'use strict';
/** utils/lp-scope.js 单测：node scripts/test/test-lp-scope.js */
const LP = require('../../utils/lp-scope.js');

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed += 1; } else { failed += 1; console.error('  ✗ ' + msg); }
}
function eq(actual, expected, msg) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), msg + '\n    got:      ' + JSON.stringify(actual) + '\n    expected: ' + JSON.stringify(expected));
}

const NOW = 1792281600; // 2026-10-17 附近，纯测试用
const BAKED = {
  slugs: ['The International/2025', 'BLAST/SLAM/8/Southeast Asia', 'EPL/Masters/3', 'The_International/2025'],
  hot: [{ n: 'EPL Masters 3', s: NOW - 3 * 86400, e: NOW + 3 * 86400, slugs: ['EPL/Masters/3'] }],
  brackets: [{ n: 'EPL Masters 3', id: 4242, slugs: ['EPL/Masters/3/Main Event'] }]
};

// ---- normSlug ----
eq(LP.normSlug('The International/2026'), 'The_International/2026', '空格转下划线');
eq(LP.normSlug('  The_International/2026  '), 'The_International/2026', '首尾空白裁掉');
eq(LP.normSlug('A   B'), 'A_B', '连续空白折叠');
eq(LP.normSlug('A_ B'), 'A_B', '混合空白+下划线折叠');
eq(LP.normSlug('a|b'), '', '拒绝 | 分隔符');
eq(LP.normSlug('a\nb'), '', '拒绝控制字符');
eq(LP.normSlug(123), '', '拒绝非字符串');
eq(LP.normSlug('x'.repeat(LP.MAX_SLUG_LEN + 1)), '', '拒绝超长');

// ---- deriveScope：Baked 基线 ----
{
  const s = LP.deriveScope({ baked: BAKED, events: [], nowSec: NOW });
  eq(s.fullPages, ['The_International/2025', 'BLAST/SLAM/8/Southeast_Asia', 'EPL/Masters/3'], 'fullPages 归一+去重（4→3）');
  eq(s.rcSlugs.length, 3, 'rcSlugs 与 fullPages 同口径去重');
  eq(s.hot.length, 1, 'hot 沿用烘焙');
  eq(s.brackets.length, 1, 'brackets 沿用烘焙');
  eq(s.brackets[0].slugs, ['EPL/Masters/3/Main_Event'], '候选 slug 归一');
}

// ---- deriveScope：远端新增赛事（不应进 fullPages）----
{
  const events = [
    { canonical: 'ESL One Raleigh 2026', liquipediaSlug: 'ESL One/Raleigh/2026', start: NOW + 86400, end: NOW + 5 * 86400, leagueId: 5555 }
  ];
  const s = LP.deriveScope({ baked: BAKED, events, nowSec: NOW });
  ok(s.rcSlugs.includes('ESL_One/Raleigh/2026'), '远端新 slug 进入 rcSlugs');
  ok(!s.fullPages.includes('ESL_One/Raleigh/2026'), '远端新 slug 不能进 fullPages');
  eq(s.hot.length, 2, '窗口内赛事进入 hot');
  eq(s.brackets.length, 2, '窗口内赛事进入 brackets');
  eq(s.brackets[1].slugs[0], 'ESL_One/Raleigh/2026/Main_Event', '远端 bracket 候选顺序优先 /Main Event');
  eq(s.brackets[1].id, 5555, '远端 bracket 携带 leagueId');
}

// ---- deriveScope：窗口外 / 缺日期 / 已存在则不加 ----
{
  const events = [
    { canonical: 'Old Event', liquipediaSlug: 'Old_Event/2019', start: NOW - 400 * 86400, end: NOW - 380 * 86400 },
    { canonical: 'No Date', liquipediaSlug: 'No_Date' },
    { canonical: 'ESL One Raleigh 2026', liquipediaSlug: 'ESL One/Raleigh/2026', start: NOW + 86400, end: NOW + 5 * 86400 },
    { canonical: 'EPL Masters 3', liquipediaSlug: 'EPL/Masters/3', start: NOW - 2 * 86400, end: NOW + 2 * 86400, bracketSlug: 'EPL/Masters/3/Main Event' }
  ];
  const s = LP.deriveScope({ baked: BAKED, events, nowSec: NOW });
  eq(s.hot.length, 2, '窗口外/缺日期不加 hot，且不与烘焙重复');
  eq(s.brackets.length, 2, '赛事去重（canonical 归一后相同视为同一赛事）');
  ok(s.rcSlugs.includes('Old_Event/2019'), '历史赛事 slug 仍进入 rcSlugs（只做差集过滤，零额外请求）');
}

// ---- 上限：烘焙优先，远端不被截断 ----
{
  const bakedBig = {
    slugs: ['A/1', 'A/2', 'A/3'],
    hot: [{ n: 'h1', s: 1, e: 2, slugs: ['A/1'] }, { n: 'h2', s: 1, e: 2, slugs: ['A/2'] }],
    brackets: [{ n: 'b1', id: 1, slugs: ['A/1'] }, { n: 'b2', id: 2, slugs: ['A/2'] }]
  };
  const events = Array.from({ length: 10 }, (_, i) => ({
    canonical: 'E' + i, liquipediaSlug: 'E' + i, start: NOW, end: NOW + 86400
  }));
  const s = LP.deriveScope({ baked: bakedBig, events, nowSec: NOW, limits: { maxHotEvents: 3, maxBracketEvents: 3 } });
  eq(s.hot.length, 3, 'hot 总量受上限约束');
  eq(s.hot[0].n, 'h1', 'hot 烘焙优先');
  eq(s.brackets.length, 3, 'brackets 总量受上限约束');
  eq(s.brackets[0].n, 'b1', 'brackets 烘焙优先');
}

// ---- deriveScope：待补抓队列只收近期事件 ----
{
  const events = [
    { canonical: 'Upcoming', liquipediaSlug: 'Upcoming/2026', start: NOW + 30 * 86400, end: NOW + 32 * 86400 },
    { canonical: 'Old', liquipediaSlug: 'Old/2019', start: NOW - 400 * 86400, end: NOW - 380 * 86400 },
    { canonical: 'No Date', liquipediaSlug: 'No_Date' }
  ];
  const s = LP.deriveScope({ baked: { slugs: [] }, events, nowSec: NOW });
  eq(s.urgentSlugs, ['Upcoming/2026'], 'urgent 只收近期事件（排除历史/缺日期）');
}

// ---- 截断时活跃赛事必须保留（curation_events 无 updated_at，不能靠行序）----
{
  const events = [
    { canonical: 'Old1', liquipediaSlug: 'Old1/2015', start: NOW - 900 * 86400, end: NOW - 880 * 86400 },
    { canonical: 'Active', liquipediaSlug: 'Active/2026', start: NOW, end: NOW + 86400 },
    { canonical: 'Old2', liquipediaSlug: 'Old2/2016', start: NOW - 800 * 86400, end: NOW - 780 * 86400 }
  ];
  const s = LP.deriveScope({ baked: { slugs: [] }, events, nowSec: NOW, limits: { maxSlugs: 1 } });
  eq(s.rcSlugs, ['Active/2026'], '截断优先保留在赛事件');
  eq(s.dropped >= 1, true, '被截断数量计入 dropped');
}

// ---- 脏数据 / 超上限 ----
{
  const events = [
    { canonical: 'Bad', liquipediaSlug: 'Bad|Title' },
    { canonical: 'Good', liquipediaSlug: 'Good/2026' },
    { canonical: 'Good2', liquipediaSlug: 'Good2/2026' }
  ];
  const s = LP.deriveScope({ baked: { slugs: [] }, events, nowSec: NOW, limits: { maxSlugs: 1 } });
  eq(s.rcSlugs, ['Good/2026'], '脏 slug 丢弃 + maxSlugs 截断');
  eq(s.dropped, 1, 'dropped 计数（超上限 1 条）');
}

console.log('\nlp-scope: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
