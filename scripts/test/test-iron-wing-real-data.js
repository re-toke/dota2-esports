// 诊断脚本：基于 OpenDota TI 2026 (leagueid=19719) 的真实数据复现 Iron Wing vs Spirit 拆分 BUG
// 真实数据（2026-08-20 实测自 https://api.opendota.com/api/leagues/19719/matches）：
//   局 1：match_id=8955197224, series_id=null, series_type=null, Spirit(radiant) vs Iron Wing(dire), radiant_win=true, t=2026-08-20T02:36
//   局 2：match_id=8955247801, series_id=1132142, series_type=1, Iron Wing(radiant) vs Spirit(dire), radiant_win=false, t=2026-08-20T04:12
// 期望：groupSeries 合并为 1 张 BO3 卡（series_id=1132142）；修复前应为 2 张独立 BO1。
// 队 ID 映射（实测）：10150413=Iron Wing，7119388=Team Spirit
'use strict';
var assert = require('assert');
var sources = require('../../utils/sources.js');

console.log('=== Iron Wing vs Spirit 真实数据诊断（根因 G：单局邻居 + null series_id）===\n');

var SPIRIT = 7119388, IW = 10150413;
var T1 = Date.parse('2026-08-20T02:36:29Z') / 1000;
var T2 = Date.parse('2026-08-20T04:12:03Z') / 1000;

var realMatches = [
  {
    match_id: 8955197224,
    series_id: null,           // ★ null - 这是拆分的根因
    series_type: null,
    radiant_team_id: SPIRIT,   // Spirit radiant
    dire_team_id: IW,
    radiant_team_name: null,   // OpenDota TI 主赛事队名恒 null
    dire_team_name: null,
    radiant_win: true,         // Spirit 赢（Spirit 2:0 Iron Wing 的局 1）
    start_time: T1,
    duration: 2400
  },
  {
    match_id: 8955247801,
    series_id: 1132142,        // ★ 有效 sid - 但 count=1（仅此一场属于该 sid）
    series_type: 1,            // BO3
    radiant_team_id: IW,       // 换边：Iron Wing radiant
    dire_team_id: SPIRIT,
    radiant_team_name: null,
    dire_team_name: null,
    radiant_win: false,        // Spirit 赢（Spirit 2:0 Iron Wing 的局 2）
    start_time: T2,
    duration: 2100
  }
];

console.log('输入 matches:');
realMatches.forEach(function(m) {
  console.log('  mid=' + m.match_id + ' sid=' + m.series_id + ' st=' + m.series_type +
    ' r=' + m.radiant_team_id + ' d=' + m.dire_team_id + ' win=' + m.radiant_win);
});

var series = sources.groupSeries(realMatches);
console.log('\ngroupSeries 产出: ' + series.length + ' 个系列');
series.forEach(function(s, i) {
  console.log('  系列' + i + ': games=' + s.games.length +
    ' scoreA=' + s.scoreA + ' scoreB=' + s.scoreB);
});

// === 核心断言 ===
assert.strictEqual(series.length, 1,
  'Iron Wing vs Spirit BO3 应合并为 1 系列（实际 ' + series.length + '）→ 根因 G 未修复！');
assert.strictEqual(series[0].games.length, 2, '合并后应含 2 局');

// 比分验证：Spirit 2:0 Iron Wing（局 1 radiant_win=true radiant=Spirit → Spirit 赢；局 2 radiant_win=false radiant=IW → dire=Spirit 赢）
// groupSeries 锚定首场 radiant_team_id（=SPIRIT）为 teamA：
//   局 1：radiant_win=true → winnerId = radiant_team_id = SPIRIT → teamA++（Spirit 得 1 分）
//   局 2：radiant_win=false → winnerId = dire_team_id = SPIRIT → teamA++（Spirit 得 1 分）
// → scoreA=2 (Spirit), scoreB=0 (Iron Wing)
assert.strictEqual(series[0].scoreA, 2, 'Spirit 应得 2 分（实际 ' + series[0].scoreA + '）');
assert.strictEqual(series[0].scoreB, 0, 'Iron Wing 应得 0 分（实际 ' + series[0].scoreB + '）');

console.log('\n✓ 根因 G 修复验证通过：合并为 1 张 BO3 卡，比分 Spirit 2:0 Iron Wing');

// === 回归测试：独立的 BO1 不应被误并 ===
console.log('\n--- 回归 A：两场同队但对阵独立的 BO1 不应被误并 ---');
var T_A1 = Date.parse('2026-08-20T01:00:00Z') / 1000;
var T_A2 = Date.parse('2026-08-20T08:00:00Z') / 1000;  // 间隔 7h（>6h 上限）
var bo1Matches = [
  { match_id: 1, series_id: null, series_type: 0, radiant_team_id: IW, dire_team_id: SPIRIT, radiant_win: true, start_time: T_A1, duration: 1800 },
  { match_id: 2, series_id: null, series_type: 0, radiant_team_id: SPIRIT, dire_team_id: IW, radiant_win: false, start_time: T_A2, duration: 2000 }
];
var bo1Series = sources.groupSeries(bo1Matches);
console.log('  独立 BO1 产出: ' + bo1Series.length + ' 个系列（期望 2）');
bo1Series.forEach(function(s, i) {
  console.log('    系列' + i + ': games=' + s.games.length + ' scoreA=' + s.scoreA + ' scoreB=' + s.scoreB);
});
assert.strictEqual(bo1Series.length, 2, '独立 BO1（series_type=0）不应被误并');

console.log('  回归 A ✓\n');

// === 回归测试：同队对、同日、时间相邻但其中一局 series_type=null 的也不应误并（守卫） ===
console.log('--- 回归 B：series_type=null 的局不参与借邻居（防 BO1 数据异常被误并到邻居 BO3）---');
var T_B1 = Date.parse('2026-08-20T03:00:00Z') / 1000;
var T_B2 = Date.parse('2026-08-20T04:00:00Z') / 1000;
var T_B3 = Date.parse('2026-08-20T05:00:00Z') / 1000;
var mixMatches = [
  // 真实 BO3 两局
  { match_id: 100, series_id: 999, series_type: 1, radiant_team_id: IW, dire_team_id: SPIRIT, radiant_win: true, start_time: T_B2, duration: 1800 },
  { match_id: 101, series_id: 999, series_type: 1, radiant_team_id: SPIRIT, dire_team_id: IW, radiant_win: true, start_time: T_B3, duration: 1800 },
  // 无关 BO1（另一对队伍），series_type=null 且时间夹在中间
  { match_id: 102, series_id: null, series_type: null, radiant_team_id: 2163, dire_team_id: 8255888, radiant_win: false, start_time: T_B1, duration: 1800 }
];
var mixSeries = sources.groupSeries(mixMatches);
console.log('  混合输入产出: ' + mixSeries.length + ' 个系列（期望 2：1 个 IW vs Spirit BO3 + 1 个 Liquid vs Boom 独立 BO1）');
mixSeries.forEach(function(s, i) {
  console.log('    系列' + i + ': games=' + s.games.length + ' rId=' + (s.games[0]||{}).radiant_team_id + ' dId=' + (s.games[0]||{}).dire_team_id);
});
assert.strictEqual(mixSeries.length, 2, '无关 BO1 不应被并入其他 series');
console.log('  回归 B ✓\n');

console.log('=== 全部通过 ===');
