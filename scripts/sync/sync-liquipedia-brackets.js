#!/usr/bin/env node
// ============================================================
// scripts/sync/sync-liquipedia-brackets.js  （P3.0，2026-10-26）
//
// 背景（实证）：{{Bracket}} 的槽位在 wikitext 里基本全空（EWC 15/16、PGL 14/14、TI 13/14），
// 真实对局内容在 `Match:ID_<bracketId>_R##-M###` 页（{{MatchPage}}，含双方/日期/ApiMap matchid）。
//
// 流程：
//   1) 对每个 curation 赛事，按候选顺序找第一个含 {{Bracket}} 的页面
//      （bracketSlug > structureSlug > scheduledMatchesSlug > <base>/Main Event > <base>/Playoffs > base）
//   2) parseBrackets → 结构骨架（slots / side / round / label）
//   3) 由槽位生成 Match 页标题，批量查询（≤40/次）补内容
//   4) 写 aggregation_cache：key = lp:br:<bracketId>，TTL 26h
//
// 客户端只读缓存（utils/liquipedia.getLeagueBracket），运行时零 LP 抓取。
//
// 用法：
//   node scripts/sync/sync-liquipedia-brackets.js --list      # 只看候选，不发请求
//   node scripts/sync/sync-liquipedia-brackets.js --dry       # 抓取并打印，不写库
//   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node scripts/sync/sync-liquipedia-brackets.js
// ============================================================
const https = require('https');
const zlib = require('zlib');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const LP_BASE = 'https://liquipedia.net/dota2/api.php';
const LP_UA = require('../../utils/lp-ua.js').LP_UA;
const RATE_LIMIT_MS = 2200;
const TTL_SEC = 26 * 3600;
const BATCH = 40;

const curation = require('../../utils/curation.js');
const LP = require('../../utils/liquipedia-parse.js');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

let _last = 0;
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const wait = Math.max(0, _last + RATE_LIMIT_MS - Date.now());
    setTimeout(() => {
      _last = Date.now();
      https.get(url, { headers: { 'User-Agent': LP_UA, 'Accept-Encoding': 'gzip' } }, (r) => {
        const g = r.headers['content-encoding'] === 'gzip' ? zlib.createGunzip() : null;
        const s = g ? r.pipe(g) : r;
        let d = '';
        s.on('data', (c) => { d += c; });
        s.on('end', () => {
          try { resolve({ status: r.statusCode, json: JSON.parse(d) }); }
          catch (e) { reject(new Error('LP 返回非 JSON（status=' + r.statusCode + '）')); }
        });
        s.on('error', reject);
      }).on('error', reject);
    }, wait);
  });
}

function encTitles(titles) {
  return encodeURIComponent(titles.join('|'))
    .replace(/%2F/g, '/').replace(/%7C/g, '|').replace(/%3A/g, ':');
}

async function fetchPages(titles) {
  const out = {};
  for (let i = 0; i < titles.length; i += BATCH) {
    const chunk = titles.slice(i, i + BATCH);
    const url = LP_BASE + '?action=query&format=json&prop=revisions&rvprop=content&redirects=1&titles=' + encTitles(chunk);
    const { status, json } = await fetchJson(url);
    if (status !== 200) throw new Error('LP HTTP ' + status);
    const pages = (json && json.query && json.query.pages) || {};
    Object.values(pages).forEach((p) => {
      if (!p || p.missing) return;
      const wt = p.revisions && p.revisions[0] && p.revisions[0]['*'];
      if (wt) out[String(p.title || '').replace(/ /g, '_')] = wt;
    });
  }
  return out;
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
        apikey: SERVICE_KEY,
        Authorization: 'Bearer ' + SERVICE_KEY,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (r) => {
      let d = '';
      r.on('data', (c) => { d += c; });
      r.on('end', () => (r.statusCode >= 200 && r.statusCode < 300)
        ? resolve()
        : reject(new Error('upsert HTTP ' + r.statusCode + ': ' + d.slice(0, 120))));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function candidateSlugs(ev) {
  const base = ev.liquipediaSlug || '';
  const arr = [];
  [ev.bracketSlug, ev.structureSlug, ev.scheduledMatchesSlug,
    base ? base + '/Main Event' : '', base ? base + '/Playoffs' : '', base].forEach((s) => {
    if (s && arr.indexOf(s) < 0) arr.push(s);
  });
  return arr;
}

function events() {
  return (curation.CURATED_EVENTS || []).filter((e) => e && (e.bracketSlug || e.liquipediaSlug));
}

function slotTitle(bracketId, slot) {
  return 'Match:ID_' + bracketId + '_R' + String(slot.roundNo).padStart(2, '0') +
    '-M' + String(slot.slotNo).padStart(3, '0');
}

function mergeMatchFields(slot, wikitext) {
  if (!wikitext) return slot;
  const body = wikitext.replace(/^\s*\{\{\s*/, '').replace(/\}\}\s*$/, '');
  const rest = body.replace(/^MatchPage\s*\|\s*/, '');
  const f = LP.parseMatchFields('Match|' + rest, true);
  if (!f) return slot;
  return Object.assign({}, slot, {
    empty: false,
    team1Name: f.team1Name,
    team2Name: f.team2Name,
    score1: f.score1,
    score2: f.score2,
    walkover: f.walkover,
    startTime: f.startTime,
    boType: f.boType,
    boDeclared: f.boDeclared,
    finished: f.finished,
    phase: f.phase,
    matchIds: f.matchIds,
    mapSlots: f.mapSlots
  });
}

async function syncEvent(ev, dry) {
  const cands = candidateSlugs(ev);
  let found = null;
  for (const slug of cands) {
    try {
      const pages = await fetchPages([slug]);
      const wt = pages[String(slug).replace(/ /g, '_')];
      const brackets = wt ? LP.parseBrackets(wt) : [];
      if (brackets.length) { found = { slug, brackets }; break; }
    } catch (e) {
      console.warn('  ✗ 候选页失败', slug, e.message);
    }
  }
  if (!found) return { event: ev.canonical, brackets: 0 };
  // 2026-10-28：选「主 bracket」（Playoffs 优先，其次填充最多）→ 额外写 leagueId 别名，
  //   客户端进淘汰赛 Tab 可一跳直读（不必先等结构页返回 bracketId）。
  const _filledOf = (bb) => ((bb.slots || []).filter((s) => !s.empty).length);
  const primaryB = found.brackets.filter((bb) => /playoff|淘汰/i.test(String(bb.section || '')))[0] ||
    found.brackets.slice().sort((a, b) => _filledOf(b) - _filledOf(a))[0] || null;
  let leaguePayload = null;
  let written = 0;
  for (const b of found.brackets) {
    if (!b.id) continue;
    const titles = b.slots.filter((s) => s.side !== 'third').map((s) => slotTitle(b.id, s));
    let pageMap = {};
    if (titles.length) {
      try { pageMap = await fetchPages(titles); }
      catch (e) { console.warn('  ✗ Match 页批量失败', b.id, e.message); }
    }
    const slots = b.slots.map((s) => {
      if (s.side === 'third') return s;
      return mergeMatchFields(s, pageMap[slotTitle(b.id, s)]);
    });
    const filled = slots.filter((s) => !s.empty).length;
    const payload = {
      bracketId: b.id, type: b.type, section: b.section, slug: found.slug,
      slots, total: slots.length, filled, rounds: b.rounds,
      updatedAt: Math.floor(Date.now() / 1000)
    };
    if (b === primaryB) leaguePayload = payload;
    if (dry) {
      console.log('  [dry] bracket', b.id, 'slots', slots.length, 'filled', filled);
    } else {
      await upsertCache('lp:br:' + b.id, payload, TTL_SEC);
    }
    written++;
  }
  // 2026-10-28：leagueId 别名（同一份 payload，客户端一跳直读）
  if (!dry && ev.leagueId != null && leaguePayload) {
    try { await upsertCache('lp:brl:' + ev.leagueId, leaguePayload, TTL_SEC); }
    catch (e) { console.warn('  ✗ leagueId 别名写入失败', ev.leagueId, e.message); }
  }
  return { event: ev.canonical, brackets: written, slug: found.slug };
}

async function main() {
  const args = process.argv.slice(2);
  const listOnly = args.includes('--list');
  const dry = listOnly || args.includes('--dry');
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) || 0 : 0;

  let evs = events();
  const evIdx = args.indexOf('--event');
  if (evIdx >= 0 && args[evIdx + 1]) {
    const q = String(args[evIdx + 1]).toLowerCase();
    evs = evs.filter((e) => String(e.canonical || '').toLowerCase().indexOf(q) >= 0);
  }
  if (limit > 0) evs = evs.slice(0, limit);
  console.log('赛事数:', evs.length, '| dry=' + dry);
  if (listOnly) {
    evs.forEach((e) => console.log(' ·', e.canonical, '→', candidateSlugs(e).join(' | ')));
    return;
  }
  if (!dry && (!SUPABASE_URL || !SERVICE_KEY)) {
    console.error('缺少 SUPABASE_URL / SUPABASE_SERVICE_KEY');
    process.exit(1);
  }

  let ok = 0, fail = 0, brackets = 0;
  for (const ev of evs) {
    try {
      const r = await syncEvent(ev, dry);
      if (r.brackets) { ok++; brackets += r.brackets; console.log(' ✓', ev.canonical, '→', r.slug, '(' + r.brackets + ')'); }
      else console.log(' -', ev.canonical, '无 bracket');
    } catch (e) {
      fail++;
      console.warn(' ✗', ev.canonical, e.message);
    }
  }
  console.log('\n=== 完成 === 赛事成功:', ok, 'bracket:', brackets, '失败:', fail);
}

main();
