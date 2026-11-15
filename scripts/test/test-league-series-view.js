#!/usr/bin/env node
/**
 * scripts/test/test-league-series-view.js
 * 赛事详情页「跨源合并段 + 分页视图模型」单测（★ 2026-11-15 第三批 · 第二刀）
 *
 * 覆盖 utils/leagueSeriesView.js：
 *   mergeLiquipediaSeries（LP 聚合/去重/占位卡覆盖/窗口过滤/吸收）
 *   pageWindow（slicePage / appendPage 共用切片）
 *
 * 运行：node scripts/test/test-league-series-view.js
 */
'use strict';

const view = require('../../utils/leagueSeriesView.js');

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + '  ->  ' + (detail || '')); }
}

// ===== pageWindow =====
(function () {
  const items = [1, 2, 3, 4, 5];
  const a = view.pageWindow(items, 0, 2);
  assert('pageWindow: page0/size2 → 2 条、hasMore、start=0',
    a.slice.length === 2 && a.hasMore === true && a.start === 0, JSON.stringify(a));
  const b = view.pageWindow(items, 1, 2);
  assert('pageWindow: page1/size2 → 4 条、hasMore、start=2',
    b.slice.length === 4 && b.hasMore === true && b.start === 2, JSON.stringify(b));
  const c = view.pageWindow(items, 5, 2);
  assert('pageWindow: 越界页 → 全量且 hasMore=false',
    c.slice.length === 5 && c.hasMore === false && c.start === 10, JSON.stringify(c));
  const d = view.pageWindow(null, 0, 20);
  assert('pageWindow: 非数组 → 空切片', d.slice.length === 0 && d.hasMore === false);
  const e = view.pageWindow(items, -3, 2);
  assert('pageWindow: 负数页收敛为 0', e.page === 0 && e.start === 0, JSON.stringify(e));
})();

// ===== mergeLiquipediaSeries =====
(function () {
  const now = Math.floor(Date.now() / 1000);
  const mkAllSeries = () => ([{
    key: 's1',
    radiantName: 'Natus Vincere',
    direName: 'Team Yandex',
    games: [{ start_time: now - 3600, radiant_team_name: 'Natus Vincere', dire_team_name: 'Team Yandex' }],
    lastTime: now - 3600,
    firstTime: now - 3600
  }]);
  const raw = [{
    match_id: 101, start_time: now - 3600,
    radiant_team_id: 1, dire_team_id: 2,
    radiant_team_name: 'Natus Vincere', dire_team_name: 'Team Yandex'
  }];

  const r0 = view.mergeLiquipediaSeries({
    allSeries: mkAllSeries(), raw: raw, liqScheduled: [], nowSec: now, teamIdNameMap: {}
  });
  assert('merge: 无 LP 赛程 → 原样返回、liqGrouped 为空',
    r0.allSeries.length === 1 && r0.liqGrouped.length === 0,
    JSON.stringify({ n: r0.allSeries.length, g: r0.liqGrouped.length }));

  const r1 = view.mergeLiquipediaSeries({
    allSeries: mkAllSeries(), raw: raw, nowSec: now, teamIdNameMap: {},
    liqScheduled: [{
      team1Name: 'Natus Vincere', team2Name: 'Team Yandex',
      startTime: now - 3500, phase: 'recent', matchIds: [101], section: 'Group'
    }]
  });
  assert('merge: LP recent 与 OpenDota 同 match_id → 被剔除（不重复）',
    r1.allSeries.length === 1, '系列数=' + r1.allSeries.length);

  const r2 = view.mergeLiquipediaSeries({
    allSeries: mkAllSeries(), raw: raw, nowSec: now, teamIdNameMap: {},
    liqScheduled: [{
      team1Name: 'Team Yandex', team2Name: 'TBD',
      startTime: now - 1800, phase: 'upcoming', matchIds: [], section: 'Group'
    }]
  });
  assert('merge: TBD 占位卡已被实际比赛覆盖 → 剔除',
    r2.allSeries.length === 1, '系列数=' + r2.allSeries.length);

  const r3 = view.mergeLiquipediaSeries({
    allSeries: mkAllSeries(), raw: raw, nowSec: now, teamIdNameMap: {},
    liqScheduled: [{
      team1Name: 'Team C', team2Name: 'Team D',
      startTime: now + 3600, phase: 'upcoming', matchIds: [], section: 'Group'
    }]
  });
  assert('merge: 新的 LP upcoming 对阵 → 追加 1 张',
    r3.allSeries.length === 2, '系列数=' + r3.allSeries.length);
})();

// ===== 收尾 =====
console.log('\n===== test-league-series-view: ' + pass + ' passed, ' + fail + ' failed =====');
if (fail > 0) process.exit(1);
