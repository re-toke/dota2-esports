// utils/tiers.js
// 社区分级规则（基于赛事名的精选规则，零网络兜底）。
//
// 等级模型：grade 用于展示，rank 用于排序/筛选（越大越高级）
// S(3) > A(2) > B(1) > C(0)
// SSS(4) 仅作展示兜底（未来 rank>=4 来源），社区规则不再产出 SSS
//
// 分级依据（2024+ 职业生态，与 Liquipedia Tier 对齐）：
//   S   = 顶级赛事：TI / Riyadh Masters / EWC / DPC Major / S-Tier 巡回赛
//         （ESL One / DreamLeague / PGL / BLAST / FISSURE / BetBoom / Elite League）
//         对应 Liquipedia Tier 1
//   A   = A-Tier 第三方赛事 + DPC Minor + DPC 区域联赛 S 级
//         （Games of the Future / Clavision / CCT / Pinnacle / 1win Series / EPL）
//         对应 Liquipedia Tier 2
//   B   = B-Tier 区域联赛 + DPC 区域联赛 A 级 + 次级国际赛
//         对应 Liquipedia Tier 3
//   C   = Tier 4 社区赛 / 公开预选 / 青训
//         对应 Liquipedia Tier 4（不收录）

const COMMUNITY_TIERS = [
  // ── S 级：TI 国际邀请赛（对齐 Liquipedia Tier 1） ──
  { test: /the\s+international/i, grade: 'S', rank: 3, label: 'S级' },

  // ── S 级：顶级赛事（Riyadh/EWC + DPC Major + S-Tier 第三方巡回赛） ──
  // Riyadh Masters / 电竞世界杯 EWC（顶级第三方，奖金与关注度顶格）
  { test: /(riyadh\s+masters|esports\s+world\s+cup|ewc)/i, grade: 'S', rank: 3, label: 'S级' },
  // DPC Major（排除 Minor）：Valve 认证的官方顶级积分赛
  // DPC Major（排除 Minor）：阻断 "Major Meme/League/Fun..." 等社区戏称，避免社区联赛误升 S。
  // 真实 Major（The Kuala Lumpur Major / DPC XX Major）仍以 major 收尾或接年份，正常命中。
  { test: /major(?!.*minor)(?!\s+(meme|fun|league|cup|scrim|trial|challenge|show|march|madness|monday))/i, grade: 'S', rank: 3, label: 'S级' },
  // S-Tier 第三方巡回赛：ESL One / DreamLeague / PGL / BLAST / FISSURE / BetBoom / Elite League
  // 2024 起统一 $1M 级奖金，是 Dota2 职业生态骨架
  // ★ Elite League 升 S（对齐 Liquipedia Tier 1，2026-07-31 v3 优化项 B）
  { test: /(esl\s+one|dreamleague|pgl|blast\s+slam|fissure|betboom|elite\s+league)/i, grade: 'S', rank: 3, label: 'S级' },
  // Premier 级（OpenDota/STRATZ 枚举对应）
  { test: /premier/i, grade: 'S', rank: 3, label: 'S级' },

  // ── A 级：A-Tier 第三方 + DPC Minor + DPC 区域联赛 S 级 ──
  // 常见 A-Tier 赛事：Clavision / The Summit / Games of the Future 等
  // ★ Games of the Future 升 A（对齐 Liquipedia Tier 2，2026-07-31 v3 优化项 D）
  { test: /(clavision|the\s+summit|g\s+dexter|games\s+of\s+the\s+future)/i, grade: 'A', rank: 2, label: 'A级' },
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
  // TritonLeague / Mega Arena / Dota 2 World Invitational 等
  // （Games of the Future 已升 A，2026-07-31 v3 优化项 D）
  { test: /(triton|mega\s+arena|world\s+invitational)/i,
    grade: 'B', rank: 1, label: 'B级' },
  // §9 P0-A3（2026-07-30）：扩充 B-Tier 赛事系列
  // DreamLeague Division 2（ESL 2025-2026 新赛制次级联赛，Liquipedia Tier 2-3）
  // D2CL / Cosmic Clash / Triton / Winline / Perfect World 次级联赛
  { test: /(dreamleague\s+(division|div)\s*2|dl\s+div\s*2|d2cl|cosmic\s+clash|winline|perfect\s+world\s+league\s+2)/i,
    grade: 'B', rank: 1, label: 'B级' }
];

// ===== §9 收录口径（2026-09-19 重构：黑名单排除 → 白名单准入）=====
// ★ 重构背景（实测，非推测）：OpenDota 的 tier 字段**不可作为可信度信号** ——
//   「肛宝联赛-老婆杯」(leagueid 19066) 被 OpenDota 标为 tier=professional。
//   实测 professional 共 2488 条，其中仅 364 条（13.5%）命中白名单（正则 ∪ curation）。
//   → 新口径：**默认不收录**，需「命中白名单」才收录。
//     闸门落在服务端裁剪（supabase/functions/opendota-proxy + cloudfunctions/aggregation
//     的 trimLeagues）；本文件提供**同源**判定供客户端兜底。
//
// 规则分三类（用户 2026-09-19 拍板）：
//   ① 硬排除（不收录）：业余/社区/青训/慈善/表演/周赛月赛/国家队/TI 预选路径
//   ② 预选赛（Qualifier）：**保留但降级**为 B 级 + qualifier 标注（用户决策）
//   ③ 未命中任何规则：返回 null（交 curation / Liquipedia tier 决定，不再默认收录）
//
// 标杆：Liquipedia Notability Guidelines
//   · 收录门槛：奖金池 ≥ $500 USD
//   · 明确排除：Qualifiers / Monthly-Weekly / Showmatches / 国籍类赛事
//     （本项目按用户决策把 Qualifiers 由「排除」改为「降级保留」）
//   ★ 关键词用 \b 单词边界，避免误匹配 FunPlus / Funcurve / CommunityBank 等
//   ★ 不含单独 "open"（ESL Open 是真实赛事，"open" 必须 + qualifier/cup 才排除）
const HARD_EXCLUDE_RULES = [
  // 业余/社区/青训/学生（Liquipedia Tier 4，不收录）
  /\b(amateur|community|collegiate|university|school|student|youth|academy|junior|rookie|newbie)\b/i,
  // 慈善/娱乐/表演赛（非竞技性，不收录）
  /\b(charity|fun(ny)?|meme|joke|show\s*match|all[\s-]?star|streamers?\s+battle)\b/i,
  // TI 预选路径专用
  /road\s+to\s+the\s+international|path\s+to\s+(ti|the\s+international)/i,
  // 国家队 / 国籍类赛事（Liquipedia 明确不收录）
  /\b(national\s+team|nationals?)\b/i,
  // 周赛 / 月赛（Liquipedia 明确不收录）
  /\b(weekly|monthly)\b/i
];

// 预选赛/资格赛：保留但降级（最高 B 级）+ qualifier 标注
const QUALIFIER_RULES = [
  /\b(open\s+qualifier|closed\s+qualifier|regional\s+qualifier|qualifiers?|qualification|play-?in)\b/i
];
const QUALIFIER_MAX_GRADE = 'B';
const QUALIFIER_MAX_RANK = 1;

// 判断赛事名是否应被硬排除（不收录）
function shouldExclude(name) {
  if (!name) return false;
  for (let i = 0; i < HARD_EXCLUDE_RULES.length; i++) {
    if (HARD_EXCLUDE_RULES[i].test(name)) return true;
  }
  return false;
}

// 是否预选赛/资格赛（保留但降级）
function isQualifier(name) {
  if (!name) return false;
  for (let i = 0; i < QUALIFIER_RULES.length; i++) {
    if (QUALIFIER_RULES[i].test(name)) return true;
  }
  return false;
}

// 预选赛降级：扣到最高 B 级并打 qualifier 标记（原级别更低则保持，只补标记）
function applyQualifierCap(tier, name) {
  if (!tier || !isQualifier(name)) return tier;
  if (tier.rank <= QUALIFIER_MAX_RANK) return Object.assign({}, tier, { qualifier: true });
  return { grade: QUALIFIER_MAX_GRADE, rank: QUALIFIER_MAX_RANK, label: 'B级', qualifier: true };
}

// ===== 文档五档展示标签（与《DOTA2赛事级别分类全景》对齐）=====
// 雾峰雪 v2.0：SSS 已并入 S（四级化），SSS 条目保留仅为向后兼容（与 S 同标签）
//   S   → S-Tier（含原 SSS：TI / 顶级第三方 / DPC Major）
//   A   → A-Tier（A 级第三方 + DPC Minor/Division I）
//   B   → 区域赛（B 级区域联赛 + DPC Division II）
//   C   → 社区赛（Tier 3-4 社区/公开预选/青训）
const DISPLAY_TIERS = {
  SSS: { display: 'S-Tier', theme: 'danger',  variant: 'light' },
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
  // ① 硬排除：命中即不收录（白名单准入 → 调用方据此丢弃）
  if (shouldExclude(name)) return null;
  for (let i = 0; i < COMMUNITY_TIERS.length; i++) {
    if (COMMUNITY_TIERS[i].test.test(name)) {
      // ② 预选赛降级：即便命中赛事系列规则（如 "BLAST Slam IX China Qualifier" 命中 blast slam），
      //    也要扣到最高 B 级并打 qualifier 标注（用户决策：保留但降级标注）
      return applyQualifierCap(
        { grade: COMMUNITY_TIERS[i].grade, rank: COMMUNITY_TIERS[i].rank, label: COMMUNITY_TIERS[i].label },
        name
      );
    }
  }
  // ③ 未命中系列规则，但属预选赛 → 保留（降级为 B 级 + 标注）
  if (isQualifier(name)) {
    return { grade: QUALIFIER_MAX_GRADE, rank: QUALIFIER_MAX_RANK, label: 'B级', qualifier: true };
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
// ★ TI 已从 SSS 降为 S，与 Liquipedia Tier 1 完全一致。
//   community 规则返回 S，curation 返回 S，Liquipedia 映射返回 S。
//   SSS 条目仅在 DISPLAY_TIERS 中保留，用于未来其他来源可能产生 rank>=4 的兜底展示。
const LIQUIPEDIA_TIER_MAP = {
  1: { grade: 'S', rank: 3, label: 'S级' },      // Tier 1 → S（TI/Major/S-Tier，与 community 对齐）
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
  // ★ 2026-09-19：EXCLUSION_RULES 拆为「硬排除」+「预选赛降级」两类，EXCLUSION_RULES 保留为别名
  HARD_EXCLUDE_RULES: HARD_EXCLUDE_RULES,
  EXCLUSION_RULES: HARD_EXCLUDE_RULES,
  QUALIFIER_RULES: QUALIFIER_RULES,
  QUALIFIER_MAX_GRADE: QUALIFIER_MAX_GRADE,
  QUALIFIER_MAX_RANK: QUALIFIER_MAX_RANK,
  shouldExclude: shouldExclude,
  isQualifier: isQualifier,
  applyQualifierCap: applyQualifierCap,
  communityTierFromName: communityTierFromName,
  DISPLAY_TIERS: DISPLAY_TIERS,
  displayOf: displayOf,
  displayThemeOf: displayThemeOf,
  flagValve: flagValve,
  flagTopThirdParty: flagTopThirdParty,
  LIQUIPEDIA_TIER_MAP: LIQUIPEDIA_TIER_MAP,
  mapLiquipediaTier: mapLiquipediaTier
};
