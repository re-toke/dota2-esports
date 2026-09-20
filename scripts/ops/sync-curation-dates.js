#!/usr/bin/env node
// ============================================================
// scripts/ops/sync-curation-dates.js
// 把本地 curation 的**赛期（start/end）**订正同步到 Supabase `curation_events`。
//
// ## 为什么需要它
// 小程序运行时读的是 **远端** curation（`utils/remoteCuration.js` → Supabase
// `curation_events`），且 `mergeEventFields` 让**远端字段覆盖本地**（非 null 即覆盖）。
// 所以只改本地 `utils/curation.js` **不会生效于真机** ——
// 实测教训：本地已订正 PGL Wallachia Season 9 起始日为 9/19，但界面仍显示 9/17，
// 因为远端表里 `data.start` 还是 1789603200（9/17）。
//
// ## 用法
//   # 预览（默认，只读，不写库）
//   node scripts/ops/sync-curation-dates.js
//
//   # 实际写入（需要管理令牌；令牌取自 admin/.env.local 的 VITE_ADMIN_TOKEN）
//   ADMIN_TOKEN=<令牌> node scripts/ops/sync-curation-dates.js --apply
//
//   可选：
//     --only <关键词>   只处理名称包含关键词的条目（便于单条试跑）
//     --token <值>      直接给令牌（等价于环境变量，注意 shell 历史泄露风险）
//
// ## 只改 start/end
//   写库走 `admin-write` EF 的 `upsertEvent`，而该 operation 是**整体替换** `data` 字段
//   （`data: { ...data, updatedAt }`）→ 本脚本会先读远端现有 `data`，**合并**后再提交，
//   绝不丢 prizePool / organizer / aliases 等其它字段。
//
// ## 本地赛期约定（与展示侧 `util.fmtShort` 的设备本地时区对齐）
//   `end` 应存「**末日 00:00 UTC**」或「末日 BJ 23:59:59」这类**在 UTC+8 设备上仍显示为末日**的值。
//   ⚠️ 历史坑：存「末日 **UTC** 23:59:59」在 UTC+8 设备会显示成**次日**（已修，勿回退）。
// ============================================================
'use strict';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const getArg = (name) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : '';
};
const ONLY = getArg('only');
const TOKEN = getArg('token') || process.env.ADMIN_TOKEN || '';

const CFG = require('./../../utils/config.js');
const curation = require('./../../utils/curation.js');
const SB_URL = CFG.supabase.url;
const ANON = CFG.supabase.anonKey;

/** 与 admin-write EF / 小程序一致的赛事名归一化（用作 canonical_key，必须逐字一致） */
function normalizeEventName(name) {
  if (!name) return '';
  return String(name).toLowerCase().replace(/[^a-z0-9一-鿿а-яё]/g, '').replace(/^the/, '');
}

const bjDay = (t) => (t ? new Date((Number(t) + 8 * 3600) * 1000).toISOString().slice(0, 10) : '-');

/** 分页读全量 curation_events（REST 默认单次上限 1000，必须分页防截断） */
async function fetchRemoteRows() {
  const PAGE = 1000;
  const out = [];
  for (let offset = 0; offset < 20000; offset += PAGE) {
    const r = await fetch(SB_URL + '/rest/v1/curation_events?select=canonical_key,league_id,data', {
      headers: {
        apikey: ANON,
        Authorization: 'Bearer ' + ANON,
        Range: offset + '-' + (offset + PAGE - 1),
      },
    });
    if (!r.ok) throw new Error('读取 curation_events 失败 HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
    const rows = await r.json();
    out.push.apply(out, rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

async function upsertEvent(data) {
  const r = await fetch(SB_URL + '/functions/v1/admin-write', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: ANON,
      Authorization: 'Bearer ' + ANON,
      'x-admin-token': TOKEN,
    },
    body: JSON.stringify({ operation: 'upsertEvent', params: { data } }),
  });
  let body = null;
  try { body = await r.json(); } catch (e) { /* 非 JSON */ }
  return { status: r.status, body };
}

(async () => {
  console.log('[sync-curation-dates] 远端：' + SB_URL);
  const remoteRows = await fetchRemoteRows();
  const remote = Object.create(null);
  remoteRows.forEach((x) => { if (x && x.canonical_key) remote[x.canonical_key] = x; });
  console.log('远端 curation_events = ' + remoteRows.length + ' 行');
  console.log('本地 CURATED_EVENTS（含赛期）= ' +
    curation.CURATED_EVENTS.filter((e) => e && e.canonical && e.start && e.end).length + ' 条');
  console.log('');

  const diffs = [];
  const missing = [];
  curation.CURATED_EVENTS.forEach((e) => {
    if (!e || !e.canonical || !e.start || !e.end) return;
    if (ONLY && String(e.canonical).indexOf(ONLY) < 0) return;
    const key = normalizeEventName(e.canonical);
    const row = remote[key];
    if (!row) { missing.push({ canonical: e.canonical, key: key }); return; }
    const d = row.data || {};
    if (Number(d.start) === Number(e.start) && Number(d.end) === Number(e.end)) return;
    diffs.push({
      canonical: e.canonical,
      key: key,
      remote: { start: d.start, end: d.end },
      local: { start: e.start, end: e.end },
      merged: Object.assign({}, d, { canonical: e.canonical, start: e.start, end: e.end }),
    });
  });

  if (!diffs.length) {
    console.log('✅ 远端赛期与本地完全一致，无需同步。');
  } else {
    console.log('=== 待订正 ' + diffs.length + ' 条 ===');
    diffs.forEach((x) => {
      console.log('  ' + x.canonical);
      console.log('      远端 ' + bjDay(x.remote.start) + ' ~ ' + bjDay(x.remote.end) +
        '   →   本地 ' + bjDay(x.local.start) + ' ~ ' + bjDay(x.local.end));
    });
  }
  if (missing.length) {
    console.log('');
    console.log('ℹ️  本地有赛期但远端无该行（本次不处理，如需补录请走 admin 后台）：' + missing.length + ' 条');
    missing.slice(0, 10).forEach((x) => console.log('    - ' + x.canonical));
  }

  if (!diffs.length) return;
  if (!APPLY) {
    console.log('');
    console.log('（预览模式，未写库）确认无误后执行：');
    console.log('  ADMIN_TOKEN=<管理令牌> node scripts/ops/sync-curation-dates.js --apply');
    return;
  }
  if (!TOKEN) {
    console.error('');
    console.error('✗ 缺少管理令牌。请设置 ADMIN_TOKEN（值见 admin/.env.local 的 VITE_ADMIN_TOKEN）。');
    process.exit(1);
  }

  console.log('');
  console.log('写入中...');
  let ok = 0, fail = 0;
  for (const x of diffs) {
    const r = await upsertEvent(x.merged);
    if (r.status >= 200 && r.status < 300 && r.body && r.body.success) {
      ok++;
      console.log('  ✓ ' + x.canonical);
    } else {
      fail++;
      console.log('  ✗ ' + x.canonical + '  HTTP ' + r.status + ' ' +
        JSON.stringify(r.body && r.body.error || r.body).slice(0, 160));
    }
  }
  console.log('');
  console.log(fail === 0 ? '✅ 全部写入完成（' + ok + ' 条）' : '⚠️ 成功 ' + ok + ' / 失败 ' + fail);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('FAILED: ' + (e && e.message || e));
  process.exit(1);
});
