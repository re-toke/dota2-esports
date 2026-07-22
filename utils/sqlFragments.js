// utils/sqlFragments.js
// 纯 SQL 片段模块（无 wx 依赖、无 require），供 api.js 与云函数共享同一份 SQL 文本。
// 注意：云函数为独立部署单元，无法在部署时可靠地 require 本文件，
// 故 cloudfunctions/aggregation/index.js 顶部会复制同一常量并标注同步来源。

const LEAGUE_WINDOWS_SQL = "SELECT leagueid, min(start_time) AS earliest, max(start_time) AS latest, count(*) AS n FROM matches WHERE start_time > extract(epoch FROM now() - interval '1 year') GROUP BY leagueid";

module.exports = { LEAGUE_WINDOWS_SQL: LEAGUE_WINDOWS_SQL };
