// utils/sources.js
// 多数据源编排层：把「比赛内容来源」做多元化，并让任一源失败都能平滑降级。
//
// 设计升级（本次）：在原有「优先级回退（第一个可用源胜出）」之外，新增
// 「并行采集 + 多源交叉验证（consensus）」能力，针对关键字段做投票/比对：
//   - 赛事名称 getLeagueName        ：OpenDota / 本地精选(curation) / STRATZ 归一投票
//   - 赛事分级 getLeagueTier         ：community / curation / OpenDota / STRATZ 计票
//   - 赛事时间 getLeagueWindow       ：curation / STRATZ / Steam 时间中位数比对
//   - 队伍成员 crossTeamMembers      ：OpenDota / STRATZ 名册按 account_id 交叉比对
//   - 战队扩展 enrichTeamInfo        ：curation(永远可用) / Steam(官方,需 key)
//   - 选手ID  validatePlayerId       ：consensus 提供校验
//
// 参与的来源：
//   - community ：本地精选规则（utils/tiers.js），零网络、永远可用，作为兜底与首选快速分级
//   - curation  ：本地权威库（utils/curation.js），零网络、永远可用，提供规范名/等级/日期提示
//   - opendota  ：OpenDota（主网络源，无需 key）
//   - stratz    ：STRATZ GraphQL（第二网络源，需 apiKey 启用；未启用自动跳过）
//   - steam     ：Steam Web API（Valve 官方，需 apiKey 启用；未启用自动跳过）
//
// 所有源都是「尽力而为」，任一抛错都被隔离，绝不影响其它源或页面渲染。

const config = require('./config.js');
const tiers = require('./tiers.js');
const util = require('./util.js');
const api = require('./api.js');
const stratz = require('./stratz.js');
const steam = require('./steam.js');
const consensus = require('./consensus.js');
const curation = require('./remoteCuration.js');

// 源中文名（用于 UI 标注数据来源 / 可信度）
const SOURCE_LABEL = {
  community: '本地精选',
  curation: '权威库',
  stratz: 'STRATZ',
  opendota: 'OpenDota',
  steam: 'Steam'
};

function labelOf(src) { return SOURCE_LABEL[src] || src; }
function joinedLabels(sources) {
  return (sources || []).map(labelOf).join('/') || labelOf('opendota');
}

// ===== 赛事分级：多源计票 =====
// 候选来源：community(本地规则) -> curation(权威库) -> opendota(枚举) -> stratz(启用时)
async function getLeagueTier(league) {
  const name = (league && league.name) || '';
  const candidates = [];

  const c = tiers.communityTierFromName(name);
  if (c) candidates.push({ grade: c.grade, rank: c.rank, label: c.label, source: 'community' });

  const cu = curation.curatedEventFor(name);
  if (cu && cu.tier) candidates.push({ grade: cu.tier.grade, rank: cu.tier.rank, label: cu.tier.label, source: 'curation' });

  const u = util.unifiedTier(league || {});
  candidates.push({ grade: u.grade, rank: u.rank, label: u.label, source: 'opendota' });

  if (stratz.ENABLED && name) {
    try {
      const s = await stratz.getLeagueTier(name);
      if (s && s.grade) candidates.push({ grade: s.grade, rank: s.rank, label: s.label, source: 'stratz' });
    } catch (e) { /* 隔离 */ }
  }

  const r = consensus.consensusTier(candidates);
  r.source = 'consensus';
  r.sourceLabel = joinedLabels(r.sources);
  return r;
}

// ===== 赛事名称：多源归一投票 =====
async function getLeagueName(league) {
  const candidates = [];
  const name = (league && league.name) || '';
  if (name) candidates.push({ value: name, source: 'opendota' });

  const cu = curation.curatedEventFor(name);
  if (cu) candidates.push({ value: cu.canonical, source: 'curation' });

  const id = league && (league.leagueid || league.id);
  if (stratz.ENABLED && id) {
    try {
      const s = await stratz.getLeagueDisplayName(id);
      if (s) candidates.push({ value: s, source: 'stratz' });
    } catch (e) { /* 隔离 */ }
  }

  const r = consensus.voteName(candidates);
  if (!r.value && name) {
    return { value: name, sources: ['opendota'], confidence: 'low', agreement: 1, total: 1 };
  }
  r.source = 'consensus';
  r.sourceLabel = joinedLabels(r.sources);
  return r;
}

// ===== 赛事时间窗口：多源时间中位数比对 =====
async function getLeagueWindow(league) {
  const name = (league && league.name) || '';
  const startC = [];
  const endC = [];

  const cu = curation.curatedEventFor(name);
  if (cu && cu.start) startC.push({ value: cu.start, source: 'curation' });
  if (cu && cu.end) endC.push({ value: cu.end, source: 'curation' });

  // STRATZ 当前 schema 不直接提供赛事起止时间，留接口；启用且可用时补充
  if (stratz.ENABLED && name) {
    try {
      const s = await stratz.getLeagueWindow(name);
      if (s && s.start) startC.push({ value: s.start, source: 'stratz' });
      if (s && s.end) endC.push({ value: s.end, source: 'stratz' });
    } catch (e) { /* 隔离 */ }
  }

  const start = startC.length ? consensus.voteTime(startC).value : null;
  const end = endC.length ? consensus.voteTime(endC).value : null;
  if (start == null && end == null) return null;

  const sources = Array.from(new Set(
    startC.map((c) => c.source).concat(endC.map((c) => c.source))
  ));
  return {
    startDate: start,
    endDate: end,
    source: 'consensus',
    sourceLabel: joinedLabels(sources),
    confidence: sources.length >= 2 ? 'medium' : 'low'
  };
}

// 多源增强战队 logo：优先级 [stratz]（已有 http logo 直接复用）
async function enrichTeamLogo(team) {
  const name = (team && team.name) || '';
  const id = (team && team.id);
  const existing = (team && team.logo) || (team && team.logo_url) || '';
  if (existing && /^https?:\/\//i.test(existing)) return { logo: existing, source: 'opendota' };

  if (stratz.ENABLED && id) {
    try {
      const r = await stratz.getTeamLogo(id);
      if (r && /^https?:\/\//i.test(r)) return { logo: r, source: 'stratz' };
    } catch (e) { /* 隔离 */ }
  }
  return null;
}

// 多源增强队员头像：优先级 [stratz]（已有 http avatar 直接复用）
async function enrichPlayerAvatar(player) {
  const accountId = (player && player.accountId);
  const existing = (player && player.avatar) || '';
  if (existing && /^https?:\/\//i.test(existing)) return { avatar: existing, source: 'opendota' };

  if (stratz.ENABLED && accountId) {
    try {
      const r = await stratz.getPlayerAvatar(accountId);
      if (r && /^https?:\/\//i.test(r)) return { avatar: r, source: 'stratz' };
    } catch (e) { /* 隔离 */ }
  }
  return null;
}

// 多源增强战队扩展信息（规范名/标签/国家/成立时间）：
// curation(永远可用) -> steam(官方，需 key)。返回 { name, tag, country, logo, source, confidence }
async function enrichTeamInfo(team) {
  const info = {};
  const cu = curation.curatedTeamFor(team && (team.id || team.name));
  if (cu) {
    if (cu.name) info.name = cu.name;
    if (cu.tag) info.tag = cu.tag;
    if (cu.country) info.country = cu.country;
    info.source = 'curation';
    info.confidence = 'medium';
  }

  if (steam.ENABLED && team && team.id) {
    try {
      const s = await steam.getTeamInfo(team.id);
      if (s) {
        if (s.name) info.name = s.name;
        if (s.tag) info.tag = s.tag;
        if (s.country) info.country = s.country;
        if (s.logo && /^https?:\/\//i.test(s.logo)) info.logo = s.logo;
        info.source = 'steam';
        info.confidence = 'high';
      }
    } catch (e) { /* 隔离 */ }
  }

  return Object.keys(info).length ? info : null;
}

// 多源交叉验证「队伍成员」：OpenDota / STRATZ 名册按 account_id 主键合并。
// 出现在 >=2 来源的成员标记为 verified（高可信）。返回 consensus.crossMembers 结果。
async function crossTeamMembers(teamId) {
  const lists = [];

  try {
    const ps = await api.getTeamPlayers(teamId);
    if (ps && ps.length) {
      lists.push({
        source: 'opendota',
        members: ps.map((p) => ({ account_id: p.account_id, name: p.name }))
      });
    }
  } catch (e) { /* 隔离 */ }

  if (stratz.ENABLED && teamId) {
    try {
      const rs = await stratz.getTeamRoster(teamId);
      if (rs && rs.length) lists.push({ source: 'stratz', members: rs });
    } catch (e) { /* 隔离 */ }
  }

  if (lists.length === 0) return null;
  const r = consensus.crossMembers(lists);
  r.sourceLabel = joinedLabels(r.sources);
  return r;
}

// 多源聚合「正在直播/进行中」的比赛（实时比分+队伍）：
// ✓ 从所有启用的源并行收集（steam + stratz），按 lobbyId/matchId 去重合并。
// ✓ 任一源失败不影响其它；全部失败返回空数组。
async function enrichLiveGames() {
  const order = (config.sources && config.sources.livePriority) || ['steam', 'stratz'];
  const allUnmerged = [];
  for (let i = 0; i < order.length; i++) {
    const src = order[i];
    try {
      let list = [];
      if (src === 'steam') list = await steam.getLiveLeagueGames();
      else if (src === 'stratz') list = await stratz.getLiveMatches();
      if (list && list.length > 0) {
        list.forEach((g) => { g.source = src; allUnmerged.push(g); });
      }
    } catch (e) { /* 隔离 */ }
  }
  // 去重：steam 的 lobbyId 与 stratz 的 matchId 属不同 ID 空间，无法跨源去重。
  // 改用跨源稳定的复合键 (radiantTeamId, direTeamId, leagueId)，并对两个队伍 id
  // 升序归一，避免两端天辉/夜魇槽位顺序不同导致同一局被判为两场。
  // 三个标识全部 0/缺失时，回退到源私有 id（前缀 src_），避免误合并两场无法识别的局。
  const seen = {};
  const merged = [];
  allUnmerged.forEach((g) => {
    const radiant = g.radiantTeamId || 0;
    const dire = g.direTeamId || 0;
    const league = g.leagueId || 0;
    let dedupKey;
    if (radiant === 0 && dire === 0 && league === 0) {
      dedupKey = 'src_' + (g.lobbyId != null ? 'lobby_' + g.lobbyId : ('match_' + (g.matchId || '')));
    } else {
      const teamA = Math.min(radiant, dire);
      const teamB = Math.max(radiant, dire);
      dedupKey = teamA + '_' + teamB + '_' + league;
    }
    if (!seen[dedupKey]) {
      seen[dedupKey] = true;
      merged.push(g);
    }
  });
  return merged;
}

// 选手ID 校验（包装 consensus）
function validatePlayerId(id) {
  return consensus.validatePlayerId(id);
}

module.exports = {
  SOURCE_LABEL: SOURCE_LABEL,
  getLeagueTier: getLeagueTier,
  getLeagueName: getLeagueName,
  getLeagueWindow: getLeagueWindow,
  enrichTeamLogo: enrichTeamLogo,
  enrichPlayerAvatar: enrichPlayerAvatar,
  enrichTeamInfo: enrichTeamInfo,
  crossTeamMembers: crossTeamMembers,
  enrichLiveGames: enrichLiveGames,
  validatePlayerId: validatePlayerId
};
