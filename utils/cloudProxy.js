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
function call(action, params, extra) {
  if (!isAvailable()) {
    return Promise.reject(new Error('cloud proxy unavailable'));
  }
  var payload = { action: action, params: params || {} };
  if (extra && typeof extra === 'object') {
    Object.keys(extra).forEach(function (k) { payload[k] = extra[k]; });
  }
  return wx.cloud.callFunction({
    name: 'aggregation',
    data: payload
  }).then((res) => {
    const r = res && res.result;
    if (r && !r.error && r.data !== undefined) {
      breaker.markSuccess();
      return r.data;
    }
    breaker.markFailure(THRESHOLD);
    throw new Error((r && r.error) || 'cloud proxy empty');
  }).catch((err) => {
    if (isAvailable()) breaker.markFailure(THRESHOLD);
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

// §9 Liquipedia 赛事主动枚举云代理（2026-07-30）：
// 调云函数 action=liquipediaListTournaments，云端用 categorymembers API 分页枚举
// Category:Tournaments 下全量赛事页面（仅页面标题，不抓 HTML，符合 Liquipedia API 条款）。
// 返回 [{ slug, title }] 或 reject（由调用方 catch 降级为空数组）。
// 云端缓存 7 天 + 月度主动刷新，降频降低 Liquipedia 负载。
proxy.liquipediaListTournamentsProxy = function () {
  return call('liquipediaListTournaments', {});
};

// §9 P1（2026-07-30）Liquipedia raw wikitext 代理抓取
// 调云函数 action=liquipediaFetchRawWikitext，返回 { wikitext: string }。
// 用于 getTeamRoster/getPlayerProfile 等客户端本地解析的场景，
// 云函数侧仅做合规抓取（设 UA+gzip），不解析，减少云函数负担。
proxy.liquipediaFetchRawWikitextProxy = function (pageName) {
  return call('liquipediaFetchRawWikitext', { pageName: pageName });
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
proxy.call = call;

module.exports = proxy;
