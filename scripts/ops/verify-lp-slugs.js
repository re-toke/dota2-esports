#!/usr/bin/env node
/**
 * LP slug 存在性核验工具（运维/诊断用，**不入 CI** —— 依赖外网 + 2s 限流）
 *
 * 背景（2026-09-25 真实事故）：
 *   curation 里 3 条预选赛的 `liquipediaSlug` 在 Liquipedia 上**根本不存在**
 *   （`BLAST/Slam/9/China`、`RES_Unchained/6/BLAST_SLAM_IX/Europe|Southeast_Asia`）。
 *   此前只验证过「`curatedEventFor` 能返回 slug」⇒ **5/5 命中**的假绿灯，
 *   却从未验证「该 slug 指向的页面真实存在」⇒ 详情页/赛程静默取不到任何数据。
 *   → 本工具补上这一环：**slug 存在性 + {{Match}} 数量**。
 *
 * 用法：
 *   node scripts/ops/verify-lp-slugs.js --curation       # 核验 curation 全部 slug（推荐定期跑）
 *   node scripts/ops/verify-lp-slugs.js --slug "BLAST/SLAM/9/China"
 *   node scripts/ops/verify-lp-slugs.js --slugs "A,B,C"  # 逗号分隔批量
 *   node scripts/ops/verify-lp-slugs.js --find "The International 2026" [--limit 60]   # 查真身（allpages + search）
 *   node scripts/ops/verify-lp-slugs.js --curation --json
 *
 * 退出码：0 = 全部存在；1 = 有 missing（可直接当门禁用）
 *
 * 关键事实（2026-09-25 实测定案）：
 *   · MediaWiki 标题**只有首字母大小写不敏感**；`BLAST/SLAM/7/China` ✅ 但 `BLAST/slam/7/china` ❌。
 *   · 部分页面有手建 redirect（`BLAST/Slam/7/China` → `BLAST/SLAM/7/China` ✅），
 *     但**同系列不同届次不一定有**（`BLAST/Slam/9/China` ❌ 无 redirect）
 *     ⇒ **必须写真实大小写，不能指望 redirect 兜底**。
 *   · 请求必须同时带「描述性 User-Agent + Accept-Encoding: gzip」（缺 gzip → HTTP 406）。
 */
const https = require('https');
const zlib = require('zlib');

const LP_UA = 'DOTA2-Esports-Hub/1.0 (WeChat Mini Program; contact: dev@local)';
const API = 'https://liquipedia.net/dota2/api.php';
const RATE_LIMIT_MS = 2200;

function get(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { 'User-Agent': LP_UA, 'Accept': 'application/json', 'Accept-Encoding': 'gzip' } }, (r) => {
      const c = [];
      const s = r.headers['content-encoding'] === 'gzip' ? r.pipe(zlib.createGunzip()) : r;
      s.on('data', (x) => c.push(x));
      s.on('end', () => resolve({ status: r.statusCode, raw: Buffer.concat(c).toString('utf8') }));
    });
    req.on('error', (e) => resolve({ status: 0, raw: 'ERR ' + e.code }));
    req.setTimeout(25000, () => { req.destroy(); resolve({ status: 0, raw: 'TIMEOUT' }); });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 单次请求同时取「是否存在」+ wikitext（省一半请求，限流下很重要）
async function probe(slug) {
  const u = API + '?action=query&prop=revisions&rvprop=content&rvslots=main&titles=' +
    encodeURIComponent(slug) + '&redirects=1&format=json&formatversion=2';
  const r = await get(u);
  if (r.status !== 200) return { slug, ok: false, why: 'HTTP ' + r.status + (r.status === 406 ? '（缺 gzip/UA？）' : '') };
  let j; try { j = JSON.parse(r.raw); } catch (e) { return { slug, ok: false, why: 'non-JSON: ' + r.raw.slice(0, 100) }; }
  const p = ((j.query && j.query.pages) || [])[0];
  if (!p) return { slug, ok: false, why: 'no pages' };
  if (p.missing) return { slug, ok: false, why: 'missing' };
  const red = ((j.query.redirects) || [])[0];
  const rev = (p.revisions || [])[0] || {};
  const wt = (rev.slots && rev.slots.main && rev.slots.main.content) || rev.content || '';
  return {
    slug, ok: true, title: p.title,
    redirect: red ? red.to : null,
    matchCount: (wt.match(/\{\{\s*Match\b/gi) || []).length,
    bytes: wt.length,
  };
}

async function allpages(prefix, limit) {
  const u = API + '?action=query&list=allpages&apprefix=' + encodeURIComponent(prefix) +
    '&aplimit=' + (limit || 30) + '&apnamespace=0&format=json&formatversion=2';
  const r = await get(u);
  let j = null; try { j = JSON.parse(r.raw); } catch (e) { return []; }
  return ((j.query && j.query.allpages) || []).map((p) => p.title);
}

async function searchTitles(q, limit) {
  const u = API + '?action=query&list=search&srsearch=' + encodeURIComponent(q) +
    '&srlimit=' + (limit || 8) + '&format=json&formatversion=2';
  const r = await get(u);
  let j = null; try { j = JSON.parse(r.raw); } catch (e) { return []; }
  return ((j.query && j.query.search) || []).map((s) => s.title);
}

// --find：查真身。**优先 allpages（拿全子页面清单），search 仅作线索**（search 会混进队名/选手名）
async function find(term, limit) {
  console.log(`[find] "${term}" —— allpages 前缀清单（limit ${limit}）：`);
  const pages = await allpages(term, limit);
  pages.forEach((t) => console.log('   · ' + t));
  if (!pages.length) console.log('   (空)');
  if (pages.length >= limit) console.log('   ⚠️ 已达 limit 上限，可能有更多页 —— 调大 --limit 再看');
  await sleep(RATE_LIMIT_MS);
  console.log(`[find] "${term}" —— search 线索（含噪）：`);
  const hits = await searchTitles(term, 8);
  hits.forEach((t) => console.log('   · ' + t));
  if (!hits.length) console.log('   (空)');
}

function collectCurationSlugs() {
  const cura = require('../../utils/curation.js');
  const out = [];
  (cura.CURATED_EVENTS || []).forEach((e) => {
    const seen = {};
    ['liquipediaSlug', 'scheduledMatchesSlug', 'structureSlug'].forEach((f) => {
      const v = e[f];
      if (!v || seen[v]) return;
      seen[v] = true;
      out.push({ slug: v, field: f, canonical: e.canonical || '(no canonical)' });
    });
  });
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const findIdx = args.indexOf('--find');
  if (findIdx >= 0 && args[findIdx + 1]) {
    const li = args.indexOf('--limit');
    const lim = (li >= 0 && args[li + 1]) ? parseInt(args[li + 1], 10) : 30;
    await find(args[findIdx + 1], (Number.isFinite(lim) && lim > 0) ? lim : 30);
    process.exit(0);
  }
  let items = [];
  if (args.includes('--curation')) {
    items = collectCurationSlugs();
  } else {
    const one = args.indexOf('--slug');
    const many = args.findIndex((a) => a === '--slugs');
    if (one >= 0 && args[one + 1]) items = [{ slug: args[one + 1], field: '-', canonical: '-' }];
    else if (many >= 0 && args[many + 1]) items = args[many + 1].split(',').map((s) => ({ slug: s.trim(), field: '-', canonical: '-' })).filter((x) => x.slug);
  }
  if (!items.length) {
    console.error('用法：node scripts/ops/verify-lp-slugs.js --curation | --slug "X" | --slugs "A,B"  [--json]');
    process.exit(2);
  }

  console.log(`[verify-lp-slugs] 待核验 ${items.length} 个 slug（${RATE_LIMIT_MS}ms 限流，预计 ${Math.ceil(items.length * RATE_LIMIT_MS / 1000)}s）\n`);
  const results = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const r = await probe(it.slug);
    r.field = it.field;
    r.canonical = it.canonical;
    results.push(r);
    const tag = r.ok ? '✅' : '❌';
    const extra = r.ok
      ? `「${r.title}」${r.redirect ? ' (redirect→' + r.redirect + ')' : ''} {{Match}}=${r.matchCount} ${r.bytes}B`
      : `[${r.why}]`;
    console.log(`${String(i + 1).padStart(2)}. ${tag} ${it.slug}\n      ${it.canonical} · ${it.field}\n      ${extra}`);
    if (i < items.length - 1) await sleep(RATE_LIMIT_MS);
  }

  const bad = results.filter((r) => !r.ok);
  const empty = results.filter((r) => r.ok && r.matchCount === 0);
  console.log('\n========== 汇总 ==========');
  console.log(`总数 ${results.length} | 存在 ${results.length - bad.length} | **不存在 ${bad.length}** | 存在但 0 场 ${empty.length}`);
  if (bad.length) {
    console.log('\n❌ 不存在（必须修 —— 这些 slug 的数据链路是断的）：');
    bad.forEach((r) => console.log(`   · ${r.slug}   （${r.canonical} · ${r.field}）`));
  }
  if (empty.length) {
    console.log('\n⚠️ 页面存在但无 {{Match}}（可能是主页，对阵在子页面；或确实无赛程）：');
    empty.forEach((r) => console.log(`   · ${r.slug}   （${r.canonical} · ${r.field}）`));
  }
  if (asJson) console.log('\nJSON:\n' + JSON.stringify(results, null, 2));
  process.exit(bad.length ? 1 : 0);
}

main().catch((e) => { console.error('[verify-lp-slugs] FATAL', e); process.exit(1); });
