const fs = require('fs');
const { execSync } = require('child_process');

/* ① 手册补记停用结果 */
const P = 'deliverables/阶段6_执行手册_停触发器与观察期_2026-09-15.md';
let s = fs.readFileSync(P, 'utf8');
const anchor = '**停用后立刻记一行**：`停用时间 = ____`（观察期的起点）';
if (s.indexOf(anchor) >= 0) {
  const repl = [
    '### ✅ 停用结果（2026-09-15 17:14 记录）',
    '',
    '- 用户确认位置：云开发控制台 → 云函数 → 点函数名 → **右侧面板「定时触发器」**',
    '- `aggregation`：✅ **定时触发器：空**（cacheRefresh + schedulePreheat 已移除）',
    '- `cron-discover-tournaments`：✅ **定时触发器：空**（dailyDiscover 已移除）',
    '- 生效方式：清空 `config.json` 的 triggers 后**重新部署两个函数**（已执行）',
    '- **停用时间 = 2026-09-15 17:14（观察期第 0 天）**',
    '',
    '> 判据：云函数详情右侧面板读的是**云端实况**，比本地文件可靠。',
    '> 二次验证（可选）：等 35 分钟看 `aggregation` 日志，不再出现新 timer 触发即确认。'
  ].join('\n');
  s = s.replace(anchor, repl);
  console.log('① 手册已记录停用结果');
} else console.log('① 手册锚点未命中（跳过）');

const row = '| 9/15 | | | | | 停用日 |';
if (s.indexOf(row) >= 0) {
  s = s.replace(row, '| **9/15** | ⬜ 待查 | ⬜ 待查 | ⬜ 待查 | ⬜ 待查 | **停用日 17:14（第 0 天）** |');
  console.log('① 观察表首行已标注');
}
fs.writeFileSync(P, s);

/* ② 记忆 */
const p = '../.workbuddy/memory/2026-09-15.md';
fs.appendFileSync(p, [
  '',
  '## ✅✅ ⑥ 步骤① 完成：三个定时触发器已停用（17:14）',
  '用户确认（云开发控制台 → 云函数 → 点函数名 → 右侧面板「定时触发器」）：',
  '- aggregation → 定时触发器：**空**（cacheRefresh + schedulePreheat 已移除）',
  '- cron-discover-tournaments → 定时触发器：**空**（dailyDiscover 已移除）',
  '生效方式：清空 config.json 的 triggers → 重新部署两个函数（用户已执行）',
  '**观察期起始 = 2026-09-15 17:14（第 0 天）**',
  '',
  '### ★ 经验：微信云开发停定时触发器的可靠路径',
  '控制台入口隐蔽（版本差异大、有的只读）；可靠路径 = 把 config.json 的 triggers 改为 []，',
  '再在开发者工具里右键函数选「上传并部署：云端安装依赖」（必须选带云端安装依赖那项，仅上传代码不生效）。',
  '验证：云函数详情右侧面板「定时触发器」为空 = 云端实况已移除 ✓',
  '',
  '### 观察期（9/15~9/21）每天 4 项',
  '① 真机 Console（筛 回落/兜底/error）② Discover workflow ③ EF Health Check ④ admin 后台读写',
  '★ 9/17 = PGL Wallachia S9 开赛日，重点看首页与「即将」tab',
  ''
].join('\n'), 'utf8');
console.log('② 记忆已写入');

/* ③ 提交 */
try {
  execSync('git add -A', { stdio: 'pipe' });
  execSync('git commit -m "docs(v8.86): ⑥ 步骤① 完成 —— 记录停用结果与观察期起始（2026-09-15 17:14）"', { stdio: 'pipe' });
  console.log('③ 已提交: ' + execSync('git log --oneline -1', { encoding: 'utf8' }).trim());
} catch (e) {
  console.log('③ 提交输出:\n' + ((e.stdout || '') + (e.stderr || '')).slice(-250));
}
