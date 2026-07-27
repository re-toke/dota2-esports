// cloudfunctions/aggregation/league-canon-map.js
// 赛事展示名规范映射（精确归一匹配）。数据来自 curation-shared.js（CommonJS 模块，由
// scripts/sync-canon-map.js 从 utils/curation.js 的 CURATED_EVENTS 生成，并镜像到本目录），
// require 时不带扩展名。
//
// G4 单一数据源：与小程序 utils/league-canon-map.js 是同一份生成产物的副本，
// 消除此前「云函数内联手写 MAP」与「curation 别名」双源漂移。
// ⚠️ 部署云函数前必须重新运行 npm run sync:canon，使本副本与小程序侧保持同步。
//
// ⚠️ 必须用 .js 模块而非 .json：require('./curation-shared') 解析为 .js；
//   此前写成 require('./curation-shared.json') 在微信小程序侧会报
//   "module '...curation-shared.json.js' is not defined"。
//
// 归一：小写 + 去非字母数字（与 consensus.normName 对 ASCII 联赛名等价）。
// 精确匹配：命中返回规范名；未命中返回原始 raw；空输入返回空串，由 canonicalLeagueName 兜底 'DOTA2 赛事'。

const DATA = require('./curation-shared');
const MAP = (DATA && DATA.map) || {};

function normalizeKey(raw) {
  return String(raw == null ? '' : raw).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function resolveCanonical(raw) {
  const k = normalizeKey(raw);
  if (!k) return '';
  return MAP[k] || (raw == null ? '' : String(raw));
}

module.exports = { resolveCanonical, MAP, normalizeKey };
