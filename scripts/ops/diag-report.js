#!/usr/bin/env node
/**
 * scripts/ops/diag-report.js
 * **管道指标上报 + 调度心跳**（P0-B 下半 / P0-C）。
 *
 * ## 为什么需要它
 * P0-B 的指标此前只在**客户端**算并打 Console ⇒ 开发者只能在"打开小程序的那台设备上"看到，
 * 且**调度是否还在跑**这件事完全不可观测（方案把这条列为"架构唯一的系统性脆弱点"：
 * `ef-health` 只探 EF 健康，**不探调度本身**）。
 * 本脚本在 CI 里跑，把「快照新鲜度 / 条目数 / 本次运行时间」写进 `curation_meta`：
 *   ① 客户端「我的」页读它 ⇒ **用户/开发者都能看见"调度多久没跑"**（消费方：来源不同，不是同一处自证）
 *   ② 它本身就是**心跳**：定时任务若停摆，该行时间戳就不再前进
 * ★ 2026-10-24：内置赛程/联赛快照已移除 ⇒ 快照维度只保留队徽快照（其余诊断项不变）。
 *
 * ## 口径
 * 指标计算走**纯函数** `utils/diagnostics.js` 的 `computePipelineMetrics`
 * —— 与客户端**同一实现**，两边数字可直接对账（避免"两处口径"）。
 * ★ 本脚本**只上报 CI 真正知道的事**（快照年龄/条目数/运行信息）；
 *   卡片级指标（重复卡率等）依赖客户端融合结果，**不在此臆造**。
 *
 * ## 用法
 *   node scripts/ops/diag-report.js            # 预览（默认，只读，不写库）
 *   node scripts/ops/diag-report.js --apply    # 写库
 *
 * ## 凭据（与 fetch-liquipedia-upcoming.js 同一套，已在 GitHub Secrets 配好）
 *   SUPABASE_URL + SUPABASE_SERVICE_KEY —— 直连 PostgREST 写 `curation_meta`；
 *   ⚠️ `curation_meta` 的 RLS 只有 `anon_read_meta`（只读）⇒ **客户端写不了**，必须 CI/服务端写。
 *   ★ 2026-10-12（P1-12 已修）：EF `admin-write` 的 `updateMeta` **key 已参数化**
 *     （`{ key, value }`，key 必填；原先硬编码 `ti_contestant_ids` ⇒ 传别的 key 会写坏该行）。
 *     本脚本仍**直接走 service key 写库**：本报告是 CI 侧运维数据，不经管理令牌（ADMIN_TOKEN）。 */
'use strict';

const path = require('path');
const fs = require('fs');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const ROOT = path.resolve(__dirname, '..', '..');
const diag = require(path.join(ROOT, 'utils', 'diagnostics.js'));

const META_KEY = 'diag_report';

function readSnapshot(rel, countOf) {
  const p = path.join(ROOT, rel);
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { name: rel.split('/').pop(), ts: Number(j.generatedAt) || 0, count: countOf(j) };
  } catch (e) {
    return { name: rel.split('/').pop(), ts: 0, count: null };
  }
}

function buildReport() {
  // ★ 2026-10-24：内置赛程/联赛快照已移除 ⇒ 管道指标只保留**队徽快照**（仍在包内的 build-time 产物）。
  const snaps = [
    readSnapshot('utils/team-logo-map.json', (j) => Object.keys(j.byName || {}).length),
  ];
  const pm = diag.computePipelineMetrics(snaps, Math.floor(Date.now() / 1000));
  // ★ 只上报**可核对**的事实；卡片级指标不臆造（那依赖客户端融合）
  return {
    at: pm.at,
    head: (process.env.GITHUB_SHA || '').slice(0, 7) || null,   // CI 上可知"哪个修订产生的快照"
    source: process.env.GITHUB_ACTIONS ? 'gh-actions' : 'local',
    snapshots: pm.items,
    oldest: pm.oldest ? { name: pm.oldest.name, ageSec: pm.oldest.ageSec } : null,
    oldestAgeSec: pm.ageSec,
    overTarget: pm.overTarget,
    targetSec: pm.targetSec,
    totalCount: pm.totalCount,
    slo: {
      dupCardRateStrict: diag.SLO.dupCardRateStrict.target,
      endedNoScoreRate: diag.SLO.endedNoScoreRate.target,
      snapshotAgeSec: diag.SLO.snapshotAgeSec.target,
      statusConvergeDegradedSec: diag.SLO.statusConvergeDegradedSec.target,
    },
  };
}

async function writeMeta(report) {
  const CFG = require(path.join(ROOT, 'utils', 'config.js'));
  const SB_URL = process.env.SUPABASE_URL || (CFG.supabase && CFG.supabase.url) || '';
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

  if (!SB_URL) throw new Error('缺少 SUPABASE_URL');
  // ① 首选 service key 直连 PostgREST（CI 已配；集合语义 upsert）
  if (SERVICE_KEY) {
    const res = await fetch(SB_URL + '/rest/v1/curation_meta', {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: 'Bearer ' + SERVICE_KEY,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify({ key: META_KEY, value: report }),
    });
    if (!res.ok) throw new Error('upsert HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200));
    return 'service_key';
  }
  // ② 不使用 EF `admin-write` 的 `updateMeta` 作回退 ——
  //   本脚本是 **CI 侧运维写入**，只走 service key（不依赖管理令牌 ADMIN_TOKEN）。
  //   （★ 2026-10-12 P1-12：EF 侧 key 硬编码缺陷**已修**，`updateMeta` 现为 `{ key, value }` 参数化；
  //     但其鉴权口径是管理令牌，与本脚本的凭据模型不同，故仍不串用。）
  throw new Error('缺少 SUPABASE_SERVICE_KEY（CI 已配）；本地手动跑请显式设置该环境变量');
}

(async () => {
  const report = buildReport();
  console.log('[diag-report] 快照年龄（取最旧 = ' + (report.oldest ? report.oldest.name : '无') + '）：' +
    (report.oldestAgeSec == null ? '未知' : report.oldestAgeSec + 's') +
    (report.overTarget ? '  ❌ 超目标 ' + (report.targetSec / 3600) + 'h' : '  ✅ 未超目标'));
  report.snapshots.forEach((s) => {
    console.log('  · ' + s.name + '  年龄 ' + s.ageText + '  条目 ' + (s.count == null ? '-' : s.count));
  });
  console.log('[diag-report] 合计条目 ' + report.totalCount + ' · head ' + (report.head || '-') + ' · 来源 ' + report.source);
  if (!APPLY) {
    console.log('（预览模式，未写库）确认后执行：node scripts/ops/diag-report.js --apply');
    return;
  }
  const via = await writeMeta(report);
  console.log('✅ 已写入 curation_meta[' + META_KEY + ']（经 ' + via + '）—— 该行即"调度心跳"');
})().catch((e) => {
  console.error('❌ diag-report 失败：' + (e && e.message || e));
  process.exit(1);
});
