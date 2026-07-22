// scripts/test-incremental.js
// 增量拉取纯函数单测（不联网、不需 wx）。
'use strict';

const inc = require('../utils/incremental.js');

let passed = 0;
let failed = 0;
function check(label, fn) {
  try { fn(); passed++; console.log('PASS  ' + label); }
  catch (e) { failed++; console.log('FAIL  ' + label + '  ->  ' + e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

// ===== maxStart =====
check('maxStart: 空列表返回 0', () => assert(inc.maxStart([]) === 0));
check('maxStart: 取最大 start_time', () =>
  assert(inc.maxStart([{ start_time: 100 }, { start_time: 300 }, { start_time: 200 }]) === 300));
check('maxStart: 忽略非法值', () =>
  assert(inc.maxStart([{ start_time: 'x' }, { start_time: 50 }]) === 50));
check('maxStart: 容忍 null / undefined 元素', () =>
  assert(inc.maxStart([null, { start_time: 10 }, undefined]) === 10));

// ===== mergeMatches =====
const old = [{ match_id: 1, start_time: 100 }, { match_id: 2, start_time: 90 }];
check('merge: 仅并入去重后的新比赛，新者在头部', () => {
  const delta = [{ match_id: 3, start_time: 200 }, { match_id: 1, start_time: 100 }]; // 1 已存在应被忽略
  const m = inc.mergeMatches(old, delta);
  assert(m.length === 3, 'len=' + m.length);
  assert(m[0].match_id === 3, '新比赛应在头部');
  assert(m[1].match_id === 1 && m[2].match_id === 2, '旧顺序保持');
});
check('merge: 旧为空时直接返回 delta', () => {
  const m = inc.mergeMatches([], [{ match_id: 5, start_time: 1 }]);
  assert(m.length === 1 && m[0].match_id === 5);
});
check('merge: delta 为空时返回旧', () => {
  const m = inc.mergeMatches(old, []);
  assert(m.length === 2);
});

// ===== buildMatchSql =====
// 修复后：三个 SQL 均用真实表/视图 + JOIN 补全字段，且字段名与直连端点对齐。
check('sql: league 用 matches 表 + JOIN teams 补队名 + leagueid + 游标 + 倒序 + 限量', () => {
  const s = inc.buildMatchSql('league', 123, 1000);
  assert(s.indexOf('FROM matches') >= 0, '表名');
  assert(s.indexOf('LEFT JOIN teams tr') >= 0, 'JOIN teams 补队名');
  assert(s.indexOf('leagueid = 123') >= 0, '条件');
  assert(s.indexOf('start_time >= 1000') >= 0, '游标');
  assert(s.indexOf('ORDER BY m.start_time DESC') >= 0, '排序');
  assert(s.indexOf('LIMIT 200') >= 0, '限量');
});

check('sql: team 用 matches 表 + CASE 计算 opposing（不再用不存在的 team_match_history）', () => {
  const s = inc.buildMatchSql('team', 9, 500);
  assert(s.indexOf('FROM matches') >= 0, '用 matches 表');
  assert(s.indexOf('team_match_history') < 0, '不得再用不存在的 team_match_history 视图');
  assert(s.indexOf('opposing_team_id') >= 0, 'opposing_team_id（与直连端点对齐）');
  assert(s.indexOf('opposing_team_name') >= 0, 'opposing_team_name');
  assert(s.indexOf('(m.radiant_team_id = 9) AS radiant') >= 0, 'CASE 计算 radiant 布尔');
  assert(s.indexOf('league_name') >= 0, 'league_name');
});

check('sql: player 用 player_matches JOIN matches JOIN leagues + 必选 player_slot', () => {
  const s = inc.buildMatchSql('player', 888, 0);
  assert(s.indexOf('FROM player_matches') >= 0, 'player_matches 视图');
  assert(s.indexOf('JOIN matches m') >= 0, 'JOIN matches 补 match 级字段');
  assert(s.indexOf('LEFT JOIN leagues l') >= 0, 'JOIN leagues 补 league_name');
  assert(s.indexOf('account_id = 888') >= 0, '条件');
  assert(s.indexOf('player_slot') >= 0, '必选 player_slot（胜负判断依赖）');
  assert(s.indexOf('radiant_win') >= 0, 'radiant_win（来自 matches）');
});

check('sql: cursor=0 仍生成合法 >=0 条件', () => {
  const s = inc.buildMatchSql('league', 1, 0);
  assert(s.indexOf('start_time >= 0') >= 0);
});

// ★ 字段对齐契约 ★ 增量 SQL 选出的字段名必须与直连端点一致，
// 否则 mergeMatches 后新旧比赛字段结构错位，导致缺字段/胜负反转。
check('契约: league SQL 字段名与直连端点 /leagues/{id}/matches 对齐', () => {
  const s = inc.buildMatchSql('league', 1, 0);
  assert(s.indexOf('radiant_team_name') >= 0, 'radiant_team_name（非 radiant_name）');
  assert(s.indexOf('dire_team_name') >= 0, 'dire_team_name（非 dire_name）');
  assert(s.indexOf('radiant_name') < 0, '不得用 matches 表不存在的 radiant_name');
  // matches 表无 radiant 布尔字段，league 直连端点也无；league-detail fmt 不需要 radiant 布尔
});

check('契约: team SQL 字段名与直连端点 /teams/{id}/matches 对齐', () => {
  const s = inc.buildMatchSql('team', 1, 0);
  assert(s.indexOf('opposing_team_id') >= 0, 'opposing_team_id（非 opponent_team_id）');
  assert(s.indexOf('opposing_team_name') >= 0, 'opposing_team_name（非 opponent_team_name）');
  assert(s.indexOf('opponent_team') < 0, '不得用 opposing 的旧拼写 opponent_team');
});

check('契约: player SQL 必含 player_slot（util.playerWon 胜负判断依赖）', () => {
  const s = inc.buildMatchSql('player', 1, 0);
  assert(s.indexOf('player_slot') >= 0, '缺 player_slot 会导致 undefined<128=false，胜负反转');
});

// 数字化防注入：非法 id 归 0（SQL 返回空集而非报错/注入）
check('防护: 非数字 id 归 0', () => {
  const s = inc.buildMatchSql('league', 'abc; DROP', 0);
  assert(s.indexOf('leagueid = 0') >= 0, '非法 id 应归 0');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
