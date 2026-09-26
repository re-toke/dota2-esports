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

console.log('\n--- ③ ★ 漂移守卫：SLO 阈值必须与代码常量一致 ---');
// 只允许「数字 * 数字」形态（不做 eval，避免执行任意代码）
function readConst(file, name) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const re = new RegExp('(?:const|var|let)\\s+' + name + '\\s*=\\s*([0-9]+(?:\\s*\\*\\s*[0-9]+)*)');
  const hit = src.match(re);
  if (!hit) return null;
  return hit[1].split('*').map((x) => Number(x.trim())).reduce((a, b) => a * b, 1);
}
const stale = readConst('utils/sources.js', 'STALE_LIVE_MAX_SEC');
assert('能读到 sources.js 的 STALE_LIVE_MAX_SEC（守卫前提）', stale !== null, '未匹配到常量');
assert('★ SLO 降级收敛延迟 == 代码 STALE_LIVE_MAX_SEC（' + stale + 's）',
  diag.SLO.statusConvergeDegradedSec.target === stale,
  'SLO=' + diag.SLO.statusConvergeDegradedSec.target + '  code=' + stale);
const snap = readConst('pages/leagues/leagues.js', 'SNAPSHOT_MAX_AGE_SEC');
assert('能读到 leagues.js 的 SNAPSHOT_MAX_AGE_SEC（守卫前提）', snap !== null, '未匹配到常量');
assert('★ SLO 降级阈值 == 代码 SNAPSHOT_MAX_AGE_SEC（' + snap + 's）', snap === 7 * 86400, '实际 ' + snap);
assert('★ 快照"目标 24h"必须**严于**"降权阈值 7d"（两者语义不同，不可混用）',
  diag.SLO.snapshotAgeSec.target === 24 * 3600 && diag.SLO.snapshotAgeSec.target < snap,
  'target=' + diag.SLO.snapshotAgeSec.target + '  threshold=' + snap);
assert('★ 硬判据收敛目标 5min 必须**严于**降级路径（否则口径自相矛盾）',
  diag.SLO.statusConvergeHardSec.target < diag.SLO.statusConvergeDegradedSec.target,
  JSON.stringify({ hard: diag.SLO.statusConvergeHardSec.target, deg: diag.SLO.statusConvergeDegradedSec.target }));
assert('重复卡率严格目标为 0', diag.SLO.dupCardRateStrict.target === 0);
assert('启发式降级率"只建基线不设阈值"（target 为 null）', diag.SLO.heuristicRate.target === null);

console.log('\n=== 结果 ===');
console.log('通过: ' + pass + '  失败: ' + fail);
if (fail) { console.log('存在失败 ❌'); process.exit(1); }
console.log('全部通过 ✅');
