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
// §6.2 slug 命中率统计（2026-07-29）：记录命中/未命中次数，未命中 name 收集到集合。
//   - getSlugStats() 供调试/日志输出命中率
//   - getMissedSlugs() 供 generate-liquipedia-slugmap 优先处理（未来可通过脚本拉取）
//   - 去重集合上限 50，避免无限增长
var _slugHitCount = 0;
var _slugMissCount = 0;
var _slugMissedNames = {};
var SLUG_MISS_LIMIT = 50;
function liquipediaSlugFor(name) {
  var m = getSlugMap();
  if (m && m.mappings && m.mappings[name]) {
    _slugHitCount++;
    return m.mappings[name];
  }
  _slugMissCount++;
  if (Object.keys(_slugMissedNames).length < SLUG_MISS_LIMIT) {
    _slugMissedNames[name] = 1;
  }
  return name;
}
function getSlugStats() {
  var total = _slugHitCount + _slugMissCount;
  return {
    hit: _slugHitCount,
    miss: _slugMissCount,
    total: total,
    hitRate: total > 0 ? (_slugHitCount / total) : 0,
    missedNames: Object.keys(_slugMissedNames)
  };
}

var ENABLED = !!(config.liquipedia && config.liquipedia.enabled);
var BASE = (config.liquipedia && config.liquipedia.base) || 'https://liquipedia.net/dota2/api.php';
var USER_AGENT = (config.liquipedia && config.liquipedia.userAgent) || 'DOTA2-Esports-Hub/1.0 (WeChat Mini Program; contact: dev@local)';
// 官方要求普通端点 ≤ 1 次/2 秒；这里留余量用 2200ms
var RATE_GAP_MS = (config.liquipedia && config.liquipedia.rateLimitMs) || 2200;
var CACHE_TTL = (config.liquipedia && config.liquipedia.cacheTTL) || (6 * 3600);
// 2026-07-29 差异化 TTL（Phase 1-②）：赛程变化敏感，30min 短缓存（与云函数对齐）
var CACHE_TTL_SCHEDULE = (config.liquipedia && config.liquipedia.cacheTtlSchedule) || (30 * 60);

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

// ===== 会话级熔断（Phase 1-③，2026-07-29）=====
// Liquipedia 连续失败 3 次后，本会话内标记不可用，避免反复请求不可用源。
// 内存变量（会话级，不持久化，冷启动重置）；成功一次即复位。
// 阈值 3 次：覆盖瞬时 CAPTCHA + 网络 + 服务端故障的常见场景。
var LIQ_FAILURES = 0;
var LIQ_BREAKER_THRESHOLD = 3;
function liquipediaBroken() {
  return LIQ_FAILURES >= LIQ_BREAKER_THRESHOLD;
}
function liquipediaMarkFailure() {
  LIQ_FAILURES++;
  if (LIQ_FAILURES === LIQ_BREAKER_THRESHOLD) {
    console.warn('[liquipedia] 连续失败 ' + LIQ_BREAKER_THRESHOLD + ' 次，本会话熔断 → 停止请求 Liquipedia');
  }
}
function liquipediaMarkSuccess() {
  if (LIQ_FAILURES > 0) LIQ_FAILURES = 0;
}

// 内部请求：调用 MediaWiki action API，返回解析后的 JSON。
// 始终 resolve（失败时 resolve null），绝不 reject —— 优雅降级。
// 注意：wx.request 禁止设置 "User-Agent"（微信运行时会报 Refused to set unsafe header），
//       只保留 Accept-Encoding: gzip（官方要求 + 微信允许）。
//       Liquipedia 官方要求描述性 UA → 需通过云函数代理（Node.js 可设 UA）。
function request(params) {
  if (!ENABLED) return Promise.resolve(null);
  // 会话级熔断：连续失败达阈值后直接返回 null，不再发起请求
  if (liquipediaBroken()) return Promise.resolve(null);

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
            liquipediaMarkFailure();  // 会话级熔断计数
            resolve(null);
            return;
          }
          liquipediaMarkSuccess();  // 成功：复位熔断计数
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
        liquipediaMarkFailure();  // 会话级熔断计数
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
        liquipediaMarkFailure();  // 会话级熔断计数
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
// ===== 底层抓取 =====
// 从 Liquipedia 抓取页面的 raw wikitext（MediaWiki action=query & prop=revisions）。
//
// 2026-07-30 P1 改造：优先走云函数代理（Node.js 可设 User-Agent，规避 wx.request
// 禁设 UA 的限制），失败回退本地 wx.request。
// 所有基于 fetchPageWikitext 的方法（getTeamRoster / getPlayerProfile / 等）自动受益。

function fetchPageWikitext(pageName) {
  if (!pageName) return Promise.resolve(null);

  // 云代理优先：通过云函数（got + UA + redirects:1）代理抓取 raw wikitext，
  // 规避 wx.request 禁设 User-Agent 的限制（Liquipedia 要求合规 UA 才返回数据）。
  // 仅当 wx.cloud 存在且熔断器放行时才走云代理；测试/纯本地环境下回退本地。
  if (typeof wx !== 'undefined' && wx.cloud && cloudProxy.isAvailable()) {
    return cloudProxy.liquipediaFetchRawWikitextProxy(pageName).then(function (remote) {
      if (remote && remote.wikitext) return remote.wikitext;
      return fetchPageWikitextLocal(pageName);
    }).catch(function () {
      return fetchPageWikitextLocal(pageName);
    });
  }
  return fetchPageWikitextLocal(pageName);
}

// 本地抓取（wx.request 路径，云代理不可用/失败时兜底）
// 注意：微信 wx.request 禁设 User-Agent，Liquipedia 可能返回 CAPTCHA/拦截页，
// 因此本地路径仅在开发/调试/无云环境时可用，真机大概率被拦截。
function fetchPageWikitextLocal(pageName) {
  return request({
    action: 'query',
    prop: 'revisions',
    rvprop: 'content',
    rvslots: 'main',
    titles: pageName,
    format: 'json',
    formatversion: '2',   // version 2 返回更扁平结构，pages 为数组
    redirects: 1          // ★ 2026-07-28 修复重定向 BUG：自动跟随 #REDIRECT，返回最终页面的 wikitext
                          // 不加此参数时，"ESL One Birmingham 2024" 会返回 "#REDIRECT [[ESL One/Birmingham/2024]]"（仅几百字节），
                          // 而非真实页面内容，导致 parseScheduledMatches/parseLeagueMetadata 在重定向文本中找不到任何模板
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
  // 2026-07-30 修复：缓存 key 用解析后的 slug 而非原始 name，
  //   避免 slug 映射新增/修改后旧空缓存持续命中。
  var cacheKey = 'liquipedia_league_' + consensus.normName(slug);
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

// ===== §9 赛事等级：对齐 Liquipedia Tier 体系（2026-07-30，方案A）=====
// 返回 { grade, rank, label, source } 或 null。
// 调用 parseLeagueTier 解析 {{Infobox league}} 模板的 liquipediatier 字段（1-4 数字），
// 通过 LIQUIPEDIA_TIER_MAP（来自 tiers.js）映射为项目的 grade/rank/label。
//
// 与 getLeagueMetadata 复用同一份 wikitext 抓取（fetchPageWikitext），但独立缓存 tier 结果。
// 原因：getLeagueMetadata 解析完整元数据，parseLeagueTier 仅解析等级字段，两者解析逻辑独立，
//       缓存独立避免互相影响。若 getLeagueMetadata 已缓存 wikitext，此处可复用。
//
// 夁用策略：先查 liquipedia_league_ 缓存（getLeagueMetadata 已写入），命中则从 meta 中无 tier 字段
//          → 需独立解析。简化为单独 fetchPageWikitext + parseLeagueTier + 独立 cache key。
function getLeagueTier(name) {
  if (!ENABLED || !name) return Promise.resolve(null);

  // 复用 getLeagueMetadata 已抓取的 wikitext + 云函数返回的 meta.liquipediaTier 字段
  // （云函数 liquipediaLeagueMeta 在解析 wikitext 时同步解析 tier，零额外请求）
  return getLeagueMetadata(name).then(function (meta) {
    if (!meta || meta.liquipediaTier == null) return null;
    var tiers = require('./tiers.js');
    var mapped = tiers.mapLiquipediaTier(meta.liquipediaTier);
    if (!mapped) return null;
    return {
      grade: mapped.grade,
      rank: mapped.rank,
      label: mapped.label,
      tier: meta.liquipediaTier,  // 原始 Liquipedia tier（1-4），供调试
      source: 'liquipedia'
    };
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

  var cacheKey = 'liquipedia_team_roster_' + consensus.normName(name);
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
// 返回 { name, realName, country, role, team, birthDate, status, alternateIds, teamHistory, achievements } 或 null。
// 解析 {{Infobox player}} 模板参数。
// §8.3 选手档案完善（2026-07-29）：新增 realName/birthDate/status/alternateIds 字段
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
    // §8.3 真实姓名（区别于游戏 ID）：优先 romanized，其次 realname/fullname
    try {
      result.realName = tpl.romanized || tpl.realname || tpl.fullname || tpl.real_name || null;
      if (result.realName && result.realName === result.name) result.realName = null;  // 避免与 ID 重复
      if (result.realName) anyField = true;
    } catch (e) { result.realName = null; }
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
    // §8.3 出生日期（用于计算年龄/职业生涯时长）
    try {
      result.birthDate = tpl.birthdate || tpl.birth_date || tpl.born || null;
      if (result.birthDate) {
        // 清理 wikitext 标记（如 {{birth date and age|...}}）
        result.birthDate = LiquiParse.stripWikitextMarkup(result.birthDate);
        if (result.birthDate) anyField = true;
      }
    } catch (e) { result.birthDate = null; }
    // §8.3 状态（active/retired/inactive）
    try {
      result.status = tpl.status || null;
      if (result.status) anyField = true;
    } catch (e) { result.status = null; }
    // §8.3 曾用 ID（别称/历史 ID）
    try {
      result.alternateIds = tpl.ids || tpl.aliases || tpl.altid || null;
      if (result.alternateIds) {
        // 拆分为数组（逗号分隔）
        if (typeof result.alternateIds === 'string') {
          result.alternateIds = result.alternateIds.split(/[,，]/).map(function (s) { return s.trim(); }).filter(Boolean);
        }
        if (result.alternateIds && result.alternateIds.length) anyField = true;
        else result.alternateIds = null;
      }
    } catch (e) { result.alternateIds = null; }

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
  // 2026-07-30 修复：缓存 key 用解析后的 slug 而非原始 name，
  //   避免 slug 映射新增/修改后旧空缓存持续命中。
  var cacheKey = 'liquipedia_schedule_' + consensus.normName(slug);
  var cached = cache.get(cacheKey, CACHE_TTL_SCHEDULE);
  if (cached) return Promise.resolve(cached);

  // 云代理优先：通过云函数（Node.js 环境，可自由设 User-Agent + gzip）代理 Liquipedia 请求，
  // 规避 wx.request 禁止设置 User-Agent 的限制（Liquipedia 官方强制要求描述性 UA）。
  if (typeof wx !== 'undefined' && wx.cloud && cloudProxy.isAvailable()) {
    return cloudProxy.liquipediaScheduledProxy(name).then(function (res) {
      // 云函数返回 { data: [...], source: 'liquipedia' | 'cache' }
      var scheduled = (res && res.data) || [];
      if (scheduled.length) {
        cache.set(cacheKey, scheduled, CACHE_TTL_SCHEDULE);
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
      cache.set(cacheKey, scheduled, CACHE_TTL_SCHEDULE);
      return scheduled;
    })
    .catch(function () { return []; });
}

// §8.3 战队 Logo（2026-07-29）：OpenDota logo_url 为空 + STRATZ 无数据时的兜底源。
// Liquipedia 是独立人工策展源，与 Valve 数据链路无关，可覆盖 OpenDota 无 logo 的队伍。
//
// 仅走云函数代理路径：Liquipedia 官方强制要求描述性 User-Agent，而 wx.request 禁止设置
// 该 header，直连会被反爬虫层拦截。云函数 Node.js 环境可自由设 header。
// 云函数内两步获取：wikitext → parseTeamLogo → imageinfo API → 缩略图 URL。
//
// 返回 { logo: url, source: 'liquipedia' } 或 null。
// 任何失败（云函数不可用 / 页面不存在 / 无 image 字段 / imageinfo 失败）均 resolve null，不影响其它源。
function getTeamLogo(name) {
  if (!ENABLED || !name) return Promise.resolve(null);

  // 本地缓存优先（与 enrichTeamLogo 共用 logoCache，但此处用通用 cache.js 30 天 TTL）
  var cacheKey = 'liquipedia_team_logo_' + consensus.normName(name);
  var cached = cache.get(cacheKey, CACHE_TTL);
  if (cached) return Promise.resolve(cached);

  // 云代理优先（Node.js 可设 UA + gzip）
  if (typeof wx !== 'undefined' && wx.cloud && cloudProxy.isAvailable()) {
    return cloudProxy.liquipediaTeamLogoProxy(name).then(function (remote) {
      if (remote && remote.logo) {
        cache.set(cacheKey, remote, CACHE_TTL);
        return remote;
      }
      return null;
    }).catch(function () { return null; });
  }
  // 无云代理可用 → 无法获取（wx.request 禁设 UA，直连必被拦）
  return Promise.resolve(null);
}

// ===== §9 Liquipedia 赛事主动枚举（2026-07-30）=====
// 通过云函数代理调用 MediaWiki categorymembers API，枚举 Category:Tournaments 下
// 全量赛事页面标题。Liquipedia 是独立人工策展 wiki，覆盖 OpenDota 未收录的未举办赛事。
//
// ★ 合规要点 ★
//   1. 使用标准 API（action=query&list=categorymembers），不抓 HTML，符合 Liquipedia 条款
//   2. 仅走云函数代理路径（wx.request 禁设 User-Agent，直连必被反爬虫层拦截）
//   3. 云端缓存 7 天 + 月度主动刷新，降频降低 Liquipedia 负载
//   4. 客户端再叠加本地缓存（7 天），避免重复调用云函数
//
// 返回 [{ slug, title }] 或 []。任何失败均 resolve 空数组，不影响其它功能。
// slug 可直接传入 fetchPageWikitext 获取具体赛事页内容；title 用于展示/匹配。
function listAllTournaments() {
  if (!ENABLED) return Promise.resolve([]);

  // 客户端本地缓存（7 天，与云端对齐）：赛事列表变化慢，长缓存减少云函数调用
  var cacheKey = 'liquipedia_tournament_list';
  var LIST_CACHE_TTL = 7 * 24 * 3600;  // 7 天（秒）
  var cached = cache.get(cacheKey, LIST_CACHE_TTL);
  if (cached && Array.isArray(cached) && cached.length) {
    return Promise.resolve(cached);
  }

  // 仅走云函数代理路径
  if (typeof wx !== 'undefined' && wx.cloud && cloudProxy.isAvailable()) {
    return cloudProxy.liquipediaListTournamentsProxy().then(function (remote) {
      if (remote && Array.isArray(remote) && remote.length) {
        cache.set(cacheKey, remote, LIST_CACHE_TTL);
        return remote;
      }
      return [];
    }).catch(function () { return []; });
  }
  // 无云代理可用 → 返回空数组（不降级本地 wx.request，因为 UA 缺失会被拦）
  return Promise.resolve([]);
}

module.exports = {
  ENABLED: ENABLED,
  getLeagueMetadata: getLeagueMetadata,
  getLeagueTier: getLeagueTier,
  getTeamRoster: getTeamRoster,
  getPlayerProfile: getPlayerProfile,
  getScheduledMatches: getScheduledMatches,
  getTeamLogo: getTeamLogo,
  listAllTournaments: listAllTournaments,
  parseParticipants: LiquiParse.parseParticipants,  // 2026-07-28 导出供单元测试直接调用（单一来源：liquipedia-parse.js）
  getSlugStats: getSlugStats  // §6.2 slug 命中率统计（供调试/日志输出）
};
