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
const LP_UA = 'DOTA2-Esports-Hub/1.0 (WeChat Mini Program; contact: dev@local)';
const RATE_LIMIT_MS = 2200;
const TTL_SEC = 26 * 3600;

const slugmap = require('./../cloudfunctions/aggregation/liquipedia-slugmap.json');

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

function upsertCache(key, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      key, payload,
      expire_at: new Date(Date.now() + TTL_SEC * 1000).toISOString(),
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

(async () => {
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
  if (fail > slugs.length * 0.5) {
    console.error('失败率超 50%——查看上方 ✗ 行的具体错误（403/429=被限流，需加长退避）');
    process.exit(2);
  }
})();
