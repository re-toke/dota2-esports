// utils/names.js
// ============================================================================
// 名称归一化的**单一实现**（2026-09-20 抽取）。
//
// ## 为什么需要这个模块
// 「小写 + 去非字母数字」这条规则在仓库里被**内联复制了 19 次**，且分属两个**不同语义**的命名空间：
//   · **队名**（team name）—— 必须与 `scripts/sync/fetch-team-logos.js` 生成的快照键
//     （`team-logo-local-data.js` 的 byName）**逐字一致**，否则 logo 精确键永远 miss；
//   · **赛事名的「叶子」键**（league key leaf）—— 供 `league-canon-map` 的静态映射查表使用。
// 各处散布实现 + 仅靠注释约定「要与 XX 保持一致」→ 一旦任一处漂移就静默失效
//   （实测教训：`replace(/\s+/g,'')` 与 `replace(/[^a-z0-9]/g,'')` 不一致导致
//    "Pipsqueak + 4" → `pipsqueak+4` ≠ 快照键 `pipsqueak4`，整队 logo 全 miss）。
//
// ## ⚠️ 不要用 leagueKey / leagueBaseName 替代本模块
// 本项目「赛事名」有**语义级**归一化（`sources.leagueBaseName` → 剥阶段后缀 + 查 curation 规范名），
// 它与本模块的「**形状级**去符号」是两件事：
//   ① 队名用 leagueKey 会被剥掉 "Team/Eagles" 之类的后缀并触发 curation 查表 → **误配**；
//   ② `league-canon-map` 是 `canonicalLeagueName` 的**下游叶子**，若它改用 `leagueKey`，
//      会形成 `canonicalLeagueName → resolveCanonical → leagueKey → leagueBaseName →
//      canonicalLeagueName` 的**无限递归**。
//   ⇒ 本模块是「形状归一化」的唯一出口；语义归一化请用 `sources.leagueKey`。
//
// ## 无依赖
// 刻意保持零 `require`，避免与 `sources.js` / `consensus.js` 形成循环依赖。
// ============================================================================

/**
 * 形状归一（叶子规则）：小写 + 去掉所有非 ASCII 字母数字字符。
 *
 * ★ 这是全仓库**唯一**允许出现该规则的地方。新增用途请 import 本函数，
 *   不要再内联 `String(x).toLowerCase().replace(/[^a-z0-9]/g, '')`。
 *
 * ⚠️ 刻意**不保留** CJK / 西里尔字母（与 `consensus.normName` 不同）——
 *   因为队名快照键是按此规则生成的，改动会让既有快照键全部失配。
 *   中文队名（如「天辉」「夜魇」）归一到空串，由调用方按占位名特判（见各处 天辉/夜魇 判断）。
 *
 * @param {*} s
 * @returns {string}
 */
function normAsciiKey(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * 队名归一 —— 语义别名，等价于 `normAsciiKey`。
 * 单独命名是为了让调用点自解释（`normTeamName(t.name)` 比 `normAsciiKey(...)` 更明确），
 * 同时把「队名归一」的改动收口到一处。
 *
 * 契约（改动前必须同步 `scripts/sync/fetch-team-logos.js` 的键生成并**重新生成快照**）：
 *   · "Pipsqueak + 4" → "pipsqueak4"
 *   · "Level UP esports" → "levelupesports"（后缀剥离由调用方另行处理）
 *   · "Чемпионат Москвы" → ""（非 ASCII 被去除）
 *   · "天辉" / "夜魇" → ""（占位名，调用方需特判）
 */
function normTeamName(s) {
  return normAsciiKey(s);
}

/**
 * 队名归一 + 剥离常见战队后缀（esports/gaming/team/club/gg…）。
 * 用途：跨源队名比对的**兜底**匹配（"Level UP esports" 剥离后 = "levelup" 可直接命中简称）。
 * ⚠️ 仅用于兜底链路；精确匹配仍应先比 `normTeamName` 的原值。
 */
const TEAM_SUFFIX_RE = /(esports|esport|gaming|team|club|dota)$/;
function normTeamNameLoose(s) {
  return normAsciiKey(s).replace(TEAM_SUFFIX_RE, '');
}

module.exports = {
  normAsciiKey: normAsciiKey,
  normTeamName: normTeamName,
  normTeamNameLoose: normTeamNameLoose,
  TEAM_SUFFIX_RE: TEAM_SUFFIX_RE
};
