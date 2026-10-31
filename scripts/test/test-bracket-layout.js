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
assert(qf.x === 12 && qf.y === s.sections[0].y + 56, 'QF1 位于首列首行（含 section 头 + PAD_X 偏移）');
assert(sf1.x === 356, `SF1 x = PAD_X + 280+64（实际 ${sf1.x}）`);
const _HALF_GAP = (bl.CARD_H + bl.CARD_GAP) / 2;
assert(sf1.y === s.sections[0].y + 56 + _HALF_GAP, `SF1 y = 两源中心平均（实际相对 ${sf1.y - s.sections[0].y - 56}）`);
assert(gf.x === 700, `GF x 第三列（实际 ${gf.x}）`);
assert(gf.y === s.sections[0].y + 56 + _HALF_GAP * 3, `GF y 居中（实际相对 ${gf.y - s.sections[0].y - 56}）`);
// ★ 2026-10-31（真机「视觉偏上/局促」）：画布四边留白 —— 卡片不贴边、底部不再切在卡下沿
assert(s.sections[0].y === 12, `留白：分区标题距画布上沿 12rpx（实际 ${s.sections[0].y}）`);
assert(s.width === 3 * 280 + 2 * 64 + 24, `留白：总宽含左右各 12rpx（实际 ${s.width}）`);
// 2026-10-28（第 4 步）：三行压两行 → 卡片高度 132 → 104（BO/LIVE 走角标，不占行高）
assert(bl.CARD_H === 104, `卡片高度：紧凑两行 = 104rpx（实际 ${bl.CARD_H}）`);
// ★ 2026-10-31（P0-3）：卡间距 32rpx —— 卡下沿要放「MM-DD HH:mm」时间行（6+22=28rpx）
assert(bl.CARD_GAP === 32, `卡片间距：时间行需要 32rpx（实际 ${bl.CARD_GAP}）`);
assert(s.cardH === bl.CARD_H, '布局输出带 cardH（页面据此内联卡片高度，与 CSS 单一来源）');
assert(s.sections[0].lines.length > 0, '单败：生成连线');
assert(sf1.winner === 'A' && sf1.score1 === 2, '胜者/比分写入卡片');
assert(gf.matchId === 8891145641, 'matchIds → 卡片 matchId（可跳转）');

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
// ★ 2026-10-31（其他赛制）：inline final 不再依赖 drops 映射 —— 未知 type 只要有 upper/main 也内联
assert(d.sections[2].label === '' &&
  d.sections[2].cards[0].x === d.sections[1].cards.filter((c) => c.key === 'R2M3')[0].x + 280 + 64 &&
  d.sections[2].cards[0].y === (d.sections[0].cards.filter((c) => c.key === 'R2M1')[0].y +
    d.sections[1].cards.filter((c) => c.key === 'R2M3')[0].y) / 2,
  'inline final：无分区标题、最右列、垂直居中于上/败者组决赛（未知 type 不再另起一段）');
assert(d.sections[2].rounds[0].short === '总决赛', 'inline final：轮次表头保留「总决赛」');
// 2026-10-28：分区标题 / 轮次表头中文化（方案 §12 缺口 10）
assert(d.sections[0].label === '胜者组' && d.sections[1].label === '败者组', '分区标题：Upper/Lower → 胜者组/败者组');
assert(bl.localizeRoundLabel('Upper Bracket Quarterfinals') === '胜者组¼决赛', '轮名：Upper Bracket Quarterfinals');
assert(bl.localizeRoundLabel('Lower Bracket Round 2') === '败者组第2轮', '轮名：Lower Bracket Round N');
assert(bl.localizeRoundLabel('Grand Final') === '总决赛', '轮名：Grand Final');
assert(bl.localizeRoundLabel('Upper Bracket Semifinals') === '胜者组半决赛', '轮名：Upper Bracket Semifinals');
assert(bl.localizeRoundLabel('Custom Round X') === 'Custom Round X', '轮名：未知保留原文（不硬猜）');
assert(bl.localizeRoundLabel('') === '', '轮名：空串保持空（由调用方回退 R{n}）');

// ===== 2026-10-28（真机 UI 复盘）：无数据标记 + 败者组紧凑排布 =====
const ns = bl.layoutBracket({
  rounds: [
    { no: 1, side: 'main', label: 'R1', matches: [
      slot(1, 1, 'main', 'A', 'B', { finished: true, score1: '', score2: '' }),
      slot(1, 2, 'main', 'C', 'D', { finished: true, score1: 2, score2: 1 })
    ] }
  ]
});
const nsCards = ns.sections[0].cards;
assert(nsCards[0].noScore === true, '无数据：已结束且两源无比分 → noScore=true');
assert(nsCards[1].noScore === false, '无数据：有比分 → noScore=false');
assert(nsCards[2] === undefined && nsCards[3] === undefined, '无数据：不额外生成卡片');

const compact = {
  rounds: [
    { no: 1, side: 'lower', label: 'Lower R1', matches: [slot(1, 5, 'lower', 'A', 'B'), slot(1, 6, 'lower', 'C', 'D')] },
    { no: 2, side: 'lower', label: 'Lower R2', matches: [slot(2, 3, 'lower', 'A', 'C'), slot(2, 4, 'lower', 'B', 'D')] }
  ]
};
const cView = bl.layoutBracket(compact);
const lCards = cView.sections[0].cards;
const r1m5 = lCards.filter((c) => c.key === 'R1M5')[0];
const r1m6 = lCards.filter((c) => c.key === 'R1M6')[0];
const r2m3 = lCards.filter((c) => c.key === 'R2M3')[0];
const r2m4 = lCards.filter((c) => c.key === 'R2M4')[0];
// ★ 2026-10-31（其他赛制）：上下轮数量相同 ⇒ 1:1 晋级，同排对齐（原 2j/2j+1 会阶梯错位）
assert(r2m3.y === r1m5.y && r2m4.y === r1m6.y,
  '紧凑排布：同数轮 1:1 对齐（R2M3/R2M4 与 R1M5/R1M6 同排，不再错位下移）');
assert(cView.height < bl.CARD_H * 6, '紧凑排布：画布高度不指数膨胀');

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
assert(lowerR1 && lowerR1.x === 356, `P4：lower 分区右移一列（R1M5 x 实际 ${lowerR1 && lowerR1.x}）`);
const upperR1 = pgl.sections[0].cards.filter((c) => c.key === 'R1M1')[0];
assert(upperR1 && upperR1.x === 12, 'P4：upper 分区不位移（仅 PAD_X）');
const lane = pgl.crossLines.filter((l) => l.width === 2 && l.left === 323)[0];
assert(!!lane, 'P4：降级竖线走 source 右侧通道（left=323）');
assert(pgl.crossLines.some((l) => l.left === 292), 'P4：降级线起点为 upper 卡右边缘（292）');
const lowerR2 = pgl.sections[1].cards.filter((c) => c.key === 'R2M3')[0];
assert(!!lowerR2 && lowerR2.y === lowerR1.y, 'P4：败者组同数轮 1:1 对齐（R2M3 与 R1M5 同排）');
const pglNoFinal = bl.layoutBracket({ type: 'Bracket/8U4L2DSL1D', rounds: pglRounds().filter((r) => !(r.side === 'lower' && r.no === 4)) });
assert(pglNoFinal.crossLines.length === 6 * 3, `P4：缺目标槽 ⇒ 少一条边（实际 ${pglNoFinal.crossLines.length}）`);

// ===== ★ 2026-10-31（真机反馈 2）：inline final —— 总决赛放到最右列、垂直居中于上/败者组决赛 =====
const NOW = 1793400000;
const pglUpperSec = pgl.sections[0];
const pglFinalSec = pgl.sections[2];
const ufCard = pglUpperSec.cards.filter((c) => c.key === 'R4M1')[0];   // 胜者组决赛（决赛）
const lfCard = pgl.sections[1].cards.filter((c) => c.key === 'R4M2')[0]; // 败者组决赛
const gfCard = pglFinalSec.cards.filter((c) => c.key === 'R5M1')[0];
assert(!!lfCard && !!gfCard && gfCard.x === lfCard.x + 280 + 64,
  `inline final：总决赛在败者组决赛右侧一列（最右列，实际 x=${gfCard && gfCard.x}）`);
assert(!!ufCard && !!gfCard && gfCard.y === (ufCard.y + lfCard.y) / 2,
  'inline final：总决赛垂直居中于胜者组决赛 / 败者组决赛之间');
assert(pglFinalSec.label === '', 'inline final：无分区标题');
assert(Math.abs(gfCard.y - (pglFinalSec.y + 24)) === 36,
  'inline final：轮次表头紧跟卡上方（原飘在分区顶部）');
assert(pglFinalSec.height === 0, 'inline final：不占额外垂直空间（画布不为它增高）');
assert(pglFinalSec.rounds.length === 1 && pglFinalSec.rounds[0].roundNo === 5 &&
  pglFinalSec.rounds[0].short === '总决赛', 'inline final：轮次表头 roundNo=5 / short=总决赛');
const gfLane = gfCard.x - 64 / 2;
assert(pglFinalSec.lines.some((l) => l.left === ufCard.x + 280 && l.top === ufCard.y + 51 && l.width === gfLane - (ufCard.x + 280)),
  'inline final：胜者组决赛 → 总决赛 手肘线（水平段）');
assert(pglFinalSec.lines.some((l) => l.left === lfCard.x + 280 && l.top === lfCard.y + 51),
  'inline final：败者组决赛 → 总决赛 手肘线（水平段）');
assert(pglFinalSec.lines.length === 5, `inline final：两源各 2 段 + 共享入卡段（实际 ${pglFinalSec.lines.length}）`);
assert(ufCard.y > 0 && gfCard.y > 0, 'inline final：坐标已含 PAD_TOP（不与标题重叠）');

// 时间骨架（总决赛双方待定但已排期）也必须显示开赛时分
const gfTimeView = bl.layoutBracket({
  type: 'Bracket/8U4L2DSL1D',
  rounds: pglRounds().map((r) => (r.side === 'final'
    ? Object.assign({}, r, { matches: [slot(5, 1, 'final', '', '', { startTime: NOW + 3600 })] })
    : r))
}, { formatDateTime: (t) => 'T' + t, nowSec: NOW });
const gfTimeCard = gfTimeView.sections[2].cards.filter((c) => c.key === 'R5M1')[0];
assert(!!gfTimeCard && gfTimeCard.empty === true && gfTimeCard.timeLabel === 'T' + (NOW + 3600) &&
  gfTimeCard.timeCls === 'is-next', '总决赛：双方待定也显示开赛时间（不再丢时分）');
// 总决赛有队伍且已排期 → 「下一场」选轮必须能聚焦到 inline final 分区（roundNo=5）
const gfFocusView = bl.layoutBracket({
  type: 'Bracket/8U4L2DSL1D',
  rounds: pglRounds().map((r) => (r.side === 'final'
    ? Object.assign({}, r, { matches: [slot(5, 1, 'final', 'A', 'B', { startTime: NOW + 3600 })] })
    : r))
}, { nowSec: NOW });
const gfFocus = bl.findCurrentRound(gfFocusView, NOW);
assert(!!gfFocus && gfFocus.side === 'final' && gfFocus.roundNo === 5,
  `当前轮：inline final 分区可聚焦（实际 ${gfFocus && gfFocus.side + '/' + gfFocus.roundNo}）`);

// 单败 / 未知 type ⇒ 无降级线，且分区不位移
const se8 = bl.layoutBracket({ type: 'Bracket/8', rounds: single.rounds });
assert(se8.crossLines.length === 0, 'P4：单败 Bracket/8 无降级线');
const unknown = bl.layoutBracket({ type: 'Bracket/16U8L4D', rounds: pglRounds() });
assert(unknown.crossLines.length === 0, 'P4：未知 type 不画降级线（不臆测）');
assert(unknown.sections[1].cards[0].x === 12, 'P4：无降级线时 lower 分区不位移（仅 PAD_X）');

// ===== ★ 2026-10-31（其他赛制）：单败 + 季军赛（EWC Playoffs Bracket/8 同构）=====
// 修复前：Grand Final / Third Place 各自单独占一段，全部堆在画布左下角、无连线。
const ewcView = bl.layoutBracket({
  type: 'Bracket/8',
  rounds: [
    { no: 1, side: 'main', label: 'Quarterfinals', matches: [
      slot(1, 1, 'main', 'A', 'B'), slot(1, 2, 'main', 'C', 'D'),
      slot(1, 3, 'main', 'E', 'F'), slot(1, 4, 'main', 'G', 'H')] },
    { no: 2, side: 'main', label: 'Semifinals', matches: [slot(2, 1, 'main', 'A', 'C'), slot(2, 2, 'main', 'E', 'G')] },
    { no: 3, side: 'final', label: 'Grand Final', matches: [slot(3, 1, 'final', 'A', 'E')] },
    { no: 1, side: 'third', label: 'Third Place Match', matches: [slot(0, 1, 'third', 'B', 'F')] }
  ]
});
assert(ewcView.sections.map((x) => x.side).join(',') === 'main,third,final', '单败+季军：main/third/final 分区');
const ewcMain = ewcView.sections[0];
const ewcThird = ewcView.sections[1];
const ewcFinal = ewcView.sections[2];
const ewcSf1 = ewcMain.cards.filter((c) => c.key === 'R2M1')[0];
const ewcSf2 = ewcMain.cards.filter((c) => c.key === 'R2M2')[0];
const ewcGf = ewcFinal.cards.filter((c) => c.key === 'R3M1')[0];
assert(!!ewcSf1 && !!ewcSf2 && !!ewcGf, '单败+季军：半决赛 / 总决赛卡齐全');
assert(ewcGf.x === ewcSf1.x + 280 + 64, '单败：总决赛接在半决赛右侧一列');
assert(Math.abs(ewcGf.y - (ewcSf1.y + ewcSf2.y) / 2) < 1, '单败：总决赛垂直居中于两场半决赛');
const ewcGfLines = ewcMain.lines.filter((l) => l.width === 2 && l.left === ewcGf.x - 64 / 2 - 1);
assert(ewcGfLines.length === 2, `单败：两场半决赛各一条竖线汇入总决赛（实际 ${ewcGfLines.length}）`);
assert(ewcThird.y > ewcMain.y + ewcMain.height - 1, '季军赛：独立分段（不与冠军路径混排）');
assert(ewcView.crossLines.length === 0, '单败：无降级线');

// ===== ★ 2026-10-31（其他赛制）：未知 type 的双败（BLAST Bracket/4L2DS 同构）=====
// 修复前：没有 drops 映射 ⇒ 总决赛仍被推到最下方另起一段。
const blastView = bl.layoutBracket({
  type: 'Bracket/4L2DS',
  rounds: [
    { no: 1, side: 'upper', label: 'Upper Bracket Semifinals', matches: [slot(1, 1, 'upper', 'A', 'B'), slot(1, 2, 'upper', 'C', 'D')] },
    { no: 2, side: 'upper', label: 'Upper Bracket Final', matches: [slot(2, 1, 'upper', 'A', 'C')] },
    { no: 1, side: 'lower', label: 'Lower Bracket Round 1', matches: [slot(1, 3, 'lower', 'B', 'D')] },
    { no: 2, side: 'lower', label: 'Lower Bracket Final', matches: [slot(2, 2, 'lower', 'B', 'A')] },
    { no: 3, side: 'final', label: 'Grand Final', matches: [slot(3, 1, 'final', 'A', 'B')] }
  ]
});
assert(blastView.sections.map((x) => x.side).join(',') === 'upper,lower,final', '未知双败：upper/lower/final 分区');
assert(blastView.crossLines.length === 0, '未知双败：仍不画降级线（不臆测）');
const blastUf = blastView.sections[0].cards.filter((c) => c.key === 'R2M1')[0];
const blastLf = blastView.sections[1].cards.filter((c) => c.key === 'R2M2')[0];
const blastGf = blastView.sections[2].cards.filter((c) => c.key === 'R3M1')[0];
assert(!!blastUf && !!blastLf && !!blastGf && blastGf.x === blastLf.x + 280 + 64,
  '未知双败：总决赛在败者组决赛右侧独立一列（不再夹在两半区中间）');
assert(!!blastGf && blastGf.y === (blastUf.y + blastLf.y) / 2,
  '未知双败：总决赛垂直居中于上/败者组决赛之间');
assert(blastView.sections[1].cards[0].x === 12, '未知双败：败者组不位移（仅 PAD_X）');
assert(blastView.sections[2].lines.length === 5, '未知双败：上/败者组决赛两条手肘线汇入总决赛');

// ===== ★ 2026-10-31（其他赛制）：Survival（Bracket/8L4D-4Q）—— 同数轮 1:1 晋级 =====
// 修复前：R1/R2 都是 4 场，按 2:1 中心平均 ⇒ R2 前两张挤在两卡之间、后两张被甩到下方。
const survivalView = bl.layoutBracket({
  type: 'Bracket/8L4D-4Q',
  rounds: [
    { no: 1, side: 'main', label: 'Round 1', matches: [
      slot(1, 1, 'main', 'A', 'B'), slot(1, 2, 'main', 'C', 'D'),
      slot(1, 3, 'main', 'E', 'F'), slot(1, 4, 'main', 'G', 'H')] },
    { no: 2, side: 'main', label: 'Round 2', matches: [
      slot(2, 1, 'main', 'A', 'C'), slot(2, 2, 'main', 'E', 'G'),
      slot(2, 3, 'main', 'I', 'J'), slot(2, 4, 'main', 'K', 'L')] }
  ]
});
const svR1 = survivalView.sections[0].cards.filter((c) => (c.roundNo || 0) === 1);
const svR2 = survivalView.sections[0].cards.filter((c) => (c.roundNo || 0) === 2);
assert(svR1.length === 4 && svR2.length === 4, 'Survival：R1/R2 各 4 场');
assert(svR2[0].y === svR1[0].y && svR2[3].y === svR1[3].y, 'Survival：R2 与 R1 同排对齐（1:1 晋级）');
assert(svR2[0].x === 356 && svR1[2].x === 12, 'Survival：两列正常列距（无额外位移）');
assert(!survivalView.sections[0].lines.some((l) => l.width === 2), 'Survival：1:1 只需水平连线（无竖向折线）');
assert(survivalView.height < bl.CARD_H * 9, 'Survival：画布高度不膨胀（2 轮 4 卡同排）');

// ===== 2026-10-28（第 4 步 · 真机截图复盘）：轮次标题去重（分区标题已表明 upper/lower）=====
assert(pgl.sections[0].rounds[0].label === '胜者组¼决赛', '轮次标题：导航 chip 保留全名（跨分区可区分）');
assert(pgl.sections[0].rounds[0].short === '¼决赛', '轮次标题：画布去掉分区前缀（胜者组¼决赛 → ¼决赛）');
assert(pgl.sections[0].rounds[1].short === '半决赛', '轮次标题：胜者组半决赛 → 半决赛');
assert(pgl.sections[1].rounds[0].short === '第1轮', '轮次标题：败者组第1轮 → 第1轮');
assert(pgl.sections[2].rounds[0].short === '总决赛', '轮次标题：inline final 无分区标题 ⇒ 画布保留「总决赛」（原为留空隐藏）');
assert(s.sections[0].rounds[0].short === '¼决赛', '轮次标题：单败 main 分区 Quarterfinals → ¼决赛');

// ===== 2026-10-28（第 4 步 · 真机 UI）：卡面契约（源码守卫）=====
const fs = require('fs');
const path = require('path');
const _wxml = fs.readFileSync(path.join(__dirname, '../../subpackages/detail/league-detail/league-detail.wxml'), 'utf8');
const _wxss = fs.readFileSync(path.join(__dirname, '../../subpackages/detail/league-detail/league-detail.wxss'), 'utf8');
const _js = fs.readFileSync(path.join(__dirname, '../../subpackages/detail/league-detail/league-detail.js'), 'utf8');
assert(_wxml.indexOf('class="brk-meta"') < 0, '卡面：移除第三行 meta（BO/时间改角标，不占行高）');
assert(_wxml.indexOf('brk-badge') > 0 && _wxml.indexOf('item.boType') > 0, '卡面：BO / LIVE 右上角徽标');
assert(_wxml.indexOf('class="brk-badge">{{item.boType}}') > 0, '卡面：BO 徽标常显（不随「显示赛程」开关）');
assert(_wxml.indexOf('{{bracketView.cardH}}') > 0, '卡面：卡片高度取 bracketView.cardH（与 CARD_H 单一来源）');
assert(_wxml.indexOf('rd.short') > 0, '卡面：轮次标题用 short（不重复分区名）');
assert(/showBracketSchedule:\s*true/.test(_js), '默认：赛程时间开启（★ 2026-10-31 需要具体开赛时分）');
assert(/leagueDetail\.brkSchedule/.test(_js), '持久化：赛程开关写入本地存储并回读');
assert(/\.brk-card\s*\{[^}]*height:\s*104rpx/.test(_wxss), '样式：.brk-card 高度 104rpx');
assert(/\.brk-card\.has-bo \.brk-team/.test(_wxss) && /\.brk-card\.has-live \.brk-team/.test(_wxss),
  '样式：徽标占位 → 两行比分统一内缩（左右同列）');
assert(/\.standings-card\s*\{[^}]*border:\s*1rpx solid/.test(_wxss) &&
  /\.lp-group-card\s*\{[^}]*border:\s*1rpx solid/.test(_wxss),
  '视觉统一：小组积分卡 / 战绩卡 同容器（白底 + 1rpx 边框）');

// ===== ★ 2026-10-31（P0-3）：赛程时间到「时:分」+ 状态配色 + 「下一场」选轮 =====
const tv = bl.layoutBracket({
  rounds: [{ no: 1, side: 'main', label: 'R1', matches: [
    slot(1, 1, 'main', 'A', 'B', { startTime: NOW - 7200, finished: true, score1: 2, score2: 1 }),
    slot(1, 2, 'main', 'C', 'D', { startTime: NOW + 7200 })
  ] }]
}, { formatDateTime: (t) => 'T' + t, nowSec: NOW });
const tc1 = tv.sections[0].cards.filter((c) => c.key === 'R1M1')[0];
const tc2 = tv.sections[0].cards.filter((c) => c.key === 'R1M2')[0];
assert(tc1.timeLabel === 'T' + (NOW - 7200) && tc1.timeCls === 'is-past', '时间：已开赛 → is-past + 格式化文案');
assert(tc2.timeLabel === 'T' + (NOW + 7200) && tc2.timeCls === 'is-next', '时间：未开赛 → is-next');
assert(tc1.startTime === NOW - 7200, '时间：卡片带 startTime（供「下一场」选轮）');

const liveCard = bl.layoutBracket({
  rounds: [{ no: 1, side: 'main', label: 'R1', matches: [
    slot(1, 1, 'main', 'A', 'B', { startTime: NOW - 600, phase: 'live' })
  ] }]
}, { nowSec: NOW }).sections[0].cards[0];
assert(liveCard.timeCls === 'is-live', '时间：LIVE → is-live 配色');

const nextView = bl.layoutBracket({
  type: 'Bracket/8U4L2DSL1D',
  rounds: [
    { no: 1, side: 'upper', label: 'UB R1', matches: [slot(1, 1, 'upper', 'A', 'B', { finished: true, score1: 2, score2: 0 })] },
    { no: 2, side: 'upper', label: 'UB Final', matches: [slot(2, 1, 'upper', 'A', 'C', { startTime: NOW + 7200 })] },
    { no: 4, side: 'lower', label: 'LB Final', matches: [slot(4, 1, 'lower', 'D', 'E', { startTime: NOW + 3600 })] }
  ]
});
const nx = bl.findCurrentRound(nextView, NOW);
assert(!!nx && nx.side === 'lower', '当前轮：优先选「最早未开赛」的一场（败者组决赛更早）');

// ===== 空槽 =====
const empty = bl.layoutBracket({
  rounds: [{ no: 1, side: 'main', label: 'R1', matches: [slot(1, 1, 'main', '', '')] }]
});
const c = empty.sections[0].cards[0];
assert(c.empty === true && c.team1 === '待定' && c.team2 === '待定', '空槽渲染为「待定」卡');

// ===== 填充态：rounds 为空槽、slots 为 Match 页合并后的真实内容（CI 落库形状）=====
const filled = bl.layoutBracket({
  type: 'Bracket/8',
  rounds: [{ no: 1, side: 'main', label: 'Quarterfinals', matches: [
    slot(1, 1, 'main', '', ''), slot(1, 2, 'main', '', '')
  ] }],
  slots: [
    slot(1, 1, 'main', 'Iron Wing', 'Team Spirit', { key: 'R1M1', matchIds: [8900771154] }),
    slot(1, 2, 'main', 'Aurora', 'Tundra', { key: 'R1M2' })
  ]
});
const f1 = filled.sections[0].cards.filter((x) => x.key === 'R1M1')[0];
assert(!!f1 && f1.team1 === 'Iron Wing' && f1.team2 === 'Team Spirit', '填充态：slots 真实队名覆盖 rounds 空槽');
assert(!!f1 && f1.empty === false, '填充态：空槽标记以 slots 为准');
assert(!!f1 && f1.matchId === 8900771154, '填充态：slots 的 matchIds 用于跳转');

// ===== P4：当前轮定位 =====
const curView = bl.layoutBracket({
  type: 'Bracket/8',
  slots: [],
  rounds: [
    { no: 1, side: 'main', label: 'R1', matches: [slot(1, 1, 'main', 'A', 'B', { finished: true, score1: 2, score2: 1 })] },
    { no: 2, side: 'main', label: 'R2', matches: [slot(2, 1, 'main', 'A', 'C', { phase: 'live' })] }
  ]
});
const cur = bl.findCurrentRound(curView);
assert(!!cur && cur.side === 'main' && cur.roundNo === 2, '当前轮：LIVE 卡所在轮为焦点');
assert(!!cur && cur.x === curView.sections[0].rounds[1].x, '当前轮：x 取该轮表头坐标');
assert(!!cur && cur.left === Math.max(0, cur.x - 24), '当前轮：scroll-left 预留 24rpx 呼吸位');

// 无 LIVE：取最早「有队伍且未完赛」的轮
const curView2 = bl.layoutBracket({
  type: 'Bracket/8',
  slots: [],
  rounds: [
    { no: 1, side: 'main', label: 'R1', matches: [slot(1, 1, 'main', 'A', 'B', { finished: true, score1: 2, score2: 0 })] },
    { no: 2, side: 'main', label: 'R2', matches: [slot(2, 1, 'main', 'A', 'C')] }
  ]
});
assert(bl.findCurrentRound(curView2).roundNo === 2, '当前轮：无 LIVE 时取未完赛轮');

// 全部完赛：退回最后一轮（决赛）
const curView3 = bl.layoutBracket({
  type: 'Bracket/8',
  slots: [],
  rounds: [
    { no: 1, side: 'main', label: 'R1', matches: [slot(1, 1, 'main', 'A', 'B', { finished: true, score1: 2, score2: 0 })] },
    { no: 2, side: 'main', label: 'R2', matches: [slot(2, 1, 'main', 'A', 'C', { finished: true, score1: 3, score2: 1 })] }
  ]
});
assert(bl.findCurrentRound(curView3).roundNo === 2, '当前轮：全部完赛取最后一轮');
assert(bl.findCurrentRound(null) === null, '当前轮：空视图返回 null');

// R1 残留未完赛卡、R2 进行中 → 焦点不能被拉回 R1
const curView4 = bl.layoutBracket({
  type: 'Bracket/8',
  slots: [],
  rounds: [
    { no: 1, side: 'main', label: 'R1', matches: [
      slot(1, 1, 'main', 'A', 'B', { finished: true, score1: 2, score2: 0 }), slot(1, 2, 'main', 'C', 'D')
    ] },
    { no: 2, side: 'main', label: 'R2', matches: [
      slot(2, 1, 'main', 'A', 'C', { finished: true, score1: 2, score2: 1 }), slot(2, 2, 'main', 'B', 'D')
    ] }
  ]
});
assert(bl.findCurrentRound(curView4).roundNo === 2, '当前轮：早期残留卡不拉回焦点');

// 双败：upper 已完赛、lower 进行中 → 焦点在 lower
const curView5 = bl.layoutBracket({
  type: 'Bracket/8U4L2DSL1D',
  slots: [],
  rounds: [
    { no: 1, side: 'upper', label: 'UB R1', matches: [slot(1, 1, 'upper', 'A', 'B', { finished: true, score1: 2, score2: 0 })] },
    { no: 1, side: 'lower', label: 'LB R1', matches: [slot(1, 1, 'lower', 'C', 'D')] }
  ]
});
assert(bl.findCurrentRound(curView5).side === 'lower', '当前轮：双败取未完成分区');

// ===== ★ 2026-10-31（其他赛制全面回归）：16 队单败 / 16 队双败 / 无 final 标记 / 多场总决赛 =====
// 16 队单败 + 季军：总决赛接在半决赛右侧一列、垂直居中于两场半决赛
const se16 = bl.layoutBracket({
  type: 'Bracket/16',
  rounds: [
    { no: 1, side: 'main', label: 'Round of 16', matches: Array.from({ length: 8 }, (_, i) => slot(1, i + 1, 'main')) },
    { no: 2, side: 'main', label: 'Quarterfinals', matches: Array.from({ length: 4 }, (_, i) => slot(2, i + 1, 'main')) },
    { no: 3, side: 'main', label: 'Semifinals', matches: [slot(3, 1, 'main'), slot(3, 2, 'main')] },
    { no: 99, side: 'third', label: 'Third Place Match', matches: [slot(99, 1, 'third')] },
    { no: 4, side: 'final', label: 'Grand Final', matches: [slot(4, 1, 'final')] }
  ]
});
assert(se16.sections.map((s) => s.side).join(',') === 'main,third,final', '16 队单败：main/third/final 分区');
const s16sf1 = se16.sections[0].cards.filter((c) => c.key === 'R3M1')[0];
const s16sf2 = se16.sections[0].cards.filter((c) => c.key === 'R3M2')[0];
const s16gf = se16.sections[2].cards[0];
assert(!!s16gf && s16gf.x === s16sf1.x + 344 && s16gf.y === (s16sf1.y + s16sf2.y) / 2,
  '16 队单败：总决赛在半决赛右侧一列、垂直居中');
assert(se16.sections[1].y > se16.sections[0].y + se16.sections[0].height - 1, '16 队单败：季军赛独立分段');

// 16 队双败（未知 type）：总决赛在最右列、垂直居中；多轮 lower 1:1 对齐不溢出
const de16 = bl.layoutBracket({
  type: 'Bracket/16U8L4D',
  rounds: [
    { no: 1, side: 'upper', label: 'Upper Round 1', matches: Array.from({ length: 8 }, (_, i) => slot(1, i + 1, 'upper')) },
    { no: 2, side: 'upper', label: 'Upper Round 2', matches: Array.from({ length: 4 }, (_, i) => slot(2, i + 1, 'upper')) },
    { no: 3, side: 'upper', label: 'Upper Round 3', matches: [slot(3, 1, 'upper'), slot(3, 2, 'upper')] },
    { no: 4, side: 'upper', label: 'Upper Final', matches: [slot(4, 1, 'upper')] },
    { no: 1, side: 'lower', label: 'Lower Round 1', matches: [1, 2, 3, 4].map((i) => slot(1, i + 4, 'lower')) },
    { no: 2, side: 'lower', label: 'Lower Round 2', matches: [1, 2, 3, 4].map((i) => slot(2, i + 8, 'lower')) },
    { no: 3, side: 'lower', label: 'Lower Round 3', matches: [slot(3, 1, 'lower'), slot(3, 2, 'lower')] },
    { no: 4, side: 'lower', label: 'Lower Round 4', matches: [slot(4, 5, 'lower'), slot(4, 6, 'lower')] },
    { no: 5, side: 'lower', label: 'Lower Round 5', matches: [slot(5, 1, 'lower')] },
    { no: 6, side: 'lower', label: 'Lower Final', matches: [slot(6, 1, 'lower')] },
    { no: 7, side: 'final', label: 'Grand Final', matches: [slot(7, 1, 'final')] }
  ]
});
assert(de16.sections.map((s) => s.side).join(',') === 'upper,lower,final', '16 队双败：upper/lower/final 分区');
const d16uf = de16.sections[0].cards.filter((c) => c.key === 'R4M1')[0];
const d16lf = de16.sections[1].cards.filter((c) => c.key === 'R6M1')[0];
const d16gf = de16.sections[2].cards[0];
assert(!!d16gf && d16gf.x === d16lf.x + 344 && d16gf.y === (d16uf.y + d16lf.y) / 2,
  '16 队双败：总决赛在最右列、垂直居中于上/败者组决赛');
assert(de16.sections[2].lines.length === 5 && de16.crossLines.length === 0,
  '16 队双败（未知 type）：两条手肘线汇入、不臆测降级线');
assert(d16gf.x + 280 <= de16.width - 12 && d16gf.y + 104 <= de16.height, '16 队双败：总决赛不越界');

// final 标记缺失（末轮就叫 "Final"）：照常作为 main 最后一列，不单独内联
const noFinalTag = bl.layoutBracket({
  type: 'Bracket/8',
  rounds: [
    { no: 1, side: 'main', label: 'Quarterfinals', matches: [1, 2, 3, 4].map((i) => slot(1, i, 'main')) },
    { no: 2, side: 'main', label: 'Semifinals', matches: [slot(2, 1, 'main'), slot(2, 2, 'main')] },
    { no: 3, side: 'main', label: 'Final', matches: [slot(3, 1, 'main')] }
  ]
});
assert(noFinalTag.sections.length === 1 && noFinalTag.sections[0].cards.length === 7,
  '无 final 标记：全部并入 main 分区（7 张卡）');

// 多场总决赛（bracket reset 的第二场）必须顺序下排，不叠在同一坐标
const resetView = bl.layoutBracket({
  type: 'Bracket/8U4L2DSL1D',
  rounds: pglRounds().map((r) => (r.side === 'final'
    ? Object.assign({}, r, { matches: [slot(5, 1, 'final'), slot(5, 2, 'final')] })
    : r))
});
const resetCards = resetView.sections[2].cards;
assert(resetCards.length === 2 && resetCards[1].y === resetCards[0].y + 136,
  `多场总决赛：顺序下排（间距 ${bl.CARD_H + bl.CARD_GAP}，实际 ${resetCards[1] && (resetCards[1].y - resetCards[0].y)}）`);
assert(resetView.height >= resetCards[1].y + 104 + 16,
  `多场总决赛：画布高度容纳第二场（height=${resetView.height}）`);

// ===== 无数据 =====
assert(bl.layoutBracket(null).sections.length === 0, 'null 输入 → 空布局');

console.log(`\n=== 结果 ===\n通过: ${pass}  失败: ${fail}`);
process.exit(fail ? 1 : 0);
