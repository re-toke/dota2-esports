// 系列赛聚合单元测试
// 验证 groupSeries() 的 BO1/BO2/BO3/BO5 识别、平局判定、比分计算

const sources = require('../utils/sources.js');

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + '  ->  ' + (detail || '')); }
}

// ===== 测试 1: BO3 三局两胜 =====
const bo3Matches = [
  { match_id: 1, series_id: 100, series_type: 1, radiant_win: true, radiant_team_name: 'Tundra', dire_team_name: 'Gaimin', radiant_team_id: 1, dire_team_id: 2, start_time: 1000, duration: 2400, radiant_score: 0, dire_score: 0 },
  { match_id: 2, series_id: 100, series_type: 1, radiant_win: false, radiant_team_name: 'Tundra', dire_team_name: 'Gaimin', radiant_team_id: 1, dire_team_id: 2, start_time: 2000, duration: 2500, radiant_score: 0, dire_score: 0 },
  { match_id: 3, series_id: 100, series_type: 1, radiant_win: true, radiant_team_name: 'Tundra', dire_team_name: 'Gaimin', radiant_team_id: 1, dire_team_id: 2, start_time: 3000, duration: 2100, radiant_score: 0, dire_score: 0 }
];
const bo3Result = sources.groupSeries(bo3Matches);
assert('BO3 series_type=1 → 三场聚合为 1 个系列', bo3Result.length === 1, '实际: ' + bo3Result.length);
assert('BO3 boType 正确', bo3Result[0].boType === 'BO3', '实际: ' + bo3Result[0].boType);
assert('BO3 boLabel 正确', bo3Result[0].boLabel === '三局两胜', '实际: ' + bo3Result[0].boLabel);
assert('BO3 比分 2-1', bo3Result[0].scoreA === 2 && bo3Result[0].scoreB === 1, '实际: ' + bo3Result[0].scoreA + '-' + bo3Result[0].scoreB);
assert('BO3 radiantWin=true', bo3Result[0].radiantWin === true);
assert('BO3 isMulti=true', bo3Result[0].isMulti === true);
assert('BO3 scoreACls=win', bo3Result[0].scoreACls === 'win', '实际: ' + bo3Result[0].scoreACls);
assert('BO3 scoreBCls=lose', bo3Result[0].scoreBCls === 'lose', '实际: ' + bo3Result[0].scoreBCls);
assert('BO3 teamACls=win', bo3Result[0].teamACls === 'win', '实际: ' + bo3Result[0].teamACls);
assert('BO3 teamALogoCls=team-win', bo3Result[0].teamALogoCls === 'team-win', '实际: ' + bo3Result[0].teamALogoCls);
assert('BO3 boTagCls 为空（默认紫色）', bo3Result[0].boTagCls === '', '实际: ' + bo3Result[0].boTagCls);

// ===== 测试 1b: BO3 横扫 2-0（series_type=1，2场）=====
const bo3SweepMatches = [
  { match_id: 1, series_id: 101, series_type: 1, radiant_win: true, radiant_team_name: 'A', dire_team_name: 'B', radiant_team_id: 1, dire_team_id: 2, start_time: 1000, duration: 2400, radiant_score: 0, dire_score: 0 },
  { match_id: 2, series_id: 101, series_type: 1, radiant_win: true, radiant_team_name: 'A', dire_team_name: 'B', radiant_team_id: 1, dire_team_id: 2, start_time: 2000, duration: 2500, radiant_score: 0, dire_score: 0 }
];
const bo3SweepResult = sources.groupSeries(bo3SweepMatches);
assert('BO3 横扫 2-0 series_type=1 → BO3（不是BO2）', bo3SweepResult[0].boType === 'BO3', '实际: ' + bo3SweepResult[0].boType);
assert('BO3 横扫 比分 2-0', bo3SweepResult[0].scoreA === 2 && bo3SweepResult[0].scoreB === 0);

// ===== 测试 1c: 用户反馈场景 - 一方赢3局但 series_type=1（误标为BO3）应判为 BO5 =====
const bo5MislabeledMatches = [
  { match_id: 1, series_id: 102, series_type: 1, radiant_win: true, radiant_team_name: 'X', dire_team_name: 'Y', radiant_team_id: 1, dire_team_id: 2, start_time: 1000, duration: 2400, radiant_score: 0, dire_score: 0 },
  { match_id: 2, series_id: 102, series_type: 1, radiant_win: false, radiant_team_name: 'X', dire_team_name: 'Y', radiant_team_id: 1, dire_team_id: 2, start_time: 2000, duration: 2500, radiant_score: 0, dire_score: 0 },
  { match_id: 3, series_id: 102, series_type: 1, radiant_win: true, radiant_team_name: 'X', dire_team_name: 'Y', radiant_team_id: 1, dire_team_id: 2, start_time: 3000, duration: 2100, radiant_score: 0, dire_score: 0 },
  { match_id: 4, series_id: 102, series_type: 1, radiant_win: true, radiant_team_name: 'X', dire_team_name: 'Y', radiant_team_id: 1, dire_team_id: 2, start_time: 4000, duration: 2000, radiant_score: 0, dire_score: 0 }
];
const bo5MislabeledResult = sources.groupSeries(bo5MislabeledMatches);
assert('一方赢3局（series_type误标为1）→ BO5', bo5MislabeledResult[0].boType === 'BO5', '实际: ' + bo5MislabeledResult[0].boType);
assert('BO5 误标场景 比分 3-1', bo5MislabeledResult[0].scoreA === 3 && bo5MislabeledResult[0].scoreB === 1, '实际: ' + bo5MislabeledResult[0].scoreA + '-' + bo5MislabeledResult[0].scoreB);
assert('BO5 误标场景 boLabel 正确', bo5MislabeledResult[0].boLabel === '五局三胜', '实际: ' + bo5MislabeledResult[0].boLabel);

// ===== 测试 2: BO2 双局积分（1-1 平局）=====
const bo2Matches = [
  { match_id: 10, series_id: 200, series_type: 0, radiant_win: true, radiant_team_name: 'Entity', dire_team_name: 'Talon', radiant_team_id: 3, dire_team_id: 4, start_time: 4000, duration: 2200, radiant_score: 0, dire_score: 0 },
  { match_id: 11, series_id: 200, series_type: 0, radiant_win: false, radiant_team_name: 'Entity', dire_team_name: 'Talon', radiant_team_id: 3, dire_team_id: 4, start_time: 5000, duration: 2500, radiant_score: 0, dire_score: 0 }
];
const bo2Result = sources.groupSeries(bo2Matches);
assert('BO2 series_type=0 两场聚合为 1 个系列', bo2Result.length === 1, '实际: ' + bo2Result.length);
assert('BO2 boType 正确（不应为 BO3）', bo2Result[0].boType === 'BO2', '实际: ' + bo2Result[0].boType);
assert('BO2 boLabel 正确', bo2Result[0].boLabel === '双局积分', '实际: ' + bo2Result[0].boLabel);
assert('BO2 比分 1-1', bo2Result[0].scoreA === 1 && bo2Result[0].scoreB === 1, '实际: ' + bo2Result[0].scoreA + '-' + bo2Result[0].scoreB);
assert('BO2 isDraw=true（平局）', bo2Result[0].isDraw === true, '实际: ' + bo2Result[0].isDraw);
assert('BO2 radiantWin=false（平局无胜者）', bo2Result[0].radiantWin === false);
assert('BO2 direWin=false（平局无胜者）', bo2Result[0].direWin === false);
assert('BO2 scoreACls=draw', bo2Result[0].scoreACls === 'draw', '实际: ' + bo2Result[0].scoreACls);
assert('BO2 scoreBCls=draw', bo2Result[0].scoreBCls === 'draw', '实际: ' + bo2Result[0].scoreBCls);
assert('BO2 boTagCls=bo-bo2', bo2Result[0].boTagCls === 'bo-bo2', '实际: ' + bo2Result[0].boTagCls);

// ===== 测试 3: BO2 非平局（2-0 横扫）=====
const bo2WinMatches = [
  { match_id: 20, series_id: 300, series_type: 0, radiant_win: true, radiant_team_name: 'Secret', dire_team_name: 'Nigma', radiant_team_id: 5, dire_team_id: 6, start_time: 6000, duration: 1800, radiant_score: 0, dire_score: 0 },
  { match_id: 21, series_id: 300, series_type: 0, radiant_win: true, radiant_team_name: 'Secret', dire_team_name: 'Nigma', radiant_team_id: 5, dire_team_id: 6, start_time: 7000, duration: 2000, radiant_score: 0, dire_score: 0 }
];
const bo2WinResult = sources.groupSeries(bo2WinMatches);
assert('BO2 2-0 boType 仍为 BO2', bo2WinResult[0].boType === 'BO2', '实际: ' + bo2WinResult[0].boType);
assert('BO2 2-0 比分正确', bo2WinResult[0].scoreA === 2 && bo2WinResult[0].scoreB === 0, '实际: ' + bo2WinResult[0].scoreA + '-' + bo2WinResult[0].scoreB);
assert('BO2 2-0 isDraw=false', bo2WinResult[0].isDraw === false);
assert('BO2 2-0 radiantWin=true', bo2WinResult[0].radiantWin === true);

// ===== 测试 4: BO5 五局三胜 =====
const bo5Matches = [
  { match_id: 30, series_id: 400, series_type: 2, radiant_win: true, radiant_team_name: 'Liquid', dire_team_name: 'OG', radiant_team_id: 7, dire_team_id: 8, start_time: 8000, duration: 1900, radiant_score: 0, dire_score: 0 },
  { match_id: 31, series_id: 400, series_type: 2, radiant_win: false, radiant_team_name: 'Liquid', dire_team_name: 'OG', radiant_team_id: 7, dire_team_id: 8, start_time: 9000, duration: 2100, radiant_score: 0, dire_score: 0 },
  { match_id: 32, series_id: 400, series_type: 2, radiant_win: true, radiant_team_name: 'Liquid', dire_team_name: 'OG', radiant_team_id: 7, dire_team_id: 8, start_time: 10000, duration: 2300, radiant_score: 0, dire_score: 0 }
];
const bo5Result = sources.groupSeries(bo5Matches);
assert('BO5 series_type=2 → 三场聚合为 1 个系列', bo5Result.length === 1);
assert('BO5 boType 正确', bo5Result[0].boType === 'BO5', '实际: ' + bo5Result[0].boType);
assert('BO5 boLabel 正确', bo5Result[0].boLabel === '五局三胜', '实际: ' + bo5Result[0].boLabel);
assert('BO5 比分 2-1', bo5Result[0].scoreA === 2 && bo5Result[0].scoreB === 1, '实际: ' + bo5Result[0].scoreA + '-' + bo5Result[0].scoreB);

// ===== 测试 5: BO1 单场 =====
const bo1Matches = [
  { match_id: 40, series_id: 0, series_type: 0, radiant_win: true, radiant_team_name: 'Spirit', dire_team_name: 'VP', radiant_team_id: 9, dire_team_id: 10, start_time: 11000, duration: 1700, radiant_score: 0, dire_score: 0 }
];
const bo1Result = sources.groupSeries(bo1Matches);
assert('BO1 单场聚合为 1 个系列', bo1Result.length === 1);
assert('BO1 boType 正确', bo1Result[0].boType === 'BO1', '实际: ' + bo1Result[0].boType);
assert('BO1 boLabel 正确', bo1Result[0].boLabel === '单局制', '实际: ' + bo1Result[0].boLabel);
assert('BO1 isMulti=false', bo1Result[0].isMulti === false);

// ===== 测试 6: series_id 为 null（无系列赛信息）=====
const nullSidMatches = [
  { match_id: 50, series_id: null, series_type: null, radiant_win: true, radiant_team_name: 'A', dire_team_name: 'B', radiant_team_id: 11, dire_team_id: 12, start_time: 12000, duration: 1800, radiant_score: 0, dire_score: 0 },
  { match_id: 51, series_id: null, series_type: null, radiant_win: false, radiant_team_name: 'A', dire_team_name: 'B', radiant_team_id: 11, dire_team_id: 12, start_time: 13000, duration: 1900, radiant_score: 0, dire_score: 0 }
];
const nullResult = sources.groupSeries(nullSidMatches);
assert('series_id=null 两场各自独立（不聚合）', nullResult.length === 2, '实际: ' + nullResult.length);
assert('series_id=null 第一场为 BO1', nullResult[0].boType === 'BO1' || nullResult[0].boType === 'BO2', '实际: ' + nullResult[0].boType);

// ===== 测试 7: 空数据 =====
assert('空数组返回空', sources.groupSeries([]).length === 0);
assert('null 返回空', sources.groupSeries(null).length === 0);

// ===== 测试 8: 多系列赛混合排序 =====
const mixedMatches = [
  { match_id: 60, series_id: 500, series_type: 1, radiant_win: true, radiant_team_name: 'X', dire_team_name: 'Y', radiant_team_id: 13, dire_team_id: 14, start_time: 14000, duration: 2000, radiant_score: 0, dire_score: 0 },
  { match_id: 61, series_id: 500, series_type: 1, radiant_win: true, radiant_team_name: 'X', dire_team_name: 'Y', radiant_team_id: 13, dire_team_id: 14, start_time: 15000, duration: 1800, radiant_score: 0, dire_score: 0 },
  { match_id: 62, series_id: 600, series_type: 0, radiant_win: false, radiant_team_name: 'P', dire_team_name: 'Q', radiant_team_id: 15, dire_team_id: 16, start_time: 16000, duration: 1700, radiant_score: 0, dire_score: 0 }
];
const mixedResult = sources.groupSeries(mixedMatches);
assert('混合 3 场聚合为 2 个系列', mixedResult.length === 2, '实际: ' + mixedResult.length);
// 按最新时间倒序：series 600 (start_time 16000) 在前
assert('混合排序：最新时间在前', mixedResult[0].lastTime >= mixedResult[1].lastTime, '实际: ' + mixedResult[0].lastTime + ' vs ' + mixedResult[1].lastTime);

console.log('');
console.log('=== 结果 ===');
console.log('通过: ' + pass + '  失败: ' + fail);
if (fail > 0) { console.log('存在失败 ❌'); process.exit(1); }
else { console.log('全部通过 ✅'); }
