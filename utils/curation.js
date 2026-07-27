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

// ===== 重大赛事（规范名 + 等级 + 可选日期提示）=====
// aliases 含规范名的小写无分隔形式，用于模糊匹配 OpenDota 返回的各种写法。
// start/end 为 Unix 秒（UTC），用于时间交叉验证补强。
const CURATED_EVENTS = [
  // ── TI 系列（SSS） ──
  { canonical: 'The International 2025', tier: { grade: 'SSS', rank: 4, label: 'TI 顶级' },
    aliases: ['theinternational2025', 'ti2025', 'international2025'], year: 2025 },
  { canonical: 'The International 2024', tier: { grade: 'SSS', rank: 4, label: 'TI 顶级' },
    aliases: ['theinternational2024', 'ti2024', 'international2024'], year: 2024,
    start: Math.floor(Date.UTC(2024, 8, 4) / 1000), end: Math.floor(Date.UTC(2024, 8, 15) / 1000) },
  { canonical: 'The International 2023', tier: { grade: 'SSS', rank: 4, label: 'TI 顶级' },
    aliases: ['theinternational2023', 'ti2023', 'international2023'], year: 2023 },
  { canonical: 'The International 2022', tier: { grade: 'SSS', rank: 4, label: 'TI 顶级' },
    aliases: ['theinternational2022', 'ti2022', 'international2022'], year: 2022 },
  // TI15 (The International 2026)：2026-08-13 ~ 2026-08-23（含小组赛+主赛事），上海
  // 来源：Liquipedia The_International/2026 + Valve 官方公告
  // 补充字段（2026-07-25）：奖金池/地点/Valve 标记，供「赛事」tab 焦点卡与详情页 curation 兜底使用。
  { canonical: 'The International 2026', tier: { grade: 'SSS', rank: 4, label: 'TI 顶级' },
    aliases: ['theinternational2026', 'ti2026', 'international2026', 'ti15'], year: 2026,
    start: Math.floor(Date.UTC(2026, 7, 13) / 1000), end: Math.floor(Date.UTC(2026, 7, 23) / 1000),
    prizePool: '$1,600,000', organizer: 'Valve', region: '中国上海', format: '小组赛+双败淘汰',
    participants: 16, status: '即将到来', liquipediaSlug: 'The_International/2026', valve: true, topThirdParty: false },

  // ── 知名 S 级（顶级第三方 S-Tier 巡回赛）2024 ──
  // 2024 起统一 $1M 级奖金，是 Dota2 职业生态骨架
  { canonical: 'ESL One Birmingham 2024', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['eslonebirmingham2024', 'birminghammajor2024'], year: 2024,
    start: Math.floor(Date.UTC(2024, 3, 22) / 1000), end: Math.floor(Date.UTC(2024, 3, 28) / 1000) },
  // Riyadh Masters：顶级第三方（史上非 TI 最高奖金 $15.12M）
  { canonical: 'Riyadh Masters 2024', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['riyadhmasters2024', 'rm2024', 'riyadh2024'], year: 2024,
    start: Math.floor(Date.UTC(2024, 6, 4) / 1000), end: Math.floor(Date.UTC(2024, 6, 21) / 1000) },
  // DreamLeague：ESL 线上联赛，每赛季 $1M，稳定高频
  { canonical: 'DreamLeague Season 23', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['dreamleagueseason23', 'dreamleague23', 'dl2024s23'], year: 2024 },
  { canonical: 'DreamLeague Season 22', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['dreamleagueseason22', 'dreamleague22', 'dl2024s22'], year: 2024 },
  { canonical: 'DreamLeague Season 24', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['dreamleagueseason24', 'dreamleague24', 'dl2024s24'], year: 2024 },
  { canonical: 'DreamLeague Season 25', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['dreamleagueseason25', 'dreamleague25', 'dl2025s25'], year: 2025 },
  // BetBoom Dacha：高额新秀系列
  { canonical: 'BetBoom Dacha', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['betboomdacha', 'betboomdacha2024', 'bbdacha'], year: 2024 },
  // PGL Wallachia：PGL 三年马拉松系列
  { canonical: 'PGL Wallachia', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['pglwallachia', 'pglwallachia2024', 'wallachia2024'], year: 2024 },
  { canonical: 'PGL Wallachia Season 2', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['pglwallachia2', 'pglwallachiaseason2', 'wallachia2025'], year: 2025 },
  // BLAST Slam：BLAST 入局 Dota2 后的新系列
  { canonical: 'BLAST Slam', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['blastslam', 'blastslam2024'], year: 2024 },
  { canonical: 'BLAST Slam II', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['blastslam2', 'blastslamii', 'blastslam2025'], year: 2025 },
  // FISSURE Playground / Universe：高额新秀系列
  { canonical: 'FISSURE Playground', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['fissureplayground', 'fissure', 'fissure2025'], year: 2025 },
  { canonical: 'FISSURE Universe', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['fissureuniverse', 'fissureuniverse2025'], year: 2025 },

  // ── S 级（ESL One 统一为 S-Tier，与 tiers.js 的 esl\s+one 规则对齐）2025 ──
  { canonical: 'ESL One Raleigh 2025', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['esloneraleigh2025', 'raleigh2025', 'eslraleigh2025'], year: 2025,
    prizePool: '$1,000,000', organizer: 'ESL', region: '北美', format: '双败淘汰', participants: 16,
    status: '已结束', liquipediaSlug: 'ESL_One/2025/Raleigh', valve: false, topThirdParty: false },
  { canonical: 'Riyadh Masters 2025', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['riyadhmasters2025', 'rm2025', 'riyadh2025'], year: 2025 },
  { canonical: 'PGL Astana 2025', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['pglastana2025', 'astana2025', 'pglastana'], year: 2025 },
  // Clavision / Elite League：A-Tier 第三方
  { canonical: 'Clavision Masters', tier: { grade: 'A', rank: 2, label: 'A级' },
    aliases: ['clavisionmasters', 'clavision'], year: 2024 },
  { canonical: 'Elite League', tier: { grade: 'A', rank: 2, label: 'A级' },
    aliases: ['eliteleague', 'eliteleague2024'], year: 2024 },

  // ── 2026 ──
  // DreamLeague Season 26：2026 上半年 ESL Pro Tour 赛事（已举办）
  { canonical: 'DreamLeague Season 26', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['dreamleagueseason26', 'dreamleague26', 'dl2026s26'], year: 2026,
    prizePool: '$1,000,000', organizer: 'ESL', region: '欧洲', format: '双败淘汰',
    participants: 16, status: '已结束', liquipediaSlug: 'DreamLeague/Season_26',
    valve: false, topThirdParty: false },
  // 2026 电竞世界杯 DOTA2 项目：7月6日-8月23日，利雅得（顶级第三方，S 级）
  { canonical: 'Esports World Cup 2026', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['esportsworldcup2026', 'ewc2026', 'ewcdota2026'], year: 2026,
    start: Math.floor(Date.UTC(2026, 6, 6) / 1000), end: Math.floor(Date.UTC(2026, 7, 23) / 1000),
    prizePool: '$1,000,000', organizer: 'ESL / Savvy Games', region: '沙特阿拉伯·利雅得', format: '循环小组赛 + 单败淘汰附加赛',
    participants: 16, status: '已结束', liquipediaSlug: 'Esports_World_Cup/2026/Dota_2',
    valve: false, topThirdParty: true },
  // EPL Masters I（ESL / European Pro League Masters 第一季）：DOTA2 线上赛事
  // ⚠️ 别名收敛（2026-07-27 修复，对应「EPL Masters I 列表重复 + 参赛队伍错误」Bug）：
  //   原别名 'epl2026' / 'eplmasters2026' 过宽，会把 OpenDota 中两个低级别联赛也误映射为
  //   "EPL Masters I"：
  //     • leagueid 19080 "EPL 2026"（tier=excluded、0 场）→ 列表出现第二张重复卡；
  //     • leagueid 19944 "EPL Masters 2026 "（专业级、86 场，但参赛队为 Nemiga/PuckChamp/
  //       Team Lynx/Team Spirit Academy 等低级别队）→ 被强行冠以权威名，导致详情页队伍错位。
  //   两联赛真实队伍均与本条目标注的 $100K A-Tier ESL EPL Masters I 不符；且本条目引用的
  //   Liquipedia slug 'EPL/Masters/I' 实测不存在（页面无内容），交叉验证失效。
  //   故收敛为仅命中字面 "EPL Masters I" 的窄别名，使上述联赛回退到 OpenDota 原始名，
  //   不再被错误冠名（重复卡与队伍错位一并消除）。
  //   —— 若确有正确的 ESL EPL Masters I leagueid，应改为「显式 pin（leagueId 字段）」而非模糊别名，
  //      避免再次因 OpenDota 联赛名漂移而误关联。
  { canonical: 'EPL Masters I', tier: { grade: 'A', rank: 8, label: 'A-Tier' },
    aliases: ['epl masters i'], year: 2026,
    start: Math.floor(Date.UTC(2026, 6, 20) / 1000), end: Math.floor(Date.UTC(2026, 7, 12) / 1000),
    prizePool: '$100,000', organizer: 'ESL / EPL', region: '欧洲/CIS · 线上',
    format: '小组赛(Bo3) + 双败淘汰(Bo3/Bo5决赛)',
    participants: 16, status: '进行中', liquipediaSlug: 'EPL/Masters/I',
    valve: false, topThirdParty: true },

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

  // ── B 级（B-Tier 区域联赛 + 次级国际赛）──
  { canonical: 'Games of the Future 2024', tier: { grade: 'B', rank: 1, label: 'B级' },
    aliases: ['gamesofthefuture2024', 'gof2024'], year: 2024 },
  { canonical: 'ESL One Kuala Lumpur 2024', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['eslkualalumpur2024', 'kualalumpur2024', 'kl2024'], year: 2024,
    prizePool: '$1,000,000', organizer: 'ESL', region: '东南亚', format: '双败淘汰', participants: 16,
    status: '已结束', liquipediaSlug: 'ESL_One/2024/Kuala_Lumpur', valve: false, topThirdParty: false },
  { canonical: 'TritonLeague', tier: { grade: 'B', rank: 1, label: 'B级' },
    aliases: ['tritonleague', 'triton'], year: 2024 },
  { canonical: 'Dota 2 World Invitational', tier: { grade: 'B', rank: 1, label: 'B级' },
    aliases: ['dotaworldinvitational', 'd2wi'], year: 2024 },
  { canonical: 'Mega Arena', tier: { grade: 'B', rank: 1, label: 'B级' },
    aliases: ['megaarena', 'megaarena2025'], year: 2025 },

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
    aliases: ['dpc20222023', 'dpc202223', 'dpc2023'], year: 2023,
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
    valve: true, topThirdParty: false, defunct: true }
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
  7262280:  { name: 'BetBoom Team', tag: 'BB', country: 'RU', tier: { grade: 'S', label: 'S-Tier' },
              aliases: ['betboom', 'betboomteam'] },   // ⚠️待复核：id 待替换正确值
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
  10150538, 7119388, 2586976, 8291895, 8599101, 2163, 111474, 10136357, 7262280,
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
// 返回 { eventFor(name), teamFor(nameOrId) }，逻辑与原 curatedEventFor/curatedTeamFor 完全一致。
function buildLookups(events, teams) {
  // 赛事名 -> 事件对象（按规范名/别名归一匹配）
  const EVENT_INDEX = {};
  (events || []).forEach((ev) => {
    if (!ev || !ev.canonical) return;
    EVENT_INDEX[consensus.normName(ev.canonical)] = ev;
    (ev.aliases || []).forEach((a) => { EVENT_INDEX[consensus.normName(a)] = ev; });
  });
  // 战队名 -> id 反向索引（用于按名查询）
  const NAME_INDEX = {};
  Object.keys(teams || {}).forEach((id) => {
    const t = teams[id];
    if (!t || !t.name) return;
    NAME_INDEX[consensus.normName(t.name)] = Number(id);
    (t.aliases || []).forEach((a) => { NAME_INDEX[consensus.normName(a)] = Number(id); });
  });
  function eventFor(name) {
    if (!name) return null;
    const k = consensus.normName(name);
    if (!k) return null;
    if (EVENT_INDEX[k]) return EVENT_INDEX[k];
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
        const after = k.charAt(idx + ek.length);
        const okBefore = !before || !/[a-z0-9]/.test(before);
        const okAfter = !after || !/[a-z0-9]/.test(after);
        if (okBefore && okAfter) return EVENT_INDEX[ek];
      }
      // 反向：事件键包含归一名（处理 OpenDota 名称少后缀，如 "ESL" 匹配 "ESL One"）
      const idx2 = ek.indexOf(k);
      if (idx2 >= 0) {
        const before = idx2 > 0 ? ek.charAt(idx2 - 1) : '';
        const after = ek.charAt(idx2 + k.length);
        const okBefore = !before || !/[a-z0-9]/.test(before);
        const okAfter = !after || !/[a-z0-9]/.test(after);
        if (okBefore && okAfter) return EVENT_INDEX[ek];
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

function curatedEventFor(name) { return LOCAL.eventFor(name); }
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

module.exports = {
  CURATED_EVENTS: CURATED_EVENTS,
  CURATED_TEAMS: CURATED_TEAMS,
  TI_CONTESTANT_TEAM_IDS: TI_CONTESTANT_TEAM_IDS,
  buildLookups: buildLookups,
  curatedEventFor: curatedEventFor,
  curatedTeamFor: curatedTeamFor,
  isTIContestantTeam: isTIContestantTeam,
  isHighPriorityTeam: isHighPriorityTeam
};
