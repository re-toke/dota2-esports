// cloudfunctions/aggregation/index.js
// DOTA2赛事 —— CloudBase 聚合云函数。
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
// Keep in sync with utils/sqlFragments.js (single source of truth)
const LEAGUE_WINDOWS_SQL = "SELECT leagueid, min(start_time) AS earliest, max(start_time) AS latest, count(*) AS n FROM matches WHERE start_time > extract(epoch FROM now() - interval '1 year') GROUP BY leagueid";
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

// ===== STRATZ GraphQL 请求（用于赛程预热）=====
// STRATZ API key 从云函数环境变量 STRATZ_API_KEY 读取（在云开发控制台配置）。
// 未配置时跳过 STRATZ 预热，不影响 OpenDota 代理。
const STRATZ_BASE = 'https://api.stratz.com/graphql';
const STRATZ_KEY = process.env.STRATZ_API_KEY || '';

async function fetchStratz(query, variables) {
  if (!STRATZ_KEY) return null;
  const res = await GOT.post(STRATZ_BASE, {
    json: { query: query, variables: variables || {} },
    headers: {
      'content-type': 'application/json',
      'Authorization': 'Bearer ' + STRATZ_KEY
    },
    responseType: 'json',
    timeout: { request: 15000 }
  });
  return res.body && res.body.data;
}

// ===== Steam Web API 代理（key 从环境变量注入，客户端零明文，T1）=====
const STEAM_BASE = 'https://api.steampowered.com/IDOTA2Match_570';
const STEAM_KEY = process.env.STEAM_API_KEY || '';

async function fetchSteam(path, params) {
  if (!STEAM_KEY) return null;
  const ps = Object.assign({ key: STEAM_KEY }, params || {});
  const qs = Object.keys(ps).map((k) => k + '=' + encodeURIComponent(ps[k])).join('&');
  const url = STEAM_BASE + path + '/v1/?' + qs;
  const res = await GOT(url, {
    responseType: 'json',
    timeout: { request: 15000 },
    headers: { 'User-Agent': 'DOTA2-Esports-Hub/1.0' }
  });
  return res.body;
}

// ===== Liquipedia 代理常量（描述性 UA，微信端不可设；供 upcoming 实时赛程等使用）=====
const LIQUIPEDIA_BASE = 'https://liquipedia.net/dota2/api.php';
const LIQUIPEDIA_UA = 'DOTA2-Esports-Hub/1.0 (WeChat Mini Program; contact: dev@local)';

// ===== Liquipedia 赛事列表（"即将到来"实时源，无需 STRATZ key）=====
// 通过 action=parse 取 Portal:Tournaments 渲染后的 HTML，解析 "Upcoming" 段落的
// 赛事表格（Tier / 名称 / 日期），作为「即将到来」tab 的实时数据源。
// 相比 STRATZ（需 key），Liquipedia 零 key、人工策展、覆盖下半年已公布赛程。
// 仅取 Tier 1 / Tier 2（Premier + Major），避免 Tier 3/4 预选赛刷屏。
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

// 解析 Liquipedia 日期文本：支持 同月 "Nov 17–29, 2026"、跨月 "Sep 29 – Oct 11, 2026"、单日 "Jul 27, 2026"
// 分隔符兼容 en-dash / em-dash / hyphen。失败返回 null（非日期单元格被忽略）。
function parseLiquipediaDate(text) {
  if (!text) return null;
  const s = String(text).replace(/[‒–—―]/g, '-').trim();
  const m = s.match(/^([A-Z][a-z]{2})\s+(\d{1,2})(?:\s*-\s*(?:([A-Z][a-z]{2})\s+)?(\d{1,2}))?,\s*(\d{4})$/);
  if (!m) return null;
  const sm = MONTHS[m[1].toLowerCase()];
  const em = m[3] ? MONTHS[m[3].toLowerCase()] : sm;
  const sd = parseInt(m[2], 10);
  const ed = m[4] ? parseInt(m[4], 10) : sd;
  const year = parseInt(m[5], 10);
  if (sm == null || em == null || isNaN(sd) || isNaN(ed) || isNaN(year)) return null;
  const start = Math.floor(Date.UTC(year, sm, sd, 0, 0, 0) / 1000);
  const end = Math.floor(Date.UTC(year, em, ed, 23, 59, 59) / 1000);
  return { start: start, end: end };
}

// 基于规范名生成稳定的负数 id（与 curation 占位 id 风格一致，避免与真实 leagueid 冲突）
function hashId(name) {
  const k = String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
  let h = 0;
  for (let i = 0; i < k.length; i++) h = ((h << 5) - h + k.charCodeAt(i)) | 0;
  return -(Math.abs(h) % 1000000 + 1000000);
}

// Liquipedia tier 数字 → 产品分级 { grade, rank, label }
function liquipediaTierToGrade(t) {
  if (t <= 1) return { grade: 'S', rank: 3, label: 'S级' };
  if (t === 2) return { grade: 'A', rank: 2, label: 'A级' };
  if (t === 3) return { grade: 'B', rank: 1, label: 'B级' };
  return { grade: 'B', rank: 1, label: 'B级' };
}

async function fetchLiquipediaUpcoming() {
  const res = await GOT(LIQUIPEDIA_BASE, {
    searchParams: { action: 'parse', page: 'Portal:Tournaments', prop: 'text', format: 'json' },
    headers: { 'User-Agent': LIQUIPEDIA_UA, 'Accept': 'application/json' },
    responseType: 'json',
    timeout: { request: 15000 }
  });
  const html = res.body && res.body.parse && res.body.parse.text && res.body.parse.text['*'];
  if (!html) return [];
  // 仅取 "Upcoming" 段落（到下一个 mw-headline 为止）
  const startIdx = html.indexOf('id="Upcoming"');
  if (startIdx < 0) return [];
  const nextHead = html.indexOf('class="mw-headline"', startIdx + 10);
  const section = html.slice(startIdx, nextHead > 0 ? nextHead : html.length);

  const nowSec = Math.floor(Date.now() / 1000);
  const out = [];
  const rowRe = /<tr class="table2&#95;&#95;row--(body|highlighted)">(.*?)<\/tr>/gs;
  let m;
  while ((m = rowRe.exec(section)) !== null) {
    const row = m[2];
    const tm = row.match(/Tier_(\d+)_Tournaments/);
    const liqTier = tm ? parseInt(tm[1], 10) : 0;
    if (liqTier > 2) continue; // 仅 Tier 1 / Tier 2
    const nm = row.match(/column&#95;&#95;tournament[^>]*><a[^>]*>([^<]+)<\/a>/);
    const name = nm ? nm[1].trim() : null;
    if (!name) continue;
    const dm = row.match(/<td class="" data-nowrap="">([^<]+)<\/td>/);
    const dr = dm ? parseLiquipediaDate(dm[1]) : null;
    if (!dr) continue; // 日期解析失败（非日期单元格）跳过
    if (dr.end < nowSec) continue; // 已结束不进入"即将到来"
    const g = liquipediaTierToGrade(liqTier);
    out.push({
      id: hashId(name),
      name: name,
      grade: g.grade,
      rank: g.rank,
      label: g.label,
      tier: liqTier,
      start: dr.start,
      end: dr.end,
      source: 'liquipedia'
    });
  }
  return out;
}

// 知名 S 级赛事关键词（与客户端 leagues.js 保持一致）
const KNOWN_KEYWORDS = /(international|major|esl\s+one|esl\s+pro|dreamleague|blast|riyadh|pgl|betboom|clavision|fissure|the\s+summit|games\s+of\s+the\s+future|heroic|resurrection|weplay|moonstorm|dpc|tour|division\s+i)/i;

// 赛程预热：优先 STRATZ（需 key，数据最全，含真实联赛 id 便于跳转详情）；
// 未配 STRATZ key 时自动改用 Liquipedia 实时赛事列表（零 key，覆盖下半年已公布 Tier 1/2 赛程）。
// 两者都把结果写入云缓存 upcoming_schedule，供 getUpcomingSchedule / 客户端"即将到来"秒开读取。
async function preheatUpcoming() {
  if (STRATZ_KEY) return await preheatUpcomingFromStratz();
  try {
    const events = await fetchLiquipediaUpcoming();
    if (!events.length) return { ok: false, reason: 'no liquipedia upcoming' };
    const windows = {};
    events.forEach((ev) => {
      windows[ev.id] = {
        id: ev.id,
        name: ev.name,
        grade: ev.grade,
        rank: ev.rank,
        label: ev.label,
        tier: ev.tier,
        start: ev.start,
        end: ev.end,
        source: ev.source
      };
    });
    await setCache('upcoming_schedule', windows, 6 * 3600 * 1000);
    return { ok: true, count: Object.keys(windows).length, source: 'liquipedia' };
  } catch (e) {
    return { ok: false, reason: 'liquipedia error: ' + (e && e.message) };
  }
}

// STRATZ 赛程预热（需 STRATZ_API_KEY）：拉全量赛事 → 筛知名赛事 → 逐个查赛程窗口 → 存 cloud DB
// 客户端 loadUpcoming 优先读此缓存，避免串行 2s 限流导致首次加载 2 分钟。
async function preheatUpcomingFromStratz() {
  // 1. 拉全量赛事
  const leaguesData = await fetchStratz('query { leagues(request: { take: 200 }) { id name tier displayName } }');
  const leagues = (leaguesData && leaguesData.leagues) || [];
  if (!leagues.length) return { ok: false, reason: 'no leagues' };

  // 2. 筛知名赛事（与客户端 KNOWN_KEYWORDS 一致），取前 30 个
  const targets = leagues
    .filter((l) => KNOWN_KEYWORDS.test(l.name || l.displayName || ''))
    .slice(0, 30);

  // 3. 逐个查赛程窗口（云函数服务端查，不阻塞客户端；2s 间隔避免 STRATZ 限流）
  const windows = {};
  for (const lg of targets) {
    try {
      const d = await fetchStratz('query ($id: Int!) { league(id: $id) { startDateTime endDateTime } }', { id: Number(lg.id) });
      const l = d && d.league;
      if (l && (l.startDateTime || l.endDateTime)) {
        windows[lg.id] = {
          id: lg.id,
          name: lg.displayName || lg.name,
          tier: lg.tier,
          start: l.startDateTime ? Math.floor(l.startDateTime / 1000) : null,
          end: l.endDateTime ? Math.floor(l.endDateTime / 1000) : null
        };
      }
    } catch (e) { /* 隔离 */ }
    // STRATZ 限流：2s 间隔
    await new Promise((r) => setTimeout(r, 2000));
  }

  // 4. 存 cloud DB（客户端读此缓存秒开）
  await setCache('upcoming_schedule', windows, 6 * 3600 * 1000);
  return { ok: true, count: Object.keys(windows).length };
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
    case 'getLeagueWindows':   return '/explorer?sql=' + encodeURIComponent(LEAGUE_WINDOWS_SQL);
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

// ===== 定时预热：刷新热端点的缓存 + STRATZ 赛程预热 =====
async function handleTimer() {
  const hotEndpoints = [
    '/leagues',
    '/heroes',
    '/explorer?sql=' + encodeURIComponent(LEAGUE_WINDOWS_SQL)
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
  // STRATZ 赛程预热（解决客户端"即将到来"首次加载慢）
  try {
    const r = await preheatUpcoming();
    results.push({ preheatUpcoming: r });
  } catch (e) {
    results.push({ preheatUpcoming: { ok: false, error: e.message } });
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

  // 赛程预热（手动触发，或客户端读取预热结果）
  if (action === 'preheatUpcoming') return await preheatUpcoming();

  // STRATZ GraphQL 代理：客户端不存 apiKey，通过云函数环境变量 STRATZ_API_KEY 中转
  if (action === 'stratzGql') {
    const { query, variables } = event;
    if (!query) return { error: 'query required' };
    const data = await fetchStratz(query, variables);
    if (data) return { data: data, source: 'stratz' };
    return { error: 'stratz fetch failed' };
  }

  // Steam Web API 代理：客户端不存 apiKey，通过云函数环境变量 STEAM_API_KEY 中转（T1）
  if (action === 'steamProxy') {
    const { path, params } = event;
    if (!path) return { error: 'path required' };
    if (!STEAM_KEY) return { error: 'STEAM_API_KEY not set' };
    try {
      const data = await fetchSteam(path, params);
      if (data) return { data: data, source: 'steam' };
      return { error: 'steam fetch failed' };
    } catch (e) {
      return { error: 'steam fetch error: ' + (e && e.message) };
    }
  }

  // Liquipedia 赛事列表（"即将到来"实时源，无需 STRATZ key）：解析 Portal:Tournaments
  // Upcoming 段落，返回 Tier 1/2 赛事数组。供调试 / 直接读取，正式链路走 getUpcomingSchedule。
  if (action === 'getLiquipediaUpcoming') {
    try {
      const data = await fetchLiquipediaUpcoming();
      return { data: data, source: 'liquipedia' };
    } catch (e) {
      return { error: 'liquipedia upcoming error: ' + (e && e.message) };
    }
  }

  if (action === 'getUpcomingSchedule') {
    const cached = await getCache('upcoming_schedule');
    if (cached) return { data: cached, source: 'cache' };
    // 缓存未命中：现场预热一次（耗时较长，客户端应配 loading 提示）
    const r = await preheatUpcoming();
    if (r.ok) {
      const data = await getCache('upcoming_schedule');
      return { data: data || {}, source: 'fresh' };
    }
    return { error: 'preheat failed', detail: r };
  }

  // T6 A/B 实验配置下发。生产环境应读云数据库 experiments collection（按用户分桶），
  // 此处返回静态样本配置，客户端拉取后缓存并按 variant 灰度。后端契约见 README。
  if (action === 'getExperiments') {
    return {
      experiments: {
        follow_cta_variant: { variant: 'A', enabled: true } // A=去发现战队 / B=浏览热门战队
      },
      source: 'cloud'
    };
  }

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
