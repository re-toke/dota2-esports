#!/usr/bin/env node
/**
 * scripts/ops/check-snapshot-freshness.js
 * build-time 快照**新鲜度守卫**（2026-09-27 · 快照过期诊断「缺口 B」）
 *
 * ## 为什么需要它（实测教训）
 * 队标快照（`utils/team-logo-map.json` + `subpackages/detail/team-logo-local-data.js`；★ P2-21 后移至分包）
 * 曾停更 **≈26 天**，而**全部 CI 门禁仍全绿** —— 因为没有任何判据在看"数据是否过期"。
 * ⇒ 这是典型的**静默失效**：只能等用户在界面上偶然看到才发现（本次就是这么发现的）。
 * 本守卫把「过期」变成**可见**：过期 ⇒ 退出码非 0 + 明确打印多久没动。
 *
 * ## 范围（★ 2026-10-24 变更）
 * 内置「即将赛程 / 联赛」快照已按用户决策移除（改为纯联网）⇒ 本守卫**只检查队徽快照**。
 * 阈值改为脚本内局部常量（原读 `utils/config.js` 的快照阈值，已随快照一并删除）。
 *
 * ## 阈值口径
 * 提示 7 天 / 不可用 30 天（与移除前一致的语义，保留"提示"与"不可用"两级）。
 *
 * ## 为什么**刻意不进** `test:all` 串行链
 * 本守卫失败的原因**几乎总是"调度没跑"**（GH scheduled 实测延迟 ~5h、9 次里 3 次失败），
 * **不是代码回归**。若混进 `test:all`（任一失败其后门禁全不执行），调度抖动会让
 * **代码门禁整条变红** ⇒ 团队对红灯麻木 ⇒ 反而失去信号。
 * ⇒ 独立 job + `continue-on-error`（可见但不阻塞）。见 `deliverables/快照过期问题-方案复核意见-2026-09-27.md` R4。
 *
 * 用法：node scripts/ops/check-snapshot-freshness.js
 * 退出码：0 = 在阈值内；1 = 已过期
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

// ★ 2026-10-24：内置赛程/联赛快照移除后仅剩队徽快照；阈值改为本脚本局部常量（config 已无对应常量）。
const STALE_SEC = 7 * 86400;        // 7 天：提示阈值
const UNUSABLE_SEC = 30 * 86400;    // 30 天：可用性阈值

const SNAPSHOT = {
  name: '队标快照',
  file: 'utils/team-logo-map.json',
  module: 'subpackages/detail/team-logo-local-data.js',
  ci: 'sync-upcoming.yml'
};

function readGeneratedAt(s) {
  // 优先读 JSON 留档；缺 JSON 时回退 JS wrapper（两者由同一脚本同次写出，应一致）
  for (const f of [s.file, s.module]) {
    try {
      const p = path.join(ROOT, f);
      if (!fs.existsSync(p)) continue;
      const content = fs.readFileSync(p, 'utf8');
      const v = f.endsWith('.json')
        ? JSON.parse(content)
        : JSON.parse('{' + (content.match(/"generatedAt"\s*:\s*\d+/g) || ['"generatedAt":0'])[0] + '}');
      const t = Number(v && v.generatedAt) || 0;
      if (t) return { ts: t, from: f };
    } catch (e) { /* 继续尝试下一个文件 */ }
  }
  return { ts: 0, from: null };
}

const nowSec = Math.floor(Date.now() / 1000);
const fmtDays = (sec) => (Math.round((sec / 86400) * 10) / 10);

console.log('[snapshot-freshness] 阈值：提示 ' + fmtDays(STALE_SEC) + ' 天 / 不可用 ' + fmtDays(UNUSABLE_SEC) +
  ' 天（脚本内局部常量；内置赛程/联赛快照已移除，仅检查队徽快照）\n');

const g = readGeneratedAt(SNAPSHOT);
const ageSec = g.ts ? (nowSec - g.ts) : null;
const days = ageSec == null ? null : fmtDays(ageSec);
const stale = ageSec == null || ageSec > STALE_SEC;
const unusable = ageSec == null || ageSec > UNUSABLE_SEC;
console.log('  ' + (stale ? '❌' : '✅') + ' ' + SNAPSHOT.name + '（' + SNAPSHOT.file + '）');
console.log('      generatedAt=' + (g.ts || '缺失') + (days == null ? '' : '（' + days + ' 天前）') +
  '   来源文件=' + (g.from || '—'));
console.log('      CI 接线=' + SNAPSHOT.ci + (unusable ? '   ⚠️ 已达「不可用」阈值' : ''));

console.log('');
if (!stale) {
  console.log('[snapshot-freshness] ✅ 队徽快照在 ' + fmtDays(STALE_SEC) + ' 天阈值内');
  process.exit(0);
}

console.log('[snapshot-freshness] ❌ 队徽快照已过期（超过 ' + fmtDays(STALE_SEC) + ' 天）');
console.log('');
console.log('  可能原因（按概率排序）——注意：**这不是代码回归，而是"调度没跑"**：');
console.log('    ① GitHub scheduled workflow 被丢弃/延迟（实测名义 2×/天，实际延迟 ~5h、9 次里 3 次失败）；');
console.log('    ② 刷新步骤所在 job 失败（见 sync-upcoming.yml 的 "Refresh * snapshot" 步骤）；');
console.log('    ③ 脚本依赖的 OpenDota/Steam CDN 抖动（该步骤已设 continue-on-error，失败不会阻断其它回写）。');
console.log('');
console.log('  处理：可在 Actions 页手动 workflow_dispatch 触发一次 sync-upcoming 复核。');
console.log('  ⚠️ 本守卫刻意不阻塞主门禁（见脚本头注释 R4）；它的红灯表示"数据不新鲜"，不是"代码坏了"。');
process.exit(1);
