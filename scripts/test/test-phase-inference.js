// test-phase-inference.js —— 验证 phase 推断收紧（2026-08-22 修复）
// 覆盖四个症状的根因：
//   P1: haglund 未开赛对局不应判 live（开赛前 5min 内仍算 upcoming）
//   P2: haglund 已结束对局不应判 live（超 6h 应转 recent）
//   P3: haglund 刚开赛 <6h 应判 live（中间过渡态）
//   P4: 云函数 normalizeV3Match 相位推断规则（需云函数环境，此文件测 haglund 同口径逻辑）
//
// 核心规则（haglund normalizeMatch 同口径）：
//   start > nowSec + 5min        → upcoming
//   nowSec - 5min >= start, 且
//     elapsed < 6h               → live
//   elapsed >= 6h                → recent

var assert = require('assert');
var haglund = require('../../utils/haglund.js');

var MIN = 60;
var HOUR = 3600;

console.log('--- 测试 phase 推断收紧 ---');

// 用 haglund._normalizeMatch 注入 nowSec 测试各场景
// 形状：raw { id, teams:[{name},{name}], startsAt: ISO }, nowSec: number
function makeRaw(nameA, nameB, startUnixSec) {
  return {
    id: 'test-' + nameA + '-' + startUnixSec,
    teams: [{ name: nameA, url: '' }, { name: nameB, url: '' }],
    startsAt: new Date(startUnixSec * 1000).toISOString(),
    matchType: 'Bo3'
  };
}

// P1: 未开赛（开赛时间在未来 5min 以上）→ upcoming
(function () {
  var now = Math.floor(Date.now() / 1000);
  var start = now + 30 * MIN;  // 30 分钟后开赛
  var m = haglund._normalizeMatch(makeRaw('PARIVISION', 'Team Yandex', start), now);
  assert.strictEqual(m.phase, 'upcoming',
    'P1: 未开赛（未来 30min）应判 upcoming，实际 ' + m.phase);
  console.log('  P1 ✓ 未开赛对局判 upcoming（修复「进行中误判已开始」）');
})();

// P1.b: 开赛前 2 分钟（在 5min 缓冲内）→ 仍 upcoming（防时钟漂移）
(function () {
  var now = Math.floor(Date.now() / 1000);
  var start = now + 2 * MIN;
  var m = haglund._normalizeMatch(makeRaw('PARIVISION', 'Team Yandex', start), now);
  assert.strictEqual(m.phase, 'upcoming',
    'P1.b: 开赛前 2min 应仍在 upcoming 缓冲内，实际 ' + m.phase);
  console.log('  P1.b ✓ 开赛前 2min 仍判 upcoming（5min 时钟漂移缓冲）');
})();

// P2: 已结束（开赛超 6h）→ recent
(function () {
  var now = Math.floor(Date.now() / 1000);
  var start = now - 7 * HOUR;  // 7 小前开赛，应已结束
  var m = haglund._normalizeMatch(makeRaw('Nigma Galaxy', 'BetBoom Team', start), now);
  assert.strictEqual(m.phase, 'recent',
    'P2: 开赛超 6h 应判 recent，实际 ' + m.phase);
  console.log('  P2 ✓ 已结束（>6h）判 recent（修复「刚结束段出现进行中」）');
})();

// P3: 进行中（开赛 1h）→ live
(function () {
  var now = Math.floor(Date.now() / 1000);
  var start = now - 1 * HOUR;
  var m = haglund._normalizeMatch(makeRaw('Team Spirit', 'Team Liquid', start), now);
  assert.strictEqual(m.phase, 'live',
    'P3: 开赛 1h 应判 live，实际 ' + m.phase);
  console.log('  P3 ✓ 进行中（1h）判 live（中间过渡态正确）');
})();

// P4: 刚好 6h 边界 → recent（严格小于 6h 才算 live）
(function () {
  var now = Math.floor(Date.now() / 1000);
  var start = now - 6 * HOUR;
  var m = haglund._normalizeMatch(makeRaw('Edge Case', 'Border Team', start), now);
  assert.strictEqual(m.phase, 'recent',
    'P4: 开赛恰好 6h 应判 recent（边界），实际 ' + m.phase);
  console.log('  P4 ✓ 6h 边界判 recent');
})();

// P5: 刚好 5h59m → live
(function () {
  var now = Math.floor(Date.now() / 1000);
  var start = now - (6 * HOUR - MIN);
  var m = haglund._normalizeMatch(makeRaw('Edge Case 2', 'Border Team 2', start), now);
  assert.strictEqual(m.phase, 'live',
    'P5: 开赛 5h59m 应判 live（边界内），实际 ' + m.phase);
  console.log('  P5 ✓ 5h59m 判 live');
})();

console.log('--- 全部 6 条 phase 推断断言通过 ---');
