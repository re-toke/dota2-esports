// ★ 2026-09-22（微信云开发脱离）：本文件原位于 cloudfunctions/cron-discover-tournaments/discover-core.js，
//   随云函数退役迁至 utils/。**零 require、纯函数**，被 scripts/sync/discover-tournaments.js 与
//   scripts/test/test-discover-mirror.js（校验与 utils/tiers.js 口径逐条一致）共用。
//   云侧旧副本随 cloudfunctions/ 一并删除，勿再引用旧路径。
// ============================================================
// cloudfunctions/cron-discover-tournaments/discover-core.js
// 赛事发现的**纯函数**逻辑（2026-09-14 · 阶段2-④）
//
// ## 为什么抽出来
// 「每日赛事发现 + 分级同步」要从微信云开发迁到 GitHub Actions
// （云开发退场；且云函数侧 `.limit(500)` 导致对比基数被卡死 → 发现实际失效）。
//
// 迁移时若把逻辑在脚本里重写一份，**必然双源漂移**（本项目已多次吃这个亏）。
// 故抽成纯函数模块：云函数与 GH Actions 脚本 require 同一份。
//
// ## 落位约束
// 放在云函数目录内 —— 微信云函数只能 require 自己目录下的文件（同 index-builders.js）。
// GH Actions 脚本反向 require 进来。
//
// ## 纯函数约束
// 不依赖 wx-server-sdk / 网络 / 缓存，两个环境都能直接 require。
// ============================================================
'use strict';

/** 归一化赛事名（用作 _id / canonical_key） */
function normalizeEventName(name) {
  if (!name) return '';
  return String(name).toLowerCase().replace(/[^a-z0-9一-鿿а-яё]/g, '').replace(/^the/, '');
}

/** 非 DOTA2 游戏关键词（Liquipedia Category:Tournaments 混入其它游戏） */
var NON_DOTA2_KEYWORDS = [
  'CS2', 'Counter-Strike', 'CS:GO', 'CSGO',
  'LoL', 'League of Legends',
  'Valorant', 'VALORANT',
  'Overwatch',
  'StarCraft', 'Starcraft',
  'Warcraft', 'Warcraft III',
  'Rocket League',
  'Smite', 'Paladins', 'Hearthstone',
  'Rainbow Six', 'R6',
  'Call of Duty', 'CoD',
  'Apex Legends', 'Apex',
  'FIFA', 'NBA 2K',
  'Street Fighter', 'Tekken',
  'Fortnite', 'PUBG', 'Free Fire',
  'Mobile Legends', 'MLBB',
  'Arena of Valor', 'AoV',
  'King of Glory', 'KOG',
  'Wild Rift'
];

/** 是否 DOTA2 赛事（标题含 dota2 → 是；含其它游戏关键词 → 否；否则默认是） */
function isDota2Tournament(title) {
  if (!title) return false;
  if (/dota\s*2|dota2/i.test(title)) return true;
  var lower = title.toLowerCase();
  for (var i = 0; i < NON_DOTA2_KEYWORDS.length; i++) {
    if (lower.indexOf(NON_DOTA2_KEYWORDS[i].toLowerCase()) >= 0) return false;
  }
  return true;
}

/** 去掉 Liquipedia 路径前缀（DOTA2/ / Dota 2/） */
function cleanTitle(title) {
  if (!title) return '';
  return title.replace(/^(DOTA2|Dota 2)\//i, '').trim();
}

/** 从标题提取 4 位年份（无则 null） */
function extractYear(title) {
  var m = String(title).match(/\b(20\d{2})\b/);
  return m ? parseInt(m[1], 10) : null;
}

// ===== community 分级规则（镜像 utils/tiers.js）=====
// ⚠️ 与 utils/tiers.js 的 COMMUNITY_TIERS / EXCLUSION_RULES 必须一致。
//    scripts/test/test-discover-mirror.js 会校验三处（utils/tiers.js、云函数、本模块）逐条一致。
// 等级模型：S(3) > A(2) > B(1) > C(0)
var COMMUNITY_TIERS = [
  // ── S 级：TI 国际邀请赛 ──
  { test: /the\s+international/i, grade: 'S', rank: 3, label: 'S级' },
  // ── S 级：顶级赛事（Riyadh/EWC + DPC Major + S-Tier 第三方巡回赛）──
  { test: /(riyadh\s+masters|esports\s+world\s+cup|ewc)/i, grade: 'S', rank: 3, label: 'S级' },
  { test: /major(?!.*minor)(?!\s+(meme|fun|league|cup|scrim|trial|challenge|show|march|madness|monday))/i, grade: 'S', rank: 3, label: 'S级' },
  { test: /(esl\s+one|dreamleague|pgl|blast\s+slam|fissure|betboom|elite\s+league)/i, grade: 'S', rank: 3, label: 'S级' },
  { test: /premier/i, grade: 'S', rank: 3, label: 'S级' },
  // ── A 级：A-Tier 第三方 + DPC Minor + DPC Division I ──
  { test: /(clavision|the\s+summit|g\s+dexter|games\s+of\s+the\s+future)/i, grade: 'A', rank: 2, label: 'A级' },
  { test: /(cct\s+series|cct\b|pinnacle\s+cup|pinnacle\b|1win\s+(series|essence|duel|standoff|motion))/i, grade: 'A', rank: 2, label: 'A级' },
  { test: /(european\s+pro\s+league|\bepl\b|moonstorm|resurrection|heroic\s+league|1win\s+not\s+int)/i, grade: 'A', rank: 2, label: 'A级' },
  { test: /\bminor\b(?!(\s+(league|scrim|scrims|cup|series|weekly|daily|challenge|fun|meme|trial|show|madness)))/i, grade: 'A', rank: 2, label: 'A级' },
  { test: /(division\s*(i\b|1\b|one\b)|super\s*group|甲级组|upper\s*division)/i, grade: 'A', rank: 2, label: 'A级' },
  // ── B 级：B-Tier 区域联赛 + DPC Division II ──
  { test: /(division\s*(ii\b|2\b|two\b)|乙级组|lower\s*division)/i, grade: 'B', rank: 1, label: 'B级' },
  { test: /(triton|mega\s+arena|world\s+invitational)/i, grade: 'B', rank: 1, label: 'B级' },
  { test: /(dreamleague\s+(division|div)\s*2|dl\s+div\s*2|d2cl|cosmic\s+clash|winline|perfect\s+world\s+league\s+2)/i, grade: 'B', rank: 1, label: 'B级' }
];

// ★ 2026-09-19（收录严谨化 · 黑名单排除 → 白名单准入）：原 EXCLUSION_RULES 拆为两类：
//   ① 硬排除（不收录）② 预选赛（保留但降级为 B 级 + qualifier 标注，用户 2026-09-19 决策）。
//   与 utils/tiers.js 逐条镜像（scripts/test/test-discover-mirror.js 校验）。
var HARD_EXCLUDE_RULES = [
  // 业余/社区/青训/学生（Liquipedia Tier 4，不收录）
  /\b(amateur|community|collegiate|university|school|student|youth|academy|junior|rookie|newbie)\b/i,
  // 慈善/娱乐/表演赛（含 streamers battle 类表演赛）
  /\b(charity|fun(ny)?|meme|joke|show\s*match|all[\s-]?star|streamers?\s+battle)\b/i,
  // TI 预选路径专用
  /road\s+to\s+the\s+international|path\s+to\s+(ti|the\s+international)/i,
  // 国家队 / 国籍类赛事（Liquipedia 明确不收录）
  /\b(national\s+team|nationals?)\b/i,
  // 周赛 / 月赛（Liquipedia 明确不收录）
  /\b(weekly|monthly)\b/i
];
var EXCLUSION_RULES = HARD_EXCLUDE_RULES;   // 向后兼容别名

var QUALIFIER_RULES = [
  /\b(open\s+qualifier|closed\s+qualifier|regional\s+qualifier|qualifiers?|qualification|play-?in)\b/i
];
var QUALIFIER_MAX_GRADE = 'B';
var QUALIFIER_MAX_RANK = 1;

function shouldExclude(name) {
  if (!name) return false;
  for (var i = 0; i < HARD_EXCLUDE_RULES.length; i++) {
    if (HARD_EXCLUDE_RULES[i].test(name)) return true;
  }
  return false;
}

/** 是否预选赛/资格赛（保留但降级） */
function isQualifier(name) {
  if (!name) return false;
  for (var i = 0; i < QUALIFIER_RULES.length; i++) {
    if (QUALIFIER_RULES[i].test(name)) return true;
  }
  return false;
}

/** 预选赛降级：扣到最高 B 级并打 qualifier 标记 */
function applyQualifierCap(tier, name) {
  if (!tier || !isQualifier(name)) return tier;
  if (tier.rank <= QUALIFIER_MAX_RANK) return Object.assign({}, tier, { qualifier: true });
  return { grade: QUALIFIER_MAX_GRADE, rank: QUALIFIER_MAX_RANK, label: 'B级', qualifier: true };
}

/** 按名判社区等级；硬排除命中或未命中规则 → null */
function communityTierFromName(name) {
  if (!name) return null;
  if (shouldExclude(name)) return null;
  for (var i = 0; i < COMMUNITY_TIERS.length; i++) {
    if (COMMUNITY_TIERS[i].test.test(name)) {
      return applyQualifierCap(
        { grade: COMMUNITY_TIERS[i].grade, rank: COMMUNITY_TIERS[i].rank, label: COMMUNITY_TIERS[i].label },
        name
      );
    }
  }
  // 未命中系列规则但属预选赛 → 保留（降级为 B 级 + 标注）
  if (isQualifier(name)) {
    return { grade: QUALIFIER_MAX_GRADE, rank: QUALIFIER_MAX_RANK, label: 'B级', qualifier: true };
  }
  return null;
}

/** Liquipedia Tier(1-4) → 等级对象；越界/非数字 → null */
var LIQUIPEDIA_TIER_MAP = {
  1: { grade: 'S', rank: 3, label: 'S级' },
  2: { grade: 'A', rank: 2, label: 'A级' },
  3: { grade: 'B', rank: 1, label: 'B级' },
  4: { grade: 'C', rank: 0, label: '社区赛' }
};

function mapLiquipediaTier(tier) {
  if (tier == null) return null;
  var t = Number(tier);
  if (isNaN(t) || t < 1 || t > 4) return null;
  return LIQUIPEDIA_TIER_MAP[t];
}

/** 从 wikitext 的 Infobox 提取 liquipediatier（1-4），失败返回 null */
function parseLeagueTierFromWikitext(wikitext) {
  if (!wikitext) return null;
  var tierMatch = wikitext.match(/\|\s*(?:liquipediatier|tier)\s*=\s*([^|}\n]+)/i);
  if (!tierMatch) return null;
  var raw = tierMatch[1].trim().replace(/\[\[|\]\]/g, '').trim();
  var num = parseInt(raw, 10);
  if (isNaN(num) || num < 1 || num > 4) return null;
  return { tier: num };
}

/**
 * 双源分级决策：community 优先 → Liquipedia 兜底 → C 级兜底
 * @returns {{grade:string, rank:number, label:string, source:'community'|'liquipedia'|'fallback'}}
 */
function decideTier(canonicalName, liquipediaTier) {
  var c = communityTierFromName(canonicalName);
  if (c) return { grade: c.grade, rank: c.rank, label: c.label, source: 'community' };
  var l = mapLiquipediaTier(liquipediaTier);
  if (l) return { grade: l.grade, rank: l.rank, label: l.label, source: 'liquipedia' };
  return { grade: 'C', rank: 0, label: '社区赛', source: 'fallback' };
}

/** 候选页面是否值得收录：DOTA2 + 有年份 + 未被排除规则命中 */
function isCandidate(title) {
  var t = cleanTitle(title);
  if (!t) return false;
  if (!isDota2Tournament(t)) return false;
  if (!extractYear(t)) return false;          // 仅保留带年份的（剔除帮助页/分类页）
  if (shouldExclude(t)) return false;
  return true;
}

/**
 * 构造新赛事文档（形状与云函数 insertNewTournaments 完全一致）
 * @param {string} title  LP 页面标题（可含 DOTA2/ 前缀）
 * @param {string} slug   LP slug（用于 liquipediaSlug 字段 + 后续抓分级）
 * @returns {{key:string, doc:object}|null}
 */
function buildEventDoc(title, slug) {
  var canonical = cleanTitle(title);
  var key = normalizeEventName(canonical);
  if (!key) return null;
  var tierDecision = decideTier(canonical, null);   // 插入时仅 community + 兜底
  var isAutoTiered = tierDecision.source === 'community';
  return {
    key: key,
    doc: {
      canonical: canonical,
      aliases: [normalizeEventName(canonical)],
      tier: { grade: tierDecision.grade, rank: tierDecision.rank, label: tierDecision.label },
      tierSource: tierDecision.source,
      year: extractYear(canonical),
      start: null,
      end: null,
      liquipediaSlug: slug || title,
      status: isAutoTiered ? 'auto_tiered' : 'pending_review',
      updatedAt: Date.now()
    }
  };
}

module.exports = {
  normalizeEventName: normalizeEventName,
  NON_DOTA2_KEYWORDS: NON_DOTA2_KEYWORDS,
  isDota2Tournament: isDota2Tournament,
  cleanTitle: cleanTitle,
  extractYear: extractYear,
  COMMUNITY_TIERS: COMMUNITY_TIERS,
  HARD_EXCLUDE_RULES: HARD_EXCLUDE_RULES,
  EXCLUSION_RULES: EXCLUSION_RULES,
  QUALIFIER_RULES: QUALIFIER_RULES,
  QUALIFIER_MAX_GRADE: QUALIFIER_MAX_GRADE,
  QUALIFIER_MAX_RANK: QUALIFIER_MAX_RANK,
  shouldExclude: shouldExclude,
  isQualifier: isQualifier,
  applyQualifierCap: applyQualifierCap,
  communityTierFromName: communityTierFromName,
  LIQUIPEDIA_TIER_MAP: LIQUIPEDIA_TIER_MAP,
  mapLiquipediaTier: mapLiquipediaTier,
  parseLeagueTierFromWikitext: parseLeagueTierFromWikitext,
  decideTier: decideTier,
  isCandidate: isCandidate,
  buildEventDoc: buildEventDoc
};
