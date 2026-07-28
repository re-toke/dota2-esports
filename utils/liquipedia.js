// utils/liquipedia.js
// 第四网络数据源：Liquipedia（独立人工策展电竞 wiki，MediaWiki action API）。
// 与 OpenDota/STRATZ/Steam（均派生自 Valve 比赛数据）不同，Liquipedia 是人工维护的
// 电竞 wiki，提供赛事元数据（规范名/日期/奖金池/地点/赛制/主办方）、战队名册、选手资料，
// 作为真正独立于 Valve 比赛数据的交叉验证来源。
//
// 启用条件：config.liquipedia.enabled === true（免费、无需 key）。
//
// ★ 合规要点（见 https://liquipedia.net/api-terms-of-use）★
//   1. 必须设置描述性 User-Agent（含项目名 + 联系方式），通用 UA 会被封禁
//   2. 必须支持 gzip（设 Accept-Encoding: gzip）
//   3. 普通端点限流 1 次/2 秒；action=parse 限流 1 次/30 秒（资源消耗大）
//      → 本模块改用 action=query&prop=revisions 取 wikitext 源码（2 秒限流，宽松 15 倍），
//        避免 action=parse 的 30 秒严格限流导致 IP 被反爬虫层封禁
//   4. 必须缓存复用结果（默认 6h TTL）
//   5. 不得抓取非 API 端点（HTML 页面）
//
// ★★ 微信小程序限制（重要）★★
//   wx.request 禁止设置 "User-Agent" header（运行时会报 Refused to set unsafe header）。
//   这与 Liquipedia 官方要求"必须设置描述性 User-Agent"存在根本冲突。
//   解决方案：通过微信云函数（Node.js 环境，可自由设置 header）代理 Liquipedia 请求。
//   云函数基础设施已就绪：cloudfunctions/aggregation/
//
// 早期版本误用 action=parse + 1500ms 限流（违反 30 秒规则）→ IP 被封、返回 CAPTCHA 拦截页
// 而非 JSON → 数据永远拿不到。本版本已修复：改用 revisions 端点 + 2 秒限流 + wikitext 模板解析。
//
// 未启用 / 任意请求失败 / 解析失败 → 所有方法优雅降级（resolve 为空），不影响其它源。

var config = require('./config.js');
var cache = require('./cache.js');
var consensus = require('./consensus.js');
var cloudProxy = require('./cloudProxy.js');

var ENABLED = !!(config.liquipedia && config.liquipedia.enabled);
var BASE = (config.liquipedia && config.liquipedia.base) || 'https://liquipedia.net/dota2/api.php';
var USER_AGENT = (config.liquipedia && config.liquipedia.userAgent) || 'DOTA2-Esports-Hub/1.0 (WeChat Mini Program; contact: dev@local)';
// 官方要求普通端点 ≤ 1 次/2 秒；这里留余量用 2200ms
var RATE_GAP_MS = (config.liquipedia && config.liquipedia.rateLimitMs) || 2200;
var CACHE_TTL = (config.liquipedia && config.liquipedia.cacheTTL) || (6 * 3600);

// 启动日志：在开发者工具 Console 中一眼确认配置是否生效
if (ENABLED) {
  console.log('[liquipedia] ✅ ENABLED: true, base:', BASE);
} else {
  console.log('[liquipedia] ⏸️ DISABLED（如需启用，请在 utils/config.js 中设置 enabled: true）');
}

// ===== 速率限制器（串行 + 最小间隔，复用 api.js 的 lastCall + sleep 模式）=====
var lastCall = 0;
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

var MAX_RETRIES = 2;
var RETRY_DELAYS_MS = [2200, 6000]; // 第 1/2 次重试的退避（≥ RATE_GAP_MS）

function isRetriable(statusCode) {
  return statusCode === 429 || (statusCode >= 500 && statusCode < 600);
}

// 内部请求：调用 MediaWiki action API，返回解析后的 JSON。
// 始终 resolve（失败时 resolve null），绝不 reject —— 优雅降级。
// 注意：wx.request 禁止设置 "User-Agent"（微信运行时会报 Refused to set unsafe header），
//       只保留 Accept-Encoding: gzip（官方要求 + 微信允许）。
//       Liquipedia 官方要求描述性 UA → 需通过云函数代理（Node.js 可设 UA）。
function request(params) {
  if (!ENABLED) return Promise.resolve(null);

  // 串行限流：立即预留槽位，保证两次请求间隔不小于 RATE_GAP_MS
  var now = Date.now();
  var wait = Math.max(0, lastCall + RATE_GAP_MS - now);
  lastCall = now + wait;

  return sleep(wait).then(function () { return attempt(params, 0); });
}

function attempt(params, retryCount) {
  // 拼 query string
  var qs = Object.keys(params).map(function (k) {
    return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
  }).join('&');
  var url = BASE + '?' + qs;

  return new Promise(function (resolve) {
    wx.request({
      url: url,
      method: 'GET',
      header: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip'           // 官方强制要求支持 gzip（微信允许此 header）
        // 注意：不设置 User-Agent —— wx.request 禁止设置该 header
      },
      success: function (res) {
        // 成功：200~299 且有 body
        if (res.statusCode >= 200 && res.statusCode < 300 && res.data) {
          // 检测反爬虫拦截页（返回 HTML 而非 JSON）：Liquipedia 违规时会返回 CAPTCHA 页面
          if (typeof res.data === 'string' && res.data.indexOf('temporarily blocked') >= 0) {
            console.warn('[liquipedia] 被反爬虫层拦截（IP 临时封禁），请降低请求频率或完成 CAPTCHA 解锁');
            resolve(null);
            return;
          }
          resolve(res.data);
          return;
        }
        // 429 / 5xx 且还有重试次数：退避后重试
        if (isRetriable(res.statusCode) && retryCount < MAX_RETRIES) {
          var delay = RETRY_DELAYS_MS[retryCount] || 6000;
          console.warn('[liquipedia] HTTP ' + res.statusCode + ' 准备重试 ' + (retryCount + 1) + '/' + MAX_RETRIES + '（' + delay + 'ms 后）');
          setTimeout(function () { attempt(params, retryCount + 1).then(resolve); }, delay);
          return;
        }
        console.warn('[liquipedia] HTTP ' + res.statusCode + ' 请求失败，降级返回 null');
        resolve(null);
      },
      fail: function (err) {
        // 网络/超时：可重试
        if (retryCount < MAX_RETRIES) {
          var delay = RETRY_DELAYS_MS[retryCount] || 6000;
          console.warn('[liquipedia] 网络错误 准备重试 ' + (retryCount + 1) + '/' + MAX_RETRIES + '（' + delay + 'ms 后）:', err && err.errMsg);
          setTimeout(function () { attempt(params, retryCount + 1).then(resolve); }, delay);
          return;
        }
        console.warn('[liquipedia] 请求失败（重试耗尽）:', err && err.errMsg);
        resolve(null);
      }
    });
  });
}

// ===== wikitext 模板参数解析（比 HTML 正则更可靠）=====
//
// Liquipedia 页面用 MediaWiki 模板组织元数据，例如赛事页：
//   {{Infobox league
//   |name=The International 2024
//   |sdate=2024-09-11
//   |edate=2024-10-13
//   |prizepool=5000000
//   |city=Copenhagen
//   |organizer=Valve
//   |format=...
//   }}
//
// 本解析器从 wikitext 中提取首个指定模板的所有 key=value 参数。
// 相比 HTML 正则，模板参数是结构化的，不依赖易变的 HTML class 名，容错性更强。

// 从 wikitext 中提取指定模板的参数对象。
// templateName 形如 'Infobox league'（不区分大小写匹配）。
// 返回 { key: value } 或 null（未找到模板）。
function parseTemplate(wikitext, templateName) {
  if (!wikitext || !templateName) return null;
  try {
    // 匹配 {{TemplateName ... }}，需处理嵌套花括号（用深度计数）
    var target = templateName.toLowerCase().trim();
    var start = -1;
    var depth = 0;
    var end = -1;
    for (var i = 0; i < wikitext.length - 1; i++) {
      if (wikitext[i] === '{' && wikitext[i + 1] === '{') {
        if (start < 0) {
          // 检查模板名是否匹配
          var afterName = wikitext.substring(i + 2);
          var nameMatch = afterName.match(/^([^|}]+)/);
          if (nameMatch) {
            var thisName = nameMatch[1].trim().toLowerCase();
            if (thisName === target) {
              start = i + 2 + nameMatch[1].length;
              depth = 1;
              i = i + 2 + nameMatch[1].length - 1;
              continue;
            }
          }
        } else {
          depth++;
          i++; // 跳过下一个 {
        }
      } else if (wikitext[i] === '}' && wikitext[i + 1] === '}') {
        if (start >= 0) {
          depth--;
          if (depth === 0) {
            end = i;
            break;
          }
          i++; // 跳过下一个 }
        }
      }
    }
    if (start < 0 || end < 0) return null;

    var body = wikitext.substring(start, end);
    // 按 | 分割参数（需忽略 || 在值内部的情况，但 Liquipedia 模板值很少含 |）
    var params = {};
    // 去掉开头的 |（如果模板名后紧跟 |）
    body = body.replace(/^\s*\|/, '');
    var parts = splitTopLevel(body, '|');
    for (var p = 0; p < parts.length; p++) {
      var part = parts[p].trim();
      if (!part) continue;
      var eq = part.indexOf('=');
      if (eq < 0) continue;
      var key = part.substring(0, eq).trim().toLowerCase();
      var value = part.substring(eq + 1).trim();
      // 去掉值内层模板的 {{...}} 包裹（保留纯文本）
      value = stripWikitextMarkup(value);
      if (key) params[key] = value;
    }
    return params;
  } catch (e) {
    return null;
  }
}

// 按分隔符分割，但忽略 [[...]] 内部和 {{...}} 内部的分隔符
function splitTopLevel(s, sep) {
  var result = [];
  var current = '';
  var bracketDepth = 0; // [[ ]]
  var braceDepth = 0;   // {{ }}
  for (var i = 0; i < s.length; i++) {
    var ch = s[i];
    if (ch === '[' && s[i + 1] === '[') { bracketDepth++; current += '[['; i++; continue; }
    if (ch === ']' && s[i + 1] === ']') { bracketDepth--; current += ']]'; i++; continue; }
    if (ch === '{' && s[i + 1] === '{') { braceDepth++; current += '{{'; i++; continue; }
    if (ch === '}' && s[i + 1] === '}') { braceDepth--; current += '}}'; i++; continue; }
    if (ch === sep && bracketDepth === 0 && braceDepth === 0) {
      result.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current) result.push(current);
  return result;
}

// 去掉 wikitext 标记：[[a|b]] → b，[[a]] → a，'''a''' → a，''a'' → a，<br> → 空格
function stripWikitextMarkup(s) {
  if (!s) return '';
  return String(s)
    .replace(/\[\[[^\]]*\|([^\]]*)\]\]/g, '$1')   // [[a|b]] → b
    .replace(/\[\[([^\]]*)\]\]/g, '$1')           // [[a]] → a
    .replace(/'''/g, '')                          // '''粗体'''
    .replace(/''/g, '')                           // ''斜体''
    .replace(/<br\s*\/?>/gi, ' ')                // <br> 换行
    .replace(/<[^>]+(>|$)/g, '')                  // 其它 HTML 标签
    .replace(/\s+/g, ' ')
    .trim();
}

// 去掉 HTML 标签（保留纯文本），用于解析表格行
function stripTags(html) {
  if (!html) return '';
  return String(html)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/?[^>]+(>|$)/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// 解析奖金池文本，如 "$1,000,000 USD" 或 wikitext 中的 "5000000" → { amount, currency }
function parsePrizePool(text) {
  if (!text) return null;
  try {
    // 纯数字（wikitext 模板参数常为纯数字）
    var numOnly = String(text).match(/^[\d,]+(\.\d+)?$/);
    if (numOnly) {
      return { amount: text.replace(/,/g, ''), currency: 'USD' };
    }
    // 带货币符号：$1,000,000 USD
    var m = String(text).match(/([\$€£¥])\s*([\d,]+(?:\.\d+)?)\s*([A-Za-z]{3})?/);
    if (m) {
      return { amount: m[2].replace(/,/g, ''), currency: m[3] || 'USD' };
    }
    // 纯数字 + 货币码
    var m2 = String(text).match(/([\d,]+(?:\.\d+)?)\s*([A-Za-z]{3})?/);
    if (m2) {
      return { amount: m2[1].replace(/,/g, ''), currency: m2[2] || 'USD' };
    }
    return null;
  } catch (e) {
    return null;
  }
}

// 取 revisions API 返回的页面 wikitext 源码，失败/页面不存在返回 null
// 使用 action=query&prop=revisions&rvprop=content（2 秒限流，比 action=parse 的 30 秒宽松 15 倍）
function fetchPageWikitext(pageName) {
  if (!pageName) return Promise.resolve(null);
  return request({
    action: 'query',
    prop: 'revisions',
    rvprop: 'content',
    rvslots: 'main',
    titles: pageName,
    format: 'json',
    formatversion: '2'   // version 2 返回更扁平结构，pages 为数组
  }).then(function (data) {
    try {
      if (!data || !data.query || !data.query.pages) return null;
      var pages = data.query.pages;
      if (!Array.isArray(pages)) {
        // formatversion=1 兼容：pages 是对象
        var arr = [];
        for (var k in pages) { if (pages.hasOwnProperty(k)) arr.push(pages[k]); }
        pages = arr;
      }
      if (!pages.length) return null;
      var page = pages[0];
      // missing 标记或无 revisions → 页面不存在
      if (page.missing !== undefined && page.missing) return null;
      if (!page.revisions || !page.revisions.length) return null;
      var rev = page.revisions[0];
      var content = (rev.slots && rev.slots.main && rev.slots.main.content) || rev['*'] || rev.content;
      return content || null;
    } catch (e) {
      return null;
    }
  }).catch(function () { return null; });
}

// 从一段文本中收集所有 yyyy-MM-dd / yyyy-M-d / yyyy/MM/dd 形态的日期
function collectDates(text) {
  if (!text) return [];
  try {
    var ms = text.match(/\d{4}[-/]\d{1,2}([-/]\d{1,2})?/g);
    return ms || [];
  } catch (e) {
    return [];
  }
}

// ===== 公共方法 =====

// 0. 解析赛事页 Participants 区块，提取参赛队伍列表。
// wikitext 支持两种模板（Liquipedia 标准，互斥使用）：
//
//   ① 嵌套式（近 1-2 年新赛事）：
//   {{TeamParticipants
//   |{{Opponent|队伍名|players=...|qualification={{Qualification|method=invite|qual}}}}
//   |{{Opponent|...}}
//   }}
//   {{FormerParticipants|{{TeamParticipants|{{Opponent|...}}}}}}  ← 已替换的队伍
//
//   ② 扁平式（旧赛事，如 ESL One Birmingham 2024）：
//   {{TeamCard columns start|cols=4}}
//   {{TeamCard|team=队伍名|p1=...|p5=...|qualifier=[[...]]}}
//   {{TeamCard|...}}
//   {{TeamCard columns end}}
//   {{FormerParticipants|{{TeamCard|team=...}}}}  ← 已替换的队伍
//
// 返回数组 [{ name, status, liquipediaSlug }] 或 null。
//   - status: 'invited'（直邀）/ 'qualifier'（预选）/ 'TBD'（未公布）
//   - name 为空时返回 TBD（Opponent/TeamCard 模板队名参数为空表示未公布）
//   - liquipediaSlug: 队伍在 Liquipedia 的页面 slug（用于跳转），优先取 [[...]] 内部链接
// 不解析选手 roster（{{Persons}}/{{Person}}/{{p1..p5}}），仅取队伍级信息，
// 避免解析过深导致性能问题（roster 数据需求由战队详情页单独拉取）。
// 用深度计数法处理嵌套花括号。
// 2026-07-28 新增 TeamCard 解析分支：兼容旧版赛事页（如 ESL One Birmingham 2024）。

// 用深度计数法从 startPos 开始查找匹配的 }} 结束位置（含）。
// startPos 应指向首个 `{` 的位置。返回 -1 表示未找到。
function findTemplateEnd(wikitext, startPos) {
  var depth = 1;
  for (var i = startPos + 2; i < wikitext.length - 1; i++) {
    if (wikitext[i] === '{' && wikitext[i + 1] === '{') { depth++; i++; }
    else if (wikitext[i] === '}' && wikitext[i + 1] === '}') {
      depth--;
      if (depth === 0) return i;
      i++;
    }
  }
  return -1;
}

// 从 [[...]] wikitext 链接中提取展示名与 slug。
// 输入 '[[Team Spirit|TS]]' → { name: 'TS', slug: 'Team Spirit' }
// 输入 '[[Team Spirit]]' → { name: 'Team Spirit', slug: 'Team Spirit' }
// 输入 'Team Spirit' → { name: 'Team Spirit', slug: null }
function extractLink(nameRaw) {
  var name = nameRaw;
  var slug = null;
  var linkMatch = nameRaw.match(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/);
  if (linkMatch) {
    slug = linkMatch[1];
    var textMatch = nameRaw.match(/\[\[[^\]]*\|([^\]]+)\]\]/);
    name = textMatch ? textMatch[1].trim() : slug.split('/').pop();
  } else {
    name = stripWikitextMarkup(nameRaw);
  }
  return { name: name, slug: slug };
}

// 解析 {{Opponent|...}} 模板内容，提取队伍信息。
// 结构：{{Opponent|队伍名|players=...|qualification={{Qualification|method=invite|qual}}}}
//   - 队名：首个无名参数（去掉 Opponent| 前缀后的第一个 | 分段）
//   - 资格：|qualification= 字段内嵌 {{Qualification|method=invite|qual}}
function parseOpponentBlock(body) {
  var afterName = body.replace(/^Opponent\s*\|\s*/, '');
  var parts = splitTopLevel(afterName, '|');
  var nameRaw = (parts[0] || '').trim();
  var linkInfo = extractLink(nameRaw);
  var name = linkInfo.name;
  var slug = linkInfo.slug;
  var status = 'TBD';
  for (var p = 1; p < parts.length; p++) {
    var part = parts[p].trim();
    if (/^qualification\s*=/.test(part)) {
      var qualVal = part.replace(/^qualification\s*=\s*/, '').trim();
      if (/method\s*=\s*invite/i.test(qualVal)) status = 'invited';
      else if (/method\s*=\s*qual/i.test(qualVal)) status = 'qualifier';
      break;
    }
  }
  if (!name) name = 'TBD';
  return { name: name, status: status, liquipediaSlug: slug };
}

// 解析 {{TeamCard|...}} 模板内容，提取队伍信息。
// 结构：{{TeamCard|team=队伍名|p1=...|p5=...|c=...|qualifier=[[...]]|logo=...}}
//   - 队名：|team= 命名参数（必填，缺失视为 TBD）
//   - 资格：|qualifier= 字段，可能是 [[链接|显示名]] 或纯文本
//     启发式判定（无 method 结构）：
//       含 'invite'/'Direct'/'Leaderboard'/'Seed'/'Top' → invited
//       含 'qualifier'/'Qual'/'Play-In'/'Open'/'Closed' → qualifier
//       空或其它 → TBD
// 不解析 p1..p5 选手（选手走 getTeamRoster 单独查，避免主赛事页过大）。
function parseTeamCardBlock(body) {
  var afterName = body.replace(/^TeamCard\s*\|\s*/, '');
  var parts = splitTopLevel(afterName, '|');
  var name = '';
  var slug = null;
  var qualifierRaw = '';
  for (var i = 0; i < parts.length; i++) {
    var part = parts[i].trim();
    var m = part.match(/^([^=]+)\s*=\s*(.*)$/);
    if (!m) continue;
    var key = m[1].trim().toLowerCase();
    var val = m[2].trim();
    if (key === 'team' || key === 'teamtemplate') {
      var linkInfo = extractLink(val);
      name = linkInfo.name;
      slug = linkInfo.slug;
    } else if (key === 'qualifier' || key === 'qualification') {
      qualifierRaw = val;
    } else if (key === 'linkteam' && !slug) {
      // |linkteam= 显式指定跳转目标，优先级低于 team= 中的 [[...]]
      slug = val;
    }
  }
  var status = 'TBD';
  if (qualifierRaw) {
    if (/invite|direct|leaderboard|seed|top/i.test(qualifierRaw)) status = 'invited';
    else if (/qual|play-?in|open|closed/i.test(qualifierRaw)) status = 'qualifier';
  }
  if (!name) name = 'TBD';
  return { name: name, status: status, liquipediaSlug: slug };
}

function parseParticipants(wikitext) {
  if (!wikitext) return null;
  try {
    var teams = [];
    // 一次扫描同时识别 {{Opponent|...}} 和 {{TeamCard|...}}
    // 注意：{{TeamCardToggleButton}} 和 {{TeamCard columns start}} 不含 | 后跟 team=，故不会被误匹配
    var tplRegex = /\{\{(Opponent|TeamCard)\s*\|/g;
    var match;
    while ((match = tplRegex.exec(wikitext)) !== null) {
      var tplType = match[1];
      var startIdx = match.index + 2; // 跳过 {{
      var endIdx = findTemplateEnd(wikitext, match.index);
      if (endIdx < 0) break;
      var body = wikitext.substring(startIdx, endIdx);
      var team = tplType === 'Opponent'
        ? parseOpponentBlock(body)
        : parseTeamCardBlock(body);
      teams.push(team);
      // 推进 regex 位置避免重复匹配嵌套模板
      tplRegex.lastIndex = endIdx + 2;
    }
    // 过滤掉 FormerParticipants（已替换的队伍）：检测 wikitext 中 {{FormerParticipants|...}} 区块，
    // 并从结果中移除该区块内出现的队伍名。
    // 2026-07-28：同时收集 {{Opponent}} 和 {{TeamCard}} 的队名，兼容两种模板。
    var formerNames = {};
    var fpStart = wikitext.indexOf('{{FormerParticipants');
    while (fpStart >= 0) {
      var fpEnd = findTemplateEnd(wikitext, fpStart);
      if (fpEnd < 0) break;
      var fblock = wikitext.substring(fpStart, fpEnd);
      var fTplRegex = /\{\{(Opponent|TeamCard)\s*\|/g;
      var fm;
      while ((fm = fTplRegex.exec(fblock)) !== null) {
        var fStart = fm.index + 2;
        var fEnd = findTemplateEnd(fblock, fm.index);
        if (fEnd < 0) break;
        var fBody = fblock.substring(fStart, fEnd);
        var fTeam = fm[1] === 'Opponent'
          ? parseOpponentBlock(fBody)
          : parseTeamCardBlock(fBody);
        if (fTeam && fTeam.name && fTeam.name !== 'TBD') {
          formerNames[fTeam.name.toLowerCase()] = true;
        }
        fTplRegex.lastIndex = fEnd + 2;
      }
      fpStart = wikitext.indexOf('{{FormerParticipants', fpEnd + 2);
    }
    // 移除已替换的队伍
    if (Object.keys(formerNames).length) {
      teams = teams.filter(function (t) {
        return !formerNames[(t.name || '').toLowerCase()];
      });
    }
    return teams.length ? teams : null;
  } catch (e) {
    return null;
  }
}

// 1. 赛事元数据
// 返回 { canonical, startDate, endDate, prizePool, prizePoolCurrency, location, format, organizer, participants, source }
// 或 null。每个字段独立 try/catch，缺一个不影响其它字段。
// 解析 Liquipedia 赛事页的 {{Infobox league}} 模板参数，及 Participants 区块参赛队伍。
// 2026-07-28 新增 participants 字段：解析 {{TeamParticipants}} 中的 {{Opponent}} 列表，
//   为未开赛赛事提供已公布的参赛队伍，与 Liquipedia 公示一致。
function getLeagueMetadata(name) {
  if (!ENABLED) return Promise.resolve(null);
  if (!name) return Promise.resolve(null);

  var cacheKey = 'liquipedia_league_' + consensus.normName(name);
  var cached = cache.get(cacheKey, CACHE_TTL);
  if (cached) return Promise.resolve(cached);

  return fetchPageWikitext(name).then(function (wikitext) {
    if (!wikitext) return null;

    // 解析 {{Infobox league}} 模板（Liquipedia 赛事页标准模板）
    // 也尝试 {{Infobox tournament}} 作为别名
    var tpl = parseTemplate(wikitext, 'Infobox league') || parseTemplate(wikitext, 'Infobox tournament');
    if (!tpl) return null;

    var result = { source: 'liquipedia' };
    var anyField = false;

    try {
      result.canonical = tpl.name || tpl.ticker || name;
      if (result.canonical) anyField = true;
    } catch (e) { result.canonical = name; }

    try {
      // sdate/edate 是 Liquipedia 模板的标准键；也兼容 startdate/enddate
      result.startDate = tpl.sdate || tpl.startdate || tpl.start || null;
      result.endDate = tpl.edate || tpl.enddate || tpl.end || null;
      if (result.startDate) anyField = true;
    } catch (e) { result.startDate = null; result.endDate = null; }

    try {
      // prizepool 通常是纯数字（USD）；也支持带货币符号的文本
      var pp = tpl.prizepool || tpl.prizepoolusd || tpl.prize_pool;
      var parsed = parsePrizePool(pp);
      result.prizePool = parsed ? parsed.amount : null;
      result.prizePoolCurrency = parsed ? parsed.currency : null;
      if (parsed) anyField = true;
    } catch (e) { result.prizePool = null; result.prizePoolCurrency = null; }

    try {
      // city 优先，country 作为补充，venue 是场馆名
      var loc = tpl.city || tpl.country || tpl.location || tpl.venue;
      if (tpl.city && tpl.country) loc = tpl.city + ', ' + tpl.country;
      result.location = loc || null;
      if (result.location) anyField = true;
    } catch (e) { result.location = null; }

    try { result.format = tpl.format || null; if (result.format) anyField = true; } catch (e) { result.format = null; }
    try { result.organizer = tpl.organizer || tpl.organizers || null; if (result.organizer) anyField = true; } catch (e) { result.organizer = null; }

    // 2026-07-28 新增：解析 Participants 区块参赛队伍。
    // 即使 Infobox 无任何字段（under construction 页面），Participants 也能提供已公布队伍。
    // 解析失败不影响其它字段，participants 为 null 时由调用方走 curation/占位兜底。
    try {
      var participants = parseParticipants(wikitext);
      if (participants && participants.length) {
        result.participants = participants;
        anyField = true;
      }
    } catch (e) { result.participants = null; }

    if (!anyField) return null;

    cache.set(cacheKey, result, CACHE_TTL);
    return result;
  }).catch(function () { return null; });
}

// 2. 战队名册
// 返回 [{ account_id, name, position, joinDate, leaveDate }] 或 []。
// 注意：Liquipedia wikitext 中 account_id 通常不可靠/缺失，统一设为 null。
// consensus.crossMembers 会用 name 匹配作为回退，故无 account_id 的成员仅参与
// 基于名称的交叉验证，不参与基于 id 的验证（这是可接受的降级）。
//
// 战队页的 roster 通常在 wikitable 表格中（wikitext 的 {| ... |} 块），
// 每行一个队员，列含 nick/position/join date。
function getTeamRoster(name) {
  if (!ENABLED) return Promise.resolve([]);
  if (!name) return Promise.resolve([]);

  var cacheKey = 'liquipedia_team_' + consensus.normName(name);
  var cached = cache.get(cacheKey, CACHE_TTL);
  if (cached) return Promise.resolve(cached);

  return fetchPageWikitext(name).then(function (wikitext) {
    if (!wikitext) return [];

    var members = [];
    try {
      // wikitext 表格：{| class="wikitable" ... \n |-
      // 解析 {| ... |} 块内的 |- 分隔的行
      // 匹配表格块
      var tableMatch = wikitext.match(/\{\|[\s\S]*?\|\}/g);
      if (!tableMatch) return [];

      // 遍历所有表格，找含 roster 信息的表（通常有 Nick/Player 列）
      for (var t = 0; t < tableMatch.length; t++) {
        var table = tableMatch[t];
        // 按 |- 分割行
        var rows = table.split('\n|-');
        if (rows.length < 2) continue; // 无数据行

        for (var r = 1; r < rows.length; r++) { // 跳过首行（表格头 + 第一行分隔符）
          var row = rows[r].trim();
          if (!row) continue;
          // 去掉行尾的 |}（表格结束符）—— 不能直接 continue，否则最后一行数据会被丢掉
          row = row.replace(/\|\}[\s\S]*$/, '').trim();
          if (!row) continue;
          // 按 || 或 \n| 分割单元格
          var cells = row.split(/\n?\|\||\|\s+/).map(function (c) { return stripWikitextMarkup(c); });
          // 过滤空单元格和样式行
          cells = cells.filter(function (c) { return c && c.indexOf('class=') < 0 && c.indexOf('style=') < 0; });
          if (cells.length < 2) continue;

          var playerName = null;
          var position = null;
          var joinDate = null;

          for (var c = 0; c < cells.length; c++) {
            var cell = (cells[c] || '').trim();
            if (!cell) continue;
            // 位置：单数字 1-5 或位置关键字
            if (!position && /^[1-5]$/.test(cell)) { position = cell; continue; }
            if (!position && /^(carry|mid|offlane|support|hard support|core|captain|coach|position [1-5])$/i.test(cell)) { position = cell; continue; }
            // 加入日期
            if (!joinDate) {
              var dm = cell.match(/\d{4}[-/]\d{1,2}([-/]\d{1,2})?/);
              if (dm) { joinDate = dm[0]; continue; }
            }
            // 选手名：第一个非空、非日期、非位置、长度>1 的单元格
            if (!playerName && cell.length > 1 && !/^\d{4}[-/]\d{1,2}/.test(cell)) { playerName = cell; }
          }

          if (playerName) {
            members.push({
              account_id: null,
              name: playerName,
              position: position,
              joinDate: joinDate,
              leaveDate: null
            });
          }
        }
        if (members.length) break; // 找到 roster 表就停止
      }
    } catch (e) {
      // 整体解析失败：返回空（绝不抛错）
      return [];
    }

    cache.set(cacheKey, members, CACHE_TTL);
    return members;
  }).catch(function () { return []; });
}

// 3. 选手资料
// 返回 { name, country, role, teamHistory: [{team, joinDate, leaveDate}], achievements: [] } 或 null。
// 解析 {{Infobox player}} 模板参数。
function getPlayerProfile(name) {
  if (!ENABLED) return Promise.resolve(null);
  if (!name) return Promise.resolve(null);

  var cacheKey = 'liquipedia_player_' + consensus.normName(name);
  var cached = cache.get(cacheKey, CACHE_TTL);
  if (cached) return Promise.resolve(cached);

  return fetchPageWikitext(name).then(function (wikitext) {
    if (!wikitext) return null;

    var tpl = parseTemplate(wikitext, 'Infobox player') || parseTemplate(wikitext, 'Infobox team member');
    if (!tpl) return null;

    var result = { achievements: [] };
    var anyField = false;

    try { result.name = tpl.name || tpl.romanized || name; anyField = true; } catch (e) { result.name = name; }
    try {
      result.country = tpl.country || tpl.nationality || tpl.region || null;
      if (result.country) anyField = true;
    } catch (e) { result.country = null; }
    try {
      result.role = tpl.role || tpl.position || null;
      if (result.role) anyField = true;
    } catch (e) { result.role = null; }
    try {
      result.team = tpl.team || tpl.currentteam || null;
      if (result.team) anyField = true;
    } catch (e) { result.team = null; }

    // 历史队伍表：解析 wikitext 表格
    result.teamHistory = [];
    try {
      var tableMatch = wikitext.match(/\{\|[\s\S]*?\|\}/g);
      if (tableMatch) {
        for (var t = 0; t < tableMatch.length; t++) {
          var table = tableMatch[t];
          if (table.toLowerCase().indexOf('team') < 0 && table.toLowerCase().indexOf('date') < 0) continue;
          var rows = table.split('\n|-');
          for (var r = 1; r < rows.length; r++) {
            var row = rows[r].replace(/\|\}[\s\S]*$/, '').trim();
            if (!row) continue;
            var cells = row.split(/\n?\|\||\|\s+/).map(function (c) { return stripWikitextMarkup(c); });
            cells = cells.filter(function (c) { return c && c.indexOf('class=') < 0; });
            if (cells.length < 2) continue;
            var team = cells[0];
            var dates = [];
            for (var j = 1; j < cells.length; j++) {
              var found = collectDates(cells[j]);
              for (var k = 0; k < found.length; k++) dates.push(found[k]);
            }
            if (team) {
              result.teamHistory.push({
                team: team,
                joinDate: dates.length >= 1 ? dates[0] : null,
                leaveDate: dates.length >= 2 ? dates[1] : null
              });
            }
          }
          if (result.teamHistory.length) break;
        }
      }
      if (result.teamHistory.length) anyField = true;
    } catch (e) {
      result.teamHistory = [];
    }

    if (!anyField) return null;

    cache.set(cacheKey, result, CACHE_TTL);
    return result;
  }).catch(function () { return null; });
}

module.exports = {
  ENABLED: ENABLED,
  getLeagueMetadata: getLeagueMetadata,
  getTeamRoster: getTeamRoster,
  getPlayerProfile: getPlayerProfile,
  parseParticipants: parseParticipants  // 2026-07-28 导出供单元测试直接调用
};
