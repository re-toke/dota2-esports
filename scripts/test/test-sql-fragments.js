'use strict';
/**
 * scripts/test/test-sql-fragments.js
 * 2026-11-15：赛事列表「正赛口径组数」相关 SQL 片段的纯函数测试。
 *
 * 背景：列表卡面场次原本是 explorer `count(*)`（含 Play-In/海选），与详情页「正赛 N 组」矛盾。
 *   现在 windows SQL 增加 `count(DISTINCT series_id) AS sn`，并对「同一 leagueid 混有预选赛」
 *   的少数赛事追加一次条件计数（LEAGUE_MAIN_COUNTS_SQL）。
 *   本用例守住三件事：① sn 字段仍在；② 非法 plan 被丢弃（防 SQL 注入）；③ 条数上限。
 */
const sqlFragments = require('../../utils/sqlFragments.js');

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('PASS  ' + msg); }
  else { fail++; console.log('FAIL  ' + msg); }
}

const NOW = 1794729600; // 2026-11-15 00:00:00 UTC

// ① windows SQL：必须是整数秒下界 + 含 sn（组数）
(function () {
  const sql = sqlFragments.LEAGUE_WINDOWS_SQL(NOW);
  ok(/count\(DISTINCT COALESCE\(series_id, -match_id\)\) AS sn/.test(sql), '① windows SQL 含 COALESCE 版组数（null series_id 不漏计）');
  ok(/count\(\*\) AS n/.test(sql), '① windows SQL 仍保留 count(*) AS n');
  const floor = Math.floor(NOW / 86400) * 86400 - 90 * 86400;
  ok(sql.indexOf('start_time > ' + floor) >= 0, '① 下界为对齐到日的整数常量（可走索引）');
})();

// ② 正赛计数 SQL：按 leagueid + 正赛起点条件计数
(function () {
  const sql = sqlFragments.LEAGUE_MAIN_COUNTS_SQL([
    { leagueid: 20486, fromSec: 1794441600 },
    { leagueid: 20009, fromSec: 1785369600 }
  ], NOW);
  ok(!!sql, '② 有效 plans → 生成 SQL');
  ok(/\(leagueid = 20486 AND start_time >= 1794441600\)/.test(sql), '② 含 leagueid 20486 的正赛条件');
  ok(/\(leagueid = 20009 AND start_time >= 1785369600\)/.test(sql), '② 含 leagueid 20009 的正赛条件');
  ok(/GROUP BY leagueid/.test(sql), '② 按 leagueid 聚合');
  ok(/count\(DISTINCT COALESCE\(series_id, -match_id\)\) AS sn/.test(sql), '② 输出组数 sn（COALESCE 兜底 null series_id）');
})();

// ③ 输入防护：非法值丢弃、同 id 去重、超上限截断
(function () {
  ok(sqlFragments.LEAGUE_MAIN_COUNTS_SQL([]) === null, '③ 空数组 → null（调用方不发请求）');
  ok(sqlFragments.LEAGUE_MAIN_COUNTS_SQL(null) === null, '③ null → null');
  ok(sqlFragments.LEAGUE_MAIN_COUNTS_SQL([
    { leagueid: 0, fromSec: 1794441600 },
    { leagueid: -1, fromSec: 1794441600 },
    { leagueid: 20486, fromSec: 0 },
    { leagueid: '20486; DROP TABLE matches', fromSec: 1794441600 }
  ], NOW) === null, '③ 非法/注入型输入 → 全部丢弃（返回 null）');

  const dup = sqlFragments.LEAGUE_MAIN_COUNTS_SQL([
    { leagueid: 20486, fromSec: 1794441600 },
    { leagueid: '20486', fromSec: 1794441600 }
  ], NOW);
  ok(dup && (dup.match(/leagueid = 20486/g) || []).length === 1, '③ 同 leagueid 去重（只出现一次）');

  const many = [];
  for (let i = 1; i <= 40; i++) many.push({ leagueid: 30000 + i, fromSec: 1794441600 });
  const capped = sqlFragments.LEAGUE_MAIN_COUNTS_SQL(many, NOW);
  ok(capped && (capped.match(/leagueid = /g) || []).length === 25, '③ 上限 25 条（防 SQL 过长）');
})();

// ④ G14 双源镜像：EF（opendota-proxy）的 SQL 必须与 utils/sqlFragments.js 同源
//   ★ 2026-11-15：此前只有人工注释「保持同源」，无自动守卫 ⇒ 改一边漏另一边查不出。
(function () {
  const fs = require('fs');
  const path = require('path');
  const ef = fs.readFileSync(path.join(__dirname, '..', '..',
    'supabase', 'functions', 'opendota-proxy', 'index.ts'), 'utf8');
  const own = fs.readFileSync(path.join(__dirname, '..', '..', 'utils', 'sqlFragments.js'), 'utf8');
  [
    'count(DISTINCT COALESCE(series_id, -match_id)) AS sn',
    'max(start_time + duration) AS last_end',
    'count(*) AS n'
  ].forEach(function (frag) {
    ok(ef.indexOf(frag) >= 0, '④ EF 镜像含关键片段：' + frag);
  });
  ok(ef.indexOf('LEAGUE_WINDOWS_WINDOW_DAYS = 90') >= 0, '④ EF 窗口天数常量 = 90');
  ok(own.indexOf('const WINDOW_DAYS = 90;') >= 0, '④ 客户端窗口天数常量 = 90');
  ok(ef.indexOf('const floor = dayStart - LEAGUE_WINDOWS_WINDOW_DAYS * 86400;') >= 0 &&
     own.indexOf('const floor = dayStart - WINDOW_DAYS * 86400;') >= 0,
    '④ 两侧下界公式同源（按日对齐的整数秒，可走索引）');
})();

console.log('\n=== 结果 ===');
console.log('通过: ' + pass + '  失败: ' + fail);
if (fail) {
  console.log('存在失败 ❌');
  process.exit(1);
}
console.log('全部通过 ✅');
