#!/usr/bin/env node
// ============================================================
// scripts/sync/discover-tournaments.js
// 每日赛事发现（2026-09-14 · 阶段2-④）—— 替代云函数 cron-discover-tournaments
//
// ## 为什么要迁
//   1. 云开发退场（该 cron 是云开发侧最后一个「有业务价值的定时任务」）
//   2. ★ 云函数侧 `.limit(500)` 导致对比基数被卡死：库里 2414 条，只读前 500 条，
//      剩余 1914 条被误判「未收录」→ newCount 常年 ~1900 → 每次只插前 100 条
//      **且插的都是早已存在的老赛事 → 真正的新赛事永远排不上号（发现实际失效）**。
//      实测证据：admin-logs 的 cron_discover 记录 summary.existing=500、
//      details[0]._id 是 2021 年的 DPC 赛事。
//      迁移到 Supabase 后**无 500 上限** → 该缺陷顺带修好。
//
// ## 与云函数的对应关系
//   本脚本 = runDiscover 的「拉取 → 过滤 → 对比 → 入库」段（不含 syncTiers，留待 ④b）
//   纯函数逻辑全部 require discover-core.js（与云函数同一份，避免双源漂移）
//
// ## 用法
//   node scripts/sync/discover-tournaments.js             # 预览（不写库）
//   SUPABASE_SERVICE_KEY=... node scripts/sync/discover-tournaments.js --apply
//
// ## 合规
//   LP 官方 API + 描述性 UA + gzip + redirects=1 + 每页 2.2s 间隔
// ============================================================
'use strict';

const fs = require('fs');
const https = require('https');
const zlib = require('zlib');

const CORE = require('./../../utils/discover-core.js');
const CFG = require('./../../utils/config.js');

const APPLY = process.argv.indexOf('--apply') >= 0;
const URL_SB = process.env.SUPABASE_URL || (CFG.supabase && CFG.supabase.url) || '';
const KEY = process.env.SUPABASE_SERVICE_KEY || '';

const LP_BASE = 'https://liquipedia.net/dota2/api.php';
const LP_UA = 'DOTA2-Esports-Hub/1.0 (cron; contact: dev@local)';
// ★ GH Actions 无云函数的 60s 超时约束 → 默认放宽到 10 页（5000 条），
//   云函数为超时只能 3 页；实测 1500 页里 899 条因字母序靠后而无年份被剔除。
const MAX_PAGES = Number(process.env.DISCOVER_MAX_PAGES || 10);
const RATE_MS = 2200;           // LP ≥2s 软限流
const MAX_INSERT = 500;         // 云函数曾限 100（因 60s 超时）；GH Actions 无此约束，放宽
const BATCH = 200;              // Supabase 批量写入

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- HTTP ---------- */
function fetchJson(url) {
  return new Promise((resolve) => {
    https.get(url, { headers: { 'User-Agent': LP_UA, 'Accept': 'application/json', 'Accept-Encoding': 'gzip' } }, (r) => {
      const g = r.headers['content-encoding'] === 'gzip' ? zlib.createGunzip() : null;
      const st = g ? r.pipe(g) : r;
      let d = '';
      st.on('data', (c) => d += c);
      st.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (e) {} resolve({ status: r.statusCode, json: j, raw: d.slice(0, 120) }); });
      st.on('error', () => resolve({ status: 0, json: null, raw: 'gunzip error' }));
    }).on('error', (e) => resolve({ status: 0, json: null, raw: e.message }));
  });
}

function sbReq(method, path, body, extraHeaders) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const hdr = Object.assign({
      apikey: KEY, Authorization: 'Bearer ' + KEY
    }, extraHeaders || {});
    if (payload) {
      hdr['Content-Type'] = 'application/json';
      hdr['Content-Length'] = Buffer.byteLength(payload);
    }
    const u = new URL(URL_SB + path);
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method, headers: hdr, timeout: 60000 }, (r) => {
      let d = ''; r.on('data', (x) => d += x);
      r.on('end', () => resolve({ status: r.statusCode, body: d, range: r.headers['content-range'] || '' }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
    req.on('error', (e) => resolve({ status: 0, body: e.message }));
    if (payload) req.write(payload);
    req.end();
  });
}

/* ---------- ① 现有集合（★ 无 500 上限，分页读全量）---------- */
async function loadExistingKeys() {
  if (!KEY) return null;                     // 无 service key → 走本地导出文件兜底（见下）
  const keys = new Set();
  const PAGE = 1000;
  for (let offset = 0; offset < 50000; offset += PAGE) {
    const r = await sbReq('GET', '/rest/v1/curation_events?select=canonical_key', null, { Range: offset + '-' + (offset + PAGE - 1) });
    if (r.status >= 300) { console.warn('  ⚠️ 读取现有集合失败 HTTP ' + r.status + ' ' + r.body.slice(0, 120)); return null; }
    let rows = [];
    try { rows = JSON.parse(r.body); } catch (e) {}
    rows.forEach((x) => { if (x && x.canonical_key) keys.add(x.canonical_key); });
    if (rows.length < PAGE) break;
  }
  return keys;
}

/** 无 service key 时的降级：从本地导出文件读（离线预览用） */
function loadExistingFromExport() {
  const cands = [
    'D:/Users/ZH/Downloads/database_export-VkOpCLYxmc_o.json',
    (process.env.USERPROFILE || '') + '/Downloads/database_export-VkOpCLYxmc_o.json'
  ];
  for (const f of cands) {
    try {
      const keys = new Set();
      fs.readFileSync(f, 'utf8').split('\n').forEach((line) => {
        const t = line.trim().replace(/,$/, '');
        if (!t) return;
        try { const o = JSON.parse(t); const id = String(o._id || '').replace(/"/g, ''); if (id) keys.add(id); } catch (e) {}
      });
      if (keys.size) { console.log('  （预览模式：现有集合取自本地导出文件，' + keys.size + ' 条）'); return keys; }
    } catch (e) { /* 试下一个 */ }
  }
  return null;
}

/* ---------- ② 拉 LP Category:Tournaments ---------- */
async function listLiquipediaTournaments() {
  const all = [];
  let cmcontinue = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    if (page > 0) await sleep(RATE_MS);
    let url = LP_BASE + '?action=query&list=categorymembers&cmtitle=' + encodeURIComponent('Category:Tournaments') +
      '&cmtype=page&cmlimit=500&cmdir=asc&format=json&formatversion=2';
    if (cmcontinue) url += '&cmcontinue=' + encodeURIComponent(cmcontinue);
    const r = await fetchJson(url);
    if (r.status !== 200 || !r.json || !r.json.query || !r.json.query.categorymembers) {
      console.warn('  第 ' + (page + 1) + ' 页失败: HTTP ' + r.status + ' ' + r.raw);
      break;
    }
    r.json.query.categorymembers.forEach((m) => {
      if (m && m.title && m.ns === 0) all.push({ slug: m.title, title: m.title.replace(/^Dota 2\/|Tournaments\//i, '') });
    });
    cmcontinue = (r.json.continue && r.json.continue.cmcontinue) || null;
    if (!cmcontinue) break;
  }
  return all;
}

/* ---------- ③ 写入 ---------- */
async function upsert(rows) {
  let ok = 0, fail = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const r = await sbReq('POST', '/rest/v1/curation_events?on_conflict=canonical_key', chunk,
      { Prefer: 'resolution=merge-duplicates,return=minimal' });
    if (r.status >= 200 && r.status < 300) ok += chunk.length;
    else { fail += chunk.length; console.warn('  ✗ 批次 ' + (i / BATCH + 1) + ' HTTP ' + r.status + ' ' + r.body.slice(0, 200)); }
    process.stdout.write('  写入 ' + Math.min(i + BATCH, rows.length) + '/' + rows.length + '\r');
  }
  console.log('  写入完成: ' + ok + ' 成功' + (fail ? ' / ' + fail + ' 失败' : '') + '          ');
  return fail === 0;
}

/* ---------- ④b：分级同步（迁自云函数 syncTiers）---------- */

/**
 * 抓 LP 页面 wikitext（用于解析 liquipediatier）
 * ⚠️ 必须带 redirects=1 —— 否则 #REDIRECT 页面会污染缓存且不自愈（项目踩过的坑）
 * ⚠️ 必须带 UA + gzip —— LP 官方软限流要求（客户端 wx.request 禁设 UA 才需云函数中转）
 */
async function fetchWikitext(slug) {
  const url = LP_BASE + '?action=query&format=json&prop=revisions&rvprop=content&redirects=1&titles=' + encodeURIComponent(slug);
  const r = await fetchJson(url);
  if (r.status !== 200 || !r.json) return null;
  const pages = r.json.query && r.json.query.pages;
  if (!pages) return null;
  const page = Object.keys(pages).map(function (k) { return pages[k]; })[0];
  return (page && page.revisions && page.revisions[0] && page.revisions[0]['*']) || null;
}

/**
 * 分级同步：pending_review 的赛事 → 抓 LP 分级 → 双源决策 → 写回
 *
 * 迁自云函数同名函数。差异：
 *   · MAX_SYNC 15 → 100（云函数受 60s 超时约束；GH Actions 可跑数分钟）
 *   · 数据源从云开发 DB 改为 Supabase（读 pending + PATCH 写回）
 *   · ★ PostgREST 的 PATCH 对 jsonb 列是**整体替换** → 必须发送合并后的完整 data
 */
async function syncTiers() {
  const MAX_SYNC = Number(process.env.DISCOVER_MAX_SYNC || 100);
  console.log('');
  console.log('④ 分级同步（pending_review → 抓 LP 分级 → 写回）...');

  // 读待同步：status=pending_review 且 tierSource != community
  const r = await sbReq('GET', '/rest/v1/curation_events?select=canonical_key,data' +
    '&data->>status=eq.pending_review&limit=' + MAX_SYNC,
    null, { Range: '0-' + (MAX_SYNC - 1) });
  if (r.status >= 300) { console.warn('  ⚠️ 读取待同步失败 HTTP ' + r.status + ' ' + r.body.slice(0, 160)); return null; }
  let pending = [];
  try { pending = JSON.parse(r.body); } catch (e) {}
  // community 已命中的无需再抓 LP（省请求）
  pending = pending.filter(function (x) { return x && x.data && x.data.tierSource !== 'community'; });
  console.log('  待同步: ' + pending.length + ' 条（单次上限 ' + MAX_SYNC + '）');
  if (!pending.length) return { synced: 0, upgraded: 0, failed: 0 };

  let synced = 0, upgraded = 0, failed = 0;
  for (let i = 0; i < pending.length; i++) {
    const row = pending[i];
    const key = row.canonical_key;
    const doc = row.data || {};
    const canonical = doc.canonical || '';
    const slug = doc.liquipediaSlug || canonical;
    if (!key || !canonical) continue;
    if (i > 0) await sleep(RATE_MS);          // LP ≥2s 软限流

    const wt = await fetchWikitext(slug);
    if (!wt) { failed++; console.warn('  ✗ ' + canonical + ' wikitext 抓取失败'); continue; }
    const parsed = CORE.parseLeagueTierFromWikitext(wt);
    const lpTier = parsed ? parsed.tier : null;
    const decision = CORE.decideTier(canonical, lpTier);

    const currentGrade = (doc.tier && doc.tier.grade) || 'C';
    const needs = decision.grade !== currentGrade || doc.tierSource !== decision.source || doc.status !== 'auto_tiered';
    if (!needs) continue;

    // ★ jsonb 整体替换 → 发送合并后的完整 data
    const merged = Object.assign({}, doc, {
      tier: { grade: decision.grade, rank: decision.rank, label: decision.label },
      tierSource: decision.source,
      liquipediaTier: lpTier,
      status: 'auto_tiered',
      updatedAt: Date.now()
    });
    const up = await sbReq('PATCH', '/rest/v1/curation_events?canonical_key=eq.' + encodeURIComponent(key),
      { data: merged }, { Prefer: 'return=minimal' });
    if (up.status >= 200 && up.status < 300) {
      synced++;
      if (decision.grade !== 'C' && currentGrade === 'C') { upgraded++; console.log('  ↑ ' + canonical + ': C → ' + decision.grade + '（' + decision.source + '）'); }
    } else { failed++; console.warn('  ✗ ' + canonical + ' 写回失败 HTTP ' + up.status + ' ' + up.body.slice(0, 120)); }
  }
  console.log('  分级同步完成: ' + synced + ' 更新（其中升级 ' + upgraded + '）｜失败 ' + failed);
  return { synced: synced, upgraded: upgraded, failed: failed };
}

(async () => {
  console.log('=== 每日赛事发现（阶段2-④）' + (APPLY ? ' ★ 实际写入' : ' 预览') + ' ===');
  console.log('  ' + new Date().toISOString());
  console.log('');

  // ① 现有集合
  console.log('① 读取现有 curation_events（Supabase，无 500 上限）...');
  let existing = await loadExistingKeys();
  if (!existing) {
    console.log('  （无 service key → 降级为本地导出文件）');
    existing = loadExistingFromExport();
  }
  if (!existing) { console.error('❌ 无法读取现有集合（需要 SUPABASE_SERVICE_KEY 或本地导出文件）'); process.exit(1); }
  console.log('  现有: ' + existing.size + ' 条  ' + (existing.size === 500 ? '⚠️ 仍是 500，检查是否走了旧路径' : '✅ 已突破 500 上限'));

  // ② 拉 LP
  console.log('');
  console.log('② 拉取 Liquipedia Category:Tournaments（最多 ' + MAX_PAGES + ' 页）...');
  const pages = await listLiquipediaTournaments();
  console.log('  拉取: ' + pages.length + ' 个页面');

  // ③ 过滤候选
  const candidates = [];
  let skippedNoYear = 0, skippedExcluded = 0, skippedNonDota = 0;
  pages.forEach((p) => {
    const t = CORE.cleanTitle(p.title);
    if (!CORE.isDota2Tournament(t)) { skippedNonDota++; return; }
    if (!CORE.extractYear(t)) { skippedNoYear++; return; }
    if (CORE.shouldExclude(t)) { skippedExcluded++; return; }
    candidates.push(p);
  });
  console.log('  候选: ' + candidates.length + '（剔除 非DOTA2=' + skippedNonDota + ' 无年份=' + skippedNoYear + ' 命中排除规则=' + skippedExcluded + '）');

  // ④ 对比差异（★ 这里是云函数失效的根因所在：基数不再是 500）
  const newOnes = [];
  const seen = new Set();
  candidates.forEach((p) => {
    const built = CORE.buildEventDoc(p.title, p.slug);
    if (!built) return;
    if (existing.has(built.key) || seen.has(built.key)) return;
    seen.add(built.key);
    newOnes.push({ key: built.key, doc: built.doc });
  });
  console.log('  未收录: ' + newOnes.length + ' 条');
  if (newOnes.length) {
    console.log('  样例: ' + newOnes.slice(0, 5).map((x) => x.key).join(', '));
  }

  // ⑤ 写入
  if (!APPLY) {
    console.log('');
    console.log('（预览结束。加 --apply 且设置 SUPABASE_SERVICE_KEY 才实际写入）');
    return;
  }
  if (!KEY) { console.error('❌ --apply 需要 SUPABASE_SERVICE_KEY'); process.exit(1); }
  if (KEY.length < 100 || KEY.slice(0, 3) !== 'eyJ') { console.error('❌ SUPABASE_SERVICE_KEY 形态不对（应以 eyJ 开头的长 JWT）'); process.exit(1); }

  let toInsert = newOnes;
  if (newOnes.length > MAX_INSERT) {
    toInsert = newOnes.slice(0, MAX_INSERT);
    console.log('  ⚠️ 超过单次上限 ' + MAX_INSERT + '，本次写入 ' + toInsert.length + ' 条，余 ' + (newOnes.length - toInsert.length) + ' 留到下次');
  }
  console.log('');
  console.log('③ 写入 Supabase...');
  const rows = toInsert.map((x) => ({ canonical_key: x.key, league_id: null, data: x.doc }));
  const ok = await upsert(rows);

  // ④b：发现完成后，对 pending_review 的赛事做分级同步
  let tierResult = null;
  try { tierResult = await syncTiers(); }
  catch (e) { console.warn('分级同步异常（不影响发现结果）:', e && e.message); }

  console.log('');
  console.log('=== 结果 ===');
  console.log('  现有基线: ' + existing.size + ' 条');
  console.log('  LP 候选 : ' + candidates.length + ' 条');
  console.log('  新发现  : ' + newOnes.length + ' 条 ｜ 本次写入 ' + rows.length + ' 条');
  if (tierResult) console.log('  分级同步: ' + tierResult.synced + ' 更新 / ' + tierResult.upgraded + ' 升级 / ' + tierResult.failed + ' 失败');
  console.log('  ' + (ok ? '✅ 完成' : '⚠️ 有批次失败，见上'));
  process.exit(ok ? 0 : 1);
})();
