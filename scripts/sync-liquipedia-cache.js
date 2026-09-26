#!/usr/bin/env node
// ============================================================
// scripts/sync-liquipedia-cache.js
// GitHub Actions 定时任务：抓取 Liquipedia wikitext → 写入 Supabase 缓存表
//
// 用途：绕开「Supabase 出口被 LP Cloudflare 拦」——GitHub Actions 出口（海外，
//       IP 信誉好）抓取，结果落库，客户端/EF 直接查表，运行时零 LP 依赖。
//
// 环境变量（GitHub Secrets）：
//   SUPABASE_URL        https://gkticzdaicpdtxheyxsd.supabase.co
//   SUPABASE_SERVICE_KEY  service_role key（Dashboard → Settings → API）
//
// 数据范围：slugmap 主 slug ∪ curation 的 scheduledMatchesSlug/structureSlug/liquipediaSlug
//           （2026-09-11 扩展：原仅主 slug，导致**赛程对阵页不在表内** → 赛程无法命中 EF）
// 写入表：  aggregation_cache（key=lp:w:<slug>, TTL 26h——比 24h 陈旧阈值略长）
//
// 本地测试：SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node scripts/sync-liquipedia-cache.js
// 查看范围：node scripts/sync-liquipedia-cache.js --list（不发请求，无需凭证）
// ============================================================
const https = require('https');
const zlib = require('zlib');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const LP_BASE = 'https://liquipedia.net/dota2/api.php';
const LP_UA = require('../utils/lp-ua.js').LP_UA;   // ★ 单点：utils/lp-ua.js（LP ToS 要求标识项目 + 联系方式）
const RATE_LIMIT_MS = 2200;
const TTL_SEC = 26 * 3600;

const slugmap = require('./../utils/liquipedia-slugmap.json');

// ★★ 2026-09-11（关键修复）：抓取范围扩展 —— 原有范围**无法让赛程命中**。
//
// 问题（实测确认）：
//   · 原范围 = slugmap 的 178 条**赛事主页面** slug（如 `EPL/Masters/2`）；
//   · 但 `getScheduledMatches` 用的 slug 来自 curation 的 `scheduledMatchesSlug`
//     （如 `The_International/2026/Group_Stage`）—— **对阵在子页面**；
//   · 且主页面本就不含 `{{Match}}` 模板（实测本地解析主页面 → 0 场）。
//   → 表里没有对阵页 ⇒ 赛程**永远不可能**从 EF 命中（无论客户端怎么调优先级）。
//
// 修复：并入 curation 的 `scheduledMatchesSlug` / `structureSlug` / `liquipediaSlug`。
//   前者是对阵页（含 {{Match}}），中者是小组积分/淘汰赛结构页（{{GroupTableLeague}}/{{Bracket}}），
//   后者补齐 slugmap 未覆盖的历史赛事主页。
//   `utils/curation.js` 零 wx 依赖 → 可在 Node/GH Actions 直接 require。
const curation = require('./../utils/curation.js');
// ★ 2026-09-25（云开发退役）：本脚本原 require cloudfunctions/ 下三份文件 —— 该目录已删除，
//   现全部改为 utils/ 侧（index-builders.js 已从退役备份 .cloudfunctions-backup-20260922 恢复到 utils/）
//   ⚠️ 此前该脚本因此**启动即崩**（CI：Sync Liquipedia Cache / Failed in 8 seconds）✗
//   该模块必须放在云函数目录内（微信云函数只能 require 自己目录下的文件），
//   同步脚本反向 require 进去 —— 与 liquipedia-slugmap.json 同一套路。
const BUILDERS = require('./../utils/index-builders.js');
// ★ 2026-09-12：队标解析器（与云函数共用同一份 liquipedia-parse，避免双源漂移）
const LIQUI_PARSE = require('./../utils/liquipedia-parse.js');

const baseSlugs = Object.values(slugmap.mappings || {});
const curatedSlugs = [];
(curation.CURATED_EVENTS || []).forEach((ev) => {
  if (!ev) return;
  ['scheduledMatchesSlug', 'structureSlug', 'liquipediaSlug'].forEach((f) => {
    if (typeof ev[f] === 'string' && ev[f]) curatedSlugs.push(ev[f]);
  });
});

// 注意：slugmap 的值与 curation 的 slug 均为 LP 页面标题形态（下划线分隔、含 `/`），
// 与 EF 侧 `slugFor()` 的产出、以及缓存 key `lp:w:<slug>` 完全同口径 —— 不可做任何归一化改写，
// 否则 EF 会查不到（这是 v8.21「斜杠保留」修过的同一类坑）。
const slugs = Array.from(new Set(baseSlugs.concat(curatedSlugs)));

console.log('抓取范围：slugmap 主 slug', baseSlugs.length,
            '+ curation 子页面/补充 slug', curatedSlugs.length,
            '→ 去重后', slugs.length, '条');

// ★ 2026-09-11：`--list` 只打印抓取范围后退出（不发请求、不需要 Supabase 凭证）。
//   用途：核对「扩展后到底会灌哪些 slug」——尤其确认对阵子页面在列，
//   无需真的跑一遍约 8 分钟的同步。
if (process.argv.indexOf('--list') >= 0) {
  console.log('--- 明细 ---');
  slugs.forEach((x, i) => console.log(String(i + 1).padStart(4) + '. ' + x));
  process.exit(0);
}

// ※ 环境变量校验放在 --list 之后：查看抓取范围无需 Supabase 凭证
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('缺少 SUPABASE_URL / SUPABASE_SERVICE_KEY 环境变量');
  process.exit(1);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fetchJson(url, headers) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: headers || {} }, r => {
      const g = r.headers['content-encoding'] === 'gzip' ? zlib.createGunzip() : null;
      const stream = g ? r.pipe(g) : r;
      let d = '';
      stream.on('data', c => d += c);
      stream.on('end', () => {
        try { resolve({ status: r.statusCode, json: JSON.parse(d) }); }
        catch (e) { resolve({ status: r.statusCode, html: d.slice(0, 100) }); }
      });
      stream.on('error', reject);
    }).on('error', reject);
  });
}

function upsertCache(key, payload, ttlSec) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      key, payload,
      expire_at: new Date(Date.now() + (ttlSec || TTL_SEC) * 1000).toISOString(),
      updated_at: new Date().toISOString()
    });
    const u = new URL(SUPABASE_URL + '/rest/v1/aggregation_cache');
    const req = https.request({
      hostname: u.hostname, path: u.pathname, method: 'POST',
      headers: {
        'apikey': SERVICE_KEY,
        'Authorization': 'Bearer ' + SERVICE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=minimal',
        'Content-Length': Buffer.byteLength(body)
      }
    }, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => (r.statusCode >= 200 && r.statusCode < 300) ? resolve() : reject(new Error('upsert HTTP ' + r.statusCode + ': ' + d.slice(0, 100))));
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

let _last = 0;
async function lpFetch(slug) {
  const wait = _last + RATE_LIMIT_MS - Date.now();
  if (wait > 0) await sleep(wait);
  _last = Date.now();
  const url = LP_BASE + '?action=query&format=json&prop=revisions&rvprop=content&titles=' + encodeURIComponent(slug).replace(/%2F/g, '/');
  const { status, json, html } = await fetchJson(url, { 'User-Agent': LP_UA, 'Accept-Encoding': 'gzip' });
  if (status !== 200) throw new Error('LP HTTP ' + status);
  if (html !== undefined) throw new Error('LP 返回 HTML（挑战页）: ' + html);
  const pages = json && json.query && json.query.pages;
  if (!pages) throw new Error('LP 无 pages');
  const p = Object.values(pages)[0];
  return (p && p.revisions && p.revisions[0] && p.revisions[0]['*']) || null;
}

// ★★ 2026-09-11：**key 角色自检** —— service_role 与 anon 都是 JWT（eyJ 开头），肉眼难辨。
//   解开 payload 看 `role` 字段：service_role 才能写（RLS 只给了 anon 只读策略）。
function keyRole(key) {
  try {
    const part = String(key).split('.')[1];
    if (!part) return '(非 JWT)';
    const json = JSON.parse(Buffer.from(part, 'base64').toString('utf8'));
    return json.role || '(payload 无 role)';
  } catch (e) { return '(解码失败)'; }
}

// ★★ 2026-09-12：通用 KV 灌表（search_index / teams_search / teams_hot）
//
// 背景：客户端已改为「Supabase 直读优先」（utils/cloudCache.js 的 _sbKvGet），
//   但这三个 key 原先只由云函数写入**微信云开发**，Supabase 表里没有 → 直读永远 miss。
//   本函数把它们同步写入 Supabase，直读才真正生效。
//   ★ 整形逻辑复用共享模块（与云函数同一份实现），避免双源漂移。
//
// TTL 6h：与云函数原 setCache TTL 一致；每日 2 次灌表 → 始终新鲜。
async function syncIndexes() {
  console.log('');
  console.log('=== 通用 KV 灌表（search_index / teams_search / teams_hot）===');
  const OPENDOTA = 'https://api.opendota.com/api';
  const IDX_TTL = 6 * 3600;

  // ① teams_search：纯本地数据（历史 S 级战队语料），无网络依赖
  try {
    const ti = BUILDERS.buildTeamsIndex();
    await upsertCache('teams_search', ti, IDX_TTL);
    console.log('  ✅ teams_search:', ti.count, '支');
  } catch (e) { console.warn('  ✗ teams_search:', e.message); }

  // ② search_index：抓 OpenDota /leagues 后整形
  try {
    const leagues = await fetchOpenDota(OPENDOTA + '/leagues');
    const si = BUILDERS.buildSearchIndex(leagues);
    await upsertCache('search_index', si, IDX_TTL);
    console.log('  ✅ search_index:', si.count, '个联赛');
  } catch (e) { console.warn('  ✗ search_index:', e.message); }

  // ③ teams_hot：串行拉 10 支热门战队详情（1.05s 间隔，与云函数限流口径一致）
  try {
    const pairs = [];
    for (const id of BUILDERS.HOT_TEAM_IDS) {
      let team = null;
      try { team = await fetchOpenDota(OPENDOTA + '/teams/' + id); } catch (e) { /* 单队失败隔离 */ }
      pairs.push({ id: id, team: team });
      await sleep(1050);
    }
    const th = BUILDERS.buildTeamsHot(pairs);
    await upsertCache('teams_hot', th.out, IDX_TTL);
    console.log('  ✅ teams_hot:', th.ok, '成功 /', th.fail, '失败');
  } catch (e) { console.warn('  ✗ teams_hot:', e.message); }
}

/** OpenDota GET（JSON）；非 2xx 抛错，由调用方隔离 */
function fetchOpenDota(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': LP_UA, 'Accept-Encoding': 'gzip' } }, (r) => {
      const g = r.headers['content-encoding'] === 'gzip' ? zlib.createGunzip() : null;
      const stream = g ? r.pipe(g) : r;
      let d = '';
      stream.on('data', (c) => d += c);
      stream.on('end', () => {
        if (r.statusCode < 200 || r.statusCode >= 300) { reject(new Error('OpenDota HTTP ' + r.statusCode)); return; }
        try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('JSON parse fail')); }
      });
      stream.on('error', reject);
    }).on('error', reject);
  });
}

// ★★ 2026-09-12：LP 队标预抓 → 写表（为「关停云开发」铺路）
//
// 背景：队标链路是 本地缓存 → OpenDota → STRATZ → **Liquipedia 兜底**。
//   最后一跳原先只在微信云函数里能做（云端两步：抓 wikitext → parseTeamLogo →
//   imageinfo API 取缩略图 URL）。云开发一旦关停，这一跳就没了 → 少数战队显示默认图标。
//   本函数把这一跳搬到 GH Actions（出口不受 LP 拦截）预抓后写入 Supabase，
//   客户端改从表里直读，即可脱离云开发。
//
// 覆盖范围：curation 的 24 支精选战队 + 6 支历史 S 级战队（按名去重）。
//   ★ 这是「已知战队」集合 —— 真正需要 LP 兜底的正是这些老/冷门队
//   （主流队在 OpenDota/STRATZ 都有 logo，轮不到这一跳）。
//
// 成本：每队 2 次 LP 请求（wikitext + imageinfo），2.2s 间隔 → ~4.5s/队。
// TTL 30 天（与云函数原 TTL.liquipediaTeamLogo 一致）。
async function syncTeamLogos() {
  console.log('');
  console.log('=== LP 队标预抓（写 lp:logo:*）===');
  const curation = require('./../utils/curation.js');
  const LOGO_TTL = 30 * 24 * 3600;

  // 目标队名清单：curation 24 支 + 历史 S 级 6 支，按名去重
  const names = [];
  const seen = new Set();
  const push = (n) => { if (n && !seen.has(n)) { seen.add(n); names.push(n); } };
  Object.values(curation.CURATED_TEAMS || {}).forEach((t) => push(t && t.name));
  (BUILDERS.TEAMS_SEARCH_HISTORICAL || []).forEach((t) => push(t && t.name));
  console.log('  目标战队:', names.length, '支');

  let ok = 0, fail = 0;
  for (const name of names) {
    const slug = name.replace(/ /g, '_');
    try {
      // 步骤 1：抓 wikitext 解析 image 文件名
      const url1 = LP_BASE + '?action=query&format=json&prop=revisions&rvprop=content&titles=' + encodeURIComponent(slug).replace(/%2F/g, '/');
      const r1 = await fetchJson(url1, { 'User-Agent': LP_UA, 'Accept-Encoding': 'gzip' });
      if (r1.status !== 200 || !r1.json) throw new Error('wikitext HTTP ' + r1.status);
      const pages = r1.json.query && r1.json.query.pages;
      const page = pages ? Object.values(pages)[0] : null;
      const wikitext = page && page.revisions && page.revisions[0] && page.revisions[0]['*'];
      if (!wikitext) throw new Error('页面无内容');
      const parsed = LIQUI_PARSE.parseTeamLogo(wikitext);
      if (!parsed || !parsed.image) throw new Error('未解析到 image 字段');

      // 步骤 2：遵守限流后再调 imageinfo API
      await sleep(RATE_LIMIT_MS);
      const url2 = LP_BASE + '?action=query&format=json&prop=imageinfo&iiprop=url&iiurlwidth=120&titles=' + encodeURIComponent('File:' + parsed.image);
      const r2 = await fetchJson(url2, { 'User-Agent': LP_UA, 'Accept-Encoding': 'gzip' });
      if (r2.status !== 200 || !r2.json) throw new Error('imageinfo HTTP ' + r2.status);
      const pages2 = r2.json.query && r2.json.query.pages;
      const page2 = pages2 ? Object.values(pages2)[0] : null;
      const info = page2 && page2.imageinfo && page2.imageinfo[0];
      const logo = info && (info.thumburl || info.url);
      if (!logo) throw new Error('imageinfo 无 url');

      await upsertCache('lp:logo:' + slug, { logo: logo, source: 'liquipedia' }, LOGO_TTL);
      ok++;
    } catch (e) {
      fail++;
      console.warn('  ✗ ' + name + ' → ' + e.message);
    }
    await sleep(RATE_LIMIT_MS);
  }
  console.log('  队标完成:', ok, '成功 /', fail, '失败，共', names.length, '支');
}

(async () => {
  console.log('key 角色:', keyRole(SERVICE_KEY),
              keyRole(SERVICE_KEY) === 'service_role' ? '✅' : '⚠️（不是 service_role，写入必被 RLS 拒）');

  // ★★ 金丝雀预检：先写一条测试 key，**被拒就立刻退出** ——
  //   否则会像上次那样空耗 8 分钟、209 条全部失败。
  //   （aggregation_cache 开了 RLS 且只给 anon 只读策略 → anon key 写入必被 403 拒）
  console.log('金丝雀预检（lp:sync:canary，TTL 1h）...');
  try {
    await upsertCache('lp:sync:canary', { t: Date.now(), note: 'sync canary' });
    console.log('✅ 写入通过，凭证有效');
  } catch (e) {
    console.error('');
    console.error('❌ 写库预检失败：' + e.message);
    console.error('');
    console.error('诊断：');
    console.error('  · 401/403 → **用的是 anon key**。`aggregation_cache` 开了 RLS，');
    console.error('    只有一条「anon 只读」策略，**没有任何写入策略** —— 只有 service_role 能写。');
    console.error('    到 Supabase Dashboard → Settings → API → 取「service_role」那一栏（不是 anon/public）。');
    console.error('  · 400 PGRST… → 列不匹配（本脚本写 key/payload/expire_at/updated_at，与建表一致，不应发生）。');
    console.error('');
    console.error('可用下面命令核对你手里 key 的角色（把 <key> 换成粘贴内容，含引号不要带）：');
    console.error("  node -e \"console.log(JSON.parse(Buffer.from(process.argv[1].split('.')[1],'base64').toString()).role)\" <key>");
    process.exit(2);
  }

  // ★ v8.21 启动横幅：确认执行的是修复版（斜杠保留 + 退避）
  console.log('=== sync v8.22（含 curation 对阵子页面）启动 | slugs:', slugs.length, '| UA:', LP_UA.slice(0, 40) + '... ===');
  let ok = 0, fail = 0, empty = 0, consecFail = 0;
  const t0 = Date.now();
  for (const slug of slugs) {
    // ★ v8.21：连续失败退避——防高频触发 LP 限流（3 连败后歇 30s，重置计数）
    if (consecFail >= 3) {
      console.warn('⏸ 连续失败', consecFail, '次，退避 30s...');
      await sleep(30000);
      consecFail = 0;
    }
    try {
      const w = await lpFetch(slug);
      consecFail = 0;
      if (w) {
        await upsertCache('lp:w:' + slug, w);
        ok++;
      } else {
        empty++;
        console.warn('○', slug, '页面空（missing 或无 revisions）');
      }
    } catch (e) {
      fail++;
      consecFail++;
      console.warn('✗', slug, '→', e.message);
    }
  }
  console.log('同步完成:', ok, '成功 /', empty, '空页面 /', fail, '失败, 耗时', Math.round((Date.now() - t0) / 1000) + 's');
  await syncIndexes();
  await syncTeamLogos();

  if (fail > slugs.length * 0.5) {
    console.error('失败率超 50%——查看上方 ✗ 行的具体错误（403/429=被限流，需加长退避）');
    process.exit(2);
  }
})();
