// test-bo3-split-fix.js —— 验证 BO3 被拆成两场 BO1 的修复
// 覆盖场景：
//   T1: haglund 返回 BO3 一条记录 → groupLiquipediaMatches 不拆分（保持 1 条）
//   T2: Steam Scheduled 返回 BO3 三局独立记录（series_id=0）→ 合并为 1 条
//   T3: BO3 跨 UTC 午夜（第一局 23:30、第二局 00:30）→ 合并为 1 条（修复前：拆成两场）
//   T4: 同队名同日两场不同 BO 系列（早场 BO1 + 晚场 BO3，间隔 >6h）→ 保持 2 条（防误并）
//   T5: 有效 series_id 的多条记录 → 按 series_id 合并（正向回归）
//   T6: series_id=0 的多条不同队名对阵 → 不会被合并成一桶（修复前 bug：全进 's_0'）
//   T7: TBD 占位场（一队为空）→ 不合并，保持独立
//   T8: 同队名同日两场 BO1（间隔 <6h）→ 合并为 1 条（避免过度切开）
//   T9: LPDB v3 无 bracket id 的 BO3 两局跨日 → 合并为 1 条

var assert = require('assert');
var sources = require('../../utils/sources.js');

function ts(hh, mm, base) {
  // base=某日 unix 秒，返回 base + hh:mm 的秒数
  return base + hh * 3600 + mm * 60;
}

var DAY = 86400;
var BASE = Math.floor(Date.UTC(2026, 7, 20) / 1000);  // 2026-08-20 00:00 UTC

console.log('--- 测试 BO3 拆分修复 ---');

// T1: haglund 单条 BO3 记录不拆分
(function () {
  var matches = [{
    team1Name: 'Iron Wing', team2Name: 'Team Spirit',
    startTime: BASE + 10 * 3600, start_time: BASE + 10 * 3600,
    boType: 'BO3', boDeclared: true, phase: 'live',
    series_id: null, matchIds: [], _source: 'haglund'
  }];
  var out = sources.groupLiquipediaMatches(matches);
  assert.strictEqual(out.length, 1, 'T1: haglund 单条 BO3 不应被拆分');
  assert.strictEqual(out[0].boType, 'BO3', 'T1: boType 保留');
  console.log('  T1 ✓ haglund 单条 BO3 保持 1 条');
})();

// T2: Steam Scheduled BO3 三局独立记录（series_id=0）
(function () {
  var matches = [
    { team1Name: 'Iron Wing', team2Name: 'Team Spirit', startTime: BASE + 10*3600, start_time: BASE + 10*3600, series_id: 0, match_id: 'g1', boType: null, phase: 'upcoming' },
    { team1Name: 'Iron Wing', team2Name: 'Team Spirit', startTime: BASE + 11*3600, start_time: BASE + 11*3600, series_id: 0, match_id: 'g2', boType: null, phase: 'upcoming' },
    { team1Name: 'Iron Wing', team2Name: 'Team Spirit', startTime: BASE + 12*3600, start_time: BASE + 12*3600, series_id: 0, match_id: 'g3', boType: null, phase: 'upcoming' }
  ];
  var out = sources.groupLiquipediaMatches(matches);
  assert.strictEqual(out.length, 1, 'T2: Steam Scheduled BO3 三局应合并为 1 条（实际 ' + out.length + '）');
  console.log('  T2 ✓ Steam Scheduled BO3 三局合并为 1 条');
})();

// T3: BO3 跨 UTC 午夜（关键修复点）
(function () {
  var matches = [
    { team1Name: 'Iron Wing', team2Name: 'Team Spirit', startTime: BASE - 30*60, start_time: BASE - 30*60, series_id: 0, match_id: 'g1', boType: null, phase: 'upcoming' },  // 前一天 23:30
    { team1Name: 'Iron Wing', team2Name: 'Team Spirit', startTime: BASE + 30*60, start_time: BASE + 30*60, series_id: 0, match_id: 'g2', boType: null, phase: 'upcoming' }   // 当天 00:30
  ];
  var out = sources.groupLiquipediaMatches(matches);
  assert.strictEqual(out.length, 1, 'T3: 跨 UTC 午夜 BO3 应合并为 1 条（实际 ' + out.length + '）—— 这是本次修复的核心场景');
  console.log('  T3 ✓ 跨 UTC 午夜 BO3 合并为 1 条（核心修复）');
})();

// T4: 同队名同日两场不同 BO 系列（间隔 >6h）→ 应保持 2 条
(function () {
  var matches = [
    { team1Name: 'Team A', team2Name: 'Team B', startTime: BASE + 2*3600, start_time: BASE + 2*3600, series_id: 0, match_id: 'm1', boType: 'BO1', phase: 'recent' },  // 早 02:00 BO1
    { team1Name: 'Team A', team2Name: 'Team B', startTime: BASE + 14*3600, start_time: BASE + 14*3600, series_id: 0, match_id: 'm2', boType: 'BO3', phase: 'upcoming' }  // 晚 14:00 BO3，间隔 12h
  ];
  var out = sources.groupLiquipediaMatches(matches);
  assert.strictEqual(out.length, 2, 'T4: 间隔 >6h 的同队名两场应保持 2 条（实际 ' + out.length + '）');
  console.log('  T4 ✓ 间隔 >6h 同队名保持独立（防误并）');
})();

// T5: 有效 series_id 合并（正向回归）
(function () {
  var matches = [
    { team1Name: 'Team X', team2Name: 'Team Y', startTime: BASE + 10*3600, start_time: BASE + 10*3600, series_id: 'lp_bracket_r1', match_id: 'a', boType: 'BO3', phase: 'recent', score1: 1, score2: 0 },
    { team1Name: 'Team X', team2Name: 'Team Y', startTime: BASE + 11*3600, start_time: BASE + 11*3600, series_id: 'lp_bracket_r1', match_id: 'b', boType: 'BO3', phase: 'recent', score1: 2, score2: 0 }
  ];
  var out = sources.groupLiquipediaMatches(matches);
  assert.strictEqual(out.length, 1, 'T5: 同 series_id 合并为 1 条');
  console.log('  T5 ✓ 同 series_id 合并正常（正向回归）');
})();

// T6: series_id=0 不同队名对阵不合并（修复前 bug）
(function () {
  var matches = [
    { team1Name: 'Team A', team2Name: 'Team B', startTime: BASE + 10*3600, start_time: BASE + 10*3600, series_id: 0, match_id: 'x1', boType: 'BO3', phase: 'upcoming' },
    { team1Name: 'Team C', team2Name: 'Team D', startTime: BASE + 11*3600, start_time: BASE + 11*3600, series_id: 0, match_id: 'x2', boType: 'BO3', phase: 'upcoming' }
  ];
  var out = sources.groupLiquipediaMatches(matches);
  assert.ok(out.length >= 2, 'T6: series_id=0 不同队名不应合并成一桶（实际 ' + out.length + '）');
  console.log('  T6 ✓ series_id=0 不同队名保持独立（修复前 bug）');
})();

// T7: TBD 占位场不合并
(function () {
  var matches = [
    { team1Name: 'TBD', team2Name: 'Team Spirit', startTime: BASE + 10*3600, start_time: BASE + 10*3600, series_id: 0, match_id: 't1', boType: 'BO3', phase: 'upcoming' },
    { team1Name: 'TBD', team2Name: 'Team Falcons', startTime: BASE + 11*3600, start_time: BASE + 11*3600, series_id: 0, match_id: 't2', boType: 'BO3', phase: 'upcoming' }
  ];
  var out = sources.groupLiquipediaMatches(matches);
  assert.ok(out.length >= 2, 'T7: TBD 占位场不应合并（实际 ' + out.length + '）');
  console.log('  T7 ✓ TBD 占位场保持独立');
})();

// T8: 同队名同日间隔 <6h 的两场应合并
(function () {
  var matches = [
    { team1Name: 'Team A', team2Name: 'Team B', startTime: BASE + 10*3600, start_time: BASE + 10*3600, series_id: 0, match_id: 'p1', boType: null, phase: 'upcoming' },
    { team1Name: 'Team A', team2Name: 'Team B', startTime: BASE + 11*3600, start_time: BASE + 11*3600, series_id: 0, match_id: 'p2', boType: null, phase: 'upcoming' }
  ];
  var out = sources.groupLiquipediaMatches(matches);
  assert.strictEqual(out.length, 1, 'T8: 间隔 <6h 同队名应合并（实际 ' + out.length + '）');
  console.log('  T8 ✓ 间隔 <6h 同队名合并正常');
})();

// T9: LPDB v3 无 bracket 的跨日 BO3
(function () {
  var matches = [
    { team1Name: 'Iron Wing', team2Name: 'Team Spirit', startTime: BASE - 60*60, start_time: BASE - 60*60, series_id: '', boType: 'BO3', phase: 'recent', score1: 1, score2: 0, match_id: 'p1' },
    { team1Name: 'Iron Wing', team2Name: 'Team Spirit', startTime: BASE + 60*60, start_time: BASE + 60*60, series_id: '', boType: 'BO3', phase: 'recent', score1: 2, score2: 0, match_id: 'p2' }
  ];
  var out = sources.groupLiquipediaMatches(matches);
  assert.strictEqual(out.length, 1, 'T9: LPDB 无 bracket 跨日 BO3 应合并（实际 ' + out.length + '）');
  console.log('  T9 ✓ LPDB 无 bracket 跨日 BO3 合并正常');
})();

// T10: LPDB bracketid 含局号后缀（如 lp_R02-M003-001 / lp_R02-M003-002）→ 合并为 1 条
//   场景：LPDB v3 给同一 BO3 的各局分配独立 bracketid（含 -001/-002 局号）
//   修复前：keyOf 返回 's_lp_R02-M003-001' 与 's_lp_R02-M003-002' → 拆分
//   修复后：剥离局号后缀 → 都返回 's_lp_R02-M003' → 合并
(function () {
  var matches = [
    { team1Name: 'Iron Wing', team2Name: 'Team Spirit', startTime: BASE + 10*3600, start_time: BASE + 10*3600, series_id: 'lp_R02-M003-001', match_id: 'g1', boType: 'BO3', phase: 'recent', score1: 1, score2: 0 },
    { team1Name: 'Iron Wing', team2Name: 'Team Spirit', startTime: BASE + 11*3600, start_time: BASE + 11*3600, series_id: 'lp_R02-M003-002', match_id: 'g2', boType: 'BO3', phase: 'recent', score1: 2, score2: 0 }
  ];
  var out = sources.groupLiquipediaMatches(matches);
  assert.strictEqual(out.length, 1, 'T10: LPDB bracketid 含局号后缀应合并（实际 ' + out.length + '）');
  console.log('  T10 ✓ LPDB bracketid 局号后缀剥离（关键修复）');
})();

// T11: match2id 不同的 bracket 内不同系列不应合并
//   场景：同一个 bracket（如 Round 2）内有多场不同系列（A vs B、C vs D）
//   修复：用 match2id 作主键（同系列共享），不同 match2id 不合并
(function () {
  var matches = [
    { team1Name: 'Iron Wing', team2Name: 'Team Spirit', startTime: BASE + 10*3600, start_time: BASE + 10*3600, series_id: 'lp_m1001', match_id: 'g1', boType: 'BO3', phase: 'recent' },
    { team1Name: 'Nigma Galaxy', team2Name: 'Boom Boys', startTime: BASE + 11*3600, start_time: BASE + 11*3600, series_id: 'lp_m1002', match_id: 'g2', boType: 'BO3', phase: 'recent' }
  ];
  var out = sources.groupLiquipediaMatches(matches);
  assert.strictEqual(out.length, 2, 'T11: 不同 match2id 不应合并（实际 ' + out.length + '）');
  console.log('  T11 ✓ 不同 match2id 保持独立');
})();

// ★ T12（2026-08-22 新增）：series_id='0'（字符串）应视为无效，走队名对兜底
//   场景：Steam LIVE 经 JSON 序列化后 series_id 从数字 0 变成字符串 '0'
//   修复前：'0' 被当成有效 series_id → 所有 '0' 合并到同一桶 s_0（跨队名混合）
//   修复后：'0' 视为无效 → 走归一化队名对兜底
(function () {
  var matches = [
    { team1Name: 'Team A', team2Name: 'Team B', startTime: BASE + 10*3600, start_time: BASE + 10*3600, series_id: '0', match_id: 'g1', boType: 'BO3', phase: 'recent' },
    { team1Name: 'Team A', team2Name: 'Team B', startTime: BASE + 11*3600, start_time: BASE + 11*3600, series_id: '0', match_id: 'g2', boType: 'BO3', phase: 'recent' },
    { team1Name: 'Team C', team2Name: 'Team D', startTime: BASE + 12*3600, start_time: BASE + 12*3600, series_id: '0', match_id: 'g3', boType: 'BO3', phase: 'recent' }
  ];
  var out = sources.groupLiquipediaMatches(matches);
  assert.strictEqual(out.length, 2, 'T12: 字符串 "0" 视为无效，按队名对分组合并（实际 ' + out.length + '）');
  console.log('  T12 ✓ series_id="0" 字符串视为无效');
})();

// ★ T13（2026-08-22 新增）：归一化队名对——后缀差异不切开
//   场景：Steam LIVE 用 "Nigma Galaxy"，haglund 用 "Nigma Galaxy Esports"
//   修复前：toLowerCase + sort 后 "nigma galaxy" vs "nigma galaxy esports" → 不同键 → 拆分
//   修复后：去后缀归一化 → 同一键 → 合并
(function () {
  var matches = [
    { team1Name: 'Iron Wing', team2Name: 'Team Spirit', startTime: BASE + 10*3600, start_time: BASE + 10*3600, series_id: null, match_id: 'g1', boType: 'BO3', phase: 'recent' },
    { team1Name: 'Iron Wing Esports', team2Name: 'Team Spirit', startTime: BASE + 11*3600, start_time: BASE + 11*3600, series_id: null, match_id: 'g2', boType: 'BO3', phase: 'recent' }
  ];
  var out = sources.groupLiquipediaMatches(matches);
  assert.strictEqual(out.length, 1, 'T13: 后缀差异（Esports）不切开同队名对（实际 ' + out.length + '）');
  console.log('  T13 ✓ 归一化队名对——后缀差异不切开');
})();

// ★ T14（2026-08-22 新增）：双向排序兜底键——队名换边仍合并
//   场景：第一局 team1=Iron Wing team2=Spirit，第二局反过来（数据源换边）
//   修复前：sort 按原始字符串 → "iron wing|spirit" vs "spirit|iron wing" → 不同键 → 拆分
//   修复后：归名排序后双向一致 → 合并
(function () {
  var matches = [
    { team1Name: 'Iron Wing', team2Name: 'Team Spirit', startTime: BASE + 10*3600, start_time: BASE + 10*3600, series_id: null, match_id: 'g1', boType: 'BO3', phase: 'recent' },
    { team1Name: 'Team Spirit', team2Name: 'Iron Wing', startTime: BASE + 11*3600, start_time: BASE + 11*3600, series_id: null, match_id: 'g2', boType: 'BO3', phase: 'recent' }
  ];
  var out = sources.groupLiquipediaMatches(matches);
  assert.strictEqual(out.length, 1, 'T14: 队名换边仍合并（实际 ' + out.length + '）');
  console.log('  T14 ✓ 双向排序兜底键——队名换边仍合并');
})();

console.log('--- 全部 14 条断言通过 ---');
