// utils/cloudProxy.js
// Supabase EF 代理层：当 config.supabase 可用时，优先通过 Edge Function 调用
// OpenDota / STRATZ / Steam / Liquipedia（国内加速 + 共享缓存 + key 不上客户端），
// EF 不可用时静默回退到 api.js / stratz.js / steam.js / liquipedia.js 直连。
//
// 本文件统一导出两类接口：
//   1) 与 api.js 方法对齐的代理方法（getLeagues / getTeam …）—— 调用方无需感知底层。
//      ⚠️ 2026-10-13：`getMatch` **已刻意移除**（EF 未实现该 action ⇒ 有意走直连，见 BUG-G）。
//   2) 通用 call(action, params) + 各源的便捷方法（steamProxy …）。
//
// ⚠️ 2026-10-12（P1-4）：原 `cloudBreaker` 全局闸门**已删除**（其 markFailure/markSuccess 全仓 0 调用
//   ⇒ 闸门恒开、只是误导）。EF 可用性改用下方 `_sbEfAvailable()`；EF 失败由 supabaseClient 的
//   per-action 熔断（name|action）负责。详见 v1.2.1 P1-4。

const api = require('./api.js');
const config = require('./config.js');

// 通用 EF 调用：返回 Promise<data>；失败（含熔断）reject，由调用方决定回退。
// 2026-08-03 优化（A3 force 链路）：call 增加可选 extra 参数，
// 透传 EF 顶层字段（如 { force: true }，EF 入口读 body.force）。★ 云开发已退役，无云函数回落。
// 现有调用不传 extra，行为完全不变（向后兼容）。
//
// ⚠️ 2026-10-12（P1-5 清死代码）：原 `ACTION_TIMEOUT_MS` 与 `timeoutFor()` **已删除** —— 二者全仓无调用点，
//   唯一影响是制造「超时受控」的假象。EF 路径的真实超时由 utils/supabaseClient.js `edge()` 的
//   `wx.request timeout=25000` 决定；直连路径由 api.js `REQUEST_TIMEOUT_MS=20000` 决定。
//   详见 deliverables/优化方案-数据加载-后端-代码-2026-10-10.md v1.2.1 的 P1-5 / BUG-B。

// ===== M2.4（2026-09-09）：Supabase EF 数据代理路由 =====
// supabase.enabled=true 时，下列 action 经中转走 Supabase Edge Function（EF 内含缓存）。
// ★★ 2026-09-22（微信云开发退役）：**不再有任何云函数回落**（原 `callCloud` 已移除）——
//   EF 是唯一后端；EF 失败即失败，由调用方各自兜底（api.js 直连 / 本地快照等）。
// EF 返回信封 {data, source} / {error}。
// ⚠️ **未登记的 action 一律「有意不经 EF」**（走 `api.js` 直连或本地）：判定**以本文件下方
//   `EDGE_ACTIONS` 实体为准，不要采信任何历史清单** —— 本注释早期版本曾把
//   haglundUpcoming / getLeagueDetailBundle / health 等**已登记**项误列为「未列入」，曾误导排查。
var EDGE_ACTIONS = {
  // OpenDota 11+ action → opendota-proxy
  getLeagues: 'opendota-proxy',
  getLeagueWindows: 'opendota-proxy',
  getLeagueMatches: 'opendota-proxy',
  searchTeams: 'opendota-proxy',
  getTeam: 'opendota-proxy',
  getTeamPlayers: 'opendota-proxy',
  getTeamMatches: 'opendota-proxy',
  getPlayer: 'opendota-proxy',
  getPlayerMatches: 'opendota-proxy',
  getHeroes: 'opendota-proxy',
  getProMatches: 'opendota-proxy',
  getLiveMatches: 'opendota-proxy',
  // ★ 2026-10-12（BUG-A 接线）：数据源健康探测 —— opendota-proxy 新增 health action（探 OpenDota 可达性）
  health: 'opendota-proxy',
  // Steam / STRATZ / Liquipedia 薄代理
  steamProxy: 'steam-proxy',
  steamLeagueScheduled: 'steam-proxy',
  stratzGql: 'stratz-proxy',
  // ★ v8.22 挂回：liquipedia-proxy 已改纯读表模式（sync 脚本灌缓存，EF 零 LP 请求）
  liquipediaFetchRawWikitext: 'liquipedia-proxy',
  // ★ v8.25（M2.4 收尾）：详情页聚合 + haglund 兜底源
  getLeagueDetailBundle: 'bundle-aggregator',
  haglundUpcoming: 'haglund-proxy'
};

// 懒加载（防循环依赖：api.js ←→ cloudProxy 已有环，supabaseClient 只依赖 config 安全）
function _sbEfAvailable() {
  try {
    var c = require('./config.js').supabase || {};
    if (!(c.enabled && c.url && c.anonKey)) return false;
    return require('./supabaseClient.js').efAvailable();
  } catch (e) { return false; }
}

// ===== ★ v8.31（赛事页 4s 感知优化）：EF 读放大缓存 =====
// 问题：EF 路由下 `call()` 每次进页面都发一次跨网请求（香港 EF + Postgres 往返 ≈
//   1.5-2.5s），即便 EF 侧有缓存也要付满 RTT。用户「切走再回来」仍等 2s+。
// 方案：EF 返回的**读类**结果在客户端内存留一份**短 TTL 热缓存**（仅本会话，不落 storage）：
//   - 热缓存命中 → **立即 resolve 旧值**（页面首屏 0 RTT），同时按新鲜度条件触发后台刷新；
//   - 旧值 < HOT_TTL（5min）→ 视为新鲜，后台不刷新（省一次跨网，防切页抖动）；
//   - 旧值 ≥ HOT_TTL → 后台静默刷新，下次进页面即最新（写回热缓存 + writeThrough 本地缓存）。
//   - 命中过期/失败 → 静默丢弃，不影响主链路（EF 失败即失败，**无云开发回落**）。
// 仅对**无参数/参数稳定**且 EF 提供缓存语义的 action 生效（getLeagues 带 windows 一并缓存）。
var HOT_TTL_SEC = 5 * 60;
var HOT_ACTIONS = {
  getLeagues: 1, getLeagueWindows: 1, getHeroes: 1,
  getProMatches: 1, getLiveMatches: 1
};
var _hotCache = {};   // { [action]: { data, ts } }，会话级（小程序自杀即清）

function _hotGet(action) {
  var h = _hotCache[action];
  if (!h) return null;
  return h;
}

// ★ 2026-09-19：部分 EF 期望「裸参数」而非 {action, params} 包裹。
//   如 stratz-proxy 直接读 body.query（见 supabase/functions/stratz-proxy/index.ts:26）。
//   这正是 STRATZ 长期未接入 EF 的真实卡点：EF 早已部署、EDGE_ACTIONS 也已注册
//   stratzGql 映射，但 payload 格式不兼容 → 调用只会得到 400 "query required"。
//   白名单内的 action 直接把 params 展开为顶层 payload（其余 action 行为不变）。
var RAW_PAYLOAD_ACTIONS = { stratzGql: 1 };

// ★ 2026-09-19（选项 C · 收录口径单一权威点）：下列 action **不再回落云函数**。
//   原因：getLeagues 的「白名单准入」口径由 EF 的 trimLeagues 负责；云函数侧的同名
//   trimLeagues 随云开发退役一并废弃，保留回落 = 维护两处口径，
//   一旦漏改就以旧口径服务（junk 复活）。
//   ✅ 安全性：EF 失败后由 utils/api.js 的 filterCollectableLeagues 兜底
//      （它按 utils/tiers.js 判一遍，与数据来源无关）→ 不会漏出未收录赛事。
//   ⚠️ 守卫：scripts/test/test-discover-mirror.js 断言本集合仍含 getLeagues。
// ★★ 2026-09-22（微信云开发脱离）：原 `NO_CLOUD_FALLBACK_ACTIONS` 黑名单**已删除** ——
//   云开发回落整体移除后，所有 action 一律由 EF 唯一负责（失败即失败，由调用方各自兜底）。

function call(action, params, extra) {
  // ★ M2.4：Supabase EF 优先；EF 熔断打开或失败 → 视为失败（**无云开发回落**，已退役）
  var efName = EDGE_ACTIONS[action];
  if (efName && _sbEfAvailable()) {
    var sbPayload = RAW_PAYLOAD_ACTIONS[action]
      ? (params || {})
      : { action: action, params: params || {} };
    if (extra && typeof extra === 'object' && extra.force != null) sbPayload.force = !!extra.force;
    // ★ 2026-09-11（LP 服务迁 EF）：cacheOnly 透传 —— 让 EF「未命中立即返回」，
    //   客户端据此实现「EF 缓存优先 → 未命中立即返回」而不用白付 7s 的 429 超时（无云函数回落）。
    if (extra && typeof extra === 'object' && extra.cacheOnly != null) sbPayload.cacheOnly = !!extra.cacheOnly;

    // ★ v8.31：热缓存秒回（非 force 请求）
    var _force = !!(extra && extra.force);
    if (!_force && HOT_ACTIONS[action]) {
      var h = _hotGet(action);
      if (h) {
        var ageSec = Math.floor((Date.now() - h.ts) / 1000);
        if (ageSec >= HOT_TTL_SEC) {
          // 旧值 + 后台静默刷新（结果写回热缓存，本次调用立即返回旧值）
          _efRefresh(action, efName, sbPayload);
        }
        // ★ P2-23（2026-10-14）：热路径日志走 verboseLog（生产默认静默，避免 Console 噪声刷屏）。
        if (config.debug && config.debug.verboseLog) console.info('[cloudProxy] 热缓存秒回 ' + action + '（' + ageSec + 's 前）');
        return Promise.resolve(h.data);
      }
    }
    // ★ 2026-10-13（方案 A · 流量）：**前台并发去重**。冷启动/切页时多个调用点会在同一 tick
    //   并发同一 action（实测：`app.js` 预取 + `leagues.js` onLoad + `search.js` onLoad 同时拉
    //   `getLeagues`，单次 **321KB** ⇒ 重复 2~3 份）。此处与下方 `_efRefreshInFlight`（只覆盖
    //   **后台刷新**）互补：这一条覆盖**前台首调**。守卫按「action + 载荷」粒度 ⇒ 参数不同
    //   （不同 leagueId / force 标志）不会误合并；命中即复用**同一个 Promise**（成功与失败一并复用）。
    var _k = _callKey(action, sbPayload);
    if (_inflight[_k]) {
      if (config.debug && config.debug.verboseLog) console.info('[cloudProxy] 并发去重命中 ' + action);
      return _inflight[_k];
    }
    var _p = _efCall(action, efName, sbPayload);
    _inflight[_k] = _p;
    var _release = function () { delete _inflight[_k]; };
    _p.then(_release, _release);
    return _p;
  }
  // ★ 2026-09-22：未在 EDGE_ACTIONS 注册的 action 不再回落云开发（云开发已退役）
  return Promise.reject(new Error('action not mapped to any Edge Function: ' + action));
}

// EF 单次调用（热缓存写回；无云开发回落）
function _efCall(action, efName, sbPayload) {
  return require('./supabaseClient.js').edge(efName, sbPayload).then(function (r) {
    // EF 形状 { data, source } / { error } —— 取 .data
    if (r && r.data !== undefined) {
      if (HOT_ACTIONS[action]) _hotCache[action] = { data: r.data, ts: Date.now() };
      return r.data;
    }
    throw new Error((r && r.error) || 'ef empty');
  }).catch(function (efErr) {
    // ★★ 2026-09-22（微信云开发脱离）：**不再回落云开发** —— EF 是唯一后端，失败即失败，
    //   由调用方各自兜底（api.js 直连 / leagues.js 本地快照 / filterCollectableLeagues 等）。
    // ★ P2-23（2026-10-14）：失败日志走 verboseLog（失败已由 supabaseClient 上报 monitor，Console 可静默）。
    if (config.debug && config.debug.verboseLog) console.info('[cloudProxy] EF ' + efName + ' fail(' + (efErr && efErr.message) + ') → 无云开发回落（已退役）');
    throw efErr;
  });
}

// ★ 2026-10-13（方案 A）：前台（`call()`）并发去重的守卫表 + 键函数（见 `call()` 内注释）
var _inflight = {};
function _callKey(action, payload) {
  var s = '';
  try { s = JSON.stringify(payload); } catch (e) { s = ''; }
  return action + '|' + s;
}

// ★ P1-6（2026-10-12）：热缓存过期的**后台刷新去重** —— 原实现每个调用点都各触发一次
//   `_efRefresh`（首页/赛事页多个热 action 调用点在陈旧窗口内并发 ⇒ 同一 action 重复打 EF）。
//   守卫按 action 粒度（本模块热缓存本就是按 action 存的，与 HOT_ACTIONS 同键）。
var _efRefreshInFlight = {};
// 后台静默刷新（不阻塞调用方；失败静默——旧值仍可用）
function _efRefresh(action, efName, sbPayload) {
  if (_efRefreshInFlight[action]) return;
  _efRefreshInFlight[action] = true;
  if (config.debug && config.debug.verboseLog) console.info('[cloudProxy] 热缓存过期 ' + action + ' → 后台刷新');
  var done = function () { delete _efRefreshInFlight[action]; };
  _efCall(action, efName, sbPayload).then(done, done);
}
// ★★ 2026-09-22（微信云开发脱离）：原 `callCloud`（云函数直调）**已移除**。
//   EF 是唯一后端；调用方在 EF 不可用时各自兜底。


// ===== OpenDota 代理（与 api.js 方法名对齐）=====
const PARAM_MAP = {
  getLeagues: function () { return {}; },
  getLeagueWindows: function () { return {}; },
  getLeagueMatches: function (id) { return { leagueId: id }; },
  // ★ 2026-10-13（BUG-G 改法②）：**刻意移除 `getMatch`**（与 `api.js` 的 `ACTION_MAP` 必须同步）——
  //   `opendota-proxy.buildPath()` 未实现该 action ⇒ 登记只会多一次必然失败的 EF 往返（负优化）。
  //   同时**移除 `cloudProxy.proxy.getMatch` 方法**（`METHOD_NAMES = Object.keys(PARAM_MAP)`）⇒
  //   有意不经 EF 的调用一律走 `api.js` 直连（`tryCloudOrDirect` 的「未登记 ⇒ 直接 direct()」守卫）。
  searchTeams: function (name) { return { q: name }; },
  getTeam: function (id) { return { teamId: id }; },
  getTeamPlayers: function (id) { return { teamId: id }; },
  getTeamMatches: function (id) { return { teamId: id }; },
  getPlayer: function (id) { return { accountId: id }; },
  getPlayerMatches: function (id) { return { accountId: id }; },
  getHeroes: function () { return {}; }
};

// 生成一个代理方法：优先走 EF，失败回退到 api.js
function wrap(methodName) {
  return function () {
    var args = arguments;
    if (!_sbEfAvailable()) {
      return api[methodName].apply(api, args);
    }
    var params = (PARAM_MAP[methodName] || function () { return {}; }).apply(null, args);
    return call(methodName, params)
      .catch(function () { return api[methodName].apply(api, args); });
  };
}

var METHOD_NAMES = Object.keys(PARAM_MAP);
var proxy = {};
METHOD_NAMES.forEach(function (name) { proxy[name] = wrap(name); });

// ===== 便捷方法：Steam / Liquipedia 代理（T1 扩展）=====
// Steam Web API：云端用 STEAM_API_KEY 签名后转发 Valve 接口。
// 客户端只传 path + params，绝不持 key。
proxy.steamProxy = function (path, params) {
  return call('steamProxy', { path: path, params: params || {} });
};

// Steam 联赛 LIVE + UPCOMING 对阵聚合（2026-08-21，LIVE/UPCOMING 主源）：
// 云端调 GetLiveLeagueGames + GetScheduledLeagueGames 按 leagueId 过滤，归一化为
// { matches: [...], boFormat: null }（与 liquipediaScheduledProxy 同契约）。
// 用于 liquipedia.getScheduledMatches 前置优先路径——Steam 命中即返回，
// 未命中 / EF 不可用 / STEAM_API_KEY 未配 → 调用方回退到 Liquipedia 路径。
proxy.steamLeagueScheduledProxy = function (leagueId, force) {
  return call('steamLeagueScheduled', { leagueId: leagueId }, force ? { force: true } : null);
};

// haglund 第三方兜底源云代理（P0-C1，2026-09-01）：
// EF haglund-proxy 的 haglundUpcoming action 服务端拉取 dota.haglund.dev（10min 云端缓存），
// 返回**原始数组**（归一化在客户端 haglund.js 完成，单一实现零漂移）。
// 背景：客户端 wx.request 直连该域在正式版必被域名白名单拦截（海外未备案不可配）。
// 调用方（haglund.fetchUpcoming）对 EF 可用性做前置守卫，此处仅封装 action。
proxy.haglundUpcomingProxy = function (force) {
  return call('haglundUpcoming', {}, force ? { force: true } : null);
};

// ★★ 2026-10-10（死代码清理）：本段原有 3 个**已无人调用**的云函数 wrapper ——
//   `liquipediaProxy`（liquipediaLeagueMeta）/ `liquipediaScheduledProxy`（liquipediaScheduledMatches）/
//   `liquipediaTeamLogoProxy`（liquipediaTeamLogo）—— **已删除**。
//   删除依据（都是"看调用点"得出的，不是靠感觉）：
//     · 三个函数在 `utils/ pages/ subpackages/ components/` 内**零调用点**
//       （`liquipedia.js:416` 只剩一句历史注释；另两个零命中）；
//     · `scripts/test`、`scripts/ops` 的守卫**均未引用**它们；
//     · `EDGE_ACTIONS` 里**本来就未登记**这三个 action。
//   历史：它们原是"云开发云函数"的兜底，客户端在 **2026-09-19 就移除了调用**，改走
//     「EF 取 raw wikitext（`liquipediaFetchRawWikitext`）+ 客户端 `LiquiParse` 本地解析」这条
//     **仍然健在**的路径（见下方 `liquipediaFetchRawWikitextProxy`）。
//   ⚠️ 删的是 wrapper 与对应超时条目；**没有**动任何在用的路径。

// ★★ 2026-09-22（云开发退役 · 决策 (b) 接受降级）：原 `liquipediaFetchRawWikitextCloud`
//   （云函数现抓 LP —— 云函数是**唯一能现抓 LP 的出口**，Supabase 出口被 LP 429 拦）**已移除**。
//   影响评估（有据）：其唯一实质消费者是战队名册，而 sources.js:632-637 自述
//   「Liquipedia 名册 account_id 全为 null → 被 consensus.crossMembers 丢弃 → **当前不进 UI**」
//   ⇒ 移除后用户零感知。将来若要启用 LP 名册，应新增「第三方出口（CF Worker + EF 转发）」而非依赖云开发。
proxy.liquipediaFetchRawWikitextProxy = function (pageName, cacheOnly) {
  return call('liquipediaFetchRawWikitext', { pageName: pageName },
              cacheOnly ? { cacheOnly: true } : null);
};

// P0-3③（2026-09-01）：赛事详情页聚合 bundle —— 一次 EF 调用返回
// { matches: [...], teamNames: { team_id: name } }（云端 OD matches + explorer 内网查询）。
// 失败/超时 reject（isTimeout 不计熔断），调用方（league-detail.load）回退旧链
// api.getLeagueMatches + 事后 getTeamNames。
proxy.leagueDetailBundle = function (leagueId, force) {
  return call('getLeagueDetailBundle', { leagueId: leagueId }, force ? { force: true } : null);
};

// 数据源健康检查（2026-08-11 长期架构改进落地；★ 2026-10-12 BUG-A 接线修复）：
// 调 EF `health` action（经 EDGE_ACTIONS → opendota-proxy），服务端探测 OpenDota 可达性，
// 返回 { ts, sources: { liquipedia: {status,latencyMs}, opendota: {...} }, ok }。
// 客户端在「数据为空」时据此区分「数据源暂不可用」与「赛事确实无数据」。
// 失败 reject → 调用方 catch 静默降级（视为 unknown，不阻断业务）。
proxy.health = function () {
  return call('health', {});
};

// 暴露给其它模块（api.js / stratz.js / leagues.js 复用）
// ⚠️ 2026-10-12（P1-4）：`proxy.isAvailable`（全局熔断闸门）已删除；调用方统一改用 `efAvailable`。
proxy.efAvailable = function () { try { return _sbEfAvailable(); } catch (e) { return false; } };
proxy.call = call;

module.exports = proxy;
