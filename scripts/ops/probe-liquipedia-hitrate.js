#!/usr/bin/env node
/**
 * 本地 Liquipedia 命中率探针（诊断用，非小程序运行时）
 * 完全复刻云端 fetchLiquipediaWikitext + parseLeagueMetadata 逻辑：
 *   1. 从 OpenDota /proLeagues 拉近半年 + 未来 notable 联赛
 *   2. 逐条用同款 UA 打 Liquipedia MediaWiki API 取 wikitext
 *   3. 用 utils/liquipedia-parse.js 的 parseLeagueMetadata 解析
 *   4. 统计命中率 / slug 缺失 / 解析为空 / TBD 日期
 * 不受微信域名白名单限制（Liquipedia 是公开 API），可在本地直接跑。
 *
 * 用法：
 *   node scripts/probe-liquipedia-hitrate.js            # 默认近半年+未来，限 40 条
 *   node scripts/probe-liquipedia-hitrate.js --limit 80  # 指定数量
 *   node scripts/probe-liquipedia-hitrate.js --all       # 全部候选
 */
const Parse = require('../../utils/liquipedia-parse.js');

// slug 映射表（由 generate-liquipedia-slugmap.js 生成，sync:slugmap 镜像云端）。
// 关键：本探针现在走 slug 映射，复刻云端 liquipediaSlugFor 的真实行为，
// 才能测出 slugmap 把直查 2.5% 拉到 ~60% 的实际命中率；否则只复现 2.5% 基线。
const slugMap = (() => {
  try { return require('../../utils/liquipedia-slugmap.json').mappings || {}; }
  catch (e) { return {}; }
})();

const UA = 'DOTA2-Esports-Hub/1.0 (WeChat Mini Program; contact: dev@local)';
const LIQUIPEDIA_BASE = 'https://liquipedia.net/dota2/api.php';
// 与云端 KNOWN_KEYWORDS 对齐（\btour\b 词边界，避免误中 TOURNAMENT）
const KNOWN_KEYWORDS = /(international|major|esl\s+one|esl\s+pro|dreamleague|blast|riyadh|pgl|betboom|clavision|fissure|the\s+summit|games\s+of\s+the\s+future|heroic|resurrection|weplay|moonstorm|dpc|\btour\b|division\s+i)/i;
// 子赛事噪声：Liquipedia 通常把这些合并到主赛事页，不设独立 slug → 查了也是 miss
const SUBEVENT_NOISE = /(qualifier|1v1|regional|lower division|upper division|group stage|playoffs?|closed qual|open qual|minor)/i;
const OPENDOTA_LEAGUES = 'https://api.opendota.com/api/leagues';
const RATE_LIMIT_MS = 2000; // Liquipedia MediaWiki 2s 限流

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

async function fetchWikitext(pageName) {
  if (!pageName) return null;
  try {
    const url = new URL(LIQUIPEDIA_BASE);
    url.search = new URLSearchParams({
      action: 'query', prop: 'revisions', rvprop: 'content',
      rvslots: 'main', titles: pageName, format: 'json', formatversion: '2',
    }).toString();
    const res = await fetchWithRetry(url.toString(), {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
    }, 3);
    const body = await res.json();
    if (!body || !body.query || !body.query.pages) return null;
    let pages = body.query.pages;
    if (!Array.isArray(pages)) {
      const arr = [];
      for (const k in pages) { if (Object.prototype.hasOwnProperty.call(pages, k)) arr.push(pages[k]); }
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

function inWindow(l, nowMs) {
  // /api/leagues 不返回日期字段，无法做近半年硬过滤。
  // 无日期时视为"纳入"（作为整体覆盖率探针）；有日期时才做窗口判断。
  const sd = l.startDate ? Date.parse(l.startDate) : NaN;
  const ed = l.endDate ? Date.parse(l.endDate) : NaN;
  if (isNaN(sd) && isNaN(ed)) return true;
  const halfYearAgo = nowMs - 182 * 864e5;
  const futureCut = nowMs + 180 * 864e5; // 未来半年
  const lo = isNaN(sd) ? ed : sd;
  const hi = isNaN(ed) ? sd : ed;
  return hi >= halfYearAgo && lo <= futureCut;
}

async function main() {
  const args = process.argv.slice(2);
  const all = args.includes('--all');
  const includeSubevents = args.includes('--include-subevents');
  let limit = 40;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit') { limit = parseInt(args[i + 1], 10); }
    else if (args[i].startsWith('--limit=')) { limit = parseInt(args[i].split('=')[1], 10); }
  }
  if (!Number.isFinite(limit) || limit <= 0) limit = 40;

  console.log('[probe] 拉取 OpenDota /leagues ...');
  const leagues = await fetchOpendotaLeagues();
  const now = Date.now();
  const seen = {};
  let candidates = [];
  (leagues || []).forEach((l) => {
    const nm = (l && l.name) || '';
    if (!nm || seen[nm]) return;
    if (!KNOWN_KEYWORDS.test(nm)) return;
    if (!includeSubevents && SUBEVENT_NOISE.test(nm)) return; // 默认跳过子赛事
    if (!inWindow(l, now)) return;
    seen[nm] = true;
    candidates.push(l);
  });
  candidates.sort((a, b) => Date.parse(b.startDate || 0) - Date.parse(a.startDate || 0));
  if (!all) candidates = candidates.slice(0, limit);

  if (process.argv.includes('--enum-only')) {
    console.log('[enum-only] OpenDota 联赛总数:', (leagues || []).length);
    console.log('[enum-only] 候选(前12):', candidates.slice(0, 12).map((c) => c.name));
    console.log('[enum-only] 全部联赛名样例(前15):', (leagues || []).slice(0, 15).map((l) => l.name));
    process.exit(0);
  }

  console.log(`[probe] 候选联赛 ${candidates.length} 个（notable，走 slug 映射；OpenDota /leagues 无日期，窗口不对枚举生效）`);
  console.log('[probe] 开始逐条打 Liquipedia（2s 限流）...\n');

  let total = 0, ok = 0, slugMissing = 0, parseEmpty = 0;
  const details = [];
  for (const l of candidates) {
    total++;
    const slug = slugMap[l.name] || l.name; // 走 slug 映射（复刻云端 liquipediaSlugFor）
    const wt = await fetchWikitext(slug);
    if (!wt) {
      slugMissing++;
      details.push({ name: l.name, slug, status: 'slug_missing', startDate: l.startDate || null });
      await sleep(RATE_LIMIT_MS);
      continue;
    }
    const meta = Parse.parseLeagueMetadata(wt, l.name);
    if (!meta) {
      parseEmpty++;
      details.push({ name: l.name, status: 'parse_empty', startDate: l.startDate || null });
      await sleep(RATE_LIMIT_MS);
      continue;
    }
    ok++;
    const hasDate = !!(meta.startDate || meta.endDate);
    const hasParts = Array.isArray(meta.participants) && meta.participants.length > 0;
    const tbd = !hasDate;
    details.push({
      name: l.name, status: 'ok',
      canonical: meta.canonical || null,
      hasDate, hasParts,
      parts: hasParts ? meta.participants.length : 0,
      tbdDate: tbd,
      prize: meta.prizePool || null,
      startDate: l.startDate || null,
    });
    await sleep(RATE_LIMIT_MS);
  }

  console.log('\n========== 命中率汇总 ==========');
  console.log(`候选总数      : ${total}`);
  console.log(`✅ 成功解析    : ${ok}  (${total ? ((ok / total) * 100).toFixed(1) : 0}%)`);
  console.log(`❌ slug 缺失   : ${slugMissing}`);
  console.log(`⚠️  解析为空    : ${parseEmpty}`);
  const okDetails = details.filter((d) => d.status === 'ok');
  console.log(`  └ 含日期      : ${okDetails.filter((d) => d.hasDate).length}`);
  console.log(`  └ 含参赛队    : ${okDetails.filter((d) => d.hasParts).length}`);
  console.log(`  └ TBD日期     : ${okDetails.filter((d) => d.tbdDate).length}`);

  console.log('\n========== 明细（ok / 关键失败）==========');
  details.forEach((d) => {
    if (d.status === 'ok') {
      const flags = [d.hasDate ? '日期✓' : '日期✗(TBD)', d.hasParts ? `队${d.parts}✓` : '队✗', d.prize ? '奖金✓' : '奖金✗'].join(' ');
      console.log(`  OK  ${d.name}  →  ${d.canonical || d.name}  [${flags}]`);
    } else {
      console.log(`  ${d.status === 'slug_missing' ? 'MISS' : 'EMPTY'}  ${d.name}  (slug=${d.slug}${d.slug !== d.name ? ' [mapped]' : ' [raw]'})`);
    }
  });

  process.exit(0);
}

main().catch((e) => { console.error('[probe] FATAL', e); process.exit(1); });
