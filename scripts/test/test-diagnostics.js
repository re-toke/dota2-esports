#!/usr/bin/env node
/**
 * P0-B 数据质量指标（SLO）单测 + **SLO/代码阈值漂移守卫**（2026-09-26）
 *
 * 覆盖：
 *   ① `utils/seriesStatus.js` 的终局判据（唯一纯实现，P0-A 将把 ~10 处调用点收敛到它）
 *   ② `utils/diagnostics.js` 的四项准确性指标计数（含 2026-09-25 首页事故的量化口径）
 *   ③ ★ 漂移守卫：SLO 里的阈值必须与**代码里的实际阈值**保持一致 ——
 *      读源码取常量（只允许数字与 `*`，不做 eval）再比对；
 *      改代码阈值不改 SLO、或反过来，本测试都会 FAIL。
 *
 * 运行：node scripts/test/test-diagnostics.js
 */
const fs = require('fs');
const path = require('path');
const seriesStatus = require('../../utils/seriesStatus.js');
const diag = require('../../utils/diagnostics.js');

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + '  ->  ' + (detail || '')); }
}
const ROOT = path.resolve(__dirname, '..', '..');

console.log('\n--- ① 终局判据（seriesStatus.isDecidedByScore）---');
assert('BO3 2:1 ⇒ 已终局', seriesStatus.isDecidedByScore(2, 1, 'BO3') === true);
assert('BO3 1:1 ⇒ 未终局（允许 LIVE）', seriesStatus.isDecidedByScore(1, 1, 'BO3') === false);
assert('BO3 0:2 ⇒ 已终局', seriesStatus.isDecidedByScore(0, 2, 'BO3') === true);
assert('BO1 1:0 ⇒ 未命中（比分上限 1，不误杀）', seriesStatus.isDecidedByScore(1, 0, 'BO1') === false);
assert('BO5 3:0 ⇒ 刻意不判（2/3 胜不足以终局，宁漏勿错）', seriesStatus.isDecidedByScore(3, 0, 'BO5') === false);
assert('BO2 2:0 ⇒ 刻意不判（双局积分制）', seriesStatus.isDecidedByScore(2, 0, 'BO2') === false);
assert('BO 未知 2:0 ⇒ 保守判终局（与 index.js 原实现一致）', seriesStatus.isDecidedByScore(2, 0, undefined) === true);
assert('0:0 ⇒ 不判（缺数据≠终局）', seriesStatus.isDecidedByScore(0, 0, 'BO3') === false);
assert('脏输入（null/字符串）不抛错', seriesStatus.isDecidedByScore(null, '2', 'BO3') === true);

console.log('\n--- ② 指标计数（diagnostics.computeCardMetrics）---');
const mkCard = (o) => Object.assign({ status: 'ended', scoreA: 0, scoreB: 0, bo: 'BO3' }, o);
const cards = [
  // 正常已结束（有比分）
  mkCard({ key: 's1', status: 'ended', scoreA: 2, scoreB: 1, teamA: { name: 'Team A' }, teamB: { name: 'Team B' } }),
  // ★ 2026-09-25 首页事故形态：已结束却 0:0
  mkCard({ key: 's2', status: 'ended', scoreA: 0, scoreB: 0, teamA: { name: 'Team C' }, teamB: { name: 'Team D' } }),
  // ★ 状态误判形态：BO3 比分 1:2 却仍 live
  mkCard({ key: 's3', status: 'live', scoreA: 1, scoreB: 2, teamA: { name: 'Team E' }, teamB: { name: 'Team F' } }),
  // 正常 LIVE（1:1 未终局）
  mkCard({ key: 's4', status: 'live', scoreA: 1, scoreB: 1, teamA: { name: 'Team G' }, teamB: { name: 'Team H' } }),
  // ★ 严格键重复：与 s1 同两队同主客
  mkCard({ key: 's1b', status: 'ended', scoreA: 2, scoreB: 1, teamA: { name: 'Team A' }, teamB: { name: 'Team B' } }),
  // 启发式身份（P0-A 才引入的字段，此处先验证会计数）
  mkCard({ key: 's5', status: 'upcoming', scoreA: 0, scoreB: 0, identitySource: 'heuristic', teamA: { name: 'Team I' }, teamB: { name: 'Team J' } }),
];
const m = diag.computeCardMetrics(cards);
assert('total=6', m.total === 6, '实际 ' + m.total);
assert('ended=3 / live=2 / upcoming=1', m.ended === 3 && m.live === 2 && m.upcoming === 1,
  JSON.stringify({ e: m.ended, l: m.live, u: m.upcoming }));
assert('★ 状态误判检出 1（比分达终局却 live）', m.statusMismatch === 1, '实际 ' + m.statusMismatch);
assert('★ 已结束无比分检出 1（0:0 口径）', m.endedNoScore === 1, '实际 ' + m.endedNoScore);
assert('已结束无比分率 = 1/3', Math.abs(m.endedNoScoreRate - 1 / 3) < 1e-9, '实际 ' + m.endedNoScoreRate);
assert('★ 严格键重复检出 1 组', m.dupGroupsStrict === 1, '实际 ' + m.dupGroupsStrict);
assert('启发式降级计数 1 / 已知 1', m.heuristic === 1 && m.heuristicKnown === 1,
  JSON.stringify({ h: m.heuristic, k: m.heuristicKnown }));
assert('启发式降级率 = 100%（仅 1 个已知）', m.heuristicRate === 1, '实际 ' + m.heuristicRate);
assert('达标判定：状态误判未达标（>0）', m.pass.statusMismatch === false);
assert('达标判定：已结束无比分率 33% > 1% ⇒ 未达标', m.pass.endedNoScore === false);

assert('空数组不抛错且比率返回 null', (function () {
  const e = diag.computeCardMetrics([]);
  return e.total === 0 && e.dupRateStrict === null && e.endedNoScoreRate === null;
})());
assert('null 输入不抛错', diag.computeCardMetrics(null).total === 0);
assert('formatSummary 返回一行且含关键字段', (function () {
  const s = diag.formatSummary(m);
  return s.indexOf('[diag][cards]') === 0 && s.indexOf('状态误判') > 0 && s.indexOf('已结束无比分') > 0;
})());
assert('formatSummary(空) 不抛错', diag.formatSummary(null).indexOf('[diag][cards]') === 0);
assert('formatDetails 返回明细数组', diag.formatDetails(m).length >= 3);

console.log('\n--- ②b 身份来源计数（P0-A 三态：authoritative / heuristic / standalone）---');
const idCards = [
  mkCard({ key: 'i1', identitySource: 'series_id', teamA: { name: 'A1' }, teamB: { name: 'B1' } }),
  mkCard({ key: 'i2', identitySource: 'heuristic', teamA: { name: 'A2' }, teamB: { name: 'B2' } }),
  mkCard({ key: 'i3', identitySource: 'standalone', teamA: { name: 'A3' }, teamB: { name: 'B3' } }),
  mkCard({ key: 'i4', teamA: { name: 'A4' }, teamB: { name: 'B4' } }),   // 未打标（旧数据/未接线）
];
const mi = diag.computeCardMetrics(idCards);
assert('权威 1 / 推断 1 / 单局 1', mi.heuristic === 1 && mi.standalone === 1 && mi.heuristicKnown === 3,
  JSON.stringify({ h: mi.heuristic, s: mi.standalone, k: mi.heuristicKnown }));
assert('★ 降级率 = 推断 ÷ 已打标 = 1/3', Math.abs(mi.heuristicRate - 1 / 3) < 1e-9, '实际 ' + mi.heuristicRate);
assert('未打标卡片**不计入分母**（total=4 / 已打标=3）⇒ 不虚报为 0% 也不稀释',
  mi.total === 4 && mi.heuristicKnown === 3, JSON.stringify({ t: mi.total, k: mi.heuristicKnown }));
assert('汇总一行含身份三态', diag.formatSummary(mi).indexOf('身份') > 0);

console.log('\n--- ③ ★ 单一事实源守卫（P1-19）：SLO 阈值与 config.timeWindow 同源 ---');
// P1-19 后，时间窗口值**只在 config.js 声明一次**；此处读 config 源码作「值守卫」（防被就地改坏）。
// 只允许「数字 * 数字」形态（不做 eval，避免执行任意代码）
function readConst(file, name) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const re = new RegExp('(?:const|var|let)\\s+' + name + '\\s*=\\s*([0-9]+(?:\\s*\\*\\s*[0-9]+)*)');
  const hit = src.match(re);
  if (!hit) return null;
  return hit[1].split('*').map((x) => Number(x.trim())).reduce((a, b) => a * b, 1);
}
const CFG = 'utils/config.js';
const liveStale = readConst(CFG, 'LIVE_STALE_MAX_SEC');
assert('能读到 config.js 的 LIVE_STALE_MAX_SEC（守卫前提）', liveStale !== null, '未匹配到常量');
assert('★ config LIVE_STALE_MAX_SEC == 3h（与 sources 降级口径一致）', liveStale === 3 * 3600, '实际 ' + liveStale);
assert('★ SLO 降级收敛延迟 == config LIVE_STALE_MAX_SEC（同源，' + liveStale + 's）',
  diag.SLO.statusConvergeDegradedSec.target === liveStale,
  'SLO=' + diag.SLO.statusConvergeDegradedSec.target + '  config=' + liveStale);
const snapTarget = readConst(CFG, 'SNAPSHOT_TARGET_AGE_SEC');
assert('能读到 config.js 的 SNAPSHOT_TARGET_AGE_SEC（守卫前提）', snapTarget !== null, '未匹配到常量');
assert('★ SLO 快照目标 == config SNAPSHOT_TARGET_AGE_SEC（同源）',
  diag.SLO.snapshotAgeSec.target === snapTarget, 'target=' + diag.SLO.snapshotAgeSec.target + ' config=' + snapTarget);
assert('★ 快照"目标 24h"取自 config（内置赛程/联赛快照已移除，SLO 尺子仍保留）',
  diag.SLO.snapshotAgeSec.target === 24 * 3600, 'target=' + diag.SLO.snapshotAgeSec.target);
assert('★ 硬判据收敛目标 5min 必须**严于**降级路径（否则口径自相矛盾）',
  diag.SLO.statusConvergeHardSec.target < diag.SLO.statusConvergeDegradedSec.target,
  JSON.stringify({ hard: diag.SLO.statusConvergeHardSec.target, deg: diag.SLO.statusConvergeDegradedSec.target }));
assert('重复卡率严格目标为 0', diag.SLO.dupCardRateStrict.target === 0);
assert('启发式降级率"只建基线不设阈值"（target 为 null）', diag.SLO.heuristicRate.target === null);

console.log('\n--- ④ P0-B 下半：消费方读取（recordLast / getLast）---');
assert('recordLast 前 getLast 为 null（内存态，重启即空）', diag.getLast() === null);
diag.recordLast(m, { source: 'test' });
const last = diag.getLast();
assert('recordLast 后可读回指标快照', !!last && !!last.metrics && last.metrics.total === m.total);
assert('快照带时间戳（供展示"多久前"）', typeof last.at === 'number' && last.at > 0);
assert('recordLast(null) 不覆盖已有快照', (function () {
  diag.recordLast(null);
  return !!diag.getLast();
})());

assert('formatPct：null → n/a，0.063 → 6.3%',
  diag.formatPct(null) === 'n/a' && diag.formatPct(0.063) === '6.3%',
  diag.formatPct(0.063));

console.log('\n--- ④b 管道指标（computePipelineMetrics，CI 与客户端共用）---');
const NOW0 = 1800000000;
const pm = diag.computePipelineMetrics([
  { name: '赛程快照', ts: NOW0 - 3600, count: 17 },      // 1 小时前（新）
  { name: '联赛快照', ts: NOW0 - 12 * 86400, count: 40 }, // 12 天前（旧）
], NOW0);
assert('取最旧快照为口径（赛程 1h vs 联赛 12d ⇒ 取 12d）',
  pm.oldest && pm.oldest.name === '联赛快照' && pm.ageSec === 12 * 86400,
  JSON.stringify({ oldest: pm.oldest && pm.oldest.name, ageSec: pm.ageSec }));
assert('★ 12 天 > 目标 24h ⇒ overTarget=true', pm.overTarget === true);
assert('ageText 可读（年长者用"天"）', pm.ageText === '12 天', pm.ageText);
assert('条目数汇总 = 17 + 40', pm.totalCount === 57, '实际 ' + pm.totalCount);
const pm2 = diag.computePipelineMetrics([{ name: '赛程快照', ts: NOW0 - 60, count: 5 }], NOW0);
assert('新鲜快照 ⇒ overTarget=false；ageText 用"分钟"',
  pm2.overTarget === false && pm2.ageText === '1 分钟', JSON.stringify({ o: pm2.overTarget, t: pm2.ageText }));
assert('空/非法输入不抛错且比率为 null', (function () {
  const a = diag.computePipelineMetrics([], NOW0);
  const b = diag.computePipelineMetrics(null, NOW0);
  const c = diag.computePipelineMetrics([{ name: 'x', ts: 0 }], NOW0);
  return a.ageSec === null && a.overTarget === false && b.ageSec === null && c.ageSec === null;
})());
assert('count 缺省不参与汇总也不报错', diag.computePipelineMetrics([{ name: 'x', ts: NOW0 - 10 }], NOW0).totalCount === 0);

console.log('\n--- ⑥ ★ 云端心跳三态：buildRemoteHealth（「无行」≠「连不上」）---');
// 背景（2026-09-26 一次真实误判）：改造前「CI 从未上报」与「Supabase 连不上」在界面上**完全同形**，
//   排查时误以为代码有 Bug、白跑一轮往返。本组守卫的核心就是**锁住这个区分**。
const NOW = 1790363346;   // 固定基准时刻（测试不得依赖当前时间）
const H = 3600;

// ① 无行 ⇒ missing（语义 =「查询成功但没有该行」= CI 从未上报 ⇒ **必须可见**）
const rMissing = diag.buildRemoteHealth(null, NOW);
assert('★ 无行 ⇒ state=missing（不可与"连不上"混同）', rMissing.state === 'missing',
  '实际=' + rMissing.state);
assert('★ 无行 ⇒ 文案含「尚无记录」+「未上报」',
  rMissing.text.indexOf('尚无记录') >= 0 && rMissing.text.indexOf('未上报') >= 0, rMissing.text);
assert('无行 ⇒ 不带 overdue/年龄（不伪造可信数字）',
  rMissing.overdue === undefined && rMissing.ageSec === undefined);

// ② 正常行
const rOk = diag.buildRemoteHealth(
  { key: 'diag_report', value: { at: NOW - 3 * H, head: '0923022', oldest: { name: '联赛快照' } } }, NOW);
assert('正常行 ⇒ state=ok', rOk.state === 'ok', '实际=' + rOk.state);
assert('正常行 ⇒ 年龄 3 小时', rOk.ageText === '3 小时', '实际=' + rOk.ageText);
assert('正常行 ⇒ 文案含「前」+ commit', rOk.text.indexOf('前') > 0 && rOk.text.indexOf('0923022') > 0, rOk.text);
assert('正常行 ⇒ 不标停摆', rOk.overdue === false && rOk.text.indexOf('停摆') < 0, rOk.text);
assert('正常行 ⇒ oldestName 透传', rOk.oldestName === '联赛快照');

// ③ 超阈值 ⇒ overdue
const rOld = diag.buildRemoteHealth({ value: { at: NOW - (diag.REMOTE_HEARTBEAT_OVERDUE_SEC + H) } }, NOW);
assert('★ 超阈值 ⇒ overdue=true 且文案含「疑似停摆」',
  rOld.overdue === true && rOld.text.indexOf('疑似停摆') >= 0, rOld.text);
// 边界：恰好等于阈值**不算**超（用 > 而非 >=，与 computePipelineMetrics.overTarget 同口径）
const rEdge = diag.buildRemoteHealth({ value: { at: NOW - diag.REMOTE_HEARTBEAT_OVERDUE_SEC } }, NOW);
assert('边界：恰好 24h ⇒ 不算停摆（口径与 overTarget 一致，用 >）', rEdge.overdue === false,
  'overdue=' + rEdge.overdue);

// ④ 行在但内容不成形 ⇒ invalid（**不可**误报成 missing）
const rInv1 = diag.buildRemoteHealth({ key: 'diag_report' }, NOW);
assert('★ 行在但无 value ⇒ state=invalid（不得误报"未上报"）',
  rInv1.state === 'invalid' && rInv1.text.indexOf('未上报') < 0, rInv1.state + ' / ' + rInv1.text);
const rInv2 = diag.buildRemoteHealth({ value: { head: 'abc' } }, NOW);
assert('★ 行在但缺 at ⇒ state=invalid', rInv2.state === 'invalid', '实际=' + rInv2.state);
assert('invalid 也不伪造年龄', rInv2.ageSec === undefined);

// ⑤ 时钟回拨保护（at 在未来）——不出现负年龄
const rFuture = diag.buildRemoteHealth({ value: { at: NOW + 5 * H } }, NOW);
assert('时钟回拨（at 在未来）⇒ 年龄夹到 0，不出现负数', rFuture.ageSec === 0, 'ageSec=' + rFuture.ageSec);

// ⑥ ★★ 源码级守卫：**「我的」页数据健康卡已于 2026-10-24 下线**
//    背景：内置快照移除后该卡无消费方，卡片整体删除（含云端心跳读取）。
//    守卫目的：防止有人只删模板、忘记删页面逻辑（或反之）留下半状态。
const fsrc = fs.readFileSync(path.join(ROOT, 'pages/follow/follow.js'), 'utf8');
assert('★ follow.js：数据健康卡已下线（不再读 diag_report 心跳）',
  fsrc.indexOf("'health.remote'") < 0 && fsrc.indexOf('buildRemoteHealth(') < 0 &&
  fsrc.indexOf("sb.rest('curation_meta'") < 0);
assert('★ follow.js：不再 require diagnostics（防半删除）',
  fsrc.indexOf("require('../../utils/diagnostics.js')") < 0);
const wsrc = fs.readFileSync(path.join(ROOT, 'pages/follow/follow.wxml'), 'utf8');
assert('★ follow.wxml：不再渲染「数据健康」卡',
  wsrc.indexOf('数据健康') < 0 && wsrc.indexOf('health.') < 0);

console.log('\n=== 结果 ===');
console.log('通过: ' + pass + '  失败: ' + fail);
if (fail) { console.log('存在失败 ❌'); process.exit(1); }
console.log('全部通过 ✅');
