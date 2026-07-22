// utils/api.js
// OpenDota 公开 API 封装（无需 key，免费）。文档：https://docs.opendota.com/
//
// 关键能力：
//  - request(): 带限流（约 60 次/分钟，最小间隔 + 429 退避）。
//  - cached(): 带 TTL 的本地缓存，命中不计入限流，是降低请求量的核心手段。
//  - 所有对外方法默认走 cached()，TTL 见 config.cacheTTL。

const cache = require('./cache.js');
const config = require('./config.js');
const inc = require('./incremental.js');

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

// 带缓存的请求：命中缓存直接返回（不计入限流）
function cached(path, data, ttlSec) {
  const key = path + '|' + JSON.stringify(data || {});
  const hit = cache.get(key, ttlSec);
  if (hit !== null && hit !== undefined) return Promise.resolve(hit);
  return request(path, data).then((data) => {
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
      .then((data) => { cache.set(key, data, ttlSec); })
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
    const sql = "SELECT leagueid, min(start_time) AS earliest, max(start_time) AS latest, count(*) AS n " +
      "FROM matches WHERE start_time > extract(epoch FROM now() - interval '1 year') GROUP BY leagueid";
    path = '/explorer?sql=' + encodeURIComponent(sql);
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
    return request(resPath).then((data) => { cache.set(key, data, ttlSec); return data; });
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

// ===== 对外方法 =====

function getLeagues() {
  return cached('/leagues', null, config.cacheTTL.leagues);
}

// 一次 SQL 拿所有赛事近一年的时间窗口：{ leagueid -> { earliest, latest, count } }
// 用于「正在进行 / 全部（按最近比赛排序）」判定，避免逐个拉 /leagues/{id}/matches。
function getLeagueWindows() {
  const sql =
    "SELECT leagueid, min(start_time) AS earliest, max(start_time) AS latest, count(*) AS n " +
    "FROM matches WHERE start_time > extract(epoch FROM now() - interval '1 year') " +
    "GROUP BY leagueid";
  const path = '/explorer?sql=' + encodeURIComponent(sql);
  return cached(path, null, config.cacheTTL.leagueWindows).then((data) => {
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
  });
}

function getLeagueMatches(leagueId) {
  // 比赛结果频繁变动：较短新鲜窗口 + 较长硬 TTL；陈旧时后台按游标增量合并
  return cachedFreshIncremental('/leagues/' + leagueId + '/matches', 'league', leagueId, 10 * 60, config.cacheTTL.leagueMatches);
}

function searchTeams(name) {
  // 搜索结果短时缓存，避免连续相同搜索重复消耗配额
  return cached('/search', { q: name }, 5 * 60).then((list) => {
    return (list || [])
      .filter((item) => item && item.team_id)
      .map((item) => ({ team_id: item.team_id, name: item.name }))
      .slice(0, 30);
  });
}

function getTeam(teamId) {
  return cachedFresh('/teams/' + teamId, null, 60 * 60, config.cacheTTL.team);
}

function getTeamPlayers(teamId) {
  return cachedFresh('/teams/' + teamId + '/players', null, 60 * 60, config.cacheTTL.teamPlayers);
}

function getTeamMatches(teamId) {
  return cachedFreshIncremental('/teams/' + teamId + '/matches', 'team', teamId, 10 * 60, config.cacheTTL.teamMatches);
}

function getPlayer(accountId) {
  return cachedFresh('/players/' + accountId, null, 60 * 60, config.cacheTTL.player);
}

function getPlayerMatches(accountId) {
  return cachedFreshIncremental('/players/' + accountId + '/matches', 'player', accountId, 10 * 60, config.cacheTTL.playerMatches);
}

function getHeroes() {
  return cached('/heroes', null, config.cacheTTL.heroes);
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
  searchTeams: searchTeams,
  getTeam: getTeam,
  getTeamPlayers: getTeamPlayers,
  getTeamMatches: getTeamMatches,
  getPlayer: getPlayer,
  getPlayerMatches: getPlayerMatches,
  getHeroes: getHeroes,
  getTeamNames: getTeamNames
};
