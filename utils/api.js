// utils/api.js
// OpenDota 公开 API 封装（无需 key，免费）。文档：https://docs.opendota.com/
//
// 关键能力：
//  - request(): 带限流（约 60 次/分钟，最小间隔 + 429 退避）。
//  - cached(): 带 TTL 的本地缓存，命中不计入限流，是降低请求量的核心手段。
//  - 所有对外方法默认走 cached()，TTL 见 config.cacheTTL。
//  - 可选云函数代理（config.cloudProxy.enabled）：优先走云函数，失败回退直连。

const cache = require('./cache.js');
const config = require('./config.js');
const inc = require('./incremental.js');
const sqlFragments = require('./sqlFragments.js');
const breaker = require('./cloudBreaker.js');

const BASE = 'https://api.opendota.com/api';

// 赛事等级映射（OpenDota 的 tier 字符串枚举）
const TIER_RANK = {
  professional: 3, // S 级（顶级职业赛事）
  premium: 2,      // A 级（高级职业赛事）
  amateur: 1,      // 业余
  excluded: 0      // 其他 / 不计入
};

// ===== 限流器 =====
const RATE = config.rateLimit;
let lastCall = 0;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function rawRequest(path, data) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: BASE + path,
      data: data || {},
      method: 'GET',
      header: { 'content-type': 'application/json' },
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data);
        } else if (res.statusCode === 429) {
          // 触发限流，交由外层重试
          const err = new Error('HTTP 429');
          err.statusCode = 429;
          reject(err);
        } else {
          reject(new Error('HTTP ' + res.statusCode));
        }
      },
      fail: (err) => reject(err)
    });
  });
}

// 带限流的请求：串行保留请求槽位，避免并发瞬间打满 60/min
function request(path, data, opts) {
  opts = opts || {};
  const now = Date.now();
  const wait = Math.max(0, lastCall + RATE.minGapMs - now);
  lastCall = now + wait; // 立即预留槽位，杜绝并发竞争
  return sleep(wait)
    .then(() => rawRequest(path, data))
    .catch((err) => {
      if (err && err.statusCode === 429 && (opts.retries || 0) < RATE.maxRetries) {
        const delay = RATE.retryBaseMs * Math.pow(2, opts.retries || 0);
        return sleep(delay).then(() =>
          request(path, data, { retries: (opts.retries || 0) + 1 }));
      }
      throw err;
    });
}

// 响应校验：避免将畸形/空响应写入缓存；畸形时回退到陈旧缓存。
// 空数组 [] 视为合法（OpenDota 合法地返回空列表），仅拒绝 null/undefined/''/非数组/错误对象。
function validateResponse(path, data) {
  if (!path) return true;
  // /explorer?sql=... → 期望 { rows: [...] }
  if (path.indexOf('/explorer') === 0) {
    return !!(data && Array.isArray(data.rows));
  }
  // 数组型端点：/leagues, /search, /heroes, /heroStats, /items, /heroes/{id}/matchups,
  //              /teams/{id}/matches, /teams/{id}/players, /leagues/{id}/matches, /players/{id}/matches
  if (path === '/leagues' || path === '/search' || path === '/heroes' ||
      path === '/heroStats' || path === '/items' ||
      /^\/heroes\/\d+\/matchups$/.test(path) ||
      /^\/teams\/\d+\/matches$/.test(path) || /^\/teams\/\d+\/players$/.test(path) ||
      /^\/leagues\/\d+\/matches$/.test(path) || /^\/players\/\d+\/matches$/.test(path)) {
    return Array.isArray(data);
  }
  // 对象型端点：/teams/{id}, /players/{id}
  if (/^\/teams\/\d+$/.test(path) || /^\/players\/\d+$/.test(path)) {
    return !!(data && typeof data === 'object' && !Array.isArray(data));
  }
  // 默认：不限制（未知端点不过度校验）
  return true;
}

// 带缓存的请求：命中缓存直接返回（不计入限流）
function cached(path, data, ttlSec) {
  const key = path + '|' + JSON.stringify(data || {});
  const hit = cache.get(key, ttlSec);
  if (hit !== null && hit !== undefined) return Promise.resolve(hit);
  return request(path, data).then((data) => {
    if (!validateResponse(path, data)) {
      // 畸形响应：不写入缓存，尝试回退到陈旧缓存
      const stale = cache.peek(key);
      if (stale && stale.value != null) return stale.value;
      throw new Error('invalid response');
    }
    cache.set(key, data, ttlSec);
    return data;
  });
}

// 后台刷新进行中的 key 集合（避免同一 key 重复触发刷新）
const refreshInFlight = {};

// 带「stale-while-revalidate」的请求：保障信息更新的及时性。
//   - 硬 TTL 内且新鲜：直接返回缓存（最省流量）
//   - 未过期但已陈旧：先返回旧值，再在后台静默刷新（用户无感拿到新数据）
//   - 已过期/无缓存：正常拉取
// 与 cached() 返回形态一致（仅 resolve 业务数据），调用方无需改动取值逻辑。
function cachedFresh(path, data, freshSec, ttlSec) {
  const key = path + '|' + JSON.stringify(data || {});
  const meta = cache.getStale(key, freshSec, ttlSec);
  if (meta.expired || !meta.value) {
    return request(path, data).then((data) => {
      if (!validateResponse(path, data)) {
        // 畸形响应：回退到旧值（若有），否则抛错
        if (meta.value != null) return meta.value;
        throw new Error('invalid response');
      }
      cache.set(key, data, ttlSec);
      return data;
    });
  }
  if (meta.fresh) {
    return Promise.resolve(meta.value);
  }
  // 陈旧但未过期：返回旧值 + 后台刷新（去重）
  if (!refreshInFlight[key]) {
    refreshInFlight[key] = true;
    request(path, data)
      .then((data) => {
        if (validateResponse(path, data)) cache.set(key, data, ttlSec);
      })
      .catch(() => {})
      .then(() => { delete refreshInFlight[key]; });
  }
  return Promise.resolve(meta.value);
}

// 查询某请求最新采集时间戳（用于 UI 「更新于 X 前」）。返回 unix 毫秒或 0。
function fetchedAtOf(name, arg) {
  let path = null;
  if (name === 'team') path = '/teams/' + arg;
  else if (name === 'teamPlayers') path = '/teams/' + arg + '/players';
  else if (name === 'teamMatches') path = '/teams/' + arg + '/matches';
  else if (name === 'player') path = '/players/' + arg;
  else if (name === 'playerMatches') path = '/players/' + arg + '/matches';
  else if (name === 'leagueMatches') path = '/leagues/' + arg + '/matches';
  else if (name === 'leagueWindows') {
    path = '/explorer?sql=' + encodeURIComponent(sqlFragments.LEAGUE_WINDOWS_SQL);
  }
  if (!path) return 0;
  const meta = cache.peek(path + '|{}');
  return (meta && meta.fetchedAt) || 0;
}

// ===== 增量拉取（联赛/战队/选手比赛列表）=====
// 思路：首次/硬过期 → 走直连端点全量拉取并整体替换；
//       陈旧(软过期) → 用 /explorer 按 start_time 游标只拉「比缓存最新一场更新的比赛」，
//       按 match_id 去重并入缓存头部，显著降低大列表(尤其选手数千场)的重拉成本与流量。
function fetchMatchDelta(resource, id, cursor) {
  const sql = inc.buildMatchSql(resource, id, cursor);
  const path = '/explorer?sql=' + encodeURIComponent(sql);
  return request(path).then((d) => (d && d.rows) || []);
}

// 增量版 cachedFresh：resPath 为直连全量端点（首次/硬过期用）；resource/id 用于游标增量。
function cachedFreshIncremental(resPath, resource, id, freshSec, ttlSec) {
  const key = resPath + '|{}';
  const meta = cache.getStale(key, freshSec, ttlSec);
  if (meta.expired || !meta.value) {
    return request(resPath).then((data) => {
      if (!validateResponse(resPath, data)) {
        // 畸形响应：回退到旧值（若有），否则抛错
        if (meta.value != null) return meta.value;
        throw new Error('invalid response');
      }
      cache.set(key, data, ttlSec);
      return data;
    });
  }
  if (meta.fresh) {
    return Promise.resolve(meta.value);
  }
  // 陈旧未过期：后台增量合并（游标无效时退化为等待下次硬过期全量刷新）
  const cursor = inc.maxStart(meta.value);
  if (!refreshInFlight[key] && cursor > 0) {
    refreshInFlight[key] = true;
    fetchMatchDelta(resource, id, cursor)
      .then((delta) => {
        if (delta && delta.length) {
          cache.set(key, inc.mergeMatches(meta.value, delta), ttlSec);
        } else {
          cache.touch(key, ttlSec); // 无新数据，仅刷新采集时间（轮询心跳）
        }
      })
      // 不静默吞错：打印警告便于排查增量 SQL / 限流 / 字段变更等问题；
      // 用户仍拿到旧值，不影响主流程。
      .catch((e) => {
        console.warn('[api] incremental refresh failed:', resPath, (e && e.message) || e);
      })
      .then(() => { delete refreshInFlight[key]; });
  }
  return Promise.resolve(meta.value);
}

// ===== 云函数代理（可选）=====
// 当 config.cloudProxy.enabled 时，优先走云函数（国内加速 + 共享缓存），
// 失败时自动回退到直连逻辑（cached/cachedFresh），不产生循环依赖。
// 注意：cloudProxy.js 顶部 require('./api.js') 用于回退，故 api.js 顶部不可
// 反向 require('./cloudProxy.js')，否则循环依赖。cloudFetch 内联了相同逻辑。
function cloudFetch(action, params) {
  const threshold = (config.cloudProxy && config.cloudProxy.circuitBreakerThreshold) || 0;
  return wx.cloud.callFunction({
    name: 'aggregation',
    data: { action: action, params: params || {} }
  }).then((res) => {
    const r = res && res.result;
    if (r && !r.error && r.data) {
      breaker.markSuccess();
      return r.data;
    }
    breaker.markFailure(threshold);
    throw new Error((r && r.error) || 'cloud proxy error');
  }).catch((err) => {
    breaker.markFailure(threshold);
    throw err;
  });
}

function cloudEnabled() {
  const threshold = (config.cloudProxy && config.cloudProxy.circuitBreakerThreshold) || 0;
  return breaker.isAvailable(config.cloudProxy && config.cloudProxy.enabled, threshold);
}

// 方法名 → (action, params-builder)，与 cloudProxy.js 的 PARAM_MAP 对齐
const ACTION_MAP = {
  getLeagues: function () { return { action: 'getLeagues', params: {} }; },
  getLeagueWindows: function () { return { action: 'getLeagueWindows', params: {} }; },
  getLeagueMatches: function (id) { return { action: 'getLeagueMatches', params: { leagueId: id } }; },
  getMatch: function (id) { return { action: 'getMatch', params: { matchId: id } }; },
  searchTeams: function (name) { return { action: 'searchTeams', params: { q: name } }; },
  getTeam: function (id) { return { action: 'getTeam', params: { teamId: id } }; },
  getTeamPlayers: function (id) { return { action: 'getTeamPlayers', params: { teamId: id } }; },
  getTeamMatches: function (id) { return { action: 'getTeamMatches', params: { teamId: id } }; },
  getPlayer: function (id) { return { action: 'getPlayer', params: { accountId: id } }; },
  getPlayerMatches: function (id) { return { action: 'getPlayerMatches', params: { accountId: id } }; },
  getHeroes: function () { return { action: 'getHeroes', params: {} }; }
};

// ===== 对外方法 =====

function getLeagues() {
  const direct = function () { return cached('/leagues', null, config.cacheTTL.leagues); };
  if (cloudEnabled()) {
    const m = ACTION_MAP.getLeagues();
    return cloudFetch(m.action, m.params).catch(function () { return direct(); });
  }
  return direct();
}

// 一次 SQL 拿所有赛事近一年的时间窗口：{ leagueid -> { earliest, latest, count } }
// 用于「正在进行 / 全部（按最近比赛排序）」判定，避免逐个拉 /leagues/{id}/matches。
function transformLeagueWindows(data) {
  const rows = (data && data.rows) || [];
  const map = {};
  rows.forEach((r) => {
    if (r && r.leagueid != null) {
      map[r.leagueid] = {
        earliest: Number(r.earliest) || 0,
        latest: Number(r.latest) || 0,
        count: Number(r.n) || 0
      };
    }
  });
  return map;
}

function getLeagueWindows() {
  const path = '/explorer?sql=' + encodeURIComponent(sqlFragments.LEAGUE_WINDOWS_SQL);
  const direct = function () {
    return cached(path, null, config.cacheTTL.leagueWindows).then(transformLeagueWindows);
  };
  if (cloudEnabled()) {
    const m = ACTION_MAP.getLeagueWindows();
    return cloudFetch(m.action, m.params).then(transformLeagueWindows).catch(function () { return direct(); });
  }
  return direct();
}

function getLeagueMatches(leagueId) {
  // 比赛结果频繁变动：较短新鲜窗口 + 较长硬 TTL；陈旧时后台按游标增量合并
  const direct = function () {
    return cachedFreshIncremental('/leagues/' + leagueId + '/matches', 'league', leagueId, 10 * 60, config.cacheTTL.leagueMatches);
  };
  if (cloudEnabled()) {
    const m = ACTION_MAP.getLeagueMatches(leagueId);
    return cloudFetch(m.action, m.params).catch(function () { return direct(); });
  }
  return direct();
}

// 单场比赛详情（含 players 数组：英雄/KDA/GPM/XPM）。
// OpenDota /matches/{match_id} 返回结构：
//   match_id, duration, start_time, radiant_win, radiant_score, dire_score,
//   radiant_team_id, dire_team_id, league, leagueid,
//   players: [{ account_id, hero_id, kills, deaths, assists,
//               gold_per_min, xp_per_min, player_slot, team, personaname, name }]
function getMatch(matchId) {
  const direct = function () { return cached('/matches/' + matchId, null, config.cacheTTL.match); };
  if (cloudEnabled()) {
    const m = ACTION_MAP.getMatch(matchId);
    return cloudFetch(m.action, m.params).catch(function () { return direct(); });
  }
  return direct();
}

// 比赛双方选手明细：从 getMatch 结果中拆出 players 数组并按阵营分组。
// 返回 { radiant: [...], dire: [...] }，每个元素含
//   { account_id, hero_id, kills, deaths, assists, gpm, xpm, name, personaname }
function getMatchPlayers(matchId) {
  return getMatch(matchId).then(function (m) {
    if (!m || !m.players) return { radiant: [], dire: [] };
    const radiant = [];
    const dire = [];
    m.players.forEach(function (p) {
      const item = {
        account_id: p.account_id,
        hero_id: p.hero_id,
        kills: p.kills || 0,
        deaths: p.deaths || 0,
        assists: p.assists || 0,
        gpm: p.gold_per_min || 0,
        xpm: p.xp_per_min || 0,
        name: p.name || p.personaname || '',
        // OpenDota player_slot 0-4 天辉，128-132 夜魇
        isRadiant: (p.isRadiant != null) ? p.isRadiant : (p.player_slot < 128)
      };
      if (item.isRadiant) radiant.push(item);
      else dire.push(item);
    });
    return { radiant: radiant, dire: dire };
  });
}

function transformSearchTeams(list) {
  return (list || [])
    .filter((item) => item && item.team_id)
    .map((item) => ({ team_id: item.team_id, name: item.name }))
    .slice(0, 30);
}

function transformSearchPlayers(list) {
  return (list || [])
    .filter((item) => item && item.account_id)
    .map((item) => ({ account_id: item.account_id, name: item.personaname || item.name || ('ID:' + item.account_id) }))
    .slice(0, 30);
}

function searchTeams(name) {
  // 搜索结果短时缓存，避免连续相同搜索重复消耗配额
  const direct = function () { return cached('/search', { q: name }, 5 * 60).then(transformSearchTeams); };
  if (cloudEnabled()) {
    const m = ACTION_MAP.searchTeams(name);
    return cloudFetch(m.action, m.params).then(transformSearchTeams).catch(function () { return direct(); });
  }
  return direct();
}

function searchPlayers(name) {
  const direct = function () { return cached('/search', { q: name }, 5 * 60).then(transformSearchPlayers); };
  if (cloudEnabled()) {
    return cloudFetch('searchTeams', { q: name }).then(transformSearchPlayers).catch(function () { return direct(); });
  }
  return direct();
}

function getTeam(teamId) {
  const direct = function () { return cachedFresh('/teams/' + teamId, null, 60 * 60, config.cacheTTL.team); };
  if (cloudEnabled()) {
    const m = ACTION_MAP.getTeam(teamId);
    return cloudFetch(m.action, m.params).catch(function () { return direct(); });
  }
  return direct();
}

function getTeamPlayers(teamId) {
  const direct = function () { return cachedFresh('/teams/' + teamId + '/players', null, 60 * 60, config.cacheTTL.teamPlayers); };
  if (cloudEnabled()) {
    const m = ACTION_MAP.getTeamPlayers(teamId);
    return cloudFetch(m.action, m.params).catch(function () { return direct(); });
  }
  return direct();
}

function getTeamMatches(teamId) {
  const direct = function () {
    return cachedFreshIncremental('/teams/' + teamId + '/matches', 'team', teamId, 10 * 60, config.cacheTTL.teamMatches);
  };
  if (cloudEnabled()) {
    const m = ACTION_MAP.getTeamMatches(teamId);
    return cloudFetch(m.action, m.params).catch(function () { return direct(); });
  }
  return direct();
}

function getPlayer(accountId) {
  const direct = function () { return cachedFresh('/players/' + accountId, null, 60 * 60, config.cacheTTL.player); };
  if (cloudEnabled()) {
    const m = ACTION_MAP.getPlayer(accountId);
    return cloudFetch(m.action, m.params).catch(function () { return direct(); });
  }
  return direct();
}

function getPlayerMatches(accountId) {
  const direct = function () {
    return cachedFreshIncremental('/players/' + accountId + '/matches', 'player', accountId, 10 * 60, config.cacheTTL.playerMatches);
  };
  if (cloudEnabled()) {
    const m = ACTION_MAP.getPlayerMatches(accountId);
    return cloudFetch(m.action, m.params).catch(function () { return direct(); });
  }
  return direct();
}

function getHeroes() {
  const direct = function () { return cached('/heroes', null, config.cacheTTL.heroes); };
  if (cloudEnabled()) {
    const m = ACTION_MAP.getHeroes();
    return cloudFetch(m.action, m.params).catch(function () { return direct(); });
  }
  return direct();
}

// 职业赛场英雄统计（登场 / 胜场 / 禁用）。返回数组，元素含
//   { id, pro_pick, pro_win, pro_ban, ... }。用于英雄页排序与详情页胜率/登场率。
function getHeroStats() {
  return cached('/heroStats', null, config.cacheTTL.heroes);
}

// 英雄对位数据：该英雄与另一英雄同场时的胜负样本。返回数组，元素含
//   { hero_id, games_played, wins }。winRate = wins / games_played。
// 用于详情页「最佳 / 最差对位」（OpenDota 不区分同队/敌对，统一按同场胜率呈现）。
function getHeroMatchups(id) {
  return cached('/heroes/' + id + '/matchups', null, config.cacheTTL.heroes);
}

// 批量查询队伍名（team_id -> name）。
// 用途：OpenDota /leagues/{id}/matches 直连端点返回的 radiant_team_name / dire_team_name
// 普遍为 null（matches 表未存队名），需用 team_id 反查 teams 表补全，否则联赛比赛列表
// 队名全部缺失（兜底显示"天辉/夜魇"）。一次 /explorer SQL 批量取，长缓存降低请求量。
function getTeamNames(teamIds) {
  const ids = (teamIds || [])
    .map((x) => Number(x))
    .filter((x) => !isNaN(x) && x > 0);
  if (!ids.length) return Promise.resolve({});
  const sql = 'SELECT team_id, name FROM teams WHERE team_id IN (' + ids.join(',') + ')';
  const path = '/explorer?sql=' + encodeURIComponent(sql);
  return cached(path, null, 6 * 3600).then((data) => {
    const rows = (data && data.rows) || [];
    const map = {};
    rows.forEach((r) => { if (r && r.team_id != null) map[r.team_id] = r.name || ''; });
    return map;
  });
}

// 物品表（id -> { name, img, dname }）：OpenDota /constants/items 返回 { name: { id, img, dname } }，
// 反转为 id 索引便于比赛详情页按 item_0~5 数字 id 查物品名/图标。长缓存（物品几乎不变）。
function getItems() {
  return cached('/constants/items', null, 24 * 3600).then((data) => {
    const map = {};
    if (!data) return map;
    Object.keys(data).forEach((name) => {
      const it = data[name];
      if (it && it.id != null) {
        map[it.id] = { name: name, img: it.img || ('items/' + name + '.png'), dname: it.dname || name };
      }
    });
    return map;
  });
}

// 物品基础表（数组）：OpenDota /items 返回 [{ id, name, cost, secret_shop, side_shop, recipe, localized_name }]。
// 含价格 / 是否配方 / 商店类型，用于物品浏览与详情；与 getItems() 的 img/dname 合并补全显示信息。
function getItemsList() {
  return cached('/items', null, config.cacheTTL.heroes);
}

module.exports = {
  BASE: BASE,
  TIER_RANK: TIER_RANK,
  request: request,
  cached: cached,
  cachedFresh: cachedFresh,
  fetchedAtOf: fetchedAtOf,
  getLeagues: getLeagues,
  getLeagueWindows: getLeagueWindows,
  getLeagueMatches: getLeagueMatches,
  getMatch: getMatch,
  getMatchPlayers: getMatchPlayers,
  searchTeams: searchTeams,
  searchPlayers: searchPlayers,
  getTeam: getTeam,
  getTeamPlayers: getTeamPlayers,
  getTeamMatches: getTeamMatches,
  getPlayer: getPlayer,
  getPlayerMatches: getPlayerMatches,
  getHeroes: getHeroes,
  getHeroStats: getHeroStats,
  getHeroMatchups: getHeroMatchups,
  getTeamNames: getTeamNames,
  getItems: getItems,
  getItemsList: getItemsList
};
