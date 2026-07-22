// utils/steam.js
// 第三网络数据源：Steam Web API（Valve 官方 DOTA2 接口，免费 key）。
// 申请 key：https://steamcommunity.com/dev/apikey（需 Steam 账号，每天 100,000 次调用）。
//
// 启用条件：config.steam.enabled === true 且填了 apiKey。
// 未启用 → 所有方法优雅降级（resolve null/[]）。
//
// 核心价值：GetLiveLeagueGames 能拿到「正在直播的职业比赛」（队名+比分+观众数），
// 这是 OpenDota 没有的实时数据维度。

const config = require('./config.js');

const ENABLED = !!(config.steam && config.steam.enabled && config.steam.apiKey);
const BASE = (config.steam && config.steam.base) || 'https://api.steampowered.com/IDOTA2Match_570';

function get(path, params) {
  if (!ENABLED) return Promise.resolve(null);
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

// 正在直播的职业比赛（实时比分 + 队伍 + 观众数）
// Steam API 返回约 5-20 条正在打的天梯/职业比赛，含 lobby_id、radiant/dire 队名、比分、观众数、阶段
function getLiveLeagueGames() {
  if (!ENABLED) return Promise.resolve([]);
  return get('/GetLiveLeagueGames').then((d) => {
    const games = (d && d.result && d.result.games) || [];
    return games.map((g) => ({
      lobbyId: g.lobby_id,
      radiantName: g.radiant_team ? (g.radiant_team.team_name || '天辉') : '天辉',
      direName: g.dire_team ? (g.dire_team.team_name || '夜魇') : '夜魇',
      radiantScore: g.radiant_score || 0,
      direScore: g.dire_score || 0,
      radiantLogo: g.radiant_team ? g.radiant_team.team_logo : '',
      direLogo: g.dire_team ? g.dire_team.team_logo : '',
      radiantTeamId: g.radiant_team ? g.radiant_team.team_id : 0,
      direTeamId: g.dire_team ? g.dire_team.team_id : 0,
      spectators: g.spectators || 0,
      stage: g.stage_name || '',
      leagueId: g.league_id,
      leagueName: g.league_name || '',
      live: true
    }));
  }).catch(() => []);
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

module.exports = {
  ENABLED: ENABLED,
  getLiveLeagueGames: getLiveLeagueGames,
  getLeagues: getLeagues,
  getTeamInfo: getTeamInfo
};
