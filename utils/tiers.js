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
  // DPC Major（排除 Minor）：阻断 "Major Meme/League/Fun..." 等社区戏称，避免社区联赛误升 S。
  // 真实 Major（The Kuala Lumpur Major / DPC XX Major）仍以 major 收尾或接年份，正常命中。
  { test: /major(?!.*minor)(?!\s+(meme|fun|league|cup|scrim|trial|challenge|show|march|madness|monday))/i, grade: 'S', rank: 3, label: 'S级' },
  // S-Tier 第三方巡回赛：ESL One / DreamLeague / PGL / BLAST / FISSURE / BetBoom
  // 2024 起统一 $1M 级奖金，是 Dota2 职业生态骨架
  { test: /(esl\s+one|dreamleague|pgl|blast\s+slam|fissure|betboom)/i, grade: 'S', rank: 3, label: 'S级' },
  // Premier 级（OpenDota/STRATZ 枚举对应）
  { test: /premier/i, grade: 'S', rank: 3, label: 'S级' },

  // ── A 级：A-Tier 第三方 + DPC Minor + DPC 区域联赛 S 级 ──
  // 常见 A-Tier 赛事：Clavision / Elite League / The Summit 等
  { test: /(clavision|elite\s+league|the\s+summit|g\s+dexter)/i, grade: 'A', rank: 2, label: 'A级' },
  // §9 P0-A3（2026-07-30）：扩充 A-Tier 第三方赛事系列（community 正则覆盖盲区）
  // 依据：Liquipedia Tier 2 赛事 + 2024-2026 赛程梳理，覆盖 OpenDota amateur 误判为 B/C 的情况
  // CCT / Pinnacle Cup / 1win Series / European Pro League / Moonstorm / Resurrection / Heroic League
  { test: /(cct\s+series|cct\b|pinnacle\s+cup|pinnacle\b|1win\s+(series|essence|duel|standoff|motion))/i, grade: 'A', rank: 2, label: 'A级' },
  { test: /(european\s+pro\s+league|\bepl\b|moonstorm|resurrection|heroic\s+league|1win\s+not\s+int)/i, grade: 'A', rank: 2, label: 'A级' },
  // DPC Minor（2017-2020 乙级联赛，已取消但仍可能出现在历史数据中）
  // DPC Minor：阻断 "Minor League/Cup/Scrim/Weekly..." 等社区戏称，避免社区联赛误升 A。
  // 真实 Minor（DPC SEA Minor / XX Minor）minor 后接年份或收尾，正常命中。
  { test: /\bminor\b(?!(\s+(league|scrim|scrims|cup|series|weekly|daily|challenge|fun|meme|trial|show|madness)))/i, grade: 'A', rank: 2, label: 'A级' },
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
    grade: 'B', rank: 1, label: 'B级' },
  // §9 P0-A3（2026-07-30）：扩充 B-Tier 赛事系列
  // DreamLeague Division 2（ESL 2025-2026 新赛制次级联赛，Liquipedia Tier 2-3）
  // D2CL / Cosmic Clash / Triton / Winline / Perfect World 次级联赛
  { test: /(dreamleague\s+(division|div)\s*2|dl\s+div\s*2|d2cl|cosmic\s+clash|winline|perfect\s+world\s+league\s+2)/i,
    grade: 'B', rank: 1, label: 'B级' }
];

// ===== §9 通用排除规则（2026-07-30）=====
// 痛点：原 COMMUNITY_TIERS 的 major/premier/the international 等正则过宽，
//   把社区赛/预选赛/慈善赛误升为 S/A/B。discover-tournaments.js 首次运行发现
//   611 条 rank>=1 的未覆盖赛事，其中混入大量误判：
//     - "SAGEMASK MAJOR" / "PONIME MAJOR" 被误判为 S（社区戏称）
//     - "Premier Amateur Community League" 被误判为 S（premier 命中）
//     - "Road To The International 2024 - Regional Qualifiers" 被误判为 SSS
//     - "Dota 2 Amateur Series" / "Youth Cup" / "University League" 被误升
// 方案：前置通用排除规则，命中关键词的赛事跳过所有 community 规则，返回 null。
//   通用规则覆盖三类误判：
//   ① 预选赛/资格赛：Open Qualifier / Closed Qualifier / Regional Qualifier / Play-In
//   ② 业余/社区/青训：Amateur / Community / Collegiate / University / Youth / Academy
//   ③ 慈善/娱乐/表演赛：Charity / Fun / Meme / Showmatch / All-Star
//   ④ TI 预选路径专用：Road To The International / Path to TI
//   ★ 所有关键词用 \b 单词边界，避免误匹配 FunPlus / Funcurve / CommunityBank 等
//   ★ 不含单独 "open"（ESL Open 是 A-Tier 真实赛事，"open" 必须 + qualifier/cup 才排除）
const EXCLUSION_RULES = [
  // ① 预选赛/资格赛（TI 预选、Major 预选、Play-In 等，不应与正赛同级）
  /\b(open\s+qualifier|closed\s+qualifier|regional\s+qualifier|qualifiers?|play-?in)\b/i,
  // ② 业余/社区/青训/学生（Tier 3-4，不应升 S/A/B）
  /\b(amateur|community|collegiate|university|school|student|youth|academy|junior|rookie|newbie)\b/i,
  // ③ 慈善/娱乐/非正式表演赛（非竞技性，不收录）
  /\b(charity|fun(ny)?|meme|joke|show\s*match|all[\s-]?star)\b/i,
  // ④ TI 预选路径专用排除：Road To The International / Path to TI
  /road\s+to\s+the\s+international|path\s+to\s+(ti|the\s+international)/i
];

// 判断赛事名是否应被排除（命中任一规则返回 true）
function shouldExclude(name) {
  if (!name) return false;
  for (let i = 0; i < EXCLUSION_RULES.length; i++) {
    if (EXCLUSION_RULES[i].test(name)) return true;
  }
  return false;
}

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
  // §9 前置排除规则：命中关键词的赛事（预选/业余/慈善/TI 预选路径）跳过所有 community 规则，
  // 返回 null 让其他源（curation/opendota/stratz/liquipedia）决定分级。
  // 解决 major/premier/the international 等正则过宽导致的误升问题。
  if (shouldExclude(name)) return null;
  for (let i = 0; i < COMMUNITY_TIERS.length; i++) {
    if (COMMUNITY_TIERS[i].test.test(name)) {
      return { grade: COMMUNITY_TIERS[i].grade, rank: COMMUNITY_TIERS[i].rank, label: COMMUNITY_TIERS[i].label };
    }
  }
  return null;
}

// ===== §9 Liquipedia Tier 映射（2026-07-30，方案A：对齐 Liquipedia 权威分级）=====
// Liquipedia 把全量赛事分为 4 档（Tier 1-4），是人工策展的权威分级，
// 覆盖 OpenDota community 规则正则未覆盖的新赛事系列（如 CCT / Pinnacle / 1win Series 等）。
//
// 映射规则（Liquipedia Tier → 项目 grade/rank/label）：
//   Tier 1 → S 级（顶级赛事，含 TI / Major / S-Tier 巡回赛）
//   Tier 2 → A 级（A-Tier 第三方赛事）
//   Tier 3 → B 级（区域联赛 / 次级国际赛）
//   Tier 4 → C 级（社区赛，不收录，rank=0）
//
// ★ 特殊处理：TI 在 community 规则中已单独识别为 SSS，Liquipedia 也标为 Tier 1，
//   但项目需保留 SSS 识别（体现 Valve 官方旗舰的独特性）。
//   因此本映射只处理「无 community 命中」或「community 命中为 S/A/B」的情况，
//   SSS 仍由 community 规则优先识别。
const LIQUIPEDIA_TIER_MAP = {
  1: { grade: 'S', rank: 3, label: 'S级' },      // Tier 1 → S（TI 由 community 优先识别为 SSS）
  2: { grade: 'A', rank: 2, label: 'A级' },      // Tier 2 → A
  3: { grade: 'B', rank: 1, label: 'B级' },       // Tier 3 → B
  4: { grade: 'C', rank: 0, label: '社区赛' }      // Tier 4 → C（不收录）
};

// 把 Liquipedia Tier（1-4 数字）映射为项目的 grade/rank/label。
// 输入超出 1-4 范围返回 null（由调用方降级）。
function mapLiquipediaTier(tier) {
  if (tier == null) return null;
  var t = Number(tier);
  if (isNaN(t) || t < 1 || t > 4) return null;
  return LIQUIPEDIA_TIER_MAP[t];
}

module.exports = {
  COMMUNITY_TIERS: COMMUNITY_TIERS,
  EXCLUSION_RULES: EXCLUSION_RULES,
  shouldExclude: shouldExclude,
  communityTierFromName: communityTierFromName,
  DISPLAY_TIERS: DISPLAY_TIERS,
  displayOf: displayOf,
  displayThemeOf: displayThemeOf,
  flagValve: flagValve,
  flagTopThirdParty: flagTopThirdParty,
  LIQUIPEDIA_TIER_MAP: LIQUIPEDIA_TIER_MAP,
  mapLiquipediaTier: mapLiquipediaTier
};
