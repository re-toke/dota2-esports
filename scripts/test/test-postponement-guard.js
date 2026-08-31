// test-postponement-guard.js
// ★ 2026-08-22 根因 J 诊断：顺延场景下，规划时间已到但实际未开赛的对局，
//   不应被误判为 LIVE，应保持 UPCOMING。
//
// 真实场景（TI 2026）：前场 TEAM VISION vs Team Yandex BO3 仍在进行（1:0），
// 后场 BoomBoys vs Team Spirit 规划时间已到但因前场顺延未开赛。
//
// 本脚本模拟 league-detail.js LIVE 段守卫的核心逻辑（实际开赛证据守卫·方案 A），
// 不依赖 league-detail.js 整体（需 wx 运行时），直接抽离守卫函数做纯函数测试。

var assert = require('assert');

var pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 FAIL: ' + name + (detail ? ' | ' + detail : '')); }
}

// ★ 抽离 league-detail.js LIVE 段守卫核心逻辑（方案 A：实际开赛证据守卫）
//   参数与 liqSeries / openDota series 字段对齐
function liveGuard(s, fmtNowSec) {
  fmtNowSec = fmtNowSec || Math.floor(Date.now() / 1000);
  if (s.phase !== 'live') return s.phase;
  var st = s.lastTime || (s.startTime ? s.startTime : 0);
  if (!st) return 'upcoming';
  var elapsedLive = fmtNowSec - st;
  if (!(elapsedLive >= -60 && elapsedLive < 6 * 3600)) return 'upcoming';

  // 实际开赛证据守卫（方案 A 核心）
  var _hasKickoffProof = false;
  var _s1 = typeof s.score1 === 'number' ? s.score1 : 0;
  var _s2 = typeof s.score2 === 'number' ? s.score2 : 0;
  var _scoreA = typeof s.scoreA === 'number' ? s.scoreA : 0;
  var _scoreB = typeof s.scoreB === 'number' ? s.scoreB : 0;
  if ((_s1 + _s2) > 0 || (_scoreA + _scoreB) > 0) _hasKickoffProof = true;
  if (!_hasKickoffProof && Array.isArray(s.matchIds) && s.matchIds.length > 0) {
    var _firstMid = s.matchIds[0];
    if (typeof _firstMid === 'number' && _firstMid > 0) _hasKickoffProof = true;
  }
  if (!_hasKickoffProof && Array.isArray(s.games) && s.games.length > 0) {
    for (var gi = 0; gi < s.games.length; gi++) {
      var _g = s.games[gi];
      if (_g && (_g.radiant_win != null || (_g.start_time && _g.start_time <= fmtNowSec + 60))) {
        _hasKickoffProof = true;
        break;
      }
    }
  }
  var PROVISIONAL_GRACE_SEC = 15 * 60;
  if (!_hasKickoffProof && (fmtNowSec - st) >= PROVISIONAL_GRACE_SEC) {
    _hasKickoffProof = true;
  }
  if (!_hasKickoffProof) return 'upcoming';

  // 比分结束判定
  if (_s1 + _s2 > 0) {
    var _boNum = 0;
    if (s.boType && /^BO\s*([1-9])$/i.test(s.boType)) {
      _boNum = parseInt(RegExp.$1, 10);
    } else if (s.seriesType != null && s.seriesType >= 0) {
      _boNum = [1, 3, 5, 2, 7][s.seriesType] || 0;
    }
    if (_boNum > 0) {
      var _winsToClinch = Math.ceil(_boNum / 2);
      if (Math.max(_s1, _s2) >= _winsToClinch) return 'recent';
    }
  }
  return 'live';
}

console.log('=== 根因 J：顺延误判·实际开赛证据守卫（方案 A）===\n');

// 场景 1：顺延——前场仍在打，后场规划时间刚到（无任何证据）→ 应保持 UPCOMING
(function () {
  var now = Math.floor(Date.now() / 1000);
  var startJustNow = now - 3 * 60;  // 规划时间 3 分钟前已到，但实际未开赛
  var s = {
    phase: 'live',
    lastTime: startJustNow,
    score1: 0, score2: 0,
    scoreA: 0, scoreB: 0,
    matchIds: [],
    games: [],
    boType: 'BO3',
    seriesType: 1
  };
  var result = liveGuard(s, now);
  ok('S1: 顺延 3min 无证据 → 保持 UPCOMING', result === 'upcoming', 'phase=' + result);
})();

// 场景 2：顺延 + 规划时间过 10min 仍无证据 → 应保持 UPCOMING（未到 15min 兜底）
(function () {
  var now = Math.floor(Date.now() / 1000);
  var start10mAgo = now - 10 * 60;
  var s = {
    phase: 'live',
    lastTime: start10mAgo,
    score1: 0, score2: 0,
    scoreA: 0, scoreB: 0,
    matchIds: [],
    games: [],
    boType: 'BO3',
    seriesType: 1
  };
  var result = liveGuard(s, now);
  ok('S2: 顺延 10min 无证据（未到 15min 兜底）→ 保持 UPCOMING', result === 'upcoming', 'phase=' + result);
})();

// 场景 3：准点开赛 + 规划时间过 16min（兜底窗口）→ 视为 LIVE（容忍数据延迟）
(function () {
  var now = Math.floor(Date.now() / 1000);
  var start16mAgo = now - 16 * 60;
  var s = {
    phase: 'live',
    lastTime: start16mAgo,
    score1: 0, score2: 0,
    scoreA: 0, scoreB: 0,
    matchIds: [],
    games: [],
    boType: 'BO3',
    seriesType: 1
  };
  var result = liveGuard(s, now);
  ok('S3: 规划时间过 16min（兜底窗口）→ LIVE（容忍数据延迟）', result === 'live', 'phase=' + result);
})();

// 场景 4：正常开赛——有已结算局（1:0）→ LIVE（证据 E1 生效）
(function () {
  var now = Math.floor(Date.now() / 1000);
  var s = {
    phase: 'live',
    lastTime: now - 30 * 60,
    score1: 1, score2: 0,   // 已有比分
    scoreA: 0, scoreB: 0,
    matchIds: [],
    games: [],
    boType: 'BO3',
    seriesType: 1
  };
  var result = liveGuard(s, now);
  ok('S4: 有比分 1:0（证据 E1）→ LIVE', result === 'live', 'phase=' + result);
})();

// 场景 5：正常开赛——有 OpenDota match_id（证据 E2 生效）
(function () {
  var now = Math.floor(Date.now() / 1000);
  var s = {
    phase: 'live',
    lastTime: now - 5 * 60,
    score1: 0, score2: 0,
    scoreA: 0, scoreB: 0,
    matchIds: [8958842370],  // 真实 OpenDota match_id
    games: [],
    boType: 'BO3',
    seriesType: 1
  };
  var result = liveGuard(s, now);
  ok('S5: matchIds 含真实数字（证据 E2）→ LIVE', result === 'live', 'phase=' + result);
})();

// 场景 6：正常开赛——games 含已开赛局（证据 E3 生效）
(function () {
  var now = Math.floor(Date.now() / 1000);
  var s = {
    phase: 'live',
    lastTime: now - 5 * 60,
    score1: 0, score2: 0,
    scoreA: 0, scoreB: 0,
    matchIds: [],
    games: [{ radiant_win: null, start_time: now - 10 * 60, duration: 600 }],  // 进行中
    boType: 'BO3',
    seriesType: 1
  };
  var result = liveGuard(s, now);
  ok('S6: games 含进行中场（证据 E3）→ LIVE', result === 'live', 'phase=' + result);
})();

// 场景 7：顺延但 LPDB v3 matchIds 是字符串格式 → 不算真实证据 → 保持 UPCOMING
(function () {
  var now = Math.floor(Date.now() / 1000);
  var s = {
    phase: 'live',
    lastTime: now - 8 * 60,  // 顺延 8 分钟
    score1: 0, score2: 0,
    scoreA: 0, scoreB: 0,
    matchIds: ['lp_match_12345'],  // 字符串格式不算 OpenDota 数字证据
    games: [],
    boType: 'BO3',
    seriesType: 1
  };
  var result = liveGuard(s, now);
  ok('S7: matchIds 为 LPDB 字符串格式（非数字证据）+ 顺延 8min → 保持 UPCOMING', result === 'upcoming', 'phase=' + result);
})();

// 场景 8：顺延超长——规划时间过 2h 仍无证据 → 不应误判 LIVE（兜底 15min 也已过但仍无证据 → 实际已 LIVE）
//   ★ 此场景表示：规划时间过 2h 但数据源完全无证据 → 兜底窗口生效（避免永远卡 UPCOMING）
(function () {
  var now = Math.floor(Date.now() / 1000);
  var s = {
    phase: 'live',
    lastTime: now - 2 * 3600,
    score1: 0, score2: 0,
    scoreA: 0, scoreB: 0,
    matchIds: [],
    games: [],
    boType: 'BO3',
    seriesType: 1
  };
  var result = liveGuard(s, now);
  ok('S8: 规划时间过 2h 无证据（兜底窗口已生效）→ LIVE（避免永久卡 UPCOMING）', result === 'live', 'phase=' + result);
})();

// 场景 9：顺延 + 前场仍在打 + 后场有比分但显示 0:0（边界数据）→ 守卫拦截
//   （模拟 Liquipedia 缓存未刷新场景）
(function () {
  var now = Math.floor(Date.now() / 1000);
  var s = {
    phase: 'live',
    lastTime: now - 7 * 60,  // 规划时间 7min 前
    score1: 0, score2: 0,
    scoreA: 0, scoreB: 0,
    matchIds: [],
    games: [],
    boType: 'BO3',
    seriesType: 1
  };
  var result = liveGuard(s, now);
  ok('S9: 顺延 7min + 比分 0:0 + 无任何证据 → 保持 UPCOMING', result === 'upcoming', 'phase=' + result);
})();

// 场景 10：BO1 顺延——单局制无系列比分，只能靠 E4 兜底
(function () {
  var now = Math.floor(Date.now() / 1000);
  var s = {
    phase: 'live',
    lastTime: now - 10 * 60,
    score1: 0, score2: 0,
    scoreA: 0, scoreB: 0,
    matchIds: [],
    games: [],
    boType: 'BO1',
    seriesType: 0
  };
  var result = liveGuard(s, now);
  ok('S10: BO1 顺延 10min 无证据 → 保持 UPCOMING（守卫覆盖 BO1）', result === 'upcoming', 'phase=' + result);
})();

// 场景 11：已结束对局（比分 2:0 BO3）→ 不进 LIVE 段（比分结束判定）
(function () {
  var now = Math.floor(Date.now() / 1000);
  var s = {
    phase: 'live',
    lastTime: now - 2 * 3600,
    score1: 2, score2: 0,
    scoreA: 0, scoreB: 0,
    matchIds: [12345],
    games: [],
    boType: 'BO3',
    seriesType: 1
  };
  var result = liveGuard(s, now);
  ok('S11: BO3 比分 2:0（已达胜场条件）→ RECENT（不进 LIVE）', result === 'recent', 'phase=' + result);
})();

console.log('\n--- 测试结果 ---');
console.log('通过 ' + pass + ' 条，失败 ' + fail + ' 条');
if (fail > 0) {
  process.exit(1);
}
