// cloudfunctions/cron-discover-tournaments/index.js
// DOTA2赛事 —— 定时赛事发现 + 分级同步云函数（阶段3-① + P2 优化项⑫）。
//
// 功能：
//   1. 每日凌晨 3 点由定时触发器唤醒，枚举 Liquipedia 全量赛事页面，
//      对比云数据库 curation_events，将未收录的新赛事入库。
//   2. ★ P2 优化项⑫ curation 分级同步：
//      - 新赛事入库时，用 community 规则（社区正则）自动判定分级，不再固定为 C 级。
//      - 对 status='pending_review' 的赛事，从 Liquipedia 抓取 wikitext 解析 liquipediatier，
//        结合 community 规则做双源分级（community 优先，Liquipedia 兜底），写回 curation_events，
//        状态升级为 'auto_tiered'，供管理后台审核确认。
//   3. 所有写入操作幂等（doc(id).set 为 upsert）。
//
// 设计要点：
//   1. 独立部署，不 require aggregation（避免跨云函数依赖）
//   2. 复用 liquipediaListTournaments 的核心逻辑（categorymembers 分页 + 2s 限流）
//   3. got v11（CommonJS 兼容），与 aggregation 一致
//   4. 单条插入失败不阻塞整体流程（静默 catch）
//   5. 写 admin-logs 记录本次发现 + 分级同步结果，失败静默
//   6. ★ 分级同步模块自包含（community 规则 + parseLeagueTier 镜像），不依赖 utils/tiers.js
//
// ## 触发方式
//   - 定时触发器（见 config.json）：每天 03:00:00 自动执行
//   - 手动调用：wx.cloud.callFunction({ name: 'cron-discover-tournaments' })
//   - 手动指定 action：wx.cloud.callFunction({ name: 'cron-discover-tournaments', data: { action: 'syncTiers' } })

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const GOT = require('got');

const LIQUIPEDIA_BASE = 'https://liquipedia.net/dota2/api.php';
const LIQUIPEDIA_UA = 'DOTA2-Esports-Hub/1.0 (cron; contact: dev@local)';

const CURATION_EVENTS_COLL = 'curation_events';
const ADMIN_LOGS_COLL = 'admin-logs';

// ===== 规范名归一化（与 utils/consensus.js / aggregation 一致）=====
// 转小写，仅保留 [a-z 0-9 中日韩汉字 西里尔字母]，去掉一切分隔符与标点。
// 例：'The International 2025' -> 'theinternational2025'
function normalizeEventName(name) {
  if (!name) return '';
  return String(name).toLowerCase().replace(/[^a-z0-9一-鿿а-яё]/g, '').replace(/^the/, '');
}

// ===== DOTA2 赛事过滤 =====
// Liquipedia 的 Category:Tournaments 包含所有游戏的赛事页面，需过滤掉非 DOTA2 项。
// 策略：
//   1. 标题明确含 'dota 2' / 'dota2' → 保留
//   2. 标题含其他游戏关键词（CS2/LoL/Valorant 等）→ 排除
//   3. 默认保留（Liquipedia 赛事标题通常中立，如 "The International 2026"）
const NON_DOTA2_KEYWORDS = [
  'CS2', 'Counter-Strike', 'CS:GO', 'CSGO',
  'LoL', 'League of Legends',
  'Valorant', 'VALORANT',
  'Overwatch',
  'StarCraft', 'Starcraft',
  'Warcraft', 'Warcraft III',
  'Rocket League',
  'Smite',
  'Paladins',
  'Hearthstone',
  'Rainbow Six', 'R6',
  'Call of Duty', 'CoD',
  'Apex Legends', 'Apex',
  'FIFA',
  'NBA 2K',
  'Street Fighter',
  'Tekken',
  'Fortnite',
  'PUBG',
  'Free Fire',
  'Mobile Legends', 'MLBB',
  'Arena of Valor', 'AoV',
  'King of Glory', 'KOG',
  'Wild Rift'
];

function isDota2Tournament(title) {
  if (!title) return false;
  // 明确是 DOTA2 的保留
  if (/dota\s*2|dota2/i.test(title)) return true;
  // 排除其他游戏关键词
  const lower = title.toLowerCase();
  for (const kw of NON_DOTA2_KEYWORDS) {
    if (lower.includes(kw.toLowerCase())) return false;
  }
  // 默认保留（Liquipedia 的赛事标题通常是中立的，如 "The International 2026"）
  return true;
}

// ===== 标题清理（去掉 Liquipedia 路径前缀）=====
function cleanTitle(title) {
  if (!title) return '';
  // 去掉 'DOTA2/' 或 'Dota 2/' 前缀
  return title.replace(/^(DOTA2|Dota 2)\//i, '').trim();
}

// ===== 年份提取（从标题中匹配 4 位年份）=====
function extractYear(title) {
  const m = String(title).match(/\b(20\d{2})\b/);
  return m ? parseInt(m[1], 10) : null;
}

// ===== ★ P2 优化项⑫：community 分级规则（镜像 utils/tiers.js）=====
// 自包含模块：与 utils/tiers.js 的 COMMUNITY_TIERS + EXCLUSION_RULES 保持一致，
// 避免跨云函数依赖。如 tiers.js 更新规则，此处需同步（由 sync:tiers 脚本检查）。
// 等级模型：S(3) > A(2) > B(1) > C(0)
// 分级依据：与 Liquipedia Tier 对齐（Tier 1→S / Tier 2→A / Tier 3→B / Tier 4→C）
const COMMUNITY_TIERS = [
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

const EXCLUSION_RULES = [
  // ① 预选赛/资格赛
  /\b(open\s+qualifier|closed\s+qualifier|regional\s+qualifier|qualifiers?|play-?in)\b/i,
  // ② 业余/社区/青训/学生
  /\b(amateur|community|collegiate|university|school|student|youth|academy|junior|rookie|newbie)\b/i,
  // ③ 慈善/娱乐/表演赛
  /\b(charity|fun(ny)?|meme|joke|show\s*match|all[\s-]?star)\b/i,
  // ④ TI 预选路径专用排除
  /road\s+to\s+the\s+international|path\s+to\s+(ti|the\s+international)/i
];

function shouldExclude(name) {
  if (!name) return false;
  for (let i = 0; i < EXCLUSION_RULES.length; i++) {
    if (EXCLUSION_RULES[i].test(name)) return true;
  }
  return false;
}

// 根据赛事名返回社区等级（兜底规则），未命中返回 null
// ★ 与 utils/tiers.js communityTierFromName 完全一致（同步维护）
function communityTierFromName(name) {
  if (!name) return null;
  if (shouldExclude(name)) return null;
  for (let i = 0; i < COMMUNITY_TIERS.length; i++) {
    if (COMMUNITY_TIERS[i].test.test(name)) {
      return { grade: COMMUNITY_TIERS[i].grade, rank: COMMUNITY_TIERS[i].rank, label: COMMUNITY_TIERS[i].label };
    }
  }
  return null;
}

// ===== ★ P2 优化项⑫：Liquipedia Tier 映射（镜像 utils/tiers.js）=====
const LIQUIPEDIA_TIER_MAP = {
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

// ===== ★ P2 优化项⑫：从 Liquipedia wikitext 提取 liquipediatier 字段 =====
// 镜像 utils/liquipedia-parse.js 的 parseLeagueTier 核心逻辑（自包含，避免跨云函数依赖）。
// Liquipedia 赛事页结构：
//   {{Infobox league
//   |name=DreamLeague Season 27
//   |liquipediatier=1
//   |...
//   }}
// 返回 { tier: 1 } 或 null（未找到模板 / 无 liquipediatier 字段 / 值非数字）
function parseLeagueTierFromWikitext(wikitext) {
  if (!wikitext) return null;
  // 匹配 {{Infobox league ... }} 或 {{Infobox tournament ... }}
  var tierMatch = wikitext.match(/\|\s*(?:liquipediatier|tier)\s*=\s*([^|}\n]+)/i);
  if (!tierMatch) return null;
  var raw = tierMatch[1].trim();
  // 去掉 wikilink 标记（如 [[1]]）
  raw = raw.replace(/\[\[|\]\]/g, '').trim();
  var num = parseInt(raw, 10);
  if (isNaN(num) || num < 1 || num > 4) return null;
  return { tier: num };
}

// ===== ★ P2 优化项⑫：双源分级决策 =====
// 优先级：community > Liquipedia > C 级兜底
// 理由：community 规则是针对项目生态精调的正则，精确性高于 Liquipedia 通用分级
//       （如 community 排除了预选赛/慈善赛，Liquipedia 可能仍标 Tier 1）
// 返回 { grade, rank, label, source } 供入库 + 日志记录
function decideTier(canonicalName, liquipediaTier) {
  // ① community 规则优先（精确正则 + 排除规则）
  var c = communityTierFromName(canonicalName);
  if (c) {
    return { grade: c.grade, rank: c.rank, label: c.label, source: 'community' };
  }
  // ② Liquipedia 兜底（community 未命中时）
  var l = mapLiquipediaTier(liquipediaTier);
  if (l) {
    return { grade: l.grade, rank: l.rank, label: l.label, source: 'liquipedia' };
  }
  // ③ C 级兜底（双源均未命中）
  return { grade: 'C', rank: 0, label: '社区赛', source: 'fallback' };
}

// ===== Liquipedia categorymembers 全量枚举（独立实现，复用 aggregation 核心逻辑）=====
// 通过 MediaWiki 标准 API（action=query&list=categorymembers）枚举
// Category:Tournaments 下所有页面（cmtype=page 仅取页面，排除子分类）。
// 合规要点：
//   1. 使用标准 API，不抓 HTML
//   2. 描述性 User-Agent + Accept-Encoding: gzip
//   3. 分页拉取（cmlimit=500），每页间隔 2.2s 遵守 ≥2s 软限流
//   4. 最多 3 页 = 1500 条（2026-07-31 优化：从 10 页缩减到 3 页，避免 60s 超时；
//      近期赛事集中在首页，历史赛事无需每日重新发现）
//   5. 仅保留 ns=0（主命名空间）的页面，剔除分类/帮助页
//   6. 过滤：仅保留带年份的页面（/20\d{2}/），剔除帮助页/分类页
// 返回：[{ slug, title }]（title 已清理前缀）
async function liquipediaListTournaments() {
  const allPages = [];
  let cmcontinue = null;
  const MAX_PAGES = 3; // 2026-07-31 优化：3 页 × 500 = 1500 条（原 10 页会超时）

  for (let page = 0; page < MAX_PAGES; page++) {
    if (page > 0) {
      // 遵守 2s 限流（除第一页外，每页间隔 2.2s 留余量）
      await new Promise((r) => setTimeout(r, 2200));
    }
    try {
      const searchParams = {
        action: 'query',
        list: 'categorymembers',
        cmtitle: 'Category:Tournaments',
        cmtype: 'page',
        cmlimit: '500',
        cmdir: 'asc',
        format: 'json',
        formatversion: '2'
      };
      if (cmcontinue) searchParams.cmcontinue = cmcontinue;

      const res = await GOT({
        url: LIQUIPEDIA_BASE,
        searchParams: searchParams,
        headers: {
          'User-Agent': LIQUIPEDIA_UA,
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip'
        },
        responseType: 'json',
        timeout: { request: 20000 },
        retry: { limit: 2 }
      });
      const body = res && res.body;
      if (!body || !body.query || !body.query.categorymembers) break;
      const members = body.query.categorymembers;
      if (!Array.isArray(members) || !members.length) break;

      members.forEach((m) => {
        if (m && m.title && m.ns === 0) { // ns=0 为主命名空间，剔除分类/帮助页
          allPages.push({
            slug: m.title,
            title: m.title.replace(/^Dota 2\/|Tournaments\//i, '')
          });
        }
      });

      // 检查是否还有更多
      cmcontinue = (body.continue && body.continue.cmcontinue) || null;
      if (!cmcontinue) break;
    } catch (e) {
      // 单页失败不致命，返回已拉取的部分
      console.warn('[cron-discover] 第 ' + (page + 1) + ' 页拉取失败:',
        (e && e.message) || e);
      break;
    }
  }

  // 过滤：仅保留带年份的页面（剔除 "Tournaments"、"Help:..." 等非赛事页）
  const filtered = allPages.filter((p) => /20\d{2}/.test(p.title));
  return filtered;
}

// ===== ★ P2 优化项⑫：Liquipedia wikitext 抓取（用于解析 liquipediatier 字段）=====
// 镜像 aggregation 云函数的 fetchLiquipediaWikitext，自包含实现。
// 通过 action=query&prop=revisions 获取页面原始 wikitext，用于后续 parseLeagueTierFromWikitext。
// 合规要点：与 categorymembers 相同的 UA + Accept-Encoding: gzip + redirects=1
// 返回：wikitext 字符串 或 null（页面不存在/无内容/请求失败）
async function fetchLiquipediaWikitext(pageName) {
  if (!pageName) return null;
  try {
    const res = await GOT({
      url: LIQUIPEDIA_BASE,
      searchParams: {
        action: 'query',
        prop: 'revisions',
        rvprop: 'content',
        rvslots: 'main',
        titles: pageName,
        format: 'json',
        formatversion: '2',
        redirects: 1   // 自动跟随 #REDIRECT，返回最终页面的 wikitext
      },
      headers: {
        'User-Agent': LIQUIPEDIA_UA,
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip'
      },
      responseType: 'json',
      timeout: { request: 15000 },
      retry: { limit: 1 }
    });
    const body = res && res.body;
    if (!body || !body.query || !body.query.pages) return null;
    let pages = body.query.pages;
    if (!Array.isArray(pages)) {
      const arr = [];
      for (const k in pages) { if (pages.hasOwnProperty(k)) arr.push(pages[k]); }
      pages = arr;
    }
    if (!pages.length) return null;
    const page = pages[0];
    if (page.missing) return null;
    if (!page.revisions || !page.revisions.length) return null;
    const rev = page.revisions[0];
    const content = (rev.slots && rev.slots.main && rev.slots.main.content) || rev['*'] || rev.content;
    return content || null;
  } catch (e) {
    // 单页失败静默（不阻塞整体分级同步流程）
    return null;
  }
}

// ===== 读取 curation_events 全量，构建 normalized name 集合 =====
// 返回：{ existing: Set<normalized>, docs: Array }
async function loadExistingCuration() {
  const db = cloud.database();
  const res = await db.collection(CURATION_EVENTS_COLL).limit(500).get();
  const docs = (res && res.data) || [];
  const existing = new Set();
  docs.forEach((doc) => {
    // 优先用 _id（已是归一化值），回退到 canonical 归一化
    if (doc._id) existing.add(doc._id);
    if (doc.canonical) existing.add(normalizeEventName(doc.canonical));
  });
  return { existing, docs };
}

// ===== 插入新赛事到 curation_events =====
// 幂等：doc(id).set() 为 upsert，重复运行不重复插入。
// 2026-07-31 优化：并发批量写入（每批 20 条 Promise.all），避免串行超时。
// 单条失败不阻塞整体流程（静默 catch）。
// 最多写入 100 条/次，超过的留到下次定时任务（避免 DB 写入超时）。
// ★ P2 优化项⑫：插入时用 community 规则自动分级（不再固定 C 级）。
//   community 命中的赛事直接以正确分级入库（status='auto_tiered'），
//   未命中的仍以 C 级兜底入库（status='pending_review'，待 syncTiers 抓 Liquipedia 补全）。
async function insertNewTournaments(newItems) {
  const db = cloud.database();
  const MAX_INSERT = 100; // 单次最多写入 100 条，避免超时
  const BATCH_SIZE = 20;  // 每批 20 条并发写入
  const itemsToInsert = newItems.slice(0, MAX_INSERT);
  const skipped = newItems.length - itemsToInsert.length;
  if (skipped > 0) {
    console.log('[cron-discover] 新赛事 ' + newItems.length + ' 条超过上限 ' +
      MAX_INSERT + '，本次只写入前 ' + MAX_INSERT + ' 条，剩余 ' + skipped + ' 条留到下次');
  }

  let inserted = 0;
  const insertedDetails = [];

  // 分批并发写入
  for (let i = 0; i < itemsToInsert.length; i += BATCH_SIZE) {
    const batch = itemsToInsert.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(async (item) => {
      const canonical = cleanTitle(item.title);
      const docId = normalizeEventName(canonical);
      if (!docId) return null; // 归一化为空，跳过

      // ★ P2 优化项⑫：community 规则分级（插入时即判定，无需网络请求）
      // community 命中 → status='auto_tiered'（已自动分级，待人工最终确认）
      // community 未命中 → status='pending_review'（待 syncTiers 抓 Liquipedia 补全）
      const tierDecision = decideTier(canonical, null); // 此处无 liquipediaTier，仅走 community + 兜底
      const isAutoTiered = tierDecision.source === 'community';

      const doc = {
        canonical: canonical,
        aliases: [normalizeEventName(canonical)],
        tier: { grade: tierDecision.grade, rank: tierDecision.rank, label: tierDecision.label },
        tierSource: tierDecision.source,  // ★ 记录分级来源（community/fallback）
        year: extractYear(canonical),
        start: null,
        end: null,
        liquipediaSlug: item.slug || item.title,
        status: isAutoTiered ? 'auto_tiered' : 'pending_review',
        updatedAt: Date.now()
      };

      try {
        await db.collection(CURATION_EVENTS_COLL).doc(docId).set({ data: doc });
        return { _id: docId, canonical: canonical, tier: tierDecision.grade, source: tierDecision.source };
      } catch (e) {
        console.warn('[cron-discover] 插入失败 ' + canonical + ':',
          (e && e.message) || e);
        return null;
      }
    }));

    results.forEach((r) => {
      if (r) {
        inserted++;
        insertedDetails.push(r);
      }
    });
  }

  return { inserted, insertedDetails, skipped };
}

// ===== ★ P2 优化项⑫：分级同步主流程 =====
// 对 status='pending_review' 的赛事，从 Liquipedia 抓取 wikitext 解析 liquipediatier，
// 结合 community 规则做双源分级（community 优先，Liquipedia 兜底），写回 curation_events。
// 状态升级为 'auto_tiered'，供管理后台审核确认。
//
// 设计要点：
//   1. 串行抓取 Liquipedia（遵守 2s 限流，避免被封禁）
//   2. 单条失败不阻塞整体流程（静默 catch）
//   3. 最多处理 15 条/次（每条 ≈2.9s = 2.2s 限流 + ~0.7s 网络/DB，15 条 ≈43s，留余量给其他步骤）
//   4. 已有 liquipediaTier 字段的赛事不重复抓取（幂等优化）
//   5. community 命中时跳过 Liquipedia 抓取（节省请求 + 限流）
async function syncTiers(existingDocs) {
  const db = cloud.database();
  const MAX_SYNC = 15;        // 单次最多 15 条（15 × 2.9s ≈ 43s + 2s overhead ≈ 45s，60s 超时内安全）
  const RATE_LIMIT_MS = 2200; // Liquipedia ≥2s 软限流

  // 筛选待同步的赛事：status='pending_review' 且 tierSource != 'community'
  // （community 已命中的无需再抓 Liquipedia，节省请求）
  const pendingDocs = existingDocs.filter((doc) => {
    return doc.status === 'pending_review' && doc.tierSource !== 'community';
  });

  const toSync = pendingDocs.slice(0, MAX_SYNC);
  const skippedSync = pendingDocs.length - toSync.length;
  if (skippedSync > 0) {
    console.log('[cron-discover] 待同步分级 ' + pendingDocs.length + ' 条超过上限 ' +
      MAX_SYNC + '，本次只处理前 ' + MAX_SYNC + ' 条，剩余 ' + skippedSync + ' 条留到下次');
  }

  let synced = 0;
  let upgraded = 0;  // 从 C 级升级为更高等级的数量
  const syncDetails = [];

  for (let i = 0; i < toSync.length; i++) {
    const doc = toSync[i];
    const docId = doc._id;
    const canonical = doc.canonical || '';
    const slug = doc.liquipediaSlug || canonical;

    if (!docId || !canonical) continue;

    // 限流：除第一条外，每条间隔 2.2s
    if (i > 0) {
      await new Promise((r) => setTimeout(r, RATE_LIMIT_MS));
    }

    // 抓取 Liquipedia wikitext
    const wikitext = await fetchLiquipediaWikitext(slug);
    if (!wikitext) {
      console.warn('[cron-discover] syncTiers: ' + canonical + ' wikitext 抓取失败，跳过');
      syncDetails.push({ _id: docId, canonical: canonical, action: 'skip', reason: 'wikitext_fetch_failed' });
      continue;
    }

    // 解析 liquipediatier
    const tierParsed = parseLeagueTierFromWikitext(wikitext);
    const liquipediaTier = tierParsed ? tierParsed.tier : null;

    // 双源分级决策（community 优先，Liquipedia 兜底）
    const decision = decideTier(canonical, liquipediaTier);

    // 检查是否需要更新（避免无变更的重复写入）
    const currentGrade = (doc.tier && doc.tier.grade) || 'C';
    const needsUpdate = (decision.grade !== currentGrade) ||
                       (doc.tierSource !== decision.source) ||
                       (doc.status !== 'auto_tiered');

    if (!needsUpdate) {
      // 分级无变化但状态未升级（异常情况，强制更新状态）
      syncDetails.push({ _id: docId, canonical: canonical, action: 'no_change', tier: decision.grade, source: decision.source });
      continue;
    }

    // 写回 curation_events
    try {
      await db.collection(CURATION_EVENTS_COLL).doc(docId).update({
        data: {
          tier: { grade: decision.grade, rank: decision.rank, label: decision.label },
          tierSource: decision.source,
          liquipediaTier: liquipediaTier,  // 保存原始 Liquipedia tier 值（1-4 或 null）
          status: 'auto_tiered',
          updatedAt: Date.now()
        }
      });
      synced++;
      const isUpgrade = decision.grade !== 'C' && currentGrade === 'C';
      if (isUpgrade) upgraded++;
      syncDetails.push({
        _id: docId,
        canonical: canonical,
        action: isUpgrade ? 'upgraded' : 'synced',
        from: currentGrade,
        to: decision.grade,
        source: decision.source,
        liquipediaTier: liquipediaTier
      });
    } catch (e) {
      console.warn('[cron-discover] syncTiers: 更新 ' + canonical + ' 失败:',
        (e && e.message) || e);
      syncDetails.push({ _id: docId, canonical: canonical, action: 'error', reason: (e && e.message) || String(e) });
    }
  }

  return { synced, upgraded, skippedSync, syncDetails };
}

// ===== 主流程 =====
// 1. 枚举 Liquipedia 全量赛事
// 2. 过滤 DOTA2 相关赛事
// 3. 对比 curation_events，找出未收录的新赛事
// 4. 将新赛事入库（★ P2 优化项⑫：community 规则自动分级）
// 5. ★ P2 优化项⑫：对 pending_review 赛事执行 syncTiers（Liquipedia 双源分级同步）
// 6. 写 admin-logs 记录本次发现 + 分级同步结果
async function runDiscover() {
  console.log('[cron-discover] 开始执行赛事发现 + 分级同步 ...');

  // 步骤 1：枚举 Liquipedia 全量赛事
  console.log('[cron-discover] 拉取 Liquipedia 全量赛事 ...');
  const allTournaments = await liquipediaListTournaments();
  const allCount = allTournaments.length;
  console.log('[cron-discover] Liquipedia 全量赛事（带年份）：' + allCount + ' 条');

  // 步骤 2：过滤 DOTA2 相关赛事
  const dota2Tournaments = allTournaments.filter((t) => isDota2Tournament(t.title));
  const dota2Count = dota2Tournaments.length;
  console.log('[cron-discover] DOTA2 相关赛事：' + dota2Count + ' 条');

  // 步骤 3：对比 curation_events，找出未收录的新赛事
  const { existing, docs } = await loadExistingCuration();
  const existingCount = docs.length;
  console.log('[cron-discover] curation_events 现有记录：' + existingCount + ' 条');

  const newItems = [];
  for (const t of dota2Tournaments) {
    const canonical = cleanTitle(t.title);
    const norm = normalizeEventName(canonical);
    if (!norm) continue;
    if (!existing.has(norm)) {
      newItems.push(t);
    }
  }
  const newCount = newItems.length;
  console.log('[cron-discover] 未收录新赛事：' + newCount + ' 条');

  // 步骤 4：将新赛事入库（★ community 规则自动分级）
  const { inserted, insertedDetails, skipped } = await insertNewTournaments(newItems);
  console.log('[cron-discover] 成功入库：' + inserted + ' 条' +
    (skipped > 0 ? '，跳过 ' + skipped + ' 条（留到下次）' : ''));

  // ★ P2 优化项⑫ 步骤 5：分级同步（对 pending_review 赛事抓取 Liquipedia 双源分级）
  // 重新加载 curation_events（新赛事已入库，需要包含它们才能同步）
  // 时间预算：categorymembers 约 10s + insert 约 3s + loadRefresh 约 1s + admin-logs 约 1s = 15s overhead
  // syncTiers 每条 ≈2.9s（2.2s 限流 + ~0.7s 网络/DB）
  // 仅在 pendingCount <= 10 时执行（10 × 2.9 ≈ 29s + 15s overhead ≈ 44s，60s 超时内安全）
  let syncResult = { synced: 0, upgraded: 0, skippedSync: 0, syncDetails: [] };
  const pendingCount = docs.filter((d) => d.status === 'pending_review' && d.tierSource !== 'community').length
                       + insertedDetails.filter((d) => d.source !== 'community').length;
  // 保守阈值：pendingCount <= 10 执行（剩余留给 runSyncTiersOnly 手动触发）
  const SYNC_TIME_BUDGET = 10;
  if (pendingCount > 0 && pendingCount <= SYNC_TIME_BUDGET) {
    console.log('[cron-discover] 开始分级同步（pending=' + pendingCount + '）...');
    // 重新加载 curation_events（包含刚入库的新赛事）
    const { docs: refreshedDocs } = await loadExistingCuration();
    syncResult = await syncTiers(refreshedDocs);
    console.log('[cron-discover] 分级同步完成：同步 ' + syncResult.synced + ' 条，升级 ' + syncResult.upgraded + ' 条' +
      (syncResult.skippedSync > 0 ? '，跳过 ' + syncResult.skippedSync + ' 条（留到下次）' : ''));
  } else if (pendingCount > SYNC_TIME_BUDGET) {
    console.log('[cron-discover] 待同步分级 ' + pendingCount + ' 条超过时间预算 ' + SYNC_TIME_BUDGET +
      '，本次跳过 syncTiers，建议手动调用 action=syncTiers 分批处理');
  }

  // 步骤 6：写 admin-logs（失败静默，不影响主流程）
  try {
    const db = cloud.database();
    await db.collection(ADMIN_LOGS_COLL).add({
      data: {
        action: 'cron_discover',
        operator: 'cron',
        count: newCount,
        details: insertedDetails,
        summary: {
          total: allCount,
          dota2: dota2Count,
          existing: existingCount,
          new: newCount,
          inserted: inserted,
          skipped: skipped,
          // ★ P2 优化项⑫：分级同步统计
          tierSynced: syncResult.synced,
          tierUpgraded: syncResult.upgraded,
          tierSkipped: syncResult.skippedSync
        },
        tierSyncDetails: syncResult.syncDetails,
        timestamp: Date.now()
      }
    });
  } catch (e) {
    console.warn('[cron-discover] 写 admin-logs 失败（静默）:',
      (e && e.message) || e);
  }

  // 步骤 7：发现新赛事时写告警记录（action='cron_discover_alert'，作为管理后台告警源）
  // 阶段3-③：不直接发送订阅消息（cron 场景无用户上下文/授权），改为写 admin-logs 标记 needAlert，
  // 管理后台可查询 action 包含 'discover' 的未处理告警（resolved=false），展示告警列表。
  // 仅在 newCount > 0 时写入，避免无新赛事时产生噪声告警。
  if (newCount > 0) {
    try {
      const db = cloud.database();
      await db.collection(ADMIN_LOGS_COLL).add({
        data: {
          action: 'cron_discover_alert',
          operator: 'cron',
          alertType: 'new_tournaments',
          count: newCount,
          details: insertedDetails,
          message: '发现 ' + newCount + ' 个新赛事待审核' +
            (skipped > 0 ? '（' + skipped + ' 条留到下次）' : ''),
          timestamp: Date.now(),
          resolved: false // 管理后台审核后可标记为 true
        }
      });
    } catch (e) {
      console.warn('[cron-discover] 写告警 admin-logs (cron_discover_alert) 失败（静默）:',
        (e && e.message) || e);
    }
  }

  // ★ P2 优化项⑫：分级升级告警（有赛事从 C 级升级为 S/A/B 级时）
  if (syncResult.upgraded > 0) {
    try {
      const db = cloud.database();
      const upgradedDetails = syncResult.syncDetails.filter((d) => d.action === 'upgraded');
      await db.collection(ADMIN_LOGS_COLL).add({
        data: {
          action: 'cron_tier_sync_alert',
          operator: 'cron',
          alertType: 'tier_upgraded',
          count: syncResult.upgraded,
          details: upgradedDetails,
          message: '分级同步：' + syncResult.upgraded + ' 个赛事从 C 级升级为更高等级（待人工确认）',
          timestamp: Date.now(),
          resolved: false
        }
      });
    } catch (e) {
      console.warn('[cron-discover] 写分级告警 admin-logs (cron_tier_sync_alert) 失败（静默）:',
        (e && e.message) || e);
    }
  }

  return {
    success: true,
    total: allCount,
    dota2: dota2Count,
    existing: existingCount,
    new: newCount,
    inserted: inserted,
    skipped: skipped,
    // ★ P2 优化项⑫：分级同步结果
    tierSynced: syncResult.synced,
    tierUpgraded: syncResult.upgraded,
    tierSkipped: syncResult.skippedSync
  };
}

// ===== ★ P2 优化项⑫：分级同步独立流程（手动触发 action='syncTiers'）=====
// 当 runDiscover 因时间预算跳过 syncTiers 时，可手动调用此流程单独执行。
// 读取 curation_events 中所有 status='pending_review' 的赛事，逐一抓取 Liquipedia 分级。
// 单次最多处理 MAX_SYNC=15 条（15 × 2.9s ≈ 43s + 2s overhead ≈ 45s，60s 超时内安全）。
// 剩余 pending_review 赛事留到下次手动触发或次日定时任务。
async function runSyncTiersOnly() {
  console.log('[cron-discover] 开始单独执行分级同步 ...');
  const { docs } = await loadExistingCuration();
  const pendingCount = docs.filter((d) => d.status === 'pending_review' && d.tierSource !== 'community').length;
  console.log('[cron-discover] 待同步分级赛事：' + pendingCount + ' 条');

  const syncResult = await syncTiers(docs);
  console.log('[cron-discover] 分级同步完成：同步 ' + syncResult.synced + ' 条，升级 ' + syncResult.upgraded + ' 条');

  // 写 admin-logs
  try {
    const db = cloud.database();
    await db.collection(ADMIN_LOGS_COLL).add({
      data: {
        action: 'cron_sync_tiers',
        operator: 'cron',
        summary: {
          pending: pendingCount,
          synced: syncResult.synced,
          upgraded: syncResult.upgraded,
          skipped: syncResult.skippedSync
        },
        tierSyncDetails: syncResult.syncDetails,
        timestamp: Date.now()
      }
    });
  } catch (e) {
    console.warn('[cron-discover] 写 admin-logs 失败（静默）:',
      (e && e.message) || e);
  }

  return {
    success: true,
    pending: pendingCount,
    synced: syncResult.synced,
    upgraded: syncResult.upgraded,
    skipped: syncResult.skippedSync
  };
}

// ===== 云函数入口 =====
// 接收定时触发器事件（event.TriggerName / event.Message），
// 也支持手动调用（无 event 参数）。
// ★ P2 优化项⑫：支持 action 参数分流：
//   - 无 action / action='discover'：执行完整发现 + 分级同步流程（默认）
//   - action='syncTiers'：仅执行分级同步（跳过 Liquipedia 枚举，节省时间）
exports.main = async (event, context) => {
  const triggerName = (event && event.TriggerName) || '';
  const triggerMsg = (event && event.Message) || '';
  const action = (event && event.action) || '';
  console.log('[cron-discover] 触发：' + (triggerName || 'manual') +
    (triggerMsg ? ' (' + triggerMsg + ')' : '') +
    (action ? ' [action=' + action + ']' : ''));

  try {
    let result;
    if (action === 'syncTiers') {
      // ★ P2 优化项⑫：单独执行分级同步（手动触发，处理 pending_review 赛事）
      result = await runSyncTiersOnly();
    } else {
      // 默认：完整发现 + 分级同步流程
      result = await runDiscover();
    }
    console.log('[cron-discover] 完成：' + JSON.stringify(result));
    return result;
  } catch (e) {
    // 失败重试 + 静默处理（不阻塞定时任务）
    console.error('[cron-discover] 失败:', (e && e.message) || e);
    return {
      success: false,
      error: (e && e.message) || String(e),
      timestamp: Date.now()
    };
  }
};
