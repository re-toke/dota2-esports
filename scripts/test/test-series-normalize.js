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

// ===== 4b. P1b：TBD / 去重键 / 模糊匹配 / 占位覆盖 =====
assert(sn.isTbd('TBD') && sn.isTbd('') && sn.isTbd('待定') && sn.isTbd('To be determined'), 'TBD 识别（含空串/中文/英文短语）');
assert(sn.isTbd('Team Secret') === false, '真实队名不判 TBD');
assert(sn.dedupeKey('A', 'TBD') === null, '含 TBD → 不生成去重键');
assert(sn.dedupeKey('Team Spirit', 'BetBoom Team') ===
  sn.normalizeTeamNameForDedup('Team Spirit') + '__' + sn.normalizeTeamNameForDedup('BetBoom Team'),
  '去重键使用统一归一化口径');
assert(sn.fuzzyMatchName('Team Falcons', 'Falcons') === true, '模糊匹配：去后缀后全等');
assert(sn.fuzzyMatchName('Nigma Galaxy', 'Nigma') === true, '模糊匹配：包含关系');
assert(sn.fuzzyMatchName('OG', 'XG') === false, '短名（<3）不模糊匹配');

const _nk = sn.normalizeTeamNameForDedup;
const _k1 = _nk('Team Yandex') + '__' + _nk('Natus Vincere');
const _keys = new Map([[_k1, 1000]]);
const _times = new Map([[_k1, [1000, 5000]]]);
assert(sn.placeholderCoveredByReal({ team1Name: 'Team Yandex', team2Name: 'TBD', startTime: 1000 + 3600 }, _keys, _times) === true,
  '占位卡：共同方严格相等 + 时间差<2h → 已覆盖');
assert(sn.placeholderCoveredByReal({ team1Name: 'Team Yandex', team2Name: 'TBD', startTime: 1000 + 5 * 3600 }, _keys, _times) === false,
  '占位卡：时间差 5h → 不覆盖（保留）');
assert(sn.placeholderCoveredByReal({ team1Name: 'TBD', team2Name: 'TBD', startTime: 1000 }, _keys, _times) === false,
  '双方 TBD → 不判定覆盖');
assert(sn.placeholderCoveredByReal({ team1Name: 'A', team2Name: 'B', startTime: 1000 }, _keys, _times) === false,
  '非占位卡 → 不处理');

// ===== 4c. P1b：开赛证据 / BO 上限（从页面 live 过滤抽出）=====
const NOW = 2000;
assert(sn.hasKickoffProof({ score1: 1, score2: 0, lastTime: 1000 }, NOW) === true, 'E1 比分非 0:0 → 有开赛证据');
assert(sn.hasKickoffProof({ matchIds: [123], lastTime: 1000 }, NOW) === true, 'E2 真实 matchId → 有开赛证据');
assert(sn.hasKickoffProof({ games: [{ radiant_win: false }], lastTime: 1000 }, NOW) === true, 'E3 games 已开赛 → 有开赛证据');
assert(sn.hasKickoffProof({ lastTime: 2000 }, 2000 + 20 * 60) === true, 'E4 规划时间过 15min → 放行（容忍数据延迟）');
assert(sn.hasKickoffProof({ lastTime: 2000 }, 2000 + 5 * 60) === false, '无证据且仅过 5min → 降级（不顺延误判 LIVE）');
assert(sn.hasKickoffProof({ lastTime: 0 }, NOW) === false, '无开赛时间 → 无证据');

assert(sn.isSeriesEndedByBoLimit({ scoreA: 2, scoreB: 1, boType: 'BO3' }) === true, 'BO3 2:1 → 达上限');
assert(sn.isSeriesEndedByBoLimit({ scoreA: 1, scoreB: 1, boType: 'BO3' }) === false, 'BO3 1:1 → 未达上限');
assert(sn.isSeriesEndedByBoLimit({ scoreA: 1, scoreB: 1, boType: 'BO2' }) === true, 'BO2 1:1 → 打满 2 局（达上限）');
assert(sn.isSeriesEndedByBoLimit({ scoreA: 1, scoreB: 0, boType: 'BO2' }) === false, 'BO2 1:0 → 未打满');
assert(sn.isSeriesEndedByBoLimit({ scoreA: 3, scoreB: 2, boType: 'BO5' }) === true, 'BO5 3:2 → 达上限');
assert(sn.isSeriesEndedByBoLimit({ scoreA: 2, scoreB: 2, boType: 'BO5' }) === false, 'BO5 2:2 → 未达上限');
assert(sn.isSeriesEndedByBoLimit({ seriesType: 1, scoreA: 2, scoreB: 0 }) === true, 'seriesType=1 → BO3 2:0 达上限');
assert(sn.isSeriesEndedByBoLimit({ scoreA: 0, scoreB: 0, boType: 'BO3' }) === false, '0:0 → 不判');

// ===== 4d. P1b：LP 时间窗过滤 =====
const BJ = 8 * 3600;
const _now = 1700000000;
const _todayStart = Math.floor((_now + BJ) / 86400) * 86400 - BJ;
const _win = (arr) => sn.filterLiquipediaCardsByWindow(arr, _now, BJ);
assert(_win([{ phase: 'live', lastTime: _now - 2 * 3600, score1: 1, score2: 0, boType: 'BO3' }]).length === 1,
  'LIVE：2h 前开赛且有比分 → 保留');
assert(_win([{ phase: 'live', lastTime: _now - 7 * 3600, score1: 1, score2: 0, boType: 'BO3' }]).length === 0,
  'LIVE：开赛超 6h → 剔除');
assert(_win([{ phase: 'live', lastTime: _now - 5 * 60, boType: 'BO3' }]).length === 0,
  'LIVE：刚过 5min 且无开赛证据 → 剔除（顺延等待）');
assert(_win([{ phase: 'live', lastTime: _now - 25 * 60, boType: 'BO3' }]).length === 1,
  'LIVE：过 15min 容忍窗 → 保留');
assert(_win([{ phase: 'live', lastTime: _now - 2 * 3600, scoreA: 2, scoreB: 0, boType: 'BO3' }]).length === 0,
  'LIVE：比分达 BO 上限 → 剔除（归 recent）');
assert(_win([{ phase: 'upcoming', lastTime: _todayStart + 3600, boType: 'BO3' }]).length === 1,
  'UPCOMING：今天内 → 保留');
assert(_win([{ phase: 'upcoming', lastTime: _todayStart + 4 * 86400, boType: 'BO3' }]).length === 0,
  'UPCOMING：超 3 天 → 剔除');
assert(_win([{ phase: 'recent', lastTime: _todayStart - 10 * 86400, boType: 'BO3' }]).length === 1,
  'RECENT：全部保留');

// ===== 4e. P1b-2：OD 归一 / LP 映射（golden 关键字段）=====
const _fmtStub = (m) => ({
  match_id: m.match_id, radiantWin: m.radiant_win, aWin: false, bWin: false,
  time: 't', duration: '', radiantName: m.radiant_team_name, direName: m.dire_team_name
});
const _odRaw = [
  { match_id: 1, radiant_team_id: 11, dire_team_id: 22, radiant_team_name: 'Alpha', dire_team_name: 'Beta', series_id: 99, start_time: 1000, radiant_win: true, duration: 100, game_mode: 22, lobby_type: 2 },
  { match_id: 2, radiant_team_id: 22, dire_team_id: 11, radiant_team_name: 'Beta', dire_team_name: 'Alpha', series_id: 99, start_time: 2000, radiant_win: false, duration: 100, game_mode: 22, lobby_type: 2 }
];
const _od = sn.normalizeOpenDotaSeries(_odRaw, { groupSeries: sources.groupSeries, fmt: _fmtStub, nowSec: 5000 });
assert(_od.length === 1, 'OD 归一：同一 series_id 聚合为 1 张卡');
assert(_od[0].games.length === 2, 'OD 归一：2 局都经 fmt 映射');
assert(_od[0].sources.join(',') === 'od', 'OD 归一：provenance=od');
assert(_od[0].phase === 'recent' && _od[0].scoreA === 2 && _od[0].scoreB === 0, 'OD 归一：比分/阶段来自 groupSeries');

const _realNow = Math.floor(Date.now() / 1000);
const _odUp = sn.normalizeOpenDotaSeries([{
  match_id: 3, radiant_team_id: 11, dire_team_id: 22, radiant_team_name: 'Alpha', dire_team_name: 'Beta',
  series_id: 100, start_time: _realNow + 3600, radiant_win: null, duration: 0, game_mode: 22, lobby_type: 2
}], { groupSeries: sources.groupSeries, fmt: _fmtStub, nowSec: _realNow });
assert(_odUp.length === 1 && !!_odUp[0].scheduledTimeText && !!_odUp[0].countdownText,
  'OD 归一：upcoming 卡补 scheduledTimeText/countdownText');

const _now2 = 1700000000;
const _lpUp = sn.mapLiquipediaCards([{
  team1Name: 'Alpha', team2Name: 'Beta', startTime: _now2 + 3600,
  phase: 'upcoming', boType: 'BO3', score1: 0, score2: 0, matchIds: []
}], { nowSec: _now2 });
assert(_lpUp.length === 1, 'LP 映射：输出 1 张卡');
assert(_lpUp[0].sources.join(',') === 'lp', 'LP 映射：provenance=lp');
assert(_lpUp[0].isUpcoming && _lpUp[0].phase === 'upcoming' && _lpUp[0].countdownText === '1小时后',
  'LP 映射：upcoming 倒计时（3600s）');
assert(_lpUp[0].boType === 'BO3' && _lpUp[0].boLabel === '三局两胜' && _lpUp[0].boTagCls === 'bo-bo3',
  'LP 映射：BO 展示字段');
assert(/^liq-.*-\d+$/.test(_lpUp[0].key), 'LP 映射：稳定 key（分钟桶）');

const _lpDecided = sn.mapLiquipediaCards([{
  team1Name: 'Alpha', team2Name: 'Beta', startTime: _now2 - 3600,
  phase: 'live', boType: 'BO3', score1: 2, score2: 1, matchIds: []
}], { nowSec: _now2 });
assert(_lpDecided[0].phase === 'recent' && _lpDecided[0].isLive === false,
  'LP 映射：2:1 BO3 → phase=recent 且 isLive=false');
assert(_lpDecided[0].isRecent === true, 'LP 映射：1h 前结束 → isRecent=true');

const _lpTbd = sn.mapLiquipediaCards([{
  team1Name: 'Team Yandex', team2Name: 'TBD', startTime: _now2 - 1200,
  phase: 'live', boType: 'BO3', score1: 0, score2: 0, matchIds: []
}], { nowSec: _now2 });
assert(_lpTbd[0].phase === 'upcoming' && _lpTbd[0].isLive === false,
  'LP 映射：TBD 对阵不得判 live → upcoming');

// ===== 4f. P2：来源 chip =====
assert(sn.sourceTagOf({ sources: ['od'] }).label === 'OD', '来源 chip：OD');
assert(sn.sourceTagOf({ sources: ['lp'] }).label === 'LP', '来源 chip：LP');
assert(sn.sourceTagOf({ sources: ['lp', 'od'] }).label === 'OD+LP', '来源 chip：OD+LP');
assert(sn.sourceTagOf({}).label === '', '来源 chip：无来源 → 空');

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

// ===== 8. P1b-3：三段分桶 + 排序（partitionSeries）=====
const nowSec = Math.floor(Date.UTC(2026, 9, 27, 12, 0, 0) / 1000);   // 北京时间 20:00
const mk = (o) => Object.assign({ radiantName: 'A', direName: 'B', boType: 'BO3', score1: 0, score2: 0 }, o);
const part = sn.partitionSeries([
  mk({ key: 'live-old', phase: 'live', lastTime: nowSec - 3600 }),
  mk({ key: 'live-new', phase: 'live', lastTime: nowSec - 600 }),
  mk({ key: 'up-今天晚', phase: 'upcoming', lastTime: nowSec + 3 * 3600 }),      // 北京 23:00 今天
  mk({ key: 'up-明天早', phase: 'upcoming', lastTime: nowSec + 8 * 3600 }),      // 北京次日 04:00
  mk({ key: 'recent-old', phase: 'recent', lastTime: nowSec - 7200 }),
  mk({ key: 'recent-new', phase: 'recent', lastTime: nowSec - 60 })
], { nowSec, bjOffsetSec: 8 * 3600 });

assert(part.liveList.map((s) => s.key).join(',') === 'live-new,live-old', '分区：LIVE 按 lastTime 倒序');
assert(part.recentList.map((s) => s.key).join(',') === 'recent-new,recent-old', '分区：RECENT 按 lastTime 倒序');
assert(part.upcomingList.map((s) => s.key).join(',') === 'up-今天晚,up-明天早', '分区：UPCOMING 按日期升序');
assert(part.upcomingList[0].dateGroup === 0 && part.upcomingList[1].dateGroup === 1,
  '分区：dateGroup 以北京时间日界计算（0=今天,1=明天）');

// 终局归一：live 2:0 BO3 → 移入 RECENT 并写回 phase
const ended = mk({ key: 'ended', phase: 'live', lastTime: nowSec - 100, score1: 2, score2: 0 });
const part2 = sn.partitionSeries([ended], { nowSec, bjOffsetSec: 8 * 3600 });
assert(part2.liveList.length === 0 && part2.recentList.length === 1 && ended.phase === 'recent',
  '分区：比分达终局先归一（live → recent）');

console.log(`\n=== 结果 ===\n通过: ${pass}  失败: ${fail}`);
process.exit(fail ? 1 : 0);
