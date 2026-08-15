// ═══════════════════════════════════════════════════════════════════════════
// replay-live-absorb.js —— 真机等价复现（一次性验证工具，v3.1，审核 R5）
// ═══════════════════════════════════════════════════════════════════════════
// 定位：把页面 league-detail.js buildSeriesFromSources 的链路**逐行复制**（fmt →
// LP filter/map（v1.2 透传）→ 时间窗 → 吸收 → applyBo → liveProgress），用真实数据
// 验证 LIVE 卡比分。**不进 npm test**（页面更新可能失真，需同步或重跑）；长期回归靠
// test-bo.js T25（sources.js 纯函数层）。
//
// 用法：node scripts/replay-live-absorb.js
//   输入：/tmp/od_gotf_now2.json（OpenDota 64 场）+ /tmp/lp_gotf_now2.json（LP wikitext）
//         /tmp/od_1win_now.json（47 场）+ /tmp/lp_1win_now.json
//   场景：构造「用户时刻 X」——对局第一局已结算、LP 标 live（模拟 LP 当时状态）
//   断言：修复前（resolver 无 explorer map）LIVE 0:0；修复后（带 map）LIVE 1:0
// ═══════════════════════════════════════════════════════════════════════════
const sources = require('../../utils/sources.js');
const curation = require('../../utils/curation.js');
const LP = require('../../utils/liquipedia-parse.js');
const fs = require('fs');

// ---- 页面 fmt() 复制（league-detail.js L1522-1562）----
function fmt(m, anchor) {
  const aId = anchor && anchor.teamAId > 0 ? anchor.teamAId : 0;
  const bId = anchor && anchor.teamBId > 0 ? anchor.teamBId : 0;
  let aWin = false, bWin = false;
  if (m.radiant_win === true || m.radiant_win === false) {
    const winnerId = m.radiant_win ? m.radiant_team_id : m.dire_team_id;
    if (aId > 0 && bId > 0 && winnerId > 0) {
      if (winnerId === aId) aWin = true;
      else if (winnerId === bId) bWin = true;
    } else {
      if (m.radiant_win) aWin = true; else bWin = true;
    }
  }
  return {
    match_id: m.match_id,
    radiantName: m.radiant_team_name || '天辉',
    direName: m.dire_team_name || '夜魇',
    radiantTeamId: m.radiant_team_id,
    direTeamId: m.dire_team_id,
    radiantScore: Number(m.radiant_score) || 0,
    direScore: Number(m.dire_score) || 0,
    radiantWin: m.radiant_win,
    aWin: aWin, bWin: bWin,
    time: new Date((m.start_time || 0) * 1000).toISOString().slice(11, 16),
    duration: (m.duration || 0) ? (m.duration + 's') : ''
  };
}

// ---- 页面 buildSeriesFromSources 核心链路复制（吸收聚焦）----
function build(raw, scheduled, boFormat, teamIdNameMap) {
  const fmtNowSec = Math.floor(Date.now() / 1000);
  // 1) groupSeries → fmt
  let allSeries = sources.groupSeries(raw).map((s) => {
    const anchor = { teamAId: s.radiantTeamId, teamBId: s.direTeamId };
    s.games = s.games.map((m) => fmt(m, anchor));
    return s;
  });
  // 2) LP filter（R1：phase!=='recent' 早退）+ map（v1.2 透传）
  const openDotaMatchIds = new Set(raw.map((m) => String(m.match_id)));
  const normD = (n) => String(n || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  let liqSeries = scheduled
    .filter((m) => { if (m.phase !== 'recent') return true; return !(m.matchIds && m.matchIds.length && m.matchIds.every((id) => openDotaMatchIds.has(String(id)))); })
    .map((m) => {
      return {
        key: 'liq-' + normD(m.team1Name) + '__' + normD(m.team2Name) + '-' + (m.startTime || 0),
        games: [], phase: m.phase,
        matchIds: m.matchIds || [], team1Name: m.team1Name, team2Name: m.team2Name,
        radiantName: m.team1Name, direName: m.team2Name, radiantTeamId: 0, direTeamId: 0,
        scoreA: m.score1 || 0, scoreB: m.score2 || 0, boType: m.boType,
        section: m.section || '', lastTime: m.startTime || 0
      };
    });
  // 3) 时间窗过滤（live 卡 24h 上界）
  liqSeries = liqSeries.filter((s) => {
    if (s.phase === 'live') return (s.lastTime || 0) > 0 && (fmtNowSec - s.lastTime) < 24 * 3600;
    return true;
  });
  // 4) 吸收（resolver：_teamIdNameMap 优先 → curation → raw idMap，v3.1 R1）
  const curTable = curation.CURATED_TEAMS || {};
  const rawIdMap = {};
  (raw || []).forEach((m) => {
    if (m && m.radiant_team_id && m.radiant_team_name) rawIdMap[m.radiant_team_id] = m.radiant_team_name;
    if (m && m.dire_team_id && m.dire_team_name) rawIdMap[m.dire_team_id] = m.dire_team_name;
  });
  const resolver = (id) => {
    if (!id) return null;
    if (teamIdNameMap && teamIdNameMap[id]) return teamIdNameMap[id];
    if (curTable[id] && curTable[id].name) return curTable[id].name;
    return rawIdMap[id] || null;
  };
  const absorb = sources.absorbSettledGames(allSeries, liqSeries, resolver);
  liqSeries = absorb.liqSeries;
  if (absorb.absorbedKeys.length) {
    const removed = new Set(absorb.absorbedKeys);
    allSeries = allSeries.filter((s) => !(s.key && removed.has(s.key)));
  }
  // 5) concat → applyBo → liveProgress
  allSeries = allSeries.concat(liqSeries);
  const ctx = sources.buildBoContext(allSeries, { leagueId: 19917, leagueName: 'Games of the Future 2026' });
  return allSeries.map((s) => {
    const r = sources.applyBo(s, ctx);
    r.liveProgress = sources.liveProgressOf(r);
    return r;
  });
}

// ---- 数据准备：模拟「用户时刻 X」（第一局已结算 + LP 标 live）----
function simLiveMoment(rawAll, lpCards, firstMatchIds, team1, team2, resolverMap) {
  // OpenDota 只留第一局对应场次
  const rawX = rawAll.filter((m) => firstMatchIds.indexOf(m.match_id) >= 0);
  // LP 卡：matchIds 只留第一局、phase 强制 live（模拟 LP 当时状态）
  const lpX = lpCards.filter((m) => (m.team1Name || '').toLowerCase() === team1.toLowerCase())
    .map((m) => Object.assign({}, m, { phase: 'live', matchIds: firstMatchIds.slice() }));
  return { rawX: rawX, lpX: lpX, resolverMap: resolverMap };
}

function report(label, liveCards) {
  liveCards.forEach((s) => {
    console.log(' ', label, '|', (s.radiantName || '?') + ' vs ' + (s.direName || '?'), '| phase=' + s.phase,
      '| ' + s.boType, '| ' + s.scoreA + '-' + s.scoreB, '| games=' + (s.games || []).length, '| ' + (s.liveProgress || ''));
  });
  return liveCards;
}

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log('PASS ', name); }
  else { fail++; console.log('FAIL ', name, '->', detail); }
}

// ═══ GotF：PlayTime vs Team Resilience（用户时刻 X）═══
(function () {
  if (!fs.existsSync('/tmp/od_gotf_now2.json') || !fs.existsSync('/tmp/lp_gotf_now2.json')) {
    console.log('SKIP GotF（数据文件不存在）'); return;
  }
  const raw = require('/tmp/od_gotf_now2.json');
  const wt = (require('/tmp/lp_gotf_now2.json')).query.pages[0].revisions[0].slots.main.content || '';
  const sched = LP.parseScheduledMatches(wt);
  const sim = simLiveMoment(raw, sched, [8928851109], 'PlayTime', 'Team Resilience', null);
  // 修复前：无 explorer map（模拟现状 resolver=curation/raw）→ 应 0:0 守卫
  const before = build(sim.rawX, sim.lpX, null, null);
  report('GotF 修复前', before.filter((s) => s.phase === 'live'));
  const bLive = before.filter((s) => s.phase === 'live');
  assert('GotF 修复前（无 explorer map）：LIVE 0:0 守卫', bLive.length === 0 || (bLive[0] && bLive[0].scoreA === 0 && bLive[0].scoreB === 0 && bLive[0].games.length === 0));
  // 修复后：resolver 带 explorer 名（10207983=PlayTime / 10207984=Team resilience）
  const after = build(sim.rawX, sim.lpX, null, { 10207983: 'PlayTime', 10207984: 'Team resilience' });
  report('GotF 修复后', after.filter((s) => s.phase === 'live'));
  const aLive = after.filter((s) => s.phase === 'live');
  const ok = aLive.length === 1 && aLive[0].games.length === 1 && aLive[0].scoreA === 1 && aLive[0].scoreB === 0 &&
    aLive[0].boType === 'BO3' && aLive[0].liveProgress === 'Game 1/3';
  assert('GotF 修复后：LIVE 1:0 BO3 Game 1/3（PlayTime 视角）', ok,
    '实际: ' + (aLive[0] ? aLive[0].scoreA + '-' + aLive[0].scoreB + ' games=' + aLive[0].games.length + ' ' + aLive[0].boType : '无 LIVE 卡'));
})();

// ═══ 1win：BetBoom vs OG（同场景回归）═══
(function () {
  if (!fs.existsSync('/tmp/od_1win_now.json') || !fs.existsSync('/tmp/lp_1win_now.json')) {
    console.log('SKIP 1win（数据文件不存在）'); return;
  }
  const raw = require('/tmp/od_1win_now.json');
  const wt = (require('/tmp/lp_1win_now.json')).query.pages[0].revisions[0].slots.main.content || '';
  const sched = LP.parseScheduledMatches(wt);
  const sim = simLiveMoment(raw, sched, [8928712123], 'BetBoom Team', 'OG', null);
  // 修复后：curation 有 OG（2586976）→ 单点定向
  const after = build(sim.rawX, sim.lpX, null, { 2586976: 'OG' });
  report('1win 修复后', after.filter((s) => s.phase === 'live'));
  const aLive = after.filter((s) => s.phase === 'live');
  const ok = aLive.length === 1 && aLive[0].games.length === 1 && aLive[0].scoreA === 1 && aLive[0].scoreB === 0;
  assert('1win 修复后：LIVE 1:0（team1=BetBoom 视角）', ok,
    '实际: ' + (aLive[0] ? aLive[0].scoreA + '-' + aLive[0].scoreB : '无 LIVE 卡'));
})();

console.log('=== 结果 ===');
console.log('通过: ' + pass + '  失败: ' + fail);
process.exit(fail > 0 ? 1 : 0);
