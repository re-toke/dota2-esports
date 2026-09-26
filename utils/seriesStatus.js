// utils/seriesStatus.js
// ★★ 2026-09-26（P0-A 第 1 步 / 服务于 P0-B）：**系列终局判据的唯一纯实现**。
//
// 为什么要有它（P0-A「权威判据层」的核心）：
//   实测「比分达 BO 上限」这条判据在仓库里**分散在约 10 处**（`utils/sources.js` 8 处 +
//   `pages/index/index.js` 的 `_cardFromSeries` + `subpackages/detail/league-detail` 的
//   `_decidedByScore`），且**各自口径略有差异** —— 这正是"N 层启发式互搏"的温床：
//   09-23 那次修复只改了其中 1 处（`isLive` 字段），而**分段 / 徽标 / statusText 三处没改**，
//   于是同一场对局在首页与详情页给出互相矛盾的状态（1:2 BO3 却被挂在「进行中」）。
//
// 本模块**只做纯计算**（不碰 wx / this / setData）⇒ 客户端与 CI(Node) 共用同一口径。
// ⚠️ P0-A 的后续工作：把上述 ~10 处调用点逐步改指向本模块（保守推进：先替换语义等价点）。
'use strict';

/**
 * 该系列是否**已由比分判定终局**（与来源 phase、BO 推导均无关）。
 *
 * 规则（与既有实现逐字对齐，收敛而来）：
 *   · BO5 / BO2 的 2 胜 **不足以**终局 ⇒ 一律返回 false（宁漏勿错）
 *   · 其余（BO3 / BO1 / 未知）：`max(scoreA, scoreB) >= 2`
 *       - BO3：2 胜 ⇒ 必然终局 ✓
 *       - BO1：比分上限为 1 ⇒ 永不命中 ✓（不会误杀）
 *       - 未知 BO：保守按"至少 2 胜 ⇒ 已打完"处理（与 index.js 原实现一致）
 *
 * @param {number|string} scoreA 系列胜局（非击杀数）
 * @param {number|string} scoreB 系列胜局
 * @param {string} [boType] 'BO1'|'BO2'|'BO3'|'BO5'|undefined
 * @returns {boolean}
 */
function isDecidedByScore(scoreA, scoreB, boType) {
  if (boType === 'BO5' || boType === 'BO2') return false;
  var a = Number(scoreA) || 0;
  var b = Number(scoreB) || 0;
  return Math.max(a, b) >= 2;
}

/**
 * 该系列是否**正处于 LIVE 残留**：来源报 live，但比分已达终局。
 * 供采集/诊断统计「状态误判」用（UI 侧的正常化见 index / league-detail 的 phase 归一）。
 * @returns {boolean}
 */
function isStaleLiveByScore(status, scoreA, scoreB, boType) {
  return status === 'live' && isDecidedByScore(scoreA, scoreB, boType);
}

// ===== 收敛清单（2026-09-26，可审计）=====
//
// ✅ **已收敛到本模块**（语义等价，逐字对齐）：
//   1. `pages/index/index.js` 的 `_cardFromSeries`（首页「比分达终局 → 状态修正为 ended」）
//   2. `subpackages/detail/league-detail/league-detail.js` 的 `_decidedByScore`（本页只保留日志包装）
//   3. `utils/sources.js` 的 `_orphanPairMerge` 内「非完整终局不并」（原 `max < 2` ⇒ 传 undefined 等价）
//
// ⛔ **刻意不收敛**（名字像、**语义不同** —— 收敛会改变行为，故本次不动；列此备查）：
//   · `sources.js` ≈1355 `_seriesStillGoing`：用 **BO 局数阈值**（`ceil(boNum/2)`）且先看 `games.length`
//     ⇒ 比"2 胜"更精细，且依赖 boNum ⇒ 不等价
//   · `sources.js` ≈1481 `maxSc` + `BO_LIMIT`：**越界回滚**（约束⑤），用 BO 上限表判定"比分越界"
//   · `sources.js` ≈1673 / ≈2251 `maxScore >= 3 → BO5`：**BO 制式推导**，不是状态判定
//   · `sources.js` ≈1695：变量定义（供后续逻辑），非判据
//   · `league-detail.js` ≈1139「④ 系列比分未达 BO 上限」：用 `boGames` 的**另一套表述**
//     （09-23 注释已指出它"依赖 BO 推导，一旦偏大即失效"）⇒ 后续可评估收敛，但**本次不等价，不动**
//
// ★ 纪律：**收敛只做"语义等价点"**；形态相似但语义不同的，宁可留注释备案，也不要"看起来统一了"却改了行为。
module.exports = {
  isDecidedByScore: isDecidedByScore,
  isStaleLiveByScore: isStaleLiveByScore
};
