// utils/steam.js
// 第三网络数据源：Steam Web API（Valve 官方 DOTA2 接口，免费 key）。
// 申请 key：https://steamcommunity.com/dev/apikey（需 Steam 账号，每天 100,000 次调用）。
//
// 启用条件：config.steam.enabled === true 且填了 apiKey。
// 未启用 → 所有方法优雅降级（resolve null/[]）。
//
// 核心价值：提供赛事奖金池（GetTournamentPrizePool，OpenDota/STRATZ 无此数据）、
// 战队官方信息、比赛详情等官方维度数据，作为 OpenDota/STRATZ 的交叉补充。

const config = require('./config.js');
const cloudProxy = require('./cloudProxy.js');

// 启用条件（二选一）：
//   A) 云代理模式（上线推荐）：config.cloudProxy.enabled=true → Steam key 由云函数环境变量注入，
//      客户端只传 path + params，绝不持 key。
//   B) 直连模式（本地调试 fallback）：config.steam.apiKey 有值（仅本地，绝不上传）。
const cloudOk = !!(config.cloudProxy && config.cloudProxy.enabled);
const ENABLED = !!(config.steam && config.steam.enabled) && (cloudOk || !!(config.steam && config.steam.apiKey));
const BASE = (config.steam && config.steam.base) || 'https://api.steampowered.com/IDOTA2Match_570';

function getDirect(path, params) {
  if (!config.steam || !config.steam.apiKey) return Promise.resolve(null);
  const ps = Object.assign({ key: config.steam.apiKey }, params || {});
  const qs = Object.keys(ps).map((k) => k + '=' + encodeURIComponent(ps[k])).join('&');
  const url = BASE + path + '/v1/?' + qs;
  return new Promise((resolve) => {
    wx.request({
      url: url,
      method: 'GET',
      header: { 'content-type': 'application/json' },
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300 && res.data) {
          resolve(res.data);
        } else {
          resolve(null);
        }
      },
      fail: () => resolve(null)
    });
  });
}

// 统一入口：云代理优先（key 安全），直连兜底（需本地 apiKey）。
function get(path, params) {
  if (!ENABLED) return Promise.resolve(null);
  if (cloudProxy.efAvailable()) {
    return cloudProxy.steamProxy(path, params)
      .catch(() => getDirect(path, params));
  }
  return getDirect(path, params);
}

// 联赛列表（Valve 官方注册联赛，可用于交叉校验）
function getLeagues() {
  if (!ENABLED) return Promise.resolve([]);
  return get('/GetLeagueListing').then((d) => {
    const list = (d && d.result && d.result.leagues) || [];
    return list.map((l) => ({
      leagueId: l.leagueid,
      name: l.name,
      description: l.description || '',
      url: l.tournament_url || ''
    }));
  }).catch(() => []);
}

// 战队信息（Valve 官方，按 team_id 查询）
//
// ★★ 2026-10-30（steam-proxy 熔断修因）：**本地 TTL 缓存 + 在途去重**。
//   背景：本方法是 `steamProxy` 唯一的客户端调用面，扇出源是 teams 页
//   `buildHotTasks` 的**最多 12 队 `Promise.all`**（另有 team-detail / h2h）。
//   真机 Console：出口切换瞬间 9 个在途请求一起失败 ⇒ `steam-proxy|steamProxy`
//   桶 3→9 fails 立即 OPEN（EF 与 Steam 实测本身健康）。
//   ⇒ 同队 10min 内只打一次网络；同队并发（详情页 + 列表 + 交锋页）复用同一 Promise。
const TEAM_INFO_TTL_MS = 10 * 60 * 1000;
const _teamInfoCache = {};      // teamId -> { at, value }
const _teamInfoInflight = {};   // teamId -> Promise

function getTeamInfo(teamId) {
  if (!ENABLED) return Promise.resolve(null);
  const k = String(teamId);
  const hit = _teamInfoCache[k];
  if (hit && Date.now() - hit.at < TEAM_INFO_TTL_MS) return Promise.resolve(hit.value);
  if (_teamInfoInflight[k]) return _teamInfoInflight[k];
  const p = get('/GetTeamInfoByTeamID', { start_at_team_id: teamId, teams_requested: 1 }).then((d) => {
    const teams = (d && d.result && d.result.teams) || [];
    const t = teams[0];
    if (!t) return null;
    return {
      teamId: t.team_id,
      name: t.name,
      tag: t.tag,
      logo: t.logo_url || '',
      country: t.country_code || ''
    };
  }).then((info) => {
    // 只缓存成功结果；null/失败不落盘（避免把瞬时故障固化成 10min 空值）
    if (info) _teamInfoCache[k] = { at: Date.now(), value: info };
    return info;
  }).catch(() => null);
  _teamInfoInflight[k] = p;
  const clear = () => { if (_teamInfoInflight[k] === p) delete _teamInfoInflight[k]; };
  p.then(clear, clear);
  return p;
}

// 赛事奖金池（原设计：Steam 独有，OpenDota/STRATZ 无此数据）
//
// ★ 2026-09-19（观察期真机诊断）**该调用已停用**，原因是它成了「EF 熔断污染源」：
//   ① **interface 错配**：Valve 的 GetTournamentPrizePool 属 `IEconDOTA2_570`，
//      而 steam-proxy EF 把所有请求硬编码在 `IDOTA2Match_570` 下
//      （supabase/functions/steam-proxy/index.ts:20 `STEAM_BASE`）→ 必然 404
//      → EF 包装为 **HTTP 502**；
//   ② **接口本身已废弃**：用路径逃逸指到正确 interface 后（实测 200），
//      **所有** leagueid（含 TI 2022/2023/2024）仍恒返回 `prize_pool:0, league_id:0`
//      —— 连入参都不回显 → Valve 已停止提供该数据（端点尚存但已失效）；
//   ③ **污染面**：本函数被 sources.js `getLeagueMetadata` 调用，
//      **每次赛事详情/联赛列表加载都会触发** → 累计 3 次即熔断 `steam-proxy`
//      → 连带拖垮同一 EF 下**正常**的 `steamLeagueScheduled`（LIVE 对局抓取）。
//      真机 Console 已完整呈现该链条（502 → breaker OPEN → 后续 action 全被拒）。
//
//   而奖池以 **Liquipedia 为主源**（sources.js 注释：「Liquipedia 优先，Steam 兜底」），
//   Steam 仅为兜底且兜底已失效 → **停用无任何功能损失，反而消除熔断污染**。
//
//   恢复条件：若 Valve 未来恢复该接口，需①改回下方实现 ②同步修 EF 的 interface 路由
//   （让 steamProxy 支持指定 interface，而非硬编码 IDOTA2Match_570）。
function getTournamentPrizePool(leagueId) {
  return Promise.resolve(null);   // 已停用，原因见上方注释块
  /* 原实现（保留以便恢复）：
  if (!ENABLED) return Promise.resolve(null);
  return get('/GetTournamentPrizePool', { league_id: leagueId }).then((d) => {
    const r = (d && d.result) || null;
    if (!r) return null;
    return {
      prizePool: r.prize_pool != null ? Number(r.prize_pool) : 0,
      prizePoolCurrency: r.prize_pool_currency || 'USD',
      leagueId: leagueId,
      source: 'steam'
    };
  }).catch(() => null);
  */
}

module.exports = {
  ENABLED: ENABLED,
  getLeagues: getLeagues,
  getTeamInfo: getTeamInfo,
  getTournamentPrizePool: getTournamentPrizePool
};
