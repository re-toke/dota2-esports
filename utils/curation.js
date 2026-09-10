// utils/curation.js
// 常驻「精选权威库」：零网络、永远可用，作为交叉验证的第二个可信来源。
//
// 解决痛点：OpenDota 的赛事名/队名偶尔出现截断、缩写、大小写不一致，导致「赛事信息和
// 队伍队员信息不准确」。本库收录广为人知的重大赛事与战队的「规范名称 + 等级」，与
// OpenDota 等网络源并行采集后交由 consensus.js 投票，从而修正不一致。
//
// 约定：
//   - name / tier       ：权威(high)，优先采用，作为交叉验证基准。
//   - start / end       ：提示性(low)。赛事日期会过期，时间以网络源(OpenDota SQL /
//                         STRATZ / Steam)为准；这里仅作补充/校验，不参与高权重投票。
//   - 用户可在 CURATED_EVENTS / CURATED_TEAMS 中自行增补，无需后端。

const consensus = require('./consensus.js');

// ===== §10 已知脏数据黑名单（按 leagueid）（2026-08-21）=====
// 痛点：OpenDota 的 tier=professional 审核宽松，社区赛/业余对局经常被打成 professional，
//   又因 leagues.js 信任 OpenDota tier 直接映射 S 级，导致脏数据进入列表。
// 典型案例：leagueid=16251 "Party To Play league" —— 有人在 2024-02-11 ~ 2026-08-19
//   长达 920 天里把 836 场杂乱对局都挂到这个 leagueid 下，Liquipedia 不收录（反向验证）。
// 方案：curation 黑名单 + validateLeagueWindow 跨度阈值（util.js）双保险拦截。
const EXCLUDE_LEAGUE_IDS = [
  16251   // Party To Play league —— 非正式赛事，920 天 / 836 场脏数据
];

// 检查 leagueid 是否在黑名单中（参数类型宽松，支持数字或数字字符串）
function isExcludedLeagueId(id) {
  if (id == null) return false;
  var n = Number(id);
  if (!isFinite(n) || n <= 0) return false;
  for (var i = 0; i < EXCLUDE_LEAGUE_IDS.length; i++) {
    if (Number(EXCLUDE_LEAGUE_IDS[i]) === n) return true;
  }
  return false;
}

// ===== 重大赛事（规范名 + 等级 + 可选日期提示）=====
// aliases 含规范名的小写无分隔形式，用于模糊匹配 OpenDota 返回的各种写法。
// start/end 为 Unix 秒（UTC），用于时间交叉验证补强。
const CURATED_EVENTS = [
  // ── TI 系列（S 级，对齐 Liquipedia Tier 1） ──
  { canonical: 'The International 2025', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['theinternational2025', 'ti2025', 'international2025'], year: 2025,
    liquipediaSlug: 'The_International/2025' },
  { canonical: 'The International 2024', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['theinternational2024', 'ti2024', 'international2024'], year: 2024,
    start: Math.floor(Date.UTC(2024, 8, 4) / 1000), end: Math.floor(Date.UTC(2024, 8, 15) / 1000),
    liquipediaSlug: 'The_International/2024' },
  { canonical: 'The International 2023', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['theinternational2023', 'ti2023', 'international2023'], year: 2023,
    liquipediaSlug: 'The_International/2023' },
  { canonical: 'The International 2022', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['theinternational2022', 'ti2022', 'international2022'], year: 2022,
    liquipediaSlug: 'The_International/2022' },
  // TI15 (The International 2026)：2026-08-13 ~ 2026-08-23（含小组赛+主赛事），上海
  // 来源：Liquipedia The_International/2026 + Valve 官方公告
  // 补充字段（2026-07-25）：奖金池/地点/Valve 标记，供「赛事」tab 焦点卡与详情页 curation 兜底使用。
  // 2026-08-11 方案 A+R1：加 leagueId=19719（OpenDota 主赛事 leagueid，触发详情页 redirectTo 真实 id）
  //   + legacyFakeId=-1653808（leagues.js L1080-1103 对 "international2026" 的哈希值，用于老用户关注状态迁移）
  // 2026-08-11 方案 B：participants 由数字 16 改为数组形式（数组触发详情页渲染真实队名+赛区+分组，
  //   参赛队伍已通过 GosuGamers/fragster/17173/百度百科/16score 五源交叉验证，2026-06-29 全部锁定）
  { canonical: 'The International 2026', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['theinternational2026', 'ti2026', 'international2026', 'ti15'], year: 2026,
    leagueId: 19719, legacyFakeId: -1653808,
    start: Math.floor(Date.UTC(2026, 7, 13) / 1000), end: Math.floor(Date.UTC(2026, 7, 23) / 1000),
    prizePool: '$1,600,000', organizer: 'Valve', region: '中国上海', format: '小组赛+双败淘汰',
    participants: [
      // 直接受邀 7 支（Valve 基于 2025-26 赛季成绩邀请）
      { name: 'Aurora Gaming', region: 'EU', group: 'direct' },
      { name: 'BoomBoys', region: 'EU', group: 'direct' },
      { name: 'Team Falcons', region: 'EU', group: 'direct' },
      { name: 'Team Liquid', region: 'EU', group: 'direct' },
      { name: 'Tundra Esports', region: 'EU', group: 'direct' },
      { name: 'Xtreme Gaming', region: 'CN', group: 'direct' },
      { name: 'Team Yandex', region: 'EU', group: 'direct' },
      // 欧洲赛区预选 4 支（2026-06-29 锁定）
      { name: 'Team Spirit', region: 'EU', group: 'qualifier' },
      { name: 'TEAM VISION', region: 'EU', group: 'qualifier' },
      { name: 'HULIGANI', region: 'EU', group: 'qualifier' },
      { name: 'Nigma Galaxy', region: 'EU', group: 'qualifier' },
      // 中国赛区预选 2 支（2026-06-18 锁定）
      { name: 'Team Resilience', region: 'CN', group: 'qualifier' },
      { name: 'Vici Gaming', region: 'CN', group: 'qualifier' },
      // 东南亚赛区预选 1 支
      { name: 'OG', region: 'SEA', group: 'qualifier' },
      // 北美赛区预选 1 支
      { name: 'GamerLegion', region: 'NA', group: 'qualifier' },
      // 南美赛区预选 1 支
      { name: 'LGD Gaming', region: 'SA', group: 'qualifier' }
    ],
    // ★ 2026-08-11：TI 主页 wikitext 不含 {{Match}} 模板（对阵在子页面 Group_Stage 里，
    //   主页仅含 {{Opponent}} 列表 + Infobox）。scheduledMatchesSlug 指向对阵所在子页面，
    //   让详情页对阵 tab 能拉到小组赛 44 场 {{Match}}（2026-08-13 首日 8 场已公布）。
    //   多阶段赛事后续可改为数组（如 ['The_International/2026/Group_Stage', '.../Playoff']）。
    status: '即将到来', liquipediaSlug: 'The_International/2026',
    scheduledMatchesSlug: 'The_International/2026/Group_Stage',
    // ★ P3（2026-08-31）：结构页 slug —— TI2026 排名数据在 /Swiss_Standings 子页
    //   （{{SwissStandings}} 模板，16 队排名顺序），供 getLeagueStructure 解析小组积分。
    structureSlug: 'The_International/2026/Swiss_Standings',
    // ★ 2026-08-12 方案 B（BO 判定引擎 S2 权威信号）：TI 2026 实为 16 队 Swiss BO3（5 源交叉验证：
    //   sportsbrackets/winio/umggaming/bo3.gg/Liquipedia Format 段），Grand Final BO5。
    //   供 resolveBoType S2 按 stageKey 取值（group/playoff/grandFinal），早于比分反推生效。
    //   子页面 wikitext 的 Format 段若解析成功（parseBoFormat），会与本地字段合并增强；
    //   若解析失败或缺失，本字段兜底（TI 2026 子页面 Format 段格式不稳定，本字段为权威源）。
    boFormat: { group: 'BO3', playoff: 'BO3', grandFinal: 'BO5' },
    valve: true, topThirdParty: false },

  // ── 知名 S 级（顶级第三方 S-Tier 巡回赛）2024 ──
  // 2024 起统一 $1M 级奖金，是 Dota2 职业生态骨架
  // ESL One Birmingham 2024 完整条目见下方「ESL One 分站」区块（含 liquipediaSlug/region/status 等）
  // Riyadh Masters：顶级第三方（史上非 TI 最高奖金 $15.12M）
  { canonical: 'Riyadh Masters 2024', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['riyadhmasters2024', 'rm2024', 'riyadh2024'], year: 2024,
    start: Math.floor(Date.UTC(2024, 6, 4) / 1000), end: Math.floor(Date.UTC(2024, 6, 21) / 1000),
    liquipediaSlug: 'Riyadh_Masters/2024' },
  // DreamLeague：ESL 线上联赛，每赛季 $1M，稳定高频
  { canonical: 'DreamLeague Season 23', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['dreamleagueseason23', 'dreamleague23', 'dl2024s23'], year: 2024,
    liquipediaSlug: 'DreamLeague/Season_23' },
  { canonical: 'DreamLeague Season 22', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['dreamleagueseason22', 'dreamleague22', 'dl2024s22'], year: 2024,
    liquipediaSlug: 'DreamLeague/Season_22' },
  { canonical: 'DreamLeague Season 24', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['dreamleagueseason24', 'dreamleague24', 'dl2024s24'], year: 2024,
    liquipediaSlug: 'DreamLeague/Season_24' },
  { canonical: 'DreamLeague Season 25', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['dreamleagueseason25', 'dreamleague25', 'dl2025s25'], year: 2025,
    liquipediaSlug: 'DreamLeague/Season_25' },
  // BetBoom Dacha：高额新秀系列
  { canonical: 'BetBoom Dacha', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['betboomdacha', 'betboomdacha2024', 'bbdacha'], year: 2024,
    liquipediaSlug: 'BetBoom_Dacha' },
  // PGL Wallachia：PGL 三年马拉松系列
  { canonical: 'PGL Wallachia', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['pglwallachia', 'pglwallachia2024', 'wallachia2024'], year: 2024,
    liquipediaSlug: 'PGL/Wallachia/1' },
  { canonical: 'PGL Wallachia Season 2', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['pglwallachia2', 'pglwallachiaseason2', 'wallachia2025'], year: 2025,
    liquipediaSlug: 'PGL/Wallachia/2' },
  // BLAST Slam：BLAST 入局 Dota2 后的新系列
  { canonical: 'BLAST Slam', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['blastslam', 'blastslam2024'], year: 2024,
    liquipediaSlug: 'BLAST/Slam/1' },
  { canonical: 'BLAST Slam II', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['blastslam2', 'blastslamii', 'blastslam2025'], year: 2025,
    liquipediaSlug: 'BLAST/Slam/2' },
  // FISSURE Playground / Universe：高额新秀系列
  { canonical: 'FISSURE Playground', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['fissureplayground', 'fissure', 'fissure2025'], year: 2025,
    liquipediaSlug: 'FISSURE/Playground/1' },
  { canonical: 'FISSURE Universe', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['fissureuniverse', 'fissureuniverse2025'], year: 2025,
    liquipediaSlug: 'FISSURE/Universe/1' },

  // ── S 级（ESL One 统一为 S-Tier，与 tiers.js 的 esl\s+one 规则对齐）2025 ──
  { canonical: 'ESL One Raleigh 2025', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['esloneraleigh2025', 'raleigh2025', 'eslraleigh2025'], year: 2025,
    prizePool: '$1,000,000', organizer: 'ESL', region: '北美', format: '双败淘汰', participants: 16,
    status: '已结束', liquipediaSlug: 'ESL_One/2025/Raleigh', valve: false, topThirdParty: false },
  { canonical: 'Riyadh Masters 2025', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['riyadhmasters2025', 'rm2025', 'riyadh2025'], year: 2025,
    liquipediaSlug: 'Riyadh_Masters/2025' },
  { canonical: 'PGL Astana 2025', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['pglastana2025', 'astana2025', 'pglastana'], year: 2025,
    liquipediaSlug: 'PGL/Astana/2025' },
  // Clavision / Elite League：A-Tier 第三方
  { canonical: 'Clavision Masters', tier: { grade: 'A', rank: 2, label: 'A级' },
    aliases: ['clavisionmasters', 'clavision'], year: 2024,
    liquipediaSlug: 'Clavision/Masters/1' },
  { canonical: 'Elite League', tier: { grade: 'A', rank: 2, label: 'A级' },
    aliases: ['eliteleague', 'eliteleague2024'], year: 2024,
    liquipediaSlug: 'Elite_League/1' },

  // ── 2026 ──
  // DreamLeague Season 26：2026 上半年 ESL Pro Tour 赛事（已举办）
  { canonical: 'DreamLeague Season 26', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['dreamleagueseason26', 'dreamleague26', 'dl2026s26'], year: 2026,
    prizePool: '$1,000,000', organizer: 'ESL', region: '欧洲', format: '双败淘汰',
    participants: 16, status: '已结束', liquipediaSlug: 'DreamLeague/Season_26',
    valve: false, topThirdParty: false },
  // 2026 电竞世界杯 DOTA2 项目：7月7日-7月19日，法国巴黎（顶级第三方，S 级）
  // ⚠️ 2026-07-28 重大修正（依据 Liquipedia 官方页面核实）：
  //   1. 赛期：原存 7/6-8/23 是整个 EWC 多项目嘉年华宽窗口（24 个游戏），DOTA2 项目实际
  //      赛期为 7/7-7/19（小组赛 7/7-7/12 + 突围赛 7/14-7/15 + 淘汰赛 7/16-7/19）。
  //   2. 地点：原存「沙特阿拉伯·利雅得」错误。EWC 2026 原计划在利雅得，但 2026-05-20 官方
  //      宣布 DOTA2 项目移师法国巴黎（Paris Expo Porte de Versailles）。
  //   3. 奖金池：原存 $1,000,000 错误，实际 $2,000,000（冠军 $750,000）。
  //   4. 状态：原存「进行中」错误，7/19 已收官（PARIVISION 3-1 BetBoom 夺冠），应改为「已结束」。
  //   5. 主办方：原存「ESL / Savvy Games」错误，实际为 Esports Foundation / ESL FACEIT Group。
  //   6. liquipediaSlug：原存 'Esports_World_Cup/2026/Dota_2' 404，实际页面为 'Esports_World_Cup/2026'。
  //   7. 参赛队数 24 正确（12 直邀 + 12 预选），保留不变。
  //   今后：curation 的赛期必须存「该游戏项目的实际赛期」，不能存整个嘉年华宽窗口。
  { canonical: 'Esports World Cup 2026', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['esportsworldcup2026', 'ewc2026', 'ewcdota2026'], year: 2026,
    start: Math.floor(Date.UTC(2026, 6, 7) / 1000), end: Math.floor(Date.UTC(2026, 6, 19) / 1000),
    prizePool: '$2,000,000', organizer: 'Esports Foundation / ESL FACEIT Group', region: '法国·巴黎',
    format: '循环小组赛(Bo2) + 突围赛(Bo3) + 单败淘汰(Bo3/Bo5决赛)',
    participants: 24, status: '已结束', liquipediaSlug: 'Esports_World_Cup/2026',
    valve: false, topThirdParty: true },
  // EPL Masters I（ESL / European Pro League Masters 第一季）：DOTA2 线上赛事
  // ⚠️ 关联模型（2026-07-27 第二次修复，对应「修复 A 比赛影响 B 比赛」Bug）：
  //   原别名 'epl2026' / 'eplmasters2026' 过宽，会把 OpenDota 中两个非 DOTA2 / 低级别联赛
  //   也误映射为 "EPL Masters I"，造成列表重复卡 + 详情页队伍错位（被错误应用 CS2 元数据）。
  //   修复方案（精确匹配 + 跨游戏隔离，取代模糊别名）：
  //     ① leagueId 显式 pin：leagueId=19944 是 OpenDota 中该赛事的权威 id，绕过别名漂移；
  //        其它 leagueId（含 19080）即使名称相近也绝不匹配。
  //     ② game='dota2' 跨游戏隔离：CS2 同名「ESL Pro League S24 / EPT Masters」（$1M、10/3–10/11）
  //        一旦误关联，将用 DOTA2 元数据覆盖原赛事；game 校验确保 DOTA2 条目只能匹配 DOTA2 联赛。
  //     ③ 仅保留字面 alias 'epl masters i'，供 canonical 字面名（如 focus / 详情 fallback）查找使用。
  //   —— 今后新增 curation 条目：若 OpenDota 有明确 leagueid，应「显式 pin（leagueId + game）」
  //      而非靠模糊别名；模糊别名只作为 canonical 字面名 fallback。
  //
  // 参赛队伍（2026-07-28 从 Offstage.gg 官方预览 + e-rankings + OpenDota 比赛数据三方核对）：
  //   赛制：Play-In → 小组赛(2 组×6 队, Bo3 循环) → 双败淘汰(Bo3)
  //   Group A：Team Jenz / Syntax / Ilbirs eSports / Level UP / Nemiga Gaming / Zero Tenacity
  //   Group B：PuckChamp / KW / RE Arise / Amaru Gaming / Team Bald(Aion) / Power Rangers
  //   Play-In 淘汰/未晋级：Team Spirit Academy / Dandelions / Team Lynx 等
  //   participants 数组格式与 Liquipedia parseParticipants 输出一致，
  //   refreshMetadataDerived 分支② 会优先使用此数组重建 participantsList（当 Liquipedia 不可用时）。
  // ⚠️ rank 必须遵循统一分级模型（SSS=4/S=3/A=2/B=1），此处原误写为 8，
  // 会导致 sortSmart 按 rank 排序时把 A 级赛事排到 TI(rank 4) 之上（收录错误）。
  { canonical: 'EPL Masters I', tier: { grade: 'A', rank: 2, label: 'A-Tier' },
    leagueId: 19944,
    // ★ 2026-08-31 P0：19944 被 Masters I/II 两届复用，I 也必须带判届窗（见 II 条目注释）。
    //   窗口从 OpenDota 该 league 首场比赛前一周（7/13）到官方赛期结束 + 1 天宽限（8/13）。
    leagueIdWindow: { from: Math.floor(Date.UTC(2026, 6, 13) / 1000), to: Math.floor(Date.UTC(2026, 7, 13) / 1000) },
    game: 'dota2',
    aliases: ['epl masters i'], year: 2026,
    start: Math.floor(Date.UTC(2026, 6, 20) / 1000), end: Math.floor(Date.UTC(2026, 7, 12) / 1000),
    prizePool: '$100,000', organizer: 'EPL', region: '欧洲/CIS · 线上',
    format: 'Play-In + 小组赛(Bo3) + 双败淘汰(Bo3)',
    participants: [
      // ── Group A ──
      { name: 'Nemiga Gaming', region: '欧洲/白俄罗斯', group: 'A' },
      { name: 'Zero Tenacity', region: 'CIS/多国', group: 'A' },
      { name: 'Ilbirs Esports', region: 'CIS/哈萨克斯坦', group: 'A' },
      { name: 'Level UP esports', region: '欧洲/俄罗斯', group: 'A' },
      { name: 'Team Syntax', region: '欧洲/土耳其', group: 'A' },
      { name: 'Team Jenz', region: '美洲/秘鲁', group: 'A' },
      // ── Group B ──
      { name: 'PuckChamp', region: '欧洲/多国', group: 'B' },
      { name: 'KW', region: '中东/伊朗', group: 'B' },
      { name: 'RE Arise', region: '欧洲/乌克兰', group: 'B' },
      { name: 'Team Bald', region: '欧洲/北欧', group: 'B' },
      { name: 'Power Rangers', region: '欧洲/俄罗斯', group: 'B' },
      { name: 'Amaru Gaming', region: '美洲/秘鲁', group: 'B' },
      // ── Play-In（已淘汰/未晋级小组赛，但有比赛记录在 league 19944 中）──
      { name: 'Team Spirit Academy', region: '欧洲/俄罗斯', group: 'Play-In' },
      { name: 'Dandelions', region: '中国', group: 'Play-In' },
      { name: 'Team Lynx', region: '欧洲/俄罗斯', group: 'Play-In' },
      { name: 'Aion', region: '欧洲/北欧', group: 'Play-In' }
    ],
    // ★ 2026-08-14：赛事已于 2026-08-12 结束，status 由 '进行中' 改为 '已结束'。
    //   配合 leagues.js / league-detail.js 的「时间窗口守卫」（方案 B），
    //   即使本字段未及时更新，也不会再卡死为「僵尸进行中」。
    status: '已结束', liquipediaSlug: 'EPL/Masters/1',
    valve: false, topThirdParty: true },

  // ── 2026-08-31 P0 补录：EPL Masters II（19944 复用届次，时间窗判届）──
  // EPL 两届复用同一 OpenDota league entity（leagueid 19944）：
  //   Masters I：2026-07-20 ~ 08-12（已结束）
  //   Masters II：2026-08-30 ~ 09-10（进行中，Liquipedia EPL/Masters/2 实锤：
  //   sdate=2026-08-30 / edate=2026-09-10 / 16 队 / $100,000 / liquipediatier=3）
  // LEAGUE_ID_INDEX 为「一 ID 一条目」，因此 19944 的 pin 必须带时间窗（leagueIdWindow）：
  //   调用时刻落在哪个届次赛期内就解析为哪一届（详见 buildLookups 判届逻辑）。
  // 名称匹配（无 leagueId ctx）不受影响——OpenDota 当届显示名 "EPL Masters 2026" 按字面走。
  // ⚠️ 别名只留 'epl masters ii'：曾试加 'epl masters 2'（normName=eplmasters2），被
  //   名称宽松匹配的「纯数字后缀」规则吞掉 "EPL Masters 2026"（eplmasters2026 前缀命中），
  //   违反 2026-07-27「无 ctx 不猜」原则，测试 8 连挂——数字类短别名禁用。
  { canonical: 'EPL Masters II', tier: { grade: 'A', rank: 2, label: 'A-Tier' },
    leagueId: 19944,
    leagueIdWindow: { from: Math.floor(Date.UTC(2026, 7, 13) / 1000), to: Math.floor(Date.UTC(2026, 8, 12) / 1000) },
    game: 'dota2',
    aliases: ['epl masters ii'], year: 2026,
    start: Math.floor(Date.UTC(2026, 7, 30) / 1000), end: Math.floor(Date.UTC(2026, 8, 10) / 1000),
    prizePool: '$100,000', organizer: 'EPL', region: '欧洲/CIS · 线上',
    format: '小组赛(2×6 Bo3 循环) + 双败淘汰(Bo3)',
    // ★ 2026-09-01（v8.4 Fix-F）：participants 由数字 16 升级为 16 队数组（Liquipedia EPL/Masters/2
    //   官方名单实锤）。根因：19944 被 Masters I/II 复用，OpenDota /leagues/19944/matches 返回两届
    //   混合数据，详情页按判届窗口过滤后仍混入 Masters I 季后赛残留（Nemiga/RE ARISE/Syntax）+
    //   Masters II 预选赛队伍（FTS/Summer Bear）+ 跨届同名双 id（Zero Tenacity）→ 推导出 19 队。
    //   提供人工策展数组后，详情页「策展数组优先重建」（league-detail.js Fix-F）以 16 队为准，
    //   不再被推导的 19 覆盖。region 为预估值（非官方字段），group 按官方 Group Stage Seed 分组。
    participants: [
      // ── Group Stage Seed（Liquipedia 官方分组）──
      { name: 'Level UP', region: '欧洲/俄罗斯', group: 'A' },
      { name: 'Pipsqueak+4', region: '欧洲/多国', group: 'A' },
      { name: 'Power Rangers', region: '欧洲/俄罗斯', group: 'A' },
      { name: 'Zero Tenacity', region: 'CIS/多国', group: 'A' },
      { name: 'Klim Sani4', region: 'CIS/乌克兰', group: 'A' },
      { name: 'Team Lynx', region: '欧洲/俄罗斯', group: 'A' },
      { name: '4ikibamboni', region: '欧洲/多国', group: 'B' },
      { name: 'PuckChamp', region: '欧洲/多国', group: 'B' },
      { name: 'Team Spirit Academy', region: '欧洲/俄罗斯', group: 'B' },
      { name: 'Team Synapse', region: '欧洲/多国', group: 'B' },
      { name: 'Inner Circle', region: '欧洲/多国', group: 'B' },
      { name: 'DYNASTY', region: 'CIS/多国', group: 'B' },
      // ── Playoff Seed（邀请制，8/26~30 陆续官宣）──
      { name: 'HULIGANI', region: 'CIS/多国', group: 'Playoff' },
      { name: 'MOUZ', region: '欧洲/德国', group: 'Playoff' },
      { name: 'Natus Vincere', region: '欧洲/乌克兰', group: 'Playoff' },
      { name: 'Yellow Submarine', region: '欧洲/俄罗斯', group: 'Playoff' }
    ],
    status: '进行中', liquipediaSlug: 'EPL/Masters/2',
    valve: false, topThirdParty: true },

  // ── 2026-08-31 P0 补录：RES Unchained 5（BLAST SLAM VIII 预选赛，一 ID 一届无复用）──
  // 用户报告「App 显示 RES Unchained 5EU 进行中，但 Liquipedia 搜不到」根因：
  //   OpenDota 名 "RES Unchained - A Blast Dota Slam VIII Qualifier EU"（leagueid 20142）
  //   vs Liquipedia 页面 "BLAST/Slam/8/Europe/Open Qualifier 1"（标题 RES Unchained 5: BLAST
  //   SLAM VIII Europe Open Qualifier 1）——三源三名的名称碎片化。
  // 此处补 canonical + slug pin：列表显示归一名，详情页可拉 Liquipedia 元数据。
  // SEA 预选同批补录（leagueid 20143，OpenDota 名 RES Unchained - A Blast Dota Slam VIII Qualifier SEA）。
  // 赛期：EU 8/26~8/30（OpenDota 实际开赛 8/26，Liquipedia OQ1 页 8/26-8/27，决赛收尾 8/30）；
  //       SEA 8/26~8/27（OQ2 页面赛期）。tierrank：预选赛按 B 级（B-Tier）收录。
  { canonical: 'RES Unchained 5: BLAST SLAM VIII Europe Qualifier',
    tier: { grade: 'B', rank: 1, label: 'B-Tier' },
    leagueId: 20142,
    game: 'dota2',
    aliases: ['resunchained5eu', 'resunchained5europe', 'resunchainedeu', 'res unchained 5eu'], year: 2026,
    start: Math.floor(Date.UTC(2026, 7, 26) / 1000), end: Math.floor(Date.UTC(2026, 7, 30) / 1000),
    prizePool: '', organizer: 'Relog Media', region: '欧洲 · 线上',
    format: '公开预选（Bo3）',
    participants: 8, status: '进行中', liquipediaSlug: 'BLAST/SLAM/8/Europe',
    valve: false, topThirdParty: false },
  { canonical: 'RES Unchained 5: BLAST SLAM VIII SEA Qualifier',
    tier: { grade: 'B', rank: 1, label: 'B-Tier' },
    leagueId: 20143,
    game: 'dota2',
    aliases: ['resunchained5sea', 'resunchained5southeastasia', 'res unchained 5sea'], year: 2026,
    start: Math.floor(Date.UTC(2026, 7, 26) / 1000), end: Math.floor(Date.UTC(2026, 7, 30) / 1000),
    prizePool: '', organizer: 'Relog Media', region: '东南亚 · 线上',
    format: '公开预选（Bo3）',
    participants: 8, status: '进行中', liquipediaSlug: 'BLAST/SLAM/8/Southeast Asia',
    valve: false, topThirdParty: false },

  // ── 2026 下半年即将到来（Tier 1，来源：Liquipedia Tournaments，已核实日期）──
  // 这些赛事在 OpenDota /leagues 中尚无比赛记录（未开赛），只能靠 curation 进入"即将到来" tab。
  // 日期为 UTC，与 Liquipedia 公布一致；时间以 Liquipedia 为准，此处用于"即将到来"判定。
  // PGL Wallachia Season 9：9月17-27日，布加勒斯特，$1,000,000
  { canonical: 'PGL Wallachia Season 9', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['pglwallachiaseason9', 'pglwallachia9', 'wallachia2026', 'pglwallachia2026'], year: 2026,
    start: 1789603200, end: 1790467200,
    prizePool: '$1,000,000', organizer: 'PGL', region: '罗马尼亚·布加勒斯特', format: '双败淘汰',
    participants: 16, status: '即将到来', liquipediaSlug: 'PGL/Wallachia/9',
    valve: false, topThirdParty: false },
  // BLAST SLAM VIII：9月29日-10月11日，欧洲/马耳他，$750,000
  { canonical: 'BLAST SLAM VIII', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['blastslamviii', 'blastslam8', 'blastslam2026viii', 'blast2026s8'], year: 2026,
    start: 1790640000, end: 1791676800,
    prizePool: '$750,000', organizer: 'BLAST', region: '马耳他', format: '双败淘汰',
    participants: 12, status: '即将到来', liquipediaSlug: 'BLAST/Slam/8',
    valve: false, topThirdParty: false },
  // Esports Nations Cup 2026：11月2-8日，利雅得，$1,500,000（国家级 Tier 1）
  { canonical: 'Esports Nations Cup 2026', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['esportsnationscup2026', 'enc2026', 'nationscup2026'], year: 2026,
    start: 1793577600, end: 1794096000,
    prizePool: '$1,500,000', organizer: 'ESL / Savvy Games', region: '沙特阿拉伯·利雅得', format: '双败淘汰',
    participants: 8, status: '即将到来', liquipediaSlug: 'Esports_Nations_Cup/2026',
    valve: false, topThirdParty: true },
  // BLAST SLAM IX：11月17-29日，欧洲，$750,000
  { canonical: 'BLAST SLAM IX', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['blastslamix', 'blastslam9', 'blastslam2026ix', 'blast2026s9'], year: 2026,
    start: 1794873600, end: 1795910400,
    prizePool: '$750,000', organizer: 'BLAST', region: '欧洲', format: '双败淘汰',
    participants: 12, status: '即将到来', liquipediaSlug: 'BLAST/Slam/9',
    valve: false, topThirdParty: false },

  // ── 2026-08-31 新增：BLAST SLAM IX 三大赛区封闭预选赛（来源：Liquipedia Tournaments Upcoming，
  //    fetch:upcoming 告警触发人工 curation，防止详情页赛期截断。日期为 UTC。）──
  // RES Unchained 6: BLAST SLAM IX 欧洲封闭预选：9月12-13日
  { canonical: 'RES Unchained 6: BLAST SLAM IX Europe Closed Qualifier',
    tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['resunchained6blastslamixeurope', 'resunchained6eu', 'resblastslamixeuq'], year: 2026,
    start: 1789171200, end: 1789257599,
    prizePool: '$25,000', organizer: 'RES Esports', region: '欧洲', format: '封闭预选',
    participants: 8, status: '即将到来', liquipediaSlug: 'RES_Unchained/6/BLAST_SLAM_IX/Europe',
    valve: false, topThirdParty: false },
  // RES Unchained 6: BLAST SLAM IX 东南亚封闭预选：9月12-13日
  { canonical: 'RES Unchained 6: BLAST SLAM IX Southeast Asia Closed Qualifier',
    tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['resunchained6blastslamixsea', 'resunchained6sea', 'resblastslamixseq'], year: 2026,
    start: 1789171200, end: 1789257599,
    prizePool: '$25,000', organizer: 'RES Esports', region: '东南亚', format: '封闭预选',
    participants: 8, status: '即将到来', liquipediaSlug: 'RES_Unchained/6/BLAST_SLAM_IX/Southeast_Asia',
    valve: false, topThirdParty: false },
  // BLAST SLAM IX 中国封闭预选：9月19-20日
  { canonical: 'BLAST SLAM IX China Closed Qualifier',
    tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['blastslamixchina', 'blastslamixcn', 'blastslamixchinaq'], year: 2026,
    start: 1789776000, end: 1789862399,
    prizePool: '$25,000', organizer: 'BLAST', region: '中国', format: '封闭预选',
    participants: 8, status: '即将到来', liquipediaSlug: 'BLAST/Slam/9/China',
    valve: false, topThirdParty: false },

  // ── B 级（B-Tier 区域联赛 + 次级国际赛）──
  { canonical: 'Games of the Future 2024', tier: { grade: 'B', rank: 1, label: 'B级' },
    aliases: ['gamesofthefuture2024', 'gof2024'], year: 2024,
    liquipediaSlug: 'Games_of_the_Future/2024' },
  { canonical: 'ESL One Kuala Lumpur 2024', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['eslkualalumpur2024', 'kualalumpur2024', 'kl2024'], year: 2024,
    prizePool: '$1,000,000', organizer: 'ESL', region: '东南亚', format: '双败淘汰', participants: 16,
    status: '已结束', liquipediaSlug: 'ESL_One/2024/Kuala_Lumpur', valve: false, topThirdParty: false },
  { canonical: 'TritonLeague', tier: { grade: 'B', rank: 1, label: 'B级' },
    aliases: ['tritonleague', 'triton'], year: 2024,
    liquipediaSlug: 'Triton_League' },
  { canonical: 'Dota 2 World Invitational', tier: { grade: 'B', rank: 1, label: 'B级' },
    aliases: ['dotaworldinvitational', 'd2wi'], year: 2024,
    liquipediaSlug: 'Dota_2_World_Invitational' },
  { canonical: 'Mega Arena', tier: { grade: 'B', rank: 1, label: 'B级' },
    aliases: ['megaarena', 'megaarena2025'], year: 2025,
    liquipediaSlug: 'Mega_Arena' },

  // =====================================================================
  // 扩展收录（依据《DOTA2赛事级别分类全景》P0/P1 优化）：
  //   - Riyadh Masters / 电竞世界杯 EWC 全年代（顶级第三方）
  //   - S-Tier 分站（ESL One / BLAST Slam III-IX / PGL Wallachia S3+）
  //   - A-Tier 代表（CCT / Pinnacle 系列）
  //   - DPC 历史赛事（已停办 defunct + Valve 官方 valve 标记）
  // 新增字段：prizePool / organizer / region / format / participants /
  //          status / liquipediaSlug / valve / topThirdParty
  // 说明：奖金池为公开近似值，可在 remoteCuration 热更新中修正。
  // =====================================================================

  // ── Riyadh Masters（顶级第三方，史上非 TI 最高奖金）──
  { canonical: 'Riyadh Masters 2023', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['riyadhmasters2023', 'rm2023', 'riyadh2023'], year: 2023,
    prizePool: '$15,000,000', organizer: 'ESL / Savvy Games', region: '沙特阿拉伯',
    format: '双败淘汰', participants: 20, status: '已结束',
    liquipediaSlug: 'Riyadh_Masters/2023', valve: false, topThirdParty: true },

  // ── 电竞世界杯 EWC（顶级第三方，利雅得）──
  { canonical: 'Esports World Cup 2024', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['esportsworldcup2024', 'ewc2024', 'ewcdota2024'], year: 2024,
    prizePool: '$1,000,000', organizer: 'Savvy Games', region: '沙特阿拉伯',
    format: '双败淘汰', participants: 16, status: '已结束',
    liquipediaSlug: 'Esports_World_Cup/2024/Dota_2', valve: false, topThirdParty: true },
  { canonical: 'Esports World Cup 2025', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['esportsworldcup2025', 'ewc2025', 'ewcdota2025'], year: 2025,
    prizePool: '$1,000,000', organizer: 'Savvy Games', region: '沙特阿拉伯',
    format: '双败淘汰', participants: 16, status: '已结束',
    liquipediaSlug: 'Esports_World_Cup/2025/Dota_2', valve: false, topThirdParty: true },
  // EWC 2026 已在上方（S 级）

  // ── ESL One 分站（统一 S-Tier）──
  { canonical: 'ESL One Birmingham 2024', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['eslonebirmingham2024', 'birminghammajor2024'], year: 2024,
    prizePool: '$1,000,000', organizer: 'ESL', region: '欧洲', format: '双败淘汰',
    participants: 16, status: '已结束', liquipediaSlug: 'ESL_One/2024/Birmingham',
    valve: false, topThirdParty: false },
  { canonical: 'ESL One Bangkok 2024', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['eslonebangkok2024', 'bangkok2024', 'eslbangkok'], year: 2024,
    prizePool: '$1,000,000', organizer: 'ESL', region: '东南亚', format: '双败淘汰',
    participants: 16, status: '已结束', liquipediaSlug: 'ESL_One/2024/Bangkok',
    valve: false, topThirdParty: false },
  // ESL One Raleigh 2025 / Kuala Lumpur 2024 已在上方（已统一 S 级）

  // ── BLAST Slam III-IX（BLAST 入局 Dota2 后的新系列，S-Tier）──
  { canonical: 'BLAST Slam III', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['blastslamiii', 'blastslam3', 'blastslam2025iii'], year: 2025,
    prizePool: '$750,000', organizer: 'BLAST', region: '欧洲', format: '双败淘汰',
    participants: 12, status: '已结束', liquipediaSlug: 'BLAST/Slam/3',
    valve: false, topThirdParty: false },
  { canonical: 'BLAST Slam IV', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['blastslamiv', 'blastslam4', 'blastslam2025iv'], year: 2025,
    prizePool: '$750,000', organizer: 'BLAST', region: '欧洲', format: '双败淘汰',
    participants: 12, status: '已结束', liquipediaSlug: 'BLAST/Slam/4',
    valve: false, topThirdParty: false },
  { canonical: 'BLAST Slam V', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['blastslamv', 'blastslam5', 'blastslam2025v'], year: 2025,
    prizePool: '$750,000', organizer: 'BLAST', region: '欧洲', format: '双败淘汰',
    participants: 12, status: '已结束', liquipediaSlug: 'BLAST/Slam/5',
    valve: false, topThirdParty: false },
  { canonical: 'BLAST Slam VI', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['blastslamvi', 'blastslam6', 'blastslam2026vi'], year: 2026,
    prizePool: '$750,000', organizer: 'BLAST', region: '欧洲', format: '双败淘汰',
    participants: 12, status: '已结束', liquipediaSlug: 'BLAST/Slam/6',
    valve: false, topThirdParty: false },
  { canonical: 'BLAST Slam VII', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['blastslamvii', 'blastslam7', 'blastslam2026vii'], year: 2026,
    prizePool: '$750,000', organizer: 'BLAST', region: '欧洲', format: '双败淘汰',
    participants: 12, status: '已结束', liquipediaSlug: 'BLAST/Slam/7',
    valve: false, topThirdParty: false },

  // ── PGL Wallachia Season 3+（PGL 三年马拉松系列，S-Tier）──
  { canonical: 'PGL Wallachia Season 3', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['pglwallachiaseason3', 'pglwallachia3', 'wallachia2025s3'], year: 2025,
    prizePool: '$1,000,000', organizer: 'PGL', region: '欧洲', format: '双败淘汰',
    participants: 16, status: '已结束', liquipediaSlug: 'PGL/Wallachia/3',
    valve: false, topThirdParty: false },
  { canonical: 'PGL Wallachia Season 4', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['pglwallachiaseason4', 'pglwallachia4', 'wallachia2025s4'], year: 2025,
    prizePool: '$1,000,000', organizer: 'PGL', region: '欧洲', format: '双败淘汰',
    participants: 16, status: '已结束', liquipediaSlug: 'PGL/Wallachia/4',
    valve: false, topThirdParty: false },
  { canonical: 'PGL Wallachia Season 5', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['pglwallachiaseason5', 'pglwallachia5', 'wallachia2026s5'], year: 2026,
    prizePool: '$1,000,000', organizer: 'PGL', region: '欧洲', format: '双败淘汰',
    participants: 16, status: '已结束', liquipediaSlug: 'PGL/Wallachia/5',
    valve: false, topThirdParty: false },

  // ── A-Tier 代表（次级第三方巡回赛）──
  { canonical: 'CCT 2024', tier: { grade: 'A', rank: 2, label: 'A级' },
    aliases: ['cct2024', 'cct2024dota'], year: 2024,
    prizePool: '$250,000', organizer: 'CCT', region: '欧洲', format: '双败淘汰',
    participants: 16, status: '已结束', liquipediaSlug: 'CCT/2024',
    valve: false, topThirdParty: false },
  { canonical: 'CCT 2025', tier: { grade: 'A', rank: 2, label: 'A级' },
    aliases: ['cct2025', 'cct2025dota'], year: 2025,
    prizePool: '$250,000', organizer: 'CCT', region: '欧洲', format: '双败淘汰',
    participants: 16, status: '已结束', liquipediaSlug: 'CCT/2025',
    valve: false, topThirdParty: false },
  { canonical: 'Pinnacle 2024', tier: { grade: 'A', rank: 2, label: 'A级' },
    aliases: ['pinnacle2024', 'pinnacle2024dota'], year: 2024,
    prizePool: '$250,000', organizer: 'Pinnacle', region: '欧洲', format: '双败淘汰',
    participants: 16, status: '已结束', liquipediaSlug: 'Pinnacle/2024',
    valve: false, topThirdParty: false },
  { canonical: 'Pinnacle 2025', tier: { grade: 'A', rank: 2, label: 'A级' },
    aliases: ['pinnacle2025', 'pinnacle2025dota'], year: 2025,
    prizePool: '$250,000', organizer: 'Pinnacle', region: '欧洲', format: '双败淘汰',
    participants: 16, status: '已结束', liquipediaSlug: 'Pinnacle/2025',
    valve: false, topThirdParty: false },

  // ── DPC 历史赛事（Valve 官方，已停办 defunct）──
  // DPC 体系（2015-2023）由 Valve 运营，2023 年后取消，改为第三方巡回赛为主。
  { canonical: 'DPC 2020-2021', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['dpc20202021', 'dpc202021', 'dpc2021'], year: 2021,
    prizePool: '$1,500,000 (估算)', organizer: 'Valve', region: '全球', format: '区域联赛+Major',
    participants: 18, status: '已取消', liquipediaSlug: 'Dota_Pro_Circuit/2020-21',
    valve: true, topThirdParty: false, defunct: true },
  { canonical: 'DPC 2021-2022 Tour', tier: { grade: 'A', rank: 2, label: 'A级' },
    aliases: ['dpc20212022', 'dpc202122', 'dpc2022'], year: 2022,
    organizer: 'Valve', region: '全球', format: '区域联赛(Div I/II)+Major',
    status: '已结束', liquipediaSlug: 'Dota_Pro_Circuit/2021-22',
    valve: true, topThirdParty: false, defunct: true },
  { canonical: 'DPC 2022-2023 Tour', tier: { grade: 'A', rank: 2, label: 'A级' },
    // ⚠️ 2026-07-30 修复别名冲突：移除 'dpc2023'（与 DPC 2023 Tour 共用导致歧义）
    // 'dpc2023' 现专属 DPC 2023 Tour；本赛事靠 'dpc20222023'/'dpc202223' 精确匹配
    aliases: ['dpc20222023', 'dpc202223'], year: 2023,
    organizer: 'Valve', region: '全球', format: '区域联赛(Div I/II)+Major',
    status: '已结束', liquipediaSlug: 'Dota_Pro_Circuit/2022-23',
    valve: true, topThirdParty: false, defunct: true },
  { canonical: 'DPC 2023 Tour', tier: { grade: 'A', rank: 2, label: 'A级' },
    aliases: ['dpc2023tour', 'dpc2023'], year: 2023,
    organizer: 'Valve', region: '全球', format: '区域联赛(Div I/II)+Major',
    status: '已结束', liquipediaSlug: 'Dota_Pro_Circuit/2023',
    valve: true, topThirdParty: false, defunct: true },
  // DPC Major 代表（2017-2020，Valve 官方顶级积分赛，已停办）
  { canonical: 'The Kuala Lumpur Major', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['kualalumpurmajor', 'klmajor2018', 'thekualalumpurmajor'], year: 2018,
    prizePool: '$1,000,000', organizer: 'Valve / PGL', region: '东南亚', format: '双败淘汰',
    participants: 16, status: '已结束', liquipediaSlug: 'The_Kuala_Lumpur_Major',
    valve: true, topThirdParty: false, defunct: true },
  { canonical: 'The Chongqing Major', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['chongqingmajor', 'cqmajor2019'], year: 2019,
    prizePool: '$1,000,000', organizer: 'Valve / Perfect World', region: '中国', format: '双败淘汰',
    participants: 16, status: '已结束', liquipediaSlug: 'The_Chongqing_Major',
    valve: true, topThirdParty: false, defunct: true },
  { canonical: 'MDL Disneyland Paris Major', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['mdldisneylandparismajor', 'parismajor2019'], year: 2019,
    prizePool: '$1,000,000', organizer: 'Valve / MarsTV', region: '欧洲', format: '双败淘汰',
    participants: 16, status: '已结束', liquipediaSlug: 'MDL_Disneyland_Paris_Major',
    valve: true, topThirdParty: false, defunct: true },
  { canonical: 'EPICENTER Major', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['epicentermajor', 'epicenter2019'], year: 2019,
    prizePool: '$1,000,000', organizer: 'Valve / EPICENTER', region: '独联体', format: '双败淘汰',
    participants: 16, status: '已结束', liquipediaSlug: 'EPICENTER_Major',
    valve: true, topThirdParty: false, defunct: true },

  // ── 2026 新增赛事（2026-07-30 补入，防止赛期截断） ──
  { canonical: '1win Essence II', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['1win Essence 2', '1win essence ii', '1win Essence'],
    year: 2026,
    start: Math.floor(Date.UTC(2026, 6, 30) / 1000),
    end: Math.floor(Date.UTC(2026, 7, 5, 23, 59, 59) / 1000),
    liquipediaSlug: '1win_Essence/2' },
  { canonical: 'Games of the Future 2026', tier: { grade: 'A', rank: 2, label: 'A级' },
    aliases: ['games of the future', 'future 2026', 'gotf 2026'],
    year: 2026,
    start: Math.floor(Date.UTC(2026, 6, 31) / 1000),
    end: Math.floor(Date.UTC(2026, 7, 5, 23, 59, 59) / 1000),
    liquipediaSlug: 'Games_of_the_Future/2026' },
  // ★ 2026-09-10（curation 数据老化修复）：补录 9 月赛事（源：v8.20 LP sync 缓存 + 快照窗口）。
  //   背景：curation 停在 8/31 导致首页 ⑥ 段（getUpcomingFromCuration 候选）查不到
  //   RES/PGL/BLAST 的排期 → 首页「即将开始」卡片全缺；leagues 页 curation 补充源同缺。
  //   预选赛未开赛无 OpenDota leagueId → 不带 leagueId（⑥ 段 Steam 自动跳过，走 LP/haglund）。
  { canonical: 'RES Unchained 6: BLAST SLAM IX Europe Closed Qualifier', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['res unchained 6 europe', 'blast slam ix europe qualifier', 'res unchained blast slam ix europe'],
    year: 2026,
    start: Math.floor(Date.UTC(2026, 8, 12) / 1000),
    end: Math.floor(Date.UTC(2026, 8, 13, 23, 59, 59) / 1000),
    liquipediaSlug: 'BLAST/SLAM/9/Europe' },
  { canonical: 'RES Unchained 6: BLAST SLAM IX Southeast Asia Closed Qualifier', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['res unchained 6 sea', 'blast slam ix southeast asia qualifier', 'res unchained blast slam ix sea'],
    year: 2026,
    start: Math.floor(Date.UTC(2026, 8, 12) / 1000),
    end: Math.floor(Date.UTC(2026, 8, 13, 23, 59, 59) / 1000),
    liquipediaSlug: 'BLAST/SLAM/9/Southeast Asia' },
  { canonical: 'PGL Wallachia Season 9', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['pgl wallachia 9', 'wallachia season 9', 'pgl wallachia s9'],
    year: 2026,
    start: Math.floor(Date.UTC(2026, 8, 17) / 1000),
    end: Math.floor(Date.UTC(2026, 8, 27, 23, 59, 59) / 1000),
    liquipediaSlug: 'PGL/Wallachia/Season_9' },
  { canonical: 'BLAST SLAM IX China Closed Qualifier', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['blast slam ix china qualifier', 'blast slam 9 china'],
    year: 2026,
    start: Math.floor(Date.UTC(2026, 8, 19) / 1000),
    end: Math.floor(Date.UTC(2026, 8, 20, 23, 59, 59) / 1000),
    liquipediaSlug: 'BLAST/SLAM/9/China' },
  { canonical: 'BLAST SLAM VIII', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['blast slam 8'],
    year: 2026,
    start: Math.floor(Date.UTC(2026, 8, 29) / 1000),
    end: Math.floor(Date.UTC(2026, 9, 11, 23, 59, 59) / 1000),
    liquipediaSlug: 'BLAST/SLAM/8' },
  { canonical: 'Esports Nations Cup 2026', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['esports nations cup', 'enc 2026'],
    year: 2026,
    start: Math.floor(Date.UTC(2026, 10, 2) / 1000),
    end: Math.floor(Date.UTC(2026, 10, 8, 23, 59, 59) / 1000),
    liquipediaSlug: 'Esports_Nations_Cup/2026' },
  { canonical: 'BLAST SLAM IX', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['blast slam 9'],
    year: 2026,
    start: Math.floor(Date.UTC(2026, 10, 17) / 1000),
    end: Math.floor(Date.UTC(2026, 10, 29, 23, 59, 59) / 1000),
    liquipediaSlug: 'BLAST/SLAM/9' }
];

// ===== 知名战队（team_id -> 规范信息）=====
// tier 字段：标识战队优先级（用于 H2H/资料功能优先覆盖 S-Tier 与 TI 参赛队）
//   - { grade: 'SSS', label: 'TI 参赛' }：历届 TI 主赛事参赛队
//   - { grade: 'S',   label: 'S-Tier' }：长期活跃于 S 级赛事的顶级战队
//   - 缺省：未标注，按普通战队处理
// ⚠️ 重要：team_id 为 OpenDota 当前真实 id（2026-07 经 /teams/{id} + proMatches 对手反查逐项核验）。
// OpenDota 会**复用** team_id，旧 id 已指向完全不同的队（例如 1333179 现为 2017 死数据、
// 2163 现为 Team Liquid、111474 实为 Alliance）。故每隔版本需重新核验，详见项目记忆。
// 标注「⚠️待复核」的 2 支（BetBoom/PARIVISION）因 OpenDota /search 与 /teams 分页受限
// 无法自动解析正确 id，其详情可能仍不准确，需手动补正。（Fnatic 1375614 已校正为 Newbee，HOT_TEAMS 替换为 TL 2163）
const CURATED_TEAMS = {
  10150538: { name: 'LGD Gaming', tag: 'LGD', country: 'CN', tier: { grade: 'S', label: 'S-Tier' },
              aliases: ['lgd', 'lgdgaming', 'psglgd'] },
  7119388:  { name: 'Team Spirit', tag: 'TS', country: 'RU', tier: { grade: 'SSS', label: 'TI 参赛' },
              aliases: ['teamspirit', 'spirit'] },
  36:       { name: 'Natus Vincere', tag: 'NAVI', country: 'UA', tier: { grade: 'SSS', label: 'TI 参赛' },
              aliases: ['natusvincere', 'navi'] },
  2586976:  { name: 'OG', tag: 'OG', country: 'EU', tier: { grade: 'SSS', label: 'TI 参赛' },
              aliases: ['og'] },
  2163:     { name: 'Team Liquid', tag: 'TL', country: 'NL', tier: { grade: 'SSS', label: 'TI 参赛' },
              aliases: ['teamliquid', 'liquid'] },
  1838315:  { name: 'Team Secret', tag: 'SEC', country: 'EU', tier: { grade: 'S', label: 'S-Tier' },
              aliases: ['teamsecret', 'secret'] },
  8291895:  { name: 'Tundra Esports', tag: 'TUN', country: 'EU', tier: { grade: 'SSS', label: 'TI 参赛' },
              aliases: ['tundra', 'tundraesports'] },
  8599101:  { name: 'Gaimin Gladiators', tag: 'GG', country: 'EU', tier: { grade: 'SSS', label: 'TI 参赛' },
              aliases: ['gaimingladiators', 'gg'] },
  // 注：1375614 = Newbee（已解散，2020 年后无比赛）；原误标为 Fnatic 已校正。
  // Fnatic DOTA2 分部已于 2023-02 解散，HOT_TEAMS 中已替换为 Team Liquid(2163)。
  1375614:  { name: 'Newbee', tag: 'NB', country: 'CN', tier: { grade: 'A', label: '历史战队' },
              aliases: ['newbee'] },
  8255756:  { name: 'Evil Geniuses', tag: 'EG', country: 'US', tier: { grade: 'SSS', label: 'TI 参赛' },
              aliases: ['evilgeniuses', 'eg'] },
  9580444:  { name: 'PSG.LGD', tag: 'PSG', country: 'CN', tier: { grade: 'SSS', label: 'TI 参赛' },
              aliases: ['psglgd', 'psgldg'] },
  9895392:  { name: 'Virtus.pro', tag: 'VP', country: 'RU', tier: { grade: 'SSS', label: 'TI 参赛' },
              aliases: ['virtuspro', 'vp'] },
  111474:   { name: 'Alliance', tag: 'ALL', country: 'SE', tier: { grade: 'SSS', label: 'TI 参赛' },
              aliases: ['alliance'] },
  10136357: { name: 'Nigma Galaxy', tag: 'NGX', country: 'EU', tier: { grade: 'SSS', label: 'TI 参赛' },
              aliases: ['nigma', 'nigmagalaxy', 'nigmagx'] },  // 合并原 350190 + 8124688
  8255888:  { name: 'BetBoom Team', tag: 'BB', country: 'RU', tier: { grade: 'S', label: 'S-Tier' },
              aliases: ['betboom', 'betboomteam', 'boomboys'] },  // ★ 2026-08-05（审核 R3）：修正原 7262280（实测不存在），真 BetBoom=8255888（OpenDota 名 BoomBoys/tag=BB）
  10182357: { name: '1w Team', tag: '1W', country: 'RU', tier: { grade: 'A', label: 'A-Tier' },
              aliases: ['1w', '1wteam'] },  // ★ 2026-08-05（审核 R3）：OpenDota 名 '1w'
  8261500:  { name: 'Xtreme Gaming', tag: 'XG', country: 'CN', tier: { grade: 'SSS', label: 'TI 参赛' },
              aliases: ['xtremegaming', 'xg', 'extremegaming'] },
  8574561:  { name: 'Azure Ray', tag: 'AR', country: 'CN', tier: { grade: 'S', label: 'S-Tier' },
              aliases: ['azureray', 'ar'] },
  9467224:  { name: 'Aurora Gaming', tag: 'AUR', country: 'TH', tier: { grade: 'S', label: 'S-Tier' },
              aliases: ['aurora', 'auroragaming'] },
  9247354:  { name: 'Team Falcons', tag: 'FAL', country: 'SA', tier: { grade: 'SSS', label: 'TI 参赛' },
              aliases: ['falcons', 'teamfalcons'] },
  8260824:  { name: 'PARIVISION', tag: 'PARI', country: 'RU', tier: { grade: 'S', label: 'S-Tier' },
              aliases: ['parivision'] },   // ⚠️待复核：id 待替换正确值
  9338413:  { name: 'MOUZ', tag: 'MOUZ', country: 'DE', tier: { grade: 'S', label: 'S-Tier' },
              aliases: ['mouz'] },
  9766941:  { name: 'Talon Esports', tag: 'TLN', country: 'TH', tier: { grade: 'S', label: 'S-Tier' },
              aliases: ['talon', 'talonesports', 'flipstertalon'] },  // OpenDota 现名 FLIPSTER TALON
  726228:   { name: 'Vici Gaming', tag: 'VG', country: 'CN', tier: { grade: 'S', label: 'S-Tier' },
              aliases: ['vici', 'vici gaming', 'vg'] }               // 中国老牌战队，多届 TI 参赛 + EWC 2026 参赛
};

// ===== 历届 TI 参赛队 ID 集合（2022-2026 主赛事）=====
// 用于"双方对战胜负/战队队员资料"功能优先覆盖 TI 参赛队。
// 数据来源：Liquipedia TI 各届主赛事参赛名单（不含预选赛）。
// 注：同一战队 ID 跨届复用，这里合并去重。
const TI_CONTESTANT_TEAM_IDS = [
  // TI 2022 (Singapore)
  10150538, 7119388, 2586976, 1838315, 8599101, 2163, 111474, 10136357,
  8240186, 8252383, 8260824, 8572539, 8444661, 8654067, 8669264, 21,
  // TI 2023 (Seattle)
  10150538, 7119388, 2586976, 1838315, 8291895, 8599101, 2163, 10136357, 8252383, 3925770,
  8444661, 8252383, 9247354, 8572539, 8609307, 8655479, 8210156, 39,
  // TI 2024 (Copenhagen)
  10150538, 7119388, 2586976, 8291895, 8599101, 2163, 111474, 10136357, 8255888,
  8261500, 9247354, 8260824, 8377730, 8210156, 8609307,
  // TI 2026 (Shanghai, 已确认参赛队)
  10150538, 7119388, 8291895, 8599101, 2163, 8261500, 9247354, 7260824
];
// 构建 Set 用于 O(1) 查询
const TI_CONTESTANT_TEAM_SET = (function () {
  const s = {};
  for (let i = 0; i < TI_CONTESTANT_TEAM_IDS.length; i++) {
    s[TI_CONTESTANT_TEAM_IDS[i]] = true;
  }
  return s;
})();

// 判断 team_id 是否为历届 TI 参赛队（用于优先覆盖）
function isTIContestantTeam(teamId) {
  if (teamId == null) return false;
  return !!TI_CONTESTANT_TEAM_SET[Number(teamId)];
}

// 构建「赛事/战队」查找器（可作用于任意数据集合，便于远程覆盖复用）。
// 返回 { eventFor(name, ctx), teamFor(nameOrId) }，逻辑与原 curatedEventFor/curatedTeamFor
// 完全一致，但 eventFor 接受可选 ctx = { leagueId, game }：
//   - leagueId 显式 pin 匹配（最高优先级，绕过别名漂移）
//   - game 校验：若 entry.game 与 ctx.game 同时声明，必须一致；否则拒绝（防 CS2/DOTA2 跨游戏污染）
//   - 两者都缺时保持原行为（向后兼容）
function buildLookups(events, teams) {
  // 赛事名 -> 事件对象（按规范名/别名归一匹配）
  const EVENT_INDEX = {};
  // leagueId -> 事件对象数组（显式 pin，绕过别名漂移；2026-07-27 加）
  // ★ 2026-08-31 P0 判届升级：数组化支持「一 ID 多届」（如 EPL Masters I/II 复用 19944）。
  //   单届条目（无 leagueIdWindow）→ [该条目]，行为与旧版单对象完全一致；
  //   多届条目 → 按 leagueIdWindow {from,to} 判届：调用时刻（ctx.now 或当前时间）落在
  //   窗口内即命中该届。多届均未命中窗口时回退最后一条（宁可错配也不空手——
  //   名称匹配兜底仍可纠正；空手会让「修复 A 影响 B」防线整体失效）。
  const LEAGUE_ID_INDEX = {};
  (events || []).forEach((ev) => {
    if (!ev || !ev.canonical) return;
    EVENT_INDEX[consensus.normName(ev.canonical)] = ev;
    (ev.aliases || []).forEach((a) => { EVENT_INDEX[consensus.normName(a)] = ev; });
    if (ev.leagueId != null) {
      (LEAGUE_ID_INDEX[ev.leagueId] = LEAGUE_ID_INDEX[ev.leagueId] || []).push(ev);
    }
  });
  // leagueId 判届命中：时间窗命中返回该届。未命中窗时的回退策略：
  //   now 早于首届窗口（历史上该 league 尚无第二届数据）→ 回退首届（最早届）；
  //   其余（now 晚于末届窗 / 窗数据缺失）→ 回退末条（最新届）。
  const pinLookup = (leagueId, now) => {
    const arr = LEAGUE_ID_INDEX[leagueId];
    if (!arr || !arr.length) return null;
    if (arr.length === 1) return arr[0];
    const withWin = arr.filter((e) => e && e.leagueIdWindow);
    for (let i = 0; i < arr.length; i++) {
      const w = arr[i].leagueIdWindow;
      if (w && w.from != null && w.to != null && now != null && now >= w.from && now <= w.to) return arr[i];
    }
    if (now != null && withWin.length) {
      const firstWin = withWin[0].leagueIdWindow;
      if (firstWin.from != null && now < firstWin.from) return arr[0];
    }
    return arr[arr.length - 1];
  };
  // 战队名 -> id 反向索引（用于按名查询）
  const NAME_INDEX = {};
  Object.keys(teams || {}).forEach((id) => {
    const t = teams[id];
    if (!t || !t.name) return;
    NAME_INDEX[consensus.normName(t.name)] = Number(id);
    (t.aliases || []).forEach((a) => { NAME_INDEX[consensus.normName(a)] = Number(id); });
  });
  function eventFor(name, ctx) {
    // ★ 2026-08-11 BUG 修复：leagueId 显式 pin 匹配提到 name 判空之前。
    //   关注页 follow.js 跳转详情页只传 leagueId 不传 name → 原实现 `if (!name) return null`
    //   先短路，即使 leagueId 在 LEAGUE_ID_INDEX 中命中也返回 null →
    //   详情页 onLoad 不重定向（保留 fakeId）+ refreshMetadataDerived 拿不到 participants 数组
    //   （参赛队伍全部变「待定队伍 N」）。
    //   修复：有 ctx.leagueId 且命中索引时，name 为空也能返回（名称匹配仍需 name 非空）。
    //   注意：此修复同时解决「fakeId 负数也能按名称匹配」——负数 id 不在 LEAGUE_ID_INDEX，
    //   继续走名称匹配（若 name 非空）。
    // game 校验助手：entry.game 与 ctx.game 同时声明才校验；任一缺失则放行
    const validGame = (entry) => {
      if (!entry) return null;
      if (ctx && ctx.game && entry.game && entry.game !== ctx.game) return null;
      return entry;
    };
    // 1. 显式 leagueId 匹配（最高优先级，绕过别名漂移；name 为空也可命中——关注页只传 id）
    //    仅当调用方提供了 leagueId 且确实有对应 pin 时返回；其余情况走名称匹配。
    //    ★ 2026-08-31 P0：一 ID 多届时按 leagueIdWindow 判届（ctx.now 缺省用当前时间）。
    if (ctx && ctx.leagueId != null) {
      const pinned = pinLookup(ctx.leagueId, ctx.now != null ? ctx.now : Date.now() / 1000);
      if (pinned) return validGame(pinned);
    }
    if (!name) return null;
    // 2. 名称匹配（精确 + 模糊）
    const k = consensus.normName(name);
    if (!k) return null;
    if (EVENT_INDEX[k]) return validGame(EVENT_INDEX[k]);
    // 宽松匹配：归一名包含事件键或反之，但必须满足边界检查（非字母数字）
    // 避免子串误匹配：如 "TI2026 NA Qualifier" 误匹配到 "TI2026" 主赛事
    const ks = Object.keys(EVENT_INDEX);
    for (let i = 0; i < ks.length; i++) {
      const ek = ks[i];
      if (ek.length < 5) continue; // 短键跳过，避免误匹配
      // 正向：归一名包含事件键（处理 OpenDota 名称多后缀，如 "ESL One Birmingham 2024" 含 "ESL One Birmingham"）
      const idx = k.indexOf(ek);
      if (idx >= 0) {
        const before = idx > 0 ? k.charAt(idx - 1) : '';
        const okBefore = !before || !/[a-z0-9]/.test(before);
        const remainder = k.slice(idx + ek.length);
        // 正向边界放宽：ek 之后除「词边界」外，还允许纯数字 / "dota2?" / "s<季>" 后缀，
        // 以兼容 OpenDota 在规范名后追加年份/赛季/「Dota 2」的写法
        // （如 "Esports World Cup 2026 Dota 2" → esportsworldcup2026dota2 仍能命中 curation 别名）。
        // 这样真实 S/A 赛事即便被 OpenDota 标为 excluded，也能经 curation 兜底收录，避免漏收。
        const okAfter = !remainder || !/[a-z0-9]/.test(remainder[0])
          || /^\d+$/.test(remainder) || /^dota2?$/.test(remainder) || /^s\d+$/.test(remainder);
        if (okBefore && okAfter) {
          const v = validGame(EVENT_INDEX[ek]);
          if (v) return v;
        }
      }
      // 反向：事件键包含归一名（处理 OpenDota 名称少后缀，如 "ESL" 匹配 "ESL One"）
      const idx2 = ek.indexOf(k);
      if (idx2 >= 0) {
        const before = idx2 > 0 ? ek.charAt(idx2 - 1) : '';
        const after = ek.charAt(idx2 + k.length);
        const okBefore = !before || !/[a-z0-9]/.test(before);
        const okAfter = !after || !/[a-z0-9]/.test(after);
        if (okBefore && okAfter) {
          const v = validGame(EVENT_INDEX[ek]);
          if (v) return v;
        }
      }
    }
    return null;
  }
  function teamFor(nameOrId) {
    if (nameOrId == null) return null;
    const id = Number(nameOrId);
    if (!isNaN(id) && teams[id]) return Object.assign({ id: id }, teams[id]);
    const k = consensus.normName(String(nameOrId));
    if (k && NAME_INDEX[k]) {
      const tid = NAME_INDEX[k];
      return Object.assign({ id: Number(tid) }, teams[tid]);
    }
    return null;
  }
  return { eventFor, teamFor };
}

// 本地兜底查找器（始终基于内置 CURATED_*，离线/首启可用）
const LOCAL = buildLookups(CURATED_EVENTS, CURATED_TEAMS);

function curatedEventFor(name, ctx) { return LOCAL.eventFor(name, ctx); }
function curatedTeamFor(nameOrId) { return LOCAL.teamFor(nameOrId); }

// 判断 team_id/队名 是否为高优先级战队（S-Tier 或 TI 参赛队）。
// 综合判定：先看 TI 名单快速判定，再用 curation 库的 tier 字段交叉验证。
// 用于 H2H / 战队队员资料功能优先覆盖 S-Tier 与 TI 参赛队。
function isHighPriorityTeam(nameOrId) {
  if (nameOrId == null) return false;
  // 1) TI 名单快速判定（按 id）
  const id = Number(nameOrId);
  if (!isNaN(id) && isTIContestantTeam(id)) return true;
  // 2) curation 库的 tier 字段判定
  const t = LOCAL && LOCAL.teamFor(nameOrId);
  if (t && t.tier && (t.tier.grade === 'SSS' || t.tier.grade === 'S')) return true;
  return false;
}

// ===== §9 P3-C2 取消赛事自动检测（2026-07-30）=====
// 检测 curation 中 status='即将到来' 但 startDate 已过 N 天的赛事，标记为疑似取消。
// 不自动修改 curation 数据（避免误删），仅返回清单供人工确认。
//
// 判定规则：
//   - status === '即将到来' 且 start 已过 overdueDays 天（默认 7 天）→ 疑似取消
//   - status === '进行中' 且 end 已过 overdueDays 天 → 疑似延期/取消
//   - 无 start 字段的 '即将到来' 赛事不检测（无法判定）
//
// 返回：[{ canonical, status, start, end, delaySec, delayDays, reason }]
function detectCancelledEvents(now, overdueDays) {
  now = now || Math.floor(Date.now() / 1000);
  overdueDays = overdueDays || 7;
  const overdueSec = overdueDays * 86400;
  const list = [];
  CURATED_EVENTS.forEach((ev) => {
    if (!ev || !ev.status) return;
    if (ev.status === '即将到来' && ev.start) {
      if (ev.start + overdueSec < now) {
        list.push({
          canonical: ev.canonical,
          status: ev.status,
          start: ev.start,
          end: ev.end || null,
          delaySec: now - ev.start,
          delayDays: Math.floor((now - ev.start) / 86400),
          reason: '即将到来但已过开始时间 ' + Math.floor((now - ev.start) / 86400) + ' 天'
        });
      }
    } else if (ev.status === '进行中' && ev.end) {
      if (ev.end + overdueSec < now) {
        list.push({
          canonical: ev.canonical,
          status: ev.status,
          start: ev.start || null,
          end: ev.end,
          delaySec: now - ev.end,
          delayDays: Math.floor((now - ev.end) / 86400),
          reason: '进行中但已过结束时间 ' + Math.floor((now - ev.end) / 86400) + ' 天'
        });
      }
    }
  });
  return list;
}

module.exports = {
  CURATED_EVENTS: CURATED_EVENTS,
  CURATED_TEAMS: CURATED_TEAMS,
  TI_CONTESTANT_TEAM_IDS: TI_CONTESTANT_TEAM_IDS,
  EXCLUDE_LEAGUE_IDS: EXCLUDE_LEAGUE_IDS,
  isExcludedLeagueId: isExcludedLeagueId,
  buildLookups: buildLookups,
  curatedEventFor: curatedEventFor,
  curatedTeamFor: curatedTeamFor,
  isTIContestantTeam: isTIContestantTeam,
  isHighPriorityTeam: isHighPriorityTeam,
  detectCancelledEvents: detectCancelledEvents
};
