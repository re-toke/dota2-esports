// 2026-08-22 fix(merge): 跨源同对局重复修复验证
//   场景：Steam LIVE 卡（startTime=Date.now()）与 haglund UPCOMING 卡（startTime=真实开赛时间）
//        同对局「Nigma Galaxy vs Boom Boys」重复显示在 UPCOMING 段。
//   修复前：三元组 (team1,team2,startTime) 去重键因 startTime 不同失效 → 双卡
//   修复后：队名对归一化键（顺序无关）作为主去重，Steam 先入表 → haglund 同队名对阵剔除
//
// 本脚本验证 utils/liquipedia.js Promise.all 合并段的去重逻辑（纯函数模拟，不依赖 wx.cloud）。

var assert = require('assert');

// === 复制 utils/liquipedia.js 合并段去重逻辑（同步等价）===
function buildMerger() {
  var seen = {};
  var seenTeams = {};
  var merged = [];
  function _normTeam(s) {
    if (!s) return '';
    var n = String(s).toLowerCase().trim();
    n = n.replace(/\s*(esports|e-sports|gaming|team|club)\s*$/g, '');
    n = n.replace(/[^a-z0-9一-鿿а-яё]/g, '');
    return n;
  }
  function _teamPairKey(n1, n2) {
    return n1 < n2 ? (n1 + '|' + n2) : (n2 + '|' + n1);
  }
  function _isTBD(n) { return !n || n === 'tbd' || n === 'tba'; }
  function pushIfNew(m) {
    if (!m) return;
    var tri = (m.team1Name || '') + '|' + (m.team2Name || '') + '|' + (m.startTime || m.start_time || 0);
    if (seen[tri]) return;
    var n1 = _normTeam(m.team1Name);
    var n2 = _normTeam(m.team2Name);
    if (n1 && n2 && !_isTBD(n1) && !_isTBD(n2)) {
      var pk = _teamPairKey(n1, n2);
      if (seenTeams[pk]) return;
      seenTeams[pk] = m.source || m.phase || 'unknown';
    }
    seen[tri] = true;
    merged.push(m);
  }
  return {
    push: pushIfNew,
    result: function () { return merged.slice(); }
  };
}

var pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.error('  ✗ FAIL: ' + msg); }
}

console.log('--- T1: Steam LIVE + haglund UPCOMING 同对局（startTime 不同）→ 应只保留 1 张 ---');
(function () {
  var merger = buildMerger();
  var steamMatch = {
    team1Name: 'Nigma Galaxy', team2Name: 'Boom Boys',
    startTime: 1735000000,  // Date.now() 模拟
    phase: 'live', source: 'steam-live',
    series_id: 12345, score1: 1, score2: 0
  };
  var haglundMatch = {
    team1Name: 'Nigma Galaxy', team2Name: 'Boom Boys',
    startTime: 1734980000,  // 真实开赛时间（与 Steam 不同）
    phase: 'upcoming', source: 'haglund',
    series_id: null, score1: 0, score2: 0
  };
  merger.push(steamMatch);
  merger.push(haglundMatch);
  var out = merger.result();
  ok(out.length === 1, '合并后只剩 1 张（实际 ' + out.length + '）');
  ok(out[0].source === 'steam-live', '保留的是 Steam LIVE（更权威，含 series_id/score）');
  ok(out[0].phase === 'live', 'phase 仍为 live');
})();

console.log('--- T2: 队名换边（Steam: A|B  vs  haglund: B|A）→ 仍应去重 ---');
(function () {
  var merger = buildMerger();
  merger.push({ team1Name: 'Team A', team2Name: 'Team B', startTime: 100, phase: 'live', source: 'steam-live' });
  merger.push({ team1Name: 'Team B', team2Name: 'Team A', startTime: 200, phase: 'upcoming', source: 'haglund' });
  var out = merger.result();
  ok(out.length === 1, '换边后仍合并为 1 张（实际 ' + out.length + '）');
})();

console.log('--- T3: 队名后缀差异（"Nigma Galaxy esports" vs "Nigma Galaxy"）→ 应去重 ---');
(function () {
  var merger = buildMerger();
  merger.push({ team1Name: 'Nigma Galaxy esports', team2Name: 'Boom Boys', startTime: 100, phase: 'live', source: 'steam-live' });
  merger.push({ team1Name: 'Nigma Galaxy', team2Name: 'Boom Boys', startTime: 200, phase: 'upcoming', source: 'haglund' });
  var out = merger.result();
  ok(out.length === 1, '后缀差异（esports/team/gaming）归一化后合并（实际 ' + out.length + '）');
})();

console.log('--- T4: 两场完全不同对局 → 都保留 ---');
(function () {
  var merger = buildMerger();
  merger.push({ team1Name: 'Team A', team2Name: 'Team B', startTime: 100, phase: 'live', source: 'steam-live' });
  merger.push({ team1Name: 'Team C', team2Name: 'Team D', startTime: 200, phase: 'upcoming', source: 'haglund' });
  var out = merger.result();
  ok(out.length === 2, '不同对局都保留（实际 ' + out.length + '）');
})();

console.log('--- T5: TBD/TBA 占位场不参与队名去重（多个 TBD vs 不同队应各自保留）---');
(function () {
  var merger = buildMerger();
  merger.push({ team1Name: 'TBD', team2Name: 'Team X', startTime: 100, phase: 'upcoming', source: 'haglund' });
  merger.push({ team1Name: 'TBD', team2Name: 'Team Y', startTime: 200, phase: 'upcoming', source: 'haglund' });
  var out = merger.result();
  ok(out.length === 2, 'TBD 占位场各自保留不误并（实际 ' + out.length + '）');
})();

console.log('--- T6: haglund 同对局两条（完全相同 startTime）→ 三元组去重保留 1 张 ---');
(function () {
  var merger = buildMerger();
  merger.push({ team1Name: 'Team A', team2Name: 'Team B', startTime: 300, phase: 'upcoming', source: 'haglund' });
  merger.push({ team1Name: 'Team A', team2Name: 'Team B', startTime: 300, phase: 'upcoming', source: 'haglund' });
  var out = merger.result();
  ok(out.length === 1, '三元组严格相等去重（实际 ' + out.length + '）');
})();

console.log('--- T7: 只有两张 haglund（无 Steam），同对局不同 startTime（少见）→ 应合并 ---');
(function () {
  var merger = buildMerger();
  merger.push({ team1Name: 'Team Falcons', team2Name: 'Team Falcons esports', startTime: 100, phase: 'upcoming', source: 'haglund' });
  // 注意：归一化后两侧都是 "falcons"，队名对键相同 → 第二条被剔除
  merger.push({ team1Name: 'Team Falcons', team2Name: 'Team Falcons', startTime: 200, phase: 'upcoming', source: 'haglund' });
  var out = merger.result();
  ok(out.length === 1, '同队名对（归一化后相同）合并（实际 ' + out.length + '）');
})();

console.log('--- T8: Steam 先入表 → haglund 后入同对局 → 保留 Steam 的 series_id ---');
(function () {
  var merger = buildMerger();
  merger.push({ team1Name: 'A', team2Name: 'B', startTime: 999, phase: 'live', source: 'steam-live', series_id: 777, score1: 2, score2: 1 });
  merger.push({ team1Name: 'A', team2Name: 'B', startTime: 888, phase: 'upcoming', source: 'haglund', series_id: null });
  var out = merger.result();
  ok(out.length === 1, '合并为 1 张');
  ok(out[0].series_id === 777, '保留 Steam 的 series_id=777（更权威）');
  ok(out[0].score1 === 2 && out[0].score2 === 1, '保留 Steam 的系列比分 2:1');
})();

console.log('\n=== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ===');
process.exit(fail > 0 ? 1 : 0);
