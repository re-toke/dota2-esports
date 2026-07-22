// cloudfunctions/aggregation/index.js
// DOTA2 赛事通 —— CloudBase 聚合云函数。
// 功能：代理 OpenDota API（国内访问加速）、可选缓存到云数据库、定时预热热数据。
//
// ## 部署步骤（首次开通）
// 1. 在微信开发者工具顶部点击「云开发」→ 开通 → 创建环境（建议选择「按量计费」）。
// 2. 右键 cloudfunctions/aggregation → 选择「云函数本地调试」(或将整个目录上传为云函数)。
// 3. 在云函数目录下打开终端，运行 npm install（安装 got）。
// 4. 右键 → 上传并部署 → 云端安装依赖。
// 5. （可选）创建云数据库 collection "aggregation_cache" 以避免每次冷调用直连 OpenDota。
// 6. 在 app.js 中调用 cloud.init（已添加）。
//
// ## 客户端调用
// wx.cloud.callFunction({
//   name: 'aggregation',
//   data: { action: 'getLeagueMatches', params: { leagueId: 123 }, force: false }
// }).then(res => {
//   // res.result.data = 比赛数组，与 api.js 直连返回形状一致
//   // res.result.source = 'fresh' | 'cache' | 'cache_fallback'
// })

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const GOT = require('got');

const BASE = 'https://api.opendota.com/api';
const CACHE_COLL = 'aggregation_cache';
const TTL = {
  leagues: 6 * 3600 * 1000,
  leagueMatches: 30 * 60 * 1000,
  team: 6 * 3600 * 1000,
  teamMatches: 30 * 60 * 1000,
  player: 6 * 3600 * 1000,
  playerMatches: 30 * 60 * 1000,
  heroes: 24 * 3600 * 1000
};

// ===== 缓存操作（可选，依赖 cloud DB collection） =====
async function getCache(key) {
  try {
    const db = cloud.database();
    const res = await db.collection(CACHE_COLL).doc(key).get();
    const item = res && res.data;
    if (item && item.expire > Date.now()) return item.data;
    if (item) db.collection(CACHE_COLL).doc(key).remove().catch(() => {});
  } catch (e) {}
  return null;
}

async function setCache(key, data, ttlMs) {
  try {
    const db = cloud.database();
    const expire = Date.now() + (ttlMs || 30 * 60 * 1000);
    await db.collection(CACHE_COLL).doc(key).set({
      data: data,
      expire: expire,
      fetchedAt: Date.now()
    });
  } catch (e) {}
}

// ===== OpenDota 请求 =====
async function fetch(path) {
  const res = await GOT(BASE + path, {
    responseType: 'json',
    timeout: { request: 15000 },
    headers: { 'User-Agent': 'DOTA2-Esports-Hub/1.0' }
  });
  return res.body;
}

// ===== 路由：action → OpenDota path =====
function buildPath(action, params) {
  const p = params || {};
  switch (action) {
    case 'getLeagues':         return '/leagues';
    case 'getLeagueMatches':   return '/leagues/' + p.leagueId + '/matches';
    case 'getTeam':            return '/teams/' + p.teamId;
    case 'getTeamPlayers':     return '/teams/' + p.teamId + '/players';
    case 'getTeamMatches':     return '/teams/' + p.teamId + '/matches';
    case 'getPlayer':          return '/players/' + p.accountId;
    case 'getPlayerMatches':   return '/players/' + p.accountId + '/matches';
    case 'getHeroes':          return '/heroes';
    case 'searchTeams':        return '/search?q=' + encodeURIComponent(p.q || '');
    case 'getLeagueWindows': {
      const sql = 'SELECT leagueid, min(start_time) AS earliest, max(start_time) AS latest, count(*) AS n ' +
        "FROM matches WHERE start_time > extract(epoch FROM now() - interval '1 year') GROUP BY leagueid";
      return '/explorer?sql=' + encodeURIComponent(sql);
    }
    default: return null;
  }
}

function resolveTtl(action) {
  if (action === 'getLeagues') return TTL.leagues;
  if (action === 'getLeagueMatches' || action === 'getTeamMatches' || action === 'getPlayerMatches') return TTL.leagueMatches;
  if (action === 'getTeam' || action === 'getPlayer') return TTL.team;
  if (action === 'getTeamPlayers') return TTL.team;
  if (action === 'getPlayer') return TTL.player;
  if (action === 'getHeroes') return TTL.heroes;
  return 30 * 60 * 1000;
}

// ===== 定时预热：刷新热端点的缓存 =====
async function handleTimer() {
  const hotEndpoints = [
    '/leagues',
    '/heroes',
    "/explorer?sql=" + encodeURIComponent(
      'SELECT leagueid, min(start_time) AS earliest, max(start_time) AS latest, count(*) AS n ' +
      "FROM matches WHERE start_time > extract(epoch FROM now() - interval '1 year') GROUP BY leagueid"
    )
  ];
  const results = [];
  for (const path of hotEndpoints) {
    try {
      const data = await fetch(path);
      await setCache(path, data, 6 * 3600 * 1000);
      results.push({ path, ok: true });
    } catch (e) {
      results.push({ path, ok: false, error: e.message });
    }
  }
  return { ok: true, results };
}

// ===== 主入口 =====
exports.main = async (event, context) => {
  // 定时触发
  if (event.TriggerName === 'cron') {
    return await handleTimer();
  }

  const { action, params, force } = event;
  if (!action) return { error: 'action required' };

  // 内置定时指令
  if (action === '__cron__') return await handleTimer();

  const path = buildPath(action, params);
  if (!path) return { error: 'unknown action: ' + action };

  // 查缓存（非 force）
  const cacheKey = path;
  if (!force) {
    const cached = await getCache(cacheKey);
    if (cached) return { data: cached, source: 'cache' };
  }

  // 代理请求 OpenDota
  try {
    const data = await fetch(path);
    // 后台缓存（不阻塞返回）
    setCache(cacheKey, data, resolveTtl(action)).catch(() => {});
    return { data: data, source: 'fresh' };
  } catch (e) {
    // 请求失败时尝试用过期缓存兜底
    const fallback = await getCache(cacheKey);
    if (fallback) return { data: fallback, source: 'cache_fallback' };
    return { error: 'fetch failed: ' + e.message };
  }
};
