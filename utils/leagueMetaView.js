// utils/leagueMetaView.js
// 赛事详情页：metadata 视图模型纯函数层
//
// ★ 2026-11-15（第三批 · 第一刀）：从 `subpackages/detail/league-detail/league-detail.js`
//   （3571 行）整段搬出，逻辑与注释逐字保留。目的：
//     ① 骨架/兜底/合并/徽标/可信度这类**纯映射**可被 Node 单测覆盖（页面层零测试是最大盲区）；
//     ② 降低详情页单文件的职责密度（页面只保留取数编排与渲染）。
//   ⚠️ 纯计算：不碰 wx / 页面实例 / setData。
'use strict';

const util = require('./util.js');
const remoteCuration = require('./remoteCuration.js');

// 可信度数值化，取两者中最保守者作为整体可信度
const CONF_RANK = { low: 1, medium: 2, high: 3 };
const CONF_TEXT = { low: '待核实', medium: '较可信', high: '可信' };

function worstConfidence(a, b) {
  if (!a && !b) return 'low';
  const ra = CONF_RANK[a || 'low'];
  const rb = CONF_RANK[b || 'low'];
  const min = Math.min(ra, rb);
  return min >= 3 ? 'high' : (min === 2 ? 'medium' : 'low');
}

// 来源 key -> 中文标签
const SOURCE_BADGES = {
  opendota: 'OpenDota',
  stratz: 'STRATZ',
  steam: 'Steam',
  liquipedia: 'Liquipedia',
  curation: '本地策展',
  community: '社区规则'
};

// 把 sources 返回的 source 标签数组转成统一徽标对象
function buildSourceBadges(srcArr) {
  if (!srcArr || !srcArr.length) return [];
  const seen = {};
  const out = [];
  for (let i = 0; i < srcArr.length; i++) {
    const k = (srcArr[i] || '').toLowerCase();
    if (!k || seen[k]) continue;
    seen[k] = true;
    out.push({ key: k, label: SOURCE_BADGES[k] || srcArr[i] });
  }
  return out;
}

// 生成 metadata 骨架：确保 KPI Strip 每个字段都有 key，无数据时统一展示 '--'。
function buildMetadataSkeleton() {
  return {
    canonical: null,
    prizePool: null,
    prizePoolCurrency: null,
    prizeDisplay: '',          // ★ 2026-10-26：紧凑奖金（$2M / $750K），由 refreshMetadataDerived 派生
    prizeRawText: '',          // ★ 2026-10-26：千分位原始值（展开区）
    location: null,
    format: null,
    organizer: null,
    startDate: null,
    endDate: null,
    participants: null,        // ★ P0：只存数组（LP/curation 原始列表），供队伍 Tab 重建
    participantsCount: null,   // ★ P0：只存数字，供 KPI/赛事信息卡展示（禁止与数组混用）
    status: null,
    liquipediaSlug: null,
    sources: []
  };
}

// 当 Liquipedia / Steam 元数据缺失（禁用或拉取失败）时，用 curation 本地策展字段兜底，
// 拼成与 kpi-strip 兼容的 metadata 结构（奖金池/地点/赛制/主办方/赛期/参赛队/状态/Liquipedia slug）。
function buildCurationFallback(cur) {
  if (!cur) return null;
  const fmt = function (sec) { return sec ? util.formatTime(sec) : null; };
  return {
    source: 'curation',
    sources: ['curation'],
    canonical: cur.canonical || '',
    prizePool: cur.prizePool != null ? String(cur.prizePool) : null,
    prizePoolCurrency: cur.prizePoolCurrency || null,
    location: cur.region || null,            // curation 用 region，kpi-strip 用 location
    format: cur.format || null,
    organizer: cur.organizer || null,
    startDate: fmt(cur.start) || cur.startDate || null,   // curation 历史字段为 unix 秒
    endDate: fmt(cur.end) || cur.endDate || null,
    // ★ P0：数组只进 participants，数字只进 participantsCount（原实现两者混用同一字段）
    participants: Array.isArray(cur.participants) ? cur.participants : null,
    participantsCount: Array.isArray(cur.participants)
      ? cur.participants.length
      : (cur.participants != null && cur.participants !== '' && isFinite(Number(cur.participants)) ? Number(cur.participants) : null),
    status: cur.status || null,
    liquipediaSlug: cur.liquipediaSlug || null
  };
}

// 合并已有网络元数据与 curation 兜底，确保返回完整骨架。
// 2026-07-27：传入 leagueId + game 上下文，让 curation 引擎走精确 pin + 跨游戏隔离，
// 防止 CS2 同名联赛（如「ESL Pro League S24」）的元数据污染 DOTA2 详情页。
// 2026-08-11 方案 B/L2 修复：participants 字段特殊处理（数组优先于非数组）。
//   背景：Object.assign({}, fb, meta) 让 meta（Liquipedia 返回）覆盖 fb（curation 兜底）。
//   一旦 meta.participants 是非数组（数字或空数组），会覆盖 fb.participants 数组，
//   导致 curation 人工策展的参赛队伍列表丢失，详情页退回「待定队伍 1..N」占位。
function mergeMetadataWithFallback(meta, name, leagueId) {
  const cur = remoteCuration.curatedEventFor(name, { leagueId: leagueId, game: 'dota2' });
  const fb = cur ? buildCurationFallback(cur) : buildMetadataSkeleton();
  const merged = Object.assign({}, fb);
  // ★ 视觉验证发现：Object.assign 让 meta 的 null/空串覆盖 curation 兜底（主办方显示 --）。
  //   改为「仅非空值覆盖」，保留 curation 的 organizer/location/format/prize 等。
  Object.keys(meta || {}).forEach((k) => {
    const v = meta[k];
    if (v === null || v === undefined || v === '') return;
    merged[k] = v;
  });
  // ★ P0：participants 两字段归一 —— 数组只进 participants，数字只进 participantsCount。
  //   兼容旧形状：若 participants 仍是数字，迁移到 participantsCount 后置空。
  //   数组优先级：LP 数组（meta）> curation 数组（fb），与原 L2 修复口径一致。
  let arr = Array.isArray(merged.participants) ? merged.participants : null;
  if (!arr && Array.isArray(fb && fb.participants)) arr = fb.participants;
  let count = (merged.participantsCount != null && merged.participantsCount !== '')
    ? Number(merged.participantsCount) : null;
  if ((count == null || !isFinite(count)) && merged.participants != null &&
      !Array.isArray(merged.participants) && merged.participants !== '') {
    const n = Number(merged.participants);
    if (isFinite(n)) count = n;
  }
  if ((count == null || !isFinite(count)) && arr) count = arr.length;
  merged.participants = arr;
  merged.participantsCount = (count != null && isFinite(count)) ? count : null;
  return merged;
}

module.exports = {
  CONF_TEXT,
  worstConfidence,
  buildSourceBadges,
  buildMetadataSkeleton,
  buildCurationFallback,
  mergeMetadataWithFallback
};
