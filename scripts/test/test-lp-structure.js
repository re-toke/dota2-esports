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

// ===== parseBrackets：EWC Survival 淘汰赛 =====
const brackets = LP.parseBrackets(ewc);
assert(brackets.length === 1, `EWC 解析出 1 个有内容的 Bracket（实际 ${brackets.length}）`);
if (brackets.length === 1) {
  const b = brackets[0];
  assert(b.section === 'Survival', `H2 section 解析（实际 ${b.section}）`);
  assert(b.type === 'Bracket/8L4D-4Q', `Bracket 类型（实际 ${b.type}）`);
  const allMatches = b.rounds.reduce((acc, r) => acc.concat(r.matches), []);
  assert(allMatches.length === 1, `仅 1 场已填充对局（其余空壳 {{Match}} 跳过；实际 ${allMatches.length}）`);
  if (allMatches.length === 1) {
    const m = allMatches[0];
    assert(m.team1Name === 'Vici Gaming' && m.team2Name === 'PTime',
      `对局双方 Vici Gaming vs PTime（实际 ${m.team1Name} vs ${m.team2Name}）`);
    assert(m.finished === true, 'score=W/FF 字母比分 → finished=true');
    assert(m.startTime > 0, '对局有时间戳');
  }
  assert(b.rounds[0].label === 'Round 1', `轮次标签取 HTML 注释（实际 ${b.rounds[0].label}）`);
}

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
