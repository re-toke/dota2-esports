#!/usr/bin/env node
/**
 * scripts/sync/purge-uncollectable-events.js
 *
 * 按新收录口径清理 Supabase `curation_events` 中**不应收录**的存量赛事（2026-09-19）。
 *
 * ## 背景（用户 2026-09-19 决策）
 * OpenDota 的 tier 不可信（「肛宝联赛-老婆杯」被标 professional），2026-09-14 的自动发现
 * 又一次性写入 831 条赛事。用户决策：**存量按新口径清理**。
 *
 * ## 清理目标（与 utils/tiers.js 单一同源）
 * 删除满足**任一**条件的行：
 *   ① 硬排除：赛事名命中 HARD_EXCLUDE_RULES（业余/社区/青训/慈善/表演/周赛月赛/国家队/TI预选路径）
 *   ② C 级：tier.rank === 0（社区赛，新口径不收录）
 *   ⚠️ 预选赛（Qualifier）**不在清理范围** —— 用户决策为「保留但降级标注」。
 *
 * ## 凭证
 * 运行时从 `admin/.env.local` 读取（VITE_SUPABASE_URL / VITE_ADMIN_TOKEN），
 * 脚本本身**不包含也不打印**任何密钥。
 *
 * ## 用法
 *   node scripts/sync/purge-uncollectable-events.js            # 干跑（默认，只统计 + 样本）
 *   node scripts/sync/purge-uncollectable-events.js --apply    # 实际删除
 *   node scripts/sync/purge-uncollectable-events.js --apply --force   # 跳过 50% 安全阀
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const tiers = require(path.join(ROOT, 'utils/tiers.js'));

const APPLY = process.argv.indexOf('--apply') >= 0;
const FORCE = process.argv.indexOf('--force') >= 0;
const PAGE = 1000;

/** 从 admin/.env.local 读凭证（不打印） */
function readCreds() {
  const envPath = path.join(ROOT, 'admin/.env.local');
  if (!fs.existsSync(envPath)) {
    throw new Error('未找到 admin/.env.local（含 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY / VITE_ADMIN_TOKEN）');
  }
  const txt = fs.readFileSync(envPath, 'utf8');
  const pick = (k) => {
    const m = txt.match(new RegExp('^\\s*' + k + '\\s*=\\s*(.+)\\s*$', 'm'));
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
  };
  const url = pick('VITE_SUPABASE_URL');
  const anon = pick('VITE_SUPABASE_ANON_KEY');
  const token = pick('VITE_ADMIN_TOKEN');
  if (!url || !anon || !token) throw new Error('admin/.env.local 缺少 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY / VITE_ADMIN_TOKEN');
  return { url, anon, token };
}

async function fetchAll(url, anon) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const to = from + PAGE - 1;
    const res = await fetch(url + '/rest/v1/curation_events?select=canonical_key,data', {
      headers: { apikey: anon, Authorization: 'Bearer ' + anon, Range: from + '-' + to }
    });
    if (!res.ok) throw new Error('读取失败 ' + res.status + ' ' + (await res.text()).slice(0, 200));
    const batch = await res.json();
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }
  return rows;
}

function classify(row) {
  const d = row.data || {};
  const name = d.canonical || '';
  const rank = (d.tier && d.tier.rank != null) ? d.tier.rank : null;
  if (tiers.shouldExclude(name)) return 'hard-excluded';
  if (rank === 0) return 'rank0-community';
  return null;
}

(async () => {
  const { url, anon, token } = readCreds();
  console.log('[purge] 模式：' + (APPLY ? '★ APPLY（实际删除）' : '干跑（只统计）'));

  const rows = await fetchAll(url, anon);
  console.log('[purge] curation_events 总数：' + rows.length);

  const targets = [];
  const byReason = {};
  const samples = { 'hard-excluded': [], 'rank0-community': [] };
  for (const r of rows) {
    const reason = classify(r);
    if (!reason) continue;
    targets.push(r);
    byReason[reason] = (byReason[reason] || 0) + 1;
    const nm = (r.data && r.data.canonical) || r.canonical_key;
    if (samples[reason].length < 15) samples[reason].push(nm);
  }

  console.log('[purge] 命中清理条件：' + targets.length
    + '（hard-excluded=' + (byReason['hard-excluded'] || 0)
    + ', rank0-community=' + (byReason['rank0-community'] || 0) + '）');
  Object.keys(samples).forEach((k) => {
    if (samples[k].length) {
      console.log('[purge] ' + k + ' 样本：');
      samples[k].forEach((n) => console.log('    - ' + n));
    }
  });

  if (!targets.length) { console.log('[purge] 无需清理，退出。'); return; }
  if (!APPLY) {
    console.log('[purge] 干跑结束。确认无误后加 --apply 执行删除。');
    return;
  }
  // 安全阀：删除量超过总数 50% 时需 --force（防口径写错导致误删大半）
  if (targets.length > rows.length * 0.5 && !FORCE) {
    console.log('[purge] ⛔ 安全阀：待删 ' + targets.length + ' / 总 ' + rows.length
      + ' 超过 50%。如确认无误请加 --force。');
    process.exit(1);
  }

  let okCount = 0, failCount = 0;
  for (let i = 0; i < targets.length; i++) {
    const key = targets[i].canonical_key;
    try {
      const res = await fetch(url + '/functions/v1/admin-write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': token },
        body: JSON.stringify({ operation: 'deleteEvent', docId: key })
      });
      if (res.ok) okCount++; else { failCount++; console.log('  ✗ ' + key + ' → ' + res.status); }
    } catch (e) {
      failCount++; console.log('  ✗ ' + key + ' → ' + e.message);
    }
    if ((i + 1) % 100 === 0) console.log('[purge] 进度 ' + (i + 1) + '/' + targets.length);
  }
  console.log('[purge] 完成：成功 ' + okCount + ' / 失败 ' + failCount);
})().catch((e) => { console.error('[purge] 失败：' + e.message); process.exit(1); });
