// utils/cloudProxy.js
// CloudBase 云函数代理层：当 config.cloudProxy.enabled 时，优先通过云函数调用
// OpenDota（国内加速 + 共享缓存），云函数不可用时静默回退到 api.js 直连。
// 导出接口与 api.js 完全一致（getLeagues / getLeagueMatches / getTeam…等），
// 调用方无需知道底层走云函数还是直连。

const api = require('./api.js');
const config = require('./config.js');

// 参数映射：api.js 的 (id) → cloud function 的 { params }
const PARAM_MAP = {
  getLeagues: function () { return {}; },
  getLeagueWindows: function () { return {}; },
  getLeagueMatches: function (id) { return { leagueId: id }; },
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
    if (!config.cloudProxy.enabled) {
      return api[methodName].apply(api, args);
    }
    var params = (PARAM_MAP[methodName] || function () { return {}; }).apply(null, args);
    return new Promise(function (resolve, reject) {
      wx.cloud.callFunction({
        name: 'aggregation',
        data: { action: methodName, params: params }
      }).then(function (res) {
        var r = res && res.result;
        if (r && !r.error && r.data) {
          resolve(r.data);
        } else {
          throw new Error(r && r.error || 'cloud proxy error');
        }
      }).catch(function () {
        // 云函数失败 → 直连回退
        api[methodName].apply(api, args).then(resolve).catch(reject);
      });
    });
  };
}

// 自动生成所有导出（与 api.js 的方法名对齐）
var METHOD_NAMES = Object.keys(PARAM_MAP);
var proxy = {};
METHOD_NAMES.forEach(function (name) { proxy[name] = wrap(name); });

module.exports = proxy;
