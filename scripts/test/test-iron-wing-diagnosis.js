// 诊断脚本：Iron Wing vs Spirit BO3 为何被拆成两场 BO1
// 模拟三种数据源（LPDB v3 / wikitext / Steam LIVE）各返回一场 BO3，
// 跟踪客户端 groupLiquipediaMatches 的实际合并行为。
'use strict';

var assert = require('assert');
var sources = require('../../utils/sources.js');

var BASE = 1724088000;  // 2024-08-20 02:00 UTC（固定基准，避免测试时间漂移）

console.log('=== Iron Wing vs Spirit BO3 拆分诊断 ===\n');

// ------------------------------------------------------------------
// 场景 1：LPDB v3 路径——一行 match2 记录代表整场 BO3
// normalizeV3Match 产出形状：series_id='lp_m{match2id}', score1=0, score2=2
// ------------------------------------------------------------------
console.log('--- 场景 1: LPDB v3 单行 BO3（系列级 match2id） ---');
(function () {
  var lpdbMatches = [{
    // normalizeV3Match 产出形状
    match_id: 'The_International/2026/Main_Event/Upper_Bracket_Round_1_M001',
    series_id: 'lp_mR02-M001',
    series_type: 1,  // BO3
    radiant_team_id: 8256605,
    dire_team_id: 7119388,
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
    mapSlots: 3,
    source: 'liquipedia-v3'
  }];

  var out = sources.groupLiquipediaMatches(lpdbMatches);
  console.log('  输入: 1 条 LPDB v3 记录（含系列比分 0:2）');
  console.log('  输出: ' + out.length + ' 系列');
  if (out.length === 1) {
    console.log('  ✓ LPDB v3 单行不被拆分');
    console.log('    系列: ' + out[0].team1Name + ' vs ' + out[0].team2Name +
                ' 比分 ' + out[0].score1 + ':' + out[0].score2 +
                ' boType=' + out[0].boType);
  } else {
    console.log('  ✗ LPDB v3 单行被拆成 ' + out.length + ' 系列！');
    out.forEach(function (s, i) {
      console.log('    #' + (i+1) + ': ' + s.team1Name + ' vs ' + s.team2Name +
                  ' boType=' + s.boType + ' phase=' + s.phase);
    });
  }
})();

console.log('');
// ------------------------------------------------------------------
// 场景 2：wikitext 路径——一场 BO3 一条记录（无 series_id）
// parseMatchFields 产出形状：无 series_id 字段
// ------------------------------------------------------------------
console.log('--- 场景 2: wikitext 单条 BO3（无 series_id） ---');
(function () {
  var wikitextMatches = [{
    // parseMatchFields 产出形状（注意：没有 series_id 字段！）
    team1Name: 'Iron Wing',
    team2Name: 'Team Spirit',
    score1: 0,
    score2: 2,
    startTime: BASE,
    boType: 'BO3',
    boDeclared: true,
    finished: true,
    phase: 'recent',
    matchIds: [],
    mapSlots: 3
  }];

  var out = sources.groupLiquipediaMatches(wikitextMatches);
  console.log('  输入: 1 条 wikitext 记录（无 series_id）');
  console.log('  输出: ' + out.length + ' 系列');
  if (out.length === 1) {
    console.log('  ✓ wikitext 单条不被拆分');
  } else {
    console.log('  ✗ wikitext 单条被拆成 ' + out.length + ' 系列！');
  }
})();

console.log('');
// ------------------------------------------------------------------
// 场景 3：双源合并——LPDB v3 + wikitext 同时返回同一场 BO3
// 这是最可疑的场景！两源各返回一场，series_id 不同 → keyOf 不同 → 不合并
// ------------------------------------------------------------------
console.log('--- 场景 3: 双源同对局（LPDB v3 + wikitext 各返回一场） ---');
(function () {
  var dualSource = [
    // LPDB v3 产出
    {
      match_id: 'lp_v3_iw_vs_ts',
      series_id: 'lp_mR02-M001',
      series_type: 1,
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
      mapSlots: 3,
      source: 'liquipedia-v3'
    },
    // wikitext 产出（无 series_id）
    {
      team1Name: 'Iron Wing',
      team2Name: 'Team Spirit',
      score1: 0,
      score2: 2,
      startTime: BASE,
      boType: 'BO3',
      boDeclared: true,
      finished: true,
      phase: 'recent',
      matchIds: [],
      mapSlots: 3
    }
  ];

  var out = sources.groupLiquipediaMatches(dualSource);
  console.log('  输入: 2 条同对局记录（1 LPDB v3 + 1 wikitext）');
  console.log('  输出: ' + out.length + ' 系列');
  if (out.length === 1) {
    console.log('  ✓ 双源同对局正确合并为 1 系列');
  } else {
    console.log('  ✗✗✗ 双源同对局被拆成 ' + out.length + ' 系列！这就是根因！★★★');
    out.forEach(function (s, i) {
      console.log('    #' + (i+1) + ': ' + s.team1Name + ' vs ' + s.team2Name +
                  ' 比分=' + s.score1 + ':' + s.score2 +
                  ' boType=' + s.boType + ' phase=' + s.phase);
    });
  }
})();

console.log('');
// ------------------------------------------------------------------
// 场景 4：Steam LIVE 残留——已结束 BO3 仍返回两局各一条
// 每局有相同 series_id（Steam 系列级），但 startTime 用 Date.now() 略有差异
// ------------------------------------------------------------------
console.log('--- 场景 4: Steam LIVE 残留（同一 BO3 两局各一条，series_id 相同） ---');
(function () {
  var nowSec = Math.floor(Date.now() / 1000);
  var steamLiveResidue = [
    // 第一局
    {
      series_id: 12345,
      series_type: 1,
      league_id: 19944,
      radiant_team_id: 8256605,
      dire_team_id: 7119388,
      radiant_win: false,
      match_id: 100001,
      start_time: nowSec - 7200,  // 2h 前
      team1Name: 'Iron Wing',
      team2Name: 'Team Spirit',
      team1Short: 'Iron Wing',
      team2Short: 'Team Spirit',
      startTime: nowSec - 7200,
      score1: 0,
      score2: 1,  // 第一局结束后 Spirit 1:0 领先
      phase: 'live',
      boType: null,
      source: 'steam-live'
    },
    // 第二局（series_id 相同）
    {
      series_id: 12345,
      series_type: 1,
      league_id: 19944,
      radiant_team_id: 8256605,
      dire_team_id: 7119388,
      radiant_win: false,
      match_id: 100002,
      start_time: nowSec - 3600,  // 1h 前
      team1Name: 'Iron Wing',
      team2Name: 'Team Spirit',
      team1Short: 'Iron Wing',
      team2Short: 'Team Spirit',
      startTime: nowSec - 3600,
      score1: 0,
      score2: 2,  // 第二局结束后 Spirit 2:0 胜
      phase: 'recent',  // 已被 normalizeSteamLiveGame 比分结束判定改 recent
      boType: null,
      source: 'steam-live'
    }
  ];

  var out = sources.groupLiquipediaMatches(steamLiveResidue);
  console.log('  输入: 2 条 Steam LIVE 同 series_id=12345 记录');
  console.log('  输出: ' + out.length + ' 系列');
  if (out.length === 1) {
    console.log('  ✓ Steam LIVE 同 series_id 正确合并');
    console.log('    最终比分: ' + out[0].score1 + ':' + out[0].score2);
  } else {
    console.log('  ✗ Steam LIVE 同 series_id 被拆成 ' + out.length + ' 系列！');
  }
})();

console.log('');
// ------------------------------------------------------------------
// 场景 5：Steam LIVE 残留但 series_id=0（未分配系列号）
// 这种情况下 keyOf 走兜底，两局 startTime 差 1h < 6h 应合并
// ------------------------------------------------------------------
console.log('--- 场景 5: Steam LIVE 残留 series_id=0（兜底聚合） ---');
(function () {
  var nowSec = Math.floor(Date.now() / 1000);
  var steamNoSeries = [
    {
      series_id: 0,
      series_type: 1,
      team1Name: 'Iron Wing',
      team2Name: 'Team Spirit',
      startTime: nowSec - 7200,
      start_time: nowSec - 7200,
      score1: 0,
      score2: 1,
      phase: 'live',
      match_id: 200001,
      boType: null,
      source: 'steam-live'
    },
    {
      series_id: 0,
      series_type: 1,
      team1Name: 'Iron Wing',
      team2Name: 'Team Spirit',
      startTime: nowSec - 3600,
      start_time: nowSec - 3600,
      score1: 0,
      score2: 2,
      phase: 'recent',
      match_id: 200002,
      boType: null,
      source: 'steam-live'
    }
  ];

  var out = sources.groupLiquipediaMatches(steamNoSeries);
  console.log('  输入: 2 条 Steam LIVE series_id=0 记录');
  console.log('  输出: ' + out.length + ' 系列');
  if (out.length === 1) {
    console.log('  ✓ series_id=0 兜底正确合并');
  } else {
    console.log('  ✗ series_id=0 被拆成 ' + out.length + ' 系列！');
  }
})();

console.log('');
// ------------------------------------------------------------------
// 场景 6：跨源——LPDB v3 已结束 + Steam LIVE 残留（同对局）
// 这是最可能的真实场景！LPDB v3 返回 phase=recent 的完整 BO3，
// Steam LIVE 残留返回 phase=live 的零散局数据（series_id 不同）
// ------------------------------------------------------------------
console.log('--- 场景 6: 跨源 LPDB v3 (recent) + Steam LIVE 残留 (live) ---');
(function () {
  var nowSec = Math.floor(Date.now() / 1000);
  var crossSource = [
    // LPDB v3 返回的完整 BO3
    {
      match_id: 'lp_v3_complete',
      series_id: 'lp_mR02-M001',
      series_type: 1,
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
      mapSlots: 3,
      source: 'liquipedia-v3'
    },
    // Steam LIVE 残留（series_id 数字，与 LPDB v3 的 'lp_mR02-M001' 不同）
    // 注意：同 UTC 日桶（与 LPDB v3 的 BASE 同日），验证去重生效
    {
      series_id: 12345,
      series_type: 1,
      team1Name: 'Iron Wing',
      team2Name: 'Team Spirit',
      team1Short: 'Iron Wing',
      team2Short: 'Team Spirit',
      startTime: BASE + 3600,  // 与 LPDB v3 同日，差 1h
      start_time: BASE + 3600,
      score1: 0,
      score2: 2,
      phase: 'recent',
      match_id: 300001,
      boType: null,
      source: 'steam-live'
    }
  ];

  var out = sources.groupLiquipediaMatches(crossSource);
  console.log('  输入: 1 LPDB v3 (series_id=lp_mR02-M001) + 1 Steam (series_id=12345)');
  console.log('  输出: ' + out.length + ' 系列');
  if (out.length === 1) {
    console.log('  ✓ 跨源同对局正确合并（keyOf 兜底起作用）');
  } else {
    console.log('  ✗✗✗ 跨源同对局被拆成 ' + out.length + ' 系列！★★★');
    out.forEach(function (s, i) {
      console.log('    #' + (i+1) + ': ' + s.team1Name + ' vs ' + s.team2Name +
                  ' boType=' + s.boType + ' phase=' + s.phase);
    });
  }
})();

console.log('\n=== 诊断完成 ===');
