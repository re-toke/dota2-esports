// utils/haglund.js
// 第三方免费 DOTA2 赛程兜底源：dota.haglund.dev
//
// 来源说明：
//   该服务由 beeequeue/dota-matches-api 开源项目提供，跑在 Cloudflare Workers 上。
//   本质是 Liquipedia wikitext 的服务端封装，返回结构化 JSON（无需自己解析 wikitext），
//   并自带 3 小时缓存。对小程序而言，它的关键价值在于：
//     1. 无需设置 User-Agent（绕开 wx.request 禁设 UA 的根本限制）；
//     2. 返回的 JSON 结构与项目 normalizeScheduled 兼容（含 matchType/teams/startsAt）；
//     3. 完全免费、无需 API key、无明确速率限制。
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
// 风险与降级：
//   - 这是第三方个人项目，稳定性弱于 Liquipedia 官方 API；
//   - 数据本身派生自 Liquipedia，若 Liquipedia 真被全站封禁，本源也会失效；
//   - 本模块所有失败均 resolve 空对象（错误隔离，不影响其它源）。
//
// ★ 2026-08-22 新增（Liquipedia 故障期间的临时方案）★

var cache = require('./cache.js');

// 端点与缓存策略
var BASE = 'https://dota.haglund.dev/v1/matches';
var CACHE_KEY = 'haglund_upcoming_v1';
// 缓存 30 分钟：与服务端 3h 缓存错开，既能降低对外部稳定性的依赖，
// 又能在 Liquipedia 恢复后较快切换回主源。
var CACHE_TTL = 30 * 60;

// haglund 的 matchType 字段（如 "Bo3"）→ 项目内部统一 BO 格式
// 与 liquipedia-parse.js parseBoFormat 的产出形状对齐：{ format: 'BO3', games: 3 }
function normalizeBoType(matchType) {
  if (!matchType || typeof matchType !== 'string') return null;
  var s = matchType.trim().toUpperCase();
  // "BO3" / "BO5" / "BO1" / "BO2"
  var m = s.match(/^BO\s*([1-9])$/);
  if (m) return { format: 'BO' + m[1], games: parseInt(m[1], 10) };
  return null;
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

// 把 haglund 的单条对阵归一化为项目 normalizeScheduled 期望的 match 形状
// 字段对齐参考：subpackages/detail/league-detail/league-detail.js 里 liq map 段
function normalizeMatch(raw) {
  if (!raw || !raw.id) return null;
  var teams = Array.isArray(raw.teams) ? raw.teams : [];
  var tA = teams[0] || {};
  var tB = teams[1] || {};
  var start = isoToUnix(raw.startsAt);
  // TBD/TBA 占位：name 为空或字面 "TBD"/"TBA" 视为未编排
  var nameA = (tA.name && tA.name !== 'TBD' && tA.name !== 'TBA') ? tA.name : null;
  var nameB = (tB.name && tB.name !== 'TBD' && tB.name !== 'TBA') ? tB.name : null;

  return {
    // 用 haglund 的 id 作为去重键（形如 "TI2026Main:R02-M004"）
    matchId: raw.id,
    series_id: null,           // haglund 不返回 series_id（Valve 内部字段）
    teamA: nameA,
    teamB: nameB,
    teamAUrl: tA.url || null,
    teamBUrl: tB.url || null,
    scoreA: null,              // 未开赛无比分
    scoreB: null,
    start_time: start,         // Unix 秒，失败为 null
    // BO 格式透传：haglund 的 matchType 比 Liquipedia wikitext 更权威（结构化字段）
    boType: normalizeBoType(raw.matchType),
    // 上游元数据
    leagueName: raw.leagueName || null,
    leagueUrl: raw.leagueUrl || null,
    streamUrl: raw.streamUrl || null,
    source: 'haglund'
  };
}

// 按赛事名（leagueName）过滤；不传则返回全部
// 用于让客户端按当前赛事详情页的 leagueName 筛选对阵
function filterByLeague(matches, leagueName) {
  if (!leagueName || !matches || !matches.length) return matches || [];
  // 模糊匹配：haglund 的 leagueName 是 "TI 2026 - Main Event"，
  // 客户端传入的可能是 curation canonical 名 "The International 2026" 或别名。
  // 这里采用宽松包含：任何一方包含另一方的核心 token 即算命中。
  var target = String(leagueName).toLowerCase();
  return matches.filter(function (m) {
    if (!m.leagueName) return false;
    var ln = String(m.leagueName).toLowerCase();
    // 简单双向包含；命中 "TI 2026" 之类核心 token
    return ln.indexOf(target) !== -1 || target.indexOf(ln) !== -1;
  });
}

// 主入口：返回 { matches: [...], boFormat: {...}|null }
//   - opts.leagueName：可选，传入则按 leagueName 过滤；不传返回全部 UPCOMING 对阵
//   - opts.force：跳过本地缓存
//   - opts.now：内部测试注入用
// 任何失败 resolve { matches: [], boFormat: null }，绝不 reject。
function fetchUpcoming(opts) {
  opts = opts || {};
  var force = !!opts.force;
  var leagueName = opts.leagueName || null;

  // 1) 本地缓存命中直接返回
  if (!force) {
    var cached = cache.get(CACHE_KEY, CACHE_TTL);
    if (cached) {
      return Promise.resolve({
        matches: filterByLeague(cached.matches || [], leagueName),
        boFormat: cached.boFormat || null
      });
    }
  }

  // 2) wx.request 拉取
  return new Promise(function (resolve) {
    if (typeof wx === 'undefined' || !wx.request) {
      return resolve({ matches: [], boFormat: null });
    }
    wx.request({
      url: BASE,
      method: 'GET',
      timeout: 8000,
      success: function (res) {
        var data = res && res.data;
        if (res.statusCode !== 200 || !Array.isArray(data)) {
          return resolve({ matches: [], boFormat: null });
        }
        // 归一化 + 过滤已开赛/已过期（start_time 已过且已有比分的视为已结算，留给 OpenDota 段）
        var now = (opts.now || Math.floor(Date.now() / 1000));
        var normalized = [];
        var boAggregate = {}; // 用于推断整页主导 BO 格式
        data.forEach(function (raw) {
          var m = normalizeMatch(raw);
          if (!m) return;
          // 保留所有未来场 + 当前小时内的场（可能刚开赛但还没结算）
          if (m.start_time && m.start_time < now - 3600) return;
          normalized.push(m);
          if (m.boType && m.boType.format) {
            boAggregate[m.boType.format] = (boAggregate[m.boType.format] || 0) + 1;
          }
        });

        // 推断整页主导 BO 格式（出现次数最多）
        var mainBo = null;
        var mainBoCount = 0;
        Object.keys(boAggregate).forEach(function (k) {
          if (boAggregate[k] > mainBoCount) {
            mainBoCount = boAggregate[k];
            mainBo = k;
          }
        });
        var boFormat = mainBo ? { format: mainBo, games: parseInt(mainBo.replace('BO', ''), 10) } : null;

        var result = { matches: normalized, boFormat: boFormat };
        // 写缓存（保存全量，过滤在每次读取时做，避免一次拉取只服务单个 leagueName）
        try { cache.set(CACHE_KEY, result, CACHE_TTL); } catch (e) {}

        resolve({
          matches: filterByLeague(normalized, leagueName),
          boFormat: boFormat
        });
      },
      fail: function () {
        resolve({ matches: [], boFormat: null });
      }
    });
  });
}

module.exports = {
  fetchUpcoming: fetchUpcoming,
  // 导出测试辅助函数
  _normalizeMatch: normalizeMatch,
  _normalizeBoType: normalizeBoType,
  _isoToUnix: isoToUnix,
  _filterByLeague: filterByLeague
};
