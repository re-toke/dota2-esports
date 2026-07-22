// utils/liquipedia.js
// 第四网络数据源：Liquipedia（独立人工策展电竞 wiki，MediaWiki action API）。
// 与 OpenDota/STRATZ/Steam（均派生自 Valve 比赛数据）不同，Liquipedia 是人工维护的
// 电竞 wiki，提供赛事元数据（规范名/日期/奖金池/地点/赛制/主办方）、战队名册、选手资料，
// 作为真正独立于 Valve 比赛数据的交叉验证来源。
//
// 启用条件：config.liquipedia.enabled === true（免费、无需 key）。
// Liquipedia 强制要求描述性 User-Agent，否则会 429/封禁；并要求遵守速率限制
// （默认串行 + 1500ms 间隔，比 OpenDota 更保守）。
//
// 未启用 / 任意请求失败 / 解析失败 → 所有方法优雅降级（resolve 为空），不影响其它源。
//
// 注意：小程序无 DOM 解析器，下面用正则从 MediaWiki parse API 返回的 HTML 中
// 防御式提取字段，取不到就返回 null，绝不抛错。

var config = require('./config.js');
var cache = require('./cache.js');
var consensus = require('./consensus.js');

var ENABLED = !!(config.liquipedia && config.liquipedia.enabled);
var BASE = (config.liquipedia && config.liquipedia.base) || 'https://liquipedia.net/dota2/api.php';
var USER_AGENT = (config.liquipedia && config.liquipedia.userAgent) || 'DOTA2-Esports-Hub/1.0 (WeChat Mini Program)';
var RATE_GAP_MS = (config.liquipedia && config.liquipedia.rateLimitMs) || 1500;
var CACHE_TTL = (config.liquipedia && config.liquipedia.cacheTTL) || (6 * 3600);

// 启动日志：在开发者工具 Console 中一眼确认配置是否生效
if (ENABLED) {
  console.log('[liquipedia] ✅ ENABLED: true, base:', BASE);
} else {
  console.log('[liquipedia] ⏸️ DISABLED（如需启用，请在 utils/config.js 中设置 enabled: true）');
}

// ===== 速率限制器（串行 + 最小间隔，复用 api.js 的 lastCall + sleep 模式）=====
var lastCall = 0;
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

var MAX_RETRIES = 2;
var RETRY_DELAYS_MS = [1500, 4000]; // 第 1/2 次重试的退避

function isRetriable(statusCode) {
  return statusCode === 429 || (statusCode >= 500 && statusCode < 600);
}

// 内部请求：调用 MediaWiki action API，返回解析后的 JSON。
// 始终 resolve（失败时 resolve null），绝不 reject —— 优雅降级。
function request(params) {
  if (!ENABLED) return Promise.resolve(null);

  // 串行限流：立即预留槽位，保证两次请求间隔不小于 RATE_GAP_MS
  var now = Date.now();
  var wait = Math.max(0, lastCall + RATE_GAP_MS - now);
  lastCall = now + wait;

  return sleep(wait).then(function () { return attempt(params, 0); });
}

function attempt(params, retryCount) {
  // 拼 query string
  var qs = Object.keys(params).map(function (k) {
    return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
  }).join('&');
  var url = BASE + '?' + qs;

  return new Promise(function (resolve) {
    wx.request({
      url: url,
      method: 'GET',
      header: {
        'Accept': 'application/json',
        'User-Agent': USER_AGENT
      },
      success: function (res) {
        // 成功：200~299 且有 body
        if (res.statusCode >= 200 && res.statusCode < 300 && res.data) {
          resolve(res.data);
          return;
        }
        // 429 / 5xx 且还有重试次数：退避后重试
        if (isRetriable(res.statusCode) && retryCount < MAX_RETRIES) {
          var delay = RETRY_DELAYS_MS[retryCount] || 4000;
          console.warn('[liquipedia] HTTP ' + res.statusCode + ' 准备重试 ' + (retryCount + 1) + '/' + MAX_RETRIES + '（' + delay + 'ms 后）');
          setTimeout(function () { attempt(params, retryCount + 1).then(resolve); }, delay);
          return;
        }
        console.warn('[liquipedia] HTTP ' + res.statusCode + ' 请求失败，降级返回 null');
        resolve(null);
      },
      fail: function (err) {
        // 网络/超时：可重试
        if (retryCount < MAX_RETRIES) {
          var delay = RETRY_DELAYS_MS[retryCount] || 4000;
          console.warn('[liquipedia] 网络错误 准备重试 ' + (retryCount + 1) + '/' + MAX_RETRIES + '（' + delay + 'ms 后）:', err && err.errMsg);
          setTimeout(function () { attempt(params, retryCount + 1).then(resolve); }, delay);
          return;
        }
        console.warn('[liquipedia] 请求失败（重试耗尽）:', err && err.errMsg);
        resolve(null);
      }
    });
  });
}

// ===== 防御式 HTML 解析辅助（小程序无 DOM 解析器，只能用正则）=====

// 转义正则元字符
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 去掉 HTML 标签，保留纯文本，解码常见实体
function stripTags(html) {
  if (!html) return '';
  return String(html)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/?[^>]+(>|$)/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// 从 infobox 的 <th>Label</th><td>Value</td> 行中提取 td 纯文本。
// 匹配不到返回 null（绝不抛错）。
function extractRow(html, label) {
  if (!html || !label) return null;
  try {
    var re = new RegExp('<th[^>]*>\\s*' + escapeRegex(label) + '\\s*</th>\\s*<td[^>]*>([\\s\\S]*?)</td>', 'i');
    var m = html.match(re);
    if (!m) return null;
    return stripTags(m[1]);
  } catch (e) {
    return null;
  }
}

// 取页面规范标题：首个 <h1>，回退到 infobox 顶部 <th colspan><b>标题</b></th>
function extractCanonical(html) {
  if (!html) return null;
  try {
    var m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (m) return stripTags(m[1]);
    var m2 = html.match(/<th[^>]*colspan[^>]*>\s*<b[^>]*>([\s\S]*?)<\/b>/i);
    if (m2) return stripTags(m2[1]);
    return null;
  } catch (e) {
    return null;
  }
}

// 解析奖金池文本，如 "$1,000,000 USD" → { amount: '1000000', currency: 'USD' }
function parsePrizePool(text) {
  if (!text) return null;
  try {
    var m = text.match(/([\$€£¥])\s*([\d,]+(?:\.\d+)?)\s*([A-Za-z]{3})?/);
    if (m) {
      return { amount: m[2].replace(/,/g, ''), currency: m[3] || null };
    }
    // 退而求其次：纯数字 + 可选货币码
    var m2 = text.match(/([\d,]+(?:\.\d+)?)\s*([A-Za-z]{3})?/);
    if (m2) {
      return { amount: m2[1].replace(/,/g, ''), currency: m2[2] || null };
    }
    return null;
  } catch (e) {
    return null;
  }
}

// 取 parse API 返回的页面 HTML 文本，失败/页面不存在返回 null
function fetchPageHtml(pageName) {
  if (!pageName) return Promise.resolve(null);
  return request({
    action: 'parse',
    page: pageName,
    format: 'json',
    prop: 'text'
  }).then(function (data) {
    try {
      if (!data || !data.parse || !data.parse.text || !data.parse.text['*']) return null;
      return data.parse.text['*'];
    } catch (e) {
      return null;
    }
  }).catch(function () { return null; });
}

// 从一段文本中收集所有 yyyy-MM-dd / yyyy-M-d / yyyy/MM/dd 形态的日期
function collectDates(text) {
  if (!text) return [];
  try {
    var ms = text.match(/\d{4}[-/]\d{1,2}([-/]\d{1,2})?/g);
    return ms || [];
  } catch (e) {
    return [];
  }
}

// ===== 公共方法 =====

// 1. 赛事元数据
// 返回 { canonical, startDate, endDate, prizePool, prizePoolCurrency, location, format, organizer, source }
// 或 null。每个字段独立 try/catch，缺一个不影响其它字段。
function getLeagueMetadata(name) {
  if (!ENABLED) return Promise.resolve(null);
  if (!name) return Promise.resolve(null);

  var cacheKey = 'liquipedia_league_' + consensus.normName(name);
  var cached = cache.get(cacheKey, CACHE_TTL);
  if (cached) return Promise.resolve(cached);

  return fetchPageHtml(name).then(function (html) {
    if (!html) return null;

    var result = { source: 'liquipedia' };
    var anyField = false;

    try { result.canonical = extractCanonical(html) || name; anyField = true; } catch (e) { result.canonical = name; }
    try { result.startDate = extractRow(html, 'Start Date') || extractRow(html, 'Start'); if (result.startDate) anyField = true; } catch (e) { result.startDate = null; }
    try { result.endDate = extractRow(html, 'End Date') || extractRow(html, 'End'); if (result.endDate) anyField = true; } catch (e) { result.endDate = null; }
    try {
      var pp = extractRow(html, 'Prize Pool') || extractRow(html, 'Prize');
      var parsed = parsePrizePool(pp);
      result.prizePool = parsed ? parsed.amount : null;
      result.prizePoolCurrency = parsed ? parsed.currency : null;
      if (parsed) anyField = true;
    } catch (e) { result.prizePool = null; result.prizePoolCurrency = null; }
    try { result.location = extractRow(html, 'Location') || extractRow(html, 'Venue'); if (result.location) anyField = true; } catch (e) { result.location = null; }
    try { result.format = extractRow(html, 'Format'); if (result.format) anyField = true; } catch (e) { result.format = null; }
    try { result.organizer = extractRow(html, 'Organizer'); if (result.organizer) anyField = true; } catch (e) { result.organizer = null; }

    if (!anyField) return null;

    cache.set(cacheKey, result, CACHE_TTL);
    return result;
  }).catch(function () { return null; });
}

// 2. 战队名册
// 返回 [{ account_id, name, position, joinDate, leaveDate }] 或 []。
// 注意：Liquipedia HTML 中 account_id 通常不可靠/缺失，统一设为 null。
// consensus.crossMembers 会用 name 匹配作为回退，故无 account_id 的成员仅参与
// 基于名称的交叉验证，不参与基于 id 的验证（这是可接受的降级）。
function getTeamRoster(name) {
  if (!ENABLED) return Promise.resolve([]);
  if (!name) return Promise.resolve([]);

  var cacheKey = 'liquipedia_team_' + consensus.normName(name);
  var cached = cache.get(cacheKey, CACHE_TTL);
  if (cached) return Promise.resolve(cached);

  return fetchPageHtml(name).then(function (html) {
    if (!html) return [];

    var members = [];
    try {
      var trs = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
      for (var i = 0; i < trs.length; i++) {
        var tr = trs[i];
        var tds = tr.match(/<td[^>]*>[\s\S]*?<\/td>/gi) || [];
        if (tds.length < 2) continue; // 跳过表头/空行

        var cells = [];
        for (var c = 0; c < tds.length; c++) cells.push(stripTags(tds[c]));

        var playerName = null;
        var position = null;
        var joinDate = null;

        for (var c = 0; c < cells.length; c++) {
          var cell = (cells[c] || '').trim();
          if (!cell) continue;
          // 位置：单数字 1-5 或位置关键字
          if (!position && /^[1-5]$/.test(cell)) { position = cell; continue; }
          if (!position && /^(carry|mid|offlane|support|hard support|core|captain|coach)$/i.test(cell)) { position = cell; continue; }
          // 加入日期
          if (!joinDate) {
            var dm = cell.match(/\d{4}[-/]\d{1,2}([-/]\d{1,2})?/);
            if (dm) { joinDate = dm[0]; continue; }
          }
          // 选手名：第一个非空、非日期、非位置、长度>1 的单元格
          if (!playerName && cell.length > 1) { playerName = cell; }
        }

        if (playerName) {
          members.push({
            account_id: null,
            name: playerName,
            position: position,
            joinDate: joinDate,
            leaveDate: null
          });
        }
      }
    } catch (e) {
      // 整体解析失败：返回空（绝不抛错）
      return [];
    }

    cache.set(cacheKey, members, CACHE_TTL);
    return members;
  }).catch(function () { return []; });
}

// 3. 选手资料
// 返回 { name, country, role, teamHistory: [{team, joinDate, leaveDate}], achievements: [] } 或 null。
function getPlayerProfile(name) {
  if (!ENABLED) return Promise.resolve(null);
  if (!name) return Promise.resolve(null);

  var cacheKey = 'liquipedia_player_' + consensus.normName(name);
  var cached = cache.get(cacheKey, CACHE_TTL);
  if (cached) return Promise.resolve(cached);

  return fetchPageHtml(name).then(function (html) {
    if (!html) return null;

    var result = { achievements: [] };
    var anyField = false;

    try { result.name = extractCanonical(html) || name; anyField = true; } catch (e) { result.name = name; }
    try {
      result.country = extractRow(html, 'Nationality') || extractRow(html, 'Country');
      if (result.country) anyField = true;
    } catch (e) { result.country = null; }
    try {
      result.role = extractRow(html, 'Role') || extractRow(html, 'Position');
      if (result.role) anyField = true;
    } catch (e) { result.role = null; }

    // 历史队伍表：解析表格行，每行首个单元格为队名，日期为入队/离队日
    result.teamHistory = [];
    try {
      var trs = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
      for (var i = 0; i < trs.length; i++) {
        var tr = trs[i];
        var tds = tr.match(/<td[^>]*>[\s\S]*?<\/td>/gi) || [];
        if (tds.length < 2) continue;

        var team = stripTags(tds[0]);
        if (!team) continue;

        var dates = [];
        for (var j = 1; j < tds.length; j++) {
          var found = collectDates(stripTags(tds[j]));
          for (var k = 0; k < found.length; k++) dates.push(found[k]);
        }
        var jDate = dates.length >= 1 ? dates[0] : null;
        var lDate = dates.length >= 2 ? dates[1] : null;

        result.teamHistory.push({ team: team, joinDate: jDate, leaveDate: lDate });
      }
      if (result.teamHistory.length) anyField = true;
    } catch (e) {
      result.teamHistory = [];
    }

    if (!anyField) return null;

    cache.set(cacheKey, result, CACHE_TTL);
    return result;
  }).catch(function () { return null; });
}

module.exports = {
  ENABLED: ENABLED,
  getLeagueMetadata: getLeagueMetadata,
  getTeamRoster: getTeamRoster,
  getPlayerProfile: getPlayerProfile
};
