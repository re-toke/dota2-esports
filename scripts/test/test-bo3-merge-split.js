// test-bo3-merge-split.js —— v8.8 A'：RECENT 段「OpenDota 拆裂 BO3」合并逻辑单测
// 直接测 utils/sources.js 的共享纯函数 mergeSplittedBo3Series（首页/详情页共用，不联网）。
'use strict';
const sources = require('../../utils/sources.js');

let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail ? '  → ' + detail : '')); }
}

const merge = sources.mergeSplittedBo3Series;

// 构造单局卡（recent + games=1）辅助
function mkCard(opts) {
  const g = {
    match_id: opts.mid || 1,
    radiantWin: opts.radiantWin != null ? opts.radiantWin : null,
    radiant_win: opts.radiantWin != null ? opts.radiantWin : null,
    radiantTeamId: opts.radTid != null ? opts.radTid : 0,
    direTeamId: opts.direTid != null ? opts.direTid : 0,
    radiantScore: 0, direScore: 0,
    start_time: opts.start_time || 0,
    time: '', duration: '', aWin: !!opts.radiantWin, bWin: !opts.radiantWin
  };
  return {
    key: opts.key || ('s' + (opts.mid || Math.random())),
    phase: 'recent', isRecent: true, isLive: false, isUpcoming: false,
    games: [g],
    radiantName: opts.radiantName || '天辉',
    direName: opts.direName || '夜魇',
    radiantTeamId: g.radiantTeamId, direTeamId: g.direTeamId,
    radiantWin: !!opts.radiantWin, direWin: !opts.radiantWin,
    scoreA: opts.radiantWin ? 1 : 0, scoreB: opts.radiantWin ? 0 : 1,
    seriesType: opts.seriesType != null ? opts.seriesType : 1,
    boType: 'BO1', boLabel: '单局制', isMulti: false,
    firstTime: opts.start_time || 0, lastTime: opts.start_time || 0,
    radiantLogo: '', direLogo: ''
  };
}

// ===== 用例 =====
// H1：ZT vs TSA 三局跨双 team_id（9600141/10208035）→ BO3 2:1
(function () {
  const base = 1788292000;
  const list = [
    mkCard({ key: 's1136859', mid: 8978147287, radiantName: 'Zero Tenacity', direName: 'Team Spirit Academy', radTid: 9600141, direTid: 9948367, radiantWin: false, start_time: base }),
    mkCard({ key: 's1136882', mid: 8978242189, radiantName: 'Zero Tenacity', direName: 'Team Spirit Academy', radTid: 10208035, direTid: 9948367, radiantWin: true, start_time: base + 3800 }),
    mkCard({ key: 's1136896', mid: 8978292022, radiantName: 'Zero Tenacity', direName: 'Team Spirit Academy', radTid: 9600141, direTid: 9948367, radiantWin: true, start_time: base + 6900 })
  ];
  const out = merge(list);
  assert('H1: 三张单局卡合并为 1 张', out.length === 1, '实际 ' + out.length);
  const s = out[0];
  assert('H1: boType=BO3', s.boType === 'BO3', '实际 ' + s.boType);
  assert('H1: 比分 2-1', s.scoreA === 2 && s.scoreB === 1, '实际 ' + s.scoreA + '-' + s.scoreB);
  assert('H1: games=3（各局保留）', s.games.length === 3, '实际 ' + s.games.length);
  assert('H1: key 为 mrg_ 前缀稳定键', s.key && s.key.indexOf('mrg_') === 0, s.key);
})();

// H2：1:1 中断局（Yangon vs Kinetix 两局）→ 不合并，各自保留
(function () {
  const base = 1788370000;
  const list = [
    mkCard({ key: 's1136983', radiantName: 'Yangon Galacticos', direName: 'Team Kinetix', radTid: 7653080, direTid: 10232572, radiantWin: false, start_time: base }),
    mkCard({ key: 's1136994', radiantName: 'Yangon Galacticos', direName: 'Team Kinetix', radTid: 9546449, direTid: 10232572, radiantWin: true, start_time: base + 3400 })
  ];
  const out = merge(list);
  assert('H2: 1:1 不合并（2 张保留）', out.length === 2, '实际 ' + out.length);
})();

// H3：不同队对不合并
(function () {
  const base = 1788300000;
  const list = [
    mkCard({ key: 'a', radiantName: 'Team A', direName: 'Team B', radiantWin: true, start_time: base }),
    mkCard({ key: 'b', radiantName: 'Team C', direName: 'Team D', radiantWin: true, start_time: base + 1000 })
  ];
  const out = merge(list);
  assert('H3: 不同队对保持独立', out.length === 2, '实际 ' + out.length);
})();

// H4：6h 窗外不合并
(function () {
  const base = 1788300000;
  const list = [
    mkCard({ key: 'a', radiantName: 'Team A', direName: 'Team B', radiantWin: true, start_time: base }),
    mkCard({ key: 'b', radiantName: 'Team A', direName: 'Team B', radiantWin: false, start_time: base + 8 * 3600 })
  ];
  const out = merge(list);
  assert('H4: 间隔 8h（>6h 窗）不合并', out.length === 2, '实际 ' + out.length);
})();

// H5：正常聚合 BO3（games=3）不参与、原样保留
(function () {
  const base = 1788300000;
  const normalBo3 = {
    key: 's1136766', phase: 'recent', isRecent: true,
    games: [{}, {}, {}],
    radiantName: 'Team Synapse', direName: 'Level UP',
    scoreA: 2, scoreB: 1, boType: 'BO3', isMulti: true,
    firstTime: base, lastTime: base + 7000
  };
  const list = [normalBo3];
  const out = merge(list);
  assert('H5: games=3 的正常 BO3 不处理', out.length === 1 && out[0] === normalBo3, '实际 ' + out.length);
})();

// H6：真 BO1（同队对仅 1 局）不受影响
(function () {
  const base = 1788300000;
  const list = [
    mkCard({ key: 'only', radiantName: 'Team A', direName: 'Team B', seriesType: 0, radiantWin: true, start_time: base })
  ];
  const out = merge(list);
  assert('H6: 单张 BO1 原样保留', out.length === 1 && out[0].key === 'only', '实际 ' + out.length);
})();

// H7：2:0 两局（ZT vs PuckChamp 真实场景 rw=true/true）→ BO3 2:0
(function () {
  const base = 1788290000;
  const list = [
    mkCard({ key: 's1136291', radiantName: 'Zero Tenacity', direName: 'PuckChamp', radiantWin: true, start_time: base }),
    mkCard({ key: 's1136302', radiantName: 'Zero Tenacity', direName: 'PuckChamp', radiantWin: true, start_time: base + 4200 })
  ];
  const out = merge(list);
  assert('H7: 2:0 两局合并为 BO3', out.length === 1 && out[0].boType === 'BO3' && out[0].scoreA === 2, '实际 ' + out.length + ' ' + (out[0] && out[0].boType + ' ' + out[0].scoreA + '-' + out[0].scoreB));
})();

// H8：占位名（天辉/夜魇）不参与合并（首页未解名场景安全兜底）
(function () {
  const base = 1788300000;
  const list = [
    mkCard({ key: 'a', radiantName: '天辉', direName: '夜魇', radiantWin: true, start_time: base }),
    mkCard({ key: 'b', radiantName: '天辉', direName: '夜魇', radiantWin: false, start_time: base + 2000 })
  ];
  const out = merge(list);
  assert('H8: 占位名两张均保留（不误并）', out.length === 2, '实际 ' + out.length);
})();


// ===== H9-H11：跨联赛误标白名单过滤（filterMisattributedRecentSeries）=====
// H9：非参赛队对局被剔除（Yangon vs Kinetix 误标场景）——但白名单来自 curation（联网/远程），
//     单测用 leagueId 无匹配返回原样验证「不强过滤守卫」。
(function () {
  const base = 1788370000;
  const list = [
    mkCard({ key: 'a', radiantName: 'Yangon Galacticos', direName: 'Team Kinetix', radiantWin: false, start_time: base }),
    mkCard({ key: 'b', radiantName: 'Zero Tenacity', direName: 'Team Spirit Academy', radiantWin: true, start_time: base + 100 })
  ];
  // leagueId=999999（curation 无此赛事 → 不强过滤）→ 原样返回
  const out = sources.filterMisattributedRecentSeries(list, 999999);
  assert('H9: curation 未命中的 league 不强过滤', out.length === 2, '实际 ' + out.length);
})();

// H10：非 recent 系列不被白名单过滤（live 由 LP 背书）
(function () {
  const list = [
    mkCard({ key: 'a', radiantName: 'Yangon Galacticos', direName: 'Team Kinetix', radiantWin: true, start_time: 100 })
  ];
  list[0].phase = 'live';   // 改 live
  const out = sources.filterMisattributedRecentSeries(list, 19944);  // 19944 有 curation，但 live 不判
  assert('H10: live 系列不被白名单过滤', out.length === 1, '实际 ' + out.length);
})();

// H11：占位名系列不被白名单误删（队名缺失守卫）
(function () {
  const list = [
    mkCard({ key: 'a', radiantName: '天辉', direName: '夜魇', radiantWin: true, start_time: 100 })
  ];
  const out = sources.filterMisattributedRecentSeries(list, 19944);
  assert('H11: 占位名不被白名单误删', out.length === 1, '实际 ' + out.length);
})();


console.log('\n===== test-bo3-merge-split: ' + passed + ' passed, ' + failed + ' failed =====');
process.exit(failed ? 1 : 0);