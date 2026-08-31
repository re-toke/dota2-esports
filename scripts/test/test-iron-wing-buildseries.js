// 诊断脚本 II：Iron Wing vs Spirit 在 buildSeriesFromSources 全链路的合并行为
// 重点测试：当 OpenDota 和 LPDB v3 同时返回同一场 BO3 时，合并段的去重逻辑是否正确。
'use strict';

var assert = require('assert');

// 不直接 require league-detail（依赖 wx/Page），而是模拟其 buildSeriesFromSources 的核心逻辑
var sources = require('../../utils/sources.js');

var BASE = 1724088000;  // 2024-08-20 02:00 UTC

console.log('=== Iron Wing vs Spirit buildSeriesFromSources 链路诊断 ===\n');

// 辅助：模拟 OpenDota raw matches（每局一条记录，series_id 可能为 0 或有效值）
function makeOpenDotaGames(seriesId) {
  return [
    {
      match_id: 70000001,
      series_id: seriesId,
      series_type: 1,
      radiant_team_id: 8256605,
      dire_team_id: 7119388,
      radiant_team_name: 'Iron Wing',
      dire_team_name: 'Team Spirit',
      radiant_win: false,
      start_time: BASE,
      duration: 1800
    },
    {
      match_id: 70000002,
      series_id: seriesId,
      series_type: 1,
      radiant_team_id: 7119388,  // BO3 换边
      dire_team_id: 8256605,
      radiant_team_name: 'Team Spirit',
      dire_team_name: 'Iron Wing',
      radiant_win: true,  // Spirit 赢第二局
      start_time: BASE + 3600,
      duration: 2400
    }
  ];
}

// 辅助：模拟 LPDB v3 路径返回的一场 BO3（系列级，合并后）
function makeLPDBv3Match() {
  return {
    match_id: 'The_International/2026/Main_Event/R2_M001',
    series_id: 'lp_mR02-M001',
    series_type: 1,
    radiant_team_id: 0,
    dire_team_id: 0,
    radiant_team_name: 'Iron Wing',
    dire_team_name: 'Team Spirit',
    team1Name: 'Iron Wing',
    team2Name: 'Team Spirit',
    team1Short: 'IW',
    team2Short: 'TS',
    startTime: BASE,
    start_time: BASE,
    score1: 0,
    score2: 2,
    phase: 'recent',
    boType: 'BO3',
    boDeclared: true,
    finished: true,
    matchIds: [],
    mapSlots: 2
  };
}

// 模拟 buildSeriesFromSources 的核心流程
function simulateBuildSeries(rawMatches, liqMatches) {
  // Step 1: OpenDota -> groupSeries
  var openDotaSeries = sources.groupSeries(rawMatches);
  console.log('  OpenDota groupSeries 产出: ' + openDotaSeries.length + ' 个系列');
  openDotaSeries.forEach(function(s, i) {
    console.log('    系列' + i + ': ' + s.radiantName + ' vs ' + s.direName +
      ' scoreA=' + s.scoreA + ' scoreB=' + s.scoreB + ' games=' + s.games.length);
  });

  // Step 2: LP -> groupLiquipediaMatches
  var liqGrouped = sources.groupLiquipediaMatches(liqMatches);
  console.log('  LP groupLiquipediaMatches 产出: ' + liqGrouped.length + ' 个匹配');
  liqGrouped.forEach(function(m, i) {
    console.log('    匹配' + i + ': ' + m.team1Name + ' vs ' + m.team2Name +
      ' score1=' + m.score1 + ' score2=' + m.score2 + ' phase=' + m.phase);
  });

  // Step 3: 模拟合并段 filter（league-detail.js L803-846 的核心逻辑）
  function normalizeTeamNameForDedup(name) {
    if (!name) return '';
    var n = String(name).toLowerCase().trim();
    n = n.replace(/\s*(esports|e-sports|gaming|team|club)\s*$/g, '');
    n = n.replace(/[^a-z0-9一-鿿а-яё]/g, '');
    return n;
  }
  function dedupeKey(n1, n2) {
    return normalizeTeamNameForDedup(n1) + '__' + normalizeTeamNameForDedup(n2);
  }

  var openDotaKeys = new Map();
  openDotaSeries.forEach(function(s) {
    var g0 = s.games && s.games[0];
    var rn = s.radiantName;
    var dn = s.direName;
    if (rn && dn) {
      var k1 = dedupeKey(rn, dn);
      openDotaKeys.set(k1, g0 ? (g0.start_time || 0) : 0);
      openDotaKeys.set(k1.split('__').reverse().join('__'), g0 ? (g0.start_time || 0) : 0);
    }
  });

  var survivingLP = [];
  liqGrouped.forEach(function(m) {
    if (m.phase !== 'recent') { survivingLP.push(m); return; }
    if (!m.team1Name || !m.team2Name) { survivingLP.push(m); return; }
    var k = dedupeKey(m.team1Name, m.team2Name);
    var kRev = k.split('__').reverse().join('__');
    if (openDotaKeys.has(k) || openDotaKeys.has(kRev)) {
      var _t0 = openDotaKeys.get(k) || openDotaKeys.get(kRev) || 0;
      if (_t0 && m.startTime && Math.abs(m.startTime - _t0) < 2 * 3600) {
        console.log('  ⚠️ LP 项被剔除: ' + m.team1Name + ' vs ' + m.team2Name +
          ' (OpenDota 已有同队名对, 时间差<' + Math.abs(m.startTime - _t0) + 's)');
        return;  // 被剔除
      }
    }
    survivingLP.push(m);
  });

  console.log('  合并段后 LP 存活: ' + survivingLP.length + ' 个');
  var totalSeries = openDotaSeries.length + survivingLP.length;
  console.log('  最终总系列数: ' + totalSeries);
  return { openDotaSeries: openDotaSeries, survivingLP: survivingLP, total: totalSeries };
}

// === 场景 A：OpenDota series_id 有效（如 12345）→ groupSeries 正确合并 ===
console.log('--- 场景 A: OpenDota series_id=12345（有效）→ 合并 + LP 被剔除 ---');
(function () {
  var raw = makeOpenDotaGames(12345);
  var liq = [makeLPDBv3Match()];
  var result = simulateBuildSeries(raw, liq);
  assert.strictEqual(result.openDotaSeries.length, 1, 'A: OpenDota 应合并成 1 系列');
  assert.strictEqual(result.survivingLP.length, 0, 'A: LP 应被剔除');
  assert.strictEqual(result.total, 1, 'A: 最终应只有 1 系列');
  console.log('  场景 A ✓\n');
})();

// === 场景 B：OpenDota series_id=0 → groupSeries 是否合并？ ===
console.log('--- 场景 B: OpenDota series_id=0 → patchNullSeriesId 兜底 ---');
(function () {
  var raw = makeOpenDotaGames(0);
  var liq = [makeLPDBv3Match()];
  var result = simulateBuildSeries(raw, liq);
  console.log('  B-OpenDota系列数: ' + result.openDotaSeries.length);
  // 关键断言：如果 OpenDota 正确合并了（1系列），LP 会被剔除，最终 1 系列
  // 如果 OpenDota 没合并（2系列），LP 也会被剔除（队名匹配），最终 2 系列 ← 这就是 BUG
  if (result.openDotaSeries.length === 2) {
    console.log('  ❌ 根因确认：OpenDota series_id=0 时 groupSeries 拆成 2 系列，LP 合并的被剔除 → 最终 2 张 BO1');
  } else if (result.openDotaSeries.length === 1) {
    console.log('  ✓ OpenDota series_id=0 时 patchNullSeriesId 成功合并');
  }
  assert.strictEqual(result.total, 1, 'B: 最终应只有 1 系列（实际 ' + result.total + '）');
  console.log('  场景 B ✓\n');
})();

// === 场景 C：OpenDota series_id=null → 同场景 B ===
console.log('--- 场景 C: OpenDota series_id=null → patchNullSeriesId 兜底 ---');
(function () {
  var raw = makeOpenDotaGames(null);
  var liq = [makeLPDBv3Match()];
  var result = simulateBuildSeries(raw, liq);
  console.log('  C-OpenDota系列数: ' + result.openDotaSeries.length);
  assert.strictEqual(result.total, 1, 'C: 最终应只有 1 系列（实际 ' + result.total + '）');
  console.log('  场景 C ✓\n');
})();

// === 场景 D：OpenDota 无数据（延迟）→ 只走 LP 路径 ===
console.log('--- 场景 D: OpenDota 无数据（延迟 1-2 周）→ 只走 LP ---');
(function () {
  var raw = [];
  var liq = [makeLPDBv3Match()];
  var result = simulateBuildSeries(raw, liq);
  assert.strictEqual(result.openDotaSeries.length, 0, 'D: OpenDota 无数据');
  assert.strictEqual(result.survivingLP.length, 1, 'D: LP 应存活');
  assert.strictEqual(result.total, 1, 'D: 最终应只有 1 系列');
  console.log('  场景 D ✓\n');
})();

// === 场景 E：OpenDota 两局 team_id 不同（数据异常）→ 拆分 ===
console.log('--- 场景 E: OpenDota 两局 team_id 不同（数据异常）---');
(function () {
  var raw = [
    {
      match_id: 70000001, series_id: 0, series_type: 1,
      radiant_team_id: 8256605, dire_team_id: 7119388,
      radiant_team_name: 'Iron Wing', dire_team_name: 'Team Spirit',
      radiant_win: false, start_time: BASE, duration: 1800
    },
    {
      match_id: 70000002, series_id: 0, series_type: 1,
      radiant_team_id: 9999999, dire_team_id: 8888888,  // 完全不同的 team_id
      radiant_team_name: 'Iron Wing', dire_team_name: 'Team Spirit',
      radiant_win: false, start_time: BASE + 3600, duration: 2400
    }
  ];
  var liq = [makeLPDBv3Match()];
  var result = simulateBuildSeries(raw, liq);
  console.log('  E-OpenDota系列数: ' + result.openDotaSeries.length);
  // team_id 不同 → 孤儿互并失败 → 拆成 2 系列 → LP 被剔除 → 最终 2 张 BO1
  if (result.openDotaSeries.length === 2) {
    console.log('  ❌ 根因确认：team_id 不同导致孤儿互并失败');
  }
  console.log('  场景 E (记录现状)\n');
})();

console.log('=== 诊断完成 ===');
