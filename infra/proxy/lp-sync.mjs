// infra/proxy/lp-sync.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Liquipedia → Supabase 缓存同步（Deno Deploy worker，**不依赖 GitHub Actions**）
//
// 背景（2026-11-05 实测）：GitHub runner 抓 LP 时 205/205 条全部 HTTP 429，
//   且第一条就 429 ⇒ LP 按来源 IP 限流，Azure 共享池已被打满。
//   Deno 边缘实测（探针 crazy-mantis-7950，region=ams）：LP API 200 / 26ms，
//   同 UA 同路径内容一致 ⇒ 换出口即通。
//
// 职责：批量抓 LP wikitext → 写 Supabase `aggregation_cache`（key=lp:w:<slug>）
//   与现有 `scripts/sync-liquipedia-cache.js` **同一口径**：payload 是原始 wikitext 字符串，
//   TTL 26h。客户端 / EF 不需要任何改动。
//
// 触发：外部定时器（如 cron-job.org）每 15 分钟 GET /sync?token=<SYNC_TOKEN>
//   —— 刻意不依赖 `Deno.cron`（免费档是否按时触发未经证实）。
//
// 模式：
//   /sync            增量：RecentChanges 差集，通常 1~2 条请求、1~3 个页面
//   /sync?hot=1      热点：只刷「进行中 / 2 天内开赛」赛事的页面（约 4 页）
//   /sync?full=1     全量：40 标题/请求，205 页约 6 条请求（用于首次或解析逻辑变更后重建）
//
// 环境变量（项目 Settings → Environment Variables，前两项务必标记为 Secret）：
//   SB_SERVICE_KEY   Supabase service_role（**绝不能写进代码**）
//   SYNC_TOKEN       调用口令，与 ?token= 一致
//   SB_URL           可选，默认 https://gkic...supabase.co
//
// 合规：相邻 LP 请求强制 2.2s 间隔；`Accept-Encoding: gzip`（LP 对缺该头的 API 请求回 406）；
//   UA 与仓库唯一来源 utils/lp-ua.js 保持一致。
//
// ⚠️ 本文件的 SLUGS / HOT 数组由 `node infra/proxy/build-lp-sync.cjs` 生成
//   —— curation / slugmap 变更后必须重跑生成器并重新粘贴部署，否则新赛事不在同步范围。
// ─────────────────────────────────────────────────────────────────────────────

// <BUILD:SLUGS>
const SLUGS = [
  "EPL/Masters/3", "EPL/Masters/2", "ExitLagChampZ",
  "BLAST/SLAM/8/Europe", "BLAST/SLAM/8/Southeast Asia", "BLAST/SLAM/8/Europe/Open Qualifier 1",
  "BLAST/SLAM/8/Europe/Open Qualifier 2", "BLAST/SLAM/8/Southeast Asia/Open Qualifier 1", "BLAST/SLAM/8/Southeast Asia/Open Qualifier 2",
  "BLAST/SLAM/8/China", "BLAST/SLAM/8/China/Open Qualifier 1", "BLAST/SLAM/8/China/Open Qualifier 2",
  "BLAST/SLAM/9/Europe", "BLAST/SLAM/9/Southeast Asia", "BLAST/SLAM/9/China",
  "The Summit/8", "DreamLeague/Season 13", "Illuminational Dota 2 Major",
  "Games of the Future/2025", "The International/2021", "The International/2024",
  "FISSURE/Special/1", "FISSURE/Universe/6", "FISSURE/PLAYGROUND/1",
  "BetBoom Streamers Battle/10", "DreamLeague/Season 26", "1win_Essence/1",
  "1win_Essence/2", "BetBoom Streamers Battle/2", "FISSURE/Universe/8",
  "FISSURE/Universe/4/Western Europe", "PARI Universe/1/Qualifier", "WePlay/Pushka League/1/Europe",
  "ESL One/Raleigh/2025", "ESL One/Manila/2016", "DreamLeague/Season 2",
  "FISSURE/Universe/3", "Clavision/Snow Ruyi/2024", "AKPA/A-Major/2025",
  "ESL One/Bangkok/2024", "Games of the Future/2026", "BetBoom Streamers Battle/9",
  "ONE Esports/Singapore Major/2021", "FISSURE/Universe/5", "BetBoom Streamers Battle/12",
  "FISSURE/Universe/7", "WePlay/AniMajor/2021", "Lima Major/2023",
  "The Summit/3", "The Summit/5", "DreamLeague/29",
  "DreamLeague/30", "Winline Star Series/4", "Elite League/1/MENA",
  "DreamLeague/Kick-Off Season", "ESL One/New York/2014", "BLAST/Slam/1",
  "BetBoom Streamers Battle/8", "The Summit/2", "The Prime Major Tournament",
  "Midas Mode/1", "BetBoom Esports Tournament/1", "ESL One/Frankfurt/2014",
  "DreamLeague/Season 5", "ESL One/Frankfurt/2016", "The International/2014",
  "BetBoom Streamers Battle/5", "The International/2016", "WePlay Dota2 League/3",
  "The Summit/4", "ESL One/New York/2015", "ESL One/Frankfurt/2015",
  "The Major League/2017", "ESL One/Genting/2017", "DreamLeague/Season 7",
  "ESL One/Hamburg/2017", "BetBoom Streamers Battle/13", "DreamLeague/Season 8",
  "PGL/Arlington Major/2022", "ESL One/Genting/2018", "DreamLeague/Season 6",
  "Kiev Major/2017", "DreamLeague/Season 9", "Philippine Pro Gaming League/2018",
  "BetBoom Xmas Show/2022", "WePlay/WeSave Charity Play", "The International/2018",
  "Dota2 Professional League/Season 5/Top", "ESL One/Germany/2020", "DreamLeague/Season 4",
  "PGL/Kuala Lumpur Major", "DreamLeague/Season 10", "EPICENTER/2019/Southeast Asia",
  "The International/2025", "BetBoom Dacha/Dubai/2024", "BetBoom Dacha/Dubai/2024/Solo Tournament",
  "ESL One/Katowice/2019", "The International/2022", "Global Esports Games/2023",
  "DreamLeague/Season 11", "FISSURE/PLAYGROUND/2", "The International/2019",
  "Bali Major/2023", "EPICENTER/2019/Europe", "BetBoom Streamers Battle/3",
  "Riyadh Masters/2023", "BetBoom Dacha/2023", "DreamLeague/Season 25",
  "DreamLeague/Season 21", "Mars Dota 2 League/Chengdu Major/2019", "DreamLeague/27",
  "BetBoom Streamers Battle/7", "Shanghai Major/2016", "MPGL/Asian Championship/Regular Season",
  "Red Bull Heroicks", "Chongqing Major/2019", "World Electronic Sports Games/2017",
  "DreamLeague/Season 12", "The International/2023", "Mars Dota 2 League/Disneyland Paris Major",
  "BLAST/Bounty Hunt", "DreamLeague/28", "The International/2017",
  "BetBoom Streamers Battle/4", "BLAST/SLAM/6", "BetBoom Dacha/Belgrade/2024",
  "The International/2026", "IESF World Championship/2024", "ESL One/Birmingham/2026",
  "The International/2012", "BeyondTheSummit World Tour", "The International/2013",
  "WePlay Dota2 League/2", "The International/2015", "BetBoom Streamers Battle/6",
  "Riyadh Masters/2024", "Riyadh Masters/2025", "DreamLeague/Season 22",
  "DreamLeague/Season 23", "DreamLeague/Season 24", "ESL One/Kuala Lumpur/2023",
  "ESL One/Birmingham/2024", "Esports World Cup/2025", "Esports World Cup/2026",
  "Esports Nations Cup/2026", "PGL/Wallachia/1", "PGL/Wallachia/2",
  "PGL/Wallachia/3", "PGL/Wallachia/4", "PGL/Wallachia/5",
  "PGL/Wallachia/9", "BLAST/Slam/2", "BLAST/Slam/3",
  "BLAST/Slam/4", "BLAST/Slam/5", "BLAST/Slam/6",
  "BLAST/Slam/7", "BLAST/Slam/8", "BLAST/Slam/9",
  "EPL/Masters/1", "The_International/2025", "The_International/2024",
  "The_International/2023", "The_International/2022", "The_International/2026/Group_Stage",
  "The_International/2026/Swiss_Standings", "The_International/2026/Main Event", "The_International/2026",
  "The_International/2026/Europe", "The_International/2026/North America", "The_International/2026/South America",
  "The_International/2026/China", "The_International/2026/Southeast Asia", "BLAST/SLAM/7/China",
  "Riyadh_Masters/2024", "DreamLeague/Season_23", "DreamLeague/Season_22",
  "DreamLeague/Season_24", "DreamLeague/Season_25", "FISSURE/Universe/1",
  "PARI_Universe/1", "Riyadh_Masters/2025", "Clavision/Masters/2025",
  "Elite_League/1", "DreamLeague/Season_26", "Esports_World_Cup/2026",
  "BLAST/SLAM/8", "Esports_Nations_Cup/2026", "BLAST/SLAM/9",
  "Games_of_the_Future/2024", "Portal Dota 2 World Invitationals/2024", "Riyadh_Masters/2023",
  "BLAST/SLAM/7", "Dota_Pro_Circuit/2020-21", "Dota_Pro_Circuit/2021-22",
  "Dota_Pro_Circuit/2023", "The_Kuala_Lumpur_Major", "EPICENTER_Major",
  "Games_of_the_Future/2026", "EPL/World Series/Southeast Asia/17", "European Pro League/40",
  "DreamLeague/Division 2/5", "DreamLeague/Division 2/6", "DreamLeague/31",
  "PGL/Wallachia/10",
];
// </BUILD:SLUGS>

// <BUILD:HOT>
const HOT = [
  { n: "EPL Masters III", s: 1792281600, e: 1793836800, slugs: ["EPL/Masters/3"] },
  { n: "Esports Nations Cup 2026", s: 1793577600, e: 1794096000, slugs: ["Esports_Nations_Cup/2026", "Esports Nations Cup/2026"] },
  { n: "DreamLeague Division 2 Series 5", s: 1793923200, e: 1795046400, slugs: ["DreamLeague/Division 2/5"] },
];
// </BUILD:HOT>

// <BUILD:BRACKETS>
const BRACKET_EVENTS = [
  { n: "EPL Masters III", id: 19944, slugs: ["EPL/Masters/3/Main Event", "EPL/Masters/3/Playoffs", "EPL/Masters/3"] },
  { n: "Esports Nations Cup 2026", id: null, slugs: ["Esports_Nations_Cup/2026/Main Event", "Esports_Nations_Cup/2026/Playoffs", "Esports_Nations_Cup/2026"] },
  { n: "DreamLeague Division 2 Series 5", id: null, slugs: ["DreamLeague/Division 2/5/Main Event", "DreamLeague/Division 2/5/Playoffs", "DreamLeague/Division 2/5"] },
];
// </BUILD:BRACKETS>

// <BUILD:PARSER>
const NAMES = (function () {
  const module = { exports: {} };
  const exports = module.exports;
// utils/names.js
// ============================================================================
// 名称归一化的**单一实现**（2026-09-20 抽取）。
//
// ## 为什么需要这个模块
// 「小写 + 去非字母数字」这条规则在仓库里被**内联复制了 19 次**，且分属两个**不同语义**的命名空间：
//   · **队名**（team name）—— 必须与 `scripts/sync/fetch-team-logos.js` 生成的快照键
//     （`team-logo-local-data.js` 的 byName）**逐字一致**，否则 logo 精确键永远 miss；
//   · **赛事名的「叶子」键**（league key leaf）—— 供 `league-canon-map` 的静态映射查表使用。
// 各处散布实现 + 仅靠注释约定「要与 XX 保持一致」→ 一旦任一处漂移就静默失效
//   （实测教训：`replace(/\s+/g,'')` 与 `replace(/[^a-z0-9]/g,'')` 不一致导致
//    "Pipsqueak + 4" → `pipsqueak+4` ≠ 快照键 `pipsqueak4`，整队 logo 全 miss）。
//
// ## ⚠️ 不要用 leagueKey / leagueBaseName 替代本模块
// 本项目「赛事名」有**语义级**归一化（`sources.leagueBaseName` → 剥阶段后缀 + 查 curation 规范名），
// 它与本模块的「**形状级**去符号」是两件事：
//   ① 队名用 leagueKey 会被剥掉 "Team/Eagles" 之类的后缀并触发 curation 查表 → **误配**；
//   ② `league-canon-map` 是 `canonicalLeagueName` 的**下游叶子**，若它改用 `leagueKey`，
//      会形成 `canonicalLeagueName → resolveCanonical → leagueKey → leagueBaseName →
//      canonicalLeagueName` 的**无限递归**。
//   ⇒ 本模块是「形状归一化」的唯一出口；语义归一化请用 `sources.leagueKey`。
//
// ## 无依赖
// 刻意保持零 `require`，避免与 `sources.js` / `consensus.js` 形成循环依赖。
// ============================================================================

/**
 * 形状归一（叶子规则）：小写 + 去掉所有非 ASCII 字母数字字符。
 *
 * ★ 这是全仓库**唯一**允许出现该规则的地方。新增用途请 import 本函数，
 *   不要再内联 `String(x).toLowerCase().replace(/[^a-z0-9]/g, '')`。
 *
 * ⚠️ 刻意**不保留** CJK / 西里尔字母（与 `consensus.normName` 不同）——
 *   因为队名快照键是按此规则生成的，改动会让既有快照键全部失配。
 *   中文队名（如「天辉」「夜魇」）归一到空串，由调用方按占位名特判（见各处 天辉/夜魇 判断）。
 *
 * @param {*} s
 * @returns {string}
 */
function normAsciiKey(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * 队名归一 —— 语义别名，等价于 `normAsciiKey`。
 * 单独命名是为了让调用点自解释（`normTeamName(t.name)` 比 `normAsciiKey(...)` 更明确），
 * 同时把「队名归一」的改动收口到一处。
 *
 * 契约（改动前必须同步 `scripts/sync/fetch-team-logos.js` 的键生成并**重新生成快照**）：
 *   · "Pipsqueak + 4" → "pipsqueak4"
 *   · "Level UP esports" → "levelupesports"（后缀剥离由调用方另行处理）
 *   · "Чемпионат Москвы" → ""（非 ASCII 被去除）
 *   · "天辉" / "夜魇" → ""（占位名，调用方需特判）
 */
function normTeamName(s) {
  return normAsciiKey(s);
}

/**
 * 队名归一 + 剥离常见战队后缀（esports/gaming/team/club/gg…）。
 * 用途：跨源队名比对的**兜底**匹配（"Level UP esports" 剥离后 = "levelup" 可直接命中简称）。
 * ⚠️ 仅用于兜底链路；精确匹配仍应先比 `normTeamName` 的原值。
 */
const TEAM_SUFFIX_RE = /(esports|esport|gaming|team|club|dota)$/;
function normTeamNameLoose(s) {
  return normAsciiKey(s).replace(TEAM_SUFFIX_RE, '');
}

// ===== 语义族 ②「含 CJK / 西里尔」（**与族 ① 语义不同，勿合并**）=====
// ★★ 2026-10-13（P1-17）：把仓内**仍内联**的队名归一收敛到本族单一实现 ——
//   原重复点（8 处，均为逐字或近逐字的副本）：
//     · `utils/sources.js` ×4：`dedupeLiveSeries._norm`（无赞助商）/ `_dedupCrossSourceMatches._normTeam` /
//       `groupLiquipediaMatches.keyOf._normTeam` / `buildLpLiveSeries._normTeamX`（后三者剥「 x 赞助商」）
//     · `utils/liquipedia.js` `_normTeam`（剥 x 赞助商）
//     · `subpackages/detail/league-detail/league-detail.js` `normalizeTeamNameForDedup`（无赞助商）
//     · `pages/index/index.js` `_normTeamX`（剥 x 赞助商）
//   ⇒ 消除「同名归一结果不一致」类静默 bug（族 ① 曾因 `[^a-z0-9]` vs `\s+` 不一致导致整队 logo 全 miss）。
//
// 与族 ①（`normAsciiKey`）的区别：
//   · 本族**保留 CJK / 西里尔**（`[^a-z0-9一-鿿а-яё]`）——族 ① 会抹成空串（"天辉" → ""）；
//   · 本族**剥队后缀** `esports|e-sports|gaming|team|club`（含 e-sports、**不含 dota/esport** ⇒ 与 TEAM_SUFFIX_RE 不同）。
//   ⚠️ 两族**不可互相替代**；也**不可**改用 `sources.leagueKey`（那个是语义级，会剥阶段后缀 + 查 curation，见文件头）。
//   ⚠️ 字符类须与 `utils/consensus.js` 的 `normName`（赛事名族）**逐字一致**；两处改动要同步并回归
//     `test-consensus` / `test-sources`。
const KEEP_ASCII_CJK_CYR_RE = /[^a-z0-9\u4e00-\u9fff\u0430-\u044f\u0451]/g;  // = [^a-z0-9一-鿿а-яё]
const TEAM_SUFFIX_CJK_RE = /\s*(esports|e-sports|gaming|team|club)\s*$/g;
// 「 x 赞助商」后缀（Valve live 全名 'Inner Circle x Insanity' → 'Inner Circle'）
const SPONSOR_X_RE = /\s*[x×]\s+\S+.*$/i;

/**
 * 含 CJK 队名归一：小写 + 剥队后缀 + 保留 ASCII/CJK/西里尔（去其余符号）。
 * 契约：'Team Spirit' → 'teamspirit'；'Level UP esports' → 'levelup'；
 *       'Чемпионат Москвы' → 'чемпионатмосквы'；'天辉' → '天辉'（族 ① 则为 ""）。
 */
function normTeamNameCjk(s) {
  return String(s || '').toLowerCase().trim()
    .replace(TEAM_SUFFIX_CJK_RE, '')
    .replace(KEEP_ASCII_CJK_CYR_RE, '');
}

/**
 * 同 `normTeamNameCjk`，但**先剥「 x 赞助商」后缀**（Steam/Valve live 全名）。
 * 契约：'Inner Circle x Insanity' → 'innercircle'；'Pipsqueak + 4' → 'pipsqueak4'。
 */
function normTeamNameCjkSponsor(s) {
  return String(s || '').toLowerCase().trim()
    .replace(SPONSOR_X_RE, '')
    .replace(TEAM_SUFFIX_CJK_RE, '')
    .replace(KEEP_ASCII_CJK_CYR_RE, '');
}

// ★★ 2026-09-25：清理**上游 LP/LPDB 混进队名的系统文案**（队名清洗的单一实现处）。
//
// 背景（线上实测，用户 2026-09-23 Console 诊断）：
//   上游把「页面不存在」的系统文案混进了队名 ⇒ 形如 Conventus Stellarum + (page does not exist) ✗
//   ⇒ 归一化后与干净队名**算不出同一个键** ⇒ 首页「同一对局两张卡」的合并失效 ✓
//
// 规则（只去噪，不做语义改写）：
//   1) 剔除已知系统文案 page does not exist（含括号、大小写不敏感）
//   2) 剔除**尾部**括号补充（如 Brazil / Peru 这类地区标注）
//   ⚠️ 与 normAsciiKey 的分工：本函数**保留可读文本**（不去符号、不转小写），
//      供展示清洗与「先清洗再归一化」的链路使用。
function sanitizeTeamName(name) {
  var x = String(name == null ? '' : name);
  x = x.replace(/\(\s*page does not exist\s*\)/ig, ' ');
  x = x.replace(/\s*\([^)]*\)\s*$/, ' ');
  return x.replace(/\s+/g, ' ').trim();
}

module.exports = {
  sanitizeTeamName: sanitizeTeamName,
  normAsciiKey: normAsciiKey,
  normTeamName: normTeamName,
  normTeamNameLoose: normTeamNameLoose,
  TEAM_SUFFIX_RE: TEAM_SUFFIX_RE,
  // 语义族 ②（含 CJK/西里尔）—— P1-17 收敛后的单一实现
  normTeamNameCjk: normTeamNameCjk,
  normTeamNameCjkSponsor: normTeamNameCjkSponsor
};

  return module.exports;
})();

const LPParse = (function () {
  const module = { exports: {} };
  const exports = module.exports;
// ★ 2026-09-25：清洗上游混入队名的系统文案时，复用 names.js 的单一实现。
//   ⚠️ 本模块此前是「零 require 的纯函数模块」（曾作为 EF/Deno 侧可复用的前提）——
//   现引入唯一依赖 names.js（其自身零依赖、无循环风险）。若将来再需要把它搬到别的运行时，
//   请连同 names.js 一起复制（或改回自包含）。
var names = NAMES;

// utils/liquipedia-parse.js
// Liquipedia wikitext 纯解析层（零 wx / 零云 / 零 config 依赖）。
//
// ★ 设计目的（A+B 双源策略核心）★
//   原 liquipedia.js 的模板解析逻辑与微信耦合的 request 混在同一文件，无法在云函数
//   （Node.js）环境复用。本文件把"纯解析"部分抽成独立模块：
//     - 客户端 liquipedia.js：require 本文件 + 保留 wx.request 抓取层
//     - 云函数 aggregation：require 本文件的镜像拷贝（scripts/sync-liquipedia-parse.js
//       保证两侧字节一致），用 got 抓取 + 本文件解析，规避 wx.request 禁设 User-Agent。
//   两侧共用同一份解析逻辑 → 杜绝"客户端解析 / 云端解析"漂移。
//
// 本文件只做"给定 wikitext 文本 → 结构化对象"的纯函数，不发起任何网络请求、
// 不读写缓存、不依赖 wx / cloud / config。可在任何 Node / 小程序环境直接 require。

// ===== wikitext 模板参数解析（比 HTML 正则更可靠）=====
//
// Liquipedia 页面用 MediaWiki 模板组织元数据，例如赛事页：
//   {{Infobox league
//   |name=The International 2024
//   |sdate=2024-09-11
//   |edate=2024-10-13
//   |prizepool=5000000
//   |city=Copenhagen
//   |organizer=Valve
//   |format=...
//   }}
//
// 本解析器从 wikitext 中提取首个指定模板的所有 key=value 参数。
// 相比 HTML 正则，模板参数是结构化的，不依赖易变的 HTML class 名，容错性更强。

// 从 wikitext 中提取指定模板的参数对象。
// templateName 形如 'Infobox league'（不区分大小写匹配）。
// 返回 { key: value } 或 null（未找到模板）。
function parseTemplate(wikitext, templateName) {
  if (!wikitext || !templateName) return null;
  try {
    // 匹配 {{TemplateName ... }}，需处理嵌套花括号（用深度计数）
    var target = templateName.toLowerCase().trim();
    var start = -1;
    var depth = 0;
    var end = -1;
    for (var i = 0; i < wikitext.length - 1; i++) {
      if (wikitext[i] === '{' && wikitext[i + 1] === '{') {
        if (start < 0) {
          // 检查模板名是否匹配
          var afterName = wikitext.substring(i + 2);
          var nameMatch = afterName.match(/^([^|}]+)/);
          if (nameMatch) {
            var thisName = nameMatch[1].trim().toLowerCase();
            if (thisName === target) {
              start = i + 2 + nameMatch[1].length;
              depth = 1;
              i = i + 2 + nameMatch[1].length - 1;
              continue;
            }
          }
        } else {
          depth++;
          i++; // 跳过下一个 {
        }
      } else if (wikitext[i] === '}' && wikitext[i + 1] === '}') {
        if (start >= 0) {
          depth--;
          if (depth === 0) {
            end = i;
            break;
          }
          i++; // 跳过下一个 }
        }
      }
    }
    if (start < 0 || end < 0) return null;

    var body = wikitext.substring(start, end);
    // 按 | 分割参数（需忽略 || 在值内部的情况，但 Liquipedia 模板值很少含 |）
    var params = {};
    // 去掉开头的 |（如果模板名后紧跟 |）
    body = body.replace(/^\s*\|/, '');
    var parts = splitTopLevel(body, '|');
    for (var p = 0; p < parts.length; p++) {
      var part = parts[p].trim();
      if (!part) continue;
      var eq = part.indexOf('=');
      if (eq < 0) continue;
      var key = part.substring(0, eq).trim().toLowerCase();
      var value = part.substring(eq + 1).trim();
      // 去掉值内层模板的 {{...}} 包裹（保留纯文本）
      value = stripWikitextMarkup(value);
      if (key) params[key] = value;
    }
    return params;
  } catch (e) {
    return null;
  }
}

// 按分隔符分割，但忽略 [[...]] 内部和 {{...}} 内部的分隔符
function splitTopLevel(s, sep) {
  var result = [];
  var current = '';
  var bracketDepth = 0; // [[ ]]
  var braceDepth = 0;   // {{ }}
  for (var i = 0; i < s.length; i++) {
    var ch = s[i];
    if (ch === '[' && s[i + 1] === '[') { bracketDepth++; current += '[['; i++; continue; }
    if (ch === ']' && s[i + 1] === ']') { bracketDepth--; current += ']]'; i++; continue; }
    if (ch === '{' && s[i + 1] === '{') { braceDepth++; current += '{{'; i++; continue; }
    if (ch === '}' && s[i + 1] === '}') { braceDepth--; current += '}}'; i++; continue; }
    if (ch === sep && bracketDepth === 0 && braceDepth === 0) {
      result.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current) result.push(current);
  return result;
}

// 去掉 wikitext 标记：[[a|b]] → b，[[a]] → a，'''a''' → a，''a'' → a，<br> → 空格
function stripWikitextMarkup(s) {
  if (!s) return '';
  return String(s)
    .replace(/\[\[[^\]]*\|([^\]]*)\]\]/g, '$1')   // [[a|b]] → b
    .replace(/\[\[([^\]]*)\]\]/g, '$1')           // [[a]] → a
    .replace(/'''/g, '')                          // '''粗体'''
    .replace(/''/g, '')                           // ''斜体''
    .replace(/<br\s*\/?>/gi, ' ')                // <br> 换行
    .replace(/<[^>]+(>|$)/g, '')                  // 其它 HTML 标签
    .replace(/\s+/g, ' ')
    .trim();
}

// 去掉 HTML 标签（保留纯文本），用于解析表格行
function stripTags(html) {
  if (!html) return '';
  return String(html)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/?[^>]+(>|$)/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// 解析奖金池文本，如 "$1,000,000 USD" 或 wikitext 中的 "5000000" → { amount, currency }
// ★ 2026-10-25（P0）：币种符号映射 —— 原实现对 €/£/¥ 不识别，统一回落 USD，导致「€500,000 显示 500000 USD」。
var PRIZE_CURRENCY_BY_SYMBOL = { '$': 'USD', '€': 'EUR', '£': 'GBP', '¥': 'CNY' };
function parsePrizePool(text) {
  if (!text) return null;
  try {
    // 纯数字（wikitext 模板参数常为纯数字）：无币种线索，保留 USD 兜底
    var numOnly = String(text).match(/^[\d,]+(\.\d+)?$/);
    if (numOnly) {
      return { amount: text.replace(/,/g, ''), currency: 'USD' };
    }
    // 带货币符号：$1,000,000 USD
    var m = String(text).match(/([\$€£¥])\s*([\d,]+(?:\.\d+)?)\s*([A-Za-z]{3})?/);
    if (m) {
      return {
        amount: m[2].replace(/,/g, ''),
        currency: m[3] || PRIZE_CURRENCY_BY_SYMBOL[m[1]] || 'USD'
      };
    }
    // 纯数字 + 货币码
    var m2 = String(text).match(/([\d,]+(?:\.\d+)?)\s*([A-Za-z]{3})?/);
    if (m2) {
      return { amount: m2[1].replace(/,/g, ''), currency: m2[2] || 'USD' };
    }
    return null;
  } catch (e) {
    return null;
  }
}

// 从一段文本中收集所有 yyyy-MM-dd / yyyy-M-d / yyyy/MM/dd 形态的日期
function collectDates(text) {
  if (!text) return [];
  try {
    var ms = text.match(/\d{4}[-/]\d{1,2}([-/]\d{1,2})?/g);
    return ms || [];
  } catch (e) {
    return [];
  }
}

// ===== 公共方法 =====

// 0. 解析赛事页 Participants 区块，提取参赛队伍列表。
// wikitext 支持两种模板（Liquipedia 标准，互斥使用）：
//
//   ① 嵌套式（近 1-2 年新赛事）：
//   {{TeamParticipants
//   |{{Opponent|队伍名|players=...|qualification={{Qualification|method=invite|qual}}}}
//   |{{Opponent|...}}
//   }}
//   {{FormerParticipants|{{TeamParticipants|{{Opponent|...}}}}}}  ← 已替换的队伍
//
//   ② 扁平式（旧赛事，如 ESL One Birmingham 2024）：
//   {{TeamCard columns start|cols=4}}
//   {{TeamCard|team=队伍名|p1=...|p5=...|qualifier=[[...]]}}
//   {{TeamCard|...}}
//   {{TeamCard columns end}}
//   {{FormerParticipants|{{TeamCard|team=...}}}}  ← 已替换的队伍
//
// 返回数组 [{ name, status, liquipediaSlug }] 或 null。
//   - status: 'invited'（直邀）/ 'qualifier'（预选）/ 'TBD'（未公布）
//   - name 为空时返回 TBD（Opponent/TeamCard 模板队名参数为空表示未公布）
//   - liquipediaSlug: 队伍在 Liquipedia 的页面 slug（用于跳转），优先取 [[...]] 内部链接
// 不解析选手 roster（{{Persons}}/{{Person}}/{{p1..p5}}），仅取队伍级信息，
// 避免解析过深导致性能问题（roster 数据需求由战队详情页单独拉取）。
// 用深度计数法处理嵌套花括号。
// 2026-07-28 新增 TeamCard 解析分支：兼容旧版赛事页（如 ESL One Birmingham 2024）。

// 用深度计数法从 startPos 开始查找匹配的 }} 结束位置（含）。
// startPos 应指向首个 `{` 的位置。返回 -1 表示未找到。
function findTemplateEnd(wikitext, startPos) {
  var depth = 1;
  for (var i = startPos + 2; i < wikitext.length - 1; i++) {
    if (wikitext[i] === '{' && wikitext[i + 1] === '{') { depth++; i++; }
    else if (wikitext[i] === '}' && wikitext[i + 1] === '}') {
      depth--;
      if (depth === 0) return i;
      i++;
    }
  }
  return -1;
}

// 从 [[...]] wikitext 链接中提取展示名与 slug。
// 输入 '[[Team Spirit|TS]]' → { name: 'TS', slug: 'Team Spirit' }
// 输入 '[[Team Spirit]]' → { name: 'Team Spirit', slug: 'Team Spirit' }
// 输入 'Team Spirit' → { name: 'Team Spirit', slug: null }
function extractLink(nameRaw) {
  var name = nameRaw;
  var slug = null;
  var linkMatch = nameRaw.match(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/);
  if (linkMatch) {
    slug = linkMatch[1];
    var textMatch = nameRaw.match(/\[\[[^\]]*\|([^\]]+)\]\]/);
    name = textMatch ? textMatch[1].trim() : slug.split('/').pop();
  } else {
    name = stripWikitextMarkup(nameRaw);
  }
  return { name: name, slug: slug };
}

// 解析 {{Opponent|...}} 模板内容，提取队伍信息。
// 结构：{{Opponent|队伍名|players=...|qualification={{Qualification|method=invite|qual}}}}
//   - 队名：首个无名参数（去掉 Opponent| 前缀后的第一个 | 分段）
//   - 资格：|qualification= 字段内嵌 {{Qualification|method=invite|qual}}
function parseOpponentBlock(body) {
  var afterName = body.replace(/^Opponent\s*\|\s*/, '');
  var parts = splitTopLevel(afterName, '|');
  // ★ 2026-10-26（视觉验证）：队名取值优先级 —— `team=` 命名参数 > 首个无名参数。
  //   原实现取 parts[0]，遇到 `{{Opponent|flag=ru|Team Spirit|...}}` 会把 "flag=ru" 当成队名。
  var nameRaw = '';
  var teamParam = '';
  for (var pi = 0; pi < parts.length; pi++) {
    var p0 = (parts[pi] || '').trim();
    if (!p0) continue;
    if (p0.indexOf('=') >= 0) {
      var kv = p0.match(/^team\s*=\s*(.*)$/i);
      if (kv && !teamParam) teamParam = kv[1].trim();
      continue;
    }
    if (!nameRaw) nameRaw = p0;
  }
  if (teamParam) nameRaw = teamParam;
  var linkInfo = extractLink(nameRaw);
  var name = linkInfo.name;
  var slug = linkInfo.slug;
  var status = 'TBD';
  for (var p = 1; p < parts.length; p++) {
    var part = parts[p].trim();
    if (/^qualification\s*=/.test(part)) {
      var qualVal = part.replace(/^qualification\s*=\s*/, '').trim();
      if (/method\s*=\s*invite/i.test(qualVal)) status = 'invited';
      else if (/method\s*=\s*qual/i.test(qualVal)) status = 'qualifier';
      break;
    }
  }
  // ★ 2026-09-25：清洗上游混入的系统文案（见 names.sanitizeTeamName）
  name = names.sanitizeTeamName(name);
  if (!name) name = 'TBD';
  return { name: name, status: status, liquipediaSlug: slug };
}

// 解析 {{TeamCard|...}} 模板内容，提取队伍信息。
// 结构：{{TeamCard|team=队伍名|p1=...|p5=...|c=...|qualifier=[[...]]|logo=...}}
//   - 队名：|team= 命名参数（必填，缺失视为 TBD）
//   - 资格：|qualifier= 字段，可能是 [[链接|显示名]] 或纯文本
//     启发式判定（无 method 结构）：
//       含 'invite'/'Direct'/'Leaderboard'/'Seed'/'Top' → invited
//       含 'qualifier'/'Qual'/'Play-In'/'Open'/'Closed' → qualifier
//       空或其它 → TBD
// 不解析 p1..p5 选手（选手走 getTeamRoster 单独查，避免主赛事页过大）。
function parseTeamCardBlock(body) {
  var afterName = body.replace(/^TeamCard\s*\|\s*/, '');
  var parts = splitTopLevel(afterName, '|');
  var name = '';
  var slug = null;
  var qualifierRaw = '';
  for (var i = 0; i < parts.length; i++) {
    var part = parts[i].trim();
    var m = part.match(/^([^=]+)\s*=\s*(.*)$/);
    if (!m) continue;
    var key = m[1].trim().toLowerCase();
    var val = m[2].trim();
    if (key === 'team' || key === 'teamtemplate') {
      var linkInfo = extractLink(val);
      name = linkInfo.name;
      slug = linkInfo.slug;
    } else if (key === 'qualifier' || key === 'qualification') {
      qualifierRaw = val;
    } else if (key === 'linkteam' && !slug) {
      // |linkteam= 显式指定跳转目标，优先级低于 team= 中的 [[...]]
      slug = val;
    }
  }
  var status = 'TBD';
  if (qualifierRaw) {
    if (/invite|direct|leaderboard|seed|top/i.test(qualifierRaw)) status = 'invited';
    else if (/qual|play-?in|open|closed/i.test(qualifierRaw)) status = 'qualifier';
  }
  if (!name) name = 'TBD';
  return { name: name, status: status, liquipediaSlug: slug };
}

// ★ 2026-10-26（视觉验证）：参赛队扫描区域收窄。
//   原实现全页扫描 {{Opponent|...}}，会把「奖金分配 / 奖项（AwardPrizePool）」等区块里的
//   opponent 模板也当成参赛队（EWC 的 `{{Opponent|flag=ru|Noticed|team=PVISION}}` → 25 队）。
//   优先级：全部 {{TeamParticipants ...}} 模板块 > 「Participants」章节 > 全页兜底。
//   注：一场赛事可能有多段 {{TeamParticipants}}（如 EPL 的 Playoff Seed / Group Stage Seed），
//   必须取并集；`TeamParticipantsControls` 不是参赛队容器，用 `{{TeamParticipants|` 锚定排除。
function participantsScanRegion(wikitext) {
  var out = '';
  var re = /\{\{TeamParticipants\s*\|/g;
  var m;
  while ((m = re.exec(wikitext)) !== null) {
    var end = findTemplateEnd(wikitext, m.index);
    if (end < 0) break;
    out += wikitext.substring(m.index, end + 2) + '\n';
    re.lastIndex = end + 2;
  }
  if (out) return out;
  var hm = /^==+\s*(Participants|Participating [Tt]eams|Teams|Qualified [Tt]eams)\s*==+/m.exec(wikitext);
  if (hm) {
    var from = hm.index + hm[0].length;
    var rest = wikitext.substring(from);
    var nm = /^==[^=]/m.exec(rest);
    return nm ? wikitext.substring(from, from + nm.index) : rest;
  }
  return wikitext;
}

function parseParticipants(wikitext) {
  if (!wikitext) return null;
  try {
    var teams = [];
    var scanText = participantsScanRegion(wikitext);
    // 一次扫描同时识别 {{Opponent|...}} 和 {{TeamCard|...}}
    // 注意：{{TeamCardToggleButton}} 和 {{TeamCard columns start}} 不含 | 后跟 team=，故不会被误匹配
    var tplRegex = /\{\{(Opponent|TeamCard)\s*\|/g;
    var match;
    while ((match = tplRegex.exec(scanText)) !== null) {
      var tplType = match[1];
      var startIdx = match.index + 2; // 跳过 {{
      var endIdx = findTemplateEnd(scanText, match.index);
      if (endIdx < 0) break;
      var body = scanText.substring(startIdx, endIdx);
      var team = tplType === 'Opponent'
        ? parseOpponentBlock(body)
        : parseTeamCardBlock(body);
      teams.push(team);
      // 推进 regex 位置避免重复匹配嵌套模板
      tplRegex.lastIndex = endIdx + 2;
    }
    // 过滤掉 FormerParticipants（已替换的队伍）：检测 wikitext 中 {{FormerParticipants|...}} 区块，
    // 并从结果中移除该区块内出现的队伍名。
    // 2026-07-28：同时收集 {{Opponent}} 和 {{TeamCard}} 的队名，兼容两种模板。
    var formerNames = {};
    var fpStart = wikitext.indexOf('{{FormerParticipants');
    while (fpStart >= 0) {
      var fpEnd = findTemplateEnd(wikitext, fpStart);
      if (fpEnd < 0) break;
      var fblock = wikitext.substring(fpStart, fpEnd);
      var fTplRegex = /\{\{(Opponent|TeamCard)\s*\|/g;
      var fm;
      while ((fm = fTplRegex.exec(fblock)) !== null) {
        var fStart = fm.index + 2;
        var fEnd = findTemplateEnd(fblock, fm.index);
        if (fEnd < 0) break;
        var fBody = fblock.substring(fStart, fEnd);
        var fTeam = fm[1] === 'Opponent'
          ? parseOpponentBlock(fBody)
          : parseTeamCardBlock(fBody);
        if (fTeam && fTeam.name && fTeam.name !== 'TBD') {
          formerNames[fTeam.name.toLowerCase()] = true;
        }
        fTplRegex.lastIndex = fEnd + 2;
      }
      fpStart = wikitext.indexOf('{{FormerParticipants', fpEnd + 2);
    }
    // 移除已替换的队伍
    if (Object.keys(formerNames).length) {
      teams = teams.filter(function (t) {
        return !formerNames[(t.name || '').toLowerCase()];
      });
    }
    // ★ 2026-10-26（视觉验证）：同名队伍去重（TBD 槽位允许多条，不参与去重）
    var _seenNames = {};
    teams = teams.filter(function (t) {
      var n = String((t && t.name) || '').toLowerCase();
      if (!n || n === 'tbd') return true;
      if (_seenNames[n]) return false;
      _seenNames[n] = 1;
      return true;
    });
    return teams.length ? teams : null;
  } catch (e) {
    return null;
  }
}

// 1. 解析赛事元数据（纯函数版，供客户端 + 云端共用）
// 输入：wikitext 源码（已由调用方抓取）；fallbackName 为页面 slug（当 Infobox 无 name 时兜底）。
// 返回 { canonical, startDate, endDate, prizePool, prizePoolCurrency, location, format, organizer, participants, source }
// 或 null。每个字段独立 try/catch，缺一个不影响其它字段。
// 解析 Liquipedia 赛事页的 {{Infobox league}} 模板参数，及 Participants 区块参赛队伍。
// 2026-07-28 新增 participants 字段：解析 {{TeamParticipants}} 中的 {{Opponent}} 列表，
//   为未开赛赛事提供已公布的参赛队伍，与 Liquipedia 公示一致。
function parseLeagueMetadata(wikitext, fallbackName) {
  if (!wikitext) return null;
  try {
    var tpl = parseTemplate(wikitext, 'Infobox league') || parseTemplate(wikitext, 'Infobox tournament');
    if (!tpl) return null;

    var result = { source: 'liquipedia' };
    var anyField = false;

    try {
      result.canonical = tpl.name || tpl.ticker || (fallbackName || null);
      if (result.canonical) anyField = true;
    } catch (e) { result.canonical = null; }

    try {
      // sdate/edate 是 Liquipedia 模板的标准键；也兼容 startdate/enddate
      result.startDate = tpl.sdate || tpl.startdate || tpl.start || null;
      result.endDate = tpl.edate || tpl.enddate || tpl.end || null;
      if (result.startDate) anyField = true;
    } catch (e) { result.startDate = null; result.endDate = null; }

    try {
      // prizepool 通常是纯数字（USD）；也支持带货币符号的文本
      var pp = tpl.prizepool || tpl.prizepoolusd || tpl.prize_pool;
      var parsed = parsePrizePool(pp);
      result.prizePool = parsed ? parsed.amount : null;
      result.prizePoolCurrency = parsed ? parsed.currency : null;
      if (parsed) anyField = true;
    } catch (e) { result.prizePool = null; result.prizePoolCurrency = null; }

    try {
      // city 优先，country 作为补充，venue 是场馆名
      var loc = tpl.city || tpl.country || tpl.location || tpl.venue;
      if (tpl.city && tpl.country) loc = tpl.city + ', ' + tpl.country;
      result.location = loc || null;
      if (result.location) anyField = true;
    } catch (e) { result.location = null; }

    try { result.format = tpl.format || null; if (result.format) anyField = true; } catch (e) { result.format = null; }
    try { result.organizer = tpl.organizer || tpl.organizers || null; if (result.organizer) anyField = true; } catch (e) { result.organizer = null; }

    // 2026-07-28 新增：解析 Participants 区块参赛队伍。
    // 即使 Infobox 无任何字段（under construction 页面），Participants 也能提供已公布队伍。
    // 解析失败不影响其它字段，participants 为 null 时由调用方走 curation/占位兜底。
    try {
      var participants = parseParticipants(wikitext);
      if (participants && participants.length) {
        result.participants = participants;
        anyField = true;
      }
    } catch (e) { result.participants = null; }

    if (!anyField) return null;
    return result;
  } catch (e) {
    return null;
  }
}

// ===== 赛程解析：从 wikitext 中提取未开赛/进行中的对阵 =====
//
// Liquipedia 赛事页面用 {{Matchlist}} 容器 + 嵌套 {{Match}} 模板记录赛程：
//   {{Matchlist|title=April 22-A|collapsed=true
//   |M1={{Match
//     |bestof=2
//     |opponent1={{TeamOpponent|team falcons}}
//     |opponent2={{TeamOpponent|betboom team}}
//     |date=April 22, 2024 - 13:00 {{Abbr/CEST}}
//     |finished=true
//     |map1={{Map|team1side=dir|t1h1=...}}
//     ...
//   }}
//   |M2={{Match|...}}
//   }}
//
// 本函数扫描所有 {{Match}} 模板（跳过 {{Matchlist}} 容器），提取：
//   - team1Name / team2Name：从 opponent1/opponent2 的 {{TeamOpponent|队名}} 提取
//   - startTime：从 date 字段解析为 unix 秒
//   - boType：从 bestof 字段
//   - finished：是否已结束
//   - phase：live（已开赛未结束）/ upcoming（未开赛）/ recent（已结束）
//
// nowSec 用于判定 phase：start < now 且未结束 → live；start > now → upcoming；已结束 → recent
function parseScheduledMatches(wikitext, nowSec) {
  if (!wikitext) return [];
  nowSec = nowSec || Math.floor(Date.now() / 1000);
  var matches = [];
  // ★ v3 优化项23：维护当前 section 上下文（标题层级解析）
  var currentSection = '';
  var currentSubsection = '';
  // 逐行扫描：检测标题行（== Section == / === Subsection ===）和 {{Match}} 模板
  var lines = wikitext.split('\n');
  for (var li = 0; li < lines.length; li++) {
    var line = lines[li].trim();
    // 检测二级标题（== Section ==）
    var h2 = line.match(/^==\s*([^=]+?)\s*==$/);
    if (h2) {
      currentSection = h2[1].trim();
      currentSubsection = '';
      continue;
    }
    // 检测三级标题（=== Subsection ===）
    var h3 = line.match(/^===\s*([^=]+?)\s*===$/);
    if (h3) {
      currentSubsection = h3[1].trim();
      continue;
    }
    // 检测 {{Match}} 模板（跳过 {{Matchlist}} 定义行；
    // ★ 2026-08-03 修复：兼容 {{Matchlist}} 嵌套写法 "|M#={{Match"（Match 不在行首，
    //   如 1win Essence II 页面结构），此前 line.indexOf('{{Match') !== 0 会把
    //   所有 Matchlist 嵌套的比赛整场跳过 → 详情页对阵 LIVE/UPCOMING 恒为 0。
    var mPos = line.indexOf('{{Match');
    if (mPos < 0) continue;
    if (/^\{\{Matchlist(?![a-zA-Z])/.test(line)) continue;
    var startPos = mPos;
    // （空占位 {{Match}} 无参数 → parseMatchFields 返回 null 自动过滤；
    //  跨行模板 "{{Match\n|opponent1=..." 由下方拼接逻辑闭合后整体解析）
    // 从行中提取模板（处理同行模板和跨行模板）
    var fullLine = line;
    // 如果模板未在当前行闭合，拼接后续行
    var braceDepth = 0;
    var templateEnd = -1;
    for (var ci = 0; ci < fullLine.length - 1; ci++) {
      if (fullLine[ci] === '{' && fullLine[ci + 1] === '{') { braceDepth++; ci++; }
      else if (fullLine[ci] === '}' && fullLine[ci + 1] === '}') {
        braceDepth--;
        if (braceDepth === 0) { templateEnd = ci; break; }
        ci++;
      }
    }
    // 如果当前行未闭合，继续拼接后续行
    while (templateEnd < 0 && li + 1 < lines.length) {
      li++;
      fullLine += '\n' + lines[li];
      // ★ 2026-08-03 修复：每轮重扫前重置 braceDepth（此前跨轮累计，
      //   含 map1/map2/map3 深层嵌套的模板（如 1win Essence II 淘汰赛 R#M#）
      //   累计值永不归零 → templateEnd 永远 -1 → 整场丢弃 → 对阵 UPCOMING 恒为 0；
      //   短模板则"带病成功"（吞掉后续行后才偶然闭合，body 混入多余行）。
      braceDepth = 0;
      for (var ci2 = 0; ci2 < fullLine.length - 1; ci2++) {
        if (fullLine[ci2] === '{' && fullLine[ci2 + 1] === '{') { braceDepth++; ci2++; }
        else if (fullLine[ci2] === '}' && fullLine[ci2 + 1] === '}') {
          braceDepth--;
          if (braceDepth === 0) { templateEnd = ci2; break; }
          ci2++;
        }
      }
    }
    if (templateEnd < 0) continue;
    // 提取模板 body
    var bodyStart = fullLine.indexOf('{{Match') + 2;
    // 找到 Match 后的第一个 |
    var pipeIdx = fullLine.indexOf('|', bodyStart);
    if (pipeIdx < 0) continue;
    var body = fullLine.substring(bodyStart, templateEnd);
    // 解析参数
    var fields = parseMatchFields(body);
    if (!fields) continue;
    if (fields.empty) continue;   // 2026-10-31：双方待定的时间骨架不进赛程列表（bracket 专用）
    // ★ v3 优化项23：注入 section 上下文
    fields.section = currentSection;
    fields.subsection = currentSubsection;
    matches.push(fields);
  }
  // 去重：同队对+同日期的对阵只保留一个（Liquipedia 可能在不同 Matchlist 中重复）
  var seen = {};
  var deduped = [];
  matches.forEach(function (mch) {
    var key = mch.team1Name + '__' + mch.team2Name + '__' + mch.startTime;
    if (!seen[key]) {
      seen[key] = true;
      deduped.push(mch);
    }
  });
  return deduped;
}

// 解析 {{Match}} 模板参数，提取对阵信息
// ★ 2026-10-26（P3.0）：`allowNoDate` —— bracket 槽位常无 date，传 true 时保留（startTime=0）。
function parseMatchFields(body, allowNoDate) {
  // 去掉开头的 'Match|'
  var afterName = body.replace(/^Match\s*\|\s*/, '');
  var parts = splitTopLevel(afterName, '|');
  var fields = {};
  parts.forEach(function (part) {
    part = part.trim();
    var eqIdx = part.indexOf('=');
    if (eqIdx < 0) return;
    var key = part.substring(0, eqIdx).trim().toLowerCase();
    var val = part.substring(eqIdx + 1).trim();
    fields[key] = val;
  });
  // 提取队名和比分：opponent1={{TeamOpponent|队名|score=N}} 或 {{TeamOpponent|[[队名|显示名]]|score=N}}
  var opp1 = extractTeamOpponent(fields.opponent1 || '');
  var opp2 = extractTeamOpponent(fields.opponent2 || '');
  var team1Name = opp1.name;
  var team2Name = opp2.name;
  // ★ 2026-08-05（v1.1，审核 R1-R5）：一方已确认、一方未确认（{{TeamOpponent|}} 空串）的对局必须保留。
  //   LP 用空字符串表示未确认方（非 TBD 字样）→ 归一为 TBD 占位，交给显示层按「至少一方确定」规则处理；
  //   双方均空（空壳模板，无任何对手信息）→ 仍丢弃（原行为，无展示价值）。
  var missing1 = !team1Name, missing2 = !team2Name;
  // 解析日期（提前到空壳判定之前：总决赛等「双方待定但已排期」的槽位必须保留开赛时间）
  var startTime = parseLiquipediaDate(fields.date || '');
  if (missing1 && missing2) {
    // ★ 2026-10-31：双方均空 = 待定阶段。旧实现直接丢弃 ⇒ 总决赛卡永远没有开赛时分
    //   （实测 PARI R5M1 写明「November 1, 2026 - 14:00 CET」却整槽被丢）。
    //   只在「有日期」时保留时间骨架；无日期空壳仍丢弃（无展示价值，原行为）。
    if (!startTime) return null;
    team1Name = 'TBD';
    team2Name = 'TBD';
  } else {
    if (missing1) team1Name = 'TBD';
    if (missing2) team2Name = 'TBD';
    if (!startTime && !allowNoDate) return null;  // 日期解析失败，跳过（bracket 骨架模式除外）
  }
  // bestof
  var bo = fields.bestof ? parseInt(fields.bestof, 10) : 1;
  var boType = 'BO' + (isNaN(bo) || bo < 1 ? 1 : bo);
  // ★ 2026-08-04：区分「显式声明 bestof」与「缺失默认 BO1」。
  // 缺失时 boType=BO1 只是占位，BO 判定引擎（sources.resolveBoType）会用
  // S2 赛制文本 / S3 series_type / S4 同赛事自证等信号重新决策，避免全判 BO1。
  var boDeclared = !!(fields.bestof && String(fields.bestof).trim());
  // finished
  var finished = fields.finished === 'true' || fields.finished === '1';
  // ★ v3 优化项32（2026-08-03）：字母 score 辅助 finished 判定。
  // TeamOpponent|score=w/l/ff 只在比赛结束后才写入（比分标记），
  // 而数字 score（当前小局分）在 live 比赛中也存在 —— 因此仅字母值判结束。
  // 场景：Liquipedia 打完比赛但未标 finished=true 时，靠此提前进入 recent。
  if (!finished && (opp1.scoreAlpha || opp2.scoreAlpha)) {
    finished = true;
  }
  // ★ v3 优化项33（2026-08-03）：Map 层结果信号判系列结束（P0）。
  // Liquipedia 打完的比赛在 {{Map}} 嵌套模板里写 winner/length（系列赛顶层常不标
  // finished/score，如 1win Essence II 淘汰赛）。信号：
  //   - 任一 map finished=skip → 系列提前结束（如 BO3 2-0 横扫，第三局 skip）
  //   - 某队 winner 局数 ≥ 阈值 → 系列结束
  //   - 全部 map 槽都已打且无队达阈值 → 打满结束（BO2 1-1 平 / BO5 2-2 决胜后）
  // 阈值按 map 槽数推断（页面可能不写 bestof，实测 1win 页面即缺）：1 槽→1，
  // 2 槽→2（BO2/BO3 前两局），3 槽→2，4 槽→2，5 槽→3。
  // ★ 2026-08-12 方案 A：mapSlots 计算提到 finished 守卫外（finished 已为 true 时也要输出）。
  //   mapSlots = {{Match}} 模板显式声明的 map 槽数（字段存在，含空壳 |map1=），
  //   用于 resolveBoType S4.5 信号推断 BO 结构（如 3 槽 → BO3，5 槽 → BO5）。
  //   注意：原 _mapCount（值非空）仍在 finished 块内统计，二者职责分离。
  var mapSlots = 0;
  var _mapKeysAll = ['map1', 'map2', 'map3', 'map4', 'map5'];
  for (var _si = 0; _si < _mapKeysAll.length; _si++) {
    if (_mapKeysAll[_si] in fields) mapSlots++;
  }
  if (!finished) {
    var _mapWins = { '1': 0, '2': 0 };
    var _hasSkip = false;
    var _played = 0;
    var _mapCount = 0;
    var _mapKeys = ['map1', 'map2', 'map3', 'map4', 'map5'];
    for (var _mi = 0; _mi < _mapKeys.length; _mi++) {
      var _mv = fields[_mapKeys[_mi]] || '';
      if (!_mv) continue;
      _mapCount++;
      if (/\|finished\s*=\s*skip/i.test(_mv)) { _hasSkip = true; continue; }
      var _wm = _mv.match(/\|winner\s*=\s*([12])/);
      if (_wm) { _mapWins[_wm[1]]++; _played++; }
    }
    if (_hasSkip) {
      finished = true;
    } else if (_mapCount > 0) {
      var _winTh = _mapCount <= 1 ? 1 : (_mapCount <= 2 ? 2 : Math.ceil(_mapCount / 2));
      if (_mapWins['1'] >= _winTh || _mapWins['2'] >= _winTh) {
        finished = true;
      } else if (_mapCount >= 2 && _played === _mapCount && _played >= 2) {
        finished = true;   // 打满：BO2 1-1 平 / BO5 2-2
      }
    }
  }
  // ★ v3 优化项33（2026-08-03）：提取 OpenDota 比赛 id（P0b 关联 OpenDota 用）。
  // ★ 2026-10-31（P0-1）：补 mapN={{ApiMap|matchid=...}} —— 实测 Match 页 14 槽中 12 槽
  //   只在 map1..map5 内写 matchid，顶层 matchid1/matchid2 根本不存在 ⇒ 旧实现 matchIds 恒空，
  //   对战表无法按 matchId 精确关联 OpenDota 系列（比分借位大面积失败的主因）。
  //   顺序：先按局序收集 mapN，再补顶层显式字段；去重、忽略 0。
  var matchIds = [];
  var _pushMatchId = function (v) {
    var n = parseInt(v, 10);
    if (n > 0 && matchIds.indexOf(n) < 0) matchIds.push(n);
  };
  var _mapKeysForIds = ['map1', 'map2', 'map3', 'map4', 'map5'];
  for (var _ki = 0; _ki < _mapKeysForIds.length; _ki++) {
    var _mapVal = fields[_mapKeysForIds[_ki]];
    if (!_mapVal) continue;
    var _idRe = /\bmatchid\s*=\s*(\d+)/gi;
    var _idM;
    while ((_idM = _idRe.exec(_mapVal))) _pushMatchId(_idM[1]);
  }
  if (fields.matchid) _pushMatchId(fields.matchid);
  if (fields.matchid1) _pushMatchId(fields.matchid1);
  if (fields.matchid2) _pushMatchId(fields.matchid2);
  // walkover（弃权）：0=无弃权, 1=team1弃权, 2=team2弃权
  var walkover = fields.walkover ? parseInt(fields.walkover, 10) : 0;
  // phase 判定（★ v3 优化项④：增加 24h 上界守卫，与 sources.js groupSeries 保持一致）
  var nowSec = Math.floor(Date.now() / 1000);
  var phase;
  if (finished) {
    phase = 'recent';
  } else if (startTime > nowSec) {
    phase = 'upcoming';
  } else if ((nowSec - startTime) < 24 * 3600) {
    phase = 'live';  // 已开赛但未结束，且在 24h 内
  } else {
    phase = 'recent';  // ★ 超 24h 未结束 → 降级为 recent（防僵死数据）
  }
  return {
    team1Name: team1Name,
    team2Name: team2Name,
    empty: missing1 && missing2,   // ★ 2026-10-31：双方待定的「时间骨架」槽位（仅 date 存在时保留）
    score1: opp1.score,   // ★ v3 优化项22：从 TeamOpponent|score=N 提取
    score2: opp2.score,
    walkover: walkover,   // ★ v3 优化项22：弃权标记
    startTime: startTime,
    boType: boType,
    boDeclared: boDeclared,   // ★ 2026-08-04：bestof 显式声明标记（缺失→false，供 resolveBoType 决策）
    finished: finished,
    phase: phase,
    matchIds: matchIds,   // ★ v3 优化项33（2026-08-03）：OpenDota match_id 关联（P0b 去重用）
    mapSlots: mapSlots    // ★ 2026-08-12 方案 A：map 槽数（字段存在计数，含空壳），供 S4.5 BO 推断
  };
}

// ★ 2026-10-31（P0-1）：CI bracket 同步的「槽位 + Match 页」合并（单一实现，供 sync 与测试共用）。
//   合并口径为**兜底**而非覆盖：实测 Match 页常缺 date（startTime=0）、score 也未必写全
//   （LP 的 finished/score 不可靠），而 bracket 内联槽位本身可能有队伍/时间/比分 ⇒ 覆盖会
//   把这些信息抹掉。matchIds 取并集（内联槽位可能只有部分 ApiMap，Match 页另有）。
function mergeMatchSlot(slot, wikitext) {
  if (!slot) return slot;
  if (!wikitext) return slot;
  var body = wikitext.replace(/^\s*\{\{\s*/, '').replace(/\}\}\s*$/, '');
  var rest = body.replace(/^MatchPage\s*\|\s*/, '');
  var f = parseMatchFields('Match|' + rest, true);
  if (!f) return slot;
  var ids = [];
  (slot.matchIds || []).concat(f.matchIds || []).forEach(function (n) {
    var v = parseInt(n, 10);
    if (v > 0 && ids.indexOf(v) < 0) ids.push(v);
  });
  var finished = !!(f.finished || slot.finished);
  // ★ 2026-10-31：两侧都无队伍（总决赛待定）时保持 empty，且不让页面的 'TBD' 覆盖槽位队名；
  //   Match 页仍可能补上 date/bestof（时间骨架槽位就是在这一步拿到时分的）。
  var isEmpty = !!(f.empty && slot.empty);
  return Object.assign({}, slot, {
    empty: isEmpty,
    team1Name: (f.empty ? '' : f.team1Name) || slot.team1Name,
    team2Name: (f.empty ? '' : f.team2Name) || slot.team2Name,
    score1: f.score1 || slot.score1 || 0,
    score2: f.score2 || slot.score2 || 0,
    walkover: f.walkover || slot.walkover || 0,
    startTime: f.startTime || slot.startTime || 0,
    boType: (f.boDeclared || !slot.boDeclared) ? f.boType : slot.boType,
    boDeclared: !!(f.boDeclared || slot.boDeclared),
    finished: finished,
    phase: finished ? 'recent' : (f.phase || slot.phase || 'upcoming'),
    matchIds: ids,
    mapSlots: f.mapSlots || slot.mapSlots || 0
  });
}

// 从 {{TeamOpponent|队名|score=N}} 嵌套模板中提取队名和比分
// ★ v3 优化项22：新增 score 提取，从 TeamOpponent 模板的 score=N 参数获取
// 输入 '{{TeamOpponent|team falcons|score=2}}' → { name: 'team falcons', score: 2 }
// 输入 '{{TeamOpponent|[[Team Spirit|TS]]|score=1}}' → { name: 'TS', score: 1 }
// 输入 '{{TeamOpponent}}' → { name: '', score: 0 }
// ★ v3 优化项32（2026-08-03）：score 支持字母值（w/l/ff/forfeit），
//   用于 parseMatchFields 判 finished。scoreAlpha 非空 = 该场已结束（比分标记）。
//   数字值（score=2）在 live 比赛中是当前小局分，不代表结束 —— 因此
//   scoreAlpha 与 score（数字）严格分离，避免把 live 误判成 recent。
// 输入 '{{TeamOpponent|team1|score=w}}' → { name: 'team1', score: 0, scoreAlpha: 'w' }
// ★ 2026-10-31（P0-1）：嵌套安全解析（旧实现用 /\{\{TeamOpponent\s*\|([^}]*)\}\}/ 遇
//   `{{TeamOpponent|LEGION|substitutes={{PlayerSubstitutions|...}}}}` 会在内层 `}}` 处截断，
//   把 `|substitutes={{PlayerSubstitutions...` 整段当成队名（实测 R1M6/R3M1 队名污染）。
//   改为：找模板起点 → findTemplateEnd 深度计数取完整模板 → splitTopLevel 取顶层参数。
// 内部：返回 {{TeamOpponent|...}} 的完整模板体（不含外层 {{ }}），未找到返回 ''。
function teamOpponentBody(raw) {
  if (!raw) return '';
  var startMatch = raw.match(/\{\{\s*TeamOpponent\b/i);
  if (!startMatch) return '';
  var start = startMatch.index;
  var end = findTemplateEnd(raw, start);
  if (end < 0) return '';
  return raw.substring(start + 2, end);
}

function extractTeamOpponent(raw) {
  if (!raw) return { name: '', score: 0, scoreAlpha: '' };
  var body = teamOpponentBody(raw);
  if (!body) return { name: '', score: 0, scoreAlpha: '' };
  // 去掉模板名与紧随的 |，再按顶层 | 分割（内层模板/链接内的 | 不参与分割）
  var rest = body.replace(/^\s*TeamOpponent\b/i, '').replace(/^\s*\|/, '');
  var parts = splitTopLevel(rest, '|');
  var score = 0;
  var scoreAlpha = '';
  var positional = '';
  var namedTeam = '';
  for (var i = 0; i < parts.length; i++) {
    var part = (parts[i] || '').trim();
    if (!part) continue;
    var eq = part.indexOf('=');
    if (eq >= 0) {
      var key = part.substring(0, eq).trim().toLowerCase();
      // 提取 score=N 参数（字母或数字）—— 仅顶层参数
      if (key === 'score' && !score && !scoreAlpha) {
        var sv = part.substring(eq + 1).trim().replace(/\s+/g, '');
        var sm = sv.match(/^([a-zA-Z]+\d*|\d+)/);
        if (sm) {
          var v = sm[1].toLowerCase();
          if (/^\d+$/.test(v)) score = parseInt(v, 10);
          else scoreAlpha = v;
        }
      } else if (!namedTeam && (key === 'team' || key === 'name' || key === 'team1' || key === 'name1')) {
        namedTeam = part.substring(eq + 1).trim();
      }
      continue;
    }
    if (!positional) positional = part;
  }
  // 队名优先级：team=/name= 命名参数 > 第一个位置参数（兼容 |flag=ru|Team Spirit 写法）
  var rawName = namedTeam || positional;
  if (!rawName) return { name: '', score: score, scoreAlpha: scoreAlpha };
  var tplIdx = rawName.indexOf('{{');   // 位置参数仍混入内层模板时截断保护
  if (tplIdx >= 0) rawName = rawName.substring(0, tplIdx);
  var linkMatch = rawName.match(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/);
  var name;
  if (linkMatch) {
    name = linkMatch[2] ? linkMatch[2].trim() : linkMatch[1].split('/').pop().trim();
  } else {
    name = stripWikitextMarkup(rawName).trim();
  }
  // ★ 2026-10-31（P0-1）：统一走 names.sanitizeTeamName（剥系统文案/尾部括号，如 'LEGION (stack)' → 'LEGION'）
  name = names.sanitizeTeamName(name);
  return { name: name, score: score, scoreAlpha: scoreAlpha };
}

// 从 {{TeamOpponent|队名}} 嵌套模板中提取队名
// 输入 '{{TeamOpponent|team falcons}}' → 'team falcons'
// 输入 '{{TeamOpponent|[[Team Spirit|TS]]}}' → 'TS'
// 输入 '{{TeamOpponent}}' → ''
function extractTeamOpponentName(raw) {
  return extractTeamOpponent(raw).name;
}

// 解析 Liquipedia 日期格式为 unix 秒
// ★ v3 优化项24：保留时区信息并正确转换为 UTC（原代码去掉时区缩写后按 UTC 解析，偏差可达数小时）
// 输入 'April 22, 2024 - 13:00 {{Abbr/CEST}}' → 按解析出的时区偏移转换为 UTC 秒
// 输入 '2024-04-22 13:00' → 按 UTC 解析
// 失败返回 0
// 时区偏移表（常见电竞赛事时区）
var TZ_OFFSET = {
  'UTC': 0, 'GMT': 0,
  'CEST': 2, 'CET': 1,    // 欧洲
  'EST': -5, 'EDT': -4,   // 美东
  'PST': -8, 'PDT': -7,   // 美西
  'CST': 8,               // 中国（也可能是美中 -6，但 Dota2 赛事多用北京时间）
  'KST': 9,               // 韩国
  'MSK': 3,               // 莫斯科
  'TRT': 3,               // 土耳其
  'GST': 4,               // 海湾标准时间
  'BRT': -3,              // 巴西
  'ICT': 7,               // 印度支那
  'WIB': 7,               // 印尼西部
  // ★ v3 优化项34（2026-08-03）：补常见赛事时区。
  // ALMT 缺失曾导致 GotF 2026（哈萨克斯坦，阿斯塔纳）全部时间偏晚 6h：
  // 18:50 ALMT 被当 18:50 UTC → 本应 LIVE 的 20:50 北京对局被误判 upcoming。
  // 2026-08-03 修正：ALMT = UTC+5（哈萨克斯坦 2024-03 起全国统一 AQTT/UTC+5），
  // 勿用历史 ALMT=UTC+6。交叉验证：GotF 排期 18:50 ALMT=13:50 UTC vs OpenDota
  // 实际开赛 13:52:08 UTC（差 2 分钟=排期 vs 实际）；+6 则差 1 小时不吻合。
  'ALMT': 5,              // 哈萨克斯坦（阿斯塔纳）—— 2024-03 起 UTC+5
  'YEKT': 5,              // 叶卡捷琳堡
  'EEST': 3,              // 东欧夏令时
  'IDT': 3,               // 以色列夏令时
  'AST': 3,               // 阿拉伯标准时间（利雅得；注意与美东大西洋 -4 歧义，电竞赛事多为中东 +3）
  'SGT': 8, 'HKT': 8,     // 新加坡 / 香港
  'JST': 9,               // 日本
  'SAST': 2, 'CAT': 2,    // 南非 / 中非
  'WAT': 1,               // 西非
  'AEST': 10, 'AEDT': 11, // 澳大利亚
  'NZST': 12              // 新西兰
};
function parseLiquipediaDate(dateStr) {
  if (!dateStr) return 0;
  // 去掉 {{Abbr/XXX}} 等模板但保留时区名文本
  // 2026-08-03 修复（C7 时区）：原 `\{\{[^}]*\}\}` 把 {{Abbr/CEST}} 整个连时区缩写一起
  // 删除，导致 tzMatch 提取不到 → offset=0 → 如 14:00 CEST 被当成 14:00 UTC（偏晚 2h）。
  // 现先将 {{Abbr/CEST}} 替换为 'CEST'（保留时区名），再剥除其余模板。
  var cleaned = dateStr
    .replace(/\{\{Abbr\/([^}|]+)\}\}/gi, '$1')
    .replace(/\{\{[^}]*\}\}/g, '')
    .trim();
  // 提取时区缩写（在时间末尾）
  var tzMatch = cleaned.match(/\s+([A-Z]{3,5})\s*$/);
  var tzAbbr = tzMatch ? tzMatch[1] : '';
  // 去掉时区缩写尾部
  cleaned = cleaned.replace(/\s+[A-Z]{3,5}\s*$/, '').trim();
  // 查时区偏移表（未命中默认 0，退化为原行为）
  var tzOffset = TZ_OFFSET[tzAbbr] != null ? TZ_OFFSET[tzAbbr] : 0;
  // P3（2026-08-03）：时区缩写未命中表 → 按 UTC 解析可能偏时（CEST 偏 2h / ALMT 偏 6h 两次踩坑
  // 均为静默失败）。警告便于及时补表——数据异常属非预期问题，用 warn（豁免规则：见文件头说明）。
  // eslint-disable-next-line no-console-warn-in-production
  if (tzAbbr && TZ_OFFSET[tzAbbr] == null) {
    console.warn('[liquipedia-parse] 未知时区缩写 "' + tzAbbr + '"（' + dateStr + '），按 UTC 解析，可能偏时');
  }
  // 尝试解析 "April 22, 2024 - 13:00" 格式
  var m1 = cleaned.match(/(\w+)\s+(\d+),\s*(\d{4})\s*[-–]?\s*(\d{1,2}):(\d{2})/);
  if (m1) {
    var monthMap = {
      'january': 0, 'february': 1, 'march': 2, 'april': 3, 'may': 4, 'june': 5,
      'july': 6, 'august': 7, 'september': 8, 'october': 9, 'november': 10, 'december': 11
    };
    var monthIdx = monthMap[m1[1].toLowerCase()];
    if (monthIdx == null) return 0;
    // 按时区偏移计算 UTC 时间：本地时间 - tzOffset = UTC 时间
    var d = new Date(Date.UTC(parseInt(m1[3]), monthIdx, parseInt(m1[2]),
      parseInt(m1[4]) - tzOffset, parseInt(m1[5])));
    return Math.floor(d.getTime() / 1000);
  }
  // 尝试解析 "2024-04-22 13:00" 格式
  var m2 = cleaned.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})/);
  if (m2) {
    var d2 = new Date(Date.UTC(parseInt(m2[1]), parseInt(m2[2]) - 1, parseInt(m2[3]),
      parseInt(m2[4]) - tzOffset, parseInt(m2[5])));
    return Math.floor(d2.getTime() / 1000);
  }
  // 尝试 Date.parse 兜底
  var t = Date.parse(cleaned);
  if (!isNaN(t)) return Math.floor(t / 1000);
  return 0;
}

// ===== 战队 Logo 解析（§8.3 2026-07-29）=====
// 从战队页 wikitext 中提取 {{Infobox team}} 模板的 image 字段值。
// Liquipedia 战队页结构：
//   {{Infobox team
//   |name=Team Spirit
//   |image=Team_Spirit_logo.png
//   |imagecaption=
//   |...
//   }}
// image 字段是图片文件名（不含 File: 前缀），需配合 imageinfo API 获取可访问 URL。
//
// 返回 { image: 'Team_Spirit_logo.png' } 或 null（未找到模板 / 无 image 字段）
function parseTeamLogo(wikitext) {
  if (!wikitext) return null;
  var tpl = parseTemplate(wikitext, 'Infobox team');
  if (!tpl) return null;
  // image 字段优先，image_dark / logo / logo_dark 兜底（部分战队页用 logo 命名）
  var image = tpl.image || tpl.image_dark || tpl.logo || tpl.logo_dark || null;
  if (!image) return null;
  // parseTemplate 内部已执行 stripWikitextMarkup，但再清理一次防御 [[File:xxx|200px]] 形式
  image = stripWikitextMarkup(image);
  // 去掉可能的 "File:" / "Image:" 前缀（部分页面直接写带命名空间的文件名）
  image = image.replace(/^File:/i, '').replace(/^Image:/i, '').trim();
  // 去掉 | 后的尺寸参数（如 "Team_Spirit_logo.png|200px" → "Team_Spirit_logo.png"）
  image = image.split('|')[0].trim();
  if (!image) return null;
  return { image: image };
}

// ===== 赛事等级解析（§9 2026-07-30，方案A：对齐 Liquipedia Tier 体系）=====
// 从赛事页 wikitext 中提取 {{Infobox league}} 模板的 liquipediatier 字段值。
// Liquipedia 战队页结构：
//   {{Infobox league
//   |name=DreamLeague Season 27
//   |liquipediatier=1
//   |...
//   }}
// liquipediatier 字段是 1-4 的数字（1=最高，4=最低），是 Liquipedia 人工策展的权威分级。
//
// 返回 { tier: 1 } 或 null（未找到模板 / 无 liquipediatier 字段 / 值非数字）
function parseLeagueTier(wikitext) {
  if (!wikitext) return null;
  var tpl = parseTemplate(wikitext, 'Infobox league') || parseTemplate(wikitext, 'Infobox tournament');
  if (!tpl) return null;
  // liquipediatier 是 Liquipedia 标准字段（数字 1-4）
  var raw = tpl.liquipediatier || tpl.tier || null;
  if (!raw) return null;
  // 清理 wikitext 标记 + 提取数字
  raw = stripWikitextMarkup(raw).trim();
  var num = parseInt(raw, 10);
  if (isNaN(num) || num < 1 || num > 4) return null;
  return { tier: num };
}

// ===== 赛制 BO 声明解析（2026-08-04，BO 判定引擎 S2 信号）=====
// 从赛事页 wikitext 的 ==Format== 段提取阶段→BO 映射。
// 实测 1win_Essence/2（页面无任何 bestof 字段，赛制只在 Format 段）：
//   **All matches are {{Abbr/Bo2}}
//   **Grand Final is {{Abbr/Bo5}}, all other matches are {{Abbr/Bo3}}
// 返回 { group, playoff, grandFinal, default }，均为 'BO1'|'BO2'|'BO3'|'BO5' 或 null。
// 变体覆盖（审核 R7）：Abbr/Bo2 / Bo 2 / BO2 / best of 2 / Group Stage: Bo2 / Round robin (Bo2)
function parseBoFormat(wikitext) {
  var out = { group: null, playoff: null, grandFinal: null, default: null };
  if (!wikitext || typeof wikitext !== 'string') return out;
  function extract(txt) {
    if (!txt) return null;
    var m = String(txt).match(/(?:Abbr\/)?Bo\s*(\d)|best\s*of\s*(\d)/i);
    return m ? ('BO' + (m[1] || m[2])) : null;
  }
  // 取某短语后的首个 BO 数字（解决 "Grand Final is Bo5, all other matches are Bo3" 同行双阶段）
  function boAfter(line, pattern) {
    var m = String(line).match(pattern);
    if (!m) return null;
    return extract(String(line).slice(m.index + m[0].length));
  }
  // 取 ==Format== 段（标题层级 2-4 级均可）；无该段则扫全文本兜底
  var seg = wikitext.split(/\n=+\s*Format\s*=+\n/i)[1] || wikitext;
  String(seg).split('\n').forEach(function (line) {
    if (!extract(line)) return;
    var bo = extract(line);
    if (!out.default) out.default = bo;
    var l = line.toLowerCase();
    var gf = boAfter(l, /grand\s*final|决赛/);
    if (gf) out.grandFinal = gf;
    var grp = boAfter(l, /all matches|group|round\s*[- ]?robin|小组/);
    if (grp) out.group = grp;
    var pl = boAfter(l, /all other matches|playoff|淘汰|round\s*of|semi|quarter|upper|lower/);
    if (pl) out.playoff = pl;
  });
  return out;
}

// ===== P3（2026-08-31）：小组积分表 / 淘汰赛对阵解析 =====
// 注意：新版 {{GroupTableLeague}} / {{SwissStandings}} 的 W/L/积分由 LPDB 服务端渲染，
// wikitext 里只有「排名顺序 + 晋级状态色标」。W/L 数字由调用方与 OpenDota 本地聚合
// （sources.getLeagueStandings）互补合并；本解析器输出排名与晋级状态。

// bg 色标 → 中文晋级状态。up/stayup=晋级，down/staydown=淘汰，stay/其它=空。
function _placementOf(bg) {
  var v = (bg || '').toLowerCase();
  if (v === 'up' || v === 'stayup') return '晋级';
  if (v === 'down' || v === 'staydown') return '淘汰';
  return '';
}

// 解析 {{GroupTableLeague|team1=..|bg1=..|title=..|tournament=..}} 与 {{SwissStandings|...}}。
// 页面惯例：{{GroupTableLeague}} 前有 ===Group X=== 三级标题 → 组名；缺失时回退 title。
// {{SwissStandings}}（如 TI2026 瑞士轮）：{{TeamOpponent|队名}} 按排名列出，无 W/L，placement 空。
// 返回 [{ name, teams: [{ rank, name, placement }] }]，无数据返回 []。
function parseGroupStandings(wikitext) {
  if (!wikitext) return [];
  var groups = [];
  // ① {{GroupTableLeague}}：按出现位置扫描，回溯最近的三级标题作组名
  var idx = wikitext.indexOf('{{GroupTableLeague');
  while (idx >= 0) {
    var end = findTemplateEnd(wikitext, idx);
    if (end < 0) break;
    var body = wikitext.substring(idx + 2, end);
    var params = _topLevelParams(body);
    var teams = _orderedPlacementTeams(params);
    if (teams.length) {
      // 回溯最近的三级标题：必须用整行正则匹配（lastIndexOf('===') 会命中
      // '===Group B===' 行的**闭合** ===，导致组名恒为空 → 回退 title='Standings'）
      var before = wikitext.substring(0, idx);
      var groupName = _lastHeader(before, 3);
      if (!groupName) groupName = params.title || '小组';
      groups.push({ name: groupName, teams: teams });
    }
    idx = wikitext.indexOf('{{GroupTableLeague', end);
  }
  // ② {{SwissStandings}}：{{TeamOpponent|队名}} 按排名列出（无 W/L，placement 空）
  var sIdx = wikitext.indexOf('{{SwissStandings');
  if (sIdx >= 0) {
    var sEnd = findTemplateEnd(wikitext, sIdx);
    if (sEnd > 0) {
      var sBody = wikitext.substring(sIdx + 2, sEnd);
      var swissTeams = [];
      var tPos = sBody.indexOf('{{TeamOpponent');
      while (tPos >= 0) {
        var tEnd = findTemplateEnd(sBody, tPos);
        if (tEnd < 0) break;
        // extractTeamOpponent 的正则要求完整 '{{TeamOpponent|...}}' 包裹，须传含大括号的整段；
        // tiebreaker=N（瑞士轮排名辅助参数）不属于队名，剥离防混入显示名
        var tFull = sBody.substring(tPos, tEnd + 2).replace(/\|\s*tiebreaker\s*=\s*\d+\s*/gi, '');
        var opp = extractTeamOpponent(tFull);
        if (opp && opp.name) {
          swissTeams.push({ rank: swissTeams.length + 1, name: opp.name, placement: '' });
        }
        tPos = sBody.indexOf('{{TeamOpponent', tEnd);
      }
      if (swissTeams.length) {
        groups.push({ name: '瑞士轮', teams: swissTeams });
      }
    }
  }
  return groups;
}

// 把模板 body 按 | 顶层分割并解析 key=value（复用 splitTopLevel，保留原始值不剥内层模板）。
function _topLevelParams(body) {
  var params = {};
  var cleaned = body.replace(/^[A-Za-z_]*\s*\|/, '');   // 去掉模板名前缀（如 'GroupTableLeague|'）
  var parts = splitTopLevel(cleaned, '|');
  for (var i = 0; i < parts.length; i++) {
    var part = parts[i].trim();
    if (!part) continue;
    var eq = part.indexOf('=');
    if (eq < 0) continue;
    var key = part.substring(0, eq).trim().toLowerCase();
    if (key) params[key] = part.substring(eq + 1).trim();
  }
  return params;
}

// 在 wikitext 片段中找最后一个指定层级的标题文本（整行匹配，防 lastIndexOf 误中闭合符）。
// {{Stage|X}} 内层模板解析为其第一个参数文本（如 Survival）。
function _lastHeader(text, level) {
  if (!text) return '';
  var lines = text.split('\n');
  var out = '';
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].replace(/\r$/, '');
    var re = level >= 3
      ? /^===\s*([^=].*?)\s*===\s*$/
      : /^==\s*([^=].*?)\s*==\s*$/;
    var m = line.match(re);
    if (m) {
      var t = m[1].trim();
      var stageM = t.match(/^\{\{\s*Stage\s*\|([^}]+)\}\}$/i);
      if (stageM) t = stageM[1].trim();
      if (t) out = t;
    }
  }
  return out;
}

// 从 params 提取 team1..teamN（含 bgN/pbgN 晋级状态），按 rank 升序。
// 晋级状态优先级：pbgN（槽位色带，页面实际渲染的着色，呈连贯阶梯）存在时**严格采用**
// （值为 '' 就是无徽标，不回退 bgN —— 实测 EWC2026 的 bg 值零散过时，
//   如 rank4=down 但实际该队进入 Survival 阶段并未淘汰）；仅当整表无 pbg 时回退 bgN。
function _orderedPlacementTeams(params) {
  var teams = [];
  var rank = 1;
  while (params['team' + rank] != null) {
    var raw = params['team' + rank];
    var name = stripWikitextMarkup(raw || '').trim();
    // 去掉 [[..|显示名]] 之外的残片（stripWikitextMarkup 已处理常见包裹）
    if (name) {
      var placement = '';
      if (params['pbg' + rank] != null) {
        placement = _placementOf(params['pbg' + rank]);
      } else {
        placement = _placementOf(params['bg' + rank]) || _placementOf(params['pbg' + rank]);
      }
      teams.push({ rank: rank, name: name, placement: placement });
    }
    rank++;
    if (rank > 30) break;   // 防御：异常页面最多 30 行
  }
  return teams;
}

// 解析 {{Bracket|<类型>|id=..|R#M#header=..|R#M#={{Match...}}}} 淘汰赛对阵树。
// ★ P3.0（2026-10-26）：改为「结构骨架」解析 —— 每个 R#M# / RxMTP 槽位都输出（空槽也保留），
//   保留 slotNo / comment / side；按 (side, roundNo) 分组，避免 Upper/Lower 共用 R# 被合并。
//   输出 [{ id, type, section, slots, total, filled, rounds: [{ no, side, label, matches }] }]
// 侧区分类（P3.0）：由 HTML 注释 / 表头文本决定，不依赖 type 编码
function classifyBracketSide(text) {
  var t = String(text || '').toLowerCase();
  if (/grand\s*final/.test(t)) return 'final';
  if (/third\s*place|季军/.test(t)) return 'third';
  if (/lower\s*bracket/.test(t)) return 'lower';
  if (/upper\s*bracket/.test(t)) return 'upper';
  if (/qualif|play-?in|survival/.test(t)) return 'qualifier';
  return 'main';
}

function parseBrackets(wikitext) {
  if (!wikitext) return [];
  var brackets = [];
  var idx = wikitext.indexOf('{{Bracket|');
  while (idx >= 0) {
    var end = findTemplateEnd(wikitext, idx);
    if (end < 0) break;
    var body = wikitext.substring(idx + 2, end);
    var type = '';
    var pipe = body.indexOf('|');
    if (pipe < 0) { body = ''; }
    else {
      body = body.substring(pipe + 1);
      var eqPos = body.indexOf('=');
      var pipePos = body.indexOf('|');
      if (pipePos < 0) type = eqPos < 0 ? body.trim() : '';
      else if (eqPos < 0 || pipePos < eqPos) type = body.substring(0, pipePos).trim();
    }
    var section = _lastHeader(wikitext.substring(0, idx), 2);

    var headers = {};
    var slots = [];
    var depth = 0;
    var i = 0;
    var lastComment = '';
    while (i < body.length - 1) {
      if (body.substr(i, 4) === '<!--') {
        var cEnd = body.indexOf('-->', i);
        if (cEnd < 0) break;
        lastComment = stripTags(body.substring(i + 4, cEnd)).trim();
        i = cEnd + 3;
        continue;
      }
      if (body[i] === '{' && body[i + 1] === '{') { depth++; i += 2; continue; }
      if (body[i] === '}' && body[i + 1] === '}') { depth = Math.max(0, depth - 1); i += 2; continue; }
      if (body[i] === '|' && depth === 0) {
        var eq = body.indexOf('=', i);
        var nextPipe = body.indexOf('|', i + 1);
        if (eq < 0 || (nextPipe >= 0 && nextPipe < eq)) { i++; continue; }
        var key = body.substring(i + 1, eq).trim().toLowerCase();
        var valStart = eq + 1;
        while (valStart < body.length && /\s/.test(body[valStart])) valStart++;
        var mh = key.match(/^r(\d+)m(\d+)header$/);
        if (mh) {
          var hEnd = body.indexOf('\n', valStart);
          headers['R' + mh[1] + 'M' + mh[2]] = stripTags(body.substring(valStart, hEnd < 0 ? body.length : hEnd)).trim();
          i = valStart;
          continue;
        }
        var mm = key.match(/^r(\d+)m(\d+)$/);
        var isMtp = key === 'rxmtp';
        if (mm || isMtp) {
          var roundNo = isMtp ? 99 : parseInt(mm[1], 10);
          var slotNo = isMtp ? 0 : parseInt(mm[2], 10);
          var slotKey = isMtp ? 'RxMTP' : ('R' + roundNo + 'M' + slotNo);
          var header = headers[slotKey] || '';
          var fields = null;
          if (body.substr(valStart, 2) === '{{') {
            var mEnd = findTemplateEnd(body, valStart);
            if (mEnd < 0) break;
            var mBody = body.substring(valStart + 2, mEnd);
            if (mBody.replace(/^Match\s*\|?\s*/, '').trim()) fields = parseMatchFields(mBody, true);
            i = mEnd;
          } else {
            i = valStart;
          }
          var side = classifyBracketSide(lastComment || header);
          slots.push({
            slotNo: slotNo, roundNo: roundNo, key: slotKey,
            header: header, comment: lastComment, side: side, empty: !fields || !!fields.empty,
            team1Name: fields ? fields.team1Name : 'TBD',
            team2Name: fields ? fields.team2Name : 'TBD',
            score1: fields ? fields.score1 : 0,
            score2: fields ? fields.score2 : 0,
            walkover: fields ? fields.walkover : 0,
            startTime: fields ? fields.startTime : 0,
            boType: fields ? fields.boType : 'BO1',
            boDeclared: fields ? fields.boDeclared : false,
            finished: fields ? fields.finished : false,
            phase: fields ? fields.phase : 'upcoming',
            matchIds: fields ? fields.matchIds : [],
            mapSlots: fields ? fields.mapSlots : 0
          });
          continue;
        }
        i = valStart;
        continue;
      }
      i++;
    }
    var groups = {};
    var order = [];
    slots.forEach(function (s) {
      var gk = s.side + '|' + s.roundNo;
      if (!groups[gk]) { groups[gk] = []; order.push(gk); }
      groups[gk].push(s);
    });
    var SIDE_ORDER = { upper: 0, main: 1, lower: 2, final: 3, third: 4, qualifier: 5 };
    order.sort(function (a, b) {
      var pa = a.split('|');
      var pb = b.split('|');
      var da = (SIDE_ORDER[pa[0]] == null ? 9 : SIDE_ORDER[pa[0]]) - (SIDE_ORDER[pb[0]] == null ? 9 : SIDE_ORDER[pb[0]]);
      if (da !== 0) return da;
      return Number(pa[1]) - Number(pb[1]);
    });
    var rounds = order.map(function (gk) {
      var list = groups[gk].slice().sort(function (a, b) { return a.slotNo - b.slotNo; });
      var label = '';
      for (var li = 0; li < list.length; li++) { if (list[li].comment) { label = list[li].comment; break; } }
      if (!label) {
        for (var hi = 0; hi < list.length; hi++) { if (list[hi].header) { label = list[hi].header; break; } }
      }
      if (!label) label = '第' + list[0].roundNo + '轮';
      return { no: list[0].roundNo, side: list[0].side, label: label, matches: list };
    });
    var filled = slots.filter(function (s) { return !s.empty; }).length;
    if (slots.length) {
      brackets.push({
        id: (body.match(/id=([A-Za-z0-9]+)/) || [])[1] || '',
        type: type, section: section,
        slots: slots, total: slots.length, filled: filled, rounds: rounds
      });
    }
    idx = wikitext.indexOf('{{Bracket|', end);
  }
  return brackets;
}


module.exports = {
  parseTemplate: parseTemplate,
  splitTopLevel: splitTopLevel,
  stripWikitextMarkup: stripWikitextMarkup,
  stripTags: stripTags,
  parsePrizePool: parsePrizePool,
  collectDates: collectDates,
  findTemplateEnd: findTemplateEnd,
  extractLink: extractLink,
  parseOpponentBlock: parseOpponentBlock,
  parseTeamCardBlock: parseTeamCardBlock,
  parseParticipants: parseParticipants,
  parseLeagueMetadata: parseLeagueMetadata,
  parseScheduledMatches: parseScheduledMatches,
  parseMatchFields: parseMatchFields,         // P3.0：MatchPage 内容解析（供 CI bracket 同步）
  mergeMatchSlot: mergeMatchSlot,             // 2026-10-31：槽位 + Match 页兜底合并（sync 与测试共用）
  parseGroupStandings: parseGroupStandings,   // P3（2026-08-31）：小组积分表（排名+晋级状态）
  parseBrackets: parseBrackets,               // P3（2026-08-31）：淘汰赛对阵树
  parseBoFormat: parseBoFormat,   // ★ 2026-08-04：Format 段 BO 声明解析（BO 判定引擎 S2）
  parseTeamLogo: parseTeamLogo,
  parseLeagueTier: parseLeagueTier,
  extractTeamOpponent: extractTeamOpponent
};

  return module.exports;
})();
// </BUILD:PARSER>

const LP_UA = 'DOTA2-Esports-Hub/1.0 (+https://github.com/re-toke/dota2-esports; 295231347@qq.com)';
const API = 'https://liquipedia.net/dota2/api.php';
const RATE_MS = 2200;       // LP ToS：1 req/2s
const BATCH = 40;           // MediaWiki 单次 titles 上限（普通用户 50，取 40 留余量）
const TTL_SEC = 26 * 3600;  // 与 GitHub 侧同步脚本一致
const MAX_RC_PAGES = 3;     // 增量最多翻 3 页 RecentChanges（1500 条），防止单次过久

// ★ 2026-11-05：v3 → v4 —— 增量差集归一化（SLUG_SET 统一转下划线形态）。
//   重新部署后 `/healthz` 必须回 `buildId: v4-...` 且 `slugSet: 189`（= 烘焙 205 去重后的真实页面数）；
//   若仍回 v3，说明 Playground 里还是旧代码。
//   v5 —— 范围运行期从 Supabase 派生（/sync?scope=1 干跑、scopeVersion / rcScope 可观测）。
const BUILD_ID = 'v8-2026-11-05-scope4';
const SB_URL = (Deno.env.get('SB_URL') || 'https://gkticzdaicpdtxheyxsd.supabase.co').replace(/\/+$/, '');
const SB_KEY = Deno.env.get('SB_SERVICE_KEY') || '';
const SYNC_TOKEN = Deno.env.get('SYNC_TOKEN') || '';

// ★ 2026-11-05（复核发现）：RecentChanges 返回的标题用**空格**，而 rcChanged() 里会把标题
//   统一 `replace(/ /g,'_')` 之后再查集合；但烘焙 SLUGS 里 205 条中有 128 条是空格形态
//   （如 `BLAST/SLAM/8/Southeast Asia`）⇒ 其中 112 条在增量差集里**永远不命中**。
//   ⇒ 集合侧统一转下划线形态（与 rcChanged 同一口径），去重后 189 条。
//   （归一的实现已收敛到 utils/lp-scope.js，此处只保留状态变量）
//
// <BUILD:SCOPE>
const LP_SCOPE = (function () {
  const module = { exports: {} };
  const exports = module.exports;
'use strict';
/**
 * Liquipedia 同步范围的**单一推导实现**。
 *
 * 调用方：
 *   1) `infra/proxy/lp-sync.mjs`（Deno worker）——构建时通过 `<BUILD:SCOPE>` 标记内联；
 *   2) `scripts/test/test-lp-scope.js`——node 单测。
 *
 * 输入两侧来源：
 *   - `baked`：构建期烘焙的本地常量（slugmap ∪ 本地 curation.js），见 build-lp-sync.cjs；
 *   - `events`：Supabase `curation_events` 里的事件（admin 新增/编辑即时生效）。
 *
 * 输出四组口径（刻意分开，不要合并成一组）：
 *   - `fullPages`：`full=1` 抓取的页面。**只取烘焙**——远端并入会让 full 请求数膨胀，
 *     2.2s/批的 ToS 间隔下会顶到定时器超时。
 *   - `rcSlugs`：增量差集过滤口径。烘焙 ∪ 远端全部 slug，只做集合匹配、不产生额外 LP 请求，
 *     所以可以放心并入（新赛事从下一轮增量起就能被捕获）。
 *   - `hot`：`hot=1` 轮询口径。烘焙 ∪ 远端「时间窗口内」的赛事，上限受 `maxHotEvents` 约束。
 *   - `brackets`：`brackets=1` 口径。烘焙优先，远端只补窗口内且确实带 bracket/主页面 slug 的赛事，
 *     远端新增量受 `maxBracketEvents - 烘焙条数` 约束。
 *
 * 任何形如空值、`|`（MediaWiki 多标题分隔符）、超长、控制字符的 slug 一律丢弃，计入 `dropped`。
 */

const MAX_SLUG_LEN = 160;
const BAD_CHAR_RE = /[|\u0000-\u001f]/;

const DEFAULTS = {
  maxSlugs: 5000,           // rcSlugs 上限：仅作防御（远端全量约 2-4k，正常不会触发）
  maxUrgentSlugs: 120,      // 待补抓队列上限（只收「进行中 / 4 个月内开赛」的页面）
  maxHotEvents: 8,          // 热点赛事上限（含烘焙）
  maxBracketEvents: 5,      // 淘汰赛赛事上限（含烘焙）
  hotLeadSec: 2 * 86400,    // 开赛前 2 天进入热点窗口
  hotTailSec: 86400,        // 结束后 1 天内仍在窗口
  urgentDays: 120           // 「近期」窗口：用于新赛事页面的首次补抓
};

/** slug 归一：MediaWiki 标题中空格与下划线等价，但缓存键 `lp:w:<title>` 区分两者 */
function normSlug(v) {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  if (!s || s.length > MAX_SLUG_LEN || BAD_CHAR_RE.test(s)) return '';
  // 连续空白/下划线折叠成单个下划线（与 MediaWiki 的标题归一一致）
  return s.replace(/[\s]+/g, '_').replace(/_+/g, '_');
}

function uniqSlugs(list) {
  const seen = new Set();
  const out = [];
  (list || []).forEach((v) => {
    const s = normSlug(v);
    if (!s || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  });
  return out;
}

const SLUG_FIELDS = ['scheduledMatchesSlug', 'structureSlug', 'bracketSlug', 'liquipediaSlug'];

function eventSlugs(ev) {
  const arr = [];
  if (!ev) return arr;
  SLUG_FIELDS.forEach((f) => { if (ev[f]) arr.push(ev[f]); });
  return arr;
}

/** 与 build-lp-sync.cjs 的 BRACKET_EVENTS 候选顺序保持一致 */
function bracketCandidates(ev) {
  const base = normSlug(ev && ev.liquipediaSlug);
  return uniqSlugs([
    ev && ev.bracketSlug,
    ev && ev.structureSlug,
    ev && ev.scheduledMatchesSlug,
    base ? base + '/Main Event' : '',
    base ? base + '/Playoffs' : '',
    base
  ]);
}

function num(v) {
  const n = Number(v);
  return isFinite(n) && n > 0 ? n : 0;
}

function eventKey(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function deriveScope(input) {
  const baked = (input && input.baked) || {};
  const events = (input && input.events) || [];
  const nowSec = num(input && input.nowSec) || Math.floor(Date.now() / 1000);
  const limits = Object.assign({}, DEFAULTS, (input && input.limits) || {});

  let dropped = 0;
  const drop = (n) => { dropped += (n || 0); };

  // ① 全量抓取口径：仅烘焙（宁可让远端新页面走 bootstrap，也不放大 full 的请求数）
  const fullPages = uniqSlugs(baked.slugs);

  // ② 增量差集口径：烘焙 ∪ 远端四个 slug 字段
  //    排序刻意分层：烘焙 → 「近期/在赛」事件 → 其余按开赛时间倒序，
  //    保证 maxSlugs 截断时丢的是最老的历史页面，绝不会丢掉新赛事
  //    （curation_events 没有 updated_at，按主键顺序截断会随机丢赛事，这是 v5 的实测问题）。
  const urgentCutoff = nowSec + limits.urgentDays * 86400;
  const isUrgent = (ev) => {
    const s = num(ev.start);
    const e = num(ev.end);
    if (!s || !e) return false;
    return nowSec <= e + limits.hotTailSec && s <= urgentCutoff;
  };
  const urgentEvents = events.filter(isUrgent);
  const restEvents = events.filter((ev) => !isUrgent(ev))
    .slice().sort((a, b) => num(b.start) - num(a.start));

  const rcRaw = [];
  (baked.slugs || []).forEach((s) => rcRaw.push(s));
  urgentEvents.forEach((ev) => eventSlugs(ev).forEach((s) => rcRaw.push(s)));
  restEvents.forEach((ev) => eventSlugs(ev).forEach((s) => rcRaw.push(s)));
  let rcSlugs = uniqSlugs(rcRaw);
  if (rcSlugs.length > limits.maxSlugs) {
    drop(rcSlugs.length - limits.maxSlugs);
    rcSlugs = rcSlugs.slice(0, limits.maxSlugs);
  }

  // 待补抓队列候选：只取「进行中 / 4 个月内开赛」的事件页面。
  // 历史页面不进队列——它们由 full=1 或详情页按需回源覆盖，避免为历史页面烧掉几小时的 LP 预算。
  const urgentRaw = [];
  urgentEvents.forEach((ev) => eventSlugs(ev).forEach((s) => urgentRaw.push(s)));
  let urgentSlugs = uniqSlugs(urgentRaw);
  if (urgentSlugs.length > limits.maxUrgentSlugs) {
    drop(urgentSlugs.length - limits.maxUrgentSlugs);
    urgentSlugs = urgentSlugs.slice(0, limits.maxUrgentSlugs);
  }

  // ③ 热点：烘焙（不按其窗口裁剪，窗口在 runHot 里按时间过滤）∪ 远端窗口内赛事
  const hot = [];
  const hotKeys = new Set();
  (baked.hot || []).forEach((ev) => {
    if (!ev) return;
    const slugs = uniqSlugs(ev.slugs);
    if (!slugs.length) return;
    const key = eventKey(ev.n);
    if (hotKeys.has(key)) return;
    hotKeys.add(key);
    hot.push({ n: String(ev.n || ''), s: num(ev.s), e: num(ev.e), slugs });
  });
  const hotRoom = Math.max(0, limits.maxHotEvents - hot.length);
  let hotAdded = 0;
  for (const ev of events) {
    if (hotAdded >= hotRoom) break;
    const s = num(ev.start);
    const e = num(ev.end);
    if (!s || !e) continue;
    if (s - limits.hotLeadSec > nowSec || nowSec > e + limits.hotTailSec) continue;
    const key = eventKey(ev.canonical);
    if (!key || hotKeys.has(key)) continue;
    const slugs = uniqSlugs(eventSlugs(ev));
    if (!slugs.length) continue;
    hotKeys.add(key);
    hot.push({ n: String(ev.canonical || ''), s, e, slugs });
    hotAdded += 1;
  }

  // ④ 淘汰赛：烘焙优先，远端只补窗口内的（候选页顺序与构建脚本一致）
  const brackets = [];
  const brKeys = new Set();
  (baked.brackets || []).forEach((ev) => {
    if (!ev) return;
    const slugs = uniqSlugs(ev.slugs);
    if (!slugs.length) return;
    const key = eventKey(ev.n);
    if (brKeys.has(key)) return;
    brKeys.add(key);
    brackets.push({ n: String(ev.n || ''), id: ev.id == null ? null : ev.id, slugs });
  });
  const brRoom = Math.max(0, limits.maxBracketEvents - brackets.length);
  let brAdded = 0;
  for (const ev of events) {
    if (brAdded >= brRoom) break;
    const s = num(ev.start);
    const e = num(ev.end);
    if (!s || !e) continue;
    if (s - limits.hotLeadSec > nowSec || nowSec > e + limits.hotTailSec) continue;
    if (!ev.bracketSlug && !ev.liquipediaSlug) continue;
    const key = eventKey(ev.canonical);
    if (!key || brKeys.has(key)) continue;
    const slugs = bracketCandidates(ev);
    if (!slugs.length) continue;
    brKeys.add(key);
    brackets.push({ n: String(ev.canonical || ''), id: ev.leagueId == null ? null : ev.leagueId, slugs });
    brAdded += 1;
  }

  return { rcSlugs, urgentSlugs, fullPages, hot, brackets, dropped };
}

module.exports = { deriveScope, normSlug, uniqSlugs, bracketCandidates, DEFAULTS, MAX_SLUG_LEN };

  return module.exports;
})();
// </BUILD:SCOPE>

const SCOPE_KEY = 'lp:scope:snapshot';       // 生效范围的快照（跨冷启动 / 保存待补抓队列）
const SCOPE_TTL_MS = 30 * 60 * 1000;         // 版本未变时也最多 30 分钟重算一次（bump 失败时的兜底）
const SCOPE_BOOT_MAX = 40;                   // 每轮最多补抓的新增页面数（= 1 个 LP 批次）

const BAKED_SCOPE = { slugs: SLUGS, hot: HOT, brackets: BRACKET_EVENTS };
const SCOPE_LIMITS = (LP_SCOPE && LP_SCOPE.DEFAULTS) || {};

function nowSec() { return Math.floor(Date.now() / 1000); }

/** 当前生效范围（烘焙兜底；resolveScope 成功后替换为 烘焙 ∪ 远端） */
let SCOPE = deriveBakedScope();
let SLUG_SET = new Set(SCOPE.rcSlugs);

function deriveBakedScope() {
  return LP_SCOPE.deriveScope({ baked: BAKED_SCOPE, events: [], nowSec: nowSec(), limits: SCOPE_LIMITS });
}

/** 快照 ↔ 内存对象（快照里 hot/brackets 已经是推导结果，直接复用） */
function scopeFromSnapshot(snap) {
  if (!snap || !Array.isArray(snap.rc)) return null;
  return {
    rcSlugs: snap.rc,
    fullPages: Array.isArray(snap.full) ? snap.full : SCOPE.fullPages,
    hot: Array.isArray(snap.hot) ? snap.hot : SCOPE.hot,
    brackets: Array.isArray(snap.brackets) ? snap.brackets : SCOPE.brackets,
    dropped: Number(snap.dropped) || 0
  };
}

let _lastLp = 0;
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** MediaWiki 时间戳格式（无毫秒）：2026-11-05T11:40:00Z */
function isoZ(t) { return new Date(t).toISOString().replace(/\.\d+Z$/, 'Z'); }

function json(body, status) {
  return new Response(JSON.stringify(body, null, 2), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

/** MediaWiki 的 titles 参数：`|` 与 `/` 必须保留原样，否则 LP 侧匹配不到页面 */
function encTitles(titles) {
  return encodeURIComponent(titles.join('|'))
    .replace(/%2F/g, '/').replace(/%7C/g, '|').replace(/%3A/g, ':');
}

async function lpGet(url, label) {
  const wait = _lastLp + RATE_MS - Date.now();
  if (wait > 0) await sleep(wait);
  _lastLp = Date.now();
  const r = await fetch(url, {
    headers: { 'User-Agent': LP_UA, 'Accept': 'application/json', 'Accept-Encoding': 'gzip' },
    signal: AbortSignal.timeout(25000)
  });
  if (r.status === 429) {
    const e = new Error('LP 429 @ ' + label);
    e.rateLimited = true;
    throw e;
  }
  if (r.status !== 200) throw new Error('LP HTTP ' + r.status + ' @ ' + label);
  const j = await r.json();
  if (!j || !j.query) throw new Error('LP 返回无 query @ ' + label);
  return j;
}

/** 批量取页面正文（**不传 redirects**，与 GitHub 侧逐页口径完全一致：重定向页返回其存根） */
async function lpPages(titles) {
  const out = {};
  for (let i = 0; i < titles.length; i += BATCH) {
    const chunk = titles.slice(i, i + BATCH);
    const j = await lpGet(
      API + '?action=query&format=json&prop=revisions&rvprop=content&titles=' + encTitles(chunk),
      'titles[' + chunk.length + ']'
    );
    const pages = (j.query && j.query.pages) || {};
    Object.values(pages).forEach((p) => {
      if (!p || p.missing) return;
      const wt = p.revisions && p.revisions[0] && p.revisions[0]['*'];
      if (!wt) return;
      out[String(p.title || '').replace(/ /g, '_')] = wt;
    });
  }
  return out;
}

/** 写库：数组批量 upsert（每批 25 行，避免单个请求体过大） */
async function sbUpsert(rows, ttlSec) {
  let written = 0;
  const ttl = Number(ttlSec) > 0 ? Number(ttlSec) : TTL_SEC;
  for (let i = 0; i < rows.length; i += 25) {
    const chunk = rows.slice(i, i + 25);
    const body = chunk.map((r) => ({
      key: r.key,
      payload: r.payload,
      expire_at: new Date(Date.now() + ttl * 1000).toISOString(),
      updated_at: new Date().toISOString()
    }));
    const r = await fetch(SB_URL + '/rest/v1/aggregation_cache', {
      method: 'POST',
      headers: {
        apikey: SB_KEY,
        Authorization: 'Bearer ' + SB_KEY,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000)
    });
    if (r.status < 200 || r.status >= 300) {
      throw new Error('Supabase ' + r.status + ': ' + (await r.text()).slice(0, 120));
    }
    written += chunk.length;
  }
  return written;
}

async function sbGet(key) {
  const r = await fetch(
    SB_URL + '/rest/v1/aggregation_cache?key=eq.' + encodeURIComponent(key) + '&select=payload',
    { headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY }, signal: AbortSignal.timeout(15000) }
  );
  if (r.status !== 200) return null;
  const rows = await r.json().catch(() => []);
  return (rows && rows[0] && rows[0].payload) || null;
}

// ============================================================
// 同步范围：运行期从 Supabase 派生（烘焙常量仅作基线/兜底）
//   目标：admin 新增赛事 / 改 slug 后，≤ 一个同步周期（15 min）自动纳入，
//        不再需要重跑 build-lp-sync.cjs、也不需要重新粘贴部署。
// ============================================================

/** curation 版本号（admin-write 每次写入都 bump，但失败时静默 ⇒ 另有 SCOPE_TTL_MS 兜底） */
async function sbCurationVersion() {
  const r = await fetch(
    SB_URL + '/rest/v1/curation_meta?key=eq.version&select=value',
    { headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY }, signal: AbortSignal.timeout(15000) }
  );
  if (r.status !== 200) throw new Error('curation_meta HTTP ' + r.status);
  const rows = await r.json().catch(() => []);
  const v = rows && rows[0] && rows[0].value && rows[0].value.v;
  return v == null ? '' : String(v);
}

/**
 * 全量 curation_events（只取推导所需的 8 个字段，避免整行 data 的 ~600KB 传输）。
 * 任一页失败即抛错（all-or-nothing），调用方沿用上一版范围，防止「范围缩小 + 游标前进」丢更新。
 */
async function sbCurationEvents() {
  const PAGE = 400;
  const out = [];
  for (let off = 0; off < 40000; off += PAGE) {
    const q = '/rest/v1/curation_events?select=canonical_key,league_id' +
      ',ls:data->>liquipediaSlug,sms:data->>scheduledMatchesSlug' +
      ',ss:data->>structureSlug,bs:data->>bracketSlug' +
      ',st:data->>start,en:data->>end' +
      '&limit=' + PAGE + '&offset=' + off;
    const r = await fetch(SB_URL + q, {
      headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY }, signal: AbortSignal.timeout(20000)
    });
    if (r.status !== 200) throw new Error('curation_events HTTP ' + r.status + ' @offset=' + off);
    const rows = await r.json();
    if (!Array.isArray(rows)) throw new Error('curation_events 返回非数组');
    rows.forEach((row) => {
      out.push({
        canonical: row.canonical_key,
        leagueId: row.league_id,
        liquipediaSlug: row.ls,
        scheduledMatchesSlug: row.sms,
        structureSlug: row.ss,
        bracketSlug: row.bs,
        start: Number(row.st) || 0,
        end: Number(row.en) || 0
      });
    });
    if (rows.length < PAGE) break;
  }
  return out;
}

let _snapLoaded = false;
let _snap = null;
let _scopeVer = '';
let _scopeAt = 0;

/**
 * 解析当前同步范围。
 * - 版本未变且快照 < 30min ⇒ 直接用快照（冷启动只花一次 ~15KB 读）；
 * - 否则重算（1 次版本探针 + 分页拉 curation_events），成功后写快照；
 * - 任一步失败 ⇒ 沿用上一版（快照 / 烘焙），绝不部分采纳。
 * - 范围内新增的 slug 进入 local 待补抓队列（快照持久化，每轮最多 40 页），
 *   避免「新赛事详情页要等有人手动 full=1 才有内容」。
 */
async function resolveScope(opts) {
  const o = opts || {};
  const t0 = Date.now();

  if (!_snapLoaded) {
    _snapLoaded = true;
    try { _snap = await sbGet(SCOPE_KEY); } catch (e) { _snap = null; }
    if (_snap) {
      _scopeVer = _snap.ver == null ? '' : String(_snap.ver);
      _scopeAt = Date.parse(_snap.at) || 0;
      const s = scopeFromSnapshot(_snap);
      if (s) { SCOPE = s; SLUG_SET = new Set(SCOPE.rcSlugs); }
    }
  }

  let ver;
  try { ver = await sbCurationVersion(); } catch (e) { ver = undefined; }
  const unknownVer = ver === undefined;
  const fresh = !o.force && !unknownVer && ver === _scopeVer && _scopeAt &&
    Number(_snap && _snap.v) >= 3 &&   // 旧格式快照（v2 的 800 截断 + 611 条历史队列）一律重算
    (Date.now() - _scopeAt < SCOPE_TTL_MS);

  if (fresh) {
    // 版本未变也要排空上一轮遗留的补抓队列，否则「已入队但未抓」的页面会一直卡住
    const drained = await drainPending(o.dry);
    return {
      source: 'snapshot', version: _scopeVer || null,
      rc: SCOPE.rcSlugs.length, full: SCOPE.fullPages.length,
      hot: SCOPE.hot.length, brackets: SCOPE.brackets.length,
      pending: drained.pending, boot: drained.boot, ms: Date.now() - t0
    };
  }

  let events;
  try {
    events = await sbCurationEvents();
  } catch (e) {
    return {
      source: _snap ? 'snapshot' : 'baked', version: _scopeVer || null,
      rc: SCOPE.rcSlugs.length, full: SCOPE.fullPages.length,
      hot: SCOPE.hot.length, brackets: SCOPE.brackets.length,
      error: String((e && e.message) || e), ms: Date.now() - t0
    };
  }

  const derived = LP_SCOPE.deriveScope({
    baked: BAKED_SCOPE, events, nowSec: nowSec(), limits: SCOPE_LIMITS
  });

  // 差集 → 待补抓队列：
  //   · 只收「本轮新发现 + 近期事件」的页面（历史页面不走补抓，避免烧掉几个小时的 LP 预算）；
  //   · 快照 v<3 的遗留队列（v5 实测积压了 611 条历史页面）直接作废，避免继续空转。
  const prevSet = new Set(SCOPE.rcSlugs);
  const urgentSet = new Set(derived.urgentSlugs);
  const carryOver = (_snap && Number(_snap.v) >= 3 && Array.isArray(_snap.pending)) ? _snap.pending : [];
  const pendingAll = [];
  const seenPending = new Set();
  derived.rcSlugs.filter((s) => !prevSet.has(s) && urgentSet.has(s))
    .concat(carryOver)
    .forEach((s) => {
      if (!s || seenPending.has(s)) return;
      seenPending.add(s);
      pendingAll.push(s);
    });

  SCOPE = {
    rcSlugs: derived.rcSlugs, fullPages: derived.fullPages,
    hot: derived.hot, brackets: derived.brackets, dropped: derived.dropped
  };
  SLUG_SET = new Set(SCOPE.rcSlugs);
  if (!unknownVer) _scopeVer = ver;
  _scopeAt = Date.now();

  const prevLastBoot = (_snap && _snap.lastBoot) || null;
  const snapOut = {
    v: 3, ver: _scopeVer || null, at: new Date().toISOString(),
    rc: SCOPE.rcSlugs, full: SCOPE.fullPages, hot: SCOPE.hot, brackets: SCOPE.brackets,
    urgent: derived.urgentSlugs, dropped: SCOPE.dropped, pending: pendingAll,
    lastBoot: prevLastBoot   // 最近一次补抓的实证（tried/fetched/written/error），跨冷启动保留
  };
  _snap = snapOut;
  try { await sbUpsert([{ key: SCOPE_KEY, payload: snapOut }], 90 * 24 * 3600); } catch (e) { /* 快照写失败不影响本轮 */ }

  const drained = await drainPending(o.dry);
  return {
    source: unknownVer ? 'remote(no-version)' : 'remote', version: _scopeVer || null,
    rc: SCOPE.rcSlugs.length, full: SCOPE.fullPages.length,
    hot: SCOPE.hot.length, brackets: SCOPE.brackets.length,
    added: derived.rcSlugs.length - prevSet.size, pending: drained.pending,
    dropped: SCOPE.dropped, boot: drained.boot, ms: Date.now() - t0
  };
}

/**
 * 排空待补抓队列（每轮最多 SCOPE_BOOT_MAX 页，避免突破 LP 速率预算）。
 * 无论抓取成功与否，本轮的尝试项都从队列移除：失败时下一轮继续，不会卡在同一批上。
 */
async function drainPending(dry) {
  const pending = (_snap && Array.isArray(_snap.pending)) ? _snap.pending : [];
  if (dry || !pending.length) return { pending: pending.length, boot: null };
  const bootNow = pending.slice(0, SCOPE_BOOT_MAX);
  let boot = null;
  try {
    const pages = await lpPages(bootNow);
    const rows = Object.keys(pages).map((s) => ({ key: 'lp:w:' + s, payload: pages[s] }));
    const written = rows.length ? await sbUpsert(rows) : 0;
    boot = { tried: bootNow.length, fetched: rows.length, written };
  } catch (e) {
    boot = { tried: bootNow.length, fetched: 0, error: String((e && e.message) || e) };
  }
  _snap.pending = pending.slice(bootNow.length);
  // 持久化「本轮补抓实证」：队列被移除 ≠ 抓取成功，只有这里的 written/error 能证明实际结果
  _snap.lastBoot = Object.assign({ at: new Date().toISOString() }, boot || {});
  try { await sbUpsert([{ key: SCOPE_KEY, payload: _snap }], 90 * 24 * 3600); } catch (e) { /* 忽略 */ }
  return { pending: _snap.pending.length, boot };
}

/** RecentChanges 差集：返回本次需要刷新的 slug（只保留属于同步范围的页面） */
async function rcChanged(sinceIso) {
  let cont = null;
  let pages = 0;
  let newest = sinceIso;
  let oldest = '';
  const titles = [];
  const seen = new Set();
  let scanned = 0;
  do {
    // ⚠️ 必须用 rcend（**较旧**的一端），不是 rcstart。
    //   MediaWiki 的 rcstart 是「从该时刻向过去枚举」——用 rcstart 只会反复扫到游标之前的历史，
    //   newest 永远不前进（2026-11-05 实测：游标卡在 11-04 不动，每次都重扫同一段）。
    const q = '?action=query&format=json&list=recentchanges&rcprop=title|timestamp' +
      '&rclimit=500&rcnamespace=0&rctype=edit|new' +
      (cont ? '&rccontinue=' + encodeURIComponent(cont) : '&rcend=' + encodeURIComponent(sinceIso));
    const j = await lpGet(API + q, 'recentchanges#' + (pages + 1));
    const list = (j.query && j.query.recentchanges) || [];
    scanned += list.length;
    list.forEach((rc) => {
      const ts = String(rc.timestamp || '');
      if (ts && ts > newest) newest = ts;
      if (ts && (!oldest || ts < oldest)) oldest = ts;
      const t = String(rc.title || '').replace(/ /g, '_');
      if (SLUG_SET.has(t) && !seen.has(t)) { seen.add(t); titles.push(t); }
    });
    cont = (j.continue && j.continue.rccontinue) || null;
    pages++;
  } while (cont && pages < MAX_RC_PAGES);
  return { titles, newest, oldest, scanned, truncated: !!cont };
}

async function runFull(titles) {
  const t0 = Date.now();
  const pages_ = (titles && titles.length) ? titles : SCOPE.fullPages;
  const pages = await lpPages(pages_);
  const rows = Object.keys(pages).map((s) => ({ key: 'lp:w:' + s, payload: pages[s] }));
  const written = rows.length ? await sbUpsert(rows) : 0;
  // 全量成功后所有页面都是最新的 ⇒ 游标直接推到当前时刻，避免增量再从 24h 前回扫
  await sbUpsert([{ key: 'lp:rc:cursor', payload: { ts: isoZ(Date.now()), at: new Date().toISOString() } }]);
  return { mode: 'full', fetched: rows.length, written, slugs: pages_.length, ms: Date.now() - t0 };
}

async function runHot(hotList) {
  const t0 = Date.now();
  const now = Date.now() / 1000;
  const list = (hotList && hotList.length) ? hotList : SCOPE.hot;
  const slugs = [];
  list.forEach((ev) => {
    if (ev.s - 2 * 86400 > now || now > ev.e + 86400) return;
    ev.slugs.forEach((s) => { if (slugs.indexOf(s) < 0) slugs.push(s); });
  });
  if (!slugs.length) return { mode: 'hot', events: 0, fetched: 0, written: 0, ms: Date.now() - t0 };
  const pages = await lpPages(slugs);
  const rows = Object.keys(pages).map((s) => ({ key: 'lp:w:' + s, payload: pages[s] }));
  const written = rows.length ? await sbUpsert(rows) : 0;
  return { mode: 'hot', events: list.length, pages: slugs.length, fetched: rows.length, written, ms: Date.now() - t0 };
}

async function runIncremental() {
  const t0 = Date.now();
  const cur = await sbGet('lp:rc:cursor');
  const since = (cur && cur.ts) || new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const rc = await rcChanged(since);
  // 截断时游标只能推进到「本次处理到的最旧一条」，否则中间那段变更会被永久跳过
  const nextCursor = (rc.truncated && rc.oldest) ? rc.oldest : rc.newest;
  if (!rc.titles.length) {
    await sbUpsert([{ key: 'lp:rc:cursor', payload: { ts: nextCursor, at: new Date().toISOString() } }]);
    return { mode: 'incremental', since, scanned: rc.scanned, changed: 0, written: 0, cursor: nextCursor, ms: Date.now() - t0 };
  }
  const pages = await lpPages(rc.titles);
  const rows = Object.keys(pages).map((s) => ({ key: 'lp:w:' + s, payload: pages[s] }));
  const written = rows.length ? await sbUpsert(rows) : 0;
  // 只有写库成功后才推进游标，避免丢更新
  await sbUpsert([{ key: 'lp:rc:cursor', payload: { ts: nextCursor, at: new Date().toISOString() } }]);
  return {
    mode: 'incremental', since, scanned: rc.scanned, truncated: rc.truncated,
    changed: rc.titles.length, fetched: rows.length, written, cursor: nextCursor, ms: Date.now() - t0
  };
}

/** 单个页面正文（结构页/候选页用） */
async function lpPageOne(slug) {
  const map = await lpPages([slug]);
  return map[String(slug).replace(/ /g, '_')] || null;
}

function slotTitleOf(bracketId, slot) {
  return 'Match:ID_' + bracketId + '_R' + String(slot.roundNo).padStart(2, '0') +
    '-M' + String(slot.slotNo).padStart(3, '0');
}

/** 淘汰赛结构 + Match 页 → lp:br:<bracketId> / lp:brl:<leagueId>（与 GitHub 脚本同口径） */
async function runBrackets(bracketList) {
  const t0 = Date.now();
  const list = (bracketList && bracketList.length) ? bracketList : BRACKET_EVENTS;
  const stats = { mode: 'brackets', events: 0, brackets: 0, written: 0, skipped: 0 };
  const filledOf = (bb) => ((bb.slots || []).filter((s) => !s.empty).length);

  for (const ev of list) {
    let found = null;
    for (const slug of ev.slugs) {
      try {
        const wt = await lpPageOne(slug);
        if (!wt) continue;
        const bs = LPParse.parseBrackets(wt);
        if (bs && bs.length) { found = { slug, brackets: bs }; break; }
      } catch (e) {
        if (e.rateLimited) throw e;
      }
    }
    if (!found) { stats.skipped++; continue; }
    stats.events++;

    const primary = found.brackets.filter((bb) => /playoff|淘汰/i.test(String(bb.section || '')))[0] ||
      found.brackets.slice().sort((a, b) => filledOf(b) - filledOf(a))[0] || null;
    let leaguePayload = null;
    const rows = [];

    for (const b of found.brackets) {
      if (!b.id) continue;
      const titles = b.slots.filter((s) => s.side !== 'third').map((s) => slotTitleOf(b.id, s));
      let pageMap = {};
      if (titles.length) {
        try { pageMap = await lpPages(titles); }
        catch (e) { if (e.rateLimited) throw e; }
      }
      const slots = b.slots.map((s) => (s.side === 'third'
        ? s
        : LPParse.mergeMatchSlot(s, pageMap[slotTitleOf(b.id, s).replace(/ /g, '_')])));
      const payload = {
        bracketId: b.id, type: b.type, section: b.section, slug: found.slug,
        slots, total: slots.length, filled: slots.filter((s) => !s.empty).length,
        rounds: b.rounds, updatedAt: Math.floor(Date.now() / 1000)
      };
      if (b === primary) leaguePayload = payload;
      rows.push({ key: 'lp:br:' + b.id, payload });
      stats.brackets++;
    }
    if (leaguePayload && ev.id != null) rows.push({ key: 'lp:brl:' + ev.id, payload: leaguePayload });
    if (rows.length) stats.written += await sbUpsert(rows);
  }
  stats.ms = Date.now() - t0;
  return stats;
}

export default {
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/healthz') {
      // ?snap=1：额外读一次持久化快照（Supabase）。isolate 是易失的，内存里的 SCOPE
      // 可能来自「从未跑过 /sync」的新实例，只有快照能证明同步真的执行过。
      let snap = null;
      if (url.searchParams.get('snap') === '1') {
        try {
          const s = await sbGet(SCOPE_KEY);
          snap = s && {
            v: s.v, ver: s.ver == null ? null : String(s.ver), at: s.at,
            rc: (s.rc || []).length, full: (s.full || []).length,
            pending: (s.pending || []).length, dropped: Number(s.dropped) || 0,
            hot: (s.hot || []).length, brackets: (s.brackets || []).length,
            lastBoot: s.lastBoot || null
          };
        } catch (e) {
          snap = { error: String((e && e.message) || e) };
        }
      }
      return json({
        ok: true,
        buildId: BUILD_ID,
        hasServiceKey: !!SB_KEY,
        hasToken: !!SYNC_TOKEN,
        slugs: SLUGS.length,
        // ★ 2026-11-05：归一化后的集合大小（205 → 189）。与 slugs 对照即可确认「补丁是否已生效」。
        slugSet: SLUG_SET.size,
        // ★ 2026-11-05：运行期范围（烘焙 ∪ 远端 curation）——scope 版本与各口径条数
        rcScope: SCOPE.rcSlugs.length,
        fullPages: SCOPE.fullPages.length,
        scopeVersion: _scopeVer || null,
        scopePending: ((_snap && _snap.pending) || []).length,
        scopeDropped: (_snap && Number(_snap.dropped)) || 0,
        hotEvents: HOT.length,
        bracketEvents: BRACKET_EVENTS.length,
        snap,
        ts: new Date().toISOString()
      });
    }
    if (url.pathname !== '/sync') return json({ error: 'not found', hint: '用 /healthz 或 /sync?token=...' }, 404);
    if (!SYNC_TOKEN || url.searchParams.get('token') !== SYNC_TOKEN) return json({ error: 'bad token' }, 401);
    if (!SB_KEY) return json({ error: 'missing SB_SERVICE_KEY' }, 500);

    try {
      const dry = url.searchParams.get('scope') === '1';
      const scope = await resolveScope({
        force: url.searchParams.get('refresh') === '1',
        dry
      });
      if (dry) return json({ ok: true, mode: 'scope', scope });
      let out;
      if (url.searchParams.get('brackets') === '1') out = await runBrackets(SCOPE.brackets);
      else if (url.searchParams.get('full') === '1') out = await runFull();
      else if (url.searchParams.get('hot') === '1') out = await runHot();
      else out = await runIncremental();
      return json(Object.assign({ ok: true, scope }, out));
    } catch (e) {
      return json({ ok: false, error: String((e && e.message) || e), rateLimited: !!(e && e.rateLimited) }, 502);
    }
  }
};
