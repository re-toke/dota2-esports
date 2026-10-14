// utils/league-canon-map.js
// 赛事展示名规范映射（精确归一匹配）。数据来自 curation-shared.js（CommonJS 模块，由
// scripts/sync-canon-map.js 从 utils/curation.js 的 CURATED_EVENTS 生成），require 时不带扩展名。
//
// G4 单一数据源：小程序与服务端（EF）共用同一份生成产物
// （服务端 EF（原 cloudfunctions/aggregation）共用 league-canon-map.js + curation-shared.js），
// 消除此前「服务端内联手写 MAP」与「curation 别名」双源漂移。
//
// ⚠️ 必须用 .js 模块而非 .json：微信小程序 require() 直接加载 .json 会报
//   "module '...curation-shared.json.js' is not defined"（解析器补 .js 后缀）。
//
// 归一：小写 + 去非字母数字 —— ★ 2026-10-13（P1-17）改调 `names.normAsciiKey`（ASCII 族单一实现）。
//   ⚠️ 已知偏差（P1-17 发现，**未修**）：生成器 `scripts/sync-canon-map.js:25` 的键规则用**含 CJK** 字符类
//      （`[^a-z0-9一-鿿а-яё]`），与本文件 lookup 的 **ASCII** 族仅对含 CJK/西里尔名的 curation 项不一致；
//      当前 curation canonical 名全为 ASCII ⇒ **无实际影响**。若要收敛须同时改生成器并重生成 `curation-shared.js`（留作后续项）。
// 精确匹配：命中返回规范名；未命中返回原始 raw（与 sources.canonicalLeagueName
// 「原样返回」契约一致）。空输入返回空串，由调用方按需兜底。

const DATA = require('./curation-shared');
const names = require('./names.js');   // ★ 2026-10-13（P1-17）：ASCII 族归一单一实现
const MAP = (DATA && DATA.map) || {};

// ★ 2026-10-13（P1-17）：并入 names.js 的 ASCII 族单一实现（原为内联副本；规则逐字相同）。
const normalizeKey = names.normAsciiKey;

function resolveCanonical(raw) {
  const k = normalizeKey(raw);
  if (!k) return '';
  return MAP[k] || (raw == null ? '' : String(raw));
}

module.exports = { resolveCanonical, MAP, normalizeKey };
