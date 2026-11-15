#!/usr/bin/env node
/**
 * 赛事收录口径收紧（2026-11-15）单元测试
 *
 * 背景：794 个 OpenDota league 中 243 个（30.6%）名字含 qualifier / play-in / seeding，
 *      原先只由 utils/tiers.js 降级为 B 级，仍会挤在「赛事」页主列表（全部/进行中/已结束）
 *      把正赛淹没。本次改为**默认不进主列表**，用户显式开启 `含预选赛` 才显示。
 *
 * 覆盖：
 *   T1 默认（showQualifiers=false）→ 预选赛过滤、正赛保留
 *   T2 showQualifiers=true → 全部保留
 *   T3 缺 name / qualifier 字段时不抛错（阶段 1 normalizeLite 尚未产出 qualifier 的场景）
 *   T4 同名多 id 兜底：dedupeByDisplayName 择优规则不变 + 落选 id 记入 aliasLeagueIds
 *
 * 运行：node scripts/test/test-league-qualifier-filter.js
 * 说明：直接 require 页面文件复用**线上同一份** shouldShowLeague（不抄规则，否则保护不到实现）。
 *       node 环境无小程序注入的 Page 全局 ⇒ 用空实现占位（页面注册结果被丢弃，不影响纯函数）。
 */
'use strict';

// ===== 1. mock wx（部分 utils 模块加载期会读 storage/配置）=====
const storage = {};
global.wx = {
  getStorageSync: function (key) { return storage[key] || null; },
  setStorageSync: function (key, val) { storage[key] = val; },
  removeStorageSync: function (key) { delete storage[key]; },
  getStorageInfoSync: function () { return { keys: Object.keys(storage) }; },
  request: function (opts) {
    if (opts && opts.fail) opts.fail({ errMsg: 'request:fail (mock network down)' });
  }
};
// ===== 2. mock Page（页面文件末尾为 Page({...}) 注册，此处丢弃其配置）=====
global.Page = function () {};

const path = require('path');
const leagues = require(path.resolve(__dirname, '..', '..', 'pages', 'leagues', 'leagues.js'));

const shouldShowLeague = leagues.shouldShowLeague;
const dedupeByDisplayName = leagues.dedupeByDisplayName;

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + '  ->  ' + (detail || '')); }
}

// ===== T0：导出层可用（纯函数已挂到 module.exports）=====
assert('T0: shouldShowLeague 已导出为函数', typeof shouldShowLeague === 'function', '实际: ' + typeof shouldShowLeague);
assert('T0: dedupeByDisplayName 已导出为函数', typeof dedupeByDisplayName === 'function', '实际: ' + typeof dedupeByDisplayName);
if (typeof shouldShowLeague !== 'function') {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(1);
}

// ===== T1：默认（showQualifiers=false）→ 预选赛被过滤、正赛保留 =====
(function () {
  // 真实形状：normalize() 产出的 item（qualifier 由 tiers.applyQualifierCap / curation tier.qualifier 标注）
  const qualifier = { leagueid: 20333, name: 'BLAST SLAM IX China Qualifier', displayName: 'BLAST SLAM IX China Qualifier', qualifier: true };
  const playIn = { leagueid: 20334, name: 'RES Unbounded Play-In', displayName: 'RES Unbounded Play-In', qualifier: true };
  const main = { leagueid: 20200, name: 'BLAST SLAM IX', displayName: 'BLAST SLAM IX', qualifier: false };
  assert('T1: qualifier 赛事默认被过滤', shouldShowLeague(qualifier, false) === false);
  assert('T1: play-in 赛事默认被过滤', shouldShowLeague(playIn, false) === false);
  assert('T1: 正赛（qualifier=false）默认保留', shouldShowLeague(main, false) === true);
  // 缺 qualifier 字段（阶段 1 normalizeLite 数据）→ 回退按赛事名判定
  const liteQualifier = { leagueid: 20335, name: 'ESL One Bangkok 2026 Open Qualifier' };
  const liteMain = { leagueid: 20201, name: 'ESL One Bangkok 2026' };
  assert('T1: 无 qualifier 字段时按名判预选赛 → 过滤', shouldShowLeague(liteQualifier, false) === false);
  assert('T1: 无 qualifier 字段的正赛 → 保留', shouldShowLeague(liteMain, false) === true);
  // 显式 false 与 curation 标注并存时，以字段为准（不被名字误杀的正赛变体）
  const edge = { leagueid: 20336, name: 'DreamLeague Season 30 Seeding Decider', qualifier: false };
  assert('T1: qualifier=false 时以字段为准（名称含 Seeding 也保留）', shouldShowLeague(edge, false) === true);
})();

// ===== T2：showQualifiers=true → 全部保留 =====
(function () {
  const items = [
    { leagueid: 20333, name: 'BLAST SLAM IX China Qualifier', qualifier: true },
    { leagueid: 20334, name: 'RES Unbounded Play-In', qualifier: true },
    { leagueid: 20335, name: 'ESL One Bangkok 2026 Open Qualifier' },
    { leagueid: 20200, name: 'BLAST SLAM IX', qualifier: false },
    { leagueid: 20201, name: 'ESL One Bangkok 2026' }
  ];
  const kept = items.filter((x) => shouldShowLeague(x, true));
  assert('T2: 开启后 5 条全部保留', kept.length === items.length, '实际保留 ' + kept.length + '/' + items.length);
})();

// ===== T3：缺字段 / 异常输入不抛错 =====
(function () {
  let threw = null;
  try {
    shouldShowLeague({}, false);
    shouldShowLeague({}, true);
    shouldShowLeague({ leagueid: 1 }, false);
    shouldShowLeague({ name: undefined, displayName: undefined, qualifier: null }, false);
    shouldShowLeague(null, false);
    shouldShowLeague(undefined, true);
  } catch (e) { threw = e; }
  assert('T3: 缺 name/qualifier/null 输入不抛错', threw === null, threw && threw.message);
  assert('T3: 空对象默认保留（不误杀）', shouldShowLeague({}, false) === true);
  assert('T3: null 输入返回 false（不抛错）', shouldShowLeague(null, false) === false);
})();

// ===== T4：同名多 id 兜底（dedupeByDisplayName）=====
// 真实事故：1win Essence III 同时存在 leagueid 20177（0 场）与 20486（85 场）
(function () {
  const mk = function (leagueid, matchCount) {
    return {
      leagueid: leagueid,
      name: '1win Essence III',
      displayName: '1win Essence III',
      matchCount: matchCount,
      startDate: Math.floor(Date.UTC(2026, 10, 12) / 1000),   // 同年同届 → 同一去重分组
      grade: 'S'
    };
  };
  const out = dedupeByDisplayName([mk(20177, 0), mk(20486, 85)]);
  assert('T4: 同名同届只保留 1 条', out.length === 1, '实际 ' + out.length);
  assert('T4: 保留 matchCount 高者（20486）', out[0] && out[0].leagueid === 20486,
    '实际保留 ' + (out[0] && out[0].leagueid));
  assert('T4: 落选 id 记入 aliasLeagueIds', !!(out[0] && out[0].aliasLeagueIds &&
    out[0].aliasLeagueIds.indexOf(20177) >= 0), '实际: ' + JSON.stringify(out[0] && out[0].aliasLeagueIds));

  // 顺序无关：落选者在前时同样以 matchCount 择优，别名照样记录
  const out2 = dedupeByDisplayName([mk(20486, 85), mk(20177, 0)]);
  assert('T4: 顺序无关，仍保留 20486', out2.length === 1 && out2[0].leagueid === 20486,
    '实际 ' + JSON.stringify(out2.map((x) => x.leagueid)));
  assert('T4: 顺序无关，别名仍记录 20177', out2[0].aliasLeagueIds && out2[0].aliasLeagueIds.indexOf(20177) >= 0,
    '实际: ' + JSON.stringify(out2[0].aliasLeagueIds));
  assert('T4: 别名不含自身 leagueid', out2[0].aliasLeagueIds.indexOf(20486) < 0,
    '实际: ' + JSON.stringify(out2[0].aliasLeagueIds));

  // 无冲突时不应凭空产生 aliasLeagueIds（避免给所有条目加字段）
  const single = dedupeByDisplayName([mk(20486, 85)]);
  assert('T4: 单条无冲突 → 不产生 aliasLeagueIds', single.length === 1 && single[0].aliasLeagueIds === undefined,
    '实际: ' + JSON.stringify(single[0] && single[0].aliasLeagueIds));
})();

// ===== T5：跨源同一性 —— Liquipedia slug 优先于赛事名（同一赛事不得出现两张卡）=====
// 真实事故（2026-11-15 真机）：「1win Essence III」同时出现在「进行中」和「即将到来」，
//   因为 Haglund 用 LP 简称 "1w Essence III - Playoffs"（curation 名 "1win Essence III"），
//   名称归一后仍不同键 → 两条卡。LP 页面 slug 才是唯一身份，须优先按 slug 归并。
(function () {
  const curation = require(path.resolve(__dirname, '..', '..', 'utils', 'curation.js'));
  const bySlug = curation.curatedEventFor('1w Essence III - Playoffs', { game: 'dota2', slug: '1win_Essence/3' });
  assert('T5: Haglund 简称 + LP slug → 命中 curation', !!bySlug && bySlug.canonical === '1win Essence III',
    '实际: ' + JSON.stringify(bySlug && bySlug.canonical));
  assert('T5: 命中后带真实 leagueId（详情页跳转不靠负哈希 fakeId）', !!bySlug && bySlug.leagueId === 20486,
    '实际: ' + (bySlug && bySlug.leagueId));
  assert('T5: curation 条目带权威赛期窗口（用于状态判定）', !!bySlug && bySlug.start > 0 && bySlug.end > bySlug.start,
    '实际: ' + JSON.stringify(bySlug && { start: bySlug.start, end: bySlug.end }));

  // slug 允许直接传 URL（带 #锚点 / ?query），应与裸 slug 等价
  const byUrl = curation.curatedEventFor('Whatever Name', {
    game: 'dota2', slug: 'https://liquipedia.net/dota2/1win_Essence/3#Playoffs' });
  assert('T5: URL 形式 slug（含 #锚点）同样命中', !!byUrl && byUrl.canonical === '1win Essence III',
    '实际: ' + JSON.stringify(byUrl && byUrl.canonical));

  // 双保险：leagueUrl 缺失时，靠别名仍能命中（不再分叉）
  const byAlias = curation.curatedEventFor('1w Essence III', { game: 'dota2' });
  assert('T5: slug 缺失时别名兜底命中', !!byAlias && byAlias.canonical === '1win Essence III',
    '实际: ' + JSON.stringify(byAlias && byAlias.canonical));

  // 不误伤相邻届：Essence II 的 slug 必须落到 II
  const prev = curation.curatedEventFor('1w Essence II', { game: 'dota2', slug: '1win_Essence/2' });
  assert('T5: 相邻届不串味（/2 → Essence II）', !!prev && /Essence II$/.test(prev.canonical),
    '实际: ' + JSON.stringify(prev && prev.canonical));
})();

// ===== T6：同 leagueId = 同赛事（跨 Tab 去重的最后一道防线）=====
(function () {
  const mergeAllWithUpcoming = leagues.mergeAllWithUpcoming;
  assert('T6: mergeAllWithUpcoming 已导出', typeof mergeAllWithUpcoming === 'function',
    '实际: ' + typeof mergeAllWithUpcoming);
  if (typeof mergeAllWithUpcoming !== 'function') return;

  const t = Math.floor(Date.UTC(2026, 10, 12) / 1000);
  // 「进行中」Tab 的 OpenDota 卡（有真实 leagueid）
  const ongoing = { leagueid: 20486, name: '1win Essence III', displayName: '1win Essence III',
    startDate: t, endDate: t + 6 * 86400, status: 'ongoing', matchCount: 85, grade: 'S' };
  // 「即将到来」Tab 的 Haglund 卡（slug 归并后已拿到同一 leagueid）
  const fromHaglund = { leagueid: 20486, name: '1win Essence III', displayName: '1win Essence III',
    startDate: t + 3 * 86400, endDate: t + 7 * 86400, status: 'upcoming', matchCount: 4, grade: 'S' };
  const out = mergeAllWithUpcoming([ongoing], [fromHaglund]);
  assert('T6: 同 leagueId 只保留 1 张卡', out.length === 1, '实际 ' + out.length);
  assert('T6: 保留进行中（已有真实赛期的那条）', out[0] && out[0].status === 'ongoing',
    '实际: ' + (out[0] && out[0].status));

  // 名称归一（无 leagueId 的负 fakeId 卡）也应被吸收
  const fake = { leagueid: -2345678, name: '1win Essence 3', startDate: t + 3 * 86400, status: 'upcoming' };
  const out2 = mergeAllWithUpcoming([ongoing], [fake]);
  assert('T6: 规范名变体（Essence 3）按名归并', out2.length === 1, '实际 ' + out2.length);
})();

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) process.exit(1);
