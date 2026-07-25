// utils/tiers.js
// 社区分级规则（基于赛事名的精选规则，零网络兜底）。
//
// 等级模型：grade 用于展示，rank 用于排序/筛选（越大越高级）
// SSS(4) > S(3) > A(2) > B(1) > C(0)
//
// 分级依据（2024+ 职业2生态）：
//   SSS = TI 国际邀请赛（Valve 官方旗舰，年度最高奖金与关注度）
//   S   = 顶级赛事：Riyadh Masters/EWC（顶级第三方）+ DPC Major + S-Tier 巡回赛
//         （ESL One / DreamLeague / PGL / BLAST / FISSURE / BetBoom）
//   A   = A-Tier 第三方赛事 + DPC Minor + DPC 区域联赛 S 级
//   B   = B-Tier 区域联赛 + DPC 区域联赛 A 级 + 次级国际赛
//   C   = Tier 3-4 社区赛 / 公开预选 / 青训

const COMMUNITY_TIERS = [
  // ── SSS：TI 国际邀请赛 ──
  { test: /the\s+international/i, grade: 'SSS', rank: 4, label: 'TI 顶级' },

  // ── S 级：顶级赛事（Riyadh/EWC + DPC Major + S-Tier 第三方巡回赛） ──
  // Riyadh Masters / 电竞世界杯 EWC（顶级第三方，奖金与关注度顶格）
  { test: /(riyadh\s+masters|esports\s+world\s+cup|ewc)/i, grade: 'S', rank: 3, label: 'S级' },
  // DPC Major（排除 Minor）：Valve 认证的官方顶级积分赛
  { test: /major(?!.*minor)/i, grade: 'S', rank: 3, label: 'S级' },
  // S-Tier 第三方巡回赛：ESL One / DreamLeague / PGL / BLAST / FISSURE / BetBoom
  // 2024 起统一 $1M 级奖金，是 Dota2 职业生态骨架
  { test: /(esl\s+one|dreamleague|pgl|blast\s+slam|fissure|betboom)/i, grade: 'S', rank: 3, label: 'S级' },
  // Premier 级（OpenDota/STRATZ 枚举对应）
  { test: /premier/i, grade: 'S', rank: 3, label: 'S级' },

  // ── A 级：A-Tier 第三方 + DPC Minor + DPC 区域联赛 S 级 ──
  // 常见 A-Tier 赛事：Clavision / Elite League / The Summit 等
  { test: /(clavision|elite\s+league|the\s+summit|g\s+dexter)/i, grade: 'A', rank: 2, label: 'A级' },
  // DPC Minor（2017-2020 乙级联赛，已取消但仍可能出现在历史数据中）
  { test: /minor/i, grade: 'A', rank: 2, label: 'A级' },
  // DPC Division（2021-22 起 Valve 将 DPC 拆为 Upper/Lower Division）：
  //   Division I（超级组 / 甲级组 / Upper Division）→ A 级（文档：DPC 区域联赛 S 级）
  //   Division II（乙级组 / Lower Division）→ B 级（文档：DPC 区域联赛 A 级）
  // ★ 修复分类 bug：旧逻辑无此规则，DPC Division I 落在 OpenDota amateur → 误判为 B，
  //   但文档明确 Division I 属 A 级，故显式补规则且置于 amateur 回退之前。
  //   注意 OpenDota 实际命名为 "Upper Division" / "Lower Division"，必须一并匹配。
  { test: /(division\s*(i\b|1\b|one\b)|super\s*group|甲级组|upper\s*division)/i, grade: 'A', rank: 2, label: 'A级' },
  { test: /(division\s*(ii\b|2\b|two\b)|乙级组|lower\s*division)/i, grade: 'B', rank: 1, label: 'B级' },

  // ── B 级：B-Tier 区域联赛 + 次级国际赛 ──
  // Games of the Future / TritonLeague / Mega Arena / Dota 2 World Invitational 等
  { test: /(games\s+of\s+the\s+future|triton|mega\s+arena|world\s+invitational)/i,
    grade: 'B', rank: 1, label: 'B级' }
];

// ===== 文档五档展示标签（与《DOTA2赛事级别分类全景》对齐）=====
// 复用既有 rank 数值（4/3/2/1/0），仅改变「展示名」与「高亮样式」，不影响排序/筛选。
//   SSS → 官方TI（Valve 官方旗舰）
//   S   → S-Tier（顶级第三方 + DPC Major）
//   A   → A-Tier（A 级第三方 + DPC Minor/Division I）
//   B   → 区域赛（B 级区域联赛 + DPC Division II）
//   C   → 社区赛（Tier 3-4 社区/公开预选/青训）
const DISPLAY_TIERS = {
  SSS: { display: '官方TI', theme: 'danger',  variant: 'light' },
  S:   { display: 'S-Tier', theme: 'danger',  variant: 'light' },
  A:   { display: 'A-Tier', theme: 'warning', variant: 'light' },
  B:   { display: '区域赛',  theme: 'default', variant: 'light' },
  C:   { display: '社区赛',  theme: 'default', variant: 'light' }
};

// 取文档五档展示标签（未命中回退社区赛）
function displayOf(grade) {
  return (DISPLAY_TIERS[grade] || DISPLAY_TIERS.C).display;
}
// 取文档五档展示样式（theme/variant），供 TDesign t-tag 直接使用
function displayThemeOf(grade) {
  return DISPLAY_TIERS[grade] || DISPLAY_TIERS.C;
}

// ===== 来源高亮标记（Valve 官方 / 顶级第三方）=====
// 用于列表/详情页「官方」「第三方」徽标。优先用 curation 显式字段，
// 无显式字段时按赛事名正则推断（兜底）。
// valve：Valve 官方运营（TI / DPC Major / DPC Division）
function flagValve(name) {
  if (!name) return false;
  return /(the\s+international|\bmajor\b|\bdivision\b|\bdpc\b)/i.test(name);
}
// topThirdParty：顶级第三方主办方（Riyadh Masters / 电竞世界杯 EWC）
function flagTopThirdParty(name) {
  if (!name) return false;
  return /(riyadh|ewc|esports\s+world\s+cup)/i.test(name);
}

// 根据赛事名返回社区等级（兜底规则），未命中返回 null
function communityTierFromName(name) {
  if (!name) return null;
  for (let i = 0; i < COMMUNITY_TIERS.length; i++) {
    if (COMMUNITY_TIERS[i].test.test(name)) {
      return { grade: COMMUNITY_TIERS[i].grade, rank: COMMUNITY_TIERS[i].rank, label: COMMUNITY_TIERS[i].label };
    }
  }
  return null;
}

module.exports = {
  COMMUNITY_TIERS: COMMUNITY_TIERS,
  communityTierFromName: communityTierFromName,
  DISPLAY_TIERS: DISPLAY_TIERS,
  displayOf: displayOf,
  displayThemeOf: displayThemeOf,
  flagValve: flagValve,
  flagTopThirdParty: flagTopThirdParty
};
