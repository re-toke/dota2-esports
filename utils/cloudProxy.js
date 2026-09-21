// utils/cloudProxy.js
// CloudBase 云函数代理层：当 config.cloudProxy.enabled 时，优先通过云函数调用
// OpenDota / STRATZ / Steam / Liquipedia（国内加速 + 共享缓存 + key 不上客户端），
// 云函数不可用时静默回退到 api.js / stratz.js / steam.js / liquipedia.js 直连。
//
// 本文件统一导出两类接口：
//   1) 与 api.js 方法对齐的代理方法（getLeagues / getMatch …）—— 调用方无需感知底层。
//   2) 通用 call(action, params) + 各源的便捷方法（steamProxy …）。
//
// 熔断逻辑见 utils/cloudBreaker.js（独立模块，避免与 api.js 循环依赖）。

const api = require('./api.js');
const config = require('./config.js');
const breaker = require('./cloudBreaker.js');

const THRESHOLD = (config.cloudProxy && config.cloudProxy.circuitBreakerThreshold) || 0;

function isAvailable() {
  return breaker.isAvailable(config.cloudProxy && config.cloudProxy.enabled, THRESHOLD);
}

// 通用云函数调用：返回 Promise<data>；失败（含熔断）reject，由调用方决定回退。
// 2026-08-03 优化（A3 force 链路）：call 增加可选 extra 参数，
// 透传云函数顶层字段（如 { force: true }，云函数入口读 e.force）。
// 现有调用不传 extra，行为完全不变（向后兼容）。
//
// ★ 2026-09-01（P0-2）：客户端超时兜底 —— wx.cloud.callFunction 无原生 abort 且默认超时很长，
//   云函数冷启动/排队时页面会无限白屏。按 action 分类设客户端超时：
//   - 读缓存/轻量 action（getLeagues 等）：8s
//   - 实时抓取 action（liquipediaScheduledMatches / steamLeagueScheduled）：12s
//   超时后 reject（err.isTimeout=true）走既有 direct 回退链；callFunction 本身无法 abort，
//   晚到的结果因 Promise 已 settle 被自然丢弃（调用方 gen 代际已是第二道防线）。
//   ★ 超时 ≠ 源故障：不计 breaker.markFailure —— 冷启动慢是正常抖动，
//   计入会把 3 次慢启动误判成熔断 10 分钟全量回退直连（比慢更糟）。
//   端到端预算：超时后 direct 侧还有 12s 请求超时 + 退避重试，最坏 ~25s 落 stale 兜底，
//   与列表页/「即将」tab 的 8s 超时口径统一。
var ACTION_TIMEOUT_MS = {
  _default: 8000,
  // 云端需现场抓 Liquipedia wikitext（2-4s）或 Steam 签名转发的实时 action
  liquipediaScheduledMatches: 12000,
  steamLeagueScheduled: 12000,
  liquipediaLeagueMeta: 12000,
  liquipediaTeamLogo: 12000,
  liquipediaFetchRawWikitext: 12000,
  // P0-C1（2026-09-01）：haglund 云代理 —— 云端现场拉 Cloudflare Workers（1-3s），归实时类 12s
  haglundUpcoming: 12000,
  // P0-3③（2026-09-01）：详情页聚合 bundle —— 云端含 OD 现抓 + explorer。
  // ★ 2026-09-01（详情页 13s 修复）：12s → 8s。云函数端 OD 子任务已改短超时单次尝试
  //   （最坏 6s 快速失败），bundle 整体 8s 内必回；超时回退旧链（getLeagueMatches direct
  //   有 30min cachedFresh 缓存，比干等 bundle 更快拿数据）。
  getLeagueDetailBundle: 8000
};

function timeoutFor(action) {
  return (ACTION_TIMEOUT_MS[action] != null) ? ACTION_TIMEOUT_MS[action] : ACTION_TIMEOUT_MS._default;
}

// ===== M2.4（2026-09-09）：Supabase 数据代理路由 =====
// supabase.enabled=true 时，下列 action 走 Supabase Edge Function（香港，带 Postgres 缓存），
// 失败自动回落云开发链路（callCloud）。EF 返回形状 {data, source} 与云函数一致。
// ⚠️ **未列入的 action**（仍走云开发，属「分阶段迁移」的剩余项）：
//    liquipediaLeagueMeta / liquipediaScheduledMatches / liquipediaTeamLogo /
//    liquipediaListTournaments（LP 解析链 —— 云函数端含解析/聚合逻辑，
//    EF 薄代理只回 raw wikitext，契约不兼容）、getUpcomingSchedule（云端含聚合逻辑）、health。
//    ★ 2026-09-19 更正：本条注释原先还把 **haglundUpcoming / getLeagueDetailBundle**
//      列为「未列入」，但二者**实际已在下方 EDGE_ACTIONS 中映射**（v8.25「M2.4 收尾」时迁入）
//      —— 注释未同步会误导排查（本轮即差点据此误判 stratz/proxy 状态）。
//      **核对该清单时请以 EDGE_ACTIONS 实体为准，不要采信本注释的历史描述。**
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
  // Steam / STRATZ / Liquipedia 薄代理
  steamProxy: 'steam-proxy',
  steamLeagueScheduled: 'steam-proxy',
  stratzGql: 'stratz-proxy',
  // ★ v8.22 挂回：liquipedia-proxy 已改纯读表模式（sync 脚本灌缓存，EF 零 LP 请求）
  liquipediaFetchRawWikitext: 'liquipedia-proxy',
  // ★ 2026-09-21（LP 解析链迁移）：与 liquipediaFetchRawWikitext 同一 EF —— 读缓存表 + 本地解析
  liquipediaLeagueMeta: 'liquipedia-proxy',
  liquipediaScheduledMatches: 'liquipedia-proxy',
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
//   - 命中过期/失败 → 静默丢弃，不影响主链路（保持现有 EF 失败 → 云开发回落语义）。
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
//   trimLeagues 已停止维护（阶段6 云开发下线中），保留回落 = 维护两处口径，
//   一旦漏改就以旧口径服务（junk 复活）。
//   ✅ 安全性：EF 失败后由 utils/api.js 的 filterCollectableLeagues 兜底
//      （它按 utils/tiers.js 判一遍，与数据来源无关）→ 不会漏出未收录赛事。
//   ⚠️ 守卫：scripts/test/test-discover-mirror.js 断言本集合仍含 getLeagues。
var NO_CLOUD_FALLBACK_ACTIONS = { getLeagues: 1 };

function call(action, params, extra) {
  // ★ M2.4：Supabase 数据代理优先；EF 熔断打开或失败 → 回落云开发（NO_CLOUD_FALLBACK_ACTIONS 除外）
  var efName = EDGE_ACTIONS[action];
  if (efName && _sbEfAvailable()) {
    var sbPayload = RAW_PAYLOAD_ACTIONS[action]
      ? (params || {})
      : { action: action, params: params || {} };
    if (extra && typeof extra === 'object' && extra.force != null) sbPayload.force = !!extra.force;
    // ★ 2026-09-11（LP 服务迁 EF）：cacheOnly 透传 —— 让 EF「未命中立即返回」，
    //   客户端据此实现「EF 缓存优先 → 未命中回落云函数」而不用付 7s 的 429 超时。
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
        console.info('[cloudProxy] 热缓存秒回 ' + action + '（' + ageSec + 's 前）');
        return Promise.resolve(h.data);
      }
    }
    return _efCall(action, efName, sbPayload);
  }
  return callCloud(action, params, extra);
}

// EF 单次调用（含云开发回落 + 热缓存写回）
function _efCall(action, efName, sbPayload) {
  return require('./supabaseClient.js').edge(efName, sbPayload).then(function (r) {
    // EF 形状 { data, source } / { error } —— 与云函数 res.result 对齐，取 .data
    if (r && r.data !== undefined) {
      if (HOT_ACTIONS[action]) _hotCache[action] = { data: r.data, ts: Date.now() };
      return r.data;
    }
    throw new Error((r && r.error) || 'ef empty');
  }).catch(function (efErr) {
    // ★ 2026-09-19（选项 C）：口径已「单一权威化」的 action 不回云函数（见 NO_CLOUD_FALLBACK_ACTIONS）
    if (NO_CLOUD_FALLBACK_ACTIONS[action]) {
      console.warn('[cloudProxy] EF ' + efName + ' fail(' + (efErr && efErr.message) + ') → 不回落云函数（'
        + action + ' 口径由 EF 唯一负责；客户端 filterCollectableLeagues 兜底）');
      throw efErr;
    }
    console.info('[cloudProxy] EF ' + efName + ' fail(' + (efErr && efErr.message) + ') → 回落云开发');
    return callCloud(action, sbPayload.params, sbPayload.force != null ? { force: sbPayload.force } : null);
  });
}

// 后台静默刷新（不阻塞调用方；失败静默——旧值仍可用）
function _efRefresh(action, efName, sbPayload) {
  console.info('[cloudProxy] 热缓存过期 ' + action + ' → 后台刷新');
  _efCall(action, efName, sbPayload).catch(function () { /* 静默：旧值仍可用 */ });
}

function callCloud(action, params, extra) {
  if (!isAvailable()) {
    return Promise.reject(new Error('cloud proxy unavailable'));
  }
  var payload = { action: action, params: params || {} };
  if (extra && typeof extra === 'object') {
    Object.keys(extra).forEach(function (k) { payload[k] = extra[k]; });
  }
  var timeoutMs = timeoutFor(action);
  var cloud = wx.cloud.callFunction({
    name: 'aggregation',
    data: payload
  });
  // Promise.race：超时先到则提前 reject（isTimeout 标记）；正常返回则透传
  var timed = Promise.race([
    cloud,
    new Promise(function (_, reject) {
      setTimeout(function () {
        var e = new Error('cloud call timeout (' + timeoutMs + 'ms): ' + action);
        e.isTimeout = true;
        reject(e);
      }, timeoutMs);
    })
  ]);
  return timed.then((res) => {
    const r = res && res.result;
    if (r && !r.error && r.data !== undefined) {
      breaker.markSuccess();
      return r.data;
    }
    breaker.markFailure(THRESHOLD);
    throw new Error((r && r.error) || 'cloud proxy empty');
  }).catch((err) => {
    // 超时不计熔断（冷启动抖动 ≠ 源故障）；仅真实失败（业务 error/网络 reject）计入
    if (!(err && err.isTimeout)) {
      if (isAvailable()) breaker.markFailure(THRESHOLD);
    } else {
      console.info('[cloudProxy] ' + (err && err.message) + ' → 回退 direct（不计熔断）');
    }
    throw err;
  });
}

// ===== OpenDota 代理（与 api.js 方法名对齐）=====
const PARAM_MAP = {
  getLeagues: function () { return {}; },
  getLeagueWindows: function () { return {}; },
  getLeagueMatches: function (id) { return { leagueId: id }; },
  getMatch: function (id) { return { matchId: id }; },
  searchTeams: function (name) { return { q: name }; },
  getTeam: function (id) { return { teamId: id }; },
  getTeamPlayers: function (id) { return { teamId: id }; },
  getTeamMatches: function (id) { return { teamId: id }; },
  getPlayer: function (id) { return { accountId: id }; },
  getPlayerMatches: function (id) { return { accountId: id }; },
  getHeroes: function () { return {}; }
};

// 生成一个代理方法：优先走云函数，失败回退到 api.js
function wrap(methodName) {
  return function () {
    var args = arguments;
    if (!isAvailable()) {
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
// 未命中 / 云函数未部署 / STEAM_API_KEY 未配 → 调用方回退到 Liquipedia 路径。
proxy.steamLeagueScheduledProxy = function (leagueId, force) {
  return call('steamLeagueScheduled', { leagueId: leagueId }, force ? { force: true } : null);
};

// haglund 第三方兜底源云代理（P0-C1，2026-09-01）：
// 云函数 aggregation 的 haglundUpcoming action 服务端拉取 dota.haglund.dev（10min 云端缓存），
// 返回**原始数组**（归一化在客户端 haglund.js 完成，单一实现零漂移）。
// 背景：客户端 wx.request 直连该域在正式版必被域名白名单拦截（海外未备案不可配）。
// 调用方（haglund.fetchUpcoming）已对 wx.cloud + 熔断器做前置守卫，此处仅封装 action。
proxy.haglundUpcomingProxy = function (force) {
  return call('haglundUpcoming', {}, force ? { force: true } : null);
};

// Liquipedia 赛事元数据代理（A+B 双源）：客户端走云函数（Node.js 可设 UA），
// 规避 wx.request 禁设 User-Agent 的限制。云函数 aggregation 的 liquipediaLeagueMeta
// action 抓取 + 纯解析，返回与 liquipedia.getLeagueMetadata 同形状的 metadata。
// 调用方（liquipedia.getLeagueMetadata）已对 wx.cloud + 熔断器做前置守卫，此处仅封装 action。
proxy.liquipediaProxy = function (pageName) {
  return call('liquipediaLeagueMeta', { pageName: pageName });
};

// Liquipedia 赛程数据云代理：调云函数 action=liquipediaScheduledMatches，
// 云端抓取 wikitext + parseScheduledMatches 解析，返回 [{ team1Name, team2Name, startTime, boType, finished, phase }]。
// 与 liquipediaProxy 同样规避 wx.request 禁设 User-Agent 的限制。
proxy.liquipediaScheduledProxy = function (pageName, force) {
  // force=true → 透传云函数顶层 force（跳过云函数缓存现抓，云函数内部有 30s 最小间隔节流）
  return call('liquipediaScheduledMatches', { pageName: pageName }, force ? { force: true } : null);
};

// §8.3 Liquipedia 战队 Logo 云代理（2026-07-29）：OpenDota 无 logo 的兜底源。
// 调云函数 action=liquipediaTeamLogo，云端两步获取（wikitext → imageinfo API）。
// 返回 { logo: url, source: 'liquipedia' } 或 reject（由调用方 catch 降级）。
proxy.liquipediaTeamLogoProxy = function (teamName) {
  return call('liquipediaTeamLogo', { teamName: teamName });
};

// ★ 2026-09-11（LP 服务迁 EF · 清理）：`liquipediaListTournamentsProxy` 已删除。
//   原因：其唯一调用方 `listAllTournaments` 已于 O-11（2026-08-15）移除，
//   此后 **0 业务引用** —— 属死代码。对应云函数 action 亦无客户端调用。
//   （云函数侧 action 未删，避免影响服务端定时任务；如需彻底清理可另行处理。）
// §9 P1（2026-07-30）Liquipedia raw wikitext 代理抓取
// 调云函数 action=liquipediaFetchRawWikitext，返回 { wikitext: string }。
// 用于 getTeamRoster/getPlayerProfile 等客户端本地解析的场景，
// 云函数侧仅做合规抓取（设 UA+gzip），不解析，减少云函数负担。
// ★ 2026-09-11：新增 cacheOnly 参数。
//   cacheOnly=true → EF 仅查 `lp:w:*` 表，未命中**立即**返回 null（不尝试现抓 LP）。
//   用途：客户端「EF 缓存优先」策略 —— 命中走快路径，未命中立刻回落云函数。
// ★ 2026-09-11：**强制走云函数**的 LP raw 抓取 —— 用于「EF 缓存未命中」时的显式回落。
//   为什么需要单独入口：`call()` 只在 EF **抛错**时才回落云开发；而 cacheOnly 未命中时
//   EF 返回的是 `{data:null}`（正常响应，不抛错）→ 不会自动回落，故需显式调用。
//   云函数是**唯一能现抓 LP 的出口**（WeChat 出口可访问；Supabase 出口被 429）。
proxy.liquipediaFetchRawWikitextCloud = function (pageName) {
  return callCloud('liquipediaFetchRawWikitext', { pageName: pageName });
};

proxy.liquipediaFetchRawWikitextProxy = function (pageName, cacheOnly) {
  return call('liquipediaFetchRawWikitext', { pageName: pageName },
              cacheOnly ? { cacheOnly: true } : null);
};

// P0-3③（2026-09-01）：赛事详情页聚合 bundle —— 一次 callFunction 返回
// { matches: [...], teamNames: { team_id: name } }（云端 OD matches + explorer 内网查询）。
// 失败/超时 reject（isTimeout 不计熔断），调用方（league-detail.load）回退旧链
// api.getLeagueMatches + 事后 getTeamNames。
proxy.leagueDetailBundle = function (leagueId, force) {
  return call('getLeagueDetailBundle', { leagueId: leagueId }, force ? { force: true } : null);
};

// 数据源健康检查（2026-08-11 长期架构改进落地）：
// 调云函数 action=health，云端轻量探测 Liquipedia / OpenDota 可达性，
// 返回 { ts, sources: { liquipedia: {status,latencyMs}, opendota: {...} }, ok }。
// 客户端在「数据为空」时据此区分「数据源暂不可用」与「赛事确实无数据」。
// 失败 reject → 调用方 catch 静默降级（视为 unknown，不阻断业务）。
proxy.health = function () {
  return call('health', {});
};

// 暴露给其它模块（api.js / stratz.js / leagues.js 复用）
proxy.isAvailable = isAvailable;
// ★ v8.25：EF 可用性（供调用方守卫使用——云熔断打开但 EF 可用时不应拦代理路径）
proxy.efAvailable = function () { try { return _sbEfAvailable(); } catch (e) { return false; } };
proxy.call = call;

module.exports = proxy;
