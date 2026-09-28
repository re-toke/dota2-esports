// utils/followBatch.js
// 首页「关注战队」批量取数的**纯逻辑**（2026-09-27 · P0-新增）。
//
// ## 为什么抽出来
// 页面层零测试是本项目最大盲区（见记忆）；这批逻辑恰好是**三态判定 + 合并 + 分批编组**，
// 完全可以做成纯函数 ⇒ 用单测锁住，避免又一处"只在真机上才发现"的静默行为。
//
// ## 修的是什么（实测背景）
// `pages/index/index.js` 原实现在取数失败时 `.catch(() => ({ t, ms: [] }))`
// —— 把**失败伪装成"没有比赛"**，于是失败的关注战队**无卡片、无提示**地消失，
// 而 `followLoading: false` 还会**掩盖**它（用户只看到"关注了却少几张"）。
// 实测：注入 15 个关注战队，首页只出 6~10 张，且**两次运行结果不一致**。
//
// ⇒ 三态：`ok === true` 成功 / `ok === false` 失败（`ms` 仍给 `[]`，**卡片构建逻辑完全不变**）。
//   ★ 注意：`ms: []` 是刻意的 —— 让"失败"与"确实没有比赛"在**展示层同形**（都无卡），
//     但**在数据层可区分**，从而能重试、能计数、能提示。展示层是否要区分由调用方决定。

'use strict';

/** 取失败的条目 */
function failedOf(rows) {
  return (Array.isArray(rows) ? rows : []).filter(function (r) { return r && r.ok === false; });
}

/** 取成功的条目 */
function okOf(rows) {
  return (Array.isArray(rows) ? rows : []).filter(function (r) { return r && r.ok !== false; });
}

/**
 * 把「重试结果」合并回原数组：**按 team id 就地替换**，保持原顺序。
 * 为什么按 id 而非下标：重试只针对失败子集，下标不对齐；
 * 且保持原顺序可避免关注卡顺序抖动（用户可感知）。
 * ★ 只有 `ok === true` 的重试结果才替换 —— 重试仍失败时保留原条目（不把失败又洗成"看起来成功"）。
 * @param {Array} rows 原数组
 * @param {Array} again 重试返回的数组
 * @returns {Array} 新数组（不改原数组）
 */
function mergeRetried(rows, again) {
  const src = Array.isArray(rows) ? rows : [];
  const byId = {};
  (Array.isArray(again) ? again : []).forEach(function (r) {
    if (r && r.t && r.ok === true) byId[String(r.t.id)] = r;
  });
  return src.map(function (r) {
    if (!r || !r.t) return r;
    const hit = byId[String(r.t.id)];
    return hit ? hit : r;
  });
}

/**
 * 把待请求的批次数组按**并发度**编组：[b0,b1,b2,b3] + conc=2 → [[b0,b1],[b2,b3]]
 * 为什么需要：原实现严格串行（每批 5 个），尾批次要等前面全部完成
 * ⇒ 实测第二批要到 +18s 才到。允许 2 个在飞可把尾巴从 ~n×RTT 降到 ~n/2×RTT，
 * 且 2×5=10 并发仍远低于 OpenDota 60/min 窗口（api 层本身还有 rateLimit 排队）。
 * @param {Array<Array>} batches
 * @param {number} conc 并发度（<1 视为 1）
 */
function groupByConcurrency(batches, conc) {
  const src = Array.isArray(batches) ? batches : [];
  const c = (typeof conc === 'number' && conc >= 1) ? Math.floor(conc) : 1;
  const out = [];
  for (let i = 0; i < src.length; i += c) out.push(src.slice(i, i + c));
  return out;
}

/** 按固定大小切批（供调用方构造 batches） */
function chunkBySize(list, size) {
  const src = Array.isArray(list) ? list : [];
  const s = (typeof size === 'number' && size >= 1) ? Math.floor(size) : 1;
  const out = [];
  for (let i = 0; i < src.length; i += s) out.push(src.slice(i, i + s));
  return out;
}

/**
 * 失败提示文案（纯函数 ⇒ 文案可单测，不必在 WXML 里拼）。
 * @returns {string} 空串表示不显示
 */
function failureHint(n) {
  const c = Number(n) || 0;
  if (c <= 0) return '';
  return c + ' 个关注战队取数失败，点此重试';
}

/**
 * 从「按关注列表下标存放的**稀疏数组**」取出已到达项。
 *
 * ★★ 关键不变量（2026-09-28 渐进渲染配套）：`arrived` 的**下标 = 该战队在关注列表中的位置**，
 *   因此"按下标升序取出"⇒ **输出顺序恒为关注列表序**，**不会**出现"按到达先后追加"造成的
 *   顺序抖动（用户可感知）。这与本文件 `mergeRetried` 注释强调的"保持原顺序"是同一诉求。
 * @param {Array} arrived 稀疏数组（未到达的位置为 undefined/null）
 * @returns {Array} 已到达项，**按下标升序**（即关注列表序）
 */
function arrivedRows(arrived) {
  const src = Array.isArray(arrived) ? arrived : [];
  const out = [];
  for (let i = 0; i < src.length; i++) {
    if (src[i]) out.push(src[i]);
  }
  return out;
}

/**
 * 渐进渲染的**节流判据**（纯函数 ⇒ 可单测）。
 *
 * 为什么必须节流：每次 publish 都要 `_renderFollowCards` 全量重建卡 + 同步跑一次
 * `_applyMatchSources`（**实测 20~42ms**）⇒ 无节流"逐张渲染"会引入 +N×30ms 的**纯增量成本**，
 * 与"更快"的目标相冲。故只放行：**首次** / **本次新增 ≥ minGrow** / **距上次 > maxGapMs** / `force`。
 * ★ `force` 用于"每波结束"与"全部结束"兜底 ⇒ 保证最终态一定落地（不会因节流丢卡片）。
 *
 * @param {{count:number, at:number}} state 已渲染状态（count=上次渲染的条数，at=上次渲染时刻 ms）
 * @param {number} count 当前"已到达"条数
 * @param {number} nowMs 当前时刻
 * @param {{force?:boolean, minGrow?:number, maxGapMs?:number}} [opts]
 * @returns {boolean} 是否应当渲染
 */
function shouldRender(state, count, nowMs, opts) {
  const st = state || {};
  const o = opts || {};
  const rendered = Number(st.count) || 0;
  const at = Number(st.at) || 0;
  const n = Number(count) || 0;
  if (o.force) return true;
  if (n <= rendered) return false;                 // 没新增 ⇒ 不渲染（避免重复全量重建）
  if (rendered === 0) return true;                 // 首卡必渲 —— 这正是本方案要抢的那 ~1.4s
  const minGrow = Number(o.minGrow) > 0 ? Number(o.minGrow) : 3;
  const maxGapMs = Number(o.maxGapMs) > 0 ? Number(o.maxGapMs) : 400;
  return (n - rendered) >= minGrow || (nowMs - at) > maxGapMs;
}

module.exports = {
  failedOf: failedOf,
  okOf: okOf,
  mergeRetried: mergeRetried,
  groupByConcurrency: groupByConcurrency,
  chunkBySize: chunkBySize,
  failureHint: failureHint,
  arrivedRows: arrivedRows,
  shouldRender: shouldRender
};
