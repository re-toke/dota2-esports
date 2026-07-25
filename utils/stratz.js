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
const cache = require('./cache.js');
const consensus = require('./consensus.js');
const curation = require('./remoteCuration.js');
const cloudProxy = require('./cloudProxy.js');

const cloudEnabled = !!(config.cloudProxy && config.cloudProxy.enabled);
// 启用条件（二选一）：
//   A) 直连模式：config.stratz.apiKey 有值（key 随小程序分发，适合开发测试）
//   B) 云代理模式：config.cloudProxy.enabled=true + 云函数环境变量配 STRATZ_API_KEY
//      （key 不上传到客户端，上线推荐；云函数需部署 stratzGql action）
const ENABLED = !!(config.stratz && config.stratz.enabled && (config.stratz.apiKey || cloudEnabled));
const BASE = (config.stratz && config.stratz.base) || 'https://api.stratz.com/graphql';

// 启动日志：在开发者工具 Console 中一眼确认配置是否生效
if (ENABLED) {
  console.log('[stratz] ✅ ENABLED: true, base:', BASE);
} else {
  console.log('[stratz] ⏸️ DISABLED（如需启用，请在 utils/config.js 中填入 apiKey 并设置 enabled: true）');
}

// STRATZ 的 LeagueTier 枚举 → 本项目的 grade/rank 模型
// 完整枚举：UNRANKED / AMATEUR / PROFESSIONAL / PREMIER / MAJOR / MINOR /
//           DPC_MAJOR / DPC_MINOR / FIRST_BLOOD / QUALIFIER / ONLINE / EVENT / UNKNOWN
function mapStratzTier(tier) {
  if (!tier) return null;
  const t = String(tier).toUpperCase();
  // SSS 级：TI 国际邀请赛（由 communityTierFromName 精确匹配，STRATZ 不单独判 SSS）
  // S 级：DPC Major / Major（官方顶级积分赛）
  if (t === 'DPC_MAJOR' || t === 'MAJOR') {
    return { grade: 'S', rank: 3, label: 'S级', source: 'stratz' };
  }
  // S 级：Premier / Professional（顶级第三方 S-Tier 巡回赛）
  if (t === 'PREMIER' || t === 'PROFESSIONAL') {
    return { grade: 'S', rank: 3, label: 'S级', source: 'stratz' };
  }
  // A 级：DPC Minor / First Blood（A-Tier 第三方 + DPC Minor 乙级联赛）
  if (t === 'DPC_MINOR' || t === 'FIRST_BLOOD') {
    return { grade: 'A', rank: 2, label: 'A级', source: 'stratz' };
  }
  // B 级：Minor / Online / Event / Amateur（B-Tier 区域联赛 + 次级国际赛）
  if (t === 'MINOR' || t === 'ONLINE' || t === 'EVENT' || t === 'AMATEUR') {
    return { grade: 'B', rank: 1, label: 'B级', source: 'stratz' };
  }
  // 预选赛：低于正式赛事
  if (t === 'QUALIFIER') {
    return { grade: 'C', rank: 0, label: '预选', source: 'stratz' };
  }
  // UNKNOWN / UNRANKED / 其它未识别 → null（交由 sources.js 回退其它源）
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

function gqlDirect(query, variables) {
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

// 云代理模式：通过 wx.cloud.callFunction 中转，key 从云函数环境变量 STRATZ_API_KEY 读取。
// 客户端不存 key，适合上线环境。失败返回 null，由上层回退到直连或降级。
function gqlCloud(query, variables) {
  // 熔断态下直接跳过云调用（避免无云环境时每次都失败一次）
  if (!cloudProxy.isAvailable()) return Promise.resolve(null);
  try {
    return wx.cloud.callFunction({
      name: 'aggregation',
      data: { action: 'stratzGql', query: query, variables: variables }
    }).then((r) => {
      const result = r && r.result;
      if (result && result.data) {
        console.log('[stratz] ✓ cloud', query);
        return result.data;
      }
      console.warn('[stratz] cloud 返回空:', result && result.error);
      return null;
    }).catch((e) => {
      console.warn('[stratz] cloud 调用失败:', e && e.errMsg);
      return null;
    });
  } catch (e) {
    // cloud未初始化（wx.cloud 不可用）时直接回退
    return Promise.resolve(null);
  }
}

// GraphQL 请求入口：云代理优先（key 安全），直连兜底。
function gql(query, variables) {
  if (!ENABLED) return Promise.resolve(null);
  // 纯云代理模式：无本地 key，完全依赖云函数
  if (cloudEnabled && !config.stratz.apiKey) {
    return gqlCloud(query, variables);
  }
  // 混合模式：有本地 key + 云代理，优先云函数加速，失败回退直连
  if (cloudEnabled) {
    return gqlCloud(query, variables)
      .then((d) => d || gqlDirect(query, variables))
      .catch(() => gqlDirect(query, variables));
  }
  // 纯直连模式
  return gqlDirect(query, variables);
}

// 全部联赛（轻量字段），用于分级匹配
// 注：STRATZ 新 schema 把 leagueId / teamId / matchId 等都统一改成 id；
// 同时 leagues 字段新增必填参数 request: LeagueRequestType!，用于分页/排序
//
// 缓存策略：league 列表变更极慢（赛季级），用 6h TTL 缓存到本地，
// 避免「即将到来」Tab 每次渲染都触发数十次重复 GraphQL 查询。
const LEAGUES_CACHE_KEY = 'stratz_leagues';
const LEAGUES_CACHE_TTL = 6 * 3600;

// 实际拉取（不走缓存）：失败时上层负责降级
function fetchLeaguesRaw() {
  const q = `query { leagues(request: { take: 200 }) { id name tier displayName } }`;
  return gql(q).then((d) => {
    const list = (d && d.leagues) || [];
    return list.map((l) => ({
      id: l.id,
      name: l.displayName || l.name,
      tier: l.tier
    }));
  });
}

function getLeagues() {
  if (!ENABLED) return Promise.resolve([]);
  // 先取一份「不判过期」的兜底值（GraphQL 失败时回退用，避免缓存被 get 删除后无法兜底）
  const stale = cache.get(LEAGUES_CACHE_KEY, 0);
  // 新鲜命中：直接返回
  const cached = cache.get(LEAGUES_CACHE_KEY, LEAGUES_CACHE_TTL);
  if (cached) return Promise.resolve(cached);
  // 未命中/过期：拉取并写缓存；失败时用过期缓存兜底，再不行返回 []
  return fetchLeaguesRaw().then((list) => {
    cache.set(LEAGUES_CACHE_KEY, list, LEAGUES_CACHE_TTL);
    return list;
  }).catch(() => {
    return stale || [];
  });
}

// 按赛事名精确匹配 STRATZ 联赛（替代旧的 indexOf 子串匹配，避免 "Major" 误命中多个联赛）
// 流程：1) 归一名等值匹配；2) 回退到精选库 curation 的 canonical/aliases 反查 STRATZ 联赛
function findLeagueByName(name) {
  if (!ENABLED || !name) return Promise.resolve(null);
  return getLeagues().then((list) => {
    if (!list || !list.length) return null;
    // 1) 归一名精确匹配（与 consensus.js 同一归一逻辑，避免分歧）
    const key = consensus.normName(name);
    if (key) {
      for (let i = 0; i < list.length; i++) {
        if (consensus.normName(list[i].name) === key) return list[i];
      }
    }
    // 2) curation 别名回退：用精选库的 canonical/aliases 归一后反查 STRATZ 联赛
    var curated = null;
    try { curated = curation.curatedEventFor(name); } catch (e) { curated = null; }
    if (curated) {
      var aliases = [];
      if (curated.canonical) aliases.push(curated.canonical);
      if (Array.isArray(curated.aliases)) {
        for (var k = 0; k < curated.aliases.length; k++) aliases.push(curated.aliases[k]);
      }
      for (var i = 0; i < aliases.length; i++) {
        var ak = consensus.normName(aliases[i]);
        if (!ak) continue;
        for (var j = 0; j < list.length; j++) {
          if (consensus.normName(list[j].name) === ak) return list[j];
        }
      }
    }
    return null;
  }).catch(() => null);
}

// 按赛事名取分级（sources 调用）
function getLeagueTier(name) {
  if (!ENABLED || !name) return Promise.resolve(null);
  return findLeagueByName(name).then((hit) => {
    if (!hit) return null;
    return mapStratzTier(hit.tier);
  }).catch(() => null);
}

// 单赛事比赛列表（可用于补充 OpenDota 的对阵数据）
// 字段与 OpenDota /leagues/{id}/matches 直连接口对齐，确保 incremental.mergeMatches
// 跨源合并时不会因字段名/结构差异而错位。
function getLeagueMatches(leagueId) {
  if (!ENABLED) return Promise.resolve([]);
  const q = `query ($id: Int!) { league(id: $id) { id matches { id radiantWin startDateTime duration radiantScore direScore radiantTeam { id name } direTeam { id name } } } }`;
  return gql(q, { id: Number(leagueId) }).then((d) => {
    const ms = (d && d.league && d.league.matches) || [];
    return ms.map((m) => ({
      match_id: m.id,
      radiant_win: m.radiantWin,
      start_time: Math.floor((m.startDateTime || 0) / 1000),
      duration: m.duration,
      leagueid: Number(leagueId),
      radiant_score: m.radiantScore || 0,
      dire_score: m.direScore || 0,
      radiant_team_id: (m.radiantTeam && m.radiantTeam.id) || 0,
      radiant_team_name: (m.radiantTeam && m.radiantTeam.name) || '',
      dire_team_id: (m.direTeam && m.direTeam.id) || 0,
      dire_team_name: (m.direTeam && m.direTeam.name) || ''
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
  return findLeagueByName(name).then((hit) => {
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

module.exports = {
  ENABLED: ENABLED,
  getLeagues: getLeagues,
  getLeagueTier: getLeagueTier,
  getLeagueMatches: getLeagueMatches,
  getLeagueDisplayName: getLeagueDisplayName,
  getLeagueWindow: getLeagueWindow,
  getTeamRoster: getTeamRoster,
  getTeamLogo: getTeamLogo,
  getPlayerAvatar: getPlayerAvatar
};
