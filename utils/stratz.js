// utils/stratz.js
// 第二网络数据源：STRATZ GraphQL API（https://stratz.com/api）。
// 与 OpenDota 互补，作为「比赛内容来源多元化」里的第二个真实网络源。
//
// 启用条件：config.stratz.enabled === true 且填了 apiKey（免费 key 在 stratz.com 申请）。
// 未启用 / 无 key / 任意请求失败 → 所有方法优雅降级（resolve 为空），不影响其它源与现有行为。
//
// 注意：STRATZ 的 GraphQL schema 与 tier 枚举可能随版本变化，下面用防御式解析 + 映射，
// 取不到就返回 null，由 sources.js 回退到 OpenDota / 本地精选。

const config = require('./config.js');
const tiers = require('./tiers.js');

const ENABLED = !!(config.stratz && config.stratz.enabled && config.stratz.apiKey);
const BASE = (config.stratz && config.stratz.base) || 'https://api.stratz.com/graphql';

// 启动日志：在开发者工具 Console 中一眼确认配置是否生效
if (ENABLED) {
  console.log('[stratz] ✅ ENABLED: true, base:', BASE);
} else {
  console.log('[stratz] ⏸️ DISABLED（如需启用，请在 utils/config.js 中填入 apiKey 并设置 enabled: true）');
}

// STRATZ 的 LeagueTier 枚举 → 本项目的 grade/rank 模型
// 常见值：UNRANKED / AMATEUR / PROFESSIONAL / PREMIER / MAJOR / MINOR
function mapStratzTier(tier) {
  if (!tier) return null;
  const t = String(tier).toUpperCase();
  if (t === 'MAJOR' || t === 'PREMIER' || t === 'PROFESSIONAL') {
    return { grade: t === 'MAJOR' ? 'SSS' : 'S', rank: t === 'MAJOR' ? 4 : 3, label: t === 'MAJOR' ? 'TI 顶级' : 'S级', source: 'stratz' };
  }
  if (t === 'MINOR') return { grade: 'B', rank: 1, label: 'B级', source: 'stratz' };
  if (t === 'AMATEUR') return { grade: 'B', rank: 1, label: 'B级', source: 'stratz' };
  return null;
}

// ===== GraphQL 请求核心 =====
const MAX_RETRIES = 2;
const RETRY_DELAYS_MS = [1000, 2500]; // 第 1/2 次重试的退避

// 把 STRATZ 返回的 errors 数组精简成可读字符串
function fmtErrors(errors) {
  if (!errors || !errors.length) return '';
  return errors.map((e) => e.message).join('; ').slice(0, 240);
}

// 是否值得重试：429（限流）/ 5xx（服务端瞬时错误）/ 网络错
function isRetriable(statusCode) {
  return statusCode === 429 || (statusCode >= 500 && statusCode < 600);
}

function gql(query, variables) {
  if (!ENABLED) return Promise.resolve(null);

  function attempt(retryCount) {
    return new Promise((resolve) => {
      wx.request({
        url: BASE,
        method: 'POST',
        header: {
          'content-type': 'application/json',
          'Accept': 'application/json',
          'Authorization': 'Bearer ' + config.stratz.apiKey
        },
        data: JSON.stringify({ query: query, variables: variables || {} }),
        success: (res) => {
          // 成功：200~299 + data.data 存在
          if (res.statusCode >= 200 && res.statusCode < 300 && res.data && res.data.data) {
            if (retryCount === 0) console.log('[stratz] ✓', query);
            resolve(res.data.data);
            return;
          }
          // 429 / 5xx 且还有重试次数：退避后重试
          if (isRetriable(res.statusCode) && retryCount < MAX_RETRIES) {
            const delay = RETRY_DELAYS_MS[retryCount] || 2500;
            console.warn('[stratz] HTTP ' + res.statusCode + ' 准备重试 ' + (retryCount + 1) + '/' + MAX_RETRIES + '（' + delay + 'ms 后）');
            setTimeout(() => attempt(retryCount + 1).then(resolve), delay);
            return;
          }
          // 4xx（schema 错误/认证错误）或重试耗尽：分类打日志并降级
          if (res.statusCode === 401 || res.statusCode === 403) {
            console.warn('[stratz] HTTP ' + res.statusCode + ' 认证失败（请检查 apiKey 是否有效）');
          } else if (res.statusCode === 400) {
            console.warn('[stratz] HTTP 400 schema/参数错误:', fmtErrors(res.data && res.data.errors));
          } else if (res.statusCode >= 200 && res.statusCode < 300 && res.data && res.data.errors) {
            // 关键场景：HTTP 2xx 但 GraphQL body 里有 errors（参数缺失/字段不匹配）
            console.warn('[stratz] GraphQL 错误（HTTP ' + res.statusCode + '）:', fmtErrors(res.data.errors));
          } else {
            console.warn('[stratz] HTTP ' + res.statusCode + ' ' + fmtErrors(res.data && res.data.errors));
          }
          console.warn('[stratz] 失败 query:', query);
          resolve(null);
        },
        fail: (err) => {
          // 网络/超时：可重试
          if (retryCount < MAX_RETRIES) {
            const delay = RETRY_DELAYS_MS[retryCount] || 2500;
            console.warn('[stratz] 网络错误 准备重试 ' + (retryCount + 1) + '/' + MAX_RETRIES + '（' + delay + 'ms 后）:', err && err.errMsg);
            setTimeout(() => attempt(retryCount + 1).then(resolve), delay);
            return;
          }
          console.warn('[stratz] 请求失败（重试耗尽，网络/域名未配置）:', err && err.errMsg);
          console.warn('[stratz] 失败 query:', query);
          resolve(null);
        }
      });
    });
  }
  return attempt(0);
}

// 全部联赛（轻量字段），用于分级匹配
// 注：STRATZ 新 schema 把 leagueId / teamId / matchId 等都统一改成 id；
// 同时 leagues 字段新增必填参数 request: LeagueRequestType!，用于分页/排序
function getLeagues() {
  if (!ENABLED) return Promise.resolve([]);
  const q = `query { leagues(request: { take: 200 }) { id name tier displayName } }`;
  return gql(q).then((d) => {
    const list = (d && d.leagues) || [];
    return list.map((l) => ({
      id: l.id,
      name: l.displayName || l.name,
      tier: l.tier
    }));
  }).catch(() => []);
}

// 按赛事名取分级（sources 调用）
function getLeagueTier(name) {
  if (!ENABLED || !name) return Promise.resolve(null);
  return getLeagues().then((list) => {
    const key = name.toLowerCase();
    const hit = list.find((l) => (l.name || '').toLowerCase().indexOf(key) >= 0);
    if (!hit) return null;
    return mapStratzTier(hit.tier);
  }).catch(() => null);
}

// 单赛事比赛列表（可用于补充 OpenDota 的对阵数据）
function getLeagueMatches(leagueId) {
  if (!ENABLED) return Promise.resolve([]);
  const q = `query ($id: Int!) { league(id: $id) { id matches { id radiantName direName radiantWin startDateTime } } }`;
  return gql(q, { id: Number(leagueId) }).then((d) => {
    const ms = (d && d.league && d.league.matches) || [];
    return ms.map((m) => ({
      match_id: m.id,
      radiant_name: m.radiantName,
      dire_name: m.direName,
      radiant_win: m.radiantWin,
      start_time: Math.floor((m.startDateTime || 0) / 1000)
    }));
  }).catch(() => []);
}

// 按 leagueId 取规范展示名（交叉验证赛事名用）
function getLeagueDisplayName(leagueId) {
  if (!ENABLED || !leagueId) return Promise.resolve(null);
  const q = `query ($id: Int!) { league(id: $id) { name displayName } }`;
  return gql(q, { id: Number(leagueId) }).then((d) => {
    const l = d && d.league;
    return (l && (l.displayName || l.name)) || null;
  }).catch(() => null);
}

// 按赛事名取赛程窗口（startDateTime/endDateTime，STRATZ epoch 毫秒 → Unix 秒）
function getLeagueWindow(name) {
  if (!ENABLED || !name) return Promise.resolve(null);
  return getLeagues().then((list) => {
    const key = String(name).toLowerCase();
    const hit = list.find((l) => (l.name || '').toLowerCase().indexOf(key) >= 0);
    if (!hit || !hit.id) return null;
    // 通过 id 二次查询拉取 startDateTime/endDateTime（epoch 毫秒）
    const q = `query ($id: Int!) { league(id: $id) { startDateTime endDateTime } }`;
    return gql(q, { id: Number(hit.id) }).then((d) => {
      const l = d && d.league;
      if (!l) return null;
      const start = l.startDateTime ? Math.floor(l.startDateTime / 1000) : null;
      const end = l.endDateTime ? Math.floor(l.endDateTime / 1000) : null;
      if (start == null && end == null) return null;
      return { start: start, end: end };
    }).catch(() => null);
  }).catch(() => null);
}

// 战队名册（交叉验证队伍成员用）：返回 [{ account_id, name }]
function getTeamRoster(teamId) {
  if (!ENABLED || !teamId) return Promise.resolve([]);
  const q = `query ($id: Int!) { team(id: $id) { players { steamAccount { id personaname name } } } }`;
  return gql(q, { id: Number(teamId) }).then((d) => {
    const ps = (d && d.team && d.team.players) || [];
    return ps
      .filter((p) => p && p.steamAccount && p.steamAccount.id)
      .map((p) => ({
        account_id: p.steamAccount.id,
        name: p.steamAccount.personaname || p.steamAccount.name || ''
      }));
  }).catch(() => []);
}

// 战队 logo（STRATZ 图床，通常比 OpenDota 稳定）
function getTeamLogo(teamId) {
  if (!ENABLED) return Promise.resolve(null);
  const q = `query ($id: Int!) { team(id: $id) { id logoUrl } }`;
  return gql(q, { id: Number(teamId) }).then((d) => {
    return (d && d.team && d.team.logoUrl) || null;
  }).catch(() => null);
}

// 队员头像（Steam avatar，通常比 OpenDota 的 profile.avatarfull 更稳定）
function getPlayerAvatar(accountId) {
  if (!ENABLED) return Promise.resolve(null);
  const q = `query ($id: Long!) { player(steamAccountId: $id) { steamAccount { id avatar } } }`;
  return gql(q, { id: Number(accountId) }).then((d) => {
    const a = d && d.player && d.player.steamAccount;
    return (a && a.avatar) || null;
  }).catch(() => null);
}

// 正在进行的比赛（STRATZ live，与 Steam GetLiveLeagueGames 互补）
// 注：STRATZ GraphQL schema 中 MatchLiveType 没有顶层 leagueName 字段，
// 需用 league 子对象取名（schema 错误信息提示 leagueId / league 二选一）
function getLiveMatches() {
  if (!ENABLED) return Promise.resolve([]);
  const q = `query { live { matches { matchId radiantTeam { id name } direTeam { id name } radiantScore direScore gameState league { id name } } } }`;
  return gql(q).then((d) => {
    const ms = (d && d.live && d.live.matches) || [];
    return ms.map((m) => ({
      matchId: m.matchId,
      radiantName: (m.radiantTeam && m.radiantTeam.name) || '天辉',
      direName: (m.direTeam && m.direTeam.name) || '夜魇',
      radiantScore: m.radiantScore,
      direScore: m.direScore,
      radiantTeamId: (m.radiantTeam && m.radiantTeam.id) || 0,
      direTeamId: (m.direTeam && m.direTeam.id) || 0,
      gameState: m.gameState,
      leagueName: (m.league && m.league.name) || '',
      leagueId: (m.league && m.league.id) || 0,
      live: true
    }));
  }).catch(() => []);
}

module.exports = {
  ENABLED: ENABLED,
  getLeagues: getLeagues,
  getLeagueTier: getLeagueTier,
  getLeagueMatches: getLeagueMatches,
  getLeagueDisplayName: getLeagueDisplayName,
  getLeagueWindow: getLeagueWindow,
  getTeamRoster: getTeamRoster,
  getTeamLogo: getTeamLogo,
  getPlayerAvatar: getPlayerAvatar,
  getLiveMatches: getLiveMatches
};
