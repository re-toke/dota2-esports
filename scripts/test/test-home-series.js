#!/usr/bin/env node
/**
 * 首页 v5 series 化聚合单测（2026-09-01）
 * 覆盖：首页 _applyMatchSources 三源合并 → sources.groupSeries → buildBoContext(series, null) → applyBo
 *       的系列化结果 —— 一场 BO3 聚为一张卡（2:1 / 1:0 系列比分），并复现三种 phase 场景。
 *
 * 与 test-bo.js 的关系：test-bo 覆盖 BO 判定引擎的信号优先级全集；本文件聚焦「首页输入形态」——
 *   ① proMatches 真实字段名（radiant_name / dire_name，而非 test-bo 的 radiant_team_name）
 *   ② /live 职业场 normalize 后形状（radiant_win=null、无 series_id、start=now-duration）
 *   ③ ctx=null（首页无 Liquipedia 数据 → buildBoContext(series, null)）
 *
 * 运行：node scripts/test/test-home-series.js（已接入 test:all / precommit）
 */
const sources = require('../../utils/sources.js');

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + '  ->  ' + (detail || '')); }
}

// —— 首页 _applyMatchSources 三源合并 → series 化（与 index.js L458-464 同链路）——
function resolveAll(matches) {
  const series = sources.groupSeries(matches);
  const ctx = sources.buildBoContext(series, null);   // 首页无 Liquipedia → ctx=null
  return series.map(function (s) { return sources.applyBo(s, ctx); });
}

// 造 OpenDota proMatches 局（真实字段名 radiant_name/dire_name）
// 天辉侧字段：radiant_team_id + radiant_name；radiant_win 有值 = 已结算
function mkPro(id, seriesId, seriesType, win, rId, dId, rName, dName, start, extra) {
  return Object.assign({
    match_id: id,
    series_id: seriesId,
    series_type: seriesType,
    radiant_win: win,
    radiant_team_id: rId,
    dire_team_id: dId,
    radiant_name: rName,
    dire_name: dName,
    start_time: start,
    duration: 2400,
    radiant_score: 0,
    dire_score: 0,
    leagueid: 10,
    league_name: 'Test League'
  }, extra || {});
}

// 造 /live 职业场（index.js _normalizeLiveMatch 的输入形状：无 series_id、radiant_win=null、无 start_time）
function mkLive(id, rId, dId, rName, dName, duration, spectators, extra) {
  return Object.assign({
    match_id: id,
    league_id: 10,
    team_id_radiant: rId,
    team_id_dire: dId,
    team_name_radiant: rName,
    team_name_dire: dName,
    duration: duration,
    spectators: spectators,
    radiant_score: 0,
    dire_score: 0
  }, extra || {});
}

// 模拟 index.js _normalizeLiveMatch（/live → OpenDota match 平铺结构）
function normalizeLive(m, now) {
  return {
    match_id: m.match_id,
    start_time: m.start_time || (now - (m.duration || 0)),
    radiant_win: null,
    leagueid: m.league_id,
    league_name: m.league_name || '',
    radiant_team_id: m.team_id_radiant,
    dire_team_id: m.team_id_dire,
    radiant_name: m.team_name_radiant,
    dire_name: m.team_name_dire,
    series_type: m.series_type,
    radiant_score: m.radiant_score,
    dire_score: m.dire_score,
    duration: m.duration,
    spectators: m.spectators,
    _isLiveSource: true
  };
}

// ===== H1：BO3 已结束 2:1（含换边局）→ 一场 = 一张卡，不拆 3 张 =====
// 第 2 局换边（B 在天辉边赢）：scoreB 必须按队 ID 归属到 B，而不是按天辉/夜魇边
(function () {
  const now = Math.floor(Date.now() / 1000);
  const list = resolveAll([
    mkPro(101, 100, 1, true, 1, 2, 'Team A', 'Team B', now - 7200),
    mkPro(102, 100, 1, true, 2, 1, 'Team B', 'Team A', now - 5400),   // 换边：radiant=B 赢
    mkPro(103, 100, 1, true, 1, 2, 'Team A', 'Team B', now - 3600)
  ]);
  assert('H1: BO3 三局聚合为 1 个系列（不拆 3 张单局卡）', list.length === 1, '实际系列数: ' + list.length);
  const s = list[0];
  assert('H1: games=3 局完整聚合', s.games.length === 3, '实际: ' + s.games.length);
  assert('H1: 系列比分 2:1（换边局按队 ID 归属，非按边）', s.scoreA === 2 && s.scoreB === 1,
    '实际: ' + s.scoreA + '-' + s.scoreB);
  assert('H1: phase=recent（已结束 → 首页映射 ended）', s.phase === 'recent', '实际: ' + s.phase);
  assert('H1: applyBo S3 → BO3', s.boType === 'BO3', '实际: ' + s.boType);
  assert('H1: radiantWin=true（A 队胜）', s.radiantWin === true, '实际: ' + s.radiantWin);
})();

// ===== H2：进行中 1:0 + /live 局并入（核心场景）=====
// proMatches 已结算第 1 局（series_id=200, st=1）+ /live 第 2 局（无 series_id, radiant_win=null）
// → patchNullSeriesId 借邻居（同队ID对 + 6h 窗口）→ 并入 s200 → 「进行中 BO3 1:0」
(function () {
  const now = Math.floor(Date.now() / 1000);
  const pro = mkPro(201, 200, 1, true, 1, 2, 'Team A', 'Team B', now - 3600);
  const liveRaw = mkLive(202, 1, 2, 'Team A', 'Team B', 1800, 856);   // /live 无 series_id
  const live = normalizeLive(liveRaw, now);
  const list = resolveAll([pro, live]);
  assert('H2: 已结算局 + live 局并入同一系列', list.length === 1, '实际系列数: ' + list.length);
  const s = list[0];
  assert('H2: 系列 key=s200（借邻居软关联）', s.key === 's200', '实际: ' + s.key);
  assert('H2: games=2（已结算 1 局 + live 1 局）', s.games.length === 2, '实际: ' + s.games.length);
  assert('H2: phase=live（进行中）', s.phase === 'live', '实际: ' + s.phase);
  assert('H2: 系列比分 1:0（live 局未结算不计）', s.scoreA === 1 && s.scoreB === 0,
    '实际: ' + s.scoreA + '-' + s.scoreB);
  assert('H2: applyBo S3 → BO3', s.boType === 'BO3', '实际: ' + s.boType);
  const liveGame = s.games.find(function (g) { return g._isLiveSource; });
  assert('H2: live 局 _isLiveSource 标记保留（供 liveSubText 提取）', !!liveGame && liveGame.spectators === 856,
    '实际: ' + JSON.stringify(liveGame && liveGame.spectators));
})();

// ===== H3：upcoming 排期赛 series_type=1 → BO3 =====
// 关注战队 upcoming：无 match_id（或 0）、radiant_win=null、start 在未来 → phase=upcoming，applyBo S3 → BO3
(function () {
  const now = Math.floor(Date.now() / 1000);
  const list = resolveAll([
    mkPro(0, 0, 1, null, 5, 6, 'Team C', 'Team D', now + 7200, { leagueid: 20, league_name: 'Upcoming League' })
  ]);
  assert('H3: 排期赛独立成 1 个系列', list.length === 1, '实际系列数: ' + list.length);
  const s = list[0];
  assert('H3: phase=upcoming（即将开始）', s.phase === 'upcoming', '实际: ' + s.phase);
  assert('H3: applyBo S3（series_type=1）→ BO3', s.boType === 'BO3', '实际: ' + s.boType);
  assert('H3: 比分 0:0（未开赛不显示比分）', s.scoreA === 0 && s.scoreB === 0,
    '实际: ' + s.scoreA + '-' + s.scoreB);
})();

// ===== H4：BO3 进行中单局（series_type=1 已结算 1:0）→ 强制 live =====
// H 根因回归：OpenDota 对进行中的 BO3 可能只收录已结算第 1 局 → 不得误判为「已结束 BO1」
(function () {
  const now = Math.floor(Date.now() / 1000);
  const list = resolveAll([
    mkPro(301, 300, 1, true, 7, 8, 'Team E', 'Team F', now - 7200)
  ]);
  assert('H4: 单局独立成 1 个系列', list.length === 1, '实际系列数: ' + list.length);
  const s = list[0];
  assert('H4: phase=live（系列未决出胜负，强制 live）', s.phase === 'live',
    '实际: ' + s.phase + ' score=' + s.scoreA + '-' + s.scoreB);
  assert('H4: applyBo → BO3（不降级为已结束 BO1）', s.boType === 'BO3', '实际: ' + s.boType);
})();

// ===== H5：孤儿互并 —— series_id 全 null 的 BO3 两局合并 =====
// patchNullSeriesId qualified 为空时也必须执行 _orphanPairMerge（同队ID对 + 同日 + series_type>=1）
(function () {
  const now = Math.floor(Date.now() / 1000);
  const list = resolveAll([
    mkPro(401, 0, 1, true, 9, 10, 'Team G', 'Team H', now - 5400),
    mkPro(402, 0, 1, true, 9, 10, 'Team G', 'Team H', now - 3600)
  ]);
  assert('H5: 全 null series_id 两局互并为 1 个系列', list.length === 1, '实际系列数: ' + list.length);
  const s = list[0];
  assert('H5: games=2 局合并', s.games.length === 2, '实际: ' + s.games.length);
  assert('H5: 比分 2:0（同队两局全胜）', s.scoreA === 2 && s.scoreB === 0,
    '实际: ' + s.scoreA + '-' + s.scoreB);
  assert('H5: applyBo → BO3', s.boType === 'BO3', '实际: ' + s.boType);
})();

// ===== H5b（2026-09-01）：跨 UTC 午夜的 BO3 孤儿互并 =====
// 根因：_orphanPairMerge 原按「队ID对@UTC自然日」分桶，跨午夜的两局（23:53Z / 次日 00:23Z）
//   落到不同桶 → 不合并 → 同一场 BO3 首页显示成两张独立卡。
//   修复：改为同队ID对按开赛时间排序 + 「相邻局间隔 ≤6h」链式聚类，摆脱 UTC 日边界。
// ⚠️ 本用例用固定 UTC 时间戳构造跨午夜场景，不依赖运行时刻（H5 用 now-N 会随时段漂移）。
(function () {
  // 固定锚点：2026-09-01T00:00:00Z，前一局 23:53Z（8/31）、后一局 00:23Z（9/1）
  const midnight = Math.floor(Date.UTC(2026, 8, 1, 0, 0, 0) / 1000);
  const list = resolveAll([
    mkPro(501, 0, 1, true, 21, 22, 'Team X', 'Team Y', midnight - 420),   // 23:53Z（前一日）
    mkPro(502, 0, 1, true, 21, 22, 'Team X', 'Team Y', midnight + 1380)   // 00:23Z（次日）
  ]);
  assert('H5b: 跨 UTC 午夜两局仍合并为 1 个系列', list.length === 1, '实际系列数: ' + list.length);
  assert('H5b: games=2', list[0] && list[0].games.length === 2,
    '实际: ' + (list[0] ? list[0].games.length : 'n/a'));
  assert('H5b: applyBo → BO3', list[0] && list[0].boType === 'BO3',
    '实际: ' + (list[0] ? list[0].boType : 'n/a'));
  // 反例：间隔 >6h 的同队对不得合并（防过度聚合把两天的小组赛并成一场）
  const far = resolveAll([
    mkPro(503, 0, 1, true, 23, 24, 'Team P', 'Team Q', midnight),
    mkPro(504, 0, 1, true, 23, 24, 'Team P', 'Team Q', midnight + 8 * 3600)
  ]);
  assert('H5b: 间隔 8h（>6h 窗口）不合并', far.length === 2, '实际系列数: ' + far.length);
})();

// ===== H6（2026-09-01 根因 H6）：多队 upcoming 排期赛各自独立成卡 =====
// 回归：getSeriesKey 对无 series_id 且 match_id=0 的局一律返回 'm0' → 不同战队的
// upcoming 全部塌缩进同一组，首页「即将开始」段多队 upcoming 被合并成 1 张卡
// （v5 相对 v4.2 的回归；v4.2 _cardFromTeamMatch 用 leagueid+start_time 独立成卡）。
// 修复后：不同队对/不同时刻各自独立；同队对同时刻（同场重复注入）仍合并。
(function () {
  const now = Math.floor(Date.now() / 1000);
  const list = resolveAll([
    mkPro(0, 0, 1, null, 11, 12, 'Team I', 'Team J', now + 7200, { leagueid: 30, league_name: 'L A' }),
    mkPro(0, 0, 1, null, 13, 14, 'Team K', 'Team L', now + 10800, { leagueid: 31, league_name: 'L B' }),
    mkPro(0, 0, 1, null, 15, 16, 'Team M', 'Team N', now + 14400, { leagueid: 32, league_name: 'L C' }),
    // 与第一场同队对同时刻（同一场被多战队列表重复注入）→ 必须仍合并
    mkPro(0, 0, 1, null, 12, 11, 'Team J', 'Team I', now + 7200, { leagueid: 30, league_name: 'L A' })
  ]);
  assert('H6: 3 场不同 upcoming 独立成 3 个系列（不再塌缩 1 张卡）', list.length === 3,
    '实际系列数: ' + list.length);
  const keys = list.map(function (s) { return s.key; });
  assert('H6: 键互不相同且非 m0', keys.every(function (k) { return k !== 'm0'; }) && new Set(keys).size === 3,
    '实际键: ' + keys.join(','));
  const dup = list.find(function (s) { return s.games.length === 2; });
  assert('H6: 同场重复注入（同队对同时刻）合并为 1 个系列', !!dup && dup.games.length === 2,
    '实际: ' + JSON.stringify(list.map(function (s) { return s.games.length; })));
  assert('H6: 全部 phase=upcoming', list.every(function (s) { return s.phase === 'upcoming'; }),
    '实际: ' + list.map(function (s) { return s.phase; }).join(','));
  assert('H6: 全部 applyBo → BO3', list.every(function (s) { return s.boType === 'BO3'; }),
    '实际: ' + list.map(function (s) { return s.boType; }).join(','));
})();

// ===== H7（2026-09-01 首页 v5.1）：LP 排期源 buildLpUpcomingSeries =====
// 首页新接对局级 upcoming 源（liquipedia.getScheduledMatches → buildLpUpcomingSeries）：
//   ① 只保留未开赛 + 双方确定队名（TBD/TBA 排除）
//   ② 一场 BO3 = 1 条记录（haglund 形状）原样保留；Steam 风格「一局=1条」多局聚为 1 系列（防拆卡）
//   ③ 映射字段与 groupSeries 输出兼容（_cardFromSeries 可直接消费），联赛名透传（卡头显示）
// 造 LP 排期 match（liquipedia.getScheduledMatches 输出形状）
function mkLp(id, sId, t1, t2, st, extra) {
  return Object.assign({
    matchIds: [id],
    series_id: sId,
    team1Name: t1,
    team2Name: t2,
    startTime: st,
    phase: 'upcoming',
    boType: 'BO3',
    series_type: 1,
    mapSlots: 3,
    boDeclared: true,
    _leagueName: 'EPL Masters II',
    leagueId: 19944
  }, extra || {});
}

(function () {
  const now = Math.floor(Date.now() / 1000);
  // 输入：两场不同队名对的 upcoming 系列（haglund 形状，一场=1条）+ 一场已开赛 + 一场 TBD 对手
  const list = sources.buildLpUpcomingSeries([
    mkLp(501, 'lp_M01', 'Team A', 'Team B', now + 7200),
    mkLp(502, 'lp_M02', 'Team C', 'Team D', now + 10800),
    mkLp(503, 'lp_M03', 'Team E', 'Team F', now - 3600),    // 已开赛 → 排除
    mkLp(504, 'lp_M04', 'TBD', 'Team G', now + 7200)        // TBD 对手 → 排除
  ], now);
  assert('H7: 两场 upcoming 独立成 2 个系列（已开赛/TBD 排除）', list.length === 2,
    '实际系列数: ' + list.length + ' -> ' + JSON.stringify(list.map(function (s) {
      return s.radiantName + ' vs ' + s.direName;
    })));
  const s = list[0];
  assert('H7: 映射 radiantName/direName（队名透传）', s.radiantName === 'Team A' && s.direName === 'Team B',
    '实际: ' + s.radiantName + ' vs ' + s.direName);
  assert('H7: phase=upcoming + isUpcoming=true', s.phase === 'upcoming' && s.isUpcoming === true,
    '实际: ' + s.phase);
  assert('H7: 比分 0:0（未开赛不显示比分）', s.scoreA === 0 && s.scoreB === 0,
    '实际: ' + s.scoreA + '-' + s.scoreB);
  assert('H7: boType=BO3（S1 boDeclared 信号保留）', s.boType === 'BO3', '实际: ' + s.boType);
  assert('H7: leagueName 透传（首页卡头显示赛事名，非「职业赛事」）', s.leagueName === 'EPL Masters II',
    '实际: ' + JSON.stringify(s.leagueName));
  assert('H7: series key 为 lpup_ 前缀且互不相同', list.every(function (x) {
    return typeof x.key === 'string' && x.key.indexOf('lpup_') === 0;
  }) && new Set(list.map(function (x) { return x.key; })).size === 2,
    '实际键: ' + list.map(function (x) { return x.key; }).join(','));
})();

// H7c（Steam 风格）：同队名对 + 同日 + 间隔≤6h 的「一局=1条」多局 → 聚为 1 个系列（防拆卡）
(function () {
  const now = Math.floor(Date.now() / 1000);
  const list = sources.buildLpUpcomingSeries([
    mkLp(511, 0, 'Team A', 'Team B', now + 7200, { boType: null, boDeclared: false }),
    mkLp(512, 0, 'Team A', 'Team B', now + 9000, { boType: null, boDeclared: false }),
    mkLp(513, 0, 'Team B', 'Team A', now + 10800, { boType: null, boDeclared: false })   // 换边局
  ], now);
  assert('H7c: Steam 风格三局聚为 1 个系列（不拆 3 张卡）', list.length === 1,
    '实际系列数: ' + list.length + ' -> ' + JSON.stringify(list.map(function (s) {
      return s.radiantName + ' vs ' + s.direName;
    })));
  const s = list[0];
  assert('H7c: leagueName 仍透传（聚合对象携带联赛名）', s.leagueName === 'EPL Masters II',
    '实际: ' + JSON.stringify(s.leagueName));
})();

// H7b：空输入 / 全部过滤 → []
(function () {
  const now = Math.floor(Date.now() / 1000);
  assert('H7b: 空数组 → []', sources.buildLpUpcomingSeries([], now).length === 0, '');
  assert('H7b: 全部已开赛 → []', sources.buildLpUpcomingSeries([
    mkLp(601, 'lp_X1', 'Team F', 'Team G', now - 120)
  ], now).length === 0, '');
  assert('H7b: 全部 TBD → []', sources.buildLpUpcomingSeries([
    mkLp(602, 'lp_X2', 'TBA', 'Team H', now + 3600)
  ], now).length === 0, '');
})();

// H7d（v5.1 ⑥ 源块）：applyBo 权威覆盖 —— Steam 风格「仅 series_type 无 boType」
//   buildLpUpcomingSeries 直判 `m.boType || 'BO1'` 会误判 BO1；_applyMatchSources ⑥ 源块
//   先 buildBoContext + applyBo，S3（series_type=1）救回 BO3。与 v5 主链路判定一致。
(function () {
  const now = Math.floor(Date.now() / 1000);
  const raw = sources.buildLpUpcomingSeries([
    mkLp(701, 0, 'Team A', 'Team B', now + 7200, { boType: null, boDeclared: false })
  ], now);
  const ctx = sources.buildBoContext(raw, null);
  raw.forEach((s) => sources.applyBo(s, ctx));
  assert('H7d: 仅 series_type=1 无 boType → applyBo S3 → BO3（不误判 BO1）',
    raw.length === 1 && raw[0].boType === 'BO3', '实际: ' + (raw[0] && raw[0].boType));
})();

// H8（2026-09-01 进行中卡修复）：buildLpLiveSeries —— LP/Steam 排期 LIVE 场系列化
//   覆盖：① phase='live' 已开赛场 → 出 live series（不被 upcoming 过滤吞掉）
//        ② BO3 两局（换边）按 series_id 聚合为 1 卡，比分取最大
//        ③ 透传 Steam 原生字段（team_id / 队标 / leagueName / leagueId）
//        ④ upcoming 场不被 live 函数捕获
(function () {
  const now = Math.floor(Date.now() / 1000);
  const live = [
    Object.assign(mkLp(801, 777001, 'Team Spirit', 'Team Falcons', now - 1800, {
      phase: 'live', series_type: 1, boType: 'BO3',
      score1: 1, score2: 0,
      radiant_team_id: 111, dire_team_id: 222,
      team1Logo: 'https://cdn.steamusercontent.com/a.jpg',
      team2Logo: 'https://cdn.steamusercontent.com/b.jpg',
      leagueName: 'EPL Masters II', leagueId: 19944
    })),
    // 同 series_id 第二局（换边）
    Object.assign(mkLp(802, 777001, 'Team Falcons', 'Team Spirit', now - 600, {
      phase: 'live', series_type: 1, boType: 'BO3',
      score1: 0, score2: 1,
      radiant_team_id: 222, dire_team_id: 111,
      team1Logo: 'https://cdn.steamusercontent.com/b.jpg',
      team2Logo: 'https://cdn.steamusercontent.com/a.jpg',
      leagueName: 'EPL Masters II', leagueId: 19944
    }))
  ];
  const s = sources.buildLpLiveSeries(live, now);
  assert('H8: 两局 LIVE 聚合为 1 个 series', s.length === 1, '实际: ' + s.length);
  if (s[0]) {
    assert('H8: phase=live', s[0].phase === 'live', '实际: ' + s[0].phase);
    assert('H8: 系列比分 1:0', s[0].scoreA === 1 && s[0].scoreB === 0, '实际: ' + s[0].scoreA + ':' + s[0].scoreB);
    assert('H8: series_id 透传', s[0].series_id === 777001, '实际: ' + s[0].series_id);
    assert('H8: 队名对（换边聚合后取首场）', s[0].radiantName === 'Team Spirit' && s[0].direName === 'Team Falcons', '实际: ' + s[0].radiantName + ' vs ' + s[0].direName);
    assert('H8: radiantTeamId 透传', s[0].radiantTeamId === 111 && s[0].direTeamId === 222, '实际: ' + s[0].radiantTeamId + '/' + s[0].direTeamId);
    assert('H8: team1Logo 透传', s[0].team1Logo.indexOf('steamusercontent.com') > 0, '实际: ' + s[0].team1Logo);
    assert('H8: leagueName/leagueId 透传', s[0].leagueName === 'EPL Masters II' && s[0].leagueId === 19944, '实际: ' + s[0].leagueName + '/' + s[0].leagueId);
  }
  // ④ upcoming 场不被 live 函数捕获
  const up = sources.buildLpLiveSeries([mkLp(803, 0, 'Team C', 'Team D', now + 3600, { phase: 'upcoming' })], now);
  assert('H8: upcoming 场不被 live 函数捕获', up.length === 0, '实际: ' + up.length);

  // ⑤（2026-09-01 多卡修复）：Steam 残留场（已结束但 phase 误判 live）必须被比分守卫排除
  const withResidual = sources.buildLpLiveSeries([
    // 真 live：BO3 1:0
    Object.assign(mkLp(811, 777011, 'Team A', 'Team B', now - 900, { phase: 'live', series_type: 1, score1: 1, score2: 0 })),
    // 残留场：BO3 2:0 已结束（series_type 缺失 → 原 phase 判定漏）
    Object.assign(mkLp(812, 777012, 'Team C', 'Team D', now - 900, { phase: 'live', series_type: null, score1: 2, score2: 0 })),
    // 残留场：BO5 3:1 已结束（series_type 缺失）
    Object.assign(mkLp(813, 777013, 'Team E', 'Team F', now - 900, { phase: 'live', series_type: null, score1: 3, score2: 1 })),
    // 真 live：0:0 开局无比分
    Object.assign(mkLp(814, 777014, 'Team G', 'Team H', now - 900, { phase: 'live', series_type: 1, score1: 0, score2: 0 }))
  ], now);
  assert('H8: 残留场 2:0 被排除（只剩 2 个真 live）', withResidual.length === 2, '实际: ' + withResidual.length);
  if (withResidual.length === 2) {
    const names = withResidual.map(function (x) { return x.radiantName; }).sort();
    assert('H8: 保留的是 Team A 与 Team G（真 live）',
      names.join(',') === 'Team A,Team G', '实际: ' + names.join(','));
  }

  // ⑥（2026-09-01 三卡修复）：跨源同对局队名写法不同（Steam 全名 x 赞助商 vs LP 简称）
  //   'Inner Circle x Insanity' 与 'Inner Circle' 必须归一化为同一队 → 去重为 1 卡
  const xVariant = sources.buildLpLiveSeries([
    Object.assign(mkLp(821, 888001, 'Inner Circle x Insanity', 'Team Lynx', now, {
      phase: 'live', series_type: 1, score1: 0, score2: 0,
      radiant_team_id: 999, dire_team_id: 888,
      team1Logo: 'https://cdn.steamusercontent.com/x.jpg', team2Logo: 'https://cdn.steamusercontent.com/y.jpg'
    })),
    Object.assign(mkLp(822, 0, 'Inner Circle', 'Team Lynx', now - 7200, {
      phase: 'live', series_type: 1, score1: 0, score2: 0
    })),
    Object.assign(mkLp(823, null, 'Inner Circle', 'Team Lynx', now - 7200 + 600, {
      phase: 'live', series_type: 1, score1: 0, score2: 0
    }))
  ], now);
  assert('H8: x 赞助商全名与简称同对局 → 1 卡', xVariant.length === 1, '实际: ' + xVariant.length);
  if (xVariant[0]) {
    assert('H8: 保留 Steam 全名（含 team_id/队标）', xVariant[0].radiantTeamId === 999 && xVariant[0].team1Logo === 'https://cdn.steamusercontent.com/x.jpg',
      '实际: id=' + xVariant[0].radiantTeamId + ' logo=' + xVariant[0].team1Logo);
  }

  // ⑦（2026-09-01 双卡修复）：② /live 职业场（league_name 缺失 → 「职业赛事」）
  //   被 ⑥ lpUp（Steam 云代理，leagueName 正确）按 series_id 覆盖 —— groupSeries 必须透传
  //   series_id 供 _cardFromSeries 的 seriesId 字段匹配。
  const liveSeries2 = sources.groupSeries([{
    match_id: 555001, start_time: now - 2400, radiant_win: null, leagueid: 19944, league_name: '',
    radiant_team_id: 999, dire_team_id: 888, radiant_name: 'Inner Circle x Insanity', dire_name: 'Team Lynx',
    series_id: 1136691, series_type: undefined, radiant_score: 14, dire_score: 12, duration: 2400,
    spectators: 5000, _isLiveSource: true
  }]);
  assert('H8: groupSeries 透传 series_id（② 卡覆盖匹配依赖）',
    liveSeries2.length === 1 && liveSeries2[0].series_id === 1136691,
    '实际: ' + (liveSeries2[0] && liveSeries2[0].series_id));
  // 同 series_id 的 lpUp live 卡应能匹配并覆盖（验证 _cardFromSeries.seriesId 链路）
  const lpUp2 = sources.buildLpLiveSeries([{
    team1Name: 'Inner Circle x Insanity', team2Name: 'Team Lynx', startTime: now, start_time: now,
    phase: 'live', series_id: 1136691, series_type: 1, score1: 0, score2: 0,
    leagueName: 'EPL Masters II', leagueId: 19944
  }], now);
  assert('H8: lpUp 同 series_id 卡可匹配（供覆盖）', lpUp2.length === 1 && lpUp2[0].series_id === 1136691,
    '实际: ' + (lpUp2[0] && lpUp2[0].series_id));

  // ⑧（2026-09-01 双卡修复 v2）：haglund 兜底源无 series_id 也必须能覆盖 ② /live 的错误卡
  //   —— 匹配键从「仅 series_id」放宽为「队名对（剥离 x 后缀）OR series_id」。
  //   场景：② 卡（全名 Inner Circle x Insanity，league_name 缺失 → 职业赛事）+
  //   ⑥ lpUp 卡（简称 Inner Circle，series_id=null，leagueName=EPL Masters II）。
  const haglundCard = { key: 'x2', seriesId: 1136691, status: 'live', leagueName: '职业赛事', bo: 'BO1',
    teamA: { name: 'Inner Circle x Insanity' }, teamB: { name: 'Team Lynx' } };
  const lpCard = { key: 'x6', seriesId: null, status: 'live', leagueName: 'EPL Masters II', bo: 'BO3',
    teamA: { name: 'Inner Circle' }, teamB: { name: 'Team Lynx' } };
  function normX(s) {
    if (!s) return '';
    return String(s).toLowerCase().replace(/\s*[x×]\s+\S+.*$/i, '').replace(/\s*(esports|e-sports|gaming|team|club)\s*$/g, '').replace(/[^a-z0-9一-鿿а-яё]/g, '');
  }
  function pairX(a, b) {
    var na = normX(a), nb = normX(b);
    if (!na || !nb) return null;
    return na < nb ? (na + '|' + nb) : (nb + '|' + na);
  }
  const pair = pairX(lpCard.teamA.name, lpCard.teamB.name);
  const matched = pair && pairX(haglundCard.teamA.name, haglundCard.teamB.name) === pair;
  assert('H8: haglund 无 series_id 时按队名对匹配 ② 卡（x 剥离）', matched === true, '实际: ' + matched);

  // ⑨（2026-09-02 双卡复现修复）：「pro 已结算 ↔ /live 进行中」矛盾数据裁决 —— /live 版本优先。
  //   实测场景：OpenDota 对进行中的 BO3 把当前局提前写进 proMatches 且 radiant_win 已填，
  //   /live 同 match_id 仍在打。合并时 /live 先入表（seenId 占位），pro 同 id 后到被去重跳过。
  //   验证点：① 合并后只有 1 条（去重生效）；② 保留的是 /live 版本（radiant_win=null、
  //   _isLiveSource=true）；③ league_name 空值已回填（proLeagueNameById）。
  (function () {
    // ★ 2026-09-04 修复时间炸弹：原 start_time 用固定时间戳（1788356464，2026-09-02 编写），
    //   groupSeries 根因 H 的「最后一场结算后 ≤6h 强制 live」窗口随真实时间流逝过期
    //   （两天后运行 phase 退化为 recent）→ 测试恒失败。改为相对运行时间的偏移，
    //   与 groupSeries 内部 Math.floor(Date.now()/1000) 的 now 口径解耦。
    const _nowH9 = Math.floor(Date.now() / 1000);
    const proM = {
      match_id: 8979131280, series_id: 1137089, series_type: 1,
      radiant_win: true, leagueid: 19944, league_name: 'EPL Masters 2026 ',
      radiant_team_id: 10225542, dire_team_id: 10164236,
      radiant_name: 'DYNASTY', dire_name: 'PuckChamp', start_time: _nowH9 - 700
    };
    const rawH9 = [];
    const seenIdH9 = {};
    const pushH9 = (m) => {
      if (!m) return;
      if (m.match_id) {
        const k = String(m.match_id);
        if (seenIdH9[k]) return;
        seenIdH9[k] = true;
        rawH9.push(m);
        return;
      }
      rawH9.push(m);
    };
    const proLeagueNameByIdH9 = { 19944: 'EPL Masters 2026 ' };
    // ② live 先入（模拟修复后的顺序 + league_name 回填；start = 10 分钟前开打，6h 窗内）
    const normH9 = {
      match_id: '8979131280', start_time: _nowH9 - 600, radiant_win: null,
      leagueid: 19944, league_name: '',
      radiant_team_id: 10225542, dire_team_id: 10164236,
      radiant_name: 'DYNASTY', dire_name: 'PuckChamp',
      series_id: 1137089, series_type: 1, _isLiveSource: true
    };
    if (!normH9.league_name) normH9.league_name = proLeagueNameByIdH9[19944] || '';
    pushH9(normH9);
    // ① pro 后入 → 同 match_id 被去重跳过
    pushH9(proM);
    assert('H9: pro/live 矛盾场去重为 1 条（/live 优先）', rawH9.length === 1, '实际: ' + rawH9.length);
    assert('H9: 保留 /live 版本（radiant_win=null 未结算）',
      rawH9[0].radiant_win === null && rawH9[0]._isLiveSource === true,
      '实际: win=' + rawH9[0].radiant_win + ' liveSrc=' + rawH9[0]._isLiveSource);
    assert('H9: league_name 空值已回填（不再退化「职业赛事」）',
      rawH9[0].league_name === 'EPL Masters 2026 ', '实际: ' + rawH9[0].league_name);
    // groupSeries 聚合后应为进行中系列（BO3 1:0 进行中，而非被 pro 的提前结算污染）
    const sH9 = sources.groupSeries(rawH9)[0];
    assert('H9: 聚合后 phase=live（实时局保留）', sH9.phase === 'live', '实际: ' + sH9.phase);
  })();

  // ⑩（2026-09-02 双卡复现修复 3）：lpUp upcoming 卡只替换「退化 live 卡」。
  //   场景：LP 缓存滞后（真实已开打但 LP 数据仍判 upcoming）→ ⑥ 卡 upcoming，
  //   ② 卡 live（league_name 缺失 → 职业赛事）。旧逻辑 upcoming 卡不触发覆盖 → 双卡。
  //   修复后：upcoming 卡替换「leagueName 为『职业赛事』兜底值」的退化 live 卡；
  //   不替换 leagueName 正常的 live 卡（保留比分）。
  (function () {
    const DEGENERATE = '职业赛事';
    const isDegenerate = (c) => (!c.leagueName || c.leagueName === DEGENERATE);
    // 场景 A：退化 live 卡 → 应被替换
    const staleA = [{ key: 's1', status: 'live', leagueName: '职业赛事', teamA: { name: 'A' }, teamB: { name: 'B' } }];
    const keepA = staleA.filter((c) => !(c.status === 'live' && isDegenerate(c)));
    assert('H10: 退化 live 卡（职业赛事）被 lpUp upcoming 卡替换', keepA.length === 0, '实际: ' + keepA.length);
    // 场景 B：正常 live 卡（有 leagueName）→ 不被替换
    const staleB = [{ key: 's2', status: 'live', leagueName: 'EPL Masters II', teamA: { name: 'A' }, teamB: { name: 'B' } }];
    const keepB = staleB.filter((c) => !(c.status === 'live' && isDegenerate(c)));
    assert('H10: 正常 live 卡（信息完整）不被 upcoming 卡误杀', keepB.length === 1, '实际: ' + keepB.length);
  })();
})();

// ===== 收尾 =====
console.log('\n===== test-home-series: ' + pass + ' passed, ' + fail + ' failed =====');
if (fail > 0) process.exit(1);
