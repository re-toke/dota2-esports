// utils/consensus.js
// 多源交叉验证引擎：对关键字段（赛事名 / 时间 / 分级 / 队伍成员 / 选手ID）
// 在「并行采集多来源取值」之后进行投票/比对，产出：
//   - value      ：共识值（多源达成一致或最接近的值）
//   - sources    ：参与并达成一致（或最接近）的来源清单
//   - confidence ：'high' | 'medium' | 'low'（基于一致来源数）
//   - agreement  ：达成一致的来源数量
//   - total      ：参与有效校核的来源数量
//
// 设计原则：所有来源都是「尽力而为」。任一来源缺失/异常都不影响其它来源，
// 也绝不阻断页面渲染。单源时无法交叉验证，confidence 自然为 'low'。

// ===== §9 P1-B2 加权投票权重表（2026-07-30 修订：对齐 Liquipedia 等级体系）=====
// 各来源的可信度权重：Liquipedia(4) > curation(3) 人工策展 > Steam(2) 官方 > STRATZ(1.5) > OpenDota/community(1) 自动。
// voteName/voteTime/consensusTier 计票时用权重求和替代简单来源数计数。
// 2026-07-30：应「比赛等级划分规则与 Liquipedia 一致」需求，将 liquipedia 权重由 2 提至 4（高于 curation 的 3），
//   使多源冲突时 Liquipedia 的权威分级（Tier 1-4 → S/A/B/C）决定最终结果。
//   同期 curation 的 TI 条目与 community 正则均已从 SSS 降为 S，TI 与 ESL One / DreamLeague / Riyadh Masters 同为 S 级。
const SOURCE_WEIGHT = {
  curation: 3,      // 人工策展（Liquipedia 缺失时的兜底，权重低于 liquipedia）
  liquipedia: 4,    // 人工 wiki 策展（最高权重：与 Liquipedia 等级体系对齐，冲突时 LP 胜出）
  steam: 2,         // Valve 官方
  stratz: 1.5,      // GraphQL，可能被 CF 拦截
  opendota: 1,      // 自动枚举，tier 边界模糊
  community: 1      // 正则兜底，非人工核实
};

// 取来源权重（未知来源默认 1）
function weightOf(source) {
  return SOURCE_WEIGHT[source] != null ? SOURCE_WEIGHT[source] : 1;
}

// ===== 归一化 =====
// 赛事名 / 队名归一：转小写，仅保留 [a-z 0-9 中文]，去掉一切分隔符与标点。
// 例：'The International 2025' -> 'theinternational2025'
function normName(s) {
  if (!s) return '';
  // §8.3 多语言支持（2026-07-29）：保留拉丁字母、数字、中日韩汉字、西里尔字母（俄语赛事名）
  // 原 [^a-z0-9一-鿿] 会把西里尔字母过滤掉，导致俄语赛事名（如 "Чемпионат" → ""）匹配失败
  // 西里尔范围 а-яё (U+0430-U+0451) + А-Я (大写，toLowerCase 后统一为小写)
  return String(s).toLowerCase().replace(/[^a-z0-9一-鿿а-яё]/g, '');
}

// 数字归一：非法/非有限/负数返回 null
function normNum(n) {
  const x = Number(n);
  return (isFinite(x) && !isNaN(x)) ? x : null;
}

// ===== 可信度 =====
// agreement：达成一致(或接近)的来源数；total：参与有效来源数
// 保守策略：仅当「全部一致」才算 high；多源(>=3)中多数一致算 medium；
// 任一来源与其他源明显冲突（agreement < total）一律 low，避免误报可信。
function confidenceOf(agreement, total) {
  if (total <= 1) return 'low';          // 仅单源，无法交叉验证
  if (agreement >= total) return 'high'; // 全部一致
  if (agreement >= 2 && total >= 3) return 'medium'; // 多源中多数一致
  return 'low';
}
const CONF_RANK = { low: 0, medium: 1, high: 2 };

// ===== 赛事名 / 队名 投票（§9 P1-B2 加权版）=====
// candidates: [{ value:string, source:string }]
// 加权计票：liquipedia(4) > curation(3) > steam(2) > stratz(1.5) > opendota/community(1)
// 让人工策展源在多源冲突时一票抵消多个自动源的错误。
function voteName(candidates) {
  const valid = (candidates || []).filter((c) => c && c.value && normName(c.value));
  if (valid.length === 0) {
    return { value: '', sources: [], confidence: 'low', agreement: 0, total: 0 };
  }
  const groups = {};
  valid.forEach((c) => {
    const k = normName(c.value);
    if (!groups[k]) groups[k] = { sources: [], raws: [], weight: 0 };
    groups[k].sources.push(c.source);
    groups[k].raws.push(String(c.value));
    groups[k].weight += weightOf(c.source);  // §9 P1-B2：加权累加
  });
  const keys = Object.keys(groups);
  keys.sort((a, b) => {
    // 1) 权重和高优先；2) 原文最长(信息最完整)优先
    if (groups[b].weight !== groups[a].weight) {
      return groups[b].weight - groups[a].weight;
    }
    const la = Math.max.apply(null, groups[a].raws.map((r) => r.length));
    const lb = Math.max.apply(null, groups[b].raws.map((r) => r.length));
    return lb - la;
  });
  const best = groups[keys[0]];
  // 选该归一组里「最长」的原文作为展示名（最完整，不丢信息）
  let pick = best.raws[0];
  best.raws.forEach((r) => { if (r.length > pick.length) pick = r; });
  const sources = Array.from(new Set(best.sources));
  return {
    value: pick,
    sources: sources,
    confidence: confidenceOf(best.sources.length, valid.length),
    agreement: best.sources.length,
    total: valid.length
  };
}

// ===== 时间 投票（中位数 + 容差）=====
// candidates: [{ value:unixSec, source:string }]，tolSec：一致容差（默认 3 天）
function voteTime(candidates, tolSec) {
  tolSec = tolSec || (86400 * 3);
  const valid = (candidates || []).filter((c) => c && normNum(c.value) != null && normNum(c.value) > 0);
  if (valid.length === 0) {
    return { value: null, sources: [], confidence: 'low', agreement: 0, total: 0, spreadSec: 0 };
  }
  const nums = valid.map((c) => normNum(c.value)).sort((a, b) => a - b);
  const median = nums[Math.floor(nums.length / 2)];
  const agreed = valid.filter((c) => Math.abs(normNum(c.value) - median) <= tolSec);
  const sources = Array.from(new Set(agreed.map((c) => c.source)));
  return {
    value: median,
    sources: sources,
    confidence: confidenceOf(agreed.length, valid.length),
    agreement: agreed.length,
    total: valid.length,
    spreadSec: nums[nums.length - 1] - nums[0]
  };
}

// ===== 分级 投票（按 rank 计票，平票取更高等级）=====
function rankToGrade(rank) {
  if (rank >= 4) return 'SSS';
  if (rank === 3) return 'S';
  if (rank === 2) return 'A';
  if (rank === 1) return 'B';
  return 'C';
}
// candidates: [{ grade, rank, label, source }]
// §9 P1-B2 加权版：按权重和排序（curation 一票抵 opendota 三票），平票取更高等级
function consensusTier(candidates) {
  const valid = (candidates || []).filter((c) => c && c.grade);
  if (valid.length === 0) {
    return { grade: 'C', rank: 0, label: '其他', sources: [], confidence: 'low', agreement: 0, total: 0 };
  }
  const groups = {};
  valid.forEach((c) => {
    const r = (c.rank != null) ? c.rank : 0;
    if (!groups[r]) groups[r] = { rank: r, sources: [], labels: [], weight: 0 };
    groups[r].sources.push(c.source);
    groups[r].weight += weightOf(c.source);  // §9 P1-B2：加权累加
    if (c.label) groups[r].labels.push(c.label);
  });
  const ranks = Object.keys(groups).map(Number).sort((a, b) => {
    // 1) 权重和高优先；2) 平票取更高等级（更稀有、更具体）
    if (groups[b].weight !== groups[a].weight) {
      return groups[b].weight - groups[a].weight;
    }
    return b - a;
  });
  const best = groups[ranks[0]];
  // label 取该等级内出现最多的
  const lc = {};
  best.labels.forEach((l) => { lc[l] = (lc[l] || 0) + 1; });
  let label = best.labels[0];
  let bc = 0;
  Object.keys(lc).forEach((l) => { if (lc[l] > bc) { bc = lc[l]; label = l; } });
  const sources = Array.from(new Set(best.sources));
  return {
    grade: rankToGrade(best.rank),
    rank: best.rank,
    label: label,
    sources: sources,
    confidence: confidenceOf(best.sources.length, valid.length),
    agreement: best.sources.length,
    total: valid.length
  };
}

// ===== 队伍成员 交叉比对（以 account_id 为主键）=====
// memberLists: [{ source:string, members:[{ account_id, name }] }]
function crossMembers(memberLists) {
  const byId = {};
  const order = [];
  (memberLists || []).forEach((group) => {
    const src = group.source;
    (group.members || []).forEach((m) => {
      const id = normNum(m.account_id);
      if (id == null) return;
      if (!byId[id]) { byId[id] = { account_id: id, names: {}, sources: [], first: m.name || '' }; order.push(id); }
      const rec = byId[id];
      if (rec.sources.indexOf(src) < 0) rec.sources.push(src);
      const nm = (m.name || '').trim();
      if (nm) {
        const k = normName(nm);
        if (!rec.names[k]) rec.names[k] = { count: 0, raws: [] };
        rec.names[k].count += 1;
        rec.names[k].raws.push(nm);
      }
    });
  });
  const sourcesSeen = Array.from(new Set((memberLists || []).map((g) => g.source)));
  const members = order.map((id) => {
    const rec = byId[id];
    const keys = Object.keys(rec.names);
    let pickKey = null;
    let pickCount = -1;
    let pickLen = -1;
    keys.forEach((k) => {
      const c = rec.names[k].count;
      const len = Math.max.apply(null, rec.names[k].raws.map((r) => r.length));
      // 频次高优先；频次相同取原文最长（信息最完整）
      if (c > pickCount || (c === pickCount && len > pickLen)) {
        pickCount = c;
        pickLen = len;
        pickKey = k;
      }
    });
    let pickName = rec.first;
    if (pickKey) {
      pickName = rec.names[pickKey].raws.reduce((a, b) => (b.length > a.length ? b : a), rec.names[pickKey].raws[0]);
    }
    const verified = rec.sources.length >= 2;
    return {
      account_id: id,
      name: pickName,
      sources: rec.sources,
      verified: verified,
      confidence: verified ? 'high' : 'low',
      crossSources: rec.sources.length
    };
  });
  // 已交叉验证（多源）的成员排在前
  members.sort((a, b) => (Number(b.verified) - Number(a.verified)) || (b.crossSources - a.crossSources));
  const verifiedCount = members.filter((m) => m.verified).length;
  return {
    members: members,
    total: members.length,
    verifiedCount: verifiedCount,
    confidence: members.length === 0
      ? 'low'
      : (verifiedCount >= members.length / 2 ? 'high' : (verifiedCount > 0 ? 'medium' : 'low')),
    sources: sourcesSeen
  };
}

// ===== 选手ID 校验 =====
function validatePlayerId(id) {
  const n = normNum(id);
  if (n == null || n <= 0 || !Number.isInteger(n)) {
    return { valid: false, accountId: null };
  }
  return { valid: true, accountId: n };
}

// ===== §9 P0-B1 赛事身份指纹（2026-07-30）=====
// 解决痛点：跨源匹配仅靠队名归一化（normName）会导致同名不同赛事误关联，
//   如多个区域的「Division I」、不同年份的同名杯赛。
//
// 指纹组成（| 分隔，缺字段用空串占位）：
//   1. 规范名归一化（normName）
//   2. 年份（优先显式 year 字段，回退从 canonical/name 中提取 20XX）
//   3. 主办方归一化（normName，去主办方后缀如 esports/gaming/team）
//   4. 时间窗（start 的周桶，±7 天容差对齐到同一桶）
//
// 指纹相同才视为同一赛事，用于跨源关联（赛事列表去重 / curation 匹配 / Liquipedia slug 映射）。
// 指纹不同一定不同赛事（主办方可能缺失），但指纹相同则强相关，可显著降低误关联率。
function extractYear(s) {
  if (!s) return '';
  const m = String(s).match(/(20\d{2})/);
  return m ? m[1] : '';
}

function eventFingerprint(event) {
  if (!event) return '';
  // 1. 规范名（canonical 优先，回退 name）
  const name = event.canonical || event.name || '';
  const nameKey = normName(name);
  if (!nameKey) return '';
  // 2. 年份（显式 year 优先，回退从 name/canonical 提取）
  const year = String(event.year || extractYear(name) || extractYear(event.canonical) || '');
  // 3. 主办方归一化（去常见后缀）
  let org = normName(event.organizer || '');
  org = org.replace(/(esports|gaming|team|inc|llc|org)$/g, '');
  // 4. 时间窗（start 的周桶，7 天粒度，对齐到同一桶避免 ±1 天跨桶）
  let weekBucket = '';
  const start = normNum(event.start || event.startDate);
  if (start != null && start > 0) {
    weekBucket = String(Math.floor(start / (7 * 86400)));
  }
  return [nameKey, year, org, weekBucket].join('|');
}

module.exports = {
  normName: normName,
  normNum: normNum,
  confidenceOf: confidenceOf,
  CONF_RANK: CONF_RANK,
  SOURCE_WEIGHT: SOURCE_WEIGHT,
  weightOf: weightOf,
  voteName: voteName,
  voteTime: voteTime,
  consensusTier: consensusTier,
  rankToGrade: rankToGrade,
  crossMembers: crossMembers,
  validatePlayerId: validatePlayerId,
  extractYear: extractYear,
  eventFingerprint: eventFingerprint
};
