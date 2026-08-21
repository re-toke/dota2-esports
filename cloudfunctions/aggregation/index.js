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
  FORBIDDEN: 'forbidden',              // O-26：鉴权拦截（无权调用管理 action）
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
  // 2026-08-04（LIVE 比分刷新 v1.1，R1）：30min → 5min。
  // 进行中 BO3 的新局在 OpenDota 收录滞后 5-30min，30min 缓存使客户端 force 拿不到新数据 →
  // LIVE 比分刷新粒度被钳制为 30min；降为 5min 后共享缓存粒度 = BO3 局粒度（≤12 次/h/赛事，全用户合计）。
  leagueMatches: 5 * 60 * 1000,
  team: 6 * 3600 * 1000,
  teamMatches: 30 * 60 * 1000,
  player: 6 * 3600 * 1000,
  playerMatches: 30 * 60 * 1000,
  heroes: 24 * 3600 * 1000,
  // 2026-07-29 差异化 TTL（Phase 1-②）
  // 元数据（奖金池/地点/赛制/参赛队等）变化极慢，24h 长缓存减少重复请求
  liquipediaMeta: 24 * 3600 * 1000,
  // 赛程（未开赛/进行中的对阵）变化敏感，30min 短缓存保证时效性
  // 2026-08-03 优化：缩至 5min（与客户端 config.liquipedia.cacheTtlSchedule 同步），
  // 配合客户端 30-60s force 定时刷新达到近实时；否则双层缓存叠加最坏 60min 旧数据。
  liquipediaSchedule: 5 * 60 * 1000,
  // §8.3 战队 Logo（2026-07-29）：战队 logo 几乎不变，30 天长缓存减少 Liquipedia 请求
  liquipediaTeamLogo: 30 * 24 * 3600 * 1000,
  // §9 Liquipedia 主动枚举（2026-07-30）：赛事列表变化慢，7 天长缓存 + 每月主动刷新一次
  // categorymembers 全量拉取（约 3000+ 条），降频到每月 1 次合规调用
  liquipediaTournamentList: 7 * 24 * 3600 * 1000
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

// TCB 单文档上限 512KB（O-17 2026-08-15）：超限的 doc().set() 会静默失败（配额合规风险），
// 且该 key 的 L2 缓存永远缺失，客户端持续回源直连 → 限流风险。此处保留 L1（内存缓存）
// 仍可用，但跳过 L2 落库并显式 warn 日志，便于发现超大缓存项。
const TCB_DOC_LIMIT_BYTES = 512 * 1024;   // TCB 单文档硬上限
const TCB_SAFE_BYTES = 450 * 1024;        // 保守阈值（留 62KB 余量给 expire/fetchedAt/_id 等字段）

async function setCache(key, data, ttlMs) {
  const fullKey = _v() + key;
  const expire = Date.now() + (ttlMs || 30 * 60 * 1000);
  // 同时写 L1 + L2
  l1Set(fullKey, data, ttlMs);
  try {
    // O-17：序列化体积预检，超限跳过 L2 落库（L1 仍有效，本实例命中；跨实例回退直连）
    let payloadBytes = 0;
    try { payloadBytes = JSON.stringify(data).length; } catch (e) { payloadBytes = TCB_DOC_LIMIT_BYTES + 1; }  // 序列化失败按超限处理
    if (payloadBytes > TCB_SAFE_BYTES) {
      console.warn('[setCache] 跳过 L2 落库（超 TCB 单文档阈值）key=' + key +
        ' size=' + payloadBytes + 'B > ' + TCB_SAFE_BYTES + 'B，仅 L1 生效');
      return;
    }
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

// 跨刷新保留赛事完整赛期：赛事从 Upcoming 过渡到 Ongoing 时，Ongoing 段日期单元格只显示开始日
// （如 "Jul 30, 2026"）→ parseLiquipediaDate 无结束日 → end==start 截断。
// 用内存中曾见过的完整赛期回填（实例存活期间有效；冷启动由下方 upcoming-local.json 快照兜底）。
const LIQUID_DATE_MEMORY = new Map(); // hashId(name) -> { start, end }

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
  // 预构建快照（scripts/fetch-liquipedia-upcoming.js 生成，已镜像到云函数目录），
  // 作为 Ongoing 段截断日期的权威回填源（与客户端 utils/upcoming-local.json 同源）。
  // 2026-07-30 修复：根治 Ongoing 段只返回开始日的脏数据（无需客户端兜底也能拿到完整赛期）。
  let _snap = null;
  try { _snap = require('./upcoming-local.json'); } catch (_e) { /* 未镜像快照时静默跳过 */ }

  const nowSec = Math.floor(Date.now() / 1000);
  const out = [];
  const rowRe = /<tr class="table2&#95;&#95;row--(body|highlighted)">(.*?)<\/tr>/gs;

  // 2026-07-30 修复：同时抓取「Upcoming」与「Ongoing」两个段落。
  // 赛事开赛后 Liquipedia 会把它从 Upcoming 移到 Ongoing 段，若只读 Upcoming，
  // 进行中的赛事（如 1win Essence II）会从赛程缓存中消失，导致小程序「进行中」tab 漏显。
  // 两段落合并后，未结束赛事都被保留（hashId 同名去重，Ongoing/Upcoming 重叠不重复）。
  const SECTIONS = ['Upcoming', 'Ongoing'];
  SECTIONS.forEach((secId) => {
    const startIdx = html.indexOf('id="' + secId + '"');
    if (startIdx < 0) return; // 该段不存在则跳过
    const nextHead = html.indexOf('class="mw-headline"', startIdx + 10);
    const section = html.slice(startIdx, nextHead > 0 ? nextHead : html.length);
    let m;
    rowRe.lastIndex = 0;
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
      const id = hashId(name);
      if (secId === 'Upcoming') {
        // Upcoming 段通常含完整日期范围 → 记入内存，供同赛事转入 Ongoing 后回填
        if (dr.end > dr.start) LIQUID_DATE_MEMORY.set(id, { start: dr.start, end: dr.end });
      } else {
        // Ongoing 段（开赛后赛事从 Upcoming 移到此处）：日期单元格仅显示开始日 → end==start 截断。
        // 用内存中曾见过的完整赛期，或预构建快照 upcoming-local.json 回填完整结束日。
        if (dr.end <= dr.start) {
          let full = LIQUID_DATE_MEMORY.get(id);
          if ((!full || full.end <= full.start) && _snap && _snap.events) {
            const _dn = name.toLowerCase().replace(/[^a-z0-9]/g, '');
            const _hit = _snap.events.find((e) => {
              const _en = (e.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
              return _en && (_en === _dn || _dn.indexOf(_en) >= 0 || _en.indexOf(_dn) >= 0);
            });
            if (_hit && _hit.end > _hit.start) full = { start: _hit.start, end: _hit.end };
          }
          if (full && full.end > full.start) { dr.start = full.start; dr.end = full.end; }
        }
      }
      if (dr.end < nowSec) continue; // 已结束不进入赛程（回填后 end 为真实结束日，过期则过滤）
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
  });
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
  // §9（2026-07-30）：同步解析 Liquipedia Tier 字段，供客户端 sources.getLeagueTier 使用
  // 复用同一份 wikitext，零额外请求，不污染原 meta 结构（tier 为可选字段）
  try {
    const tierParsed = liquipediaParse.parseLeagueTier(wikitext);
    if (tierParsed) meta.liquipediaTier = tierParsed.tier;
  } catch (e) { /* 隔离 */ }
  await setCache(cacheKey, meta, TTL.liquipediaMeta).catch(() => {});
  return { data: meta, source: 'liquipedia' };
}

// ===== Liquipedia 赛程数据（未开赛/进行中的对阵）=====
// 与 liquipediaLeagueMeta 同样的「云函数抓取 wikitext + 纯解析」模式，
// 但用 parseScheduledMatches 解析 {{Match}} 模板，返回赛程数组而非元数据。
// 缓存 TTL 5 分钟（2026-08-03 由 30min 缩短，配合客户端 force 定时刷新近实时）。
// force 节流（2026-08-03）：客户端详情页 30-60s force 刷新，若多个用户同时 force 同一赛事
// 会导致高频现抓 Liquipedia。加云函数实例内存最小间隔 30s：force 且 30s 内已现抓过 →
// 直接返回最近缓存（尽力而为，多实例下节流效果减弱但客户端定时器已是主节流）。
const FORCE_MIN_GAP_MS = 30 * 1000;
const _lastForceFetch = {};   // slug -> 最近一次 force 现抓时间戳（实例内存）
// P3-1（2026-08-05）：通用 OpenDota 端点 force 统一节流 —— 与 liquipediaScheduledMatches
// 同一 FORCE_MIN_GAP_MS（30s）。客户端详情页 OD 重拉已 5min 主节流，此处防多用户并发
// force 同端点时高频现抓 OpenDota（60req/min 限制下的并发放大）。key = OpenDota path。
const _odLastForce = {};   // path -> 最近一次 force 现抓时间戳（实例内存）
// ★ 2026-08-11：多页面赛事（如 TI）的主页面不含 {{Match}} 模板（对阵在 Group_Stage 子页面）。
//   云函数端小硬编码表（仅收录主页面 wikitext 不含 {{Match}} 的赛事）。
//   2026-08-13（方案3）：提升为模块级常量——handleTimer 定时预热赛程缓存也需读取。
const SCHEDULED_MATCHES_SLUG_OVERRIDE = {
  'The International 2026': 'The_International/2026/Group_Stage'
};

// ===== LiquipediaDB v3 REST API（2026-08-20，P0 修复 LIVE/UPCOMING）=====
// 背景：2026 年起 Liquipedia 赛事页对阵改为 {{Matchlist}} 空占位 + LPDB 动态查询，
//   现有 wikitext 解析器对新结构解析出 0 场 → 详情页 LIVE/UPCOMING 恒空。
// 方案：云函数侧集成 LiquipediaDB v3 API，按 tournament pagename 查 match 表，
//   返回完整对阵 JSON（含 status: 'upcoming'|'finished' 等字段）。
// 认证：Authorization: Apikey <key>，key 从云函数环境变量 LIQUIPEDIA_API_KEY 读取。
// 申请：访问 https://liquipedia.net/api 提交 LPDB API 申请表单（含免费档 free tier），
//   审批进度可到 Liquipedia Discord #api-help 频道咨询。人工审批，通常 1-3 工作日。
// 限流：60 req/hour（赛事聚合场景足够；客户端缓存 5min 进一步降负载）。
// 降级：未配置 key → 自动回退到现有 wikitext 解析路径（对旧结构赛事仍有效）。
const LIQUIPEDIA_V3_BASE = 'https://api.liquipedia.net/api/v3';
const LIQUIPEDIA_V3_KEY = process.env.LIQUIPEDIA_API_KEY || '';

// v3 归一化辅助：队名 → 稳定正整数 id（LPDB 只给 pagename 不给数字 id）。
// djb2 哈希取正 int；同系列左右队 id 恒定，使客户端 score-by-team 按队归属比分正确
// （不受 radiant/dire 换边影响——LPDB 左右队固定不换边）。
function v3StableTeamId(name) {
  if (!name) return 0;
  let h = 5381;
  for (let i = 0; i < name.length; i++) h = ((h << 5) + h + name.charCodeAt(i)) >>> 0;
  return h === 0 ? 1 : h;
}
// LPDB bestof 数字/字符串 → 标准 BO 串
function v3BoString(bestof) {
  if (bestof == null) return null;
  const n = parseInt(bestof, 10);
  if (!isNaN(n)) return n === 1 ? 'BO1' : n === 2 ? 'BO2' : n === 3 ? 'BO3' : n === 5 ? 'BO5' : null;
  const s = String(bestof).toUpperCase();
  if (s.indexOf('BO') === 0) return s;
  return null;
}
// 标准 BO 串 → OpenDota series_type（0=BO1/1=BO3/2=BO5/3=BO2），供 resolveBoType S3 信号
function v3BoToSeriesType(bo) {
  return bo === 'BO1' ? 0 : bo === 'BO2' ? 3 : bo === 'BO3' ? 1 : bo === 'BO5' ? 2 : null;
}

// 把赛事展示名转换为 v3 API 用的 tournament pagename。
// 复用 SCHEDULED_MATCHES_SLUG_OVERRIDE + liquipediaSlugFor（单一事实来源，与 wikitext 路径一致）。
function liquipediaV3PagenameFor(displayName) {
  const override = SCHEDULED_MATCHES_SLUG_OVERRIDE[displayName];
  if (override) return override;
  return liquipediaSlugFor(displayName);
}

// v3 API 调用：按 tournament pagename 查 match 表。
// 返回归一化后的对阵数组（与 parseScheduledMatches 输出形状对齐，供客户端零改动消费）。
// 失败/未配置 key → 返回 null（调用方回退到 wikitext 解析路径）。
async function fetchLiquipediaV3Matches(displayName) {
  if (!LIQUIPEDIA_V3_KEY) return null;
  const pagename = liquipediaV3PagenameFor(displayName);
  if (!pagename) return null;
  // v3 match 端点：wiki=dota2，conditions 按 tournament pagename 过滤。
  // [[tournament::pagename*]] 用 LPDB 前缀通配（尾随 *）匹配整棵子树：
  //   主赛事 + Group_Stage + Main_Event 等所有子页面对阵一并返回。
  //   注意：pagename 须为父级（如 The_International/2026），不含子页后缀；否则 * 会漏匹配。
  const conditions = '[[tournament::' + pagename + '*]]';
  try {
    const res = await safeFetch({
      url: LIQUIPEDIA_V3_BASE + '/match',
      searchParams: {
        wiki: 'dota2',
        conditions: conditions,
        query: 'date,tournament,opponentleft,opponentright,status,scoreleft,scoreright,extradata,match2bracketid,pagename',
        order: 'date asc',
        limit: '100'
      },
      headers: {
        'Authorization': 'Apikey ' + LIQUIPEDIA_V3_KEY,
        'User-Agent': LIQUIPEDIA_UA,
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip'
      },
      responseType: 'json',
      source: 'LiquipediaV3',
      // v3 API 限流更严，重试间隔加大
      retry: { limit: 1, backoffLimit: 5000 }
    });
    if (!res || !res.body) return null;
    const data = res.body.data || res.body.result || res.body;
    const rawMatches = Array.isArray(data) ? data : (data.match || data.matches || data.result || []);
    if (!rawMatches.length) return null;
    // 归一化为 parseScheduledMatches 输出形状（客户端 groupSeries 期望的字段）
    return rawMatches.map(normalizeV3Match).filter(Boolean);
  } catch (e) {
    console.warn('[LiquipediaV3] fetch failed for', pagename, ':', e && e.message || e);
    return null;
  }
}

// v3 match 字段 → 客户端 parseScheduledMatches 输出形状的归一化。
// v3 字段参考：https://liquipedia.net/hub/Help:LiquipediaDB（match 表）
// 关键映射：
//   opponentleft/right {name, image} → team1Name/team2Name
//   date (ISO 8601) → startTime (unix sec)
//   status ('upcoming'|'finished'|...) → phase 推导
//   scoreleft/right → score1/score2（用于 RECENT 胜负判定）
//   extradata → boType 等扩展
function normalizeV3Match(m) {
  if (!m) return null;
  try {
    const dateStr = m.date || '';
    const startTime = dateStr ? Math.floor(new Date(dateStr + 'Z').getTime() / 1000) : 0;
    if (!startTime) return null;
    const ol = m.opponentleft || (m.opponent && m.opponent[0]) || {};
    const or = m.opponentright || (m.opponent && m.opponent[1]) || {};
    const t1 = ol.name || ol.identifier || '';
    const t2 = or.name || or.identifier || '';
    const status = m.status || '';
    // phase 粗粒度推导：客户端 groupSeries 会按 startTime + isOngoing 重新精确判定
    const nowSec = Math.floor(Date.now() / 1000);
    let phase = 'recent';
    if (status === 'upcoming' || startTime > nowSec) phase = 'upcoming';
    else if (status === 'finished' || (m.scoreleft != null && m.scoreright != null && (m.scoreleft || m.scoreright))) phase = 'recent';
    else phase = 'live'; // 未明确状态 + 已开赛 + 无比分 → 假定进行中
    // boType 从 extradata 提取（v3 存 bestof 或 format）
    const extra = m.extradata || {};
    const boStr = v3BoString(extra.bestof || extra.format || extra.bo);
    // ★ 合成 series_id：优先 LPDB bracket id（同系列共享），否则用 (队名对 + UTC 日) 兜底。
    //   目的：让同一 BO 系列的若干场在客户端 groupSeries 自然归组（与 OpenDota 同路径，已验证可正确聚合），
    //   而不是每场各自成为 BO1。这是修复「一场 BO3 被识别成两场 BO1」的关键。
    const bracket = m.match2bracketid || '';
    const dayBucket = Math.floor(startTime / 86400);
    const seriesId = bracket
      ? ('lp_' + bracket)
      : ('lp_' + (t1 || 'x') + '|' + (t2 || 'x') + '|' + dayBucket);
    // 每场胜负：LPDB 左右队固定不换边，radiant_win 按左队(scoreleft)是否胜；
    // 客户端按 radiant_team_id/dire_team_id（=左右队稳定 id）归属比分 → 系列比分 = 左队总胜:右队总胜。
    const sl = typeof m.scoreleft === 'number' ? m.scoreleft : null;
    const sr = typeof m.scoreright === 'number' ? m.scoreright : null;
    const radiantWin = (sl != null && sr != null) ? (sl > sr) : null;
    return {
      // —— OpenDota 形状兼容字段（客户端 groupSeries / score / resolveBoType 依赖）——
      match_id: m.pagename || (seriesId + '_' + startTime),
      series_id: seriesId,
      series_type: v3BoToSeriesType(boStr),
      radiant_team_id: v3StableTeamId(t1),
      dire_team_id: v3StableTeamId(t2),
      radiant_team_name: t1,
      dire_team_name: t2,
      radiant_win: radiantWin,
      start_time: startTime,
      startTime: startTime,   // ★ 2026-08-20：别名对齐客户端 Liquipedia 合并段读取的 m.startTime
      // —— 向后兼容字段（其他消费方可能读取）——
      team1Name: t1,
      team2Name: t2,
      team1Short: ol.shortname || t1,
      team2Short: or.shortname || t2,
      phase: phase,
      status: status,
      boType: boStr,
      score1: sl,
      score2: sr,
      bracketId: bracket || null,
      pagename: m.pagename || m.tournament || ''
    };
  } catch (e) {
    console.warn('[LiquipediaV3] normalize failed:', e && e.message);
    return null;
  }
}

async function liquipediaScheduledMatches(params, force) {
  const pageName = (params && (params.pageName || params.name)) || null;
  if (!pageName) return { data: null, error: makeError(ERROR_CODES.BAD_REQUEST, 'pageName required') };
  const overrideSlug = SCHEDULED_MATCHES_SLUG_OVERRIDE[pageName];
  const slug = overrideSlug || liquipediaSlugFor(pageName);
  const cacheKey = 'liquipedia_schedule_' + slug;
  // ★ 2026-08-04：返回契约升级为 { matches, boFormat }（BO 判定引擎 S2 信号）。
  //   兼容旧形状：旧缓存/旧版本存的裸数组 → 归一化为 { matches, boFormat: null }。
  function normalizeCached(cached) {
    if (Array.isArray(cached)) return { matches: cached, boFormat: null };
    if (cached && Array.isArray(cached.matches)) return { matches: cached.matches, boFormat: cached.boFormat || null };
    return null;
  }
  if (!force) {
    const cached = await getCache(cacheKey);
    const norm = normalizeCached(cached);
    if (norm) return { data: norm, source: 'cache' };
  } else {
    // force 最小间隔：30s 内已现抓过 → 返回最近缓存（若有）
    const last = _lastForceFetch[slug] || 0;
    if (Date.now() - last < FORCE_MIN_GAP_MS) {
      const cached = await getCache(cacheKey);
      const norm = normalizeCached(cached);
      if (norm) return { data: norm, source: 'cache-recent' };
    }
    _lastForceFetch[slug] = Date.now();
  }
  // ★ 2026-08-20：v3 API 优先路径（P0 修复 LIVE/UPCOMING）。
  // 未配置 LIQUIPEDIA_API_KEY 或调用失败 → fetchLiquipediaV3Matches 返回 null，自动回退到 wikitext 路径。
  const v3Matches = await fetchLiquipediaV3Matches(pageName);
  if (v3Matches && v3Matches.length) {
    const payload = { matches: v3Matches, boFormat: null };
    await setCache(cacheKey, payload, TTL.liquipediaSchedule).catch(() => {});
    return { data: payload, source: 'liquipedia-v3' };
  }
  // 回退：现有 wikitext 解析路径（对旧结构赛事仍有效；对新结构赛事会返回 0 场）
  const wikitext = await fetchLiquipediaWikitext(slug);
  if (!wikitext) return { data: null, source: 'liquipedia' };
  // 用 parseScheduledMatches 解析赛程，传入当前时间戳用于 phase 判定
  const nowSec = Math.floor(Date.now() / 1000);
  const matches = liquipediaParse.parseScheduledMatches(wikitext, nowSec);
  // ★ 2026-08-04：同份 wikitext 解析 Format 段赛制（零额外请求，审核 R1/R8）
  const boFormat = liquipediaParse.parseBoFormat(wikitext);
  if (!matches || !matches.length) return { data: { matches: [], boFormat: boFormat }, source: 'liquipedia' };
  const payload = { matches: matches, boFormat: boFormat };
  await setCache(cacheKey, payload, TTL.liquipediaSchedule).catch(() => {});
  return { data: payload, source: 'liquipedia' };
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
    // ★ 2026-07-30 修复 logo 永远为空 BUG：
    //   Liquipedia 图片存储在 lpcommons（Liquipedia Commons）foreign file repo 中，
    //   查询 imageinfo 时 page.missing=true（本地 wiki 无此文件页面）但 page.known=true
    //   且 page.imageinfo 有值（API 自动从 foreign repo 获取）。
    //   原 `if (page.missing) return null` 导致所有 logo 查询都失败。
    //   修复：missing 时仍检查 imageinfo，有值则使用（foreign repo 命中）。
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

// ===== Liquipedia 赛事主动枚举（§9 2026-07-30）=====
// 通过 MediaWiki 标准 API: list=allpages 或 list=categorymembers 枚举全量赛事页面。
//
// ★ 合规要点（见 https://liquipedia.net/api-terms-of-use）★
//   1. 使用标准 API（action=query&list=...），不抓 HTML，符合条款
//   2. 设置描述性 User-Agent + Accept-Encoding: gzip
//   3. categorymembers 是标准查询 API，不属于"自动化访问非 API 端点"禁止范围
//   4. 全量拉取后缓存 7 天，月度刷新一次（赛事列表变化慢，降频降低 Liquipedia 负载）
//
// 实现策略：
//   1. 枚举 Category:Tournaments 下所有页面（cmtitle=Category:Tournaments）
//   2. 用 cmtype=page 仅取页面（排除子分类）
//   3. 分页拉取（cmlimit=500，每次间隔 2.2s 遵守限流），最多 10 页 = 5000 条
//   4. 过滤：仅保留带年份的页面（/20\d{2}/），剔除帮助页/分类页
//   5. 返回 [{ slug, title }] 列表，供客户端/脚本补全 curation
async function liquipediaListTournaments(params, force) {
  const cacheKey = 'liquipedia_tournament_list_v1';
  if (!force) {
    const cached = await getCache(cacheKey).catch(() => null);
    if (cached && Array.isArray(cached) && cached.length) {
      return { data: cached, source: 'cache' };
    }
  }

  const allPages = [];
  let cmcontinue = null;
  const MAX_PAGES = 10;  // 最多拉取 10 页 × 500 = 5000 条，覆盖历史+未来全量赛事

  for (let page = 0; page < MAX_PAGES; page++) {
    if (page > 0) {
      // 遵守 2s 限流（除第一页外，每页间隔 2.2s 留余量）
      await new Promise((r) => setTimeout(r, 2200));
    }
    try {
      const searchParams = {
        action: 'query',
        list: 'categorymembers',
        cmtitle: 'Category:Tournaments',
        cmtype: 'page',
        cmlimit: '500',
        cmdir: 'asc',
        format: 'json',
        formatversion: '2'
      };
      if (cmcontinue) searchParams.cmcontinue = cmcontinue;

      const res = await safeFetch({
        url: LIQUIPEDIA_BASE,
        searchParams: searchParams,
        headers: {
          'User-Agent': LIQUIPEDIA_UA,
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip'
        },
        responseType: 'json',
        source: 'Liquipedia-ListTournaments'
      });
      const body = res && res.body;
      if (!body || !body.query || !body.query.categorymembers) break;
      const members = body.query.categorymembers;
      if (!Array.isArray(members) || !members.length) break;

      members.forEach((m) => {
        if (m && m.title && m.ns === 0) {  // ns=0 为主命名空间，剔除分类/帮助页
          allPages.push({ slug: m.title, title: m.title.replace(/^Dota 2\/|Tournaments\//i, '') });
        }
      });

      // 检查是否还有更多
      cmcontinue = (body.continue && body.continue.cmcontinue) || null;
      if (!cmcontinue) break;
    } catch (e) {
      // 单页失败不致命，返回已拉取的部分
      console.warn('[liquipediaListTournaments] 第 ' + (page + 1) + ' 页拉取失败:', (e && e.message) || e);
      break;
    }
  }

  // 过滤：仅保留带年份的页面（剔除 "Tournaments"、"Help:..." 等非赛事页）
  const filtered = allPages.filter((p) => /20\d{2}/.test(p.title));

  if (filtered.length) {
    await setCache(cacheKey, filtered, TTL.liquipediaTournamentList).catch(() => {});
  }
  return { data: filtered, source: 'liquipedia' };
}

// ===== Liquipedia raw wikitext 抓取代理（§9 P1，用于名册/选手资料）=====
// 输入 { pageName }，输出 { wikitext: string }。
// 区别于 liquipediaLeagueMeta（抓取+解析），此处仅代理抓取 raw wikitext，
// 由客户端自行解析（getTeamRoster/getPlayerProfile 本地解析逻辑）。
// 复用 fetchLiquipediaWikitext（已含 UA+gzip+redirects:1 合规请求），
// 经 liquipediaSlugFor 映射后抓取，提高页面名命中率。
async function liquipediaFetchRawWikitext(params, force) {
  const pageName = (params && (params.pageName || params.name)) || null;
  if (!pageName) return { data: null, error: makeError(ERROR_CODES.BAD_REQUEST, 'pageName required') };
  const slug = liquipediaSlugFor(pageName);
  const wikitext = await fetchLiquipediaWikitext(slug);
  if (!wikitext) return { data: null, source: 'liquipedia' };
  return { data: { wikitext: wikitext }, source: 'liquipedia' };
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

// ===== Steam 联赛 LIVE 对阵聚合（2026-08-21，LIVE 主源）=====
// 背景：Liquipedia 2026 把对阵数据搬进了 LPDB（需 API key，且审批不确定）；
//       STRATZ GraphQL 仍被 Cloudflare 反爬虫挑战页拦截（2026-07-30 起未解封）。
//       Steam Web API 项目已配 STEAM_API_KEY 且云函数环境已知可达，作为 LIVE 主源最稳。
//
// 数据来源（2026-08-21 实测确认）：
//   - GetLiveLeagueGames/v1      ✅ 端点存活（xpaw.me 文档、沙箱探测均确认）
//     · 支持按 league_id 过滤（xpaw.me 列出该参数）
//     · 原生返回 series_id / series_type / radiant_series_wins / dire_series_wins
//   - GetScheduledLeagueGames/v1 ❌ 已被 Valve 删除（2026-08-21 沙箱探测返回 404：
//     "Method 'GetScheduledLeagueGames' not found in interface 'IDOTA2Match_570'"）
//     · 函数定义保留（带废弃标记）便于未来若 Valve 恢复时一行启用
//     · 当前 steamLeagueScheduledMatches 不再调用该端点（避免每次请求浪费一次 404）
//
// UPCOMING 段需依赖 Liquipedia LPDB v3（用户已提交申请，审批中）或 curation 兜底。
//
// 返回契约与 liquipediaScheduledMatches 对齐：{ matches: [...], boFormat: null }
//   matches 每项形状兼容客户端 league-detail.js 合并段读取的字段：
//   { series_id, series_type, league_id, radiant_team_id, dire_team_id,
//     radiant_team_name, dire_team_name, radiant_win, start_time,
//     team1Name, team2Name, startTime, score1, score2, phase }
async function fetchSteamLiveLeagueGames(leagueId) {
  // GetLiveLeagueGames 无 league_id 过滤参数，返回全量；需本地按 league_id 筛。
  // ★ 2026-08-21 BUG 修复：Steam API 返回顶层是 { result: { games: [...] } }，
  //   不是 { games: [...] }。RDota2 包源码 / TF2 Wiki 均确认。
  //   原实现读 data.games 永远为 undefined → 直接 return [] → LIVE 段恒空。
  const data = await fetchSteam('/GetLiveLeagueGames', {});
  if (!data || !data.result) {
    console.log('[SteamLive] league=' + leagueId + ' rawResp=' + JSON.stringify(data).slice(0, 200));
    return [];
  }
  const result = data.result;
  // 部分老版本兼容：极少情况下顶层直接是 games 数组
  const games = Array.isArray(result.games) ? result.games
              : (Array.isArray(data.games) ? data.games : []);
  // 诊断：打印全量 LIVE 游戏所属 league 列表，便于确认 TI2026 真的没在直播（vs 被 filter 漏掉）
  const leagueSet = {};
  games.forEach(function (g) {
    const lid = g.league_id || 0;
    leagueSet[lid] = (leagueSet[lid] || 0) + 1;
  });
  console.log('[SteamLive] league=' + leagueId + ' totalGames=' + games.length +
              ' leagueDistribution=' + JSON.stringify(leagueSet));
  return games.filter(function (g) {
    return String(g.league_id) === String(leagueId);
  });
}

// ⚠️ DEPRECATED 2026-08-21：Valve 已删除此端点（返回 404 Not Found）。
//    定义保留以便未来恢复时一行启用，但 steamLeagueScheduledMatches 不再调用它。
//    UPCOMING 数据改由 Liquipedia LPDB v3 或 curation 兜底。
async function fetchSteamScheduledLeagueGames(leagueId, dateMin, dateMax) {
  // date_min/date_max：Unix 秒（Valve 规范）；云函数环境用 process.env 避免时区漂移
  const nowSec = Math.floor(Date.now() / 1000);
  const params = {
    date_min: dateMin || nowSec,
    date_max: dateMax || (nowSec + 14 * 24 * 3600)  // 默认未来 14 天
  };
  const data = await fetchSteam('/GetScheduledLeagueGames', params);
  if (!data || !data.result || !data.result.games) return [];
  const games = Array.isArray(data.result.games) ? data.result.games : [];
  return games.filter(function (g) {
    return String(g.league_id) === String(leagueId);
  });
}

// 把 Steam live/scheduled 对局归一化为客户端合并段兼容的字段
function normalizeSteamLiveGame(g) {
  if (!g) return null;
  try {
    const rad = g.radiant_team || {};
    const dire = g.dire_team || {};
    const seriesId = g.series_id || 0;
    const seriesType = typeof g.series_type === 'number' ? g.series_type : null;
    const startTime = Math.floor(Date.now() / 1000);  // live 无固定开始时间，用当前
    return {
      // —— OpenDota 形状（客户端 groupSeries 聚合键）——
      series_id: seriesId,
      series_type: seriesType,
      league_id: g.league_id,
      radiant_team_id: rad.team_id || 0,
      dire_team_id: dire.team_id || 0,
      radiant_win: (g.radiant_series_wins > g.dire_series_wins),
      match_id: g.match_id || g.server_steam_id || 0,
      start_time: startTime,
      // —— Liquipedia 形状（league-detail.js L800 合并段读取）——
      team1Name: rad.team_name || '',
      team2Name: dire.team_name || '',
      team1Short: rad.team_name || '',
      team2Short: dire.team_name || '',
      startTime: startTime,
      // 系列 BO 比分（Steam 原生提供，比 LPDB 自己推断更准）
      score1: typeof g.radiant_series_wins === 'number' ? g.radiant_series_wins : 0,
      score2: typeof g.dire_series_wins === 'number' ? g.dire_series_wins : 0,
      phase: 'live',
      boType: null,
      // 队标 UGC URL（Steam 直接返回，无需另查）
      team1Logo: rad.team_logo || '',
      team2Logo: dire.team_logo || '',
      stage: g.stage_name || '',
      source: 'steam-live'
    };
  } catch (e) {
    console.warn('[SteamLive] normalize failed:', e && e.message);
    return null;
  }
}

function normalizeSteamScheduledGame(g) {
  if (!g) return null;
  try {
    // GetScheduledLeagueGames 返回的 teams 是数组（可能为空——未公布对阵）
    const teams = Array.isArray(g.teams) ? g.teams : [];
    const t1 = teams[0] || {};
    const t2 = teams[1] || {};
    const startTime = typeof g.starttime === 'number' ? g.starttime : 0;
    return {
      // Scheduled 无 series_id/series_type（Valve 设计：未开赛不分配）
      // 用「队名对 + 同日」让客户端 groupLiquipediaMatches 兜底聚合
      series_id: 0,
      series_type: null,
      league_id: g.league_id,
      radiant_team_id: t1.team_id || 0,
      dire_team_id: t2.team_id || 0,
      match_id: g.game_id || 0,
      start_time: startTime,
      team1Name: t1.team_name || '',
      team2Name: t2.team_name || '',
      team1Short: t1.team_name || '',
      team2Short: t2.team_name || '',
      startTime: startTime,
      score1: null,
      score2: null,
      phase: 'upcoming',
      boType: null,
      team1Logo: '',
      team2Logo: '',
      stage: g.comment || '',
      source: 'steam-scheduled'
    };
  } catch (e) {
    console.warn('[SteamScheduled] normalize failed:', e && e.message);
    return null;
  }
}

async function steamLeagueScheduledMatches(params, force) {
  const leagueId = (params && (params.leagueId || params.id)) || null;
  if (!leagueId) return { data: null, error: makeError(ERROR_CODES.BAD_REQUEST, 'leagueId required') };
  if (!STEAM_KEY) return { data: null, error: makeError(ERROR_CODES.NOT_CONFIGURED, 'STEAM_API_KEY not set') };

  const cacheKey = 'steam_schedule_' + leagueId;
  // force 节流：与 liquipediaScheduledMatches 同策略
  if (!force) {
    const cached = await getCache(cacheKey);
    if (cached) return { data: cached, source: 'cache' };
  } else {
    const last = _lastForceFetch[cacheKey] || 0;
    if (Date.now() - last < FORCE_MIN_GAP_MS) {
      const cached = await getCache(cacheKey);
      if (cached) return { data: cached, source: 'cache-recent' };
    }
    _lastForceFetch[cacheKey] = Date.now();
  }

  try {
    // ★ 2026-08-21：GetScheduledLeagueGames 端点已被 Valve 删除（返回 404），
    //   故只抓 LIVE；UPCOMING 段依赖 Liquipedia LPDB v3（申请中）或 curation 兜底。
    const liveRaw = await fetchSteamLiveLeagueGames(leagueId).catch(function (e) {
      console.warn('[SteamLive] fetch failed:', e && e.message);
      return [];
    });

    const liveMatches = (liveRaw || []).map(normalizeSteamLiveGame).filter(Boolean);
    const all = liveMatches;

    console.log('[SteamLeague] league=' + leagueId + ' liveGames=' + (liveRaw || []).length +
                ' normalized=' + liveMatches.length);

    const payload = { matches: all, boFormat: null };
    if (all.length) {
      await setCache(cacheKey, payload, TTL.liquipediaSchedule).catch(function () {});
    }
    return { data: payload, source: 'steam' };
  } catch (e) {
    return { data: null, error: makeError(ERROR_CODES.UPSTREAM_ERROR, 'Steam 联赛对阵请求异常', (e && e.message) || String(e)) };
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

// ===== 数据源健康检查（2026-08-11 长期架构改进落地）=====
// 用途：客户端在「数据为空」时区分「数据源暂不可用」与「赛事确实无数据」，
//       避免 Liquipedia/OpenDota 链路异常时静默降级让用户误以为没数据。
// 设计：轻量探测请求 + 短超时（6s）+ 不重试（健康探测追求快速，不落缓存；
//       客户端侧带 TTL 缓存控制调用频率）。OpenDota /health 返回纯文本 "OK"。
// 返回：{ ts, sources: { liquipedia: {status,latencyMs}, opendota: {status,latencyMs} }, ok }
async function probeLiquipedia() {
  try {
    const res = await safeFetch({
      url: LIQUIPEDIA_BASE,
      searchParams: { action: 'query', meta: 'siteinfo', format: 'json', formatversion: '2' },
      headers: { 'User-Agent': LIQUIPEDIA_UA, 'Accept': 'application/json', 'Accept-Encoding': 'gzip' },
      responseType: 'json',
      timeout: { request: 6000 },
      retryCount: 0,
      source: 'Liquipedia-Health'
    });
    return !!(res && res.body && res.body.query);
  } catch (e) {
    return false;
  }
}

async function handleHealth() {
  const out = { ts: Date.now(), sources: {} };
  // Liquipedia 探测：siteinfo 轻量查询
  try {
    const t0 = Date.now();
    const up = await probeLiquipedia();
    out.sources.liquipedia = { status: up ? 'up' : 'down', latencyMs: Date.now() - t0 };
  } catch (e) {
    out.sources.liquipedia = { status: 'down', latencyMs: -1, detail: (e && e.message) || String(e) };
  }
  // OpenDota 探测：/health（返回 JSON 状态对象，含 postgres/redis 等 usage 指标；
  // 2026-08-11 实测非纯文本 "OK"，只要请求成功且 body 非空即视为 up）
  try {
    const t0 = Date.now();
    const res = await safeFetch({
      url: BASE + '/health',
      responseType: 'json',
      timeout: { request: 6000 },
      retryCount: 0,
      source: 'OpenDota-Health'
    });
    const body = res && res.body;
    out.sources.opendota = {
      status: (body && typeof body === 'object' && Object.keys(body).length > 0) ? 'up' : 'down',
      latencyMs: Date.now() - t0
    };
  } catch (e) {
    out.sources.opendota = { status: 'down', latencyMs: -1, detail: (e && e.message) || String(e) };
  }
  out.ok = Object.keys(out.sources).some(function (k) { return out.sources[k].status === 'up'; });
  return { data: out, source: 'fresh' };
}

async function handleGetUpcomingSchedule() {
  const cached = await getCache('upcoming_schedule');
  if (cached) return { data: cached, source: 'cache' };
  // 2026-08-13（「即将」加载优化 · P0）：缓存未命中时不再现场预热。
  // 原因：preheatUpcoming 耗时 30-60s（STRATZ 30×2s 或 Liquipedia 多页），
  // 客户端 callFunction 挂起 30-60s = 用户看到 spinner 卡死；且有定时触发器
  // （handleTimer / preheatShouldRun）周期性预热，冷窗口本就短暂。
  // 改为 fire-and-forget 后台预热 + 立即返回 cold 空态，客户端据 source='cold'
  // 走本地快照 + curation 注入兜底（键数判空，见 leagues.js tryCloudUpcoming）。
  preheatUpcoming().catch(() => {});
  return { data: {}, source: 'cold', preheating: true };
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

// ===== 阶段1-②：云端 curation 读取（2026-07-30）=====
// 从云数据库读取 curation_events / curation_teams / curation_meta，
// 返回与 utils/curation.js 兼容的数据结构 { events, teams, tiContestantIds, version }。
//
// 增量更新机制：
//   - 客户端传 clientVersion，若与云端 version 一致 → 返回 { unchanged: true }，零数据传输
//   - 不一致 → 返回完整数据 + version
//   - clientVersion 为空 → 首次拉取，返回完整数据
//
// 缓存策略：
//   - L1 内存缓存 10 分钟（curation 数据变化慢，无需高频读 cloud DB）
//   - version 变化时自动失效 L1
const CURATION_L1_KEY = 'curation_full';
const CURATION_L1_TTL = 10 * 60 * 1000;
let _curationL1Cache = null;
let _curationL1Version = null;

async function loadCurationFromDB() {
  const db = cloud.database();
  // 并行查询 events / teams / meta（三者无依赖）
  const [eventsRes, teamsRes, metaRes] = await Promise.all([
    db.collection('curation_events').limit(500).get(),
    db.collection('curation_teams').limit(500).get(),
    db.collection('curation_meta').doc('ti_contestant_ids').get().catch(() => ({ data: null }))
  ]);

  const events = (eventsRes.data || []).map((doc) => {
    // 移除云数据库元字段，保留业务字段
    const e = Object.assign({}, doc);
    delete e._id;
    delete e.updatedAt;
    return e;
  });
  const teamsArr = (teamsRes.data || []);
  const teams = {};
  teamsArr.forEach((doc) => {
    const tid = doc._id;
    if (!tid) return;
    const t = Object.assign({}, doc);
    delete t._id;
    delete t.updatedAt;
    teams[Number(tid)] = t;
  });
  const meta = metaRes.data || {};
  const tiContestantIds = meta.ids || [];
  const version = meta.version || '0';

  return { events, teams, tiContestantIds, version };
}

async function handleGetCuration(event) {
  const clientVersion = (event.params && event.params.clientVersion) || '';
  const force = !!event.force;

  // L1 命中且版本一致：直接返回 unchanged
  if (!force && _curationL1Cache && _curationL1Version) {
    if (clientVersion && clientVersion === _curationL1Version) {
      return { unchanged: true, version: _curationL1Version, source: 'cache' };
    }
    // 版本不一致或首次拉取：返回 L1 缓存数据
    return {
      data: _curationL1Cache,
      version: _curationL1Version,
      source: 'cache'
    };
  }

  // L1 未命中：读云数据库
  try {
    const result = await loadCurationFromDB();
    _curationL1Cache = result;
    _curationL1Version = result.version;

    // 版本一致：返回 unchanged
    if (clientVersion && clientVersion === result.version) {
      return { unchanged: true, version: result.version, source: 'fresh' };
    }
    return {
      data: result,
      version: result.version,
      source: 'fresh'
    };
  } catch (e) {
    // 云数据库读取失败：尝试 L1 过期缓存兜底
    if (_curationL1Cache) {
      return {
        data: _curationL1Cache,
        version: _curationL1Version,
        source: 'cache_fallback',
        warning: 'cloud DB read failed, using stale cache'
      };
    }
    return { error: makeError(ERROR_CODES.UPSTREAM_ERROR, '云数据库读取 curation 失败', (e && e.message) || String(e)) };
  }
}

// ===== 阶段2-③：云端 curation 写操作中转（2026-07-31）=====
// Web 端无法直写云开发数据库，所有 curation 写操作走云函数中转。
// 支持 5 种 operation：upsertEvent / upsertTeam / deleteEvent / deleteTeam / updateMeta
// 每次写操作后统一：重读全量数据 → 重算 version → 更新 curation_meta(version/updatedAt)
//   → 写 admin-logs → 清空 L1 缓存（下次读取会重新从 DB 加载）。
//
// 规范名归一化（与 admin/src/api/cloudbase.js 的 normalizeEventName 逻辑一致）：
//   转小写，仅保留 [a-z0-9 中文一-鿿 西里尔字母а-яё]，去掉一切分隔符与标点。
function normalizeEventName(name) {
  if (!name) return '';
  return String(name).toLowerCase().replace(/[^a-z0-9一-鿿а-яё]/g, '').replace(/^the/, '');
}

// 计算数据指纹（MD5 前 8 位），与 scripts/migrate-curation-to-db.js 的 computeVersion 逻辑一致。
// teams 可能是数组（来自 DB 查询）或对象（按 team_id 索引），统一处理为对象后取 keys。
function computeVersion(events, teams, tiIds) {
  const crypto = require('crypto');
  const safeEvents = events || [];
  const safeTiIds = tiIds || [];
  const teamsObj = Array.isArray(teams)
    ? teams.reduce((acc, t) => {
        const k = t._id != null ? t._id : t.team_id;
        if (k != null) acc[k] = t;
        return acc;
      }, {})
    : (teams || {});
  const teamIds = Object.keys(teamsObj).map(Number).sort((a, b) => a - b);
  const payload = {
    eventsCount: safeEvents.length,
    teamsCount: teamIds.length,
    tiIdsCount: safeTiIds.length,
    eventsCanonical: safeEvents.map((e) => e.canonical).filter(Boolean).sort().join(','),
    teamsIds: teamIds.join(',')
  };
  return crypto.createHash('md5').update(JSON.stringify(payload)).digest('hex').slice(0, 8);
}

// 写操作后统一收尾：重算 version + 更新 meta + 写日志 + 清 L1。
// 返回重算后的新 version。任何子步骤失败都不阻断主流程（已写入的记录不回滚）。
async function _afterCurationWrite(operation, before, after) {
  // 1. 重读全量数据并重算 version
  const fresh = await loadCurationFromDB();
  const newVersion = computeVersion(fresh.events, fresh.teams, fresh.tiContestantIds);

  // 2. 更新 curation_meta 的 version + updatedAt + count（保留当前 ids）
  //    meta 文档完整 schema 仅 {ids, count, version, updatedAt}，set 覆盖安全。
  try {
    const db = cloud.database();
    await db.collection('curation_meta').doc('ti_contestant_ids').set({
      ids: fresh.tiContestantIds,
      count: fresh.tiContestantIds.length,
      version: newVersion,
      updatedAt: Date.now()
    });
  } catch (e) {
    // meta 更新失败不阻断主流程
    console.warn('[adminWriteCuration] update meta version failed:', (e && e.message) || e);
  }

  // 3. 写 admin-logs（失败静默，不影响主流程）
  try {
    const db = cloud.database();
    await db.collection('admin-logs').add({
      data: {
        action: operation,
        operator: 'admin',
        before: before || null,
        after: after || null,
        timestamp: Date.now()
      }
    });
  } catch (e) {}

  // 4. 清空 curation L1 缓存（模块变量 + 通用 l1Cache Map 双保险）
  _curationL1Cache = null;
  _curationL1Version = null;
  try { l1Cache.delete(_v() + CURATION_L1_KEY); } catch (e) {}

  return newVersion;
}

// 读取单条文档用于日志（before/after），不存在或异常返回 null。
async function _readDocForLog(coll, docId) {
  try {
    const db = cloud.database();
    const r = await db.collection(coll).doc(docId).get();
    return (r && r.data) || null;
  } catch (e) { return null; }
}

async function handleAdminWriteCuration(event) {
  const params = (event && event.params) || {};
  const operation = params.operation;
  const db = cloud.database();

  try {
    // ---- upsertEvent：写入/更新单条 curation_events ----
    if (operation === 'upsertEvent') {
      const data = params.data || {};
      if (!data.canonical) {
        return { error: makeError(ERROR_CODES.BAD_REQUEST, 'canonical 必填') };
      }
      const docId = normalizeEventName(data.canonical);
      if (!docId) {
        return { error: makeError(ERROR_CODES.BAD_REQUEST, 'canonical 归一化后为空') };
      }
      const before = await _readDocForLog('curation_events', docId);
      const doc = Object.assign({}, data, { updatedAt: Date.now() });
      delete doc._id; // _id 由 doc() 指定，不写入 data 体
      await db.collection('curation_events').doc(docId).set(doc);
      const after = await _readDocForLog('curation_events', docId);
      const newVersion = await _afterCurationWrite(operation, before, after);
      return { success: true, version: newVersion, source: 'fresh' };
    }

    // ---- upsertTeam：写入/更新单条 curation_teams ----
    if (operation === 'upsertTeam') {
      const data = params.data || {};
      const teamId = data.team_id;
      const tidNum = Number(teamId);
      if (teamId == null || !Number.isInteger(tidNum) || tidNum <= 0) {
        return { error: makeError(ERROR_CODES.BAD_REQUEST, 'team_id 必填且为正整数') };
      }
      const docId = String(tidNum);
      const before = await _readDocForLog('curation_teams', docId);
      const doc = Object.assign({}, data, { updatedAt: Date.now() });
      delete doc._id;
      await db.collection('curation_teams').doc(docId).set(doc);
      const after = await _readDocForLog('curation_teams', docId);
      const newVersion = await _afterCurationWrite(operation, before, after);
      return { success: true, version: newVersion, source: 'fresh' };
    }

    // ---- deleteEvent：删除单条 curation_events ----
    if (operation === 'deleteEvent') {
      const docId = params.docId;
      if (!docId) {
        return { error: makeError(ERROR_CODES.BAD_REQUEST, 'docId 必填') };
      }
      const before = await _readDocForLog('curation_events', docId);
      await db.collection('curation_events').doc(docId).remove();
      const newVersion = await _afterCurationWrite(operation, before, null);
      return { success: true, version: newVersion, source: 'fresh' };
    }

    // ---- deleteTeam：删除单条 curation_teams ----
    if (operation === 'deleteTeam') {
      const docId = params.docId;
      if (!docId) {
        return { error: makeError(ERROR_CODES.BAD_REQUEST, 'docId 必填') };
      }
      const before = await _readDocForLog('curation_teams', docId);
      await db.collection('curation_teams').doc(docId).remove();
      const newVersion = await _afterCurationWrite(operation, before, null);
      return { success: true, version: newVersion, source: 'fresh' };
    }

    // ---- updateMeta：更新 curation_meta（主要是 tiContestantIds 数组）----
    if (operation === 'updateMeta') {
      const data = params.data || {};
      const ids = Array.isArray(data.ids)
        ? data.ids.map(Number).filter((x) => Number.isInteger(x))
        : [];
      const before = await _readDocForLog('curation_meta', 'ti_contestant_ids');
      // 先写 ids（无 version），_afterCurationWrite 会重读 ids 并补写 version
      await db.collection('curation_meta').doc('ti_contestant_ids').set({
        ids: ids,
        count: ids.length,
        updatedAt: Date.now()
      });
      const after = await _readDocForLog('curation_meta', 'ti_contestant_ids');
      const newVersion = await _afterCurationWrite(operation, before, after);
      return { success: true, version: newVersion, source: 'fresh' };
    }

    return { error: makeError(ERROR_CODES.BAD_REQUEST, 'unknown operation: ' + operation) };
  } catch (e) {
    return { error: makeError(ERROR_CODES.UPSTREAM_ERROR, '写操作失败', (e && e.message) || String(e)) };
  }
}

// ===== 阶段3-②：OpenDota 新赛事轮询（2026-07-31）=====
// 调用 OpenDota /api/leagues 获取所有有比赛记录的赛事，
// 对比云数据库 curation_events，将未收录的新赛事以 status='pending_review' 入库，
// 等待人工审核。所有写入操作幂等（_id = 'opendota_' + leagueId 去重）。
//
// 设计要点：
//   1. 复用 fetchWithRetry / normalizeEventName / makeError / ERROR_CODES
//   2. 匹配逻辑：先按 leagueId 匹配（curation_events 有 leagueId 字段时），再按规范名匹配
//   3. 幂等性：_id = 'opendota_' + leagueId，重复调用不会重复插入
//   4. 错误隔离：单条插入失败不阻塞整体流程
//   5. 写 admin-logs：action='opendota_discover' 记录本次发现结果
//   6. 写 admin-logs：action='opendota_discover_alert' 作为告警源（newCount > 0 时）
//
// 返回：{ success, total, existing, new, inserted }
async function handleDiscoverOpenDotaTournaments(event) {
  const force = !!(event && event.force);
  try {
    // 步骤 1：调用 OpenDota /api/leagues 获取全量赛事
    const leagues = await fetchWithRetry('/leagues');
    if (!Array.isArray(leagues)) {
      return { error: makeError(ERROR_CODES.UPSTREAM_ERROR, 'OpenDota /leagues 返回非数组') };
    }
    const allCount = leagues.length;

    // 步骤 2：读取 curation_events 全量，构建已收录索引
    // existingByLeagueId：按 leagueId 索引（curation_events 中有 leagueId 字段的记录）
    // existingByNormName：按规范名索引（覆盖所有记录的 canonical/aliases）
    const db = cloud.database();
    const curRes = await db.collection('curation_events').limit(500).get();
    const existingDocs = (curRes && curRes.data) || [];
    const existingCount = existingDocs.length;
    const existingByLeagueId = new Set();
    const existingByNormName = new Set();
    existingDocs.forEach((doc) => {
      if (doc.leagueId != null) existingByLeagueId.add(Number(doc.leagueId));
      if (doc._id) existingByNormName.add(doc._id);
      if (doc.canonical) existingByNormName.add(normalizeEventName(doc.canonical));
    });

    // 步骤 3：对比找出未收录的新赛事
    // 匹配优先级：先 leagueId（精确），再规范名（模糊，避免重复入库）
    const newItems = [];
    const seenLeagueIds = new Set(); // 本轮去重（OpenDota 偶有重复 leagueid）
    for (const lg of leagues) {
      if (!lg || lg.leagueid == null || !lg.name) continue;
      const lid = Number(lg.leagueid);
      if (seenLeagueIds.has(lid)) continue;
      seenLeagueIds.add(lid);

      // 已收录判断：leagueId 或 规范名 命中即视为已收录
      if (existingByLeagueId.has(lid)) continue;
      const normName = normalizeEventName(lg.name);
      if (normName && existingByNormName.has(normName)) continue;

      newItems.push(lg);
    }
    const newCount = newItems.length;

    // 步骤 4：将新赛事插入 curation_events（2026-07-31 优化：并发批量写入，避免超时）
    // _id = 'opendota_' + leagueId（避免与 Liquipedia 的 _id 冲突，Liquipedia 用 normalizeEventName(canonical)）
    // 最多写入 100 条/次，每批 20 条并发，避免 DB 写入超时
    const MAX_INSERT = 100;
    const BATCH_SIZE = 20;
    const itemsToInsert = newItems.slice(0, MAX_INSERT);
    const skipped = newItems.length - itemsToInsert.length;
    if (skipped > 0) {
      console.log('[discoverOpenDotaTournaments] 新赛事 ' + newItems.length +
        ' 条超过上限 ' + MAX_INSERT + '，本次只写入前 ' + MAX_INSERT + ' 条');
    }
    let inserted = 0;
    const insertedDetails = [];
    for (let i = 0; i < itemsToInsert.length; i += BATCH_SIZE) {
      const batch = itemsToInsert.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(batch.map(async (lg) => {
        const lid = Number(lg.leagueid);
        const docId = 'opendota_' + lid;
        const yearMatch = String(lg.name).match(/\b(20\d{2})\b/);
        const year = yearMatch ? parseInt(yearMatch[1], 10) : null;
        const doc = {
          canonical: lg.name,
          aliases: [normalizeEventName(lg.name)],
          tier: { grade: 'C', rank: 0, label: 'C级' },
          year: year,
          liquipediaSlug: null,
          source: 'opendota',
          leagueId: lid,
          status: 'pending_review',
          updatedAt: Date.now()
        };
        try {
          await db.collection('curation_events').doc(docId).set({ data: doc });
          return { _id: docId, leagueId: lid, canonical: lg.name };
        } catch (e) {
          console.warn('[discoverOpenDotaTournaments] 插入失败 leagueId=' + lid +
            ' (' + lg.name + '):', (e && e.message) || e);
          return null;
        }
      }));
      results.forEach((r) => {
        if (r) {
          inserted++;
          insertedDetails.push(r);
        }
      });
    }

    // 步骤 5：写 admin-logs（action='opendota_discover'，失败静默）
    try {
      await db.collection('admin-logs').add({
        data: {
          action: 'opendota_discover',
          operator: 'aggregation',
          count: newCount,
          details: insertedDetails,
          summary: {
            total: allCount,
            existing: existingCount,
            new: newCount,
            inserted: inserted,
            skipped: skipped
          },
          timestamp: Date.now()
        }
      });
    } catch (e) {
      console.warn('[discoverOpenDotaTournaments] 写 admin-logs (opendota_discover) 失败（静默）:',
        (e && e.message) || e);
    }

    // 步骤 6：发现新赛事时写告警记录（action='opendota_discover_alert'，作为管理后台告警源）
    // 仅在 newCount > 0 时写入，避免无新赛事时产生噪声告警
    if (newCount > 0) {
      try {
        await db.collection('admin-logs').add({
          data: {
            action: 'opendota_discover_alert',
            operator: 'aggregation',
            alertType: 'new_tournaments',
            count: newCount,
            details: insertedDetails,
            message: 'OpenDota 发现 ' + newCount + ' 个新赛事待审核' +
              (skipped > 0 ? '（' + skipped + ' 条留到下次）' : ''),
            timestamp: Date.now(),
            resolved: false // 管理后台审核后可标记为 true
          }
        });
      } catch (e) {
        console.warn('[discoverOpenDotaTournaments] 写 admin-logs (opendota_discover_alert) 失败（静默）:',
          (e && e.message) || e);
      }
    }

    // 步骤 7：清空 curation L1 缓存（新增记录后下次读取需重新从 DB 加载）
    _curationL1Cache = null;
    _curationL1Version = null;
    try { l1Cache.delete(_v() + CURATION_L1_KEY); } catch (e) {}

    return {
      success: true,
      total: allCount,
      existing: existingCount,
      new: newCount,
      inserted: inserted,
      skipped: skipped,
      source: 'fresh'
    };
  } catch (e) {
    return { error: makeError(ERROR_CODES.UPSTREAM_ERROR, 'OpenDota 赛事发现失败', (e && e.message) || String(e)) };
  }
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
  // ★ 2026-08-07（审核 R4）：订阅授权检查（R3 上云的 profile.subs）
  //   - 老用户兼容：profile 无 subs 字段 → 保持现状推送（不突然断推）；有 subs 才检查
  //   - 对应模板未授权（subscribed !== true）→ 整轮跳过该用户
  const subs = profile.subs;
  if (subs && subs[String(templateId)] && subs[String(templateId)].subscribed !== true) {
    return { ok: true, sent: 0, skipped: profile.teams.length, failed: 0, reason: 'sub_not_authorized' };
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
      const code = (r.errCode || r.errcode || 0);
      if (code === 0) { sent++; continue; }
      // ★ 2026-08-07（审核 R4）：43101「订阅数不足」= 一次性订阅额度耗尽 → 跳过剩余队伍（防失败刷屏）
      if (code === 43101) {
        const idx = profile.teams.indexOf(tid);
        skipped += (profile.teams.length - idx - 1);
        break;
      }
      failed++;
    } catch (e) { failed++; }
  }
  return { ok: true, sent: sent, skipped: skipped, failed: failed };
}

// ===== B2 核心：Action → Handler 路由表（O(1) 查找，替代 if-else 链）=====
const HANDLERS = new Map([
  // 数据源健康检查（2026-08-11 长期架构改进落地）
  ['health', handleHealth],
  // STRATZ / Steam 代理
  ['stratzGql', handleStratzGql],
  ['steamProxy', handleSteamProxy],
  // Steam 联赛 LIVE + UPCOMING 对阵（2026-08-21，LIVE/UPCOMING 主源）
  ['steamLeagueScheduled', (e) => steamLeagueScheduledMatches(e.params, e.force)],
  // Liquipedia
  ['getLiquipediaUpcoming', handleGetLiquipediaUpcoming],
  ['liquipediaLeagueMeta', (e) => liquipediaLeagueMeta(e.params, e.force)],
  ['liquipediaScheduledMatches', (e) => liquipediaScheduledMatches(e.params, e.force)],
  ['liquipediaTeamLogo', (e) => liquipediaTeamLogo(e.params, e.force)],
  ['liquipediaListTournaments', (e) => liquipediaListTournaments(e.params, e.force)],
  ['liquipediaFetchRawWikitext', (e) => liquipediaFetchRawWikitext(e.params, e.force)],
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
  // 阶段1-②：云端 curation 读取
  ['getCuration', handleGetCuration],
  // 阶段2-③：云端 curation 写操作中转（admin 端）
  ['adminWriteCuration', handleAdminWriteCuration],
  // 阶段3-②：OpenDota 新赛事轮询（发现未收录赛事并入库待审核）
  ['discoverOpenDotaTournaments', handleDiscoverOpenDotaTournaments],
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
  // ★ 2026-08-13（首页推荐位跳转优化 · 方案3）：预热多页面赛事（如 TI 2026）的对阵赛程缓存。
  //   SCHEDULED_MATCHES_SLUG_OVERRIDE 收录「主页 wikitext 不含 {{Match}}、对阵在子页面」的赛事，
  //   用户从首页推荐位点击时若缓存冷（云函数现抓 LP 2-4s），跳转明显卡顿。
  //   定时预热让详情页秒开。参与退避（复用 preheatShouldRun/preheatMarkResult）。
  if (preheatShouldRun('preheatScheduledMatches')) {
    const preheatTargets = Object.keys(SCHEDULED_MATCHES_SLUG_OVERRIDE);
    let preheatOk = true;
    for (const name of preheatTargets) {
      try {
        const r = await liquipediaScheduledMatches({ name: name });
        preheatOk = preheatOk && !!(r && r.data);
        // 2.2s 限流：抓取多个子页面时留间隔（避免 Liquipedia 429）
        await new Promise((res) => setTimeout(res, 2300));
      } catch (e) {
        preheatOk = false;
      }
    }
    preheatMarkResult('preheatScheduledMatches', preheatOk);
    results.push({ preheatScheduledMatches: { ok: preheatOk, count: preheatTargets.length } });
  } else {
    results.push({ preheatScheduledMatches: { ok: false, skipped: 'backoff' } });
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
  // O-26（2026-08-15）：危险 action 鉴权守卫。
  // 背景：小程序包可解包提取云函数名（函数名不是秘密），拿到名称即可直接调用，
  // 无鉴权则任何客户端可篡改 curation / 读写任意共享缓存 / 冒充发送订阅消息。
  // 纯管理员 action（客户端从不直接调用）须命中 ADMIN_OPENIDS 白名单；
  // 半开放 action（getCached/setCached 被 subscribe.js 正常用于 follow_profile_* 画像）
  // 降级为 key 前缀白名单校验，防写入伪造 /leagues 数据污染全体共享缓存。
  const ADMIN_ACTIONS = new Set([
    'adminWriteCuration', 'sendSmartReminders',
    'buildSearchIndex', 'buildTeamsIndex',
    'discoverOpenDotaTournaments', 'refreshTeams'
  ]);
  const PUBLIC_CACHE_PREFIXES = ['follow_profile_'];  // getCached/setCached 允许的 key 前缀
  if (ADMIN_ACTIONS.has(action)) {
    const wxCtx = cloud.getWXContext();
    const adminList = (process.env.ADMIN_OPENIDS || '')
      .split(',').map(s => s.trim()).filter(Boolean);
    if (!adminList.length || !adminList.includes(wxCtx.OPENID)) {
      const r = { error: makeError(ERROR_CODES.FORBIDDEN, 'unauthorized') };
      __logEnd(r);
      return r;
    }
  } else if (action === 'getCached' || action === 'setCached') {
    const ck = (params && params.key) || '';
    if (!PUBLIC_CACHE_PREFIXES.some(pf => ck.startsWith(pf))) {
      const r = { error: makeError(ERROR_CODES.FORBIDDEN, 'key prefix not allowed') };
      __logEnd(r);
      return r;
    }
  }
  const handler = HANDLERS.get(action);
  if (handler) {
    // ★ 2026-08-21 DIAG：steamLeagueScheduled 路由入口打印一行，覆盖所有早退分支
    //   （leagueId 缺失 / STEAM_KEY 未配置 / 缓存命中 / 真请求 / 异常）
    //   便于排查「日志看不到 [SteamLive]」是否因为请求根本没到 handler。
    if (action === 'steamLeagueScheduled') {
      console.log('[SteamRoute] ENTER action=steamLeagueScheduled leagueId=' +
        ((params && (params.leagueId || params.id)) || 'null') +
        ' force=' + (!!force) +
        ' STEAM_KEY=' + (STEAM_KEY ? 'SET(' + STEAM_KEY.length + 'chars)' : 'EMPTY'));
    }
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
  } else {
    // P3-1（2026-08-05）：force 统一节流 —— 30s 内已 force 现抓过 → 返回最近缓存（若有）；
    // 与 liquipediaScheduledMatches 的 FORCE_MIN_GAP_MS 语义一致（尽力而为，多实例下效果减弱）
    const _now = Date.now();
    const _last = _odLastForce[cacheKey] || 0;
    if (_now - _last < FORCE_MIN_GAP_MS) {
      const cached = await getCache(cacheKey);
      if (cached) {
        const r = { data: cached, source: 'cache-recent' };
        __logEnd(r);
        return r;
      }
    }
    _odLastForce[cacheKey] = _now;
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
