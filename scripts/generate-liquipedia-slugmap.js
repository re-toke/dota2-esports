#!/usr/bin/env node
/**
 * Liquipedia slug 映射自动生成器（诊断/建表用，非小程序运行时）
 *
 * 核心思路：OpenDota 联赛名 ≠ Liquipedia 页面 slug（命名规则不一致，导致直查命中率仅 2.5%）。
 * 但 Liquipedia 有 search API，可直接按关键词返回最匹配的页面标题（即正确 slug）。
 * 本脚本：枚举 OpenDota notable 联赛 → 对每个调 Liquipedia search → 取候选标题 →
 * 逐个用 parseLeagueMetadata 验证能解析出元数据 → 第一个成功的标题记为映射。
 * 这样把"猜 slug 结构"变成"让 Liquipedia 自己告诉我正确 slug"，自动覆盖有页赛事。
 *
 * 输出：utils/liquipedia-slugmap.json
 *   { "mappings": { "<opendotaName>": "<liquipediaSlug>" }, "pending": ["<opendotaName>", ...] }
 *
 * 用法：
 *   node scripts/generate-liquipedia-slugmap.js --limit 20        # 小批量验证
 *   node scripts/generate-liquipedia-slugmap.js --all             # 全量
 *   node scripts/generate-liquipedia-slugmap.js --limit 60 --out mymap.json
 */
const fs = require('fs');
const path = require('path');
const Parse = require('../utils/liquipedia-parse.js');

const UA = 'DOTA2-Esports-Hub/1.0 (WeChat Mini Program; contact: dev@local)';
const LIQUIPEDIA_BASE = 'https://liquipedia.net/dota2/api.php';
const OPENDOTA_LEAGUES = 'https://api.opendota.com/api/leagues';
const KNOWN_KEYWORDS = /(international|major|esl\s+one|esl\s+pro|dreamleague|blast|riyadh|pgl|betboom|clavision|fissure|the\s+summit|games\s+of\s+the\s+future|heroic|resurrection|weplay|moonstorm|dpc|\btour\b|division\s+i)/i;
const SUBEVENT_NOISE = /(qualifier|1v1|regional|lower division|upper division|group stage|playoffs?|closed qual|open qual|minor)/i;
const RATE_LIMIT_MS = 2000;

// 赛事系列词（用于校验 search 返回的页面系列是否与原名一致，避免错映射）
const SERIES_PATTERNS = [
  /the international/i, /esl one/i, /esl pro/i, /dreamleague/i, /fissure/i,
  /pgl/i, /betboom/i, /blast/i, /riyadh/i, /games of the future/i, /weplay/i,
  /clavision/i, /\bdivision i\b/i, /the summit/i, /moonstorm/i, /heroic/i,
  /resurrection/i, /dpc/i, /esl/i, /major/i,
];
function seriesOf(name) {
  if (!name) return null;
  for (const p of SERIES_PATTERNS) {
    const m = name.match(p);
    if (m) return m[0].trim().toLowerCase();
  }
  return null;
}
// 子页面（qualifier/division/stage 等）不应作为主赛事映射目标
function isSubPage(slug) {
  return /qualifier|division|stage|lower|upper|\/open|\/closed/i.test(slug || '');
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function fetchWithRetry(url, opts, n) {
  let last;
  for (let i = 1; i <= (n || 3); i++) {
    try { return await fetch(url, opts); } catch (e) { last = e; if (i < (n || 3)) await sleep(1500 * i); }
  }
  throw last;
}

async function fetchOpendotaLeagues() {
  const res = await fetchWithRetry(OPENDOTA_LEAGUES, {}, 3);
  if (!res.ok) throw new Error('OpenDota /leagues HTTP ' + res.status);
  return res.json();
}

// 调 Liquipedia search API，返回候选页面标题列表
async function searchLiquipedia(query) {
  const url = new URL(LIQUIPEDIA_BASE);
  url.search = new URLSearchParams({
    action: 'query', list: 'search', srsearch: query, srlimit: '5', format: 'json', formatversion: '2',
  }).toString();
  const res = await fetchWithRetry(url.toString(), { headers: { 'User-Agent': UA, 'Accept': 'application/json' } }, 3);
  const body = await res.json();
  if (!body || !body.query || !body.query.search) return [];
  return body.query.search.map((s) => s.title).filter(Boolean);
}

// 抓 wikitext（同云端 fetchLiquipediaWikitext 逻辑）
async function fetchWikitext(pageName) {
  if (!pageName) return null;
  try {
    const url = new URL(LIQUIPEDIA_BASE);
    url.search = new URLSearchParams({
      action: 'query', prop: 'revisions', rvprop: 'content',
      rvslots: 'main', titles: pageName, format: 'json', formatversion: '2',
    }).toString();
    const res = await fetchWithRetry(url.toString(), { headers: { 'User-Agent': UA, 'Accept': 'application/json' } }, 3);
    const body = await res.json();
    if (!body || !body.query || !body.query.pages) return null;
    let pages = body.query.pages;
    if (!Array.isArray(pages)) { const arr = []; for (const k in pages) { if (Object.prototype.hasOwnProperty.call(pages, k)) arr.push(pages[k]); } pages = arr; }
    if (!pages.length) return null;
    const page = pages[0];
    if (page.missing) return null;
    if (!page.revisions || !page.revisions.length) return null;
    const rev = page.revisions[0];
    return (rev.slots && rev.slots.main && rev.slots.main.content) || rev['*'] || rev.content || null;
  } catch (e) { return null; }
}

async function resolveSlug(name) {
  const want = seriesOf(name);
  const candidates = await searchLiquipedia(name);
  for (const c of candidates) {
    if (isSubPage(c)) { await sleep(RATE_LIMIT_MS); continue; } // 子页面直接跳过
    const wt = await fetchWikitext(c);
    if (!wt) { await sleep(RATE_LIMIT_MS); continue; }
    const meta = Parse.parseLeagueMetadata(wt, name);
    if (!meta || !meta.canonical) { await sleep(RATE_LIMIT_MS); continue; }
    const got = seriesOf(meta.canonical) || seriesOf(c);
    // 系列已知且不匹配 → 拒绝（避免错映射，宁可待人工）；系列不确定 → 接受首个非子页
    if (want && got && got !== want) { await sleep(RATE_LIMIT_MS); continue; }
    await sleep(RATE_LIMIT_MS);
    return { slug: c, meta };
  }
  return null; // 系列已知但无匹配 → pending（待人工），不存入错误映射
}

async function main() {
  const args = process.argv.slice(2);
  const all = args.includes('--all');
  const includeMissed = args.includes('--include-missed');  // §6.2 优先处理 pending 列表
  const outArg = args.find((a) => a.startsWith('--out'));
  const outPath = outArg ? outArg.split('=')[1] : path.join(__dirname, '..', 'utils', 'liquipedia-slugmap.json');
  let limit = 20;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit') limit = parseInt(args[i + 1], 10);
    else if (args[i].startsWith('--limit=')) limit = parseInt(args[i].split('=')[1], 10);
  }
  if (!Number.isFinite(limit) || limit <= 0) limit = 20;

  // §6.2 优先处理未命中项：读取现有 slugmap 的 pending 列表，作为首批候选
  let pendingFromLast = [];
  if (includeMissed) {
    try {
      const existing = JSON.parse(fs.readFileSync(outPath, 'utf8'));
      if (existing && Array.isArray(existing.pending)) {
        pendingFromLast = existing.pending;
        console.log(`[slugmap] --include-missed：从上次 pending 列表加载 ${pendingFromLast.length} 个待处理项`);
      }
    } catch (e) { /* 首次运行无文件 */ }
  }

  console.log('[slugmap] 拉取 OpenDota /leagues ...');
  const leagues = await fetchOpendotaLeagues();
  const seen = {};
  let candidates = [];
  // §6.2 优先：pending 列表中的 name 直接作为候选（无需再匹配 KNOWN_KEYWORDS）
  pendingFromLast.forEach((name) => {
    if (!name || seen[name]) return;
    seen[name] = true;
    candidates.push({ name: name, leagueid: 0, tier: 'unknown' });
  });
  (leagues || []).forEach((l) => {
    const nm = (l && l.name) || '';
    if (!nm || seen[nm]) return;
    if (!KNOWN_KEYWORDS.test(nm)) return;
    if (SUBEVENT_NOISE.test(nm)) return;
    seen[nm] = true;
    candidates.push(l);
  });
  if (!all) candidates = candidates.slice(0, limit);

  console.log(`[slugmap] 候选联赛 ${candidates.length} 个，开始 search + 验证（2s 限流）...\n`);

  const mappings = {};
  const pending = [];
  let ok = 0;
  for (const l of candidates) {
    const r = await resolveSlug(l.name);
    if (r) {
      ok++;
      mappings[l.name] = r.slug;
      console.log(`  ✓ ${l.name}  →  ${r.slug}`);
    } else {
      pending.push(l.name);
      console.log(`  ? ${l.name}  (search 无可用页)`);
    }
  }

  // §6.2 合并上次已存在的映射（保留人工补的，不覆盖）
  if (includeMissed) {
    try {
      const existing = JSON.parse(fs.readFileSync(outPath, 'utf8'));
      if (existing && existing.mappings) {
        let merged = 0;
        Object.keys(existing.mappings).forEach((k) => {
          if (!mappings[k]) { mappings[k] = existing.mappings[k]; merged++; }
        });
        if (merged) console.log(`[slugmap] 保留 ${merged} 个上次已有映射`);
      }
    } catch (e) { /* 忽略 */ }
  }

  const payload = { generatedAt: new Date().toISOString(), mappings, pending };
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');

  console.log('\n========== slug 映射生成汇总 ==========');
  console.log(`候选总数 : ${candidates.length}`);
  console.log(`✅ 自动映射 : ${ok}  (${candidates.length ? ((ok / candidates.length) * 100).toFixed(1) : 0}%)`);
  console.log(`⚠️  待人工   : ${pending.length}`);
  console.log(`输出文件 : ${outPath}`);
  // §6.2 命中率提升建议
  if (pending.length > 0) {
    console.log('\n💡 提升命中率：');
    console.log('  1. 检查 pending 列表中是否有可通过人工补的（直接编辑 liquipedia-slugmap.json）');
    console.log('  2. 再次运行：node scripts/generate-liquipedia-slugmap.js --include-missed --all');
  }
  process.exit(0);
}

main().catch((e) => { console.error('[slugmap] FATAL', e); process.exit(1); });
