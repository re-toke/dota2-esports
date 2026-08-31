// test-v3-series-id.js —— 验证云函数 normalizeV3Match 的 series_id 合成
//   背景：云函数 v3 query 必须请求 match2id 字段，否则 m.match2id 永远为空串，
//        导致上次修复形同虚设（仍走 match2bracketid fallback）。
//   本测试通过模拟 normalizeV3Match 的核心逻辑（不依赖云函数运行时），
//   验证 series_id 合成优先级与边界。
//
// 核心规则（与 cloudfunctions/aggregation/index.js normalizeV3Match 同口径）：
//   优先级：match2id（非空） > match2bracketid 剥离局号 > (队名对+UTC日) 兜底
//   ★ 关键：query 必须含 match2id，否则上游链路永远走 fallback

var assert = require('assert');

console.log('--- 测试云函数 v3 series_id 合成逻辑 ---');

// 模拟 normalizeV3Match 的 series_id 合成段（与 index.js L686-L693 同口径）
function synthSeriesId(m) {
  var m2id = m.match2id || '';
  var bracket = m.match2bracketid || '';
  var t1 = m.t1 || '';
  var t2 = m.t2 || '';
  var startTime = m.startTime || 0;
  var dayBucket = Math.floor(startTime / 86400);
  return m2id
    ? ('lp_m' + m2id)
    : (bracket
        ? ('lp_' + bracket.replace(/[-_\s]\d{2,3}$/, ''))
        : ('lp_' + (t1 || 'x') + '|' + (t2 || 'x') + '|' + dayBucket));
}

var DAY = 86400;
var BASE = Math.floor(Date.UTC(2026, 7, 22) / 1000);

// S1: 有 match2id → 用 lp_m{match2id}（优先级最高）
(function () {
  var sid = synthSeriesId({ match2id: '12345', match2bracketid: 'R02-M003', t1: 'Iron Wing', t2: 'Team Spirit', startTime: BASE });
  assert.strictEqual(sid, 'lp_m12345', 'S1: match2id 优先，实际 ' + sid);
  console.log('  S1 ✓ match2id 优先级最高');
})();

// S2: 无 match2id，有 bracketid（无局号后缀）→ 剥离后用 lp_{bracket}
(function () {
  var sid = synthSeriesId({ match2bracketid: 'R02-M003', t1: 'Iron Wing', t2: 'Team Spirit', startTime: BASE });
  assert.strictEqual(sid, 'lp_R02-M003', 'S2: bracketid 无后缀原样，实际 ' + sid);
  console.log('  S2 ✓ bracketid 无局号后缀保留原值');
})();

// S3: 无 match2id，有 bracketid 含局号后缀（-001/-002）→ 剥离后合并
(function () {
  var sid1 = synthSeriesId({ match2bracketid: 'R02-M003-001', t1: 'Iron Wing', t2: 'Team Spirit', startTime: BASE });
  var sid2 = synthSeriesId({ match2bracketid: 'R02-M003-002', t1: 'Iron Wing', t2: 'Team Spirit', startTime: BASE + 3600 });
  assert.strictEqual(sid1, sid2, 'S3: 同 BO3 不同局号的 bracketid 剥离后应相同（' + sid1 + ' vs ' + sid2 + '）');
  assert.strictEqual(sid1, 'lp_R02-M003', 'S3: 剥离后值正确');
  console.log('  S3 ✓ bracketid 局号后缀剥离（修复 BO3 拆分关键）');
})();

// S4: 无 match2id 也无 bracketid → 用 队名对+UTC日兜底
(function () {
  var sid = synthSeriesId({ t1: 'Team Spirit', t2: 'Team Liquid', startTime: BASE + 10 * 3600 });
  var expected = 'lp_Team Spirit|Team Liquid|' + Math.floor((BASE + 10 * 3600) / 86400);
  assert.strictEqual(sid, expected, 'S4: 兜底键正确，实际 ' + sid);
  console.log('  S4 ✓ 兜底键（队名对+UTC日）');
})();

// S5: 全空 → 兜底用 'x|x|日桶'
(function () {
  var sid = synthSeriesId({ startTime: BASE });
  assert.strictEqual(sid, 'lp_x|x|' + Math.floor(BASE / 86400), 'S5: 全空兜底正确，实际 ' + sid);
  console.log('  S5 ✓ 全空兜底（x|x|day）');
})();

// S6: bracketid 用下划线分隔的局号也能剥离
(function () {
  var sid1 = synthSeriesId({ match2bracketid: 'bracket_a_001', t1: 'X', t2: 'Y', startTime: BASE });
  var sid2 = synthSeriesId({ match2bracketid: 'bracket_a_002', t1: 'X', t2: 'Y', startTime: BASE });
  assert.strictEqual(sid1, sid2, 'S6: 下划线分隔局号也能剥离（' + sid1 + ' vs ' + sid2 + '）');
  console.log('  S6 ✓ 下划线分隔局号剥离');
})();

console.log('--- 全部 6 条 series_id 合成断言通过 ---');
