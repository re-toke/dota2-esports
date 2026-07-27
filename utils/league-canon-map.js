// utils/league-canon-map.js
// 赛事展示名规范映射（精确归一匹配）。数据来自 curation-shared.js（CommonJS 模块，由
// scripts/sync-canon-map.js 从 utils/curation.js 的 CURATED_EVENTS 生成），require 时不带扩展名。
//
// G4 单一数据源：小程序与云函数 aggregation 共用同一份生成产物
// （cloudfunctions/aggregation/league-canon-map.js + curation-shared.js），
// 消除此前「云函数内联手写 MAP」与「curation 别名」双源漂移。
//
// ⚠️ 必须用 .js 模块而非 .json：微信小程序 require() 直接加载 .json 会报
//   "module '...curation-shared.json.js' is not defined"（解析器补 .js 后缀）。
//
// 归一：小写 + 去非字母数字（与 consensus.normName 对 ASCII 联赛名等价）。
// 精确匹配：命中返回规范名；未命中返回原始 raw（与 sources.canonicalLeagueName
// 「原样返回」契约一致）。空输入返回空串，由调用方按需兜底。

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
