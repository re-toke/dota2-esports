// scripts/test/test-steam-live-phase.js
// 测试云函数 normalizeSteamLiveGame 的 phase 结束判定
// ★ 2026-08-22 新增：覆盖「已结束比赛卡在进行中」修复
//
// 运行：node scripts/test/test-steam-live-phase.js
// 通过条件：全 6 条断言通过，零 console.error。

var assert = require('assert');

// 复刻 normalizeSteamLiveGame 的 phase 推断核心逻辑
// （云函数本体无法在本地直接 require，此处抽出纯函数供测试）
function inferPhase(score1, score2, seriesType) {
  var phase = 'live';
  var totalScore = score1 + score2;
  if (seriesType != null && seriesType >= 0) {
    var boNum = [1, 3, 5, 2, 7][seriesType] || (seriesType * 2 + 1);
    var winsToClinch = Math.ceil(boNum / 2);
    if (Math.max(score1, score2) >= winsToClinch) {
      phase = 'recent';
    }
  } else if (totalScore >= 6) {
    phase = 'recent';
  }
  return phase;
}

console.log('--- test-steam-live-phase.js · normalizeSteamLiveGame 比分结束判定 ---');

// T1: BO3 比分 2:0 → 已结束（series_type=1）
(function () {
  var phase = inferPhase(2, 0, 1);
  assert.strictEqual(phase, 'recent', 'T1: BO3 2:0 应判 recent（实际 ' + phase + '）');
  console.log('  T1 ✓ BO3 2:0 已结束');
})();

// T2: BO3 比分 1:0 → 仍在进行（系列未决出胜负）
(function () {
  var phase = inferPhase(1, 0, 1);
  assert.strictEqual(phase, 'live', 'T2: BO3 1:0 应判 live（实际 ' + phase + '）');
  console.log('  T2 ✓ BO3 1:0 仍在进行');
})();

// T3: BO3 比分 2:1 → 已结束（需 2 胜）
(function () {
  var phase = inferPhase(2, 1, 1);
  assert.strictEqual(phase, 'recent', 'T3: BO3 2:1 应判 recent（实际 ' + phase + '）');
  console.log('  T3 ✓ BO3 2:1 已结束');
})();

// T4: BO5 比分 2:1 → 仍在进行（需 3 胜）
(function () {
  var phase = inferPhase(2, 1, 2);
  assert.strictEqual(phase, 'live', 'T4: BO5 2:1 应判 live（实际 ' + phase + '）');
  console.log('  T4 ✓ BO5 2:1 仍在进行');
})();

// T5: BO5 比分 3:0 → 已结束（需 3 胜）
(function () {
  var phase = inferPhase(3, 0, 2);
  assert.strictEqual(phase, 'recent', 'T5: BO5 3:0 应判 recent（实际 ' + phase + '）');
  console.log('  T5 ✓ BO5 3:0 已结束');
})();

// T6: BO1 比分 1:0 → 已结束（series_type=0，需 1 胜）
(function () {
  var phase = inferPhase(1, 0, 0);
  assert.strictEqual(phase, 'recent', 'T6: BO1 1:0 应判 recent（实际 ' + phase + '）');
  console.log('  T6 ✓ BO1 1:0 已结束');
})();

// T7: series_type 缺失但比分 7:0 → 兜底判已结束（totalScore >= 6）
(function () {
  var phase = inferPhase(7, 0, null);
  assert.strictEqual(phase, 'recent', 'T7: series_type 缺失但 7:0 应判 recent（实际 ' + phase + '）');
  console.log('  T7 ✓ 兜底判定（totalScore >= 6）');
})();

// T8: series_type 缺失且比分 2:1 → 保持 live（未触发兜底阈值）
(function () {
  var phase = inferPhase(2, 1, null);
  assert.strictEqual(phase, 'live', 'T8: series_type 缺失但 2:1 应判 live（实际 ' + phase + '）');
  console.log('  T8 ✓ series_type 缺失时不触发误判');
})();

console.log('--- 全部 8 条断言通过 ---');
