#!/usr/bin/env node
/**
 * scripts/ops/check-snapshot-freshness.js
 * build-time 快照**新鲜度守卫**（2026-09-27 · 快照过期诊断「缺口 B」）
 *
 * ## 为什么需要它（实测教训）
 * `utils/leagues-local.json` 停更 **12.7 天**、`utils/team-logo-local-data.js` 停更 **≈26 天**，
 * 而**全部 CI 门禁仍全绿** —— 因为没有任何判据在看"数据是否过期"。
 * ⇒ 这是典型的**静默失效**：只能等用户在界面上偶然看到才发现（本次就是这么发现的）。
 * 本守卫把「过期」变成**可见**：过期 ⇒ 退出码非 0 + 明确打印是哪一份、多久没动。
 *
 * ## 阈值口径：**不新增常量**
 * 复用 `pages/leagues/leagues.js` 的 `SNAPSHOT_MAX_AGE_SEC`（**读源码取常量**，只允许数字与 `*`，
 * 不做 eval）—— 与页面「是否显示日期提示」**同口径**，避免出现第三个"过期"定义。
 *
 * ## 为什么**刻意不进** `test:all` 串行链
 * 本守卫失败的原因**几乎总是"调度没跑"**（GH scheduled 实测延迟 ~5h、9 次里 3 次失败），
 * **不是代码回归**。若混进 `test:all`（任一失败其后门禁全不执行），调度抖动会让
 * **代码门禁整条变红** ⇒ 团队对红灯麻木 ⇒ 反而失去信号。
 * ⇒ 独立 job + `continue-on-error`（可见但不阻塞）。见 `deliverables/快照过期问题-方案复核意见-2026-09-27.md` R4。
 *
 * 用法：node scripts/ops/check-snapshot-freshness.js
 * 退出码：0 = 全部在阈值内；1 = 存在过期快照
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

// 有「鲜度」要求的三份 build-time 产物（2026-09-27 复核修正：此前漏算了 team-logo）
const SNAPSHOTS = [
  { name: '赛程快照', file: 'utils/upcoming-local.json',          module: 'utils/upcoming-local-data.js',   ci: 'sync-upcoming.yml' },
  { name: '联赛快照', file: 'utils/leagues-local.json',           module: 'utils/leagues-local-data.js',    ci: 'sync-upcoming.yml' },
  { name: '队标快照', file: 'utils/team-logo-map.json',           module: 'utils/team-logo-local-data.js',  ci: 'sync-upcoming.yml' },
];

/** 从页面源码读常量（只允许数字与 `*`；与 SLO 漂移守卫同一套路，避免 eval） */
function readConst(file, name) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const re = new RegExp('const\\s+' + name + '\\s*=\\s*([0-9*\\s]+);');
  const m = src.match(re);
  if (!m) throw new Error('未能在 ' + file + ' 中找到常量 ' + name);
  const expr = m[1].replace(/\s/g, '');
  if (!/^[0-9*]+$/.test(expr)) throw new Error(name + ' 的表达式含非数字字符：' + expr);
  return expr.split('*').reduce((a, b) => a * Number(b), 1);
}

const LEAGUES_PAGE = 'pages/leagues/leagues.js';
const STALE_SEC = readConst(LEAGUES_PAGE, 'SNAPSHOT_MAX_AGE_SEC');        // 7 天：降权/提示阈值
const UNUSABLE_SEC = readConst(LEAGUES_PAGE, 'SNAPSHOT_UNUSABLE_AGE_SEC'); // 30 天：可用性阈值

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
  ' 天（读自 ' + LEAGUES_PAGE + '，单一来源）\n');

const rows = [];
let staleCount = 0;
SNAPSHOTS.forEach((s) => {
  const g = readGeneratedAt(s);
  const ageSec = g.ts ? (nowSec - g.ts) : null;
  const days = ageSec == null ? null : fmtDays(ageSec);
  const stale = ageSec == null || ageSec > STALE_SEC;
  const unusable = ageSec == null || ageSec > UNUSABLE_SEC;
  if (stale) staleCount++;
  rows.push({ s: s, g: g, days: days, stale: stale, unusable: unusable });
  console.log('  ' + (stale ? '❌' : '✅') + ' ' + s.name + '（' + s.file + '）');
  console.log('      generatedAt=' + (g.ts || '缺失') + (days == null ? '' : '（' + days + ' 天前）') +
    '   来源文件=' + (g.from || '—'));
  console.log('      CI 接线=' + s.ci + (unusable ? '   ⚠️ 已达「不可用」阈值（页面会拒绝用它渲染）' : ''));
});

console.log('');
if (!staleCount) {
  console.log('[snapshot-freshness] ✅ 全部快照在 ' + fmtDays(STALE_SEC) + ' 天阈值内');
  process.exit(0);
}

console.log('[snapshot-freshness] ❌ 有 ' + staleCount + ' 份快照已过期（超过 ' + fmtDays(STALE_SEC) + ' 天）');
console.log('');
console.log('  可能原因（按概率排序）——注意：**这不是代码回归，而是"调度没跑"**：');
console.log('    ① GitHub scheduled workflow 被丢弃/延迟（实测名义 2×/天，实际延迟 ~5h、9 次里 3 次失败）；');
console.log('    ② 刷新步骤所在 job 失败（见 sync-upcoming.yml 的 "Refresh * snapshot" 步骤）；');
console.log('    ③ 脚本依赖的 OpenDota 抖动（该步骤已设 continue-on-error，失败不会阻断 upcoming 回写）。');
console.log('');
console.log('  处理：可在 Actions 页手动 workflow_dispatch 触发一次 sync-upcoming 复核。');
console.log('  ⚠️ 本守卫刻意不阻塞主门禁（见脚本头注释 R4）；它的红灯表示"数据不新鲜"，不是"代码坏了"。');
process.exit(1);
