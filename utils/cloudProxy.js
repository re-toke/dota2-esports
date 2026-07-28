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
function call(action, params) {
  if (!isAvailable()) {
    return Promise.reject(new Error('cloud proxy unavailable'));
  }
  return wx.cloud.callFunction({
    name: 'aggregation',
    data: { action: action, params: params || {} }
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
proxy.liquipediaScheduledProxy = function (pageName) {
  return call('liquipediaScheduledMatches', { pageName: pageName });
};

// 暴露给其它模块（api.js / stratz.js / leagues.js 复用）
proxy.isAvailable = isAvailable;
proxy.call = call;

module.exports = proxy;
