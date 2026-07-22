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
  { canonical: 'The International 2026', tier: { grade: 'SSS', rank: 4, label: 'TI 顶级' },
    aliases: ['theinternational2026', 'ti2026', 'international2026'], year: 2026 },

  // ── 知名 Premier/Major（S / A 级）2024 ──
  { canonical: 'ESL One Birmingham 2024', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['eslonebirmingham2024', 'birminghammajor2024'], year: 2024,
    start: Math.floor(Date.UTC(2024, 3, 22) / 1000), end: Math.floor(Date.UTC(2024, 3, 28) / 1000) },
  { canonical: 'Riyadh Masters 2024', tier: { grade: 'A', rank: 2, label: 'A级' },
    aliases: ['riyadhmasters2024', 'rm2024', 'riyadh2024'], year: 2024,
    start: Math.floor(Date.UTC(2024, 6, 4) / 1000), end: Math.floor(Date.UTC(2024, 6, 21) / 1000) },
  { canonical: 'DreamLeague Season 23', tier: { grade: 'A', rank: 2, label: 'A级' },
    aliases: ['dreamleagueseason23', 'dreamleague23', 'dl2024s23'], year: 2024 },
  { canonical: 'DreamLeague Season 22', tier: { grade: 'A', rank: 2, label: 'A级' },
    aliases: ['dreamleagueseason22', 'dreamleague22', 'dl2024s22'], year: 2024 },
  { canonical: 'DreamLeague Season 24', tier: { grade: 'A', rank: 2, label: 'A级' },
    aliases: ['dreamleagueseason24', 'dreamleague24', 'dl2024s24'], year: 2024 },
  { canonical: 'DreamLeague Season 25', tier: { grade: 'A', rank: 2, label: 'A级' },
    aliases: ['dreamleagueseason25', 'dreamleague25', 'dl2025s25'], year: 2025 },
  { canonical: 'BetBoom Dacha', tier: { grade: 'A', rank: 2, label: 'A级' },
    aliases: ['betboomdacha', 'betboomdacha2024', 'bbdacha'], year: 2024 },
  { canonical: 'PGL Wallachia', tier: { grade: 'A', rank: 2, label: 'A级' },
    aliases: ['pglwallachia', 'pglwallachia2024', 'wallachia2024'], year: 2024 },
  { canonical: 'PGL Wallachia Season 2', tier: { grade: 'A', rank: 2, label: 'A级' },
    aliases: ['pglwallachia2', 'pglwallachiaseason2', 'wallachia2025'], year: 2025 },
  { canonical: 'Clavision Masters', tier: { grade: 'A', rank: 2, label: 'A级' },
    aliases: ['clavisionmasters', 'clavision'], year: 2024 },
  { canonical: 'Elite League', tier: { grade: 'A', rank: 2, label: 'A级' },
    aliases: ['eliteleague', 'eliteleague2024'], year: 2024 },
  { canonical: 'FISSURE Playground', tier: { grade: 'A', rank: 2, label: 'A级' },
    aliases: ['fissureplayground', 'fissure', 'fissure2025'], year: 2025 },
  { canonical: 'FISSURE Universe', tier: { grade: 'A', rank: 2, label: 'A级' },
    aliases: ['fissureuniverse', 'fissureuniverse2025'], year: 2025 },
  { canonical: 'BLAST Slam', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['blastslam', 'blastslam2024'], year: 2024 },
  { canonical: 'BLAST Slam II', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['blastslam2', 'blastslamii', 'blastslam2025'], year: 2025 },

  // ── 2025 ──
  { canonical: 'ESL One Raleigh 2025', tier: { grade: 'S', rank: 3, label: 'S级' },
    aliases: ['esloneraleigh2025', 'raleigh2025', 'eslraleigh2025'], year: 2025 },
  { canonical: 'Riyadh Masters 2025', tier: { grade: 'A', rank: 2, label: 'A级' },
    aliases: ['riyadhmasters2025', 'rm2025', 'riyadh2025'], year: 2025 },
  { canonical: 'PGL Astana 2025', tier: { grade: 'A', rank: 2, label: 'A级' },
    aliases: ['pglastana2025', 'astana2025', 'pglastana'], year: 2025 },

  // ── 2026 ──
  { canonical: 'DreamLeague Season 26', tier: { grade: 'A', rank: 2, label: 'A级' },
    aliases: ['dreamleagueseason26', 'dreamleague26', 'dl2026s26'], year: 2026 },

  // ── 其他知名 A/B 级 ──
  { canonical: 'Games of the Future 2024', tier: { grade: 'B', rank: 1, label: 'B级' },
    aliases: ['gamesofthefuture2024', 'gof2024'], year: 2024 },
  { canonical: 'ESL One Kuala Lumpur 2024', tier: { grade: 'A', rank: 2, label: 'A级' },
    aliases: ['eslkualalumpur2024', 'kualalumpur2024', 'kl2024'], year: 2024 },
  { canonical: 'TritonLeague', tier: { grade: 'B', rank: 1, label: 'B级' },
    aliases: ['tritonleague', 'triton'], year: 2024 },
  { canonical: 'Dota 2 World Invitational', tier: { grade: 'B', rank: 1, label: 'B级' },
    aliases: ['dotaworldinvitational', 'd2wi'], year: 2024 },
  { canonical: 'Mega Arena', tier: { grade: 'B', rank: 1, label: 'B级' },
    aliases: ['megaarena', 'megaarena2025'], year: 2025 }
];

// ===== 知名战队（team_id -> 规范信息）=====
const CURATED_TEAMS = {
  15:       { name: 'LGD Gaming', tag: 'LGD', country: 'CN', aliases: ['lgd', 'lgdgaming', 'psglgd'] },
  7119388:  { name: 'Team Spirit', tag: 'TS', country: 'RU', aliases: ['teamspirit', 'spirit'] },
  36:       { name: 'Natus Vincere', tag: 'NAVI', country: 'UA', aliases: ['natusvincere', 'navi'] },
  1838312:  { name: 'OG', tag: 'OG', country: 'EU', aliases: ['og'] },
  2163:     { name: 'Team Secret', tag: 'SEC', country: 'EU', aliases: ['teamsecret', 'secret'] },
  8336801:  { name: 'Tundra Esports', tag: 'TUN', country: 'EU', aliases: ['tundra', 'tundraesports'] },
  7090336:  { name: 'Gaimin Gladiators', tag: 'GG', country: 'EU', aliases: ['gaimingladiators', 'gg'] },
  1375614:  { name: 'Fnatic', tag: 'FNC', country: 'MY', aliases: ['fnatic'] },
  1369577:  { name: 'Evil Geniuses', tag: 'EG', country: 'US', aliases: ['evilgeniuses', 'eg'] },
  2506989:  { name: 'PSG.LGD', tag: 'PSG', country: 'CN', aliases: ['psglgd', 'psgldg'] },
  2586976:  { name: 'Team Liquid', tag: 'TL', country: 'NL', aliases: ['teamliquid', 'liquid'] },
  111474:   { name: 'Virtus.pro', tag: 'VP', country: 'RU', aliases: ['virtuspro', 'vp'] },
  543897:   { name: 'Alliance', tag: 'ALL', country: 'SE', aliases: ['alliance'] },
  350190:   { name: 'Nigma Galaxy', tag: 'NGX', country: 'EU', aliases: ['nigma', 'nigmagalaxy'] },
  7262280:  { name: 'BetBoom Team', tag: 'BB', country: 'RU', aliases: ['betboom', 'betboomteam'] },
  1333179:  { name: 'Xtreme Gaming', tag: 'XG', country: 'CN', aliases: ['xtremegaming', 'xg', 'extremegaming'] },
  5026801:  { name: 'Azure Ray', tag: 'AR', country: 'CN', aliases: ['azureray', 'ar'] },
  7390454:  { name: 'Aurora Gaming', tag: 'AUR', country: 'TH', aliases: ['aurora', 'auroragaming'] },
  8291895:  { name: 'Team Falcons', tag: 'FAL', country: 'SA', aliases: ['falcons', 'teamfalcons'] },
  8124688:  { name: 'Nigma Galaxy', tag: 'NGX', country: 'AE', aliases: ['nigmagx', 'nigma'] },
  8260824:  { name: 'PARIVISION', tag: 'PARI', country: 'RU', aliases: ['parivision'] },
  6209804:  { name: 'MOUZ', tag: 'MOUZ', country: 'DE', aliases: ['mouz'] },
  8137231:  { name: 'Talon Esports', tag: 'TLN', country: 'TH', aliases: ['talon', 'talonesports'] }
};

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
    // 宽松匹配：归一名包含某事件键或反之（处理 OpenDota 名称多/少后缀）
    const ks = Object.keys(EVENT_INDEX);
    for (let i = 0; i < ks.length; i++) {
      if (k.indexOf(ks[i]) >= 0 || ks[i].indexOf(k) >= 0) return EVENT_INDEX[ks[i]];
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

module.exports = {
  CURATED_EVENTS: CURATED_EVENTS,
  CURATED_TEAMS: CURATED_TEAMS,
  buildLookups: buildLookups,
  curatedEventFor: curatedEventFor,
  curatedTeamFor: curatedTeamFor
};
