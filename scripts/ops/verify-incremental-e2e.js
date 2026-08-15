// scripts/verify-incremental-e2e.js
// 端到端集成验证（联网）：模拟 cachedFreshIncremental 的完整增量流程，
// 验证「直连端点字段 ⊇ 增量 SQL 关键字段 ⊇ 页面消费字段」，且增量 SQL 不再 400。
// 用法：node scripts/verify-incremental-e2e.js  （需联网，作为手动集成验证）
'use strict';

const BASE = 'https://api.opendota.com/api';
const inc = require('../../utils/incremental.js');

async function j(url) {
  const r = await fetch(url);
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error('HTTP ' + r.status + ' ' + txt.slice(0, 200));
  }
  return r.json();
}

let pass = 0, fail = 0;
function ok(c, msg) { if (c) { pass++; console.log('  PASS  ' + msg); } else { fail++; console.log('  FAIL  ' + msg); } }

// 各页面 fmt 实际消费的关键字段
const PAGE_FIELDS = {
  league: ['match_id', 'radiant_team_name', 'dire_team_name', 'radiant_team_id', 'dire_team_id', 'radiant_score', 'dire_score', 'radiant_win', 'start_time'],
  team: ['match_id', 'radiant', 'radiant_win', 'opposing_team_id', 'opposing_team_name', 'league_name', 'start_time', 'radiant_score', 'dire_score'],
  player: ['match_id', 'hero_id', 'kills', 'deaths', 'assists', 'duration', 'start_time', 'radiant_win', 'league_name', 'player_slot']
};

async function checkResource(label, directUrl, resource, id) {
  console.log('\n=== ' + label + ' ===');
  // 1) 直连端点
  let direct = [];
  try {
    direct = await j(directUrl);
    console.log('  直连端点: ' + direct.length + ' 条, fields: ' + (direct[0] ? Object.keys(direct[0]).join(',') : '(empty)'));
    ok(direct.length > 0, '直连端点返回数据');
  } catch (e) { console.log('  直连端点 ERR: ' + e.message); ok(false, '直连端点可访问'); return; }

  // 2) 增量 SQL（cursor=0 全量）
  const sql = inc.buildMatchSql(resource, id, 0);
  let sqlRows = [];
  try {
    const d = await j(BASE + '/explorer?sql=' + encodeURIComponent(sql));
    sqlRows = (d && d.rows) || [];
    console.log('  增量 SQL: ' + sqlRows.length + ' 条, fields: ' + (sqlRows[0] ? Object.keys(sqlRows[0]).join(',') : '(empty)'));
    ok(true, '增量 SQL 不再 400（修复前全部 400）');
  } catch (e) { ok(false, '增量 SQL 仍报错: ' + e.message); return; }

  // 3) 字段对齐：页面消费字段必须都在增量 SQL 字段中
  const sqlFields = sqlRows[0] ? Object.keys(sqlRows[0]) : [];
  const pageFields = PAGE_FIELDS[resource] || [];
  const missing = pageFields.filter((f) => sqlFields.indexOf(f) < 0);
  ok(missing.length === 0, '页面消费字段全部在增量 SQL 中' + (missing.length ? '（缺: ' + missing.join(',') + '）' : ''));

  // 4) mergeMatches 字段一致性：合并后每条记录的关键字段非 undefined
  if (direct.length && sqlRows.length) {
    const merged = inc.mergeMatches(direct.slice(0, 3), sqlRows.slice(0, 3));
    const allHaveKey = merged.every((m) => m.match_id != null && m.start_time != null && m.radiant_win !== undefined);
    ok(allHaveKey, 'mergeMatches 后关键字段齐全（match_id/start_time/radiant_win）');

    // player 专项：player_slot 必须有值（胜负判断依赖）
    if (resource === 'player') {
      const slotOk = merged.every((m) => m.player_slot !== undefined && m.player_slot !== null);
      ok(slotOk, 'player 合并后 player_slot 有值（胜负判断正确）');
    }
    // team 专项：opposing_team_name 应有值（JOIN teams 补全）
    if (resource === 'team') {
      const oppOk = merged.every((m) => m.opposing_team_name || m.opposing_team_id != null);
      ok(oppOk, 'team 合并后 opposing_team 信息存在');
    }
    // league 专项：增量 SQL 的队名应被 COALESCE 补全（非 null）；直连端点队名
    // 普遍为 null（OpenDota 未存），需页面 enrichTeamNames 用 getTeamNames 补全。
    if (resource === 'league') {
      const sqlNameOk = sqlRows.filter((m) => m.radiant_team_id).every((m) => m.radiant_team_name);
      ok(sqlNameOk, 'league 增量 SQL 的 radiant_team_name 已被 COALESCE 补全（不再 null）');
      const directNull = direct.filter((m) => m.radiant_team_id && !m.radiant_team_name).length;
      console.log('  (info) 直连端点队名为 null 的记录: ' + directNull + ' 条 → 由页面 enrichTeamNames + getTeamNames 补全');
      // 验证 getTeamNames 能补全这些 null 队名
      if (directNull > 0) {
        const nullIds = Array.from(new Set(
          direct.filter((m) => m.radiant_team_id && !m.radiant_team_name).map((m) => m.radiant_team_id)
        )).slice(0, 5);
        try {
          const nm = await j(BASE + '/explorer?sql=' + encodeURIComponent(
            'SELECT team_id, name FROM teams WHERE team_id IN (' + nullIds.join(',') + ')'
          ));
          const filled = ((nm.rows || []).filter((r) => r.name)).length;
          ok(filled > 0, 'getTeamNames 能补全直连端点的 null 队名（' + filled + '/' + nullIds.length + ' 命中）');
        } catch (e) { ok(false, 'getTeamNames SQL 报错: ' + e.message); }
      }
    }
  }
}

async function main() {
  console.log('端到端增量流程验证（联网）');

  // 找一个近期活跃的 leagueid
  let leagueId = 18959;
  try {
    const ex = await j(BASE + '/explorer?sql=' + encodeURIComponent(
      "SELECT leagueid FROM matches WHERE start_time > extract(epoch FROM now() - interval '60 day') GROUP BY leagueid ORDER BY count(*) DESC LIMIT 1"
    ));
    leagueId = (ex.rows && ex.rows[0] && ex.rows[0].leagueid) || leagueId;
  } catch (e) { /* 用默认 */ }

  await checkResource('LEAGUE', BASE + '/leagues/' + leagueId + '/matches', 'league', leagueId);
  await checkResource('TEAM', BASE + '/teams/10150538/matches', 'team', 10150538);
  await checkResource('PLAYER', BASE + '/players/70388657/matches?limit=20', 'player', 70388657);

  console.log('\n=== 结果 ===  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.log('FATAL ' + e.message); process.exit(1); });
