#!/usr/bin/env node
// P3.1：utils/bracketLayout.js 单测
const bl = require('../../utils/bracketLayout.js');

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('PASS ', msg); }
  else { fail++; console.log('FAIL ', msg); }
}

function slot(roundNo, slotNo, side, t1, t2, extra) {
  return Object.assign({
    roundNo: roundNo, slotNo: slotNo, side: side || 'main',
    team1Name: t1 || 'TBD', team2Name: t2 || 'TBD',
    score1: 0, score2: 0, finished: false, empty: !t1 && !t2,
    matchIds: [], boType: 'BO3'
  }, extra || {});
}

// ===== 单败 8 队：QF 4 / SF 2 / GF 1 =====
const single = {
  rounds: [
    { no: 1, side: 'main', label: 'Quarterfinals', matches: [
      slot(1, 1, 'main', 'A', 'B'), slot(1, 2, 'main', 'C', 'D'),
      slot(1, 3, 'main', 'E', 'F'), slot(1, 4, 'main', 'G', 'H')
    ] },
    { no: 2, side: 'main', label: 'Semifinals', matches: [
      slot(2, 1, 'main', 'A', 'C', { score1: 2, score2: 1, finished: true }),
      slot(2, 2, 'main', 'E', 'G')
    ] },
    { no: 3, side: 'main', label: 'Grand Final', matches: [
      slot(3, 1, 'main', 'A', 'E', { matchIds: [8891145641] })
    ] }
  ]
};
const s = bl.layoutBracket(single, { formatTime: () => '' });
assert(s.sections.length === 1 && s.sections[0].side === 'main', '单败：1 个 main section');
assert(s.sections[0].cards.length === 7, `单败：7 张卡（实际 ${s.sections[0].cards.length}）`);
const qf = s.sections[0].cards.filter((c) => c.key === 'R1M1')[0];
const sf1 = s.sections[0].cards.filter((c) => c.key === 'R2M1')[0];
const gf = s.sections[0].cards.filter((c) => c.key === 'R3M1')[0];
assert(qf.x === 0 && qf.y === s.sections[0].y + 56, 'QF1 位于首列首行（含 section 头偏移）');
assert(sf1.x === 344, `SF1 x = 280+64（实际 ${sf1.x}）`);
assert(sf1.y === s.sections[0].y + 56 + 78, `SF1 y = 两源中心平均（实际相对 ${sf1.y - s.sections[0].y - 56}）`);
assert(gf.x === 688, `GF x 第三列（实际 ${gf.x}）`);
assert(gf.y === s.sections[0].y + 56 + 234, `GF y 居中（实际相对 ${gf.y - s.sections[0].y - 56}）`);
assert(s.sections[0].lines.length > 0, '单败：生成连线');
assert(sf1.winner === 'A' && sf1.score1 === 2, '胜者/比分写入卡片');
assert(gf.matchId === 8891145641, 'matchIds → 卡片 matchId（可跳转）');
assert(s.width === 3 * 280 + 2 * 64, `总宽 = 3 列（实际 ${s.width}）`);

// ===== 双败：upper / lower 分区 =====
const de = {
  rounds: [
    { no: 1, side: 'upper', label: 'Upper QF', matches: [slot(1, 1, 'upper', 'A', 'B'), slot(1, 2, 'upper', 'C', 'D')] },
    { no: 2, side: 'upper', label: 'Upper Final', matches: [slot(2, 1, 'upper', 'A', 'C')] },
    { no: 1, side: 'lower', label: 'Lower R1', matches: [slot(1, 5, 'lower', 'B', 'D')] },
    { no: 2, side: 'lower', label: 'Lower Final', matches: [slot(2, 3, 'lower', 'B', 'A')] },
    { no: 5, side: 'final', label: 'Grand Final', matches: [slot(5, 1, 'final', 'A', 'B')] }
  ]
};
const d = bl.layoutBracket(de);
assert(d.sections.map((x) => x.side).join(',') === 'upper,lower,final', '双败：upper/lower/final 三个分区');
assert(d.sections[1].y > d.sections[0].y + d.sections[0].height - 1, 'lower 分区在 upper 下方');
assert(d.sections[2].y > d.sections[1].y, 'final 分区在 lower 下方');

// ===== P4：Upper→Lower 降级线（Bracket/8U4L2DSL1D，与 PGL S9 / TI 2026 同构）=====
function pglRounds() {
  return [
    { no: 1, side: 'upper', label: 'Upper Quarterfinals', matches: [slot(1, 1, 'upper'), slot(1, 2, 'upper'), slot(1, 3, 'upper'), slot(1, 4, 'upper')] },
    { no: 2, side: 'upper', label: 'Upper Semifinals', matches: [slot(2, 1, 'upper'), slot(2, 2, 'upper')] },
    { no: 4, side: 'upper', label: 'Upper Final', matches: [slot(4, 1, 'upper')] },
    { no: 1, side: 'lower', label: 'Lower Round 1', matches: [slot(1, 5, 'lower'), slot(1, 6, 'lower')] },
    { no: 2, side: 'lower', label: 'Lower Quarterfinals', matches: [slot(2, 3, 'lower'), slot(2, 4, 'lower')] },
    { no: 3, side: 'lower', label: 'Lower Semifinal', matches: [slot(3, 1, 'lower')] },
    { no: 4, side: 'lower', label: 'Lower Final', matches: [slot(4, 2, 'lower')] },
    { no: 5, side: 'final', label: 'Grand Final', matches: [slot(5, 1, 'final')] }
  ];
}
const pgl = bl.layoutBracket({ type: 'Bracket/8U4L2DSL1D', rounds: pglRounds() }, { formatTime: () => '' });
assert(pgl.sections.map((x) => x.side).join(',') === 'upper,lower,final', 'P4：upper/lower/final 三分区');
assert(pgl.crossLines.length === 7 * 3, `P4：7 条降级边 × 3 段折线（实际 ${pgl.crossLines.length}）`);
const lowerR1 = pgl.sections[1].cards.filter((c) => c.key === 'R1M5')[0];
assert(lowerR1 && lowerR1.x === 344, `P4：lower 分区右移一列（R1M5 x 实际 ${lowerR1 && lowerR1.x}）`);
const upperR1 = pgl.sections[0].cards.filter((c) => c.key === 'R1M1')[0];
assert(upperR1 && upperR1.x === 0, 'P4：upper 分区不位移');
const lane = pgl.crossLines.filter((l) => l.width === 2 && l.left === 311)[0];
assert(!!lane, 'P4：降级竖线走 source 右侧通道（left=311）');
assert(pgl.crossLines.some((l) => l.left === 280), 'P4：降级线起点为 upper 卡右边缘（280）');
const pglNoFinal = bl.layoutBracket({ type: 'Bracket/8U4L2DSL1D', rounds: pglRounds().filter((r) => !(r.side === 'lower' && r.no === 4)) });
assert(pglNoFinal.crossLines.length === 6 * 3, `P4：缺目标槽 ⇒ 少一条边（实际 ${pglNoFinal.crossLines.length}）`);

// 单败 / 未知 type ⇒ 无降级线，且分区不位移
const se8 = bl.layoutBracket({ type: 'Bracket/8', rounds: single.rounds });
assert(se8.crossLines.length === 0, 'P4：单败 Bracket/8 无降级线');
const unknown = bl.layoutBracket({ type: 'Bracket/16U8L4D', rounds: pglRounds() });
assert(unknown.crossLines.length === 0, 'P4：未知 type 不画降级线（不臆测）');
assert(unknown.sections[1].cards[0].x === 0, 'P4：无降级线时 lower 分区不位移');

// ===== 空槽 =====
const empty = bl.layoutBracket({
  rounds: [{ no: 1, side: 'main', label: 'R1', matches: [slot(1, 1, 'main', '', '')] }]
});
const c = empty.sections[0].cards[0];
assert(c.empty === true && c.team1 === '待定' && c.team2 === '待定', '空槽渲染为「待定」卡');

// ===== 无数据 =====
assert(bl.layoutBracket(null).sections.length === 0, 'null 输入 → 空布局');

console.log(`\n=== 结果 ===\n通过: ${pass}  失败: ${fail}`);
process.exit(fail ? 1 : 0);
