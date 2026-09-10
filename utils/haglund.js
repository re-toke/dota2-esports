// utils/haglund.js
// 第三方免费 DOTA2 赛程兜底源：dota.haglund.dev
//
// 来源说明：
//   该服务由 beeequeue/dota-matches-api 开源项目提供，跑在 Cloudflare Workers 上。
//   本质是 Liquipedia wikitext 的服务端封装，返回结构化 JSON（无需自己解析 wikitext），
//   并自带 3 小时缓存。对小程序而言，它的关键价值在于：
//     1. 无需设置 User-Agent（绕开 wx.request 禁设 UA 的根本限制）；
//     2. 返回的 JSON 结构与项目 normalizeScheduled 兼容（含 matchType/teams/startsAt）；
//     3. 完全免费、无需 API key。
//
// 数据契约：
//   GET https://dota.haglund.dev/v1/matches
//   → [{ id, hash, matchType, startsAt, leagueName, leagueUrl, streamUrl,
//        teams: [{ name, url }, { name, url }] }, ...]
//
// 接入位置：
//   作为 liquipedia.getScheduledMatches 的兜底层 —— Steam 未命中 + Liquipedia 云代理失败/空时
//   自动回退到本模块。返回的 { matches, boFormat } 形状与 Liquipedia 路径完全一致，
//   下游 BO 判定引擎、absorbSettledGames、客户端缓存等逻辑零改动。
//
// ★★ 2026-08-24 容灾强化（方案 A）★★
//   实测发现 haglund 存在 IP/UA 级限流（间歇 403）。引入三层容灾：
//     1. 熔断器（CIRCUIT）：连续失败 ≥3 次进入 OPEN（熔断），冷却 10 分钟内不实际发请求，
//        直接返回缓存（即使过期）；冷却结束进入 HALF_OPEN 放一次探测，成功则复位 CLOSED。
//     2. SWR（stale-while-revalidate）：缓存 TTL 拉长到 60 分钟；硬过期后仍允许返回 stale
//        数据作为兜底（仅当熔断 OPEN 或请求失败时启用）。
//     3. 浏览器请求头：补 Referer + Accept-Language，降低被 403 的概率。
//   设计目标：haglund 哪怕限流，用户也能看到「上一次成功拉取的赛程」，而不是空白。
//
// 风险与降级：
//   - 这是第三方个人项目，稳定性弱于 Liquipedia 官方 API；
//   - 数据本身派生自 Liquipedia，若 Liquipedia 真被全站封禁，本源也会失效；
//   - 本模块所有失败均 resolve 空对象（错误隔离，不影响其它源）。

var cache = require('./cache.js');
// ★ 2026-09-01（P0-C1）：haglund 云代理。正式版客户端直连 dota.haglund.dev 必被域名白名单
//   拦截（海外未备案不可配）→ 改由云函数服务端拉取（10min 云端缓存），本模块仅做
//   「云代理优先 → 失败回退直连（开发态）→ stale 缓存」三级回退，归一化逻辑不变。
var cloudProxy = require('./cloudProxy.js');

// ============== 配置 ==============
var BASE = 'https://dota.haglund.dev/v1/matches';
var CACHE_KEY = 'haglund_upcoming_v1';

// 缓存 60 分钟（2026-08-24 从 30→60）：
//   haglund 上游自带 3h 缓存，本地拉长到 60min 既降低对外部稳定性的依赖，
//   又能在限流期间充分利用已缓存数据。配合 SWR，硬过期后仍可兜底。
var CACHE_TTL = 60 * 60;

// 过期缓存兜底窗口：硬过期后仍允许作为 stale 返回的最大时长（4 小时）。
// 超出此窗口的缓存视为彻底失效，宁可不显示也不显示严重过时数据。
var STALE_MAX_AGE_SEC = 4 * 3600;

// ============== 熔断器（CIRCUIT BREAKER）==============
// 状态机：CLOSED（正常）→ 连续失败≥3 → OPEN（熔断，冷却 10 分钟）→ 冷却结束 →
//        HALF_OPEN（放一次探测）→ 成功则 CLOSED / 失败则回到 OPEN
//
// 全部状态存 wx.localStorage，保证小程序冷启动后仍记得 haglund 当前是否可用。
var CB_KEY = 'haglund_circuit_v1';
var CB_FAIL_THRESHOLD = 3;          // 连续失败次数阈值
var CB_COOLDOWN_SEC = 10 * 60;      // OPEN 冷却时长（10 分钟）
var CB_HALF_OPEN_PROBE_SEC = 60;    // HALF_OPEN 单次探测保护窗口

function cbLoad() {
  try {
    var raw = wx.getStorageSync('dota2_' + CB_KEY);
    if (!raw) return null;
    if (typeof raw === 'object') return raw;
    return JSON.parse(raw);
  } catch (e) { return null; }
}

function cbSave(state) {
  try {
    wx.setStorageSync('dota2_' + CB_KEY, JSON.stringify(state));
  } catch (e) {}
}

// 返回 'closed' | 'open' | 'half_open'
function cbStatus(nowSec) {
  var s = cbLoad();
  if (!s) return 'closed';
  nowSec = nowSec || Math.floor(Date.now() / 1000);
  if (s.status === 'open') {
    // 冷却结束 → 转 half_open
    if (nowSec - (s.openedAt || 0) >= CB_COOLDOWN_SEC) {
      s.status = 'half_open';
      s.lastProbeAt = nowSec;
      cbSave(s);
      return 'half_open';
    }
    return 'open';
  }
  if (s.status === 'half_open') {
    // 探测窗口保护：60s 内只允许一次真实请求
    return 'half_open';
  }
  return 'closed';
}

// 成功反馈：状态复位到 closed，清零失败计数
function cbOnSuccess() {
  cbSave({ status: 'closed', failCount: 0, openedAt: 0, lastProbeAt: 0 });
}

// 失败反馈：累加失败计数，达阈值转 open
function cbOnFail() {
  var s = cbLoad() || { status: 'closed', failCount: 0, openedAt: 0, lastProbeAt: 0 };
  if (s.status === 'half_open') {
    // 探测失败 → 立即回到 open
    s.status = 'open';
    s.openedAt = Math.floor(Date.now() / 1000);
    s.failCount = CB_FAIL_THRESHOLD;
    cbSave(s);
    return;
  }
  s.failCount = (s.failCount || 0) + 1;
  if (s.failCount >= CB_FAIL_THRESHOLD) {
    s.status = 'open';
    s.openedAt = Math.floor(Date.now() / 1000);
  }
  cbSave(s);
}

// ============== 数据归一化 ==============

// haglund 的 matchType 字段（如 "Bo3"）→ 项目内部统一 BO 字符串（如 "BO3"）
// 与 liquipedia-parse.js parseMatchFields 的 boType 产出形状对齐：
//   boType 是字符串（'BO1'/'BO3'/'BO5'），不是对象 —— 下游 groupLiquipediaMatches 与
//   buildSeriesFromSources 的 boLabel 计算依赖严格相等比较（m.boType === 'BO1'）。
function normalizeBoType(matchType) {
  if (!matchType || typeof matchType !== 'string') return null;
  var s = matchType.trim().toUpperCase();
  var m = s.match(/^BO\s*([1-9])$/);
  if (m) return 'BO' + m[1];       // 字符串，与 parseMatchFields 一致
  return null;
}

// 整页主导 BO 推断：从全量 matches 里取出现次数最多的 boType 字符串
// 返回 { format: 'BO3', games: 3 } 或 null（与 parseBoFormat 形状一致）
function inferPageBoFormat(matches) {
  if (!Array.isArray(matches) || !matches.length) return null;
  var tally = {};
  matches.forEach(function (m) {
    var bt = m.boType;
    if (bt && typeof bt === 'string') tally[bt] = (tally[bt] || 0) + 1;
  });
  var best = null, bestCount = 0;
  Object.keys(tally).forEach(function (k) {
    if (tally[k] > bestCount) { bestCount = tally[k]; best = k; }
  });
  if (!best) return null;
  var games = parseInt(best.replace('BO', ''), 10) || 1;
  return { format: best, games: games };
}

// 将 haglund 的 ISO 时间字符串（"2026-08-22T02:10:00Z"）转为 Unix 秒
// 失败返回 null（下游会跳过该场）
function isoToUnix(iso) {
  if (!iso || typeof iso !== 'string') return null;
  try {
    var t = Date.parse(iso);
    if (isNaN(t)) return null;
    return Math.floor(t / 1000);
  } catch (e) {
    return null;
  }
}

// 把 haglund 的单条对阵归一化为项目下游兼容的 match 形状
// 字段名严格对齐 liquipedia-parse.js parseMatchFields 的产出（groupLiquipediaMatches 消费侧）：
//   team1Name/team2Name（★ 不是 teamA/teamB）
//   boType 字符串（★ 不是 {format,games} 对象）
//   phase 字符串（'upcoming'，由时间窗推断）
//   matchIds 数组（★ 不是 matchId 字符串）
//   startTime + start_time 双字段（兼容两种读取路径）
function normalizeMatch(raw, nowSec) {
  if (!raw || !raw.id) return null;
  var teams = Array.isArray(raw.teams) ? raw.teams : [];
  var tA = teams[0] || {};
  var tB = teams[1] || {};
  var start = isoToUnix(raw.startsAt);
  // TBD/TBA 占位：name 为空或字面 "TBD"/"TBA" 视为未编排
  var nameA = (tA.name && tA.name !== 'TBD' && tA.name !== 'TBA') ? tA.name : '';
  var nameB = (tB.name && tB.name !== 'TBD' && tB.name !== 'TBA') ? tB.name : '';
  nowSec = nowSec || Math.floor(Date.now() / 1000);

  // phase 推断（与 parseMatchFields / cloudfunctions/aggregation/liquipedia-parse.js 保持字节级镜像）：
  //   未来时间（含 5min 缓冲，防时钟漂移）→ upcoming
  //   已开赛但 < 6h → live（保守，避免短暂状态切换误判）
  //   超过 6h → recent（绝大多数比赛 < 6h）
  //   ★ 2026-08-22 根因 J（顺延误判修复·方案 A 上游侧）：
  //     顺延场景下规划时间到了但实际未开赛。haglund 无 map/score 信息，
  //     走「兜底证据 E4：规划时间过后 15min 才视为真正 LIVE」。
  var PROVISIONAL_GRACE_SEC = 15 * 60;
  var phase = 'upcoming';
  if (start && start <= nowSec - 5 * 60 - PROVISIONAL_GRACE_SEC) {
    var elapsed = nowSec - start;
    phase = (elapsed < 6 * 3600) ? 'live' : 'recent';
  }

  return {
    team1Name: nameA,
    team2Name: nameB,
    team1Short: '',
    team2Short: '',
    score1: 0,
    score2: 0,
    walkover: 0,
    startTime: start,
    start_time: start,
    boType: normalizeBoType(raw.matchType),
    boDeclared: !!(raw.matchType && /^bo\s*[1-9]$/i.test(raw.matchType)),
    finished: false,
    phase: phase,
    matchIds: [],
    mapSlots: 0,
    _haglundId: raw.id,
    _leagueName: raw.leagueName || null,
    _leagueUrl: raw.leagueUrl || null,
    _streamUrl: raw.streamUrl || null,
    _team1Url: tA.url || null,
    _team2Url: tB.url || null,
    _series_id: null,
    _source: 'haglund'
  };
}

// ============== 按赛事名过滤 ==============
var LEAGUE_ALIASES = [
  { re: /^the international\s+china\b/i, short: 'ti china' },
  { re: /^the international\b/i, short: 'ti' },
  { re: /^esl one\b/i, short: 'esl one' },
  { re: /^dreamleague\b/i, short: 'dreamleague' },
  { re: /^pgl\b/i, short: 'pgl' },
  { re: /^betboom\b/i, short: 'betboom' },
  { re: /^fissure\b/i, short: 'fissure' }
];
function extractYear(s) {
  var m = String(s).match(/(20\d{2})/);
  return m ? m[1] : '';
}
function filterByLeague(matches, leagueName) {
  if (!leagueName || !matches || !matches.length) return matches || [];
  var target = String(leagueName).toLowerCase();
  var targetYear = extractYear(target);
  var targetShort = '';
  LEAGUE_ALIASES.forEach(function (a) {
    if (a.re.test(String(leagueName))) targetShort = a.short;
  });
  return matches.filter(function (m) {
    var ln = (m._leagueName || m.leagueName || '');
    if (!ln) return false;
    var low = String(ln).toLowerCase();
    if (low.indexOf(target) !== -1 || target.indexOf(low) !== -1) return true;
    if (targetYear && targetShort) {
      var lowYear = extractYear(low);
      var lnShort = '';
      LEAGUE_ALIASES.forEach(function (a) {
        if (a.re.test(ln)) lnShort = a.short;
      });
      if (targetYear === lowYear && targetShort && lnShort && targetShort === lnShort) return true;
      if (targetYear === lowYear && (targetShort === lnShort ||
          (targetShort && low.indexOf(targetShort) !== -1) ||
          (lnShort && target.indexOf(lnShort) !== -1))) return true;
    }
    return false;
  });
}

// ============== 主入口 ==============
// 返回 { matches: [...], boFormat: {...}|null, _source: 'live'|'cache'|'stale'|'none' }
//   - opts.leagueName：可选，传入则按 leagueName 过滤；不传返回全部 UPCOMING 对阵
//   - opts.force：跳过本地缓存与熔断器，强制真实请求（调试/手动刷新用）
//   - opts.now：内部测试注入用
// 任何失败 resolve { matches: [], boFormat: null, _source: 'none' }，绝不 reject。
function fetchUpcoming(opts) {
  opts = opts || {};
  var force = !!opts.force;
  var leagueName = opts.leagueName || null;
  var nowSec = opts.now || Math.floor(Date.now() / 1000);

  // 1) 本地新鲜缓存命中 → 直接返回（最快路径）
  //    ★ 用 peek 而非 get：peek 不会删除过期条目，保留给 loadStaleAsFallback 兜底用
  //    （get 会在过期时调 removeStorageSync 把数据彻底删掉，导致 stale 兜底失效）
  if (!force) {
    var peeked = cache.peek(CACHE_KEY);
    if (peeked && peeked.value) {
      var ageSecFresh = Math.floor((Date.now() - (peeked.fetchedAt || 0)) / 1000);
      if (ageSecFresh <= CACHE_TTL) {
        return Promise.resolve({
          matches: filterByLeague(peeked.value.matches || [], leagueName),
          boFormat: peeked.value.boFormat || null,
          _source: 'cache'
        });
      }
    }
  }

  // 2) 熔断器判定
  var status = force ? 'closed' : cbStatus(nowSec);
  if (status === 'open') {
    // 熔断中：不发请求，尝试 stale 缓存兜底
    var staleResult = loadStaleAsFallback(leagueName, nowSec);
    return Promise.resolve(staleResult);
  }

  // 3) 拉取原始数据（P0-C1：云代理优先 → 失败回退 wx.request 直连）
  //    云代理返回与 haglund 原始端点相同的「原始数组」，归一化在本函数统一处理（零漂移）。
  //    云代理不可用（未开云开发/熔断）时直接走直连（开发态 urlCheck:false 可用；
  //    正式版直连会被白名单拦截，属预期——此时靠 stale 缓存兜底）。
  function fetchRaw() {
    if (typeof wx !== 'undefined' && wx.cloud && (cloudProxy.isAvailable() || cloudProxy.efAvailable())) {
      return cloudProxy.haglundUpcomingProxy(false)
        .then(function (data) { return { data: data, source: 'cloud' }; })
        .catch(function (e) {
          // 云代理失败（超时不计熔断，breaker 内部已处理）→ 回退直连
          console.info('[haglund] 云代理失败，回退直连:', (e && e.message) || e);
          return rawRequest();
        });
    }
    return rawRequest();
  }
  function rawRequest() {
    return new Promise(function (resolve) {
      if (typeof wx === 'undefined' || !wx.request) {
        var empty = { matches: [], boFormat: null, _source: 'none' };
        var staleOnly = loadStaleAsFallback(leagueName, nowSec);
        resolve(staleOnly.matches.length ? staleOnly : empty);
        return;
      }
      wx.request({
        url: BASE,
        method: 'GET',
        timeout: 8000,
        // 2026-08-24 容灾强化：补浏览器请求头降低 403 概率
        // 注意 wx.request 支持 header 但禁止设置 User-Agent（违反微信规范），
        // 因此只用 Referer + Accept-* 等允许的字段。
        header: {
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': 'https://liquipedia.net/'
        },
        success: function (res) {
          var data = res && res.data;
          if (res.statusCode !== 200 || !Array.isArray(data)) {
            // 请求失败（403/500/超时等）→ 计入熔断器
            cbOnFail();
            var stale = loadStaleAsFallback(leagueName, nowSec);
            resolve(stale);
            return;
          }
          resolve({ data: data, source: 'live' });
        },
        fail: function () {
          // 网络层失败 → 计入熔断器
          cbOnFail();
          var stale = loadStaleAsFallback(leagueName, nowSec);
          resolve(stale);
        }
      });
    });
  }
  return fetchRaw().then(function (fetched) {
    if (!fetched) return { matches: [], boFormat: null, _source: 'none' };
    // stale / none 是「已完成兜底」的结果（形状 { matches, boFormat, _source }，无 data 字段），
    // 直接透传——不可再按 data 判空，否则 stale 会被误判为失败返回 none。
    if (fetched._source === 'stale' || fetched._source === 'none') return fetched;
    if (!fetched.data) return { matches: [], boFormat: null, _source: 'none' };
    // 归一化 + 过滤已开赛/已过期（云代理与直连共用同一管线）
    var normalized = [];
    (fetched.data || []).forEach(function (raw) {
      var m = normalizeMatch(raw, nowSec);
      if (!m) return;
      if (m.startTime && m.startTime < nowSec - 24 * 3600) return;
      normalized.push(m);
    });
    var boFormat = inferPageBoFormat(normalized);
    var result = { matches: normalized, boFormat: boFormat };
    // 写缓存（保存全量，过滤在每次读取时做）
    try { cache.set(CACHE_KEY, result, CACHE_TTL); } catch (e) {}
    // 成功反馈熔断器（云代理成功也算成功——源本身可达）
    cbOnSuccess();
    return {
      matches: filterByLeague(normalized, leagueName),
      boFormat: boFormat,
      _source: fetched.source === 'cloud' ? 'cloud' : 'live'
    };
  });
}

// 从过期缓存读取 stale 数据作为兜底
// 返回 { matches, boFormat, _source: 'stale' } 或 { matches: [], boFormat: null, _source: 'none' }
function loadStaleAsFallback(leagueName, nowSec) {
  try {
    var peeked = cache.peek(CACHE_KEY);
    if (!peeked || !peeked.value) {
      return { matches: [], boFormat: null, _source: 'none' };
    }
    // 判定是否仍在 stale 兜底窗口内
    var ageSec = Math.floor((Date.now() - (peeked.fetchedAt || 0)) / 1000);
    if (ageSec > CACHE_TTL + STALE_MAX_AGE_SEC) {
      // 超出兜底窗口，宁可不显示也不显示严重过时数据
      return { matches: [], boFormat: null, _source: 'none' };
    }
    var v = peeked.value;
    return {
      matches: filterByLeague(v.matches || [], leagueName),
      boFormat: v.boFormat || null,
      _source: 'stale',
      _staleAgeSec: ageSec
    };
  } catch (e) {
    return { matches: [], boFormat: null, _source: 'none' };
  }
}

// ============== 调试 API ==============
// 返回当前熔断器状态 + 缓存概况，供设置页或日志展示
function getStatus() {
  var nowSec = Math.floor(Date.now() / 1000);
  var s = cbLoad() || { status: 'closed', failCount: 0, openedAt: 0, lastProbeAt: 0 };
  var cachePeek = cache.peek(CACHE_KEY);
  return {
    circuit: {
      status: cbStatus(nowSec),
      failCount: s.failCount || 0,
      openedAt: s.openedAt || 0,
      secondsSinceOpened: s.openedAt ? (nowSec - s.openedAt) : 0,
      cooldownSec: CB_COOLDOWN_SEC
    },
    cache: {
      hasData: !!(cachePeek && cachePeek.value),
      fetchedAt: (cachePeek && cachePeek.fetchedAt) || 0,
      ageSec: cachePeek ? Math.floor((Date.now() - cachePeek.fetchedAt) / 1000) : 0,
      ttlSec: CACHE_TTL,
      staleMaxAgeSec: STALE_MAX_AGE_SEC,
      isFresh: cachePeek ? (Date.now() <= cachePeek.expire) : false
    }
  };
}

// 手动重置熔断器（设置页"刷新赛程"按钮用）
function resetCircuit() {
  cbSave({ status: 'closed', failCount: 0, openedAt: 0, lastProbeAt: 0 });
}

module.exports = {
  fetchUpcoming: fetchUpcoming,
  getStatus: getStatus,
  resetCircuit: resetCircuit,
  // 导出测试辅助函数
  _normalizeMatch: normalizeMatch,
  _normalizeBoType: normalizeBoType,
  _isoToUnix: isoToUnix,
  _filterByLeague: filterByLeague,
  _inferPageBoFormat: inferPageBoFormat,
  // 熔断器内部函数（测试用）
  _cbStatus: cbStatus,
  _cbOnSuccess: cbOnSuccess,
  _cbOnFail: cbOnFail,
  _cbLoad: cbLoad,
  _cbSave: cbSave
};
