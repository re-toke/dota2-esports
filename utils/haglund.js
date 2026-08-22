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

  // phase 推断（与 parseMatchFields 同口径）：
  //   未来时间 → upcoming；已开始但 < 24h → live；超过 24h → recent
  var phase = 'upcoming';
  if (start && start <= nowSec) {
    phase = ((nowSec - start) < 24 * 3600) ? 'live' : 'recent';
  }

  return {
    // —— 下游 groupLiquipediaMatches + buildSeriesFromSources 依赖字段 ——
    team1Name: nameA,           // ★ 对齐 Liquipedia 字段名（下游取 m.team1Name）
    team2Name: nameB,
    team1Short: '',             // haglund 无缩写
    team2Short: '',
    score1: 0,                  // 未开赛无比分
    score2: 0,
    walkover: 0,
    startTime: start,           // ★ groupLiquipediaMatches 通过 _liqStartOf 取此字段
    start_time: start,          // 双字段兼容
    boType: normalizeBoType(raw.matchType),  // ★ 字符串（'BO3'），不是对象
    boDeclared: !!(raw.matchType && /^bo\s*[1-9]$/i.test(raw.matchType)),  // 结构化字段视为显式声明
    finished: false,
    phase: phase,               // ★ 下游 PHASE_RANK 消费
    matchIds: [],               // haglund 用自研 id（非 Valve match_id），不填入 matchIds（避免误关联 OpenDota）
    mapSlots: 0,                // 无此字段
    // —— haglund 元数据（调试用，下游不依赖）——
    _haglundId: raw.id,
    _leagueName: raw.leagueName || null,
    _leagueUrl: raw.leagueUrl || null,
    _streamUrl: raw.streamUrl || null,
    _team1Url: tA.url || null,
    _team2Url: tB.url || null,
    _series_id: null,           // haglund 不返回 series_id
    _source: 'haglund'
  };
}

// 按赛事名（leagueName）过滤；不传则返回全部
// 用于让客户端按当前赛事详情页的 leagueName 筛选对阵
// ★ 匹配策略（三路，任一命中即保留）：
//   ① 双向子串包含（原策略，处理 "TI 2026" 包含于 "TI 2026 - Main Event"）
//   ② 数字年份核心词匹配（"The International 2026" 与 "TI 2026 - Main Event" 共享 "2026" + 前缀缩写）
//   ③ 已知缩写映射（TI ↔ The International，供 haglund leagueName 与 curation canonical 对齐）
var LEAGUE_ALIASES = [
  { re: /^the international\b/i, short: 'ti' },
  { re: /^the international\s+china\b/i, short: 'ti china' },
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
  // 查找目标名的缩写（如 "the international 2026" → "ti"）
  var targetShort = '';
  LEAGUE_ALIASES.forEach(function (a) {
    if (a.re.test(String(leagueName))) targetShort = a.short;
  });
  return matches.filter(function (m) {
    var ln = (m._leagueName || m.leagueName || '');
    if (!ln) return false;
    var low = String(ln).toLowerCase();
    // ① 双向子串包含
    if (low.indexOf(target) !== -1 || target.indexOf(low) !== -1) return true;
    // ② 年份 + 缩写匹配（如 "ti 2026" 包含于 "ti 2026 - main event"）
    if (targetYear && targetShort) {
      var lowYear = extractYear(low);
      // 查 leagueName 缩写（如 "TI 2026 - Main Event" → "ti"）
      var lnShort = '';
      LEAGUE_ALIASES.forEach(function (a) {
        if (a.re.test(ln)) lnShort = a.short;
      });
      if (targetYear === lowYear && targetShort && lnShort && targetShort === lnShort) return true;
      // 单边有缩写时也宽松匹配（haglund 的 leagueName 是 "TI 2026"，curation canonical 可能不含缩写模式）
      if (targetYear === lowYear && (targetShort === lnShort ||
          (targetShort && low.indexOf(targetShort) !== -1) ||
          (lnShort && target.indexOf(lnShort) !== -1))) return true;
    }
    // ③ 仅年份匹配（兜底，如两个来源都含 "2026" 且当前赛事是 TI 类 → 保留）
    //    注意：这可能误命中同年的其他赛事，但 haglund 通常按赛事分页返回，影响有限
    return false;
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
        data.forEach(function (raw) {
          var m = normalizeMatch(raw, now);
          if (!m) return;
          // 保留所有未来场 + 当前 24h 内的场（可能刚开赛但还没结算，留给下游 phase 判定）
          if (m.startTime && m.startTime < now - 24 * 3600) return;
          normalized.push(m);
        });

        // 推断整页主导 BO 格式（出现次数最多的 boType 字符串）
        var boFormat = inferPageBoFormat(normalized);

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
  _filterByLeague: filterByLeague,
  _inferPageBoFormat: inferPageBoFormat
};
