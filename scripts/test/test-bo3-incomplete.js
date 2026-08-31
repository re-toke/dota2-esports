// test-bo3-incomplete.js
// ★ 2026-08-22 根因 H 诊断：OpenDota 仅返回 BO3 已结算的第 1 局时，
//   单局不应被当成独立 BO1 卡显示在 RECENT 段，应判 phase='live'（系列仍在进行）。
// 真实场景：TI 2026 TEAM VISION vs Team Yandex BO3（sid=1132678 st=1），仅含 1 局已结算。

var assert = require('assert');
var sources = require('../../utils/sources.js');

var pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ FAIL: ' + name + (detail ? ' | ' + detail : '')); }
}

console.log('=== 根因 H：BO3 中途单局独立成 BO1 卡 ===\n');

// 场景 1：BO3 第 1 局已结算（1:0），OpenDota 仅返回这 1 局 → 应判 live
(function () {
  var T = Math.floor(Date.now() / 1000) - 30 * 60;  // 30min 前开始
  var matches = [
    { match_id: 8958842370, series_id: 1132678, series_type: 1,
      radiant_team_id: 10150538, dire_team_id: 9964962,
      radiant_team_name: null, dire_team_name: null,
      radiant_win: false, start_time: T, duration: 3163 }
  ];
  var series = sources.groupSeries(matches);
  ok('S1: 仅 1 局已结算(series_type=1) → 1 张卡', series.length === 1, 'series=' + series.length);
  ok('S1: phase 应为 live（系列仍进行）', series[0].phase === 'live', 'phase=' + series[0].phase);
  ok('S1: 比分 1:0', series[0].scoreA === 0 && series[0].scoreB === 1, 'A=' + series[0].scoreA + ' B=' + series[0].scoreB);
  ok('S1: BO 类型为 BO3', series[0].boType === 'BO3', 'boType=' + series[0].boType);
})();

console.log('');

// 场景 2：BO3 已结束 2:0（BO3 胜场条件达成）→ 应判 recent（不应误判 live）
(function () {
  var T1 = Math.floor(Date.now() / 1000) - 3 * 3600;
  var T2 = T1 + 2 * 3600;
  var matches = [
    { match_id: 1, series_id: 999, series_type: 1,
      radiant_team_id: 100, dire_team_id: 200,
      radiant_team_name: null, dire_team_name: null,
      radiant_win: true, start_time: T1, duration: 2000 },
    { match_id: 2, series_id: 999, series_type: 1,
      radiant_team_id: 100, dire_team_id: 200,
      radiant_team_name: null, dire_team_name: null,
      radiant_win: true, start_time: T2, duration: 1800 }
  ];
  var series = sources.groupSeries(matches);
  ok('S2: 已结束 BO3 2:0 → 1 张卡', series.length === 1);
  ok('S2: phase 应为 recent（比分决出胜负）', series[0].phase === 'recent', 'phase=' + series[0].phase);
  ok('S2: 比分 2:0', series[0].scoreA === 2 && series[0].scoreB === 0);
})();

console.log('');

// 场景 3：BO1 已结算（series_type=0）→ 应判 recent（不应被新规则影响）
(function () {
  var T = Math.floor(Date.now() / 1000) - 30 * 60;
  var matches = [
    { match_id: 3, series_id: 888, series_type: 0,
      radiant_team_id: 300, dire_team_id: 400,
      radiant_team_name: null, dire_team_name: null,
      radiant_win: true, start_time: T, duration: 2000 }
  ];
  var series = sources.groupSeries(matches);
  ok('S3: BO1 已结算 → phase 为 recent', series[0].phase === 'recent', 'phase=' + series[0].phase);
})();

console.log('');

// 场景 4：BO3 中途单局已结算，但结束超过 6h → 不强制 live（历史异常数据兜底）
(function () {
  var T = Math.floor(Date.now() / 1000) - 8 * 3600;  // 8h 前结束
  var matches = [
    { match_id: 5, series_id: 777, series_type: 1,
      radiant_team_id: 500, dire_team_id: 600,
      radiant_team_name: null, dire_team_name: null,
      radiant_win: true, start_time: T, duration: 2000 }
  ];
  var series = sources.groupSeries(matches);
  ok('S4: 超 6h 的 BO3 单局 → 不强制 live', series[0].phase === 'recent', 'phase=' + series[0].phase);
})();

console.log('');

// 场景 5：BO5 中途比分 1:0（未达 3 胜）→ 应判 live
(function () {
  var T = Math.floor(Date.now() / 1000) - 30 * 60;
  var matches = [
    { match_id: 6, series_id: 666, series_type: 2,
      radiant_team_id: 700, dire_team_id: 800,
      radiant_team_name: null, dire_team_name: null,
      radiant_win: true, start_time: T, duration: 2000 }
  ];
  var series = sources.groupSeries(matches);
  ok('S5: BO5 中途 1:0 → live', series[0].phase === 'live', 'phase=' + series[0].phase);
})();

console.log('');

// 场景 7：BO2 中途仅 1 局（1:0）→ 应判 live（BO2 必须打满 2 局才算结束）
(function () {
  var T = Math.floor(Date.now() / 1000) - 30 * 60;
  var matches = [
    { match_id: 20, series_id: 111, series_type: 3,
      radiant_team_id: 1000, dire_team_id: 2000,
      radiant_team_name: null, dire_team_name: null,
      radiant_win: true, start_time: T, duration: 2000 }
  ];
  var series = sources.groupSeries(matches);
  ok('S7: BO2 仅 1 局(1:0) → live', series[0].phase === 'live', 'phase=' + series[0].phase);
})();

console.log('');

// 场景 8：BO2 已打满 2 局（2:0 横扫）→ recent（不论胜负，打满即结束）
(function () {
  var T1 = Math.floor(Date.now() / 1000) - 2 * 3600;
  var T2 = T1 + 3600;
  var matches = [
    { match_id: 21, series_id: 222, series_type: 3,
      radiant_team_id: 1000, dire_team_id: 2000,
      radiant_team_name: null, dire_team_name: null,
      radiant_win: true, start_time: T1, duration: 2000 },
    { match_id: 22, series_id: 222, series_type: 3,
      radiant_team_id: 2000, dire_team_id: 1000,
      radiant_team_name: null, dire_team_name: null,
      radiant_win: false, start_time: T2, duration: 2000 }
  ];
  var series = sources.groupSeries(matches);
  ok('S8: BO2 打满 2 局 2:0 → recent', series[0].phase === 'recent', 'phase=' + series[0].phase);
  ok('S8: 比分 2:0', series[0].scoreA === 2 && series[0].scoreB === 0);
})();

console.log('');

// 场景 9：BO2 已打满 2 局（1:1 平局）→ recent
(function () {
  var T1 = Math.floor(Date.now() / 1000) - 2 * 3600;
  var T2 = T1 + 3600;
  var matches = [
    { match_id: 23, series_id: 333, series_type: 3,
      radiant_team_id: 1000, dire_team_id: 2000,
      radiant_team_name: null, dire_team_name: null,
      radiant_win: true, start_time: T1, duration: 2000 },
    { match_id: 24, series_id: 333, series_type: 3,
      radiant_team_id: 1000, dire_team_id: 2000,
      radiant_team_name: null, dire_team_name: null,
      radiant_win: false, start_time: T2, duration: 2000 }
  ];
  var series = sources.groupSeries(matches);
  ok('S9: BO2 打满 2 局平局 1:1 → recent', series[0].phase === 'recent', 'phase=' + series[0].phase);
})();

console.log('');

// 场景 6：BO5 已决出 3:1 → recent（不应被新规则误判）
(function () {
  var base = Math.floor(Date.now() / 1000) - 5 * 3600;
  var matches = [];
  for (var i = 0; i < 4; i++) {
    matches.push({
      match_id: 10 + i, series_id: 555, series_type: 2,
      radiant_team_id: 900, dire_team_id: 950,
      radiant_team_name: null, dire_team_name: null,
      radiant_win: i < 3, start_time: base + i * 3600, duration: 2000
    });
  }
  var series = sources.groupSeries(matches);
  ok('S6: BO5 3:1 已决出 → recent', series[0].phase === 'recent', 'phase=' + series[0].phase);
  ok('S6: 比分 3:1', series[0].scoreA === 3 && series[0].scoreB === 1, 'A=' + series[0].scoreA + ' B=' + series[0].scoreB);
})();

console.log('\n=== 结果 ===');
console.log('PASS: ' + pass + ', FAIL: ' + fail);
if (fail > 0) { process.exit(1); }
