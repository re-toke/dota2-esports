#!/usr/bin/env node
// P1（2026-10-25）：utils/seriesNormalize.js 单测
// 覆盖：比分形状归一（scoreA/scoreB vs score1/score2）、终局归一、provenance、不变量。
const sn = require('../../utils/seriesNormalize.js');
const sources = require('../../utils/sources.js');

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('PASS ', msg); }
  else { fail++; console.log('FAIL ', msg); }
}

// ===== 1. 比分形状归一（P1 实测：LP 路径原读 scoreA/scoreB ⇒ 恒 undefined）=====
assert(sn.scoresOf({ scoreA: 2, scoreB: 1 }).a === 2, 'scoreA 形状可读');
assert(sn.scoresOf({ score1: 2, score2: 1 }).a === 2 && sn.scoresOf({ score1: 2, score2: 1 }).b === 1,
  'score1/score2 形状可读（LP 原始）');
assert(sn.scoresOf(null).a === 0, '空输入 → 0:0');

// ===== 2. 终局判定（沿用 seriesStatus 口径：BO5/BO2 不判）=====
assert(sn.isDecided({ scoreA: 2, scoreB: 1, boType: 'BO3' }) === true, 'BO3 2:1 → 终局');
assert(sn.isDecided({ scoreA: 1, scoreB: 1, boType: 'BO3' }) === false, 'BO3 1:1 → 未终局');
assert(sn.isDecided({ scoreA: 3, scoreB: 2, boType: 'BO5' }) === false, 'BO5 3:2 → 保守不判（宁漏勿错）');
assert(sn.isDecided({ score1: 2, score2: 0, boType: 'BO3' }) === true, 'LP 形状 2:0 BO3 → 终局');

// ===== 3. 终局归一（phase + isLive 同步，防半修回归）=====
const lpLive = { phase: 'live', isLive: true, score1: 2, score2: 1, boType: 'BO3' };
assert(sn.normalizeTerminal(lpLive) === true && lpLive.phase === 'recent' && lpLive.isLive === false,
  'LP 形状 live 2:1 → phase=recent 且 isLive=false');
const stillLive = { phase: 'live', isLive: true, score1: 1, score2: 1, boType: 'BO3' };
assert(sn.normalizeTerminal(stillLive) === false && stillLive.phase === 'live', '1:1 不误归一');
const upcoming = { phase: 'upcoming', score1: 2, score2: 0, boType: 'BO3' };
assert(sn.normalizeTerminal(upcoming) === false, '非 live 不处理');

// ===== 4. provenance：标签去重 / 并集 =====
const s1 = { sources: ['od'] };
sn.addSource(s1, 'od');
assert(s1.sources.length === 1, 'addSource 去重（同键不追加）');
sn.addSource(s1, 'lp');
assert(s1.sources.join(',') === 'od,lp', 'addSource 追加新来源');
assert(sn.unionSources([{ sources: ['od'] }, { sources: ['lp', 'od'] }]).join(',') === 'od,lp',
  'unionSources 并集去重');

// ===== 5. 不变量 =====
const okList = [
  { key: 'ok1', phase: 'recent', radiantName: 'A', direName: 'B', scoreA: 2, scoreB: 1, boType: 'BO3', radiantWin: true },
  { key: 'ok2', phase: 'upcoming', radiantName: 'C', direName: 'D', scoreA: 0, scoreB: 0, boType: 'BO3' }
];
assert(sn.validateSeries(okList).length === 0, '合法系列无违规');

const violations = sn.validateSeries([
  { key: 'v1', phase: 'recent', radiantName: 'A', direName: 'B', scoreA: 3, scoreB: 0, boType: 'BO3' },
  { key: 'v2', phase: 'recent', radiantName: 'A', direName: 'B', scoreA: 4, scoreB: 3, boType: 'BO5' },
  { key: 'v3', phase: 'live', radiantName: 'Team A', direName: 'TBD', scoreA: 0, scoreB: 0, boType: 'BO3' },
  { key: 'v4', phase: 'recent', radiantName: 'A', direName: 'B', scoreA: 1, scoreB: 1, boType: 'BO2', radiantWin: true, direWin: true }
]);
const rules = violations.map((v) => v.rule);
assert(rules.indexOf('wins-exceed-max') >= 0, 'BO3 3:0 → wins-exceed-max');
assert(rules.indexOf('score-sum-exceeds-bo') >= 0, 'BO5 4:3 → score-sum-exceeds-bo');
assert(rules.indexOf('tbd-not-live') >= 0, 'TBD 参与却标 live → tbd-not-live');
assert(rules.indexOf('double-winner') >= 0, '双方同时获胜 → double-winner');

// ===== 6. 生产管线 provenance =====
const odSeries = sources.groupSeries([{
  match_id: 1, radiant_team_id: 11, dire_team_id: 22,
  radiant_team_name: 'Alpha', dire_team_name: 'Beta',
  series_id: 99, start_time: 1789990000, radiant_win: true,
  duration: 2400, game_mode: 22, lobby_type: 2
}]);
assert(odSeries.length === 1 && odSeries[0].sources && odSeries[0].sources.indexOf('od') >= 0,
  'groupSeries 输出带 sources:["od"]');

const lpSeries = sources.groupLiquipediaMatches([{
  team1Name: 'Alpha', team2Name: 'Beta', startTime: 1790000000,
  phase: 'upcoming', boType: 'BO3', matchIds: []
}]);
assert(lpSeries.length === 1 && lpSeries[0].sources && lpSeries[0].sources.indexOf('lp') >= 0,
  'groupLiquipediaMatches 输出带 sources:["lp"]');

// dedupe：保留卡继承被丢弃卡来源
const dupA = { key: 'a', phase: 'live', radiantName: 'Alpha', direName: 'Beta', series_id: 7, games: [], matchIds: [], sources: ['od'] };
const dupB = { key: 'b', phase: 'live', radiantName: 'Alpha', direName: 'Beta', series_id: 7, games: [], matchIds: [], sources: ['lp'] };
const deduped = sources.dedupeLiveSeries([dupA, dupB]);
assert(deduped.length === 1, 'dedupeLiveSeries 合并为 1 张');
assert(deduped[0].sources.join(',') === 'od,lp', 'dedupe 保留卡吸收来源（od,lp）');

// 拆裂 BO3 合并：merged.sources 取并集
const split1 = { key: 's1', phase: 'recent', radiantName: 'Alpha', direName: 'Beta', games: [{ radiant_win: true }], lastTime: 1790000000, seriesType: 1, sources: ['od'] };
const split2 = { key: 's2', phase: 'recent', radiantName: 'Beta', direName: 'Alpha', games: [{ radiant_win: false }], lastTime: 1790000600, seriesType: 1, sources: ['lp'] };
const merged = sources.mergeSplittedBo3Series([split1, split2]);
const mrg = merged.filter((x) => /^mrg_/.test(x.key || ''));
assert(mrg.length === 1, 'mergeSplittedBo3Series 产出 1 张合并卡');
assert(mrg.length === 1 && mrg[0].sources.join(',') === 'od,lp', '合并卡 sources 取并集（od,lp）');

// ===== 7. 合并优先级表存在（审计用途）=====
assert(Array.isArray(sn.MERGE_PRIORITY.period) && sn.MERGE_PRIORITY.period[0] === 'curation',
  'MERGE_PRIORITY.period 首项为 curation');

console.log(`\n=== 结果 ===\n通过: ${pass}  失败: ${fail}`);
process.exit(fail ? 1 : 0);
