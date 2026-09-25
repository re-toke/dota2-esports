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
  let win, lose;
  if (rx !== ry) {
    win = (rx > ry) ? x : y;
    lose = (rx > ry) ? y : x;
  } else {
    const sx = (x.scoreA || 0) + (x.scoreB || 0), sy = (y.scoreA || 0) + (y.scoreB || 0);
    if (sx === sy) return x;
    win = (sx > sy) ? x : y;
    lose = (sx > sy) ? y : x;
  }
  // ★★ 2026-09-25（方案 1，用户拍板）：**合并而非二选一** —— 修「同一场对局两页口径矛盾」的首页半边。
  //   实测：首页已结束卡来自 LP 排期链路（本身无小场比分，比分依赖 absorbSettledGames 注入
  //   OpenDota 已结算局），EF 熔断窗口内注入失败 ⇒ 0:0；并存 live 卡却带比分（LP wikitext 的
  //   per-game 数据，不依赖 EF）⇒ 旧规则「保留 ended」把正确比分也丢了（详情页同场显示 1:2）。
  //   规则：胜者保留（状态/队伍/赛制等以**状态更可信**的卡为准）；**仅当**胜者无比分（总分 0）
  //   且败者有比分时，吸收败者的比分 —— 其余字段一律不动（宁少勿错）。
  //   ⚠️ 0:0 是合法比分（平局/未录入）⇒ 条件必须限定「败者总分 > 0」，否则会把真平局误当缺数据。
  //   ⚠️ 纯函数：返回**新对象**，不改写入参（本模块约定「只做纯计算」）。
  const wsum = (Number(win.scoreA) || 0) + (Number(win.scoreB) || 0);
  const lsum = (Number(lose.scoreA) || 0) + (Number(lose.scoreB) || 0);
  if (wsum === 0 && lsum > 0) {
    const sa = Number(lose.scoreA) || 0, sb = Number(lose.scoreB) || 0;
    const merged = Object.assign({}, win, { scoreA: sa, scoreB: sb });
    // 胜负标记必须与新比分一致（ended 卡通常无 games ⇒ 原 winA/winB 不可信，按比分重导）
    merged.winA = sa > sb;
    merged.winB = sb > sa;
    return merged;
  }
  return win;
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
