const fs = require('fs');
const { execSync } = require('child_process');

/* ============================================================
   Fix A：首页三段只保留 S/A（产品决策 2026-09-16）
   A1 对局卡列表按级别过滤（_renderMatchFlow 的 dayMatches）
   A2 ⑥段候选也过滤（顺带减少 LP/Steam 查询 → 对问题1 性能有正收益）
   ============================================================ */
const P1 = 'pages/index/index.js';
let L = fs.readFileSync(P1, 'utf8').split('\n');
const at = (l) => l.replace(/\r$/, '');

// A1：dayMatches 过滤
const a1 = '    const dayMatches = all.filter((c) => c.dateKey === selected);';
const i1 = L.findIndex((l) => at(l) === a1);
if (i1 < 0) { console.log('❌ A1 锚点未找到'); process.exit(1); }
L.splice(i1, 1,
  '    // ★ 2026-09-16（产品决策）：首页「即将到来 / 进行中 / 已结束」三段**只保留 S/A 级**。',
  '    //   背景：此前无级别过滤，窗口内在赛的都是 S/A 时「看起来」是 S/A；',
  '    //   补收录 B 级赛事（WINLINE S4 / EPL SEA S17 等）后它们正在进行 → 冒进首页。',
  '    //   注意：只影响首页；赛事列表页（leagues）仍展示全部级别。',
  '    const HOME_GRADES = { S: 1, A: 1 };',
  '    const passGrade = (c) => !!(c.tier && HOME_GRADES[c.tier.grade]);',
  '    const beforeGrade = all.filter((c) => c.dateKey === selected);',
  '    const dayMatches = beforeGrade.filter(passGrade);',
  '    if (beforeGrade.length !== dayMatches.length) {',
  "      console.log('[index] S/A 级别过滤：' + beforeGrade.length + ' → ' + dayMatches.length + ' 张（剔除 ' + (beforeGrade.length - dayMatches.length) + ' 张非 S/A）');",
  '    }');
console.log('✅ A1 已加：对局卡列表按 S/A 过滤');

// A2：⑥段候选过滤（只 S/A）
const a2 = '        .slice(0, 5);                                     // 请求量上限（3→5，A2）';
const i2 = L.findIndex((l) => at(l) === a2);
if (i2 < 0) { console.log('❌ A2 锚点未找到'); process.exit(1); }
L.splice(i2, 0,
  '        // ★ 2026-09-16（产品决策）：⑥ 段候选**只取 S/A 级** ——',
  '        //   ① 与首页三段「只保留 S/A」口径一致；② 顺带减少 LP/Steam 赛程查询次数（性能正收益）。',
  '        .filter((e) => { const t = e.tier; return !!(t && (t.grade === \'S\' || t.grade === \'A\')); })');
console.log('✅ A2 已加：⑥段候选按 S/A 过滤');

fs.writeFileSync(P1, L.join('\n'));
execSync('node --check ' + P1, { stdio: 'pipe' });

/* ============================================================
   Fix B：快照提示语 —— 未过期不显示日期（问题3）
   ============================================================ */
const P2 = 'pages/leagues/leagues.js';
let G = fs.readFileSync(P2, 'utf8').split('\n');
const b1 = "            leaguesAsOfText: '本地数据 ' + this._formatSnapshotDate(snap.generatedAt) + ' · 正在同步实时赛程'";
const i3 = G.findIndex((l) => at(l).trim() === b1.trim());
if (i3 < 0) { console.log('❌ Fix B 锚点未找到'); process.exit(1); }
G.splice(i3, 1,
  '            // ★ 2026-09-16（问题3 修复）：快照未见旧时**不显示日期**。',
  '            //   原实现无条件带日期 → 用户看到「本地数据 9月14日」以为数据陈旧（其实才 2 天）。',
  '            //   与 v8.1 设计意图对齐（L1028：新快照不显示、过期(>7天)才提示日期）。',
  '            leaguesAsOfText: this._snapshotIsStale(snap.generatedAt)',
  "              ? '本地数据 ' + this._formatSnapshotDate(snap.generatedAt) + ' · 正在同步实时赛程'",
  "              : '正在同步实时赛程'");

// 新增 _snapshotIsStale 工具方法（复用 SNAPSHOT_MAX_AGE_SEC）
const helper = [
  '',
  '  // ★ 2026-09-16：快照是否已过期（与 tryLocalUpcoming 的判定同口径，单一来源）',
  '  _snapshotIsStale(genAt) {',
  '    const t = Number(genAt) || 0;',
  '    if (!t) return true;                       // 无时间戳按过期处理',
  '    return (util.nowSec() - t) > SNAPSHOT_MAX_AGE_SEC;',
  '  },'
].join('\n');
// 插到 _formatSnapshotDate 之前
const i4 = G.findIndex((l) => at(l).indexOf('_formatSnapshotDate(genAt) {') >= 0);
if (i4 < 0) { console.log('❌ _formatSnapshotDate 锚点未找到，helper 未插入'); }
else { G.splice(i4, 0, helper); console.log('✅ Fix B：已加 _snapshotIsStale + 提示语分流'); }

fs.writeFileSync(P2, G.join('\n'));
execSync('node --check ' + P2, { stdio: 'pipe' });
console.log('✅ 两个文件语法 OK');

/* ===== 复核 ===== */
console.log('');
console.log('=== 关键点复核 ===');
[[P1, 'HOME_GRADES'], [P1, 'passGrade'], [P1, '⑥ 段候选**只取 S/A 级**'],
 [P2, '_snapshotIsStale'], [P2, "'正在同步实时赛程'"]].forEach(([f, k]) => {
  const c = fs.readFileSync(f, 'utf8');
  console.log((c.indexOf(k) >= 0 ? '✅ ' : '❌ ') + f.split('/').pop() + '  «' + k + '»');
});

/* ===== ESLint ===== */
for (const f of [P1, P2]) {
  try { execSync('npx eslint --rulesdir scripts/eslint-rules ' + f, { stdio: 'pipe' }); console.log('✅ ESLint: ' + f.split('/').pop()); }
  catch (e) {
    const errs = ((e.stdout || '') + (e.stderr || '')).split('\n').filter((x) => x.indexOf('error') >= 0 && x.indexOf('warning') < 0);
    console.log(errs.length ? '❌ ESLint ' + f.split('/').pop() + ': ' + errs.slice(0, 3).join(' | ') : '✅ ESLint: ' + f.split('/').pop() + '（仅 warning）');
  }
}

/* ===== 提交 ===== */
try {
  execSync('git add -A', { stdio: 'pipe' });
  execSync('git commit -F -', { input: [
    'v8.87: 修上线后 2 个问题 —— 首页只留 S/A + 快照提示语不再显陈旧日期',
    '',
    '## 问题2：首页「进行中」出现所有级别卡片（我 v8.79 补收录引起）',
    '根因：pages/index/index.js 的 ⑥段候选只排序（进行中优先）、**无级别过滤**；',
    '此前窗口内在赛的碰巧都是 S/A，故「看起来」只显示 S/A。',
    '我补了 7 个 B 级赛事（WINLINE S4 / EPL SEA S17 / European Pro League S40）且它们正在进行',
    '→ 「进行中优先」把它们排进前 5 → 首页冒出 B 级卡。**不是筛选 bug。**',
    '',
    '修法（产品决策：三段都只保留 S/A）',
    '- A1 _renderMatchFlow：dayMatches 增加 passGrade 过滤（HOME_GRADES = {S,A}），带剔除数日志',
    '- A2 ⑥段候选增加 S/A 过滤 → 同时减少 LP/Steam 赛程查询次数（对问题1 性能有正收益）',
    '- 仅影响首页；赛事列表页仍展示全部级别',
    '',
    '## 问题3：「本地数据 9月14日 · 正在同步实时赛程」造成数据陈旧感',
    '根因：leagues.js 快照秒开路径**无条件**带日期，而 v8.1 设计意图是「新快照不显示、过期(>7天)才提示」。',
    '修法：新增 _snapshotIsStale(genAt)（与 tryLocalUpcoming 同口径），',
    '  未过期 → 「正在同步实时赛程」（无日期）；已过期 → 「本地数据 X月X日 · 正在同步实时赛程」',
    '',
    '## 未处理',
    '问题1（首页变慢）：按用户要求**先量化再改**，待提供首次/二次打开耗时与 Console 耗时日志。'
  ].join('\n'), stdio: 'pipe' });
  console.log('');
  console.log('已提交: ' + execSync('git log --oneline -1', { encoding: 'utf8' }).trim());
} catch (e) { console.log('提交输出:\n' + ((e.stdout || '') + (e.stderr || '')).slice(-400)); }
