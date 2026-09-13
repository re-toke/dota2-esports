#!/usr/bin/env node
// ============================================================
// scripts/ops/backfill-curation.js
// 把云开发导出的 3 个集合灌入 Supabase（阶段 2 · 步骤②）
//
// ## 用法
//   # 预览（默认，不写库；打印将要写入的行数与样例）
//   node scripts/ops/backfill-curation.js
//
//   # 实际写入（需 service key）
//   SUPABASE_URL=https://xxx.supabase.co SUPABASE_SERVICE_KEY=eyJ... \
//     node scripts/ops/backfill-curation.js --apply
//
//   # 指定导出文件（默认取 Downloads 里那三个）
//   node scripts/ops/backfill-curation.js --events <path> --teams <path> --meta <path>
//
// ## 两个格式坑（实测踩过）
//   1. 微信云开发导出的 JSON 是 **JSON Lines**（每行一个对象），不是数组 → 按行解析
//   2. 值是「多一层引号」的字符串形态，如 _id = '"theinternational2025"'
//      → 需要 unwrap 一层（本脚本 deepUnwrap 递归处理）
//
// ## 前置
//   先执行 supabase/migrations/003-curation-schema-fix.sql（加 canonical_key 唯一索引）
// ============================================================
'use strict';

const fs = require('fs');
const https = require('https');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const getArg = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};

// 默认从「常见 Downloads 目录」里找（实测本机文件在 D: 而非 C:）
const CANDIDATE_DIRS = [
  'D:/Users/ZH/Downloads/',
  'C:/Users/ZH/Downloads/',
  (process.env.USERPROFILE || process.env.HOME || '') + '/Downloads/'
];
function findExport(name) {
  for (const d of CANDIDATE_DIRS) {
    if (d && fs.existsSync(d + name)) return d + name;
  }
  return CANDIDATE_DIRS[0] + name;   // 找不到也返回首个候选，便于报错定位
}
const F = {
  events: getArg('events', findExport('database_export-VkOpCLYxmc_o.json')),
  teams: getArg('teams', findExport('database_export-ysXXdhaGk0WF.json')),
  meta: getArg('meta', findExport('database_export-oudXsxmOGUHd.json'))
};

const CFG = require('./../../utils/config.js');
const URL_SB = process.env.SUPABASE_URL || (CFG.supabase && CFG.supabase.url) || '';
const KEY = process.env.SUPABASE_SERVICE_KEY || '';

/* ---------- 解析：JSON Lines + 去一层引号 ---------- */
function parseExport(fp) {
  if (!fs.existsSync(fp)) throw new Error('找不到导出文件: ' + fp + '\n  请用 --events/--teams/--meta 指定路径');
  const raw = fs.readFileSync(fp, 'utf8');
  const out = [];
  raw.split('\n').forEach((line) => {
    const t = line.trim().replace(/,$/, '');
    if (!t) return;
    try { out.push(JSON.parse(t)); } catch (e) { /* 跳过坏行 */ }
  });
  return out;
}

/** 去掉导出多出来的那一层引号（递归处理对象/数组） */
function unwrap(v) {
  if (typeof v === 'string') {
    const t = v.trim();
    if (t.length >= 2 && t.charAt(0) === '"' && t.charAt(t.length - 1) === '"') {
      try { return JSON.parse(t); } catch (e) { return t.slice(1, -1); }
    }
    return v;
  }
  if (Array.isArray(v)) return v.map(unwrap);
  if (v && typeof v === 'object') {
    const o = {};
    Object.keys(v).forEach((k) => { o[k] = unwrap(v[k]); });
    return o;
  }
  return v;
}

function normalize(doc) {
  const o = unwrap(doc);
  delete o.updatedAt;          // 云开发时间戳（Supabase 侧自带 updated_at）
  return o;
}

/* ---------- REST upsert ---------- */
function upsert(table, rows, conflictCol) {
  return new Promise((resolve) => {
    const body = JSON.stringify(rows);
    const u = new URL(URL_SB + '/rest/v1/' + table + '?on_conflict=' + conflictCol);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      timeout: 60000,
      headers: {
        apikey: KEY, Authorization: 'Bearer ' + KEY,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (r) => { let d = ''; r.on('data', (x) => d += x); r.on('end', () => resolve({ status: r.statusCode, body: d.slice(0, 300) })); });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
    req.on('error', (e) => resolve({ status: 0, body: e.message }));
    req.write(body);
    req.end();
  });
}

(async () => {
  console.log('模式: ' + (APPLY ? '★ 实际写入（--apply）' : '预览（不写库）'));
  console.log('');

  // ---- 读三份导出 ----
  const rawEvents = parseExport(F.events);
  const rawTeams = parseExport(F.teams);
  const rawMeta = parseExport(F.meta);
  console.log('导出读取: events ' + rawEvents.length + ' ｜ teams ' + rawTeams.length + ' ｜ meta ' + rawMeta.length);

  // ---- 构造行 ----
  const evRows = [];
  let noKey = 0, withLeague = 0;
  rawEvents.forEach((d) => {
    const o = normalize(d);
    const ck = o._id != null ? String(o._id) : null;
    if (!ck) { noKey++; return; }
    if (o.leagueId != null) withLeague++;
    delete o._id;
    evRows.push({ canonical_key: ck, league_id: o.leagueId != null ? Number(o.leagueId) : null, data: o });
  });

  const tmRows = [];
  rawTeams.forEach((d) => {
    const o = normalize(d);
    const tid = o._id != null ? Number(String(o._id).replace(/[^0-9]/g, '')) : NaN;
    if (!tid || isNaN(tid)) return;
    delete o._id;
    tmRows.push({ team_id: tid, data: o });
  });

  const meRows = [];
  rawMeta.forEach((d) => {
    const o = normalize(d);
    const k = o._id != null ? String(o._id) : null;
    if (!k) return;
    delete o._id;
    meRows.push({ key: k, data: o });
  });

  console.log('');
  console.log('待写入:');
  console.log('  curation_events  ' + evRows.length + ' 行  （无 canonical_key 被跳过 ' + noKey + ' ｜ 带 leagueId ' + withLeague + '）');
  console.log('  curation_teams   ' + tmRows.length + ' 行');
  console.log('  curation_meta    ' + meRows.length + ' 行');
  console.log('');
  console.log('样例（events[0]，值已 unwrap）:');
  console.log('  ' + JSON.stringify(evRows[0]).slice(0, 420));
  console.log('样例（teams[0]）:');
  console.log('  ' + JSON.stringify(tmRows[0]).slice(0, 260));
  console.log('样例（meta[0]）:');
  console.log('  ' + JSON.stringify(meRows[0]).slice(0, 300));

  if (!APPLY) {
    console.log('');
    console.log('（预览模式结束。确认无误后加 --apply 并设置 SUPABASE_SERVICE_KEY 实际写入）');
    return;
  }
  if (!URL_SB || !KEY) {
    console.error('❌ --apply 需要 SUPABASE_URL 与 SUPABASE_SERVICE_KEY');
    process.exit(1);
  }

  // ---- 分批写入 ----
  const BATCH = 200;
  async function run(table, rows, conflictCol) {
    let ok = 0, fail = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      const r = await upsert(table, chunk, conflictCol);
      if (r.status >= 200 && r.status < 300) ok += chunk.length;
      else { fail += chunk.length; console.warn('  ✗ ' + table + ' 批次 ' + (i / BATCH + 1) + ' HTTP ' + r.status + ' ' + r.body); }
      process.stdout.write('  ' + table + ': ' + Math.min(i + BATCH, rows.length) + '/' + rows.length + '\r');
    }
    console.log('  ' + table + ': ' + ok + ' 成功' + (fail ? ' / ' + fail + ' 失败' : '') + '          ');
    return fail === 0;
  }

  console.log('');
  console.log('写入中...');
  const a = await run('curation_events', evRows, 'canonical_key');
  const b = await run('curation_teams', tmRows, 'team_id');
  const c = await run('curation_meta', meRows, 'key');
  console.log('');
  console.log(a && b && c ? '✅ 全部写入完成' : '⚠️ 有批次失败，见上方日志');
})();
