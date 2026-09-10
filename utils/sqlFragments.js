// utils/sqlFragments.js
// 纯 SQL 片段模块（无 wx 依赖、无 require），供 api.js 与云函数共享同一份 SQL 文本。
// 注意：云函数为独立部署单元，无法在部署时可靠地 require 本文件，
// 故 cloudfunctions/aggregation/index.js 顶部会复制同一常量并标注同步来源。

// 增加 max(start_time + duration) AS last_end：真实比赛结束时间（start_time 是开赛、duration 是时长）。
// 列表"进行中"判定需要真实结束时间，否则最后一场开赛后很久仍被误判为进行中。
//
// ★ v8.31（赛事页 4s 优化 · 修复 getLeagueWindows 500）：
//   原写法 `start_time > extract(epoch FROM now() - interval '6 months')` 是**函数表达式**，
//   Postgres 无法用 start_time 索引 → 全表扫描 matches → OpenDota explorer 14-16s 后
//   返回 `400 {"err":"Error: Query read timeout"}`。列表页 leagueWindows 长期静默降级为空对象
//   （日期范围不准），且 16s 超时还会拖长 EF 冷路径。
//   修复：① 窗口 6 个月 → 3 个月（列表页 normalizeLite 只关心近 90 天活跃 + curation 窗口，
//     90 天足够；更早赛事由 curation 赛期提供）；② 用**调用时算好的整数秒下界**内联进 SQL
//     （常量可走索引）。实测 16566ms/500 → 1215ms/200。
//   ⚠️ 因下界随调用时刻变化，本常量改为**函数**；api.js / EF / 云函数须同源调用
//     `LEAGUE_WINDOWS_SQL()`（保持 G14 双源镜像，禁再写死字符串）。
const WINDOW_DAYS = 90;

/**
 * 生成赛事时间窗口 SQL（下界 = 当前时刻 - 90 天，整数秒常量，可走索引）。
 * ★ v8.31（缓存 key 稳定性）：下界对齐到**当日 00:00 UTC**——若用实时 now-90d，
 *   每秒 SQL 文本都不同 → api 缓存 key / EF 缓存 key 每秒漂移 → 永远 miss
 *   （实测「source=fresh」永不命中）。对齐到日后 24h 内 SQL 恒定，缓存真正生效。
 * @param {number} [nowSec] 便于测试注入；默认取当前时刻
 * @returns {string}
 */
function LEAGUE_WINDOWS_SQL(nowSec) {
  const now = (typeof nowSec === 'number' && nowSec > 0) ? nowSec : Math.floor(Date.now() / 1000);
  const dayStart = Math.floor(now / 86400) * 86400;          // 当日 00:00 UTC
  const floor = dayStart - WINDOW_DAYS * 86400;
  return "SELECT leagueid, min(start_time) AS earliest, max(start_time) AS latest, " +
    "max(start_time + duration) AS last_end, count(*) AS n " +
    "FROM matches WHERE start_time > " + floor + " GROUP BY leagueid";
}

module.exports = { LEAGUE_WINDOWS_SQL: LEAGUE_WINDOWS_SQL, LEAGUE_WINDOWS_WINDOW_DAYS: WINDOW_DAYS };
