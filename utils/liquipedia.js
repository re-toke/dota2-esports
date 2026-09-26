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
// ★ 2026-08-22 新增：haglund 兜底源（Liquipedia 云代理失败/空时的降级路径）
var haglund = require('./haglund.js');
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
var _slugMissReported = false;   // 2026-09-25: 本会话是否已打印过「全量缺失清单」
var SLUG_MISS_LIMIT = 50;
function liquipediaSlugFor(name) {
  var m = getSlugMap();
  var mm = (m && m.mappings) || null;
  // ① 精确命中（原逻辑，命中路径零额外成本、零回归）
  if (mm && mm[name]) {
    _slugHitCount++;
    return mm[name];
  }
  // ★★ 2026-09-19 新增：**归一化后再查**（修复「展示名被当成内部键」导致的 EF 全 miss）
  //
  //   真机根因：详情页收到的是列表卡片的**展示名**（haglund 命名）
  //     `PGL Wallachia S9 - Round 1`
  //   而 slugmap / curation 里只有**规范名** `PGL Wallachia Season 9`
  //   → 精确匹配失败 → 下方「原样返回」→ EF 查 `lp:w:PGL Wallachia S9 - Round 1` → **必然 miss**。
  //   实测佐证：`PGL/Wallachia/9` 在 EF 里 200 / 26592B / `{{Match}} ×14`（缓存其实全都有）。
  //
  //   归一化复用 `sources.leagueBaseName`（剥阶段后缀 + 对齐 curation 权威名），
  //   于是 `PGL Wallachia S9 - Round 1` → `PGL Wallachia Season 9` → **命中 slugmap**。
  //
  //   ⚠️ 用**函数内延迟 require**：`sources.js` 顶部 require 了本模块（L37），
  //      顶部互相 require 会成环 → 运行时加载时两模块均已就绪，安全。
  //   ⚠️ 放在精确匹配**之后**：原本能命中的输入一律走原路径，**行为不变**。
  var norm = null;
  try { norm = require('./sources.js').leagueBaseName(name); } catch (e) { norm = null; }
  if (norm && norm !== name && mm && mm[norm]) {
    _slugHitCount++;
    console.log('[liquipedia] slug 归一化命中：' + name + ' → ' + norm);
    return mm[norm];
  }
  // ★★ 2026-09-25（用户线上日志定位）：③.5 查 **curation 登记表** —— 手工维护的权威来源 ✓
  //   真因：5 个已策展赛事（PGL Wallachia Season 9 / BLAST SLAM VIII·IX 及其中国预选 /
  //   Esports Nations Cup 2026）运行时全部报「slug 未命中」✗，而它们 curation 条目里**都已配好**
  //   `liquipediaSlug`（实测 5/5 命中 curatedEventFor）—— 本函数此前**只查 slugmap**（精确 / 归一化后）
  //   ⇒ 落到「原样返回」⇒ LP 取不到赛程 ✓。curation 以**规范展示名**为键，正是这里传入的名字 ✓。
  //   ⚠️ 位置：slugmap 两条之后、告警之前 ⇒ 今天能命中的输入**行为完全不变**（零回归 ✓）
  //   ⚠️ 函数内延迟 require 防环（同文件对 sources.js 的既有模式；curation 只依赖 consensus ✓）
  try {
    var _cu = require('./curation.js').curatedEventFor(name, { game: 'dota2' });
    if (_cu && _cu.liquipediaSlug) {
      _slugHitCount++;
      // 2026-09-25: per-item hit log -> verbose switch (summary is kept in the miss line below)
      if (config.debug && config.debug.verboseLog) {
        console.log('[liquipedia] slug 命中 curation 登记表：' + name + ' → ' + _cu.liquipediaSlug);
      }
      return _cu.liquipediaSlug;
    }
  } catch (e) { /* 隔离：查表失败不影响原路径 */ }
  _slugMissCount++;
  var _isNewMiss = !_slugMissedNames[name];
  if (Object.keys(_slugMissedNames).length < SLUG_MISS_LIMIT) {
    _slugMissedNames[name] = 1;
  }
  // ★ 未命中告警（原实现**静默**原样返回 —— 危险默认值：把「查不到 slug」
  //   变成「拿中文/带阶段的名字当 LP 页面路径」，必然 miss 却无任何痕迹）。
  //   仅每个未命中名**首次**告警，避免刷屏（`_slugMissedNames` 本身有 LIMIT 去重）。
  if (_isNewMiss) {
    // ★★ 2026-09-25: succeeded-silent + one informative line on miss (with running tally).
    //   Rationale (from self-review): the old per-hit log flooded Console on the leagues/detail
    //   pages; but switching to "log only on miss" would LOSE the hit-rate signal that we
    //   actually rely on for verification -> so keep the tally in this single line.
    console.warn('[liquipedia] slug 未命中（累计 命中 ' + _slugHitCount + ' / 未命中 ' + _slugMissCount +
      '）：' + name + (norm && norm !== name ? '（归一化后 "' + norm + '" 仍未命中）' : ''));
    // First miss of this session -> also dump the FULL accumulated list, so gaps are discovered
    // proactively instead of one-by-one from user-pasted logs.
    if (!_slugMissReported) {
      _slugMissReported = true;
      console.warn('[liquipedia] slug 未命中清单（本会话累计，上限 ' + SLUG_MISS_LIMIT + '）：' +
        Object.keys(_slugMissedNames).join(' | '));
    }
  }
  return name;
}
// O-11（2026-08-15）：getSlugStats 调试函数已删（0 业务引用）；计数变量保留增量维护，
// 未来需 slug 命中率调试时可恢复读取入口。

var ENABLED = !!(config.liquipedia && config.liquipedia.enabled);
var BASE = (config.liquipedia && config.liquipedia.base) || 'https://liquipedia.net/dota2/api.php';
var USER_AGENT = (config.liquipedia && config.liquipedia.userAgent) || require('./lp-ua.js').LP_UA;
// 官方要求普通端点 ≤ 1 次/2 秒；这里留余量用 2200ms
var RATE_GAP_MS = (config.liquipedia && config.liquipedia.rateLimitMs) || 2200;
var CACHE_TTL = (config.liquipedia && config.liquipedia.cacheTTL) || (6 * 3600);
// 2026-07-29 差异化 TTL（Phase 1-②）：赛程变化敏感，30min 短缓存（与云函数对齐）
var CACHE_TTL_SCHEDULE = (config.liquipedia && config.liquipedia.cacheTtlSchedule) || (30 * 60);
// ★ 2026-09-01（P1-1 SWR）：赛程 stale-while-revalidate 硬 TTL —— 30min 新鲜窗口内直接返回；
//   30min ~ 6h 之间返回旧值（附加 _stale: true 标记）供页面秒开，调用方（详情页轮询首刷
//   refreshSchedule force）立即后台拉新替换；超 6h 才走完整网络链路。
//   写入侧同步用本值延长硬 TTL（getStale 的硬过期以写入 expire 为准）。
var STALE_TTL_SCHEDULE = (config.liquipedia && config.liquipedia.cacheStaleTtlSchedule) || (6 * 3600);

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
// O-5（2026-08-15）：_retryCount 内部参数 —— 重试走本函数重新排队（重新预留槽位），
//   保证任意两次真实发出的请求间隔 ≥ RATE_GAP_MS，符合 Liquipedia ToS（1 次/2 秒）。
//   旧实现：重试在 attempt() 内 setTimeout 直接再调 attempt()，绕过槽位预留 →
//   重试密集期实际请求间隔可能 < RATE_GAP_MS（合规风险，TI 期间 429/5xx 概率上升）。
function request(params, _retryCount) {
  if (!ENABLED) return Promise.resolve(null);
  // 会话级熔断：连续失败达阈值后直接返回 null，不再发起请求
  if (liquipediaBroken()) return Promise.resolve(null);

  // 串行限流：立即预留槽位，保证两次请求间隔不小于 RATE_GAP_MS
  var now = Date.now();
  var wait = Math.max(0, lastCall + RATE_GAP_MS - now);
  lastCall = now + wait;

  return sleep(wait).then(function () { return attempt(params, _retryCount || 0); });
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
          // O-5：重试走 request() 重新排队（重新预留槽位），非直接 attempt
          setTimeout(function () { request(params, retryCount + 1).then(resolve); }, delay);
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
          // O-5：重试走 request() 重新排队（重新预留槽位），非直接 attempt
          setTimeout(function () { request(params, retryCount + 1).then(resolve); }, delay);
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

// ★ 2026-09-11：**会话级「EF 表已知未命中」备忘**。
//   背景：EF cacheOnly 未命中虽已比现抓快得多（实测 707ms vs 2044~7262ms），
//   但每次冷查仍要付这 0.7s。而同一会话内反复查同一个未收录页面毫无意义
//   （表由 GH Actions 每日灌，会话期间不会变）→ 记住它直接跳过 EF，省掉这笔开销。
var _efMissMemo = {};
var EF_MISS_MEMO_MAX = 200;   // 简单容量上限，防无限增长

// ★ 2026-09-11：**会话级 wikitext 备忘（10min TTL）**。
//   动机：同一页面的 wikitext 会被多个功能消费（元数据/等级/赛制/参赛队/结构），
//   原实现每次都重新打 EF（即使刚取过）。加 memo 后 getLeagueMetadata + getLeagueTier
//   这类「同页多解析」组合只打一次 EF（实测 2 → 1）。
//   10min TTL：LP 更新低频，10min 内复用安全；容量上限防内存膨胀。
var _wtMemo = {};
var WT_MEMO_TTL = 10 * 60 * 1000;
var WT_MEMO_MAX = 300;

function _wtRemember(pageName, wikitext) {
  if (wikitext) {
    if (Object.keys(_wtMemo).length >= WT_MEMO_MAX) _wtMemo = {};
    _wtMemo[pageName] = { wikitext: wikitext, ts: Date.now() };
  }
  return wikitext;
}

function fetchPageWikitext(pageName) {
  if (!pageName) return Promise.resolve(null);
  var memo = _wtMemo[pageName];
  if (memo && Date.now() - memo.ts < WT_MEMO_TTL) return Promise.resolve(memo.wikitext);
  var knownMiss = !!_efMissMemo[pageName];

  // 云代理优先：通过云函数（got + UA + redirects:1）代理抓取 raw wikitext，
  // 规避 wx.request 禁设 User-Agent 的限制（Liquipedia 要求合规 UA 才返回数据）。
  // 仅当 wx.cloud 存在且熔断器放行时才走云代理；测试/纯本地环境下回退本地。
  if (typeof wx !== 'undefined' && wx.cloud && (cloudProxy.isAvailable() || cloudProxy.efAvailable())) {
    // ★★ 2026-09-11（LP 服务迁 EF · 第一步）：原实现直接调 EF（非 cacheOnly）——
    //   未命中时 EF 会去现抓 LP，而 Supabase 出口被持续 429 → **白等约 7s 才失败**。
    //   现改为三级链路：
    //     ① EF **cacheOnly**（命中 `lp:w:*` 表 → 立即返回，**零云开发调用**）
    //     ② 未命中 → **云函数** raw 抓取（唯一能现抓 LP 的出口，可靠）
    //     ③ 云函数也失败 → 本地 wx.request（开发态兜底；真机必被 LP 拦）
    //   → 热门/已知赛事走快路径；冷门赛事由云函数兜底，且**整体比原来更快**
    //     （原来无论命中与否都要先等 EF 的 7s 超时）。
    // 已知未命中 → 跳过 EF，直接走云函数（省掉 0.7s）
    // ★ 2026-09-22（云开发退役 · 决策 b）：无云函数现抓 → 直接走本地兜底
    if (knownMiss) return fetchPageWikitextLocal(pageName).then(function (w) { return _wtRemember(pageName, w); });

    return cloudProxy.liquipediaFetchRawWikitextProxy(pageName, true).then(function (remote) {
      if (remote && remote.wikitext) return _wtRemember(pageName, remote.wikitext);
      // 记住这次未命中（会话内不再重试 EF），随后显式回落云函数
      if (Object.keys(_efMissMemo).length < EF_MISS_MEMO_MAX) _efMissMemo[pageName] = 1;
      return fetchPageWikitextLocal(pageName).then(function (w) { return _wtRemember(pageName, w); });
    }).catch(function () {
      return fetchPageWikitextLocal(pageName).then(function (w) { return _wtRemember(pageName, w); });
    });
  }
  return fetchPageWikitextLocal(pageName).then(function (w) { return _wtRemember(pageName, w); });
}
/** ★★ 2026-09-22（云开发退役 · 决策 b）：原 `_viaCloudFn`（EF 未命中时显式回落云函数现抓 LP）
 *  **已移除** —— 云函数是唯一能现抓 LP 的出口，退役后改由 `fetchPageWikitextLocal` 兜底。
 *  影响面见 cloudProxy.js 同名说明（战队名册当前不进 UI ⇒ 零感知）。 */

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

  // ★ 2026-09-11（LP 服务迁 EF · 第三步）：**本地解析优先**，云函数降为兜底。
  //   原顺序：云函数 liquipediaLeagueMeta（服务端抓+解析）→ 本地。
  //   现 fetchPageWikitext 已是三级链路（EF 缓存命中 → 零云开发），且本地解析
  //   已补齐 liquipediaTier（见 fetchAndParseLeague）→ 与云函数产出字段对齐。
  //   本地无 wikitext / 解析失败时回落云函数，可靠性不变。
  if (typeof wx !== 'undefined' && wx.cloud && (cloudProxy.isAvailable() || cloudProxy.efAvailable())) {
    return fetchAndParseLeague(slug, cacheKey, name).then(function (local) {
      if (local) {
        console.log('[liquipedia] 元数据走 EF 缓存 + 本地解析（' + (local.canonical || name) + '）');
        return local;
      }
      // ★ 2026-09-19：**移除云函数兜底**（同 fetchLiquipediaChain 的处理）。
      //   原实现：本地解析失败 → `cloudProxy.liquipediaProxy(name)` → `call('liquipediaLeagueMeta')`
      //   → 该 action **不在 EDGE_ACTIONS** → 走 `callCloud()` = 微信云开发云函数。
      //   移除依据与「赛程」完全同构：
      //     · 本地解析已是主力（`fetchPageWikitext` 三级链路，EF 缓存命中即零云开发；
      //       且 `fetchAndParseLeague` 已补齐 `liquipediaTier`，与云函数产出字段对齐）；
      //     · 云函数抓 LP 必然 429（CloudBase 出口被 Cloudflare 拦）；
      //     · 真机日志中从未出现该云函数命中。
      //   移除后：本地失败则返回 null，由上层按「无元数据」处理（与云函数失败时行为一致）。
      return null;
    });
  }
  return fetchAndParseLeague(name, cacheKey);
}

// 本地抓取 + 解析（wx.request 路径，云代理不可用时兜底）
// ★ 2026-09-11（LP 服务迁 EF · 第三步）：本地路径补齐 `liquipediaTier` ——
//   原本地解析只有 parseLeagueMetadata（不含 tier），导致 getLeagueTier 必须依赖
//   云函数返回的 meta.liquipediaTier。现用 parseLeagueTier 合并（注意其返回
//   `{ tier: num }` 对象，需取 `.tier` 数字与云函数口径一致），
//   使「元数据 + 等级」都能走 EF 缓存 + 本地解析（零云开发）。
function fetchAndParseLeague(slug, cacheKey, fallbackName) {
  return fetchPageWikitext(slug).then(function (wikitext) {
    if (!wikitext) return null;
    var meta = LiquiParse.parseLeagueMetadata(wikitext, fallbackName || slug);
    if (!meta) return null;
    if (meta.liquipediaTier == null) {
      try {
        var t = LiquiParse.parseLeagueTier(wikitext);
        if (t && t.tier != null) meta.liquipediaTier = t.tier;
      } catch (e) { /* tier 解析失败不影响元数据 */ }
    }
    cache.set(cacheKey, meta, CACHE_TTL);
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
// 2026-08-03 优化（A3 force 链路）：新增 opts.force 支持。
//   - force=true：跳过客户端缓存，并透传给云代理（云函数 force 也有 30s 最小间隔节流），
//     用于详情页对阵定时刷新（30-60s 一次），保证 LIVE/UPCOMING 近实时。
//   - 对外调用形态不变：getScheduledMatches(name) / getScheduledMatches(name, { force: true })
//   - ★ 2026-08-04 返回契约升级：resolve { matches: [...], boFormat: {...} }（BO 判定引擎 S2 信号）
//     （兼容旧形状：旧云函数/旧缓存返回数组 → 归一化为 { matches: arr, boFormat: null }）
//   - ★ 2026-08-21 新增 Steam 优先路径：opts.leagueId 有值且云函数可用时，
//     先调 Steam GetLiveLeagueGames（LIVE 主源，2026-08-21 实测存活）。
//     注意：原计划同时覆盖 UPCOMING 的 GetScheduledLeagueGames 已被 Valve 删除，
//     UPCOMING 段仍依赖 Liquipedia LPDB v3（申请中）或 curation 兜底。
//     Steam 命中即返回；未命中 / 未配 leagueId / Steam 失败 → 走原 Liquipedia 路径。
function getScheduledMatches(name, opts) {
  if (!ENABLED) return Promise.resolve({ matches: [], boFormat: null });
  if (!name) return Promise.resolve({ matches: [], boFormat: null });

  // ★ 2026-09-01（P0-2 配套）：熔断状态不再无条件清零 —— 原实现每次进详情页都把
  //   cloudBreaker 的 10 分钟熔断窗口强行复位，熔断器对详情页近似失效（云函数真挂时
  //   每次请求都先失败一次再回退直连的额外开销）。现改为：
  //     - LIQ_FAILURES / slugMapCache（本模块会话级）保持每次清零（模拟器旧状态兜底，原行为）；
  //     - cloudBreaker 熔断状态仅在 force（用户显式刷新/轮询主动重试）时复位——
  //       属「明确想再试一次云」的语义，与 breaker 10 分钟自动过期互补。
  LIQ_FAILURES = 0;
  if (!!(opts && opts.force)) {
    try { wx.setStorageSync('dota2_cloud_cb', { broken: false, fails: 0 }); } catch (e) {}
  }
  slugMapCache = null;

  // ★ 2026-08-11：多页面赛事（如 TI）的主页面可能不含 {{Match}} 模板（对阵在 Group_Stage 子页面）。
  //   优先使用 curation 提供的 scheduledMatchesSlug（精确指向对阵子页面），回退到 slugMap 映射的主 slug。
  //   这两个 slug 可能不同：TI 的 liquipediaSlug=The_International/2026（仅参赛队），
  //   scheduledMatchesSlug=The_International/2026/Group_Stage（44 场对阵）。
  var curationEvent = null;
  try { curationEvent = require('./curation').curatedEventFor(name, { game: 'dota2' }); } catch (e) {}
  var slug = (curationEvent && curationEvent.scheduledMatchesSlug) || liquipediaSlugFor(name);
  var cacheKey = 'liquipedia_schedule_' + consensus.normName(slug);
  var force = !!(opts && opts.force);
  // ★ 2026-09-01（P1-1 SWR）：读取改 getStale ——
  //   fresh（≤30min）：直接返回（原行为）；
  //   stale（30min~6h）：立即返回旧值 + _stale 标记（调用方秒开渲染，后台刷新由
  //     详情页轮询首刷 refreshSchedule(force) 承担——load 完成后 startSchedulePolling
  //     本就立即 force 拉新并 diff setData，无需额外刷新任务）；
  //   expired（>6h / 无缓存）：走完整网络链路（原行为）。
  //   force（轮询/下拉刷新）：一律跳过缓存走网络（原行为，不受 SWR 影响）。
  var cachedMeta = cache.getStale(cacheKey, CACHE_TTL_SCHEDULE, STALE_TTL_SCHEDULE);
  if (cachedMeta && cachedMeta.value && !force) {
    if (cachedMeta.fresh) {
      // ★ 2026-09-11：补日志 —— 这是**最常见**的情形（30min 内重复进页面），
      //   此前完全静默，容易误判为「新链路没生效」。
      console.log('[liquipedia] 赛程命中本地缓存（新鲜，' +
        Math.round((Date.now() - (cachedMeta.fetchedAt || 0)) / 60000) + 'min 前）→ 不走网络');
      return Promise.resolve(cachedMeta.value);
    }
    console.log('[liquipedia] SWR: 赛程缓存 ' + Math.round((Date.now() - (cachedMeta.fetchedAt || 0)) / 60000) +
                'min 前拉取，先返回旧值（' + ((cachedMeta.value.matches) || []).length + ' 场），轮询首刷将拉新');
    // 浅拷贝附加 _stale（不污染缓存存储的内存对象引用语义）；
    // 兼容旧数组 shape（normalizeScheduled 的同款归一化，防 Object.assign 摊平数组）
    var base = Array.isArray(cachedMeta.value) ? { matches: cachedMeta.value, boFormat: null } : cachedMeta.value;
    var staleVal = Object.assign({}, base, { _stale: true });
    return Promise.resolve(staleVal);
  }

  // ★ 2026-08-04：统一返回 { matches, boFormat }（BO 判定引擎 S2 信号）。
  //   boFormat = parseBoFormat 的 Format 段赛制映射（云函数端解析，或本地兜底解析）。
  //   兼容旧形状：旧云函数/旧缓存返回数组 → 归一化为 { matches: arr, boFormat: null }。
  function normalizeScheduled(res) {
    if (!res) return { matches: [], boFormat: null };
    if (Array.isArray(res)) return { matches: res, boFormat: null };
    if (Array.isArray(res.matches)) return { matches: res.matches, boFormat: res.boFormat || null };
    return { matches: [], boFormat: null };
  }

  // ★ 2026-08-21：Steam 优先路径（LIVE/UPCOMING 主源）
  //   条件：opts.leagueId 有值 + 云函数可用 → 先查 Steam，命中即返回，未命中回退 Liquipedia。
  //   设计：Steam 与 Liquipedia 数据互补——Steam 专精 LIVE/UPCOMING（Valve 原生 series_id），
  //   Liquipedia 专精赛程元数据/小组赛对阵。两者都查会有冗余但不会冲突（客户端按 series_id 去重）。
  var leagueId = opts && (opts.leagueId || opts.league_id);
  var steamTried = false;
  function trySteamFirst() {
    if (steamTried) return null;
    steamTried = true;
    if (!leagueId) return null;
    if (typeof wx === 'undefined' || !wx.cloud || !(cloudProxy.isAvailable() || cloudProxy.efAvailable())) return null;
    return cloudProxy.steamLeagueScheduledProxy(leagueId, force).then(function (res) {
      var norm = normalizeScheduled(res);
      // Steam 命中（有 LIVE 或 UPCOMING 数据）→ 直接返回
      if (norm.matches && norm.matches.length) {
        return norm;
      }
      return null;  // Steam 空 → 回退 Liquipedia
    }).catch(function () {
      return null;  // Steam 失败 → 回退 Liquipedia
    });
  }

  // ★ 2026-08-22 关键修复：Steam 只覆盖 LIVE 段（GetScheduledLeagueGames 已被 Valve 删除），
  //   若 Steam 命中后短路返回，UPCOMING 段永远拿不到数据。
  //   新策略：Steam 与 Liquipedia/haglund 并行拉取 → 按 phase 合并（Steam 补 LIVE，haglund 补 UPCOMING）。
  //   phase 区分由 sources.groupLiquipediaMatches / buildSeriesFromSources 下游天然处理。
  // ★★ 2026-09-11（**重新启用「本地解析优先」—— 前提已满足**）：
  //
  // 时间线：v8.44 曾启用 → v8.45 实测发现「表里只有主 slug、对阵在子页面」而回退 →
  //         v8.46 扩展 sync 灌表范围 → 用户已灌表成功（183 成功/0 失败）→ **现在重新启用**。
  //
  // ★ 灌表后的实测（用 EF 真实缓存数据）：
  //   · EPL/Masters/2（主 slug，无 scheduledMatchesSlug）→ 本地解析 **32 场** ✅
  //     → 证明「主页面也可能含对阵」，**不能用 scheduledMatchesSlug 是否存在来门控**
  //       （门控会把 EPL 这类排除掉，反而错失收益最大的场景）。
  //   · The_International/2026/Group_Stage → HIT 但 0 场 —— 页面里全是 `{{Match}}` **空占位**
  //     （小组赛未填对阵），解析 0 场是**正确数据**而非错误。
  //
  // 成本评估：`fetchScheduledLocal` 会把结果（含空）写入 6h 缓存 → 多余的 EF 往返
  //   **每个赛事每 6 小时最多一次**，可控。
  //
  // 顺序：本地解析（EF raw + LiquiParse，表命中时**零云开发调用**）→ 云函数 → haglund。
  function fetchLiquipediaChain() {
    return fetchScheduledLocal(slug, cacheKey).then(function (local) {
      if (local && local.matches && local.matches.length) {
        console.log('[liquipedia] 赛程走 EF 缓存 + 本地解析（' + local.matches.length + ' 场，零云开发）');
        return local;
      }
      // ★★ 2026-09-19：**移除云函数兜底**（由用户质疑推动 —— 方向比我上一版的"并行化"更根本）。
      //
      //   原实现走 `cloudProxy.liquipediaScheduledProxy` → `call('liquipediaScheduledMatches')`
      //   → 该 action **不在 EDGE_ACTIONS** → 落到 `callCloud()` = **微信云开发云函数**。
      //   而项目正处于「脱离云开发」阶段，这属于未迁移的遗留依赖。
      //
      //   移除依据（三条叠加，确认它是**纯冗余**）：
      //     ① **功能已被覆盖**：上面的 `fetchScheduledLocal` 就是
      //        「EF 取 raw wikitext（`liquipediaFetchRawWikitext` **早已迁到 EF**）
      //         + 客户端 `LiquiParse` 本地解析」——对应日志
      //        「赛程走 EF 缓存 + 本地解析（N 场，**零云开发**）」。云函数做的是同一件事。
      //     ② **必然失败**：CloudBase 出口 IP 被 Liquipedia Cloudflare **429** 拦（注释已载明）。
      //     ③ **从未成功过**：真机日志中从未出现 `赛程取到（云函数）`，每次都直接跳到 haglund。
      //
      //   附带收益：`liquipediaScheduledMatches` 属 `cloudProxy.js` 列出的
      //   「契约不兼容、待迁移」项 —— 移除后**该项无需再迁**，等于消掉一个脱云阻塞点。
      //
      //   ⚠️ 回退方式：若将来确认云函数有独家数据，可用 git 历史恢复上一版
      //      「云函数 ∥ haglund 并行」的写法（commit 9aff195）。
      console.log('[liquipedia] EF 缓存未命中或无对阵 → haglund 兜底：' + name);
      return tryHaglundFallback(name, force, cacheKey).then(function (hf) {
        if (hf && hf.matches.length) {
          console.log('[liquipedia] 赛程取到（haglund 兜底）：' + hf.matches.length + ' 场');
          return hf;
        }
        console.warn('[liquipedia] 赛程两条路径均为空（EF 本地解析 / haglund）：' + name);
        return { matches: [], boFormat: null };
      });
    });
  }

  if (typeof wx !== 'undefined' && wx.cloud && (cloudProxy.isAvailable() || cloudProxy.efAvailable())) {
    // Steam 与 Liquipedia/haglund 并行拉取，合并两源的 matches（互补覆盖 LIVE/UPCOMING）
    var steamPromise = trySteamFirst();
    var liqPromise = fetchLiquipediaChain();
    return Promise.all([steamPromise, liqPromise]).then(function (results) {
      var steam = results[0] || { matches: [], boFormat: null };
      var liq = results[1] || { matches: [], boFormat: null };
      // ★ 2026-08-22 修复跨源同对局重复（Steam LIVE ↔ haglund UPCOMING 同对局双卡）：
      //   Steam LIVE 用 `Date.now()` 作 startTime（无固定开始时间），haglund 用真实开赛时间，
      //   旧三元组 (team1,team2,startTime) 去重键因 startTime 不同而失效 → 同对局双卡。
      //   方案：两段去重 ——
      //     ① 队名归一化键（顺序无关）覆盖跨源同对局；② 三元组键保留作同源内保险。
      var seen = {};           // 三元组键 → true（同源内严格重复保险）
      var seenTeams = {};      // 队名对归一化键（顺序无关）→ 'steam-live'（跨源同对局去重主键）
      var merged = [];
      // 队名归一化（小写+去空格+去常见后缀，与 league-detail normalizeTeamNameForDedup 同口径）
      // ★ 2026-09-01（三卡修复）：剥离「 x 赞助商」后缀（Valve 全名 'Team x Sponsor' → 'Team'），
      //   与 sources.buildLpLiveSeries._normTeamX 同口径 —— 修复 Steam 全名 vs Liquipedia 简称
      //   同对局跨源去重失效（Inner Circle x Insanity vs Inner Circle → 同一队）。
      function _normTeam(s) {
        if (!s) return '';
        var n = String(s).toLowerCase().trim();
        n = n.replace(/\s*[x×]\s+\S+.*$/i, '');
        n = n.replace(/\s*(esports|e-sports|gaming|team|club)\s*$/g, '');
        n = n.replace(/[^a-z0-9一-鿿а-яё]/g, '');
        return n;
      }
      function _teamPairKey(n1, n2) {
        // 顺序无关：两归一名排序后拼接（防 Steam/haglund 队名换边）
        return n1 < n2 ? (n1 + '|' + n2) : (n2 + '|' + n1);
      }
      function _isTBD(n) { return !n || n === 'tbd' || n === 'tba'; }
      function pushIfNew(m) {
        if (!m) return;
        // ① 三元组严格去重（保险）
        var tri = (m.team1Name || '') + '|' + (m.team2Name || '') + '|' + (m.startTime || m.start_time || 0);
        if (seen[tri]) return;
        // ② 队名对跨源去重：Steam live 卡已存在时，后续同队名对阵（不论 phase/startTime）一律剔除
        //    （Steam LIVE 数据更权威：含真实 series_id/series_wins；haglund 无 series_id）
        var n1 = _normTeam(m.team1Name);
        var n2 = _normTeam(m.team2Name);
        if (n1 && n2 && !_isTBD(n1) && !_isTBD(n2)) {
          var pk = _teamPairKey(n1, n2);
          if (seenTeams[pk]) return;  // 已被先入的 Steam live 占位 → 跳过
          seenTeams[pk] = m.source || m.phase || 'unknown';
        }
        seen[tri] = true;
        merged.push(m);
      }
      // Steam 先入表（LIVE 优先占位），haglund/Liquipedia 后入（同对局被跳过）
      (steam.matches || []).forEach(pushIfNew);
      (liq.matches || []).forEach(pushIfNew);
      var boFormat = steam.boFormat || liq.boFormat || null;
      var combined = { matches: merged, boFormat: boFormat };
      if (merged.length) {
        // ★ 2026-09-01（P1-1 SWR）：写入 TTL 延长至 6h（stale 窗口）；新鲜度由读取侧
        //   getStale(freshSec=30min) 判定，不再靠写入 TTL 表达「30min 内有效」
        try { cache.set(cacheKey, combined, STALE_TTL_SCHEDULE); } catch (e) {}
      }
      console.log('[liquipedia] 合并完成: steam=' + (steam.matches || []).length +
                  ' liquipedia/haglund=' + (liq.matches || []).length +
                  ' merged=' + merged.length + ' league=' + name);
      return combined;
    });
  }
  // 云函数不可用：直接试 haglund 再回退本地
  return tryHaglundFallback(name, force, cacheKey).then(function (hf) {
    if (hf && hf.matches.length) return hf;
    return fetchScheduledLocal(slug, cacheKey);
  });
}

// ★ 2026-08-22 haglund 兜底：Liquipedia 云代理失败/空时的降级入口
//   返回 { matches, boFormat } 形状（与 normalizeScheduled 一致），失败返回 null
//   - name：当前赛事名（用于按 leagueName 过滤 haglund 的全量对阵）
//   - force：透传跳过缓存
//   - cacheKey：可选，命中时把结果写入与 Liquipedia 相同的缓存槽，下次直接走主缓存
function tryHaglundFallback(name, force, cacheKey) {
  return haglund.fetchUpcoming({ leagueName: name, force: force }).then(function (res) {
    if (res && res.matches && res.matches.length) {
      // 命中则写入与 Liquipedia 相同的 cache key，下次走缓存（与主源缓存策略一致）
      // ★ 2026-09-01（P1-1 SWR）：同主源延长至 6h stale 窗口
      if (cacheKey) {
        try { cache.set(cacheKey, res, STALE_TTL_SCHEDULE); } catch (e) {}
      }
      console.log('[liquipedia] haglund 兜底命中, matches=' + res.matches.length +
                  ' league=' + name + ' boFormat=' + (res.boFormat ? res.boFormat.format : 'null'));
      return res;
    }
    console.log('[liquipedia] haglund 兜底未命中, league=' + name);
    return null;
  }).catch(function (e) {
    // haglund 失败不应阻塞下游，返回 null 让调用方继续回退
    console.log('[liquipedia] haglund 兜底异常: ' + (e && e.message));
    return null;
  });
}

// 本地抓取 wikitext + 解析赛程（云代理不可用时的兜底路径）
function fetchScheduledLocal(slug, cacheKey) {
  return fetchPageWikitext(slug)
    .then(function (wikitext) {
      if (!wikitext) return { matches: [], boFormat: null };
      var scheduled = LiquiParse.parseScheduledMatches(wikitext);
      // ★ 2026-08-04：本地兜底路径同样解析 Format 段赛制（S2 信号）
      var boFormat = LiquiParse.parseBoFormat(wikitext);
      var norm = { matches: scheduled, boFormat: boFormat };
      // ★ 2026-09-01（P1-1 SWR）：同主源延长至 6h stale 窗口
      cache.set(cacheKey, norm, STALE_TTL_SCHEDULE);
      return norm;
    })
    .catch(function () { return { matches: [], boFormat: null }; });
}

// ===== P3（2026-08-31）：小组积分表 + 淘汰赛对阵结构 =====
// 抓取赛事结构页 wikitext，解析 {{GroupTableLeague}}/{{SwissStandings}}（小组排名+晋级状态）
// 与 {{Bracket}}（淘汰赛对阵树）。与 getScheduledMatches 的差异：
//   - scheduledMatchesSlug 指向对阵子页面（如 /Group_Stage，61 场 Match）；结构模板
//     （GroupTableLeague/Bracket）通常在**主页面**。故 slug 解析优先级：
//     curation.structureSlug（新增可选字段）→ curation.scheduledMatchesSlug → 主 slug。
//     curation 未配 structureSlug 且 scheduledMatchesSlug 是子页面时解析结果可能为空 —— 空即不展示，无副作用。
// 解析在客户端本地进行（fetchPageWikitext 自带云代理抓取路径），不新增云函数端点。
// 返回 { groups: [{ name, teams: [{rank,name,placement}] }], brackets: [{ id, type, section, rounds }] }
function getLeagueStructure(name, opts) {
  if (!ENABLED || !name) return Promise.resolve({ groups: [], brackets: [] });
  var curationEvent = null;
  try { curationEvent = require('./curation').curatedEventFor(name, { game: 'dota2' }); } catch (e) {}
  var slug = (curationEvent && (curationEvent.structureSlug || curationEvent.scheduledMatchesSlug)) ||
             liquipediaSlugFor(name);
  var cacheKey = 'liquipedia_structure_' + consensus.normName(slug);
  var force = !!(opts && opts.force);
  var cached = cache.get(cacheKey, CACHE_TTL_SCHEDULE);
  if (cached && !force) return Promise.resolve(cached);
  return fetchPageWikitext(slug)
    .then(function (wikitext) {
      if (!wikitext) return { groups: [], brackets: [] };
      var structure = {
        groups: LiquiParse.parseGroupStandings(wikitext),
        brackets: LiquiParse.parseBrackets(wikitext)
      };
      if (structure.groups.length || structure.brackets.length) {
        try { cache.set(cacheKey, structure, CACHE_TTL_SCHEDULE); } catch (e) {}
      }
      return structure;
    })
    .catch(function () { return { groups: [], brackets: [] }; });
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
/** PostgREST 直读 aggregation_cache（队标专用；读不到/过期返回 null） */
function _sbLogoGet(key) {
  try {
    var sb = require('./supabaseClient.js');
    if (!sb || !sb.enabled()) return Promise.resolve(null);
    return sb.rest('aggregation_cache', { select: 'payload,expire_at', eq: { key: key }, limit: 1 })
      .then(function (rows) {
        var row = rows && rows[0];
        if (!row || !row.payload) return null;
        if (row.expire_at && new Date(row.expire_at).getTime() < Date.now()) return null;
        return row.payload;
      })
      .catch(function () { return null; });
  } catch (e) { return Promise.resolve(null); }
}

function getTeamLogo(name) {
  if (!ENABLED || !name) return Promise.resolve(null);

  // 本地缓存优先（与 enrichTeamLogo 共用 logoCache，但此处用通用 cache.js 30 天 TTL）
  var cacheKey = 'liquipedia_team_logo_' + consensus.normName(name);
  var cached = cache.get(cacheKey, CACHE_TTL);
  if (cached) return Promise.resolve(cached);

  // ★★ 2026-09-12（方案 B）：**Supabase 直读优先** —— 队标由 GH Actions 预抓写表（lp:logo:<slug>），
  //   命中即不依赖云开发；未命中再回落云函数（云开发关停后该回落自动失效，返回 null → UI 默认图标）。
  //   动机：保住 LP 队标这一跳，避免少数老/冷门队失去头像。
  var _sbLogoKey = 'lp:logo:' + liquipediaSlugFor(name);
  return _sbLogoGet(_sbLogoKey).then(function (row) {
    if (row && row.logo) {
      console.log('[liquipedia] 队标走 Supabase 直读（零云开发）');
      try { cache.set(cacheKey, row, CACHE_TTL); } catch (e) {}
      return row;
    }
    // ★ 2026-09-19：**移除云函数回落**（`liquipediaTeamLogoProxy` → `liquipediaTeamLogo`）。
    //   上方 2026-09-12 的注释本就说「未命中再回落云函数（**云开发关停后该回落自动失效，
    //   返回 null → UI 默认图标**）」——现在主动去掉，避免每次未命中都白跑一次
    //   必然失败的云调用（该 action 同样不在 EDGE_ACTIONS，走 callCloud = 云开发）。
    //   Supabase 直读（GH Actions 预抓写 `lp:logo:<slug>`）已是主力路径；
    //   未命中即返回 null → UI 默认图标，**行为与云函数失效后完全一致**。
    return null;
  }).catch(function () { return null; });

  // ★ 2026-09-12：原「云代理优先」分支已移除 —— 它在 SB 直读块之后，属不可达代码
  //   （云函数回落逻辑已在 SB 直读块内部处理，见上方 _sbLogoGet 调用处）
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
// O-11（2026-08-15）：listAllTournaments 已删（0 业务引用）；cloudProxy.liquipediaListTournamentsProxy
//   与云函数 handler 防御性保留（未来恢复赛事枚举能力时成本低）。

module.exports = {
  ENABLED: ENABLED,
  getLeagueMetadata: getLeagueMetadata,
  getLeagueTier: getLeagueTier,
  getTeamRoster: getTeamRoster,
  getScheduledMatches: getScheduledMatches,
  getLeagueStructure: getLeagueStructure,   // P3（2026-08-31）：小组积分 + 淘汰赛对阵结构
  getTeamLogo: getTeamLogo,
  parseParticipants: LiquiParse.parseParticipants  // 2026-07-28 导出供单元测试直接调用（单一来源：liquipedia-parse.js）
};
