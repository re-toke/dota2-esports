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
// 纯 wikitext 解析层（零 wx 依赖）：客户端 / 云函数 aggregation 共用同一份拷贝。
// 由 scripts/sync-liquipedia-parse.js 镜像到 cloudfunctions/aggregation/liquipedia-parse.js，
// 保证两侧解析逻辑一致（消除"客户端解析 / 云端解析"漂移）。
var LiquiParse = require('./liquipedia-parse.js');

// Liquipedia slug 映射表（由 scripts/generate-liquipedia-slugmap.js 生成，sync:slugmap 镜像到云端）
// OpenDota 联赛名 ≠ Liquipedia 页面 slug（扁平长名 vs 层级路径），直查命中率仅 2.5%；
// 映射表把 OpenDota name 转成正确 Liquipedia slug，命中率提升到 ~60%+ 且全为准确映射。
var slugMapCache = null;
function getSlugMap() {
  if (slugMapCache === null) {
    try { slugMapCache = require('./liquipedia-slugmap.json'); }
    catch (e) { slugMapCache = { mappings: {} }; }
  }
  return slugMapCache;
}
function liquipediaSlugFor(name) {
  var m = getSlugMap();
  if (m && m.mappings && m.mappings[name]) return m.mappings[name];
  return name;
}

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

// ===== wikitext 解析（纯函数已抽到 liquipedia-parse.js 单一来源）=====
// 解析逻辑零 wx / 云 / config 依赖，被客户端 liquipedia.js 与云函数 aggregation
// 共用同一份拷贝（scripts/sync-liquipedia-parse.js 镜像，保证双源一致）。
// 本文件仅保留 wx 耦合的抓取层（request / fetchPageWikitext）。
// getTeamRoster / getPlayerProfile 直接调用 LiquiParse 的纯函数；
// getLeagueMetadata 的赛事元数据解析也委托 LiquiParse.parseLeagueMetadata。

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

// 1. 赛事元数据
// 返回 { canonical, startDate, endDate, prizePool, prizePoolCurrency, location, format, organizer, participants, source }
// 或 null。每个字段独立 try/catch，缺一个不影响其它字段。
// 解析 Liquipedia 赛事页的 {{Infobox league}} 模板参数，及 Participants 区块参赛队伍。
// 2026-07-28 新增 participants 字段：解析 {{TeamParticipants}} 中的 {{Opponent}} 列表，
//   为未开赛赛事提供已公布的参赛队伍，与 Liquipedia 公示一致。
function getLeagueMetadata(name) {
  if (!ENABLED) return Promise.resolve(null);
  if (!name) return Promise.resolve(null);

  var slug = liquipediaSlugFor(name);
  var cacheKey = 'liquipedia_league_' + consensus.normName(name);
  var cached = cache.get(cacheKey, CACHE_TTL);
  if (cached) return Promise.resolve(cached);

  // 云代理优先：通过云函数（Node.js 环境，可自由设置 User-Agent + gzip）代理 Liquipedia 请求，
  // 规避 wx.request 禁止设置 User-Agent 的限制（Liquipedia 官方强制要求描述性 UA）。
  // 仅当 wx.cloud 存在且熔断器放行时才走云代理；测试 / 纯本地环境下 wx.cloud 未定义 → 走本地回退。
  if (typeof wx !== 'undefined' && wx.cloud && cloudProxy.isAvailable()) {
    return cloudProxy.liquipediaProxy(name).then(function (remote) {
      if (remote) {
        cache.set(cacheKey, remote, CACHE_TTL);
        return remote;
      }
      // 云代理无结果（如页面不存在）→ 回退本地 wx.request（兜底，一般不会走到）
      return fetchAndParseLeague(slug, cacheKey, name);
    }).catch(function () {
      return fetchAndParseLeague(slug, cacheKey, name);
    });
  }
  return fetchAndParseLeague(name, cacheKey);
}

// 本地抓取 + 解析（wx.request 路径，云代理不可用时兜底）
function fetchAndParseLeague(slug, cacheKey, fallbackName) {
  return fetchPageWikitext(slug).then(function (wikitext) {
    if (!wikitext) return null;
    var meta = LiquiParse.parseLeagueMetadata(wikitext, fallbackName || slug);
    if (meta) cache.set(cacheKey, meta, CACHE_TTL);
    return meta;
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
          var cells = row.split(/\n?\|\||\|\s+/).map(function (c) { return LiquiParse.stripWikitextMarkup(c); });
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

    var tpl = LiquiParse.parseTemplate(wikitext, 'Infobox player') || LiquiParse.parseTemplate(wikitext, 'Infobox team member');
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
            var cells = row.split(/\n?\|\||\|\s+/).map(function (c) { return LiquiParse.stripWikitextMarkup(c); });
            cells = cells.filter(function (c) { return c && c.indexOf('class=') < 0; });
            if (cells.length < 2) continue;
            var team = cells[0];
            var dates = [];
            for (var j = 1; j < cells.length; j++) {
              var found = LiquiParse.collectDates(cells[j]);
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

// 3. 赛程数据（未开赛/进行中的对阵）
// 从 Liquipedia wikitext 的 {{Match}} 模板中提取赛程数据，
// 补充 OpenDota 不返回的"未开赛"和"进行中"对阵。
// 返回 [{ team1Name, team2Name, startTime, boType, finished, phase }] 或 []
//
// ★ 2026-07-28 修复 LOGO 不显示 BUG：
//   原实现直接调 fetchPageWikitext（wx.request 路径，无 User-Agent），
//   被 Liquipedia 反爬拦截 → 返回空 → UI 无进行中/未开赛对阵。
//   修复：与 getLeagueMetadata 一致，优先走云代理路径（云函数可设 UA + gzip），
//   云代理不可用/失败时回退本地 wx.request（兜底，一般走不到）。
function getScheduledMatches(name) {
  if (!ENABLED) return Promise.resolve([]);
  if (!name) return Promise.resolve([]);

  var slug = liquipediaSlugFor(name);
  var cacheKey = 'liquipedia_schedule_' + consensus.normName(name);
  var cached = cache.get(cacheKey, CACHE_TTL);
  if (cached) return Promise.resolve(cached);

  // 云代理优先：通过云函数（Node.js 环境，可自由设 User-Agent + gzip）代理 Liquipedia 请求，
  // 规避 wx.request 禁止设置 User-Agent 的限制（Liquipedia 官方强制要求描述性 UA）。
  if (typeof wx !== 'undefined' && wx.cloud && cloudProxy.isAvailable()) {
    return cloudProxy.liquipediaScheduledProxy(name).then(function (res) {
      // 云函数返回 { data: [...], source: 'liquipedia' | 'cache' }
      var scheduled = (res && res.data) || [];
      if (scheduled.length) {
        cache.set(cacheKey, scheduled, CACHE_TTL);
      }
      return scheduled;
    }).catch(function () {
      // 云代理失败 → 回退本地 wx.request（兜底）
      return fetchScheduledLocal(slug, cacheKey);
    });
  }
  // 本地兜底（云代理不可用时）
  return fetchScheduledLocal(slug, cacheKey);
}

// 本地抓取 wikitext + 解析赛程（云代理不可用时的兜底路径）
function fetchScheduledLocal(slug, cacheKey) {
  return fetchPageWikitext(slug)
    .then(function (wikitext) {
      if (!wikitext) return [];
      var scheduled = LiquiParse.parseScheduledMatches(wikitext);
      cache.set(cacheKey, scheduled, CACHE_TTL);
      return scheduled;
    })
    .catch(function () { return []; });
}

module.exports = {
  ENABLED: ENABLED,
  getLeagueMetadata: getLeagueMetadata,
  getTeamRoster: getTeamRoster,
  getPlayerProfile: getPlayerProfile,
  getScheduledMatches: getScheduledMatches,
  parseParticipants: LiquiParse.parseParticipants  // 2026-07-28 导出供单元测试直接调用（单一来源：liquipedia-parse.js）
};
