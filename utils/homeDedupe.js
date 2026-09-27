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
// ★★ 2026-09-26（P0-A）：判定输赢两卡的**主客序关系**（采纳比分前必须过这一关）。
//   为什么必须做：`_pairKeysOfCard` 正是为「**主客反相同键**」而设计 ——
//   说明"同一对局的两张卡主客相反"在本项目是**已知现实**；而 2026-09-25（`7da1161`）
//   的采纳逻辑**直接取 `scoreA/scoreB`** ⇒ 主客相反时会把比分**反向**（当时恰好同序才没出事）。
//
//   返回值语义（**只做正向确认，不推测**）：
//     false = 同序（可直接采纳）· true = 互换（采纳时需对调）· null = 无法判定（**不采纳**）
//   ⚠️ 判不出就返回 null —— 宁可保留 0:0（由 `utils/diagnostics.js` 的「已结束无比分率」暴露），
//      也不要凭空写一个可能反向的比分（错误比分比缺失比分更危险：用户无法察觉）。
function _swapAt(win, lose, loose) {
  const wa = _teamToken(win && win.teamA, loose), wb = _teamToken(win && win.teamB, loose);
  const la = _teamToken(lose && lose.teamA, loose), lb = _teamToken(lose && lose.teamB, loose);
  if (!wa || !wb || !la || !lb) return null;
  if (wa === la && wb === lb) return false;
  if (wa === lb && wb === la) return true;
  return null;
}
function _scoreSwap(win, lose) {
  // 先严格键（能吸收 `(page does not exist)` 类脏名），判不出再退宽松键
  const strict = _swapAt(win, lose, false);
  if (strict !== null) return strict;
  return _swapAt(win, lose, true);
}

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
    // ★★ 2026-09-26（P0-A）：**采纳前先归一主客序**（见上方 `_scoreSwap` 的说明）。
    //   主客相反的两卡若直接取 scoreA/scoreB，会把比分反向 —— 这是 `7da1161` 引入的隐患。
    const swap = _scoreSwap(win, lose);
    if (swap === null) return win;   // 无法判定 ⇒ 不采纳（宁缺勿错；由 SLO 指标暴露）
    const sa = Number(swap ? lose.scoreB : lose.scoreA) || 0;
    const sb = Number(swap ? lose.scoreA : lose.scoreB) || 0;
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


/**
 * ★★ 2026-09-27（P2-己 保守版）：首页空态引导 —— 选「最近的有比赛的其它日」。
 *
 * ## 为什么需要
 * `_renderWeek()` 的默认选中是**今天**，且**不判断今天有没有比赛**
 * ⇒ **今天 0 场时首屏就是空态**，而本周其实还有比赛（实测全周 23 张 / `_allMatches=53`）
 * ⇒ 用户会以为"首页没加载出来"。这与性能无关，是**口径/引导**问题。
 *
 * ## 规则
 * - 排除**当前日**与 `count <= 0` 的日子；
 * - 优先取**向后（未来）最近**的一天；没有则取**向前最近**的一天；
 *   （为什么优先向后：看首页多关心"接下来有什么"）
 * - 同时给出 `weekElsewhere` = 除当前日外本周的比赛数合计（供文案「本周还有 N 场」）。
 *
 * @param {Array} weekDays [{key,label,dateNum,count,isToday}]
 * @param {string} currentKey 当前选中日
 * @returns {{key:string,label:string,shortDate:string,count:number,weekElsewhere:number}|null}
 */
function _nearestDayWithMatches(weekDays, currentKey) {
  const days = Array.isArray(weekDays) ? weekDays : [];
  const cnt = (d) => (d && Number(d.count) > 0) ? Number(d.count) : 0;
  let weekElsewhere = 0;
  days.forEach(function (d) { if (d && d.key !== currentKey) weekElsewhere += cnt(d); });

  const idx = days.findIndex(function (d) { return d && d.key === currentKey; });
  const others = [];
  days.forEach(function (d, i) {
    if (!d || !d.key || d.key === currentKey || cnt(d) <= 0) return;
    others.push({ i: i, d: d });
  });
  if (!others.length) return null;

  const after = others.filter(function (o) { return o.i > idx; });
  const before = others.filter(function (o) { return o.i < idx; });
  const pick = after.length ? after[0] : before[before.length - 1];
  return {
    key: pick.d.key,
    label: pick.d.label || '',
    // ★ shortDate：由 key（'YYYY-MM-DD'）导出的 'M-D'。
    //   为什么需要：`label` 只是**星期几**（一/二/…），直接拼成「去看 二」语义不清（E2E 实测发现）；
    //   且星期几**跨周会重复** ⇒ 用日期更明确。
    shortDate: _shortDate(pick.d.key),
    count: cnt(pick.d),
    weekElsewhere: weekElsewhere
  };
}

/** 'YYYY-MM-DD' → 'M-D'（非法输入返回 ''，由调用方回退 label） */
function _shortDate(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
  if (!m) return '';
  return Number(m[2]) + '-' + Number(m[3]);
}

/**
 * ★★ 2026-09-27（修复「同一对队多次交手 ⇒ 重复卡」）：从候选卡里按 **start 就近** 选一张。
 *
 * ## 背景（实测根因）
 * 首页「同一对局卡片合并」原实现用 `pairIndex[键] = 卡`（**单卡**），且"超窗不合并"分支会把它
 * **改写成最新卡** ⇒ 后续本应就近配对的卡**比错了对象**：
 * 实测 LGD vs NAVI 有 **09-24** 与 **09-27** 两场（同一对队、相隔 71.4h）；
 * 处理 09-27 的 LP 卡时 `hit` 变成了 09-24 那张 ⇒ 差 68.6h > 12h ⇒ **误判为不同对局** ⇒ 漏合并 ⇒ **两张卡并存**。
 *
 * ## 规则
 * - 在所有候选里取 `|candidate.start - target.start|` **最小**的那张；
 * - 若最小差值 > `windowSec`（12h，防"同日两次交手"被误并）⇒ 返回 null（**不合并**）。
 *
 * @param {Array} candidates 已入表的候选卡
 * @param {Object} target 待判定卡
 * @param {number} windowSec 视为"同一对局"的最大 start 差（秒）
 * @returns {{hit:Object, diff:number}|null}
 */
function _nearestByStart(candidates, target, windowSec) {
  const cs = Array.isArray(candidates) ? candidates : [];
  if (!target || !cs.length) return null;
  const t = Number(target.start) || 0;
  let hit = null; let diff = 0;
  for (let i = 0; i < cs.length; i++) {
    const x = cs[i];
    if (!x) continue;
    const d = Math.abs((Number(x.start) || 0) - t);
    if (hit === null || d < diff) { hit = x; diff = d; }
  }
  if (!hit) return null;
  const w = (typeof windowSec === 'number' && windowSec >= 0) ? windowSec : 12 * 3600;
  if (diff > w) return null;
  return { hit: hit, diff: diff };
}

module.exports = {
  pairKeysOfCard: _pairKeysOfCard,
  teamToken: _teamToken,
  preferSameMatchCard: _preferSameMatchCard,
  homePassGrade: _homePassGrade,
  nearestDayWithMatches: _nearestDayWithMatches,
  nearestByStart: _nearestByStart
};
