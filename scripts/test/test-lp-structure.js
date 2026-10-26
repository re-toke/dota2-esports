#!/usr/bin/env node
// P3（2026-08-31）：parseGroupStandings / parseBrackets 单元测试
// fixtures：ewc2026-wikitext.txt（EWC2026 主页，4×GroupTableLeague + Bracket）、
//           ti2026-swiss-wikitext.txt（TI2026 SwissStandings，16 队）
// 同时校验 G14 双源镜像：云函数侧解析器对同一 fixture 输出一致。
const path = require('path');
const fs = require('fs');
const LP = require('../../utils/liquipedia-parse.js');
// ★★ 2026-09-22（微信云开发退役）：原云侧镜像 cloudfunctions/aggregation/liquipedia-parse.js 已随目录删除。
//   此处指向同一实现（utils 侧）——本文件真正有价值的是下方 fixture（EWC/TI）解析断言，
//   而「双源一致」这类镜像对照已无对象，相应断言随之成为等价断言（不再证明双源）。
const LPCloud = LP;

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('PASS ', msg); }
  else { fail++; console.log('FAIL ', msg); }
}

const ewc = fs.readFileSync(path.join(__dirname, 'ewc2026-wikitext.txt'), 'utf8');
const ti = fs.readFileSync(path.join(__dirname, 'ti2026-swiss-wikitext.txt'), 'utf8');

// ===== parseGroupStandings：EWC 4 组 =====
const groups = LP.parseGroupStandings(ewc);
assert(groups.length === 4, `EWC 解析出 4 个小组（实际 ${groups.length}）`);
assert(groups.map(g => g.name).join(',') === 'Group A,Group B,Group C,Group D',
  `组名来自三级标题（实际: ${groups.map(g => g.name).join('/')}）`);
const ga = groups[0];
assert(ga.teams.length === 6, `Group A 6 支队（实际 ${ga.teams.length}）`);
assert(ga.teams[0].rank === 1 && ga.teams[0].name === 'Xtreme Gaming' && ga.teams[0].placement === '晋级',
  'Group A 第 1 名 Xtreme Gaming[晋级]');
assert(ga.teams[3].name === 'GamerLegion' && ga.teams[3].placement === '',
  'Group A 第 4 名 GamerLegion 无徽标（pbg4=stay → Survival 阶段非淘汰）');
assert(ga.teams[2].placement === '', 'pbg=stay 槽位映射为空 placement');
assert(ga.teams[4].placement === '淘汰', 'Group A 第 5 名 Rune Eaters[淘汰]（pbg 阶梯）');
// 每组 rank 连续
assert(groups.every(g => g.teams.every((t, i) => t.rank === i + 1)), '各组 rank 连续递增');

// ===== parseGroupStandings：TI 瑞士轮 =====
const swiss = LP.parseGroupStandings(ti);
assert(swiss.length === 1, `TI Swiss 解析出 1 组（实际 ${swiss.length}）`);
if (swiss.length === 1) {
  const g = swiss[0];
  assert(g.teams.length === 16, `瑞士轮 16 队（实际 ${g.teams.length}）`);
  assert(g.teams[0].name === 'TEAM VISION', `第 1 名 TEAM VISION（实际 ${g.teams[0].name}）`);
  assert(g.teams[0].name.indexOf('tiebreaker') < 0, '队名不含 tiebreaker 参数残留');
  assert(g.teams[15].name === 'HULIGANI', `第 16 名 HULIGANI（实际 ${g.teams[15].name}）`);
}

// ===== parseBrackets（P3.0）：结构骨架 + 侧区 =====
const brackets = LP.parseBrackets(ewc);
assert(brackets.length === 2, `EWC 解析出 2 个 Bracket（Survival + Playoffs；实际 ${brackets.length}）`);
const survival = brackets.find((b) => b.section === 'Survival');
const playoffs = brackets.find((b) => b.section === 'Playoffs');
assert(!!survival && survival.type === 'Bracket/8L4D-4Q', `Survival 类型（实际 ${survival && survival.type}）`);
assert(!!playoffs && playoffs.type === 'Bracket/8', `Playoffs 类型（实际 ${playoffs && playoffs.type}）`);

if (survival) {
  assert(survival.total === 8, `Survival 槽位 8（实际 ${survival.total}）`);
  assert(survival.filled === 1, `Survival 已填充 1 场（实际 ${survival.filled}）`);
  const filled = survival.slots.filter((s) => !s.empty);
  assert(filled.length === 1 && filled[0].team1Name === 'Vici Gaming' && filled[0].team2Name === 'PTime',
    `填充对局 Vici Gaming vs PTime（实际 ${filled[0] && filled[0].team1Name} vs ${filled[0] && filled[0].team2Name}）`);
  assert(filled[0].finished === true && filled[0].startTime > 0, '填充对局 finished / startTime');
  assert(survival.rounds.length === 2, `Survival 两轮（实际 ${survival.rounds.length}）`);
  assert(survival.rounds[0].label === 'Round 1', `轮次标签取 HTML 注释（实际 ${survival.rounds[0].label}）`);
  assert(survival.rounds[0].matches.length === 4, 'Round 1 四个槽位（空槽保留）');
}

if (playoffs) {
  assert(playoffs.total === 8, `Playoffs 槽位 8（实际 ${playoffs.total}）`);
  assert(playoffs.filled === 0, `Playoffs 全部空槽（实际填充 ${playoffs.filled}）`);
  const labels = playoffs.rounds.map((r) => r.label);
  assert(labels.indexOf('Quarterfinals') >= 0 && labels.indexOf('Grand Final') >= 0,
    `Playoffs 轮名（实际 ${labels.join('/')}）`);
  const third = playoffs.rounds.find((r) => r.side === 'third');
  assert(!!third && third.no === 99, '季军赛独立成轮（no=99, side=third）');
}

// ===== parseBrackets（P3.0）：PGL Wallachia S9 双败 =====
const pgl = LP.parseBrackets(fs.readFileSync(path.join(__dirname, 'pgl-wallachia9-wikitext.txt'), 'utf8'));
assert(pgl.length === 1, `PGL S9 解析出 1 个 Bracket（实际 ${pgl.length}）`);
if (pgl.length === 1) {
  const b = pgl[0];
  assert(b.type === 'Bracket/8U4L2DSL1D', `PGL 类型（实际 ${b.type}）`);
  assert(b.total === 14 && b.filled === 0, `PGL 14 槽全空（实际 ${b.total}/${b.filled}）`);
  assert(b.rounds.some((r) => r.side === 'upper') && b.rounds.some((r) => r.side === 'lower') &&
    b.rounds.some((r) => r.side === 'final'), 'PGL 同时存在 upper / lower / final 侧区');
  assert(b.slots.some((s) => s.side === 'lower' && s.roundNo === 1 && s.slotNo === 5),
    'Lower R1 从 M5 起（与 Upper 共用 R# 不合并）');
  assert(b.slots.some((s) => s.side === 'upper' && s.roundNo === 4 && s.slotNo === 1),
    'Upper Final = R4M1');
  assert(b.slots.some((s) => s.side === 'lower' && s.roundNo === 4 && s.slotNo === 2),
    'Lower Final = R4M2');
  assert(b.slots.some((s) => s.side === 'final' && s.roundNo === 5 && s.slotNo === 1),
    'Grand Final = R5M1');
}

// ===== parseBrackets（P3.0）：TI 2026 Main Event 部分填充 =====
const tiMain = LP.parseBrackets(fs.readFileSync(path.join(__dirname, 'ti2026-main-event-wikitext.txt'), 'utf8'));
assert(tiMain.length === 1, `TI 2026 Main Event 解析出 1 个 Bracket（实际 ${tiMain.length}）`);
if (tiMain.length === 1) {
  const b = tiMain[0];
  assert(b.id === 'TI2026Main', `TI bracket id（实际 ${b.id}）`);
  assert(b.total === 14 && b.filled === 1, `TI 14 槽 / 填充 1（实际 ${b.total}/${b.filled}）`);
  const f = b.slots.find((s) => !s.empty);
  assert(f && f.team1Name === 'BoomBoys' && f.team2Name === 'Team Spirit',
    `TI 填充对局 BoomBoys vs Team Spirit（实际 ${f && f.team1Name} vs ${f && f.team2Name}）`);
  assert(f.side === 'lower' && f.roundNo === 3 && f.slotNo === 1, '填充槽位 = Lower Semifinal R3M1');
}

// ===== P0（2026-10-25）：奖金币种映射（€/£/¥ 不再回落 USD）=====
assert(LP.parsePrizePool('€500,000').currency === 'EUR', '€ 应映射 EUR（实际 ' + LP.parsePrizePool('€500,000').currency + '）');
assert(LP.parsePrizePool('£250,000').currency === 'GBP', '£ 应映射 GBP（实际 ' + LP.parsePrizePool('£250,000').currency + '）');
assert(LP.parsePrizePool('¥1,000,000').currency === 'CNY', '¥ 应映射 CNY（实际 ' + LP.parsePrizePool('¥1,000,000').currency + '）');
assert(LP.parsePrizePool('$1,000,000 USD').currency === 'USD', '$ 应映射 USD');
assert(LP.parsePrizePool('500000 EUR').currency === 'EUR', '纯数字 + 货币码应保留 EUR');
assert(LP.parsePrizePool('5000000').currency === 'USD', '纯数字无币种线索 → USD 兜底');

// ===== 边界：空输入 / 无结构页面 =====
assert(LP.parseGroupStandings('').length === 0, '空输入 → 空组');
assert(LP.parseBrackets(null).length === 0, 'null 输入 → 空 bracket');
assert(LP.parseGroupStandings('==Results==\n{{Match|date=January 1, 2026 00:00 {{Abbr/CST}}}}').length === 0,
  '无积分表页面 → 空组（不误报）');

// ===== G14 双源镜像：云函数侧输出一致 =====
const groupsCloud = LPCloud.parseGroupStandings(ewc);
const bracketsCloud = LPCloud.parseBrackets(ewc);
assert(JSON.stringify(groupsCloud) === JSON.stringify(groups), 'G14: 云函数侧 parseGroupStandings 输出一致');
assert(JSON.stringify(bracketsCloud) === JSON.stringify(brackets), 'G14: 云函数侧 parseBrackets 输出一致');

console.log(`\n=== 结果 ===\n通过: ${pass}  失败: ${fail}`);
process.exit(fail ? 1 : 0);
