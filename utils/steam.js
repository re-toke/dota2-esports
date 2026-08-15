// utils/steam.js
// 第三网络数据源：Steam Web API（Valve 官方 DOTA2 接口，免费 key）。
// 申请 key：https://steamcommunity.com/dev/apikey（需 Steam 账号，每天 100,000 次调用）。
//
// 启用条件：config.steam.enabled === true 且填了 apiKey。
// 未启用 → 所有方法优雅降级（resolve null/[]）。
//
// 核心价值：提供赛事奖金池（GetTournamentPrizePool，OpenDota/STRATZ 无此数据）、
// 战队官方信息、比赛详情等官方维度数据，作为 OpenDota/STRATZ 的交叉补充。

const config = require('./config.js');
const cloudProxy = require('./cloudProxy.js');

// 启用条件（二选一）：
//   A) 云代理模式（上线推荐）：config.cloudProxy.enabled=true → Steam key 由云函数环境变量注入，
//      客户端只传 path + params，绝不持 key。
//   B) 直连模式（本地调试 fallback）：config.steam.apiKey 有值（仅本地，绝不上传）。
const cloudOk = !!(config.cloudProxy && config.cloudProxy.enabled);
const ENABLED = !!(config.steam && config.steam.enabled) && (cloudOk || !!(config.steam && config.steam.apiKey));
const BASE = (config.steam && config.steam.base) || 'https://api.steampowered.com/IDOTA2Match_570';

function getDirect(path, params) {
  if (!config.steam || !config.steam.apiKey) return Promise.resolve(null);
  const ps = Object.assign({ key: config.steam.apiKey }, params || {});
  const qs = Object.keys(ps).map((k) => k + '=' + encodeURIComponent(ps[k])).join('&');
  const url = BASE + path + '/v1/?' + qs;
  return new Promise((resolve) => {
    wx.request({
      url: url,
      method: 'GET',
      header: { 'content-type': 'application/json' },
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300 && res.data) {
          resolve(res.data);
        } else {
          resolve(null);
        }
      },
      fail: () => resolve(null)
    });
  });
}

// 统一入口：云代理优先（key 安全），直连兜底（需本地 apiKey）。
function get(path, params) {
  if (!ENABLED) return Promise.resolve(null);
  if (cloudProxy.isAvailable()) {
    return cloudProxy.steamProxy(path, params)
      .catch(() => getDirect(path, params));
  }
  return getDirect(path, params);
}

// 联赛列表（Valve 官方注册联赛，可用于交叉校验）
function getLeagues() {
  if (!ENABLED) return Promise.resolve([]);
  return get('/GetLeagueListing').then((d) => {
    const list = (d && d.result && d.result.leagues) || [];
    return list.map((l) => ({
      leagueId: l.leagueid,
      name: l.name,
      description: l.description || '',
      url: l.tournament_url || ''
    }));
  }).catch(() => []);
}

// 战队信息（Valve 官方，按 team_id 查询）
function getTeamInfo(teamId) {
  if (!ENABLED) return Promise.resolve(null);
  return get('/GetTeamInfoByTeamID', { start_at_team_id: teamId, teams_requested: 1 }).then((d) => {
    const teams = (d && d.result && d.result.teams) || [];
    const t = teams[0];
    if (!t) return null;
    return {
      teamId: t.team_id,
      name: t.name,
      tag: t.tag,
      logo: t.logo_url || '',
      country: t.country_code || ''
    };
  }).catch(() => null);
}

// 赛事奖金池（TI 奖金池，Steam 独有，OpenDota/STRATZ 无此数据）
// 返回 prize_pool（美元浮点）与币种，未启用或失败时返回 null。
function getTournamentPrizePool(leagueId) {
  if (!ENABLED) return Promise.resolve(null);
  return get('/GetTournamentPrizePool', { league_id: leagueId }).then((d) => {
    const r = (d && d.result) || null;
    if (!r) return null;
    return {
      prizePool: r.prize_pool != null ? Number(r.prize_pool) : 0,
      prizePoolCurrency: r.prize_pool_currency || 'USD',
      leagueId: leagueId,
      source: 'steam'
    };
  }).catch(() => null);
}

module.exports = {
  ENABLED: ENABLED,
  getLeagues: getLeagues,
  getTeamInfo: getTeamInfo,
  getTournamentPrizePool: getTournamentPrizePool
};
