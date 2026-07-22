// utils/incremental.js
// 比赛列表「增量拉取」的纯函数（不依赖 wx / 网络），可被 Node 单测直接 require。
// 设计：以 start_time 为游标，在「陈旧但未过期」的后台刷新阶段，只向 OpenDota
// /explorer 拉取比本地缓存最新一场更晚的比赛，按 match_id 去重并入缓存头部，
// 从而显著降低大列表（尤其选手数千场历史）的重拉成本与流量。
//
// ★ 字段对齐契约（极其重要）★
// 增量 SQL 选用的字段名必须与「直连端点」返回的字段名完全一致，否则增量合并后
// 新比赛与旧比赛字段结构错位，会导致页面渲染缺字段/错位/胜负反转。
//
// 经 OpenDota /explorer 实测（2026-07）：
//   - matches 表无 radiant_name / dire_name / radiant 字段；队名字段为
//     radiant_team_name / dire_team_name，且值常为 null（需 LEFT JOIN teams 用
//     COALESCE 补全）。
//   - 不存在 team_match_history 视图（早期 SQL 误用导致 400）；team 增量改用
//     matches 表 + CASE 计算该队视角的 opposing_team_id / opposing_team_name，
//     并用 (radiant_team_id = {id}) AS radiant 复刻直连端点的 radiant 布尔。
//   - player_matches 视图只含玩家级字段，match 级字段（duration / start_time /
//     radiant_win / league_name）需 JOIN matches + LEFT JOIN leagues；player_slot
//     必须选出（胜负判断依赖它）。

// 取列表中最新的 start_time（unix 秒），无有效值则返回 0。
function maxStart(list) {
  let max = 0;
  (list || []).forEach(function (m) {
    const t = Number(m && m.start_time) || 0;
    if (t > max) max = t;
  });
  return max;
}

// 将增量 delta 按 match_id 去重并入旧列表头部（delta 已按时间倒序）。
function mergeMatches(oldList, delta) {
  const old = oldList || [];
  const seen = {};
  old.forEach(function (m) { if (m && m.match_id != null) seen[m.match_id] = true; });
  const fresh = (delta || []).filter(function (m) {
    return m && m.match_id != null && !seen[m.match_id];
  });
  return fresh.concat(old);
}

// 数字化 id（防 SQL 注入；非法值归 0，由 SQL 层返回空集而非报错）
function numId(id) {
  const n = Number(id);
  return isNaN(n) ? 0 : n;
}

// 构造按游标增量查询的 SQL（OpenDota /explorer）。
// resource: 'league' | 'team' | 'player'；cursor 为起始 start_time。
// 返回的行字段名与对应「直连端点」保持一致，确保 mergeMatches 后字段结构统一。
function buildMatchSql(resource, id, cursor) {
  const c = Number(cursor) || 0;
  const tid = numId(id);

  if (resource === 'league') {
    // 直连端点 /leagues/{id}/matches 字段：
    //   match_id, radiant_win, start_time, duration, leagueid, radiant_score, dire_score,
    //   radiant_team_id, radiant_team_name, dire_team_id, dire_team_name, series_id, series_type
    // matches 表 radiant_team_name/dire_team_name 常为 null → LEFT JOIN teams 用 COALESCE 补全。
    return 'SELECT m.match_id, m.start_time, m.duration, m.radiant_win, ' +
      'm.radiant_team_id, m.dire_team_id, ' +
      'COALESCE(m.radiant_team_name, tr.name) AS radiant_team_name, ' +
      'COALESCE(m.dire_team_name, td.name) AS dire_team_name, ' +
      'm.radiant_score, m.dire_score ' +
      'FROM matches m ' +
      'LEFT JOIN teams tr ON m.radiant_team_id = tr.team_id ' +
      'LEFT JOIN teams td ON m.dire_team_id = td.team_id ' +
      'WHERE m.leagueid = ' + tid + ' AND m.start_time >= ' + c +
      ' ORDER BY m.start_time DESC LIMIT 200';
  }

  if (resource === 'team') {
    // 直连端点 /teams/{id}/matches 字段（从该队视角）：
    //   match_id, radiant_win, radiant_score, dire_score, radiant(该队是否天辉), duration,
    //   start_time, leagueid, league_name, cluster, opposing_team_id, opposing_team_name, opposing_team_logo
    // 不存在 team_match_history 视图；用 matches 表 + CASE 计算该队视角的 opposing_*。
    return 'SELECT m.match_id, m.start_time, m.radiant_win, m.radiant_score, m.dire_score, ' +
      '(m.radiant_team_id = ' + tid + ') AS radiant, ' +
      'CASE WHEN m.radiant_team_id = ' + tid + ' THEN m.dire_team_id ELSE m.radiant_team_id END AS opposing_team_id, ' +
      'CASE WHEN m.radiant_team_id = ' + tid + ' THEN COALESCE(m.dire_team_name, td.name) ELSE COALESCE(m.radiant_team_name, tr.name) END AS opposing_team_name, ' +
      'l.name AS league_name, m.duration ' +
      'FROM matches m ' +
      'LEFT JOIN teams tr ON m.radiant_team_id = tr.team_id ' +
      'LEFT JOIN teams td ON m.dire_team_id = td.team_id ' +
      'LEFT JOIN leagues l ON m.leagueid = l.leagueid ' +
      'WHERE (m.radiant_team_id = ' + tid + ' OR m.dire_team_id = ' + tid + ') AND m.start_time >= ' + c +
      ' ORDER BY m.start_time DESC LIMIT 200';
  }

  // player
  // 直连端点 /players/{id}/matches 字段：
  //   match_id, player_slot, radiant_win, duration, game_mode, lobby_type, hero_id, start_time,
  //   version, kills, deaths, assists, average_rank, leaver_status, party_size, hero_variant
  //   （注意：直连端点无 league_name）
  // player_matches 视图只含玩家级字段，match 级字段需 JOIN matches；league_name 需 JOIN leagues。
  // ★ 必须选出 player_slot，否则 util.playerWon() 胜负判断恒错（undefined < 128 = false）。
  return 'SELECT pm.match_id, pm.player_slot, pm.hero_id, pm.kills, pm.deaths, pm.assists, ' +
    'm.duration, m.start_time, m.radiant_win, l.name AS league_name ' +
    'FROM player_matches pm ' +
    'JOIN matches m ON pm.match_id = m.match_id ' +
    'LEFT JOIN leagues l ON m.leagueid = l.leagueid ' +
    'WHERE pm.account_id = ' + tid + ' AND m.start_time >= ' + c +
    ' ORDER BY m.start_time DESC LIMIT 200';
}

module.exports = { maxStart: maxStart, mergeMatches: mergeMatches, buildMatchSql: buildMatchSql };
