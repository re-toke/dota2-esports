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
const liquipedia = require('./liquipedia.js');
const consensus = require('./consensus.js');
const curation = require('./remoteCuration.js');

// 源中文名（用于 UI 标注数据来源 / 可信度）
const SOURCE_LABEL = {
  community: '本地精选',
  curation: '权威库',
  stratz: 'STRATZ',
  opendota: 'OpenDota',
  steam: 'Steam',
  liquipedia: 'Liquipedia'
};

function labelOf(src) { return SOURCE_LABEL[src] || src; }
function joinedLabels(sources) {
  return (sources || []).map(labelOf).join('/') || labelOf('opendota');
}

// 将 Liquipedia 返回的日期文本（如 '2025-08-15' / 'August 15, 2025'）归一为 Unix 秒。
// consensus.voteTime 只接受数值候选（normNum > 0），故 Liquipedia 的字符串日期必须先转换。
// 解析失败返回 null（该候选被跳过，不影响其它源）。
function liquipediaDateToUnix(text) {
  if (!text) return null;
  const s = String(text).trim();
  // 优先匹配 yyyy-MM-dd / yyyy/M/d（Liquipedia infobox 最常见的纯数字日期）
  const m = s.match(/(\d{4})[-/](\d{1,2})(?:[-/](\d{1,2}))?/);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = m[3] ? Number(m[3]) : 1;
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      return Math.floor(Date.UTC(y, mo - 1, d) / 1000);
    }
  }
  // 回退：原生 Date.parse（可解析 'August 15, 2025' 等英文形式）
  const t = Date.parse(s);
  return isFinite(t) ? Math.floor(t / 1000) : null;
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

  // Liquipedia：独立人工策展源，提供规范名作为第四候选（与 Valve 数据链路无关）
  if (liquipedia.ENABLED && name) {
    try {
      const meta = await liquipedia.getLeagueMetadata(name);
      if (meta && meta.canonical) candidates.push({ value: meta.canonical, source: 'liquipedia' });
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

  // Liquipedia：返回的日期为文本字符串，需经 liquipediaDateToUnix 转为 Unix 秒
  // 才能进入 voteTime（仅接受数值候选）；解析失败的字段被跳过，不影响其它源。
  if (liquipedia.ENABLED && name) {
    try {
      const meta = await liquipedia.getLeagueMetadata(name);
      if (meta) {
        if (meta.startDate) {
          const t = liquipediaDateToUnix(meta.startDate);
          if (t != null) startC.push({ value: t, source: 'liquipedia' });
        }
        if (meta.endDate) {
          const t = liquipediaDateToUnix(meta.endDate);
          if (t != null) endC.push({ value: t, source: 'liquipedia' });
        }
      }
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

// ===== 赛事元数据：Liquipedia + Steam 聚合 =====
// Liquipedia 提供完整人工策展元数据（规范名/日期/奖金池/地点/赛制/主办方），
// Steam 提供官方奖金池（OpenDota/STRATZ 均无），二者互补且可交叉校验奖金池。
// Liquipedia 优先（人工策展更可靠），Steam 兜底。
async function getLeagueMetadata(league) {
  const name = (league && league.name) || '';
  const id = league && (league.leagueid || league.id);
  const result = { sources: [] };

  // Liquipedia: full metadata (canonical name, dates, prize pool, location, format, organizer)
  if (liquipedia.ENABLED && name) {
    try {
      const meta = await liquipedia.getLeagueMetadata(name);
      if (meta) {
        Object.assign(result, meta);
        result.sources.push('liquipedia');
      }
    } catch (e) { /* 隔离 */ }
  }

  // Steam: prize pool (unique to Steam, complements/validates Liquipedia)
  if (steam.ENABLED && id) {
    try {
      const pp = await steam.getTournamentPrizePool(id);
      if (pp && pp.prizePool != null) {
        // Liquipedia 优先（人工策展更可靠），Steam 兜底
        if (result.prizePool == null) {
          result.prizePool = pp.prizePool;
          result.prizePoolCurrency = pp.prizePoolCurrency || 'USD';
        }
        result.sources.push('steam');
      }
    } catch (e) { /* 隔离 */ }
  }

  return Object.keys(result).length > 1 ? result : null;
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

  // Liquipedia：按战队「名称」查询名册（非 id），故先用 curation 把 teamId 映射到规范队名。
  // 已知限制：Liquipedia 名册 account_id 全部为 null（HTML 不可靠），而 consensus.crossMembers
  // 以 account_id 为主键（normNum 为 null 的成员会被直接 return 丢弃），因此这些成员当前
  // 不会出现在交叉验证结果中、也不会被标记 verified。要让 Liquipedia 名册真正生效，需在
  // consensus.crossMembers 中增加基于 name 的回退匹配（属 consensus.js 改动，本次不动）。
  // 现阶段保留采集以便未来增强，且任一源失败不影响其它源。
  const cu = curation.curatedTeamFor(teamId);
  const teamName = cu && cu.name;
  if (liquipedia.ENABLED && teamName) {
    try {
      const rs = await liquipedia.getTeamRoster(teamName);
      if (rs && rs.length) lists.push({ source: 'liquipedia', members: rs });
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

// ===== 赛事排名聚合 =====
// 由 api.getLeagueMatches 提供的已结束比赛聚合每支队伍的胜负，
// 不依赖 Liquipedia（避免 IP 风险）。
// 入参 leagueId；返回 [{ team_id, name, tag, wins, losses, games, winRate }]
// 按 胜场降序 -> 负场升序 排序。
function getLeagueStandings(leagueId) {
  if (!leagueId) return Promise.resolve([]);
  return api.getLeagueMatches(leagueId).then(function (matches) {
    const list = matches || [];
    const stats = {};  // team_id -> { wins, losses, name }
    list.forEach(function (m) {
      const rId = m.radiant_team_id;
      const dId = m.dire_team_id;
      if (rId) {
        if (!stats[rId]) stats[rId] = { wins: 0, losses: 0, name: m.radiant_team_name || ('Team ' + rId), tag: '' };
        if (m.radiant_win) stats[rId].wins++;
        else stats[rId].losses++;
      }
      if (dId) {
        if (!stats[dId]) stats[dId] = { wins: 0, losses: 0, name: m.dire_team_name || ('Team ' + dId), tag: '' };
        if (m.radiant_win) stats[dId].losses++;
        else stats[dId].wins++;
      }
    });
    const out = Object.keys(stats).map(function (id) {
      const s = stats[id];
      const games = s.wins + s.losses;
      return {
        team_id: Number(id),
        name: s.name,
        tag: (s.name || '').slice(0, 4).toUpperCase(),
        wins: s.wins,
        losses: s.losses,
        games: games,
        winRate: games ? Math.round(s.wins / games * 100) : 0
      };
    });
    out.sort(function (a, b) {
      if (b.wins !== a.wins) return b.wins - a.wins;
      return a.losses - b.losses;
    });
    return out;
  }).catch(function () { return []; });
}

// ===== 赛事选手统计聚合 =====
// 入参 matchIds（数组）；返回 [{ account_id, name, games, kills, deaths, assists,
//                                 kda, gpm, xpm, wins, winRate }]
// 并发限制：3 个并行，避免一次请求过多触发 OpenDota 限流。
function getPlayerStats(matchIds) {
  const ids = (matchIds || []).filter(function (id) { return !!id; });
  if (!ids.length) return Promise.resolve([]);
  const agg = {};  // account_id -> {...}
  function batch(start) {
    if (start >= ids.length) return Promise.resolve();
    const chunk = ids.slice(start, start + 3);
    return Promise.all(chunk.map(function (mid) {
      // 直接用 api.getMatch 一次拿到 match + players，避免重复请求
      return api.getMatch(mid).then(function (m) {
        if (!m || !m.players) return;
        const radiantWin = !!m.radiant_win;
        m.players.forEach(function (p) {
          if (!p.account_id) return;
          const isRadiant = (p.isRadiant != null) ? p.isRadiant : (p.player_slot < 128);
          if (!agg[p.account_id]) {
            agg[p.account_id] = {
              account_id: p.account_id,
              name: p.name || p.personaname || '',
              games: 0, kills: 0, deaths: 0, assists: 0,
              gpmSum: 0, xpmSum: 0, wins: 0
            };
          }
          const a = agg[p.account_id];
          a.games++;
          a.kills += p.kills || 0;
          a.deaths += p.deaths || 0;
          a.assists += p.assists || 0;
          a.gpmSum += p.gold_per_min || 0;
          a.xpmSum += p.xp_per_min || 0;
          // 胜负：天辉方 radiant_win 才算胜；夜魇方 !radiant_win 才算胜
          if (isRadiant && radiantWin) a.wins++;
          if (!isRadiant && !radiantWin) a.wins++;
        });
      }).catch(function () {});
    })).then(function () { return batch(start + 3); });
  }
  return batch(0).then(function () {
    return Object.keys(agg).map(function (id) {
      const a = agg[id];
      const kda = a.deaths > 0 ? (a.kills + a.assists) / a.deaths : (a.kills + a.assists);
      return {
        account_id: a.account_id,
        name: a.name,
        games: a.games,
        kills: a.kills,
        deaths: a.deaths,
        assists: a.assists,
        kda: Math.round(kda * 100) / 100,
        gpm: a.games ? Math.round(a.gpmSum / a.games) : 0,
        xpm: a.games ? Math.round(a.xpmSum / a.games) : 0,
        wins: a.wins,
        winRate: a.games ? Math.round(a.wins / a.games * 100) : 0
      };
    }).sort(function (x, y) { return y.kda - x.kda; });
  });
}

// 系列赛聚合：把同一 series_id 的多场比赛归为一个系列卡。
// 优先用 OpenDota 的 series_id（DPC/大型赛事 BO3/BO5 必有）；无 series_id 的单场独立成组（视为 BO1）。
// 返回 series 数组，每个含 { key, games, scoreA, scoreB, boType, isLive, isRecent, isMulti, radiantName, direName, ... }
// boType：series_type 0=BO1 / 1=BO3 / 2=BO5；无 series_type 时按 games 数推断。
function groupSeries(matches) {
  if (!matches || !matches.length) return [];
  const groups = {};
  const order = [];
  matches.forEach(function (m) {
    const sid = m.series_id;
    const key = (sid != null && sid !== 0) ? ('s' + sid) : ('m' + m.match_id);
    if (!groups[key]) {
      groups[key] = [];
      order.push(key);
    }
    groups[key].push(m);
  });
  const now = Date.now();
  const list = order.map(function (key) {
    const games = groups[key].slice().sort(function (a, b) {
      return (a.start_time || 0) - (b.start_time || 0);
    });
    const first = games[0];
    const last = games[games.length - 1];
    const radiantName = first.radiant_team_name || '天辉';
    const direName = first.dire_team_name || '夜魇';
    let scoreA = 0, scoreB = 0;
    let isLive = false;
    games.forEach(function (g) {
      if (g.radiant_win) scoreA++; else scoreB++;
      // 进行中：无 duration 或 duration=0 且 start_time 在最近 24h
      if ((!g.duration || g.duration === 0) && g.start_time && (now - g.start_time * 1000) < 24 * 3600 * 1000) {
        isLive = true;
      }
    });
    // 系列 BO 类型
    // OpenDota series_type 枚举：0=BO1（但 BO2 也用 0）、1=BO3、2=BO5。
    // 区分 BO2 与 BO3：series_type=0 且恰好 2 场 → BO2（双局积分制，可 1-1 平局）；
    // series_type=1 无论几场（2 场=2-0 横扫，3 场=2-1）都是 BO3。
    let boType = 'BO1';
    const st = first.series_type;
    if (st === 1) boType = 'BO3';
    else if (st === 2) boType = 'BO5';
    else if (games.length === 2) boType = 'BO2';
    else if (games.length === 3) boType = 'BO3';
    else if (games.length >= 4) boType = 'BO5';
    // 赛制说明文案
    const boLabel = boType === 'BO1' ? '单局制'
      : boType === 'BO2' ? '双局积分'
      : boType === 'BO3' ? '三局两胜'
      : '五局三胜';
    // BO2 可能平局（1-1）；其他赛制必有胜负
    const isDraw = boType === 'BO2' && scoreA === scoreB;
    // 最近 2h 内结束（用作 B 点缀判定）
    const lastEnd = last.start_time && last.duration ? (last.start_time + last.duration) * 1000 : 0;
    const isRecent = lastEnd && (now - lastEnd) < 2 * 3600 * 1000;
    return {
      key: key,
      games: games,
      scoreA: scoreA,
      scoreB: scoreB,
      boType: boType,
      boLabel: boLabel,
      isDraw: isDraw,
      isLive: isLive,
      isRecent: isRecent,
      isMulti: games.length > 1,
      radiantName: radiantName,
      direName: direName,
      radiantTeamId: first.radiant_team_id,
      direTeamId: first.dire_team_id,
      radiantWin: !isDraw && scoreA > scoreB,
      direWin: !isDraw && scoreB > scoreA,
      lastTime: last.start_time || 0
    };
  });
  // 按最新比赛时间倒序
  list.sort(function (a, b) { return b.lastTime - a.lastTime; });
  return list;
}

module.exports = {
  SOURCE_LABEL: SOURCE_LABEL,
  getLeagueTier: getLeagueTier,
  getLeagueName: getLeagueName,
  getLeagueWindow: getLeagueWindow,
  getLeagueMetadata: getLeagueMetadata,
  getLeagueStandings: getLeagueStandings,
  getPlayerStats: getPlayerStats,
  groupSeries: groupSeries,
  enrichTeamLogo: enrichTeamLogo,
  enrichPlayerAvatar: enrichPlayerAvatar,
  enrichTeamInfo: enrichTeamInfo,
  crossTeamMembers: crossTeamMembers,
  enrichLiveGames: enrichLiveGames,
  validatePlayerId: validatePlayerId
};
