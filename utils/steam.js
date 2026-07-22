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

// 赛事选手聚合统计（联赛维度的选手汇总：场次/K/D/A，字段可能缺失，做防御性解析）
function getTournamentPlayerStats(leagueId, accountId) {
  if (!ENABLED) return Promise.resolve(null);
  return get('/GetTournamentPlayerStats', { league_id: leagueId, account_id: accountId }).then((d) => {
    const r = (d && d.result) || null;
    if (!r) return null;
    return {
      accountId: accountId,
      leagueId: leagueId,
      matchesPlayed: r.matches_played != null ? Number(r.matches_played) : 0,
      kills: r.kills != null ? Number(r.kills) : 0,
      deaths: r.deaths != null ? Number(r.deaths) : 0,
      assists: r.assists != null ? Number(r.assists) : 0,
      source: 'steam'
    };
  }).catch(() => null);
}

// 单场比赛详情（比 OpenDota match 列表字段更全，可用于交叉校验）
function getMatchDetails(matchId) {
  if (!ENABLED) return Promise.resolve(null);
  return get('/GetMatchDetails', { match_id: matchId }).then((d) => {
    const r = (d && d.result) || null;
    if (!r) return null;
    const players = (r.players || []).map((p) => ({
      account_id: p.account_id || 0,
      hero_id: p.hero_id || 0,
      kills: p.kills || 0,
      deaths: p.deaths || 0,
      assists: p.assists || 0,
      gpm: p.gold_per_min || 0,
      xpm: p.xp_per_min || 0
    }));
    return {
      match_id: matchId,
      duration: r.duration || 0,
      radiant_win: !!r.radiant_win,
      radiant_score: r.radiant_score || 0,
      dire_score: r.dire_score || 0,
      players: players,
      source: 'steam'
    };
  }).catch(() => null);
}

// 顶尖天梯直播比赛（GetLiveLeagueGames 仅覆盖职业联赛，本接口覆盖高 MMR 天梯对局）
// 注意：响应字段为 team_id_radiant / team_id_dire（非 radiant_team_id）
function getTopLiveGame() {
  if (!ENABLED) return Promise.resolve([]);
  return get('/GetTopLiveGame', { partner: 0 }).then((d) => {
    const list = (d && d.game_list) || [];
    return list.map((g) => ({
      matchId: g.match_id,
      serverSteamId: g.server_steam_id,
      radiantTeamId: g.team_id_radiant || 0,
      direTeamId: g.team_id_dire || 0,
      radiantScore: g.radiant_score || 0,
      direScore: g.dire_score || 0,
      leagueId: g.league_id || 0,
      live: true,
      source: 'steam'
    }));
  }).catch(() => []);
}

module.exports = {
  ENABLED: ENABLED,
  getLiveLeagueGames: getLiveLeagueGames,
  getLeagues: getLeagues,
  getTeamInfo: getTeamInfo,
  getTournamentPrizePool: getTournamentPrizePool,
  getTournamentPlayerStats: getTournamentPlayerStats,
  getMatchDetails: getMatchDetails,
  getTopLiveGame: getTopLiveGame
};
