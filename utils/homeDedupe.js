// utils/homeDedupe.js
// ★★ 2026-09-25：从 `pages/index/index.js` **整段搬出**的纯函数（逐字未改逻辑），目的：
//   ① 让「同一对局合并」「首页可见级别过滤」这类**承载正确性**的逻辑**可被测试**（此前是页面私有 ✗）；
//   ② 与项目约定一致——页面层逻辑尽量抽纯函数（页面层零测试是最大盲区）。
//   ⚠️ 归一化一律走 utils/names.js 单一实现（test-sources 有「禁止内联」守卫 ✓）。
//   ⚠️ 本模块**只做纯计算**：不碰 wx / this / setData，便于单测。
const names = require('./names.js');

function _pairKeysOfCard(c) {
  const a1 = _teamToken(c && c.teamA, false), b1 = _teamToken(c && c.teamB, false);
  const a2 = _teamToken(c && c.teamA, true),  b2 = _teamToken(c && c.teamB, true);
  const out = [];
  if (a1 && b1) out.push((a1 < b1) ? (a1 + '|' + b1) : (b1 + '|' + a1));
  if (a2 && b2) { const k = (a2 < b2) ? (a2 + '|' + b2) : (b2 + '|' + a2); if (out.indexOf(k) < 0) out.push(k); }
  return out;
}
function _teamToken(t, loose) {
  if (!t) return '';
  // ★★ 2026-09-23（**基于线上真字段定位**）：上游 LP/LPDB 路径会把**查询失败的文案**混进队名 ——
  //   实测（用户 Console 诊断）：`Conventus Stellarum (page does not exist)` ✗
  //   ⇒ 归一化后成 `conventusstellarumpagedoesnotexist`，**与干净队名永远算不出同一个键** ✗
  //   ⇒ 这正是「同一对局两张卡」合并失效的真正成因（此前两版都栽在这里）。
  //   先剔除该文案，再去掉尾部括号补充（`(page does not exist)` / `(Peru)` 这类），最后才归一化。
  const nm = names.sanitizeTeamName(t.name || t.tag || '');
  const norm = loose ? names.normTeamNameLoose(nm) : names.normAsciiKey(nm);
  if (norm) return norm;
  return t.id ? ('#' + t.id) : '';
}
// ★ 2026-09-25：原本地 _stripLpNoise 已收敛到 utils/names.js 的单一实现（sanitizeTeamName）
//   —— 避免「同一清洗规则两处实现」再次漂移（与本项目 names.js 归一化守卫同一教训）。
function _preferSameMatchCard(x, y) {
  const rank = (c) => (c.status === 'ended' ? 3 : (c.status === 'upcoming' ? 1 : 2));
  const rx = rank(x), ry = rank(y);
  if (rx !== ry) return rx > ry ? x : y;
  const sx = (x.scoreA || 0) + (x.scoreB || 0), sy = (y.scoreA || 0) + (y.scoreB || 0);
  if (sx !== sy) return sx > sy ? x : y;
  return x;
}

function _homePassGrade(c) {
  if (!c || !c.tier) return false;
  const g = c.tier.grade;
  return g === 'S' || g === 'A';
}


module.exports = {
  pairKeysOfCard: _pairKeysOfCard,
  teamToken: _teamToken,
  preferSameMatchCard: _preferSameMatchCard,
  homePassGrade: _homePassGrade
};
