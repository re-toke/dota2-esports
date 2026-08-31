// 精确诊断：patchNullSeriesId 对 BO3 换边场景的处理
'use strict';

var sources = require('../../utils/sources.js');

var BASE = 1724088000;

console.log('=== patchNullSeriesId BO3 换边诊断 ===\n');

// 场景 1：series_id=0，BO3 换边（radiant/dire 对调）
console.log('--- 场景 1: series_id=0, BO3 换边 ---');
(function () {
  var matches = [
    {
      match_id: 70000001, series_id: 0, series_type: 1,
      radiant_team_id: 8256605, dire_team_id: 7119388,
      radiant_team_name: 'Iron Wing', dire_team_name: 'Team Spirit',
      radiant_win: false, start_time: BASE, duration: 1800
    },
    {
      match_id: 70000002, series_id: 0, series_type: 1,
      radiant_team_id: 7119388, dire_team_id: 8256605,  // 换边
      radiant_team_name: 'Team Spirit', dire_team_name: 'Iron Wing',
      radiant_win: true, start_time: BASE + 3600, duration: 2400
    }
  ];
  var result = sources.groupSeries(matches);
  console.log('  groupSeries 产出: ' + result.length + ' 个系列');
  result.forEach(function(s, i) {
    console.log('    系列' + i + ': ' + s.radiantName + ' vs ' + s.direName +
      ' scoreA=' + s.scoreA + ' scoreB=' + s.scoreB + ' games=' + s.games.length);
  });
  if (result.length === 2) {
    console.log('  ❌ 拆成 2 系列！');
    // 手动检查 patchNullSeriesId 的中间产物
    var patched = sources.patchNullSeriesId ? sources.patchNullSeriesId(matches.slice()) : null;
    if (patched) {
      patched.forEach(function(m) {
        console.log('    match ' + m.match_id + ' _patchedSeriesKey=' + m._patchedSeriesKey);
      });
    } else {
      console.log('    patchNullSeriesId 未导出，无法检查中间产物');
    }
  }
})();

// 场景 2：series_id=0，不换边（radiant/dire 保持一致）
console.log('\n--- 场景 2: series_id=0, 不换边 ---');
(function () {
  var matches = [
    {
      match_id: 70000001, series_id: 0, series_type: 1,
      radiant_team_id: 8256605, dire_team_id: 7119388,
      radiant_team_name: 'Iron Wing', dire_team_name: 'Team Spirit',
      radiant_win: false, start_time: BASE, duration: 1800
    },
    {
      match_id: 70000002, series_id: 0, series_type: 1,
      radiant_team_id: 8256605, dire_team_id: 7119388,  // 不换边
      radiant_team_name: 'Iron Wing', dire_team_name: 'Team Spirit',
      radiant_win: false, start_time: BASE + 3600, duration: 2400
    }
  ];
  var result = sources.groupSeries(matches);
  console.log('  groupSeries 产出: ' + result.length + ' 个系列');
  result.forEach(function(s, i) {
    console.log('    系列' + i + ': ' + s.radiantName + ' vs ' + s.direName +
      ' scoreA=' + s.scoreA + ' scoreB=' + s.scoreB + ' games=' + s.games.length);
  });
})();

// 场景 3：series_id=null（而非 0），换边
console.log('\n--- 场景 3: series_id=null, 换边 ---');
(function () {
  var matches = [
    {
      match_id: 70000001, series_id: null, series_type: 1,
      radiant_team_id: 8256605, dire_team_id: 7119388,
      radiant_team_name: 'Iron Wing', dire_team_name: 'Team Spirit',
      radiant_win: false, start_time: BASE, duration: 1800
    },
    {
      match_id: 70000002, series_id: null, series_type: 1,
      radiant_team_id: 7119388, dire_team_id: 8256605,
      radiant_team_name: 'Team Spirit', dire_team_name: 'Iron Wing',
      radiant_win: true, start_time: BASE + 3600, duration: 2400
    }
  ];
  var result = sources.groupSeries(matches);
  console.log('  groupSeries 产出: ' + result.length + ' 个系列');
  result.forEach(function(s, i) {
    console.log('    系列' + i + ': ' + s.radiantName + ' vs ' + s.direName +
      ' scoreA=' + s.scoreA + ' scoreB=' + s.scoreB + ' games=' + s.games.length);
  });
})();

console.log('\n=== 诊断完成 ===');
