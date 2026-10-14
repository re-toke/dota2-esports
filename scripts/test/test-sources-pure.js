// scripts/test/test-sources-pure.js
// ★★ 2026-10-14（P2-24）：`utils/sourcesPure.js`（从 sources.js 抽出的零依赖纯函数层）单测。
//   覆盖：① 日期解析（时区无关回归守卫）；② 年份 token 剥离；③ 跨源赛期合并（字段级回退 / 脏区间守卫）；
//        ④ 阶段归类；⑤ 已结算·未结算局数；⑥ 自由文本 BO 提取；⑦ LP live 归一（TBD ⇒ upcoming）。
//   纯离线：无 wx / 网络 / 其它 utils 依赖（正是抽出该模块的目的）。
//
// 运行：node scripts/test/test-sources-pure.js

'use strict';

const path = require('path');
const P = require(path.join(__dirname, '..', '..', 'utils', 'sourcesPure.js'));

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + '  ->  ' + (detail || '')); }
}

console.log('--- sourcesPure ---');

// ===== ① liquipediaDateToUnix =====
// 期望值一律以 Date.UTC 计算 ⇒ 断言「实现不依赖本地时区」（本机 +8，若误用 Date.parse 会偏移一天）。
const utc = (y, mo, d) => Math.floor(Date.UTC(y, mo - 1, d) / 1000);
assert('liquipediaDateToUnix：yyyy-MM-dd 解析为 UTC 当日 00:00',
  P.liquipediaDateToUnix('2025-08-15') === utc(2025, 8, 15),
  'got=' + P.liquipediaDateToUnix('2025-08-15') + ' exp=' + utc(2025, 8, 15));
assert('liquipediaDateToUnix：yyyy/M/d 同口径',
  P.liquipediaDateToUnix('2025/8/15') === utc(2025, 8, 15));
assert('liquipediaDateToUnix：缺日 → 默认 1 号（yyyy-MM）',
  P.liquipediaDateToUnix('2025-08') === utc(2025, 8, 1));
assert('liquipediaDateToUnix：英文日期 "August 15, 2025" 时区无关（= UTC 当日）',
  P.liquipediaDateToUnix('August 15, 2025') === utc(2025, 8, 15),
  'got=' + P.liquipediaDateToUnix('August 15, 2025'));
assert('liquipediaDateToUnix：英文日期小写/缩略 "aug 15 2025"',
  P.liquipediaDateToUnix('aug 15 2025') === utc(2025, 8, 15));
assert('liquipediaDateToUnix：英文日期 "July 4, 2026"（月份索引正确）',
  P.liquipediaDateToUnix('July 4, 2026') === utc(2026, 7, 4));
assert('liquipediaDateToUnix：日期后附时间 → 仍取日期部分（不引入本地时区）',
  P.liquipediaDateToUnix('2025-08-15 20:00') === utc(2025, 8, 15));
assert('liquipediaDateToUnix：无意义文本 → null',
  P.liquipediaDateToUnix('garbage') === null);
assert('liquipediaDateToUnix：空值（null/""/未传）→ null',
  P.liquipediaDateToUnix(null) === null && P.liquipediaDateToUnix('') === null && P.liquipediaDateToUnix() === null);

// ===== ② stripYearTokens =====
assert('stripYearTokens：中年份被剥离（PGL Wallachia 2026 Season 9）',
  P.stripYearTokens('PGL Wallachia 2026 Season 9') === 'PGL Wallachia Season 9',
  'got=' + P.stripYearTokens('PGL Wallachia 2026 Season 9'));
assert('stripYearTokens：尾部年份被剥离（The International 2026）',
  P.stripYearTokens('The International 2026') === 'The International');
assert('stripYearTokens：不含 4 位年份 → 原样（含届次数字）',
  P.stripYearTokens('DreamLeague Season 30') === 'DreamLeague Season 30');
assert('stripYearTokens：多个年份 token 全剥离并折叠空白',
  P.stripYearTokens('Cup 2024 2025') === 'Cup');
assert('stripYearTokens：20xx 前缀年份（1999/2099 边界）',
  P.stripYearTokens('Team 1999') === 'Team' && P.stripYearTokens('Team 2099') === 'Team');
assert('stripYearTokens：空值 → ""',
  P.stripYearTokens(null) === '' && P.stripYearTokens('') === '');

// ===== ③ mergeEventPeriod =====
assert('mergeEventPeriod：空数组 → null',
  P.mergeEventPeriod([]) === null && P.mergeEventPeriod(null) === null);
const m1 = P.mergeEventPeriod([{ name: 'cu', start: 100, end: 200 }]);
assert('mergeEventPeriod：单源完整 → 起止全取 + 来源标注',
  m1 && m1.start === 100 && m1.end === 200 && m1.startFrom === 'cu' && m1.endFrom === 'cu');
const m2 = P.mergeEventPeriod([{ name: 'cu', start: 100 }, { name: 'od', start: 300, end: 400 }]);
assert('mergeEventPeriod：★字段级回退（源只有 start 时不整条丢弃，end 向下回退）',
  m2 && m2.start === 100 && m2.startFrom === 'cu' && m2.end === 400 && m2.endFrom === 'od',
  JSON.stringify(m2));
const m3 = P.mergeEventPeriod([{ name: 'lp', start: 500, end: 100 }]);
assert('mergeEventPeriod：★脏区间守卫（end < start ⇒ 丢弃 end）',
  m3 && m3.start === 500 && m3.end === 0 && m3.endFrom === '', JSON.stringify(m3));
const m4 = P.mergeEventPeriod([{ start: 10, end: 20 }]);
assert('mergeEventPeriod：源未给 name → 兜底 src0',
  m4 && m4.startFrom === 'src0' && m4.endFrom === 'src0');
const m5 = P.mergeEventPeriod([{ name: 'a', start: 0, end: -5 }, { name: 'b', start: 7 }]);
assert('mergeEventPeriod：非正数/非数值视作缺失（0 不算有效）',
  m5 && m5.start === 7 && m5.startFrom === 'b' && m5.end === 0, JSON.stringify(m5));

// ===== ④ classifyStage =====
assert('classifyStage：Grand Final / 决赛 → grandFinal',
  P.classifyStage('Grand Final') === 'grandFinal' && P.classifyStage('总决赛决赛') === 'grandFinal');
assert('classifyStage：Group Stage / 小组 → group',
  P.classifyStage('Group Stage') === 'group' && P.classifyStage('小组赛') === 'group');
assert('classifyStage：Playoffs / 淘汰 → playoff',
  P.classifyStage('Playoffs') === 'playoff' && P.classifyStage('淘汰赛') === 'playoff');
assert('classifyStage：未识别 / 空 → ""',
  P.classifyStage('Swiss?') === '' && P.classifyStage('') === '' && P.classifyStage(null) === '');
assert('classifyStage：大小写不敏感（PLAYOFF）',
  P.classifyStage('PLAYOFF') === 'playoff');

// ===== ⑤ settledCountOf / pendingCountOf =====
assert('settledCountOf：games 中已结算（radiant_win 非空）计数',
  P.settledCountOf({ games: [{ radiant_win: true }, { radiant_win: false }, { radiant_win: null }] }) === 2);
assert('settledCountOf：兼容驼峰 radiantWin，且 false/0 也算已结算（非空即可）',
  P.settledCountOf({ games: [{ radiantWin: 1 }, { radiant_win: 0 }] }) === 2);
assert('settledCountOf：无 games 且 phase=recent → 用比分和估算',
  P.settledCountOf({ phase: 'recent', scoreA: 2, scoreB: 1, games: [] }) === 3);
assert('settledCountOf：无数据 → 0',
  P.settledCountOf({}) === 0 && P.settledCountOf(null) === 0);
assert('pendingCountOf：games 中未结算（两字段皆空）计数',
  P.pendingCountOf({ games: [{ radiant_win: null }, { radiantWin: null }, { radiant_win: true }] }) === 2);
assert('pendingCountOf：无 games → 0',
  P.pendingCountOf({}) === 0 && P.pendingCountOf(null) === 0);

// ===== ⑥ boFromFreeText =====
assert('boFromFreeText：括注 (Bo2) → BO2', P.boFromFreeText('Round robin (Bo2)') === 'BO2');
assert('boFromFreeText：Abbr/Bo3 前缀 → BO3', P.boFromFreeText('Abbr/Bo3') === 'BO3');
assert('boFromFreeText：best of 5 → BO5', P.boFromFreeText('best of 5') === 'BO5');
assert('boFromFreeText：允许空格 Bo 1 → BO1', P.boFromFreeText('Bo 1') === 'BO1');
assert('boFromFreeText：无关键词 / 空 → null',
  P.boFromFreeText('no info') === null && P.boFromFreeText('') === null && P.boFromFreeText(null) === null);

// ===== ⑦ normalizeLpLivePhase =====
assert('normalizeLpLivePhase：★TBD 对手 + live ⇒ upcoming',
  P.normalizeLpLivePhase('live', 'Team Yandex', 'TBD') === 'upcoming');
assert('normalizeLpLivePhase：★真队名 + live ⇒ 保持 live（防误伤）',
  P.normalizeLpLivePhase('live', 'LGD Gaming', 'Natus Vincere') === 'live');
assert('normalizeLpLivePhase：TBD 变体全覆盖（含中文/空/多词）',
  ['TBD', 'tbd', 'Tba', '待定', '待公布', 'unknown', '', '   ', 'To Be Determined']
    .every((n) => P.normalizeLpLivePhase('live', 'Team Yandex', n) === 'upcoming' &&
      P.normalizeLpLivePhase('live', n, 'Team Yandex') === 'upcoming'));
assert('normalizeLpLivePhase：仅对 live 生效，其它 phase 原样',
  P.normalizeLpLivePhase('upcoming', 'A', 'TBD') === 'upcoming' &&
  P.normalizeLpLivePhase('recent', 'A', 'TBD') === 'recent' &&
  P.normalizeLpLivePhase(undefined, 'A', 'TBD') === undefined);
assert('normalizeLpLivePhase：null 队名视为未定',
  P.normalizeLpLivePhase('live', null, null) === 'upcoming');

console.log('\n=== 结果 ===');
console.log('PASS: ' + pass + ', FAIL: ' + fail);
process.exit(fail ? 1 : 0);
