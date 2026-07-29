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
// 增加 max(start_time + duration) AS last_end：真实比赛结束时间，用于列表"进行中"准确判定
const LEAGUE_WINDOWS_SQL = "SELECT leagueid, min(start_time) AS earliest, max(start_time) AS latest, max(start_time + duration) AS last_end, count(*) AS n FROM matches WHERE start_time > extract(epoch FROM now() - interval '6 months') GROUP BY leagueid";
const CACHE_COLL = 'aggregation_cache';

// 赛事展示名规范覆盖（G4 单一数据源）。
// 与小程序共用同一份生成映射：league-canon-map.js + curation-shared.json，
// 由 scripts/sync-canon-map.js 从 utils/curation.js 生成并镜像到本目录。
// ⚠️ 部署云函数前必须重新运行 npm run sync:canon，使本副本与小程序侧保持同步。
const leagueCanon = require('./league-canon-map');
function canonicalLeagueName(raw) {
  const r = leagueCanon.resolveCanonical(raw);
  return r || 'DOTA2 赛事';
}
// 2026-07-27：新增带上下文的规范名解析，支持 leagueId 精确 pin（云函数推送文案场景）。
// 注：云函数侧仅做 leagueId pin（game 跨游戏隔离的真正威力在小程序侧 curation 引擎中，
//   见 utils/curation.js）。leagueId pin 数据来自同步脚本生成的 leagueIdMap（见 curation-shared）。
function canonicalLeagueNameWithCtx(raw, ctx) {
  const base = canonicalLeagueName(raw);
  if (!ctx || ctx.leagueId == null) return base;
  const shared = require('./curation-shared');
  const lm = shared && shared.leagueIdMap;
  if (lm && lm[ctx.leagueId] && lm[ctx.leagueId] !== raw) return lm[ctx.leagueId];
  return base;
}
// ===== B3 统一错误码格式（Phase 1-④，2026-07-29）=====
// 标准化错误对象：{ code, message, detail?, error }
// code：机器可读错误码（客户端可据此做精细处理）
// message：人类可读错误描述（中文，便于排查）
// detail：可选，附加上下文（如异常堆栈/原始错误）
// error：向后兼容字段（字符串形式，供旧客户端 r.error 判断）
const ERROR_CODES = {
  BAD_REQUEST: 'bad_request',           // 参数缺失/非法（4xx 类）
  NOT_CONFIGURED: 'not_configured',     // API key 未配置
  UPSTREAM_ERROR: 'upstream_error',     // 外部 API 请求失败（5xx/网络）
  PARSE_ERROR: 'parse_error',           // 数据解析失败
  NOT_FOUND: 'not_found',               // 资源不存在
  UNKNOWN: 'unknown'                   // 未知错误
};
function makeError(code, message, detail) {
  const err = { code: code || ERROR_CODES.UNKNOWN, message: message || '未知错误' };
  if (detail != null) err.detail = detail;
  err.error = err.message;  // 向后兼容：旧客户端用 r.error 字符串判断
  return err;
}

const TTL = {
  leagues: 6 * 3600 * 1000,
  leagueMatches: 30 * 60 * 1000,
  team: 6 * 3600 * 1000,
  teamMatches: 30 * 60 * 1000,
  player: 6 * 3600 * 1000,
  playerMatches: 30 * 60 * 1000,
  heroes: 24 * 3600 * 1000,
  // 2026-07-29 差异化 TTL（Phase 1-②）
  // 元数据（奖金池/地点/赛制/参赛队等）变化极慢，24h 长缓存减少重复请求
  liquipediaMeta: 24 * 3600 * 1000,
  // 赛程（未开赛/进行中的对阵）变化敏感，30min 短缓存保证时效性
  liquipediaSchedule: 30 * 60 * 1000,
  // §8.3 战队 Logo（2026-07-29）：战队 logo 几乎不变，30 天长缓存减少 Liquipedia 请求
  liquipediaTeamLogo: 30 * 24 * 3600 * 1000
};

// ===== 缓存操作（可选，依赖 cloud DB collection） =====
// 2026-07-27：缓存 key 加 dataVersion 前缀。dataVersion 由 utils/curation-shared.js 输出，
// 每次 scripts/sync-canon-map.js 运行即更新。语义：curation/代码变更后云函数重新部署，
// 新 dataVersion 使所有旧缓存 key 自动失效，相当于"代码部署即缓存失效"，
// 根治"云函数部署后数据未正确更新"的根因（旧 cloud DB 缓存跨部署持久化）。
//
// B5 L1 内存缓存（2026-07-29）：在 cloud DB（L2）之前加一层内存缓存（L1）。
// 云函数实例存活期间 L1 有效，命中后跳过 cloud DB 读，减少 50-200ms 延迟。
// 实例回收后 L1 丢失，自动降级为 L2 only（无功能影响，仅性能回退）。
// L1 上限 100 条（LRU 裁剪最旧），key 带 dataVersion 前缀，部署后自动失效。
const L1_MAX = 100;
const l1Cache = new Map();  // key → { data, expire }
function l1Get(key) {
  const e = l1Cache.get(key);
  if (!e) return null;
  if (Date.now() > e.expire) {
    l1Cache.delete(key);
    return null;
  }
  // LRU：删除后重新插入，使最近访问的排到末尾（Map 保持插入顺序）
  l1Cache.delete(key);
  l1Cache.set(key, e);
  return e.data;
}
function l1Set(key, data, ttlMs) {
  l1Cache.set(key, { data: data, expire: Date.now() + (ttlMs || 30 * 60 * 1000) });
  // 超上限裁剪最旧条目（Map 迭代顺序 = 插入顺序，最早插入的最先被删）
  if (l1Cache.size > L1_MAX) {
    const oldest = l1Cache.keys().next().value;
    if (oldest !== undefined) l1Cache.delete(oldest);
  }
}

function _v() {
  try { return (require('./curation-shared').dataVersion || '0') + ':'; } catch (e) { return '0:'; }
}
async function getCache(key) {
  const fullKey = _v() + key;
  // L1 命中：跳过 cloud DB 读，减少 50-200ms 延迟
  const l1 = l1Get(fullKey);
  if (l1 !== null) return l1;
  // L1 未命中 → 走 cloud DB（L2）
  try {
    const db = cloud.database();
    const res = await db.collection(CACHE_COLL).doc(fullKey).get();
    const item = res && res.data;
    if (item && item.expire > Date.now()) {
      l1Set(fullKey, item.data, item.expire - Date.now());  // L2 命中 → 回填 L1
      return item.data;
    }
    if (item) db.collection(CACHE_COLL).doc(fullKey).remove().catch(() => {});
  } catch (e) {}
  return null;
}

async function setCache(key, data, ttlMs) {
  const fullKey = _v() + key;
  const expire = Date.now() + (ttlMs || 30 * 60 * 1000);
  // 同时写 L1 + L2
  l1Set(fullKey, data, ttlMs);
  try {
    const db = cloud.database();
    await db.collection(CACHE_COLL).doc(fullKey).set({
      data: data,
      expire: expire,
      fetchedAt: Date.now()
    });
  } catch (e) {}
}

// ===== §5.4 冷启动探测（2026-07-29）=====
// 云函数实例刚启动时（L1 为空），异步探测最重要的几个缓存 key 是否在 L2 可用。
//   - 命中：回填 L1，后续请求直接走 L1（省 50-200ms cloud DB 读）
//   - 全未命中：说明是全新部署或 L2 被清，不触发预热（等 cron 周期），仅记录状态
//   - 非阻塞：失败/超时静默忽略，不影响首个请求
// 探测 key 选取原则：高频读 + 体积适中 + 预热过的（/leagues、/heroes、upcoming_schedule）
const PROBE_KEYS = ['/leagues', '/heroes', 'upcoming_schedule'];
let _coldStartProbed = false;
function coldStartProbe() {
  if (_coldStartProbed) return;
  _coldStartProbed = true;
  // 异步执行，不阻塞主入口
  Promise.all(PROBE_KEYS.map((k) => getCache(k).catch(() => null)))
    .then((hits) => {
      const hitCount = hits.filter((v) => v != null).length;
      if (typeof console !== 'undefined' && console.info) {
        console.info('[coldStart] 探测 ' + PROBE_KEYS.length + ' key，命中 ' + hitCount +
          '（L1 已回填），状态：' + (hitCount > 0 ? 'L2 可用' : 'L2 空/全新部署'));
      }
    })
    .catch(() => { /* 静默 */ });
}

// ===== safeFetch：统一外部 API 请求包装（B1 优化，2026-07-29）=====
// 包装所有外部 API 调用（OpenDota/STRATZ/Steam/Liquipedia），统一：
//   ① 5xx + 429 退避重试（可配置 retryCount，默认 2）
//   ② 超时控制（默认 15s）
//   ③ 错误格式化（标准化 error 对象，便于客户端处理）
//   ④ 重试日志（记录重试次数和原因，便于排查）
// 可重试状态码：500-599（源站错误）+ 429（限流）
// 退避策略：指数退避 1.5s * 2^attempt（与原 fetchWithRetry 一致）
// 2026-07-29 新增 429 重试：Liquipedia/STRATZ 限流场景常见，原 fetchWithRetry 仅 5xx
async function safeFetch(options) {
  const opts = options || {};
  const retryCount = opts.retryCount != null ? opts.retryCount : 2;
  const source = opts.source || 'unknown';
  // 移除自定义字段，避免传给 got
  const gotOpts = Object.assign({}, opts);
  delete gotOpts.retryCount;
  delete gotOpts.source;
  // 确保超时配置存在
  if (!gotOpts.timeout) gotOpts.timeout = { request: 15000 };

  let attempt = 0;
  while (true) {
    try {
      const res = await GOT(gotOpts);
      return res;
    } catch (err) {
      const code = err && err.response && err.response.statusCode;
      // 可重试：5xx 源站错误 + 429 限流
      const isRetryable = (code >= 500 && code < 600) || code === 429;
      if (isRetryable && attempt < retryCount) {
        const delay = 1500 * Math.pow(2, attempt);
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('[safeFetch] ' + source + ' 重试 ' + (attempt + 1) + '/' + retryCount +
            ' (HTTP ' + code + ')，' + delay + 'ms 后重试');
        }
        await new Promise((r) => setTimeout(r, delay));
        attempt++;
        continue;
      }
      // 不可重试或重试次数用尽，格式化错误
      const formatted = new Error(source + ' 请求失败: HTTP ' + (code || 'NETWORK_ERROR') +
        ' - ' + (err.message || 'unknown'));
      formatted.statusCode = code || 0;
      formatted.source = source;
      formatted.attempts = attempt + 1;
      throw formatted;
    }
  }
}

// ===== OpenDota 请求 =====
// OpenDota 经 Cloudflare 常返回 521/502/503 等瞬时源站错误（got 会抛 HTTPError）。
// 这里做 2 次退避重试（与客户端 api.js 的 5xx 重试策略一致）：多数瞬时故障可重试恢复，
// 避免把 521 一路抛到客户端触发回退直连（直连再 521 → 真机/模拟器 Console 报错 + 页面加载失败）。
// 2026-07-29：改用 safeFetch 统一包装，新增 429 重试（原仅 5xx）
async function fetchWithRetry(path) {
  const res = await safeFetch({
    url: BASE + path,
    responseType: 'json',
    headers: { 'User-Agent': 'DOTA2-Esports-Hub/1.0' },
    source: 'OpenDota'
  });
  return res.body;
}

function fetch(path) {
  return fetchWithRetry(path);
}

// ===== STRATZ GraphQL 请求（用于赛程预热）=====
// STRATZ API key 从云函数环境变量 STRATZ_API_KEY 读取（在云开发控制台配置）。
// 未配置时跳过 STRATZ 预热，不影响 OpenDota 代理。
const STRATZ_BASE = 'https://api.stratz.com/graphql';
const STRATZ_KEY = process.env.STRATZ_API_KEY || '';

async function fetchStratz(query, variables) {
  if (!STRATZ_KEY) return null;
  // 2026-07-29：改用 safeFetch 统一包装，新增 5xx+429 重试（原无重试）
  const res = await safeFetch({
    method: 'POST',
    url: STRATZ_BASE,
    json: { query: query, variables: variables || {} },
    headers: {
      'content-type': 'application/json',
      'Authorization': 'Bearer ' + STRATZ_KEY
    },
    responseType: 'json',
    source: 'STRATZ'
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
  // 2026-07-29：改用 safeFetch 统一包装，新增 5xx+429 重试（原无重试）
  const res = await safeFetch({
    url: url,
    responseType: 'json',
    headers: { 'User-Agent': 'DOTA2-Esports-Hub/1.0' },
    source: 'Steam'
  });
  return res.body;
}

// ===== Liquipedia 代理常量（描述性 UA，微信端不可设；供 upcoming 实时赛程等使用）=====
const LIQUIPEDIA_BASE = 'https://liquipedia.net/dota2/api.php';
const LIQUIPEDIA_UA = 'DOTA2-Esports-Hub/1.0 (WeChat Mini Program; contact: dev@local)';
// 纯 wikitext 解析模块（镜像自 utils/liquipedia-parse.js，由 scripts/sync-liquipedia-parse.js 同步）。
// 云函数用 got 抓取 wikitext 后，复用与客户端完全一致的解析逻辑，避免"客户端/云端"双源漂移。
const liquipediaParse = require('./liquipedia-parse');

// Liquipedia slug 映射（镜像自 utils/liquipedia-slugmap.json，由 sync:slugmap 同步）
// OpenDota 联赛名 ≠ Liquipedia 页面 slug，直查命中率仅 2.5%；映射表把 name 转成正确 slug。
let liquipediaSlugMapCache = null;
function getLiquipediaSlugMap() {
  if (liquipediaSlugMapCache === null) {
    try { liquipediaSlugMapCache = require('./liquipedia-slugmap.json'); }
    catch (e) { liquipediaSlugMapCache = { mappings: {} }; }
  }
  return liquipediaSlugMapCache;
}
function liquipediaSlugFor(name) {
  const m = getLiquipediaSlugMap();
  if (m && m.mappings && m.mappings[name]) return m.mappings[name];
  return name;
}

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
  // 2026-07-29：改用 safeFetch 统一包装，新增 5xx+429 重试（原无重试）
  const res = await safeFetch({
    url: LIQUIPEDIA_BASE,
    searchParams: { action: 'parse', page: 'Portal:Tournaments', prop: 'text', format: 'json' },
    headers: { 'User-Agent': LIQUIPEDIA_UA, 'Accept': 'application/json' },
    responseType: 'json',
    source: 'Liquipedia-Upcoming'
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

// ===== Liquipedia 赛事元数据（服务端抓取 + 纯解析，A+B 双源策略的云端侧）=====
// 客户端经 cloudProxy.liquipediaProxy → 本 action；云函数用 got 自由设 UA + gzip 抓取
// wikitext，再用与客户端完全一致的纯解析模块（liquipedia-parse.js，镜像自 utils/）解析，
// 规避 wx.request 禁止设置 User-Agent 的限制（Liquipedia 官方强制要求描述性 UA）。
async function fetchLiquipediaWikitext(pageName) {
  if (!pageName) return null;
  try {
    // 2026-07-29：改用 safeFetch 统一包装，新增 5xx+429 重试（原无重试）
    const res = await safeFetch({
      url: LIQUIPEDIA_BASE,
      searchParams: {
        action: 'query',
        prop: 'revisions',
        rvprop: 'content',
        rvslots: 'main',
        titles: pageName,
        format: 'json',
        formatversion: '2',
        redirects: 1   // ★ 2026-07-28 修复重定向 BUG：自动跟随 #REDIRECT，返回最终页面的 wikitext
                       // 不加此参数时，"ESL One Birmingham 2024" 会返回 "#REDIRECT [[...]]"（仅几百字节），
                       // 导致 parseScheduledMatches/parseLeagueMetadata 找不到任何模板
      },
      headers: {
        'User-Agent': LIQUIPEDIA_UA,
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip'
      },
      responseType: 'json',
      source: 'Liquipedia-Wikitext'
    });
    const body = res.body;
    if (!body || !body.query || !body.query.pages) return null;
    let pages = body.query.pages;
    if (!Array.isArray(pages)) {
      const arr = [];
      for (const k in pages) { if (pages.hasOwnProperty(k)) arr.push(pages[k]); }
      pages = arr;
    }
    if (!pages.length) return null;
    const page = pages[0];
    if (page.missing) return null;
    if (!page.revisions || !page.revisions.length) return null;
    const rev = page.revisions[0];
    const content = (rev.slots && rev.slots.main && rev.slots.main.content) || rev['*'] || rev.content;
    return content || null;
  } catch (e) {
    return null;
  }
}

// 解析赛事元数据（云端）：抓取 wikitext → 纯解析 → 落库缓存。
// 与客户端 liquipedia.js 共用 liquipedia-parse.js 同一份解析逻辑（镜像保证一致）。
async function liquipediaLeagueMeta(params, force) {
  const pageName = (params && (params.pageName || params.name)) || null;
  if (!pageName) return { data: null, error: makeError(ERROR_CODES.BAD_REQUEST, 'pageName required') };
  const slug = liquipediaSlugFor(pageName);
  const cacheKey = 'liquipedia_league_' + slug;
  if (!force) {
    const cached = await getCache(cacheKey);
    if (cached) return { data: cached, source: 'cache' };
  }
  const wikitext = await fetchLiquipediaWikitext(slug);
  if (!wikitext) return { data: null, source: 'liquipedia' };
  const meta = liquipediaParse.parseLeagueMetadata(wikitext, pageName);
  if (!meta) return { data: null, source: 'liquipedia' };
  await setCache(cacheKey, meta, TTL.liquipediaMeta).catch(() => {});
  return { data: meta, source: 'liquipedia' };
}

// ===== Liquipedia 赛程数据（未开赛/进行中的对阵）=====
// 与 liquipediaLeagueMeta 同样的「云函数抓取 wikitext + 纯解析」模式，
// 但用 parseScheduledMatches 解析 {{Match}} 模板，返回赛程数组而非元数据。
// 缓存 TTL 30 分钟（与 match data 一致，比元数据更短，赛程变更敏感）。
async function liquipediaScheduledMatches(params, force) {
  const pageName = (params && (params.pageName || params.name)) || null;
  if (!pageName) return { data: null, error: makeError(ERROR_CODES.BAD_REQUEST, 'pageName required') };
  const slug = liquipediaSlugFor(pageName);
  const cacheKey = 'liquipedia_schedule_' + slug;
  if (!force) {
    const cached = await getCache(cacheKey);
    if (cached) return { data: cached, source: 'cache' };
  }
  const wikitext = await fetchLiquipediaWikitext(slug);
  if (!wikitext) return { data: null, source: 'liquipedia' };
  // 用 parseScheduledMatches 解析赛程，传入当前时间戳用于 phase 判定
  const nowSec = Math.floor(Date.now() / 1000);
  const matches = liquipediaParse.parseScheduledMatches(wikitext, nowSec);
  if (!matches || !matches.length) return { data: [], source: 'liquipedia' };
  await setCache(cacheKey, matches, TTL.liquipediaSchedule).catch(() => {});
  return { data: matches, source: 'liquipedia' };
}

// ===== Liquipedia 战队 Logo（§8.3 2026-07-29，OpenDota 无 logo 的兜底源）=====
// 仅在 OpenDota logo_url 为空 + STRATZ 无数据时调用，作为独立第四源。
// 两步获取：
//   1) 抓战队页 wikitext → parseTeamLogo 解析 {{Infobox team}} image 字段
//   2) imageinfo API 获取图片缩略图 URL（160px，与项目 logo 尺寸一致）
// 两次 API 调用间隔 ≥2s（Liquipedia action=query 端点限流），结果缓存 30 天。
async function fetchImageInfoUrl(fileName) {
  if (!fileName) return null;
  try {
    const res = await safeFetch({
      url: LIQUIPEDIA_BASE,
      searchParams: {
        action: 'query',
        titles: 'File:' + fileName,
        prop: 'imageinfo',
        iiprop: 'url',
        iiurlwidth: '160',      // 160px 缩略图（与项目 logo 尺寸一致）
        format: 'json',
        formatversion: '2'
      },
      headers: {
        'User-Agent': LIQUIPEDIA_UA,
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip'
      },
      responseType: 'json',
      source: 'Liquipedia-ImageInfo'
    });
    const body = res && res.body;
    if (!body || !body.query || !body.query.pages) return null;
    let pages = body.query.pages;
    if (!Array.isArray(pages)) {
      const arr = [];
      for (const k in pages) { if (pages.hasOwnProperty(k)) arr.push(pages[k]); }
      pages = arr;
    }
    if (!pages.length) return null;
    const page = pages[0];
    if (page.missing) return null;
    const imageinfo = page.imageinfo;
    if (!imageinfo || !imageinfo.length) return null;
    // 优先 thumburl（缩略图），回退 url（原图，体积较大）
    return imageinfo[0].thumburl || imageinfo[0].url || null;
  } catch (e) {
    return null;
  }
}

async function liquipediaTeamLogo(params, force) {
  const teamName = (params && (params.teamName || params.name)) || null;
  if (!teamName) return { data: null, error: makeError(ERROR_CODES.BAD_REQUEST, 'teamName required') };
  const slug = liquipediaSlugFor(teamName);
  const cacheKey = 'liquipedia_team_logo_' + slug;
  if (!force) {
    const cached = await getCache(cacheKey);
    if (cached) return { data: cached, source: 'cache' };
  }
  // 步骤 1：抓 wikitext，解析 image 文件名
  const wikitext = await fetchLiquipediaWikitext(slug);
  if (!wikitext) return { data: null, source: 'liquipedia' };
  const parsed = liquipediaParse.parseTeamLogo(wikitext);
  if (!parsed || !parsed.image) return { data: null, source: 'liquipedia' };
  // 步骤 2：遵守 2s 限流后再调 imageinfo API
  await new Promise((r) => setTimeout(r, 2200));
  const logoUrl = await fetchImageInfoUrl(parsed.image);
  if (!logoUrl) return { data: null, source: 'liquipedia' };
  const result = { logo: logoUrl, source: 'liquipedia' };
  await setCache(cacheKey, result, TTL.liquipediaTeamLogo).catch(() => {});
  return { data: result, source: 'liquipedia' };
}

// 知名 S 级赛事关键词（与客户端 leagues.js 保持一致）
const KNOWN_KEYWORDS = /(international|major|esl\s+one|esl\s+pro|dreamleague|blast|riyadh|pgl|betboom|clavision|fissure|the\s+summit|games\s+of\s+the\s+future|heroic|resurrection|weplay|moonstorm|dpc|\btour\b|division\s+i)/i;

// 批量预热 Liquipedia 赛事元数据：把"懒加载"升级为"懒加载 + 预热"双轨。
// - 显式 pageNames：按传入列表处理（适合定向回填已知赛事）。
// - 未传 pageNames：自动从 OpenDota /leagues 枚举知名/职业联赛（与客户端 KNOWN_KEYWORDS 一致），
//   覆盖近半年 + 未来已公布的 notable 联赛（Liquipedia 仅收录 notable 赛事，故该筛选即对齐数据源）。
// 每个联赛固定 2s 间隔（Liquipedia MediaWiki API 软限流），单条失败不影响其余，最终返回汇总。
// 设计说明：本 action 单条处理约 1-3s；若由脚本逐条调用（每条一个 pageName）可规避云函数超时，
//   若在 DevTools 控制台一次性粘贴批量，建议 ≤30 条以免触发函数超时。
async function liquipediaPrewarm(params, force) {
  const p = params || {};
  let pageNames = [];
  if (Array.isArray(p.pageNames) && p.pageNames.length) {
    pageNames = p.pageNames.slice();
  } else {
    try {
      const leagues = await fetch('/leagues');
      const seen = {};
      (leagues || []).forEach(function (l) {
        const nm = (l && l.name) || '';
        if (!nm || seen[nm]) return;
        // 仅筛 notable 赛事（与客户端 preheatUpcoming / KNOWN_KEYWORDS 一致），
        // 不按 tier 放宽，避免把社区/业余赛事也拉进来浪费 Liquipedia 2s 限流配额。
        if (KNOWN_KEYWORDS.test(nm)) {
          seen[nm] = true;
          pageNames.push(nm);
        }
      });
    } catch (e) { /* 枚举失败则走空列表 */ }
  }
  const limit = (p.limit && Number(p.limit) > 0) ? Number(p.limit) : 50;
  pageNames = pageNames.slice(0, limit);

  const summary = {
    total: pageNames.length,
    ok: 0,        // 成功抓取并解析到 metadata
    skipped: 0,   // 页面不存在 / 解析为空（不计入失败）
    failed: [],   // 异常（网络/解析崩溃）
    startedAt: Date.now()
  };

  for (let i = 0; i < pageNames.length; i++) {
    const pageName = pageNames[i];
    try {
      const r = await liquipediaLeagueMeta({ pageName: pageName }, force);
      if (r && r.data) summary.ok++;
      else summary.skipped++;
    } catch (e) {
      summary.failed.push(pageName);
    }
    // 2s 软限流（最后一条后无需等待）
    if (i < pageNames.length - 1) {
      await new Promise(function (res) { setTimeout(res, 2000); });
    }
  }

  summary.elapsedSec = Math.round((Date.now() - summary.startedAt) / 1000);
  summary.source = 'liquipediaPrewarm';
  return summary;
}

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
    // B4 预热后 probe（Phase 1-⑤，2026-07-29）：写入后立即读回验证，
    // 防止缓存被清但未预热的空窗期（如 cloud DB 写入静默失败/限流）
    const probe = await getCache('upcoming_schedule');
    if (!probe) {
      console.warn('[preheat] probe 失败：upcoming_schedule 写入后读回为空');
      return { ok: false, reason: 'probe failed: cache miss after set' };
    }
    return { ok: true, count: Object.keys(windows).length, source: 'liquipedia', probed: true };
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
  // B4 预热后 probe（Phase 1-⑤）：写入后立即读回验证
  const probe = await getCache('upcoming_schedule');
  if (!probe) {
    console.warn('[preheat] probe 失败：upcoming_schedule 写入后读回为空（STRATZ 路径）');
    return { ok: false, reason: 'probe failed: cache miss after set' };
  }
  return { ok: true, count: Object.keys(windows).length, source: 'stratz', probed: true };
}

// ===== 搜索索引构建（#23 自建缓存层 / 搜索索引）=====
// 定时从 OpenDota 拉取全量联赛列表，落库为紧凑搜索索引 { leagues:[{id,name}], builtAt }。
// 客户端全局搜索（5.2）/ 推荐位（1.3）优先读此缓存，避免每次搜索 hits OpenDota /search 限流。
// 联赛列表是有限集合（~千级），适合建索引；战队/选手为开放集合，仍走 OpenDota /search。
async function buildSearchIndex() {
  try {
    const leagues = await fetch('/leagues');
    const list = Array.isArray(leagues)
      ? leagues
          .filter((l) => l && (l.leagueid || l.id) && l.name)
          .map((l) => ({ id: Number(l.leagueid || l.id), name: String(l.name) }))
          .sort((a, b) => a.name.localeCompare(b.name))
      : [];
    const index = { leagues: list, builtAt: Date.now(), count: list.length };
    await setCache('search_index', index, 6 * 3600 * 1000);
    return index;
  } catch (e) {
    return { leagues: [], builtAt: Date.now(), count: 0, error: e.message };
  }
}

// ===== 战队服务端定时刷新（战队模块数据更新方式增强）=====
// 预热顶级战队详情（HOT_TEAMS 的稳定 OpenDota id），落库云缓存 teams_hot。
// 客户端 teams 页 enrichHot 优先读此「共享」缓存，避免每位用户冷启动各发 10 次 OpenDota /teams/{id}
// （这是战队模块对 OpenDota 压力最大的路径）。
// 战队 id 为 OpenDota 稳定 id，与客户端 pages/teams/teams.js 的 HOT_TEAMS 保持一致；
// 客户端拥有展示名/标签，云端只预热数据字段，二者解耦、仅以 id 对齐。
// ⚠️ 与 pages/teams/teams.js HOT_TEAMS、utils/curation.js CURATED_TEAMS 保持一致（2026-07 经 OpenDota 核验）。
// OpenDota 会复用 team_id：原 15/1838312/2163/8336801/7090336/1369577/2506989 等已指向不同战队，
// 此处全部校正为当前真实 id。原 1375614 误标 Fnatic（实际为 Newbee，已解散），已替换为 Team Liquid(2163)。
const HOT_TEAM_IDS = [10150538, 7119388, 36, 2586976, 1838315, 2163, 8291895, 8599101, 8255756, 9580444];

// ===== 战队搜索索引语料（修复 TEAM_SEARCH_BUG · 修复 A）=====
// OpenDota /search 按「近期活跃度」建索引，历史/已解散的 S 级及以上战队常不在其结果中，
// 导致全局搜索漏检。此处落库一份「历史 S 级及以上战队」语料（服务端维护、可更新、无需发版），
// 客户端搜索时作为第三兜底源（见 utils/cloudCache.getTeamsIndex + pages/search.doSearch）。
// 语料 = 经 OpenDota /teams 全量列表核验的当前真实 team_id（非复用旧 id）：
//   - navigable:true 的 4 支可安全跳转详情（Wings/EHOME/iG/LFY）；
//   - navigable:false 的 2 支（CDEC/LGD.FY）当前窗口未核验到正确 id，仅搜索可见、不跳转。
// 当前活跃 S/SSS 队由客户端 curation（utils/teamSearch.js）本地兜底覆盖，此处不重复，避免漂移。
// 与 utils/teamSearch.js 的 HISTORICAL_S_TEAMS 保持同步。
const TEAMS_SEARCH_HISTORICAL = [
  { id: 1836806, name: 'Wings Gaming', tag: 'WG', aliases: ['wings', 'wingsgaming', 'the wings gaming'], tier: 'SSS', navigable: true },
  { id: 4, name: 'EHOME', tag: 'EH', aliases: ['ehome'], tier: 'S', navigable: true },
  { id: 5, name: 'Invictus Gaming', tag: 'iG', aliases: ['invictus gaming', 'ig', 'igaming'], tier: 'SSS', navigable: true },
  { id: 3331948, name: 'LGD.Forever Young', tag: 'LFY', aliases: ['lgd.forever young', 'lfy'], tier: 'S', navigable: true },
  { id: -1, name: 'CDEC', tag: 'CDEC', aliases: ['cdec'], tier: 'S', navigable: false },
  { id: -2, name: 'LGD.FY', tag: 'LGD.FY', aliases: ['lgd.fy', 'lgdfy'], tier: 'S', navigable: false }
];

// 构建战队搜索索引（历史 S 级语料），落库 teams_search（TTL 6h）。
async function buildTeamsIndex() {
  try {
    const teams = TEAMS_SEARCH_HISTORICAL.map((t) => ({
      id: t.id, name: t.name, tag: t.tag, aliases: t.aliases || [], tier: t.tier || '', navigable: t.navigable !== false
    }));
    const index = { teams: teams, builtAt: Date.now(), count: teams.length };
    await setCache('teams_search', index, 6 * 3600 * 1000);
    return index;
  } catch (e) {
    return { teams: [], builtAt: Date.now(), count: 0, error: e.message };
  }
}

// 客户端读取战队搜索索引。命中返回 {data:{teams,...},source:'cache'}，未命中现场构建一次。
async function getTeamsIndex() {
  const cached = await getCache('teams_search');
  if (cached && cached.teams && cached.teams.length) return { data: cached, source: 'cache' };
  const built = await buildTeamsIndex();
  return { data: built, source: 'fresh' };
}

// 串行拉取热门战队详情，逐队隔离失败；落库紧凑子集（enrichItem 所需字段），降低云 DB 体积。
async function refreshTeams() {
  const out = {};
  let ok = 0, fail = 0;
  for (const id of HOT_TEAM_IDS) {
    try {
      const t = await fetch('/teams/' + id);
      if (t && (t.team_id != null || t.name || t.rating != null || t.wins != null)) {
        out[id] = {
          team_id: t.team_id != null ? t.team_id : id,
          name: t.name || '',
          tag: t.tag || '',
          logo_url: t.logo_url || '',
          country_code: t.country_code || '',
          rating: t.rating || 0,
          wins: t.wins || 0,
          losses: t.losses || 0,
          last_match_time: t.last_match_time || 0
        };
        ok++;
      } else {
        fail++;
      }
    } catch (e) {
      fail++; // 隔离单队失败，不影响其它
    }
    // OpenDota 限流：串行 + 1s 间隔（与 config.rateLimit.minGapMs 一致）
    await new Promise((r) => setTimeout(r, 1050));
  }
  await setCache('teams_hot', out, 6 * 3600 * 1000);
  return { ok: ok, fail: fail, count: ok };
}

// 客户端读取热门战队共享缓存。仅返回已预热的数据；未命中返回空对象（不现场预热，
// 避免冷启动多人并发触发 refreshTeams 造成 OpenDota 突发限流）。miss 时客户端自动回退逐队拉取。
async function getTeamsHot() {
  const cached = await getCache('teams_hot');
  if (cached && Object.keys(cached).length) return { data: cached, source: 'cache' };
  return { data: {}, source: 'empty' };
}

// ===== B2 优化：Action Handler 函数（提取自 exports.main 的 if-else 链）=====
// 每个 handler 接收完整 event 对象，从中提取所需字段。
// 收益：O(1) Map 查找替代 O(N) 字符串比较，代码结构更清晰，便于单元测试。

async function handleStratzGql(event) {
  const { query, variables } = event;
  if (!query) return { error: makeError(ERROR_CODES.BAD_REQUEST, 'query required') };
  const data = await fetchStratz(query, variables);
  if (data) return { data: data, source: 'stratz' };
  return { error: makeError(ERROR_CODES.UPSTREAM_ERROR, 'STRATZ 请求失败') };
}

async function handleSteamProxy(event) {
  const { path, params } = event;
  if (!path) return { error: makeError(ERROR_CODES.BAD_REQUEST, 'path required') };
  if (!STEAM_KEY) return { error: makeError(ERROR_CODES.NOT_CONFIGURED, 'STEAM_API_KEY not set') };
  try {
    const data = await fetchSteam(path, params);
    if (data) return { data: data, source: 'steam' };
    return { error: makeError(ERROR_CODES.UPSTREAM_ERROR, 'Steam 请求失败') };
  } catch (e) {
    return { error: makeError(ERROR_CODES.UPSTREAM_ERROR, 'Steam 请求异常', (e && e.message) || String(e)) };
  }
}

async function handleGetLiquipediaUpcoming() {
  try {
    const data = await fetchLiquipediaUpcoming();
    return { data: data, source: 'liquipedia' };
  } catch (e) {
    return { error: makeError(ERROR_CODES.UPSTREAM_ERROR, 'Liquipedia 赛程请求失败', (e && e.message) || String(e)) };
  }
}

async function handleGetUpcomingSchedule() {
  const cached = await getCache('upcoming_schedule');
  if (cached) return { data: cached, source: 'cache' };
  // 缓存未命中：现场预热一次（耗时较长，客户端应配 loading 提示）
  const r = await preheatUpcoming();
  if (r.ok) {
    const data = await getCache('upcoming_schedule');
    return { data: data || {}, source: 'fresh' };
  }
  return { error: makeError(ERROR_CODES.UPSTREAM_ERROR, '赛程预热失败', r) };
}

function handleGetExperiments() {
  return {
    experiments: {
      follow_cta_variant: { variant: 'A', enabled: true }
    },
    source: 'cloud'
  };
}

async function handleSendSubscribeMessage(event) {
  const { touser, template_id, page, miniprogram_state, data } = (event.params || {});
  if (!touser) return { errcode: 400, errmsg: 'touser required' };
  if (!template_id) return { errcode: 400, errmsg: 'template_id required' };
  if (!data) return { errcode: 400, errmsg: 'data required' };
  try {
    const result = await cloud.openapi.subscribeMessage.send({
      touser: String(touser),
      template_id: String(template_id),
      page: String(page || '/pages/index/index'),
      miniprogram_state: String(miniprogram_state || 'formal'),
      data: data || {}
    });
    return {
      errcode: result.errCode || result.errcode || 0,
      errmsg: result.errMsg || result.errmsg || 'ok',
      msgid: result.msgid || null
    };
  } catch (e) {
    const errMsg = (e && e.message) || String(e);
    let errcode = -1;
    if (errMsg.includes('43101')) errcode = 43101;
    if (errMsg.includes('47003')) errcode = 47003;
    if (errMsg.includes('40003')) errcode = 40003;
    if (errMsg.includes('41030')) errcode = 41030;
    if (errMsg.includes('43004')) errcode = 43004;
    return { errcode: errcode, errmsg: errMsg };
  }
}

function handleGetOpenId() {
  try {
    const wxContext = cloud.getWXContext();
    return {
      openid: wxContext.OPENID || null,
      appid: wxContext.APPID || null,
      unionid: wxContext.UNIONID || null
    };
  } catch (e) {
    return { error: makeError(ERROR_CODES.UPSTREAM_ERROR, '获取 OpenID 失败', (e && e.message) || String(e)) };
  }
}

async function handleGetCached(event) {
  const { key } = (event.params || {});
  if (!key) return { error: makeError(ERROR_CODES.BAD_REQUEST, 'key required') };
  const v = await getCache(key);
  return { value: v, hit: v != null };
}

async function handleSetCached(event) {
  const { key, value, ttlSec } = (event.params || {});
  if (!key) return { error: makeError(ERROR_CODES.BAD_REQUEST, 'key required') };
  await setCache(key, value, (ttlSec || 3600) * 1000);
  return { ok: true };
}

async function handleGetSearchIndex() {
  const cached = await getCache('search_index');
  if (cached) return { data: cached, source: 'cache' };
  const built = await buildSearchIndex();
  return { data: built, source: 'fresh' };
}

async function handleBuildSearchIndex() {
  const built = await buildSearchIndex();
  return { data: built, source: 'fresh', count: built.count || 0 };
}

async function handleRefreshTeams() {
  const r = await refreshTeams();
  return { ok: true, ok_count: r.ok, fail_count: r.fail, count: r.count };
}

async function handleBuildTeamsIndex() {
  const built = await buildTeamsIndex();
  return { data: built, source: 'fresh', count: built.count || 0 };
}

async function handleSaveFollowProfile(event) {
  const { openid, profile } = (event.params || {});
  const oid = openid || (cloud.getWXContext() && cloud.getWXContext().OPENID);
  if (!oid) return { error: makeError(ERROR_CODES.BAD_REQUEST, 'openid required') };
  await setCache('follow_profile_' + oid, profile || {}, 30 * 24 * 3600 * 1000);
  return { ok: true };
}

async function handleGetFollowProfile(event) {
  const { openid } = (event.params || {});
  const oid = openid || (cloud.getWXContext() && cloud.getWXContext().OPENID);
  if (!oid) return { error: makeError(ERROR_CODES.BAD_REQUEST, 'openid required') };
  const p = await getCache('follow_profile_' + oid);
  return { profile: p || null };
}

async function handleSendSmartReminders(event) {
  const { templateId, page, openid } = (event.params || {});
  const oid = openid || (cloud.getWXContext() && cloud.getWXContext().OPENID);
  if (!oid) return { error: makeError(ERROR_CODES.BAD_REQUEST, 'openid required') };
  if (!templateId) return { error: makeError(ERROR_CODES.BAD_REQUEST, 'templateId required') };
  const profile = await getCache('follow_profile_' + oid);
  if (!profile || !profile.teams || !profile.teams.length) {
    return { ok: true, sent: 0, skipped: 0, failed: 0, reason: 'empty_profile' };
  }
  const strategy = profile.strategy || { leadSec: 1800, tiers: ['SSS', 'S', 'A'] };
  const now = Math.floor(Date.now() / 1000);
  let sent = 0, skipped = 0, failed = 0;
  for (const tid of profile.teams) {
    try {
      const ms = await fetch('/teams/' + tid + '/matches');
      if (!ms || !ms.length) { skipped++; continue; }
      const upcoming = ms.filter((m) => m.start_time > now).sort((a, b) => a.start_time - b.start_time);
      const m = upcoming[0];
      if (!m) { skipped++; continue; }
      const diff = m.start_time - now;
      if (diff > (strategy.leadSec || 1800)) { skipped++; continue; }
      const d = new Date(m.start_time * 1000);
      const pad = (n) => (n < 10 ? '0' + n : '' + n);
      const timeStr = (d.getMonth() + 1) + '-' + d.getDate() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
      const data = {
        thing1: { value: canonicalLeagueNameWithCtx(m.league_name, { leagueId: m.leagueid }).slice(0, 20) },
        thing2: { value: timeStr },
        thing6: { value: ((m.radiant_name || '天辉') + ' VS ' + (m.dire_name || '夜魇')).slice(0, 20) },
        thing5: { value: '即将开始，别错过' }
      };
      const r = await cloud.openapi.subscribeMessage.send({
        touser: oid,
        template_id: String(templateId),
        page: String(page || '/pages/index/index'),
        miniprogram_state: 'formal',
        data: data
      });
      if ((r.errCode || r.errcode || 0) === 0) sent++; else failed++;
    } catch (e) { failed++; }
  }
  return { ok: true, sent: sent, skipped: skipped, failed: failed };
}

// ===== B2 核心：Action → Handler 路由表（O(1) 查找，替代 if-else 链）=====
const HANDLERS = new Map([
  // STRATZ / Steam 代理
  ['stratzGql', handleStratzGql],
  ['steamProxy', handleSteamProxy],
  // Liquipedia
  ['getLiquipediaUpcoming', handleGetLiquipediaUpcoming],
  ['liquipediaLeagueMeta', (e) => liquipediaLeagueMeta(e.params, e.force)],
  ['liquipediaScheduledMatches', (e) => liquipediaScheduledMatches(e.params, e.force)],
  ['liquipediaTeamLogo', (e) => liquipediaTeamLogo(e.params, e.force)],
  ['liquipediaPrewarm', (e) => liquipediaPrewarm(e.params, e.force)],
  // 赛程
  ['getUpcomingSchedule', handleGetUpcomingSchedule],
  // 实验
  ['getExperiments', handleGetExperiments],
  // 订阅消息
  ['sendSubscribeMessage', handleSendSubscribeMessage],
  ['getOpenId', handleGetOpenId],
  ['sendSmartReminders', handleSendSmartReminders],
  // 通用云缓存
  ['getCached', handleGetCached],
  ['setCached', handleSetCached],
  // 搜索索引
  ['getSearchIndex', handleGetSearchIndex],
  ['buildSearchIndex', handleBuildSearchIndex],
  // 战队
  ['getTeamsHot', getTeamsHot],
  ['refreshTeams', handleRefreshTeams],
  ['getTeamsIndex', getTeamsIndex],
  ['buildTeamsIndex', handleBuildTeamsIndex],
  // 关注画像
  ['saveFollowProfile', handleSaveFollowProfile],
  ['getFollowProfile', handleGetFollowProfile],
]);

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
// §5.4 渐进退避（2026-07-29）：某源连续失败时降低该源的预热频率，避免反复打不可达的源。
//   - 每个预热任务维护 failCount + nextAllowedTime
//   - 失败 1-2 次：下次仍尝试（容忍瞬时抖动）
//   - 失败 3+ 次：nextAllowedTime 推后（每次 2x 退避，上限 4h），未到时间则跳过
//   - 成功后 failCount 重置为 0
//   收益：Liquipedia/STRATZ 长时间不可达时不浪费 cron 配额，OpenDota 热端点仍正常预热
const PREHEAT_BACKOFF = {};  // key → { failCount, nextAllowedTime }
const PREHEAT_MAX_BACKOFF_MS = 4 * 3600 * 1000;  // 单源最大退避 4h
function preheatShouldRun(key) {
  const s = PREHEAT_BACKOFF[key];
  if (!s) return true;
  if (Date.now() < s.nextAllowedTime) return false;
  return true;
}
function preheatMarkResult(key, ok) {
  if (!PREHEAT_BACKOFF[key]) PREHEAT_BACKOFF[key] = { failCount: 0, nextAllowedTime: 0 };
  const s = PREHEAT_BACKOFF[key];
  if (ok) {
    s.failCount = 0;
    s.nextAllowedTime = 0;
  } else {
    s.failCount = (s.failCount || 0) + 1;
    if (s.failCount >= 3) {
      // 指数退避：3次=2h, 4次=4h（上限）
      const backoffMs = Math.min(PREHEAT_MAX_BACKOFF_MS, 2 * 3600 * 1000 * Math.pow(2, s.failCount - 3));
      s.nextAllowedTime = Date.now() + backoffMs;
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[preheat] ' + key + ' 连续失败 ' + s.failCount + ' 次，退避 ' +
          Math.round(backoffMs / 60000) + 'min');
      }
    }
  }
}

async function handleTimer() {
  const hotEndpoints = [
    '/leagues',
    '/heroes',
    '/explorer?sql=' + encodeURIComponent(LEAGUE_WINDOWS_SQL)
  ];
  const results = [];
  for (const path of hotEndpoints) {
    // OpenDota 热端点不参与退避（核心数据源，瞬时抖动由 safeFetch 重试兜底）
    try {
      const data = await fetch(path);
      await setCache(path, data, 6 * 3600 * 1000);
      results.push({ path, ok: true });
    } catch (e) {
      results.push({ path, ok: false, error: e.message });
    }
  }
  // STRATZ 赛程预热（解决客户端"即将到来"首次加载慢）—— 参与退避
  if (preheatShouldRun('preheatUpcoming')) {
    try {
      const r = await preheatUpcoming();
      preheatMarkResult('preheatUpcoming', !!(r && r.ok));
      results.push({ preheatUpcoming: r });
    } catch (e) {
      preheatMarkResult('preheatUpcoming', false);
      results.push({ preheatUpcoming: { ok: false, error: e.message } });
    }
  } else {
    results.push({ preheatUpcoming: { ok: false, skipped: 'backoff' } });
  }
  // #23 搜索索引定时重建（联赛有限集，落库供全局搜索/推荐位复用，降 OpenDota 限流）
  try {
    const idx = await buildSearchIndex();
    results.push({ buildSearchIndex: { ok: true, count: idx.count || 0 } });
  } catch (e) {
    results.push({ buildSearchIndex: { ok: false, error: e.message } });
  }
  // 战队模块：定时预热顶级战队详情（teams_hot 共享缓存，降 OpenDota /teams/{id} 限流）
  if (preheatShouldRun('refreshTeams')) {
    try {
      const rt = await refreshTeams();
      preheatMarkResult('refreshTeams', rt && rt.fail < (rt.ok + rt.fail));  // 多数成功则视为成功
      results.push({ refreshTeams: { ok: true, ok_count: rt.ok, fail_count: rt.fail } });
    } catch (e) {
      preheatMarkResult('refreshTeams', false);
      results.push({ refreshTeams: { ok: false, error: e.message } });
    }
  } else {
    results.push({ refreshTeams: { ok: false, skipped: 'backoff' } });
  }
  // 战队搜索索引：定时重建历史 S 级语料（teams_search），供全局搜索兜底（修复 TEAM_SEARCH_BUG A）
  try {
    const ti = await buildTeamsIndex();
    results.push({ buildTeamsIndex: { ok: true, count: ti.count || 0 } });
  } catch (e) {
    results.push({ buildTeamsIndex: { ok: false, error: e.message } });
  }
  return { ok: true, results };
}

// ===== 主入口 =====
exports.main = async (event, context) => {
  // §5.4 冷启动探测：首次请求触发 L2→L1 回填（非阻塞）
  coldStartProbe();
  // §7.4 结构化日志（2026-07-29）：统一记录请求开始/结束时间、action、cache 命中、耗时、状态
  // 便于云函数日志排查性能瓶颈与失败原因。JSON 格式便于日志服务检索。
  const __startTime = Date.now();
  const __logEnd = (result) => {
    const durationMs = Date.now() - __startTime;
    const status = (result && result.error) ? 'error'
      : (result && result.source === 'cache') ? 'cache_hit'
      : (result && result.source === 'cache_fallback') ? 'cache_fallback'
      : (result && result.source === 'fresh') ? 'fresh'
      : (result && result.data) ? 'ok' : 'unknown';
    console.log(JSON.stringify({
      type: 'cloud_call',
      action: action || '',
      status: status,
      durationMs: durationMs,
      cacheSource: (result && result.source) || '',
      force: !!force,
      hasError: !!(result && result.error)
    }));
  };

  // 定时触发
  if (event.TriggerName === 'cron') {
    const r = await handleTimer();
    __logEnd(r);
    return r;
  }

  const { action, params, force } = event;
  if (!action) {
    const r = { error: makeError(ERROR_CODES.BAD_REQUEST, 'action required') };
    __logEnd(r);
    return r;
  }

  // 内置定时指令
  if (action === '__cron__') {
    const r = await handleTimer();
    __logEnd(r);
    return r;
  }

  // 赛程预热（手动触发，或客户端读取预热结果）
  if (action === 'preheatUpcoming') {
    const r = await preheatUpcoming();
    __logEnd(r);
    return r;
  }
  // B2 优化：专用 action 通过 Map O(1) 路由（替代 if-else 链）
  const handler = HANDLERS.get(action);
  if (handler) {
    const r = await handler(event);
    __logEnd(r);
    return r;
  }

  const path = buildPath(action, params);
  if (!path) {
    const r = { error: makeError(ERROR_CODES.BAD_REQUEST, 'unknown action: ' + action) };
    __logEnd(r);
    return r;
  }

  // 查缓存（非 force）
  const cacheKey = path;
  if (!force) {
    const cached = await getCache(cacheKey);
    if (cached) {
      const r = { data: cached, source: 'cache' };
      __logEnd(r);
      return r;
    }
  }

  // 代理请求 OpenDota
  try {
    const data = await fetch(path);
    // 后台缓存（不阻塞返回）
    setCache(cacheKey, data, resolveTtl(action)).catch(() => {});
    const r = { data: data, source: 'fresh' };
    __logEnd(r);
    return r;
  } catch (e) {
    // 请求失败时尝试用过期缓存兜底
    const fallback = await getCache(cacheKey);
    if (fallback) {
      const r = { data: fallback, source: 'cache_fallback' };
      __logEnd(r);
      return r;
    }
    const r = { error: makeError(ERROR_CODES.UPSTREAM_ERROR, 'OpenDota 请求失败', (e && e.message) || String(e)) };
    __logEnd(r);
    return r;
  }
};
