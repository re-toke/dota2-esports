#!/usr/bin/env node
/**
 * 赛事赛段分层（main 正赛 / playin 预选赛）单元测试（2026-11-15）
 * 覆盖：窗口切分、赛后加赛防护、无窗口启发式（保守）、seriesStageOf、countSeries、空输入安全。
 * fixture 形状取自真实事故（1win Essence III / OpenDota leagueid=20486）：
 *   Play-In 11-07~11-11（弱队） + 正赛 11-12~11-15（强队），同一 leagueid。
 * 运行：node scripts/test/test-stages.js
 */
const stages = require('../../utils/stages.js');

let pass = 0, fail = 0;
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) { pass++; console.log('PASS  ' + msg); }
  else { fail++; console.log('FAIL  ' + msg + '  -> 实际 ' + a + ' / 期望 ' + b); }
}

const HOUR = 3600;
const DAY = 86400;
// Play-In 首日：2026-11-07 12:00 UTC；正赛窗口起点：2026-11-12 00:00 UTC
const PO = Math.floor(Date.UTC(2026, 10, 7, 12, 0, 0) / 1000);
const MAIN = Math.floor(Date.UTC(2026, 10, 12, 0, 0, 0) / 1000);
const MAIN_END = MAIN + 6 * DAY;   // 正赛 11-12 ~ 11-18

// 造 OpenDota match（字段名与真实响应一致）
function mk(matchId, seriesId, start, radiantId, direId) {
  return {
    match_id: matchId,
    series_id: seriesId,
    start_time: start,
    radiant_team_id: radiantId,
    dire_team_id: direId,
    radiant_win: true,
    duration: 2400
  };
}

// ===== fixture A：Play-In 5 组（弱队 9001~9006）+ 正赛 5 组（强队 8001~8006）=====
const PLAYIN_MATCHES = [
  mk(10001, 5001, PO, 9001, 9002),
  mk(10002, 5002, PO + DAY, 9003, 9004),
  mk(10003, 5003, PO + 2 * DAY, 9005, 9006),
  mk(10004, 5004, PO + 3 * DAY, 9001, 9003),
  mk(10005, 5005, PO + 4 * DAY, 9002, 9004)     // 11-11（正赛前一天）
];
const MAIN_MATCHES = [
  mk(20001, 6001, MAIN + 12 * HOUR, 8001, 8002),            // BO2 第一局
  mk(20002, 6001, MAIN + 12 * HOUR + 2 * HOUR, 8001, 8002), // 同系列第二局（countSeries 应只算 1 组）
  mk(20003, 6002, MAIN + DAY, 8003, 8004),
  mk(20004, 6003, MAIN + 2 * DAY, 8005, 8006),
  mk(20005, 6004, MAIN + 3 * DAY, 8001, 8003),
  mk(20006, 6005, MAIN + 4 * DAY, 8002, 8004)
];
const ALL = PLAYIN_MATCHES.concat(MAIN_MATCHES);

// ===== ① 有窗口：按 mainStart 切分 =====
(function () {
  const s = stages.splitStages(ALL, { mainStart: MAIN, mainEnd: MAIN_END });
  eq(s.basis, 'window', '① has window → basis=window');
  eq(s.mainStart, MAIN, '① mainStart 透传');
  eq(s.playin.length, 5, '① playin 场数 = 5（11-07~11-11）');
  eq(s.main.length, 6, '① main 场数 = 6（11-12~11-15）');
  eq(stages.countSeries(s.playin), 5, '① playin 组数 = 5');
  eq(stages.countSeries(s.main), 5, '① main 组数 = 5（BO2 两局算 1 组）');
  // 参赛队口径：playin 的弱队一律不进 main
  const mainTeams = {};
  s.main.forEach(function (m) { mainTeams[m.radiant_team_id] = true; mainTeams[m.dire_team_id] = true; });
  eq(Object.keys(mainTeams).sort(), ['8001', '8002', '8003', '8004', '8005', '8006'], '① main 队伍 = 正赛 6 支（不含预选赛队）');
  // ★ 2026-11-15 真实数据回归修正：容差由 6h 收紧为 0（原容差会把 11-11 晚间的
  //   Play-In 对局划进正赛 —— 1win Essence III 实测 main 变 15 队 / 赛期提前到 11-11）。
  const edge = [mk(30001, 7001, MAIN - 3 * HOUR, 8001, 8002), mk(30002, 7002, MAIN - 7 * HOUR, 9001, 9002)];
  const se = stages.splitStages(edge, { mainStart: MAIN });
  eq(se.main.length, 0, '① mainStart 前 3h（无容差）→ 归 playin（防预选赛混入）');
  eq(se.playin.length, 2, '① mainStart 前 3h / 7h → 均归 playin');
})();

// ===== ② 有窗口：赛后加赛（mainEnd + 72h 之后）归 playin =====
(function () {
  const list = [
    mk(40001, 8101, MAIN + DAY, 8001, 8002),
    mk(40002, 8102, MAIN_END + 5 * DAY, 9001, 9002)   // 正赛结束 5 天后（>72h）的加赛
  ];
  const s = stages.splitStages(list, { mainStart: MAIN, mainEnd: MAIN_END });
  eq(s.main.length, 1, '② mainEnd+72h 内的对局 → main');
  eq(s.playin.length, 1, '② mainEnd+72h 之后的对局 → playin（防赛后加赛污染）');
})();

// ===== ③ 无窗口：fixture A（段间仅 1 天）→ 保守不切 =====
(function () {
  const s = stages.splitStages(ALL, {});
  eq(s.basis, 'none', '③ 间隔 1 天（<72h）→ basis=none（不误切正常赛事）');
  eq(s.main.length, ALL.length, '③ 未切分时全部归 main');
  eq(s.playin.length, 0, '③ playin 为空');
  eq(s.mainStart, 0, '③ 未切分时 mainStart=0（调用方不按窗口过滤）');
})();

// ===== ④ 无窗口：间隔 ≥72h + 每段 ≥3 组 + 队伍几乎不重叠 → 启发式切分 =====
(function () {
  const early = Math.floor(Date.UTC(2026, 9, 29, 12, 0, 0) / 1000);   // 10-29（预选赛）
  const later = Math.floor(Date.UTC(2026, 10, 12, 12, 0, 0) / 1000);  // 11-12（正赛，间隔 14 天）
  const list = [
    mk(50001, 9001, early, 9101, 9102),
    mk(50002, 9002, early + DAY, 9103, 9104),
    mk(50003, 9003, early + 2 * DAY, 9105, 9106),
    mk(50004, 8001, later, 8001, 8002),
    mk(50005, 8002, later + DAY, 8003, 8004),
    mk(50006, 8003, later + 2 * DAY, 8005, 8006)
  ];
  const s = stages.splitStages(list, {});
  eq(s.basis, 'gap', '④ 间隔 14 天 + 队伍不重叠 → basis=gap');
  eq(stages.countSeries(s.playin), 3, '④ 早段 3 组归 playin');
  eq(stages.countSeries(s.main), 3, '④ 后段 3 组归 main');
  eq(s.mainStart, later, '④ mainStart = 正赛首场时间');
})();

// ===== ⑤ 无窗口：间隔 ≥72h 但两段队伍高度重叠（同一批队打的两阶段）→ 不切 =====
(function () {
  const early = Math.floor(Date.UTC(2026, 9, 29, 12, 0, 0) / 1000);
  const later = Math.floor(Date.UTC(2026, 10, 12, 12, 0, 0) / 1000);
  const list = [
    mk(60001, 9501, early, 8001, 8002),
    mk(60002, 9502, early + DAY, 8003, 8004),
    mk(60003, 9503, early + 2 * DAY, 8005, 8006),
    mk(60004, 9504, later, 8001, 8003),
    mk(60005, 9505, later + DAY, 8002, 8004),
    mk(60006, 9506, later + 2 * DAY, 8005, 8006)
  ];
  const s = stages.splitStages(list, {});
  eq(s.basis, 'none', '⑤ 队伍交集占比过高 → 不切（防把小组赛/淘汰赛误当两个赛段）');
  eq(s.main.length, 6, '⑤ 全部归 main');
})();

// ===== ⑥ seriesStageOf：卡片标注 =====
(function () {
  const split = stages.splitStages(ALL, { mainStart: MAIN, mainEnd: MAIN_END });
  const poSeries = { key: 's5001', start_time: PO };
  const mainSeries = { key: 's6001', start_time: MAIN + 12 * HOUR };
  const noTime = { key: 'liq-a__b-1' };
  eq(stages.seriesStageOf(poSeries, split), true, '⑥ 预选赛 series（start_time 在窗口前）→ true');
  eq(poSeries.isPlayin, true, '⑥ seriesStageOf 写回 isPlayin（wxml 直接读）');
  eq(stages.seriesStageOf(mainSeries, split), false, '⑥ 正赛 series → false');
  eq(stages.seriesStageOf(noTime, split), false, '⑥ 无时间字段 → false（不误标）');
  eq(stages.seriesStageOf(poSeries, { mainStart: 0 }), false, '⑥ 无切分（mainStart=0）→ false');
})();

// ===== ⑦ countSeries：series_id 去重 / 无 series_id 按 match_id =====
(function () {
  eq(stages.countSeries([]), 0, '⑦ 空数组 → 0');
  eq(stages.countSeries(null), 0, '⑦ null → 0');
  eq(stages.countSeries([
    mk(1, 111, PO, 1, 2),
    mk(2, 111, PO + 3600, 1, 2),   // 同系列
    mk(3, null, PO, 3, 4),         // 无 series_id → 按 match_id
    mk(4, 0, PO, 5, 6)             // series_id=0 视同缺失
  ]), 3, '⑦ series_id 去重 + 无 id 按 match_id 计');
})();

// ===== ⑧ 空/非法输入安全 =====
(function () {
  const e1 = stages.splitStages([]);
  eq([e1.main.length, e1.playin.length, e1.basis], [0, 0, 'none'], '⑧ 空数组 → {main:[],playin:[],basis:none}');
  const e2 = stages.splitStages(null, { mainStart: MAIN });
  eq([e2.main.length, e2.playin.length, e2.basis], [0, 0, 'none'], '⑧ null 输入 → 空结果');
  const e3 = stages.splitStages([null, undefined, 'x', 0], null);
  eq([e3.main.length, e3.playin.length, e3.basis], [0, 0, 'none'], '⑧ 非法元素被过滤 → 空结果');
  const e4 = stages.splitStages([mk(9, 9, 'bad-ts', 1, 2)], {});
  eq([e4.main.length, e4.basis], [1, 'none'], '⑧ 时间为非法值 → 归 main（不丢数据）');
})();

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
