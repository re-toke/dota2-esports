// utils/liquipedia-parse.js
// Liquipedia wikitext 纯解析层（零 wx / 零云 / 零 config 依赖）。
//
// ★ 设计目的（A+B 双源策略核心）★
//   原 liquipedia.js 的模板解析逻辑与微信耦合的 request 混在同一文件，无法在云函数
//   （Node.js）环境复用。本文件把"纯解析"部分抽成独立模块：
//     - 客户端 liquipedia.js：require 本文件 + 保留 wx.request 抓取层
//     - 云函数 aggregation：require 本文件的镜像拷贝（scripts/sync-liquipedia-parse.js
//       保证两侧字节一致），用 got 抓取 + 本文件解析，规避 wx.request 禁设 User-Agent。
//   两侧共用同一份解析逻辑 → 杜绝"客户端解析 / 云端解析"漂移。
//
// 本文件只做"给定 wikitext 文本 → 结构化对象"的纯函数，不发起任何网络请求、
// 不读写缓存、不依赖 wx / cloud / config。可在任何 Node / 小程序环境直接 require。

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

// 1. 解析赛事元数据（纯函数版，供客户端 + 云端共用）
// 输入：wikitext 源码（已由调用方抓取）；fallbackName 为页面 slug（当 Infobox 无 name 时兜底）。
// 返回 { canonical, startDate, endDate, prizePool, prizePoolCurrency, location, format, organizer, participants, source }
// 或 null。每个字段独立 try/catch，缺一个不影响其它字段。
// 解析 Liquipedia 赛事页的 {{Infobox league}} 模板参数，及 Participants 区块参赛队伍。
// 2026-07-28 新增 participants 字段：解析 {{TeamParticipants}} 中的 {{Opponent}} 列表，
//   为未开赛赛事提供已公布的参赛队伍，与 Liquipedia 公示一致。
function parseLeagueMetadata(wikitext, fallbackName) {
  if (!wikitext) return null;
  try {
    var tpl = parseTemplate(wikitext, 'Infobox league') || parseTemplate(wikitext, 'Infobox tournament');
    if (!tpl) return null;

    var result = { source: 'liquipedia' };
    var anyField = false;

    try {
      result.canonical = tpl.name || tpl.ticker || (fallbackName || null);
      if (result.canonical) anyField = true;
    } catch (e) { result.canonical = null; }

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
    return result;
  } catch (e) {
    return null;
  }
}

// ===== 赛程解析：从 wikitext 中提取未开赛/进行中的对阵 =====
//
// Liquipedia 赛事页面用 {{Matchlist}} 容器 + 嵌套 {{Match}} 模板记录赛程：
//   {{Matchlist|title=April 22-A|collapsed=true
//   |M1={{Match
//     |bestof=2
//     |opponent1={{TeamOpponent|team falcons}}
//     |opponent2={{TeamOpponent|betboom team}}
//     |date=April 22, 2024 - 13:00 {{Abbr/CEST}}
//     |finished=true
//     |map1={{Map|team1side=dir|t1h1=...}}
//     ...
//   }}
//   |M2={{Match|...}}
//   }}
//
// 本函数扫描所有 {{Match}} 模板（跳过 {{Matchlist}} 容器），提取：
//   - team1Name / team2Name：从 opponent1/opponent2 的 {{TeamOpponent|队名}} 提取
//   - startTime：从 date 字段解析为 unix 秒
//   - boType：从 bestof 字段
//   - finished：是否已结束
//   - phase：live（已开赛未结束）/ upcoming（未开赛）/ recent（已结束）
//
// nowSec 用于判定 phase：start < now 且未结束 → live；start > now → upcoming；已结束 → recent
function parseScheduledMatches(wikitext, nowSec) {
  if (!wikitext) return [];
  nowSec = nowSec || Math.floor(Date.now() / 1000);
  var matches = [];
  // ★ v3 优化项23：维护当前 section 上下文（标题层级解析）
  var currentSection = '';
  var currentSubsection = '';
  // 逐行扫描：检测标题行（== Section == / === Subsection ===）和 {{Match}} 模板
  var lines = wikitext.split('\n');
  for (var li = 0; li < lines.length; li++) {
    var line = lines[li].trim();
    // 检测二级标题（== Section ==）
    var h2 = line.match(/^==\s*([^=]+?)\s*==$/);
    if (h2) {
      currentSection = h2[1].trim();
      currentSubsection = '';
      continue;
    }
    // 检测三级标题（=== Subsection ===）
    var h3 = line.match(/^===\s*([^=]+?)\s*===$/);
    if (h3) {
      currentSubsection = h3[1].trim();
      continue;
    }
    // 检测 {{Match}} 模板（跳过 {{Matchlist}} 定义行；
    // ★ 2026-08-03 修复：兼容 {{Matchlist}} 嵌套写法 "|M#={{Match"（Match 不在行首，
    //   如 1win Essence II 页面结构），此前 line.indexOf('{{Match') !== 0 会把
    //   所有 Matchlist 嵌套的比赛整场跳过 → 详情页对阵 LIVE/UPCOMING 恒为 0。
    var mPos = line.indexOf('{{Match');
    if (mPos < 0) continue;
    if (/^\{\{Matchlist(?![a-zA-Z])/.test(line)) continue;
    var startPos = mPos;
    // （空占位 {{Match}} 无参数 → parseMatchFields 返回 null 自动过滤；
    //  跨行模板 "{{Match\n|opponent1=..." 由下方拼接逻辑闭合后整体解析）
    // 从行中提取模板（处理同行模板和跨行模板）
    var fullLine = line;
    // 如果模板未在当前行闭合，拼接后续行
    var braceDepth = 0;
    var templateEnd = -1;
    for (var ci = 0; ci < fullLine.length - 1; ci++) {
      if (fullLine[ci] === '{' && fullLine[ci + 1] === '{') { braceDepth++; ci++; }
      else if (fullLine[ci] === '}' && fullLine[ci + 1] === '}') {
        braceDepth--;
        if (braceDepth === 0) { templateEnd = ci; break; }
        ci++;
      }
    }
    // 如果当前行未闭合，继续拼接后续行
    while (templateEnd < 0 && li + 1 < lines.length) {
      li++;
      fullLine += '\n' + lines[li];
      // ★ 2026-08-03 修复：每轮重扫前重置 braceDepth（此前跨轮累计，
      //   含 map1/map2/map3 深层嵌套的模板（如 1win Essence II 淘汰赛 R#M#）
      //   累计值永不归零 → templateEnd 永远 -1 → 整场丢弃 → 对阵 UPCOMING 恒为 0；
      //   短模板则"带病成功"（吞掉后续行后才偶然闭合，body 混入多余行）。
      braceDepth = 0;
      for (var ci2 = 0; ci2 < fullLine.length - 1; ci2++) {
        if (fullLine[ci2] === '{' && fullLine[ci2 + 1] === '{') { braceDepth++; ci2++; }
        else if (fullLine[ci2] === '}' && fullLine[ci2 + 1] === '}') {
          braceDepth--;
          if (braceDepth === 0) { templateEnd = ci2; break; }
          ci2++;
        }
      }
    }
    if (templateEnd < 0) continue;
    // 提取模板 body
    var bodyStart = fullLine.indexOf('{{Match') + 2;
    // 找到 Match 后的第一个 |
    var pipeIdx = fullLine.indexOf('|', bodyStart);
    if (pipeIdx < 0) continue;
    var body = fullLine.substring(bodyStart, templateEnd);
    // 解析参数
    var fields = parseMatchFields(body);
    if (!fields) continue;
    // ★ v3 优化项23：注入 section 上下文
    fields.section = currentSection;
    fields.subsection = currentSubsection;
    matches.push(fields);
  }
  // 去重：同队对+同日期的对阵只保留一个（Liquipedia 可能在不同 Matchlist 中重复）
  var seen = {};
  var deduped = [];
  matches.forEach(function (mch) {
    var key = mch.team1Name + '__' + mch.team2Name + '__' + mch.startTime;
    if (!seen[key]) {
      seen[key] = true;
      deduped.push(mch);
    }
  });
  return deduped;
}

// 解析 {{Match}} 模板参数，提取对阵信息
function parseMatchFields(body) {
  // 去掉开头的 'Match|'
  var afterName = body.replace(/^Match\s*\|\s*/, '');
  var parts = splitTopLevel(afterName, '|');
  var fields = {};
  parts.forEach(function (part) {
    part = part.trim();
    var eqIdx = part.indexOf('=');
    if (eqIdx < 0) return;
    var key = part.substring(0, eqIdx).trim().toLowerCase();
    var val = part.substring(eqIdx + 1).trim();
    fields[key] = val;
  });
  // 提取队名和比分：opponent1={{TeamOpponent|队名|score=N}} 或 {{TeamOpponent|[[队名|显示名]]|score=N}}
  var opp1 = extractTeamOpponent(fields.opponent1 || '');
  var opp2 = extractTeamOpponent(fields.opponent2 || '');
  var team1Name = opp1.name;
  var team2Name = opp2.name;
  if (!team1Name || !team2Name) return null;  // 队名缺失，跳过
  // 解析日期
  var startTime = parseLiquipediaDate(fields.date || '');
  if (!startTime) return null;  // 日期解析失败，跳过
  // bestof
  var bo = fields.bestof ? parseInt(fields.bestof, 10) : 1;
  var boType = 'BO' + (isNaN(bo) || bo < 1 ? 1 : bo);
  // finished
  var finished = fields.finished === 'true' || fields.finished === '1';
  // ★ v3 优化项32（2026-08-03）：字母 score 辅助 finished 判定。
  // TeamOpponent|score=w/l/ff 只在比赛结束后才写入（比分标记），
  // 而数字 score（当前小局分）在 live 比赛中也存在 —— 因此仅字母值判结束。
  // 场景：Liquipedia 打完比赛但未标 finished=true 时，靠此提前进入 recent。
  if (!finished && (opp1.scoreAlpha || opp2.scoreAlpha)) {
    finished = true;
  }
  // walkover（弃权）：0=无弃权, 1=team1弃权, 2=team2弃权
  var walkover = fields.walkover ? parseInt(fields.walkover, 10) : 0;
  // phase 判定（★ v3 优化项④：增加 24h 上界守卫，与 sources.js groupSeries 保持一致）
  var nowSec = Math.floor(Date.now() / 1000);
  var phase;
  if (finished) {
    phase = 'recent';
  } else if (startTime > nowSec) {
    phase = 'upcoming';
  } else if ((nowSec - startTime) < 24 * 3600) {
    phase = 'live';  // 已开赛但未结束，且在 24h 内
  } else {
    phase = 'recent';  // ★ 超 24h 未结束 → 降级为 recent（防僵死数据）
  }
  return {
    team1Name: team1Name,
    team2Name: team2Name,
    score1: opp1.score,   // ★ v3 优化项22：从 TeamOpponent|score=N 提取
    score2: opp2.score,
    walkover: walkover,   // ★ v3 优化项22：弃权标记
    startTime: startTime,
    boType: boType,
    finished: finished,
    phase: phase
  };
}

// 从 {{TeamOpponent|队名|score=N}} 嵌套模板中提取队名和比分
// ★ v3 优化项22：新增 score 提取，从 TeamOpponent 模板的 score=N 参数获取
// 输入 '{{TeamOpponent|team falcons|score=2}}' → { name: 'team falcons', score: 2 }
// 输入 '{{TeamOpponent|[[Team Spirit|TS]]|score=1}}' → { name: 'TS', score: 1 }
// 输入 '{{TeamOpponent}}' → { name: '', score: 0 }
// ★ v3 优化项32（2026-08-03）：score 支持字母值（w/l/ff/forfeit），
//   用于 parseMatchFields 判 finished。scoreAlpha 非空 = 该场已结束（比分标记）。
//   数字值（score=2）在 live 比赛中是当前小局分，不代表结束 —— 因此
//   scoreAlpha 与 score（数字）严格分离，避免把 live 误判成 recent。
// 输入 '{{TeamOpponent|team1|score=w}}' → { name: 'team1', score: 0, scoreAlpha: 'w' }
function extractTeamOpponent(raw) {
  if (!raw) return { name: '', score: 0, scoreAlpha: '' };
  var m = raw.match(/\{\{TeamOpponent\s*\|([^}]*)\}\}/i);
  if (!m) return { name: '', score: 0, scoreAlpha: '' };
  var inner = m[1].trim();
  // 提取 score=N 参数（字母或数字）
  var scoreMatch = inner.match(/\bscore\s*=\s*([a-zA-Z]+\d*|\d+)/i);
  var score = 0;
  var scoreAlpha = '';
  if (scoreMatch) {
    var sv = scoreMatch[1].toLowerCase();
    if (/^\d+$/.test(sv)) {
      score = parseInt(sv, 10);
    } else {
      scoreAlpha = sv;
    }
  }
  // 提取队名（复用 extractTeamOpponentName 逻辑）
  var name = extractTeamOpponentName(raw);
  return { name: name, score: score, scoreAlpha: scoreAlpha };
}

// 从 {{TeamOpponent|队名}} 嵌套模板中提取队名
// 输入 '{{TeamOpponent|team falcons}}' → 'team falcons'
// 输入 '{{TeamOpponent|[[Team Spirit|TS]]}}' → 'TS'
// 输入 '{{TeamOpponent}}' → ''
function extractTeamOpponentName(raw) {
  if (!raw) return '';
  // 匹配 {{TeamOpponent|...}} 模板
  var m = raw.match(/\{\{TeamOpponent\s*\|([^}]*)\}\}/i);
  if (!m) return '';
  var inner = m[1].trim();
  // 处理 [[链接|显示名]] 格式
  var linkMatch = inner.match(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/);
  if (linkMatch) {
    return linkMatch[2] ? linkMatch[2].trim() : linkMatch[1].split('/').pop().trim();
  }
  // 纯文本队名（去掉 score= 参数后）
  var namePart = inner.replace(/\|?\s*score\s*=\s*\w+/i, '').trim();
  return stripWikitextMarkup(namePart).trim();
}

// 解析 Liquipedia 日期格式为 unix 秒
// ★ v3 优化项24：保留时区信息并正确转换为 UTC（原代码去掉时区缩写后按 UTC 解析，偏差可达数小时）
// 输入 'April 22, 2024 - 13:00 {{Abbr/CEST}}' → 按解析出的时区偏移转换为 UTC 秒
// 输入 '2024-04-22 13:00' → 按 UTC 解析
// 失败返回 0
// 时区偏移表（常见电竞赛事时区）
var TZ_OFFSET = {
  'UTC': 0, 'GMT': 0,
  'CEST': 2, 'CET': 1,    // 欧洲
  'EST': -5, 'EDT': -4,   // 美东
  'PST': -8, 'PDT': -7,   // 美西
  'CST': 8,               // 中国（也可能是美中 -6，但 Dota2 赛事多用北京时间）
  'KST': 9,               // 韩国
  'MSK': 3,               // 莫斯科
  'TRT': 3,               // 土耳其
  'GST': 4,               // 海湾标准时间
  'BRT': -3,              // 巴西
  'ICT': 7,               // 印度支那
  'WIB': 7                // 印尼西部
};
function parseLiquipediaDate(dateStr) {
  if (!dateStr) return 0;
  // 去掉 {{Abbr/XXX}} 等模板但保留时区名文本
  var cleaned = dateStr.replace(/\{\{[^}]*\}\}/g, '').trim();
  // 提取时区缩写（在时间末尾）
  var tzMatch = cleaned.match(/\s+([A-Z]{3,5})\s*$/);
  var tzAbbr = tzMatch ? tzMatch[1] : '';
  // 去掉时区缩写尾部
  cleaned = cleaned.replace(/\s+[A-Z]{3,5}\s*$/, '').trim();
  // 查时区偏移表（未命中默认 0，退化为原行为）
  var tzOffset = TZ_OFFSET[tzAbbr] != null ? TZ_OFFSET[tzAbbr] : 0;
  // 尝试解析 "April 22, 2024 - 13:00" 格式
  var m1 = cleaned.match(/(\w+)\s+(\d+),\s*(\d{4})\s*[-–]?\s*(\d{1,2}):(\d{2})/);
  if (m1) {
    var monthMap = {
      'january': 0, 'february': 1, 'march': 2, 'april': 3, 'may': 4, 'june': 5,
      'july': 6, 'august': 7, 'september': 8, 'october': 9, 'november': 10, 'december': 11
    };
    var monthIdx = monthMap[m1[1].toLowerCase()];
    if (monthIdx == null) return 0;
    // 按时区偏移计算 UTC 时间：本地时间 - tzOffset = UTC 时间
    var d = new Date(Date.UTC(parseInt(m1[3]), monthIdx, parseInt(m1[2]),
      parseInt(m1[4]) - tzOffset, parseInt(m1[5])));
    return Math.floor(d.getTime() / 1000);
  }
  // 尝试解析 "2024-04-22 13:00" 格式
  var m2 = cleaned.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})/);
  if (m2) {
    var d2 = new Date(Date.UTC(parseInt(m2[1]), parseInt(m2[2]) - 1, parseInt(m2[3]),
      parseInt(m2[4]) - tzOffset, parseInt(m2[5])));
    return Math.floor(d2.getTime() / 1000);
  }
  // 尝试 Date.parse 兜底
  var t = Date.parse(cleaned);
  if (!isNaN(t)) return Math.floor(t / 1000);
  return 0;
}

// ===== 战队 Logo 解析（§8.3 2026-07-29）=====
// 从战队页 wikitext 中提取 {{Infobox team}} 模板的 image 字段值。
// Liquipedia 战队页结构：
//   {{Infobox team
//   |name=Team Spirit
//   |image=Team_Spirit_logo.png
//   |imagecaption=
//   |...
//   }}
// image 字段是图片文件名（不含 File: 前缀），需配合 imageinfo API 获取可访问 URL。
//
// 返回 { image: 'Team_Spirit_logo.png' } 或 null（未找到模板 / 无 image 字段）
function parseTeamLogo(wikitext) {
  if (!wikitext) return null;
  var tpl = parseTemplate(wikitext, 'Infobox team');
  if (!tpl) return null;
  // image 字段优先，image_dark / logo / logo_dark 兜底（部分战队页用 logo 命名）
  var image = tpl.image || tpl.image_dark || tpl.logo || tpl.logo_dark || null;
  if (!image) return null;
  // parseTemplate 内部已执行 stripWikitextMarkup，但再清理一次防御 [[File:xxx|200px]] 形式
  image = stripWikitextMarkup(image);
  // 去掉可能的 "File:" / "Image:" 前缀（部分页面直接写带命名空间的文件名）
  image = image.replace(/^File:/i, '').replace(/^Image:/i, '').trim();
  // 去掉 | 后的尺寸参数（如 "Team_Spirit_logo.png|200px" → "Team_Spirit_logo.png"）
  image = image.split('|')[0].trim();
  if (!image) return null;
  return { image: image };
}

// ===== 赛事等级解析（§9 2026-07-30，方案A：对齐 Liquipedia Tier 体系）=====
// 从赛事页 wikitext 中提取 {{Infobox league}} 模板的 liquipediatier 字段值。
// Liquipedia 战队页结构：
//   {{Infobox league
//   |name=DreamLeague Season 27
//   |liquipediatier=1
//   |...
//   }}
// liquipediatier 字段是 1-4 的数字（1=最高，4=最低），是 Liquipedia 人工策展的权威分级。
//
// 返回 { tier: 1 } 或 null（未找到模板 / 无 liquipediatier 字段 / 值非数字）
function parseLeagueTier(wikitext) {
  if (!wikitext) return null;
  var tpl = parseTemplate(wikitext, 'Infobox league') || parseTemplate(wikitext, 'Infobox tournament');
  if (!tpl) return null;
  // liquipediatier 是 Liquipedia 标准字段（数字 1-4）
  var raw = tpl.liquipediatier || tpl.tier || null;
  if (!raw) return null;
  // 清理 wikitext 标记 + 提取数字
  raw = stripWikitextMarkup(raw).trim();
  var num = parseInt(raw, 10);
  if (isNaN(num) || num < 1 || num > 4) return null;
  return { tier: num };
}

module.exports = {
  parseTemplate: parseTemplate,
  splitTopLevel: splitTopLevel,
  stripWikitextMarkup: stripWikitextMarkup,
  stripTags: stripTags,
  parsePrizePool: parsePrizePool,
  collectDates: collectDates,
  findTemplateEnd: findTemplateEnd,
  extractLink: extractLink,
  parseOpponentBlock: parseOpponentBlock,
  parseTeamCardBlock: parseTeamCardBlock,
  parseParticipants: parseParticipants,
  parseLeagueMetadata: parseLeagueMetadata,
  parseScheduledMatches: parseScheduledMatches,
  parseTeamLogo: parseTeamLogo,
  parseLeagueTier: parseLeagueTier,
  extractTeamOpponent: extractTeamOpponent
};
