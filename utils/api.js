// utils/api.js
// OpenDota 公开 API 封装（无需 key，免费）。文档：https://docs.opendota.com/
//
// 关键能力：
//  - request(): 带限流（约 60 次/分钟，最小间隔 + 429 退避）。
//  - cached(): 带 TTL 的本地缓存，命中不计入限流，是降低请求量的核心手段。
//  - 所有对外方法默认走 cached()，TTL 见 config.cacheTTL。
//  - 可选云函数代理（config.cloudProxy.enabled）：优先走云函数，失败回退直连。

const cache = require('./cache.js');
const config = require('./config.js');
const inc = require('./incremental.js');
const sqlFragments = require('./sqlFragments.js');
const breaker = require('./cloudBreaker.js');
// G7.4：API 失败监控（按 path 去重，避免刷屏）。monitor.js 无其他依赖，无循环风险。
const monitor = require('./monitor.js');
// 2026-07-27：curation 数据版本戳。缓存 key 前缀，确保代码/curation 变更后旧缓存自动失效。
// 由 scripts/sync-canon-map.js 生成 curation-shared.js 时填入（同云函数侧），仅作 fallback。
let _dataVersion = '0';
try { _dataVersion = (require('./curation-shared').dataVersion || '0'); } catch (e) { /* 离线兜底 */ }
// 兼容测试环境无 curation-shared 的情况
function _v() { return _dataVersion + ':'; }

const BASE = 'https://api.opendota.com/api';

// 赛事等级映射（OpenDota 的 tier 字符串枚举）
const TIER_RANK = {
  professional: 3, // S 级（顶级职业赛事）
  premium: 2,      // A 级（高级职业赛事）
  amateur: 1,      // 业余
  excluded: 0      // 其他 / 不计入
};

// ===== 限流器（滑动窗口并发模式）=====
// 改造说明：原实现用模块级 `lastCall + minGapMs` 强制所有请求串行，
// 让调用方的 Promise.all 在底层被串行化（10 个请求要 10s+）。
// 现改为滑动窗口计数：每分钟最多 60 次（OpenDota 限制），允许并发，
// 仅在窗口即将超限时 sleep 到最老请求滑出窗口。
const RATE = config.rateLimit;
const WINDOW_MS = 60 * 1000;          // 滑动窗口 1 分钟
const MAX_IN_WINDOW = Math.max(3, Math.floor(RATE.maxPerMin || 50)); // 窗口内最大请求数（留 10 余量）
const REQUEST_TIMEOUT_MS = RATE.timeoutMs || 12000;  // 单请求超时
const _timestamps = [];               // 窗口内请求时间戳队列

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// 等待直到窗口内有空闲槽位，返回本次请求入队的时间戳
function acquireSlot() {
  const now = Date.now();
  // 清理 1 分钟前的时间戳
  while (_timestamps.length && _timestamps[0] <= now - WINDOW_MS) _timestamps.shift();
  if (_timestamps.length < MAX_IN_WINDOW) {
    _timestamps.push(now);
    return Promise.resolve(now);
  }
  // 需要等待最老请求滑出窗口
  const wait = _timestamps[0] + WINDOW_MS - now + 10;
  return sleep(wait).then(() => acquireSlot());
}

function rawRequest(path, data) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const task = wx.request({
      url: BASE + path,
      data: data || {},
      method: 'GET',
      timeout: REQUEST_TIMEOUT_MS,
      header: { 'content-type': 'application/json' },
      success: (res) => {
        if (settled) return;
        settled = true;
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data);
        } else if (res.statusCode === 429) {
          // 触发限流，交由外层重试
          const err = new Error('HTTP 429');
          err.statusCode = 429;
          reject(err);
        } else {
          // 5xx/其他非 2xx：带 statusCode 抛出，供外层按状态码决定是否退避重试
          const err = new Error('HTTP ' + res.statusCode);
          err.statusCode = res.statusCode;
          reject(err);
        }
      },
      fail: (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      }
    });
    // 额外超时兜底（部分基础库 timeout 不触发 fail）
    setTimeout(() => {
      if (settled) return;
      settled = true;
      try { task && task.abort && task.abort(); } catch (e) {}
      reject(new Error('request timeout'));
    }, REQUEST_TIMEOUT_MS + 500);
  });
}

// 带限流的请求：滑动窗口并发限流，仅在窗口满时排队等待
// O-16（2026-08-15）：重试复用原 slot —— 429/5xx 重试不再重复 acquireSlot（新增占位）。
//   旧实现递归 request() 会再次占位：429 已说明配额耗尽，重试再占位会雪上加霜，
//   且退避等待期间窗口可能被其他请求占满导致重试无限排队。
//   修复：_keepSlot=true 时跳过 acquireSlot 复用首次槽位（首次已计过一次配额）。
//   窗口不变式守卫：重试真实发出时若首次时间戳已滑出 1 分钟窗口（>WINDOW_MS 等待），
//   则重新 acquireSlot 占位，避免「复用已过期槽位」导致窗口计数失真。
function request(path, data, opts) {
  opts = opts || {};
  const retry = opts.retries || 0;
  const firstTs = opts._firstTs;
  const slotPromise = (retry > 0 && firstTs && (Date.now() - firstTs) < WINDOW_MS)
    ? Promise.resolve(firstTs)            // 重试且首次槽位未过期 → 复用（不再占位）
    : acquireSlot().then((ts) => { if (firstTs == null) opts._firstTs = ts; return ts; });
  return slotPromise.then(() => rawRequest(path, data))
    .catch((err) => {
      const code = err && err.statusCode;
      // 429 限流 / 5xx 源站抖动（OpenDota 经 Cloudflare 常返回的 521/502/503）
      // 均做退避重试：429 是触发限流，5xx 多为瞬时源站不可用，重试通常可恢复，
      // 避免把瞬时故障直接暴露到 Console / 触发页面加载失败态。
      if ((code === 429 || (code >= 500 && code < 600)) && retry < RATE.maxRetries) {
        const delay = RATE.retryBaseMs * Math.pow(2, retry);
        return sleep(delay).then(() =>
          request(path, data, { retries: retry + 1, _firstTs: opts._firstTs }));
      }
      // G7.4：重试耗尽 / 不可重试的最终失败上报（按 path 去重，避免刷屏）。
      // 注：cached() 可能用陈旧缓存兜底不抛到调用方，但本次回源失败仍值得监控。
      monitor.apiCallError(path, code, (err && err.message) || 'unknown');
      throw err;
    });
}

// 响应校验：避免将畸形/空响应写入缓存；畸形时回退到陈旧缓存。
// 空数组 [] 视为合法（OpenDota 合法地返回空列表），仅拒绝 null/undefined/''/非数组/错误对象。
function validateResponse(path, data) {
  if (!path) return true;
  // /explorer?sql=... → 期望 { rows: [...] }
  if (path.indexOf('/explorer') === 0) {
    return !!(data && Array.isArray(data.rows));
  }
  // 数组型端点：/leagues, /search, /heroes, /heroStats, /items, /heroes/{id}/matchups,
  //              /teams/{id}/matches, /teams/{id}/players, /leagues/{id}/matches, /players/{id}/matches,
  //              /proMatches, /live（批次2 首页比赛流）
  if (path === '/leagues' || path === '/search' || path === '/heroes' ||
      path === '/heroStats' || path === '/items' || path === '/proMatches' || path === '/live' ||
      /^\/heroes\/\d+\/matchups$/.test(path) ||
      /^\/scenarios\/itemTimings/.test(path) ||
      /^\/teams\/\d+\/matches$/.test(path) || /^\/teams\/\d+\/players$/.test(path) ||
      /^\/leagues\/\d+\/matches$/.test(path) || /^\/players\/\d+\/matches$/.test(path)) {
    return Array.isArray(data);
  }
  // 对象型端点：/teams/{id}, /players/{id}
  if (/^\/teams\/\d+$/.test(path) || /^\/players\/\d+$/.test(path)) {
    return !!(data && typeof data === 'object' && !Array.isArray(data));
  }
  // 默认：不限制（未知端点不过度校验）
  return true;
}

// inflight 请求去重：同一缓存 key 并发调用复用同一个 Promise
// 解决痛点：冷启动时多页面/多组件同时发起同一请求，导致重复打网络。
const inflight = {};

// 带缓存的请求：命中缓存直接返回（不计入限流）；未命中时 inflight 去重
// 2026-07-27：缓存 key 加 _v() 前缀（dataVersion），保证 curation/代码变更后旧 key 自动失效。
function cached(path, data, ttlSec) {
  const key = _v() + path + '|' + JSON.stringify(data || {});
  const hit = cache.get(key, ttlSec);
  if (hit !== null && hit !== undefined) return Promise.resolve(hit);
  // inflight 去重：已有相同请求在进行中，复用其 Promise
  if (inflight[key]) return inflight[key];
  const p = request(path, data).then((data) => {
    if (!validateResponse(path, data)) {
      // 畸形响应：不写入缓存，尝试回退到陈旧缓存
      const stale = cache.peek(key);
      if (stale && stale.value != null) return stale.value;
      throw new Error('invalid response');
    }
    cache.set(key, data, ttlSec);
    return data;
  }, (err) => {
    delete inflight[key];
    throw err;
  }).then((v) => {
    delete inflight[key];
    return v;
  }, (err) => {
    // 兜底：validateResponse 校验失败（非网络错误）时第一层 .then 抛出的拒绝
    // 不会被上一层的 onRejected 捕获（它只处理 request 的网络错误），必须在此清理，
    // 否则 inflight[key] 会泄漏，导致后续相同请求永远复用这条被拒绝的 Promise。
    delete inflight[key];
    throw err;
  });
  inflight[key] = p;
  return p;
}

// 后台刷新进行中的 key 集合（避免同一 key 重复触发刷新）
const refreshInFlight = {};

// 带「stale-while-revalidate」的请求：保障信息更新的及时性。
//   - 硬 TTL 内且新鲜：直接返回缓存（最省流量）
//   - 未过期但已陈旧：先返回旧值，再在后台静默刷新（用户无感拿到新数据）
//   - 已过期/无缓存：正常拉取
// 与 cached() 返回形态一致（仅 resolve 业务数据），调用方无需改动取值逻辑。
function cachedFresh(path, data, freshSec, ttlSec) {
  const key = _v() + path + '|' + JSON.stringify(data || {});
  const meta = cache.getStale(key, freshSec, ttlSec);
  if (meta.expired || !meta.value) {
    return request(path, data).then((data) => {
      if (!validateResponse(path, data)) {
        // 畸形响应：回退到旧值（若有），否则抛错
        if (meta.value != null) return meta.value;
        throw new Error('invalid response');
      }
      cache.set(key, data, ttlSec);
      return data;
    });
  }
  if (meta.fresh) {
    return Promise.resolve(meta.value);
  }
  // 陈旧但未过期：返回旧值 + 后台刷新（去重）
  if (!refreshInFlight[key]) {
    refreshInFlight[key] = true;
    request(path, data)
      .then((data) => {
        if (validateResponse(path, data)) cache.set(key, data, ttlSec);
      })
      .catch(() => {})
      .then(() => { delete refreshInFlight[key]; });
  }
  return Promise.resolve(meta.value);
}

// 查询某请求最新采集时间戳（用于 UI 「更新于 X 前」）。返回 unix 毫秒或 0。
function fetchedAtOf(name, arg) {
  let path = null;
  if (name === 'team') path = '/teams/' + arg;
  else if (name === 'teamPlayers') path = '/teams/' + arg + '/players';
  else if (name === 'teamMatches') path = '/teams/' + arg + '/matches';
  else if (name === 'player') path = '/players/' + arg;
  else if (name === 'playerMatches') path = '/players/' + arg + '/matches';
  else if (name === 'leagueMatches') path = '/leagues/' + arg + '/matches';
  else if (name === 'leagueWindows') {
    path = '/explorer?sql=' + encodeURIComponent(sqlFragments.LEAGUE_WINDOWS_SQL);
  }
  if (!path) return 0;
  const meta = cache.peek(path + '|{}');
  return (meta && meta.fetchedAt) || 0;
}

// ===== 增量拉取（联赛/战队/选手比赛列表）=====
// 思路：首次/硬过期 → 走直连端点全量拉取并整体替换；
//       陈旧(软过期) → 用 /explorer 按 start_time 游标只拉「比缓存最新一场更新的比赛」，
//       按 match_id 去重并入缓存头部，显著降低大列表(尤其选手数千场)的重拉成本与流量。
function fetchMatchDelta(resource, id, cursor) {
  const sql = inc.buildMatchSql(resource, id, cursor);
  const path = '/explorer?sql=' + encodeURIComponent(sql);
  return request(path).then((d) => (d && d.rows) || []);
}

// 增量版 cachedFresh：resPath 为直连全量端点（首次/硬过期用）；resource/id 用于游标增量。
function cachedFreshIncremental(resPath, resource, id, freshSec, ttlSec) {
  const key = _v() + resPath + '|{}';
  const meta = cache.getStale(key, freshSec, ttlSec);
  if (meta.expired || !meta.value) {
    return request(resPath).then((data) => {
      if (!validateResponse(resPath, data)) {
        // 畸形响应：回退到旧值（若有），否则抛错
        if (meta.value != null) return meta.value;
        throw new Error('invalid response');
      }
      cache.set(key, data, ttlSec);
      return data;
    });
  }
  if (meta.fresh) {
    return Promise.resolve(meta.value);
  }
  // 陈旧未过期：后台增量合并（游标无效时退化为等待下次硬过期全量刷新）
  const cursor = inc.maxStart(meta.value);
  if (!refreshInFlight[key] && cursor > 0) {
    refreshInFlight[key] = true;
    fetchMatchDelta(resource, id, cursor)
      .then((delta) => {
        if (delta && delta.length) {
          cache.set(key, inc.mergeMatches(meta.value, delta), ttlSec);
        } else {
          cache.touch(key, ttlSec); // 无新数据，仅刷新采集时间（轮询心跳）
        }
      })
      // 不静默吞错：打印警告便于排查增量 SQL / 限流 / 字段变更等问题；
      // 用户仍拿到旧值，不影响主流程。
      .catch((e) => {
        console.warn('[api] incremental refresh failed:', resPath, (e && e.message) || e);
      })
      .then(() => { delete refreshInFlight[key]; });
  }
  return Promise.resolve(meta.value);
}

// ===== 云函数代理（可选）=====
// 当 config.cloudProxy.enabled 时，优先走云函数（国内加速 + 共享缓存），
// 失败时自动回退到直连逻辑（cached/cachedFresh），不产生循环依赖。
// 注意：cloudProxy.js 顶部 require('./api.js') 用于回退，故 api.js 顶部不可
// 反向 require('./cloudProxy.js')，否则循环依赖。cloudFetch 内联了相同逻辑。
// 2026-08-04（LIVE 比分刷新 v1.1，R3）：新增 force 透传 —— 云函数入口解构 event.force，
// 通用 OpenDota handler `if (!force)` 跳过缓存（云函数已支持，缺客户端通道）。
// 仅透传 truthy，未传时保持原形状（向后兼容）。

// 云调用超时（ms）：与 utils/cloudProxy.js 的 ACTION_TIMEOUT_MS 对齐（单一事实来源）。
// 读缓存/轻量 action 8s；实时抓取（云端需现场拉 Liquipedia/Steam/OpenDota 大端点）12s。
// ★ 2026-09-01（loadLeagues 12s 性能修复）：原 cloudFetch 无超时，云函数冷启动/回源慢时
//   页面 Promise.all 卡死（实测 12029ms）。超时 reject → tryCloudOrDirect 回退直连。
const CLOUD_ACTION_TIMEOUT = {
  _default: 8000,
  getLeagueMatches: 12000,
  getTeamMatches: 12000,
  getProMatches: 12000,
  getLiveMatches: 12000
};

function cloudFetch(action, params, force) {
  const threshold = (config.cloudProxy && config.cloudProxy.circuitBreakerThreshold) || 0;
  // 防御：wx.cloud 未初始化（测试环境 / 未开通云开发 / 用户拒绝授权）时直接 reject，
  // 交由 tryCloudOrDirect 回退到直连，避免 `wx.cloud.callFunction` 同步抛 TypeError 击穿调用链。
  if (!wx.cloud || !wx.cloud.callFunction) {
    return Promise.reject(new Error('cloud proxy unavailable'));
  }
  const data = { action: action, params: params || {} };
  if (force) data.force = true;
  // ★ 2026-09-01（loadLeagues 12s 性能修复）：云调用超时守卫（与 cloudProxy.call 同款）。
  //   原实现 wx.cloud.callFunction 裸调无限等待——云函数冷启动 / 云端 OpenDota 回源慢时，
  //   loadLeagues 的 Promise.all 卡死（实测 12029ms），用户首屏空白。
  //   读缓存/轻量 action 8s，实时抓取 action 12s（与 cloudProxy.ACTION_TIMEOUT_MS 对齐）。
  //   超时 reject（err.isTimeout=true）→ tryCloudOrDirect 回退直连；不计熔断（冷启动抖动 ≠ 源故障）。
  const timeoutMs = (CLOUD_ACTION_TIMEOUT[action] != null) ? CLOUD_ACTION_TIMEOUT[action] : CLOUD_ACTION_TIMEOUT._default;
  const cloud = wx.cloud.callFunction({
    name: 'aggregation',
    data: data
  });
  const timed = Promise.race([
    cloud,
    new Promise((_, reject) => {
      setTimeout(() => {
        const e = new Error('cloud call timeout (' + timeoutMs + 'ms): ' + action);
        e.isTimeout = true;
        reject(e);
      }, timeoutMs);
    })
  ]);
  return timed.then((res) => {
    const r = res && res.result;
    if (r && !r.error && r.data) {
      breaker.markSuccess();
      return r.data;
    }
    breaker.markFailure(threshold);
    throw new Error((r && r.error) || 'cloud proxy error');
  }).catch((err) => {
    // 超时不计熔断（冷启动抖动 ≠ 源故障）；仅真实失败（业务 error/网络 reject）计入
    if (!(err && err.isTimeout)) breaker.markFailure(threshold);
    throw err;
  });
}

function cloudEnabled() {
  const threshold = (config.cloudProxy && config.cloudProxy.circuitBreakerThreshold) || 0;
  return breaker.isAvailable(config.cloudProxy && config.cloudProxy.enabled, threshold);
}

// 方法名 → (action, params-builder)，与 cloudProxy.js 的 PARAM_MAP 对齐
// O-4（2026-08-15）：增加 path / data / ttlKey 元数据，供 tryCloudOrDirect 云成功路径
//   writeThrough 写穿本地缓存（断网兜底）。key 形态统一 _v()+path+'|'+JSON.stringify(data||{})，
//   与各 direct 函数 cached/cachedFreshIncremental 写入侧逐字符一致（单一事实来源）。
//   ⚠️ searchTeams 的 direct 用 cached('/search', {q}, ...) → data 非空，key 是 |{"q":..} 形态，
//      其余方法 data 为 null → |{} 形态。两者都必须与 direct 侧完全一致。
const ACTION_MAP = {
  getLeagues: function () { return { action: 'getLeagues', params: {}, path: '/leagues', ttlKey: 'leagues' }; },
  getLeagueWindows: function () { return { action: 'getLeagueWindows', params: {}, path: '/explorer?sql=' + encodeURIComponent(sqlFragments.LEAGUE_WINDOWS_SQL), ttlKey: 'leagueWindows' }; },
  getLeagueMatches: function (id) { return { action: 'getLeagueMatches', params: { leagueId: id }, path: '/leagues/' + id + '/matches', ttlKey: 'leagueMatches' }; },
  getMatch: function (id) { return { action: 'getMatch', params: { matchId: id }, path: '/matches/' + id, ttlKey: 'match' }; },
  searchTeams: function (name) { return { action: 'searchTeams', params: { q: name }, path: '/search', data: { q: name }, ttlKey: 'search' }; },
  getTeam: function (id) { return { action: 'getTeam', params: { teamId: id }, path: '/teams/' + id, ttlKey: 'team' }; },
  getTeamPlayers: function (id) { return { action: 'getTeamPlayers', params: { teamId: id }, path: '/teams/' + id + '/players', ttlKey: 'teamPlayers' }; },
  getTeamMatches: function (id) { return { action: 'getTeamMatches', params: { teamId: id }, path: '/teams/' + id + '/matches', ttlKey: 'teamMatches' }; },
  getHeroes: function () { return { action: 'getHeroes', params: {}, path: '/heroes', ttlKey: 'heroes' }; },
  // ★ 2026-09-01（P0-1）：首页比赛流两大数据源接入云代理（国内加速 + 云端共享缓存）。
  //   path 与 direct 侧 cached 写入 key 逐字符一致（/proMatches|{}、/live|{}），
  //   writeThrough 写穿后断网/云熔断回退直连可命中本地缓存（O-4 机制自动生效）。
  getProMatches: function () { return { action: 'getProMatches', params: {}, path: '/proMatches', ttlKey: 'proMatches' }; },
  getLiveMatches: function () { return { action: 'getLiveMatches', params: {}, path: '/live', ttlKey: 'liveMatches' }; }
};

// C1 高阶函数（2026-07-29）：统一「云代理优先 → 失败回退直连」模式。
// 原实现：9 个方法各自重复 cloudFetch(action, params).catch(() => direct()) 模板。
// 修复：提取为 tryCloudOrDirect(methodName, args, directFn, transform?)，
// 消除重复代码，集中管理熔断/回退逻辑。
// transform 可选：对云代理返回的数据做转换（与直连路径一致）。
// 2026-08-04（v1.1，R3）：第 5 参 force 透传给 cloudFetch（仅云函数路径；直连兜底不经 force，
// 本地缓存照常命中，防多用户 NAT 共享 IP 打爆 OpenDota 429）
// O-4（2026-08-15）：云成功路径 writeThrough 写穿本地缓存——断网/云熔断时回退直连
// 能命中本地缓存兜底（否则云路径拿到的数据从不落盘，断网即空）。
// 写穿 key 复用 ACTION_MAP 的 path/data/ttlKey 元数据，与 direct 写入侧逐字符一致。
function writeThrough(path, data, ttlSec) {
  if (!path || data == null) return;
  const key = _v() + path + '|' + JSON.stringify(data || {});
  cache.set(key, data, ttlSec);
}
function tryCloudOrDirect(methodName, args, directFn, transform, force) {
  const direct = directFn;
  if (!cloudEnabled()) return direct();
  const m = ACTION_MAP[methodName].apply(null, args || []);
  const cloud = cloudFetch(m.action, m.params, force);
  // O-4：写穿必须用 cloud 原始响应（transform 前），与 direct 侧 cached 的缓存内容
  //   （原始数据，transform 在返回给调用方前才做）完全一致；若写穿 transform 后的数据，
  //   下次直连命中会双重转换导致数据损坏。失败静默，不影响主流程。
  if (m.path && m.ttlKey && config.cacheTTL[m.ttlKey]) {
    cloud.then((raw) => {
      try { writeThrough(m.path, raw, config.cacheTTL[m.ttlKey]); } catch (e) { /* 静默 */ }
    }).catch(() => {});
  }
  const chain = transform ? cloud.then(transform) : cloud;
  return chain.catch(function () { return direct(); });
}

// ===== 对外方法 =====

function getLeagues() {
  return tryCloudOrDirect('getLeagues', [],
    // ★ 2026-09-01（loadLeagues 12s 性能修复）：direct 兜底改用 cachedFresh（stale-while-revalidate）。
    //   原 cached() 硬 TTL 6h 过期即删，云函数慢 + 缓存过期时只能干等（实测 12029ms）。
    //   cachedFresh：1h 新鲜直接返回；1h~6h 返回旧值 + 后台刷新（秒开，stale 语义）；
    //   超 6h 硬 TTL 才拉网络。云端 TTL 6h 不变（writeThrough 仍写本地）。
    //   赛事列表变化慢（S 级赛事排期以周计），1h 新鲜窗口足够，6h 硬 TTL 兜底。
    function () { return cachedFresh('/leagues', null, 60 * 60, config.cacheTTL.leagues); });
}

// ===== 批次2（2026-08-30）：首页全量比赛流数据源 =====
// ★ 2026-09-01（P0-1）：接入云代理（国内加速 + 云端共享缓存）——与其余 10 个方法统一。
//   direct 兜底保持 cached()（TTL 对齐 config.cacheTTL），云失败/熔断时回退直连，
//   断网时命中 writeThrough 写穿的本地缓存（O-4 机制自动生效）。
// OpenDota /proMatches：最近约 100 场职业赛（含双方队名/比分/胜负/series_type），
// 覆盖「已结束」主体。字段为平铺形态（radiant_name/dire_name 为字符串）。
function getProMatches() {
  return tryCloudOrDirect('getProMatches', [],
    function () { return cached('/proMatches', null, config.cacheTTL.proMatches); });
}

// OpenDota /live：当前所有进行中的公开对局（含路人局）。
// 职业场判定：league_id > 0（注意字段名是 league_id，与 proMatches 的 leagueid 不同）。
// 该端点天然含 radiant_score/dire_score 实时比分，供 LIVE 卡 60s 轮询刷新。
function getLiveMatches() {
  return tryCloudOrDirect('getLiveMatches', [],
    function () { return cached('/live', null, config.cacheTTL.liveMatches); });
}

// 一次 SQL 拿所有赛事近半年的时间窗口：{ leagueid -> { earliest, latest, count } }
// 用于「正在进行 / 全部（按最近比赛排序）」判定，避免逐个拉 /leagues/{id}/matches。
function transformLeagueWindows(data) {
  const rows = (data && data.rows) || [];
  const map = {};
  rows.forEach((r) => {
    if (r && r.leagueid != null) {
      map[r.leagueid] = {
        earliest: Number(r.earliest) || 0,
        latest: Number(r.latest) || 0,
        lastEnd: Number(r.last_end) || 0,   // 真实结束时间（start_time + duration 最大值）；0 = 未知
        count: Number(r.n) || 0
      };
    }
  });
  return map;
}

// O-2（2026-08-15）：下拉刷新失效修复。
// 根因：leagues.js 原 cache.remove('/leagues|{}') 缺 _v() 版本前缀，与 cached() 写入的
//   真实 key（_v() + path + '|{}'）不匹配 → 永远删不到旧缓存；且 explorer 缓存 key
//   用手拼 SQL（缺 last_end，第三份拷贝），与 getLeagueWindows() 引用的权威
//   sqlFragments.LEAGUE_WINDOWS_SQL 不一致 → 同样删不到。
// 修复：封装为单一函数，复用与写入侧完全一致的 key 构造，根治 key 漂移。
function invalidateLeagues() {
  const leaguesKey = _v() + '/leagues|{}';
  const windowsKey = _v() + '/explorer?sql=' + encodeURIComponent(sqlFragments.LEAGUE_WINDOWS_SQL) + '|{}';
  cache.remove(leaguesKey);
  cache.remove(windowsKey);
}

function getLeagueWindows() {
  const path = '/explorer?sql=' + encodeURIComponent(sqlFragments.LEAGUE_WINDOWS_SQL);
  return tryCloudOrDirect('getLeagueWindows', [],
    function () { return cached(path, null, config.cacheTTL.leagueWindows).then(transformLeagueWindows); },
    transformLeagueWindows);
}

function getLeagueMatches(leagueId, force) {
  // 比赛结果频繁变动：较短新鲜窗口 + 较长硬 TTL；陈旧时后台按游标增量合并
  // 2026-08-04（v1.1，R3）：force 透传云函数跳过缓存（进行中 BO3 低频刷新用）
  return tryCloudOrDirect('getLeagueMatches', [leagueId],
    function () {
      return cachedFreshIncremental('/leagues/' + leagueId + '/matches', 'league', leagueId, 10 * 60, config.cacheTTL.leagueMatches);
    }, null, force);
}

// 单场比赛详情（含 players 数组：英雄/KDA/GPM/XPM）。
// OpenDota /matches/{match_id} 返回结构：
//   match_id, duration, start_time, radiant_win, radiant_score, dire_score,
//   radiant_team_id, dire_team_id, league, leagueid,
//   players: [{ account_id, hero_id, kills, deaths, assists,
//               gold_per_min, xp_per_min, player_slot, team, personaname, name }]
function getMatch(matchId) {
  return tryCloudOrDirect('getMatch', [matchId],
    function () { return cached('/matches/' + matchId, null, config.cacheTTL.match); });
}

function transformSearchTeams(list) {
  return (list || [])
    .filter((item) => item && item.team_id)
    .map((item) => ({ team_id: item.team_id, name: item.name }))
    .slice(0, 30);
}

function searchTeams(name) {
  // 搜索结果短时缓存，避免连续相同搜索重复消耗配额
  return tryCloudOrDirect('searchTeams', [name],
    function () { return cached('/search', { q: name }, 5 * 60).then(transformSearchTeams); },
    transformSearchTeams);
}

// ★ 2026-08-01 修复：OpenDota /api/search 接口不稳定（常返回空结果），
//   改用 /api/teams 全量战队列表（24h 缓存）在本地按名匹配。
//   返回 { team_id, name, logo_url } 或 null。
function findTeamByName(name) {
  if (!name) return Promise.resolve(null);
  return cached('/teams', null, 24 * 3600).then(function (list) {
    if (!Array.isArray(list) || !list.length) return null;
    // ★ 2026-09-01（v8.6 Fix-G2）：归一化统一为「去非字母数字」——
    //   与快照 byName 键 / 详情页 nameTeams 的 normName 完全一致。
    //   原实现 replace(/\s+/g,'') 保留 + 号（"Pipsqueak+4"→pipsqueak+4），
    //   /teams 里 "Pipsqueak + 4" → pipsqueak4 → 精确键 miss 走模糊误配。
    //   同时剥离常见后缀（esports/gaming/team/club）提升简称命中率：
    //   "Level UP esports" 剥离后 = "levelup"，可直接精确命中 LP 简称 "Level UP"。
    function _norm(s) {
      return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    }
    function _stripSuffix(s) {
      return _norm(s).replace(/(esports|esport|gaming|team|club|dota)$/g, '');
    }
    var q = _norm(name);
    var qs = _stripSuffix(name);
    if (!q) return null;
    var best = null;
    var bestSuffix = null;
    var i, t, tn, tns, tag;
    // 第一轮：精确匹配（去非字母数字后完全相同；含后缀剥离双键）
    for (i = 0; i < list.length; i++) {
      t = list[i];
      tn = _norm(t.name || '');
      if (tn && tn === q) return { team_id: t.team_id, name: t.name, logo_url: t.logo_url || '' };
      if (qs && tn && tn === qs) return { team_id: t.team_id, name: t.name, logo_url: t.logo_url || '' };
    }
    // 第二轮：tag 精确匹配
    for (i = 0; i < list.length; i++) {
      t = list[i];
      tag = _norm(t.tag || '');
      if (tag && (tag === q || (qs && tag === qs))) return { team_id: t.team_id, name: t.name, logo_url: t.logo_url || '' };
    }
    // 第三轮：前缀匹配（LP 简称 → OpenDota 全名，如 levelup → levelupesports）
    //   仅「查询名是队名前缀」才匹配，防 "Team Spirit Academy" 误配到 "Team Spirit"
    //   （q=teamspiritacademy，tn=teamspirit 是 q 的前缀——方向反了，不再命中）。
    for (i = 0; i < list.length; i++) {
      t = list[i];
      tn = _norm(t.name || '');
      if (!tn || tn.length < q.length + 3) continue;  // 需比查询名至少长 3（防过度扩展）
      if (tn.indexOf(q) === 0) {
        if (!best || tn.length < (best.name || '').length) best = { team_id: t.team_id, name: t.name, logo_url: t.logo_url || '' };
      } else if (qs && qs.length >= 3 && tn.indexOf(qs) === 0) {
        if (!bestSuffix || tn.length < (bestSuffix.name || '').length) bestSuffix = { team_id: t.team_id, name: t.name, logo_url: t.logo_url || '' };
      }
    }
    if (best) return best;
    if (bestSuffix) return bestSuffix;
    return null;
  });
}

function getTeam(teamId) {
  return tryCloudOrDirect('getTeam', [teamId],
    function () { return cachedFresh('/teams/' + teamId, null, 15 * 60, config.cacheTTL.team); });
}

function getTeamPlayers(teamId) {
  return tryCloudOrDirect('getTeamPlayers', [teamId],
    function () { return cachedFresh('/teams/' + teamId + '/players', null, 20 * 60, config.cacheTTL.teamPlayers); });
}

function getTeamMatches(teamId) {
  return tryCloudOrDirect('getTeamMatches', [teamId],
    function () {
      return cachedFreshIncremental('/teams/' + teamId + '/matches', 'team', teamId, 10 * 60, config.cacheTTL.teamMatches);
    });
}

function getHeroes() {
  return tryCloudOrDirect('getHeroes', [],
    function () { return cached('/heroes', null, config.cacheTTL.heroes); });
}

// 职业赛场英雄统计（登场 / 胜场 / 禁用）。返回数组，元素含
//   { id, pro_pick, pro_win, pro_ban, ... }。用于英雄页排序与详情页胜率/登场率。
function getHeroStats() {
  return cached('/heroStats', null, config.cacheTTL.heroes);
}

// 英雄对位数据：该英雄与另一英雄同场时的胜负样本。返回数组，元素含
//   { hero_id, games_played, wins }。winRate = wins / games_played。
// 用于详情页「最佳 / 最差对位」（OpenDota 不区分同队/敌对，统一按同场胜率呈现）。
function getHeroMatchups(id) {
  return cached('/heroes/' + id + '/matchups', null, config.cacheTTL.heroes);
}

// 物品出装统计（P1 缺口补齐，2026-08-31）：OpenDota /scenarios/itemTimings?item={内部名}。
// 返回按「英雄 × 购买时间窗」聚合的全量对局样本数组：[{ hero_id, item, time, games, wins }]。
// 注意：games/wins 为字符串需 Number() 转换；time 为购买时刻（秒）；
// 该端点仅统计价格 >= 1400 金的物品，低价物品返回空数组（调用方据此展示「暂无统计」）。
function getItemTimings(itemName) {
  return cached('/scenarios/itemTimings?item=' + encodeURIComponent(itemName), null, 12 * 3600);
}

// P2 热门战队动态化（2026-08-31）：OpenDota /explorer 查询「近 N 天活跃 + 总场次达标 + rating 最高」的职业队。
// 相比 /teams 端点（全量 ~250KB），explorer 只返回 limit 行小 payload，且已带 name/tag/rating/wins/losses/last_match_time，
// 调用方无需再逐队 getTeam。注意：explorer 的 teams 表没有 rating 列（rating 在 team_rating 表），必须 join。
// cutoff 按天取整：同一天内缓存 key 稳定，避免跨请求缓存碎片化。
function getTopTeams(limit, activeDays) {
  limit = limit || 20;
  activeDays = activeDays || 90;
  const dayStart = Math.floor(Date.now() / 1000 / 86400) * 86400;
  const cutoff = dayStart - activeDays * 86400;
  const sql = 'SELECT t.team_id, t.name, t.tag, r.rating, r.wins, r.losses, r.last_match_time ' +
    'FROM team_rating r JOIN teams t ON t.team_id = r.team_id ' +
    'WHERE r.last_match_time >= ' + cutoff + ' AND t.name IS NOT NULL AND t.name <> \'\' ' +
    'AND (r.wins + r.losses) >= 100 ' +
    'ORDER BY r.rating DESC NULLS LAST LIMIT ' + limit;
  const path = '/explorer?sql=' + encodeURIComponent(sql);
  return cached(path, null, 6 * 3600).then((data) => {
    const rows = (data && data.rows) || [];
    return rows
      .map((r) => ({
        team_id: r.team_id,
        name: (r.name || '').trim(),
        tag: (r.tag || '').trim(),
        rating: r.rating || 0,
        wins: r.wins || 0,
        losses: r.losses || 0,
        last_match_time: r.last_match_time || 0
      }))
      .filter((t) => t.team_id > 0 && t.name);
  });
}

// 批量查询队伍名（team_id -> name）。
// 用途：OpenDota /leagues/{id}/matches 直连端点返回的 radiant_team_name / dire_team_name
// 普遍为 null（matches 表未存队名），需用 team_id 反查 teams 表补全，否则联赛比赛列表
// 队名全部缺失（兜底显示"天辉/夜魇"）。一次 /explorer SQL 批量取，长缓存降低请求量。
function getTeamNames(teamIds) {
  const ids = (teamIds || [])
    .map((x) => Number(x))
    .filter((x) => !isNaN(x) && x > 0);
  if (!ids.length) return Promise.resolve({});
  const sql = 'SELECT team_id, name FROM teams WHERE team_id IN (' + ids.join(',') + ')';
  const path = '/explorer?sql=' + encodeURIComponent(sql);
  return cached(path, null, 6 * 3600).then((data) => {
    const rows = (data && data.rows) || [];
    const map = {};
    rows.forEach((r) => { if (r && r.team_id != null) map[r.team_id] = r.name || ''; });
    return map;
  });
}

// F6（2026-08-31）：批量查询队伍 logo（team_id -> { name, logo_url }）。
// 用途：首页比赛流 LOGO 懒加载把「16 次 getTeam 单发」降为「1 次 explorer 批量」，
//   再配合 logoCache 批量写，显著减少 OpenDota 请求次数与限流风险。
// explorer 的 teams 表有 logo_url 字段（实测返回 steamcdn 地址），长缓存（6h）降低重复查询。
function getTeamLogos(teamIds) {
  const ids = (teamIds || [])
    .map((x) => Number(x))
    .filter((x) => !isNaN(x) && x > 0);
  if (!ids.length) return Promise.resolve({});
  // 注意：SQL 只允许数字 id（上面已过滤），无注入风险
  const sql = 'SELECT team_id, name, logo_url FROM teams WHERE team_id IN (' + ids.join(',') + ')';
  const path = '/explorer?sql=' + encodeURIComponent(sql);
  return cached(path, null, 6 * 3600).then((data) => {
    const rows = (data && data.rows) || [];
    const map = {};
    rows.forEach((r) => {
      if (r && r.team_id != null) {
        map[r.team_id] = { name: r.name || '', logo_url: r.logo_url || '' };
      }
    });
    return map;
  });
}

// 物品表（id -> { name, img, dname }）：OpenDota /constants/items 返回 { name: { id, img, dname } }，
// 反转为 id 索引便于比赛详情页按 item_0~5 数字 id 查物品名/图标。长缓存（物品几乎不变）。
// 注意：OpenDota 的 img 是相对路径 /apps/dota2/images/dota_react/items/{name}.png?t=xxx，
// 需拼接 Steam CDN 源站得到绝对地址（与英雄头像同源 cdn.cloudflare.steamstatic.com，已加入合法域名白名单）。
const ITEM_CDN_ORIGIN = 'https://cdn.cloudflare.steamstatic.com';
function getItems() {
  return cached('/constants/items', null, 24 * 3600).then((data) => {
    const map = {};
    if (!data) return map;
    Object.keys(data).forEach((name) => {
      const it = data[name];
      if (it && it.id != null) {
        // 规范为 Steam CDN 绝对地址；it.img 已含 ?t 时间戳，可正常加载
        let img = it.img || ('/apps/dota2/images/dota_react/items/' + name + '.png');
        if (img.indexOf('http') !== 0) {
          img = ITEM_CDN_ORIGIN + (img.charAt(0) === '/' ? img : '/' + img);
        }
        map[it.id] = { name: name, img: img, dname: it.dname || name };
      }
    });
    return map;
  });
}

// 物品基础表（数组）：OpenDota 旧端点 /items 已下线（返回 404），物品基础数据现统一来自
// /constants/items（对象，按物品内部名索引）。本函数把该对象转换为列表所需的数组形态：
// [{ id, name, cost, secret_shop, side_shop, recipe, localized_name }]，
// 供物品浏览与详情使用；与 getItems() 的 img/dname 合并补全显示信息。
// 注意：/constants/items 已不再提供 secret_shop / side_shop 字段，故这两项恒为 false（UI 相应标签不显示）；
// recipe（是否合成组件）改由 components 依赖图推导：凡被其它物品引用为组件的即标为配方。
function getItemsList() {
  return cached('/constants/items', null, 24 * 3600).then((obj) => {
    if (!obj || typeof obj !== 'object') return [];
    // 合成组件集合：出现在任意物品 components 中的物品名 → 即「配方 / 合成组件」
    const componentSet = new Set();
    Object.keys(obj).forEach((k) => {
      const comps = obj[k] && obj[k].components;
      if (Array.isArray(comps)) comps.forEach((c) => componentSet.add(c));
    });
    return Object.keys(obj).map((name) => {
      const it = obj[name] || {};
      return {
        id: it.id != null ? it.id : 0,
        name: name,
        localized_name: it.dname || name,
        cost: it.cost || 0,
        secret_shop: false,   // /constants/items 已不再提供该字段
        side_shop: false,     // /constants/items 已不再提供该字段
        recipe: componentSet.has(name)  // 由 components 依赖图推导
      };
    });
  });
}

module.exports = {
  BASE: BASE,
  TIER_RANK: TIER_RANK,
  request: request,
  cached: cached,
  cachedFresh: cachedFresh,
  // O-15（2026-08-15）：导出版本前缀构造，供 cloudCache 复用（本地 key 与 api 缓存同语义失效）
  _v: _v,
  invalidateLeagues: invalidateLeagues,
  fetchedAtOf: fetchedAtOf,
  getLeagues: getLeagues,
  getProMatches: getProMatches,
  getLiveMatches: getLiveMatches,
  getLeagueWindows: getLeagueWindows,
  getLeagueMatches: getLeagueMatches,
  getMatch: getMatch,
  searchTeams: searchTeams,
  findTeamByName: findTeamByName,
  getTeam: getTeam,
  getTeamPlayers: getTeamPlayers,
  getTeamMatches: getTeamMatches,
  getTopTeams: getTopTeams,
  getHeroes: getHeroes,
  getHeroStats: getHeroStats,
  getHeroMatchups: getHeroMatchups,
  getTeamNames: getTeamNames,
  getTeamLogos: getTeamLogos,
  getItems: getItems,
  getItemsList: getItemsList,
  getItemTimings: getItemTimings
};
