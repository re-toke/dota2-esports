// utils/supabaseClient.js —— Supabase 请求封装（方案 C+，2026-09-04）
//
// ## 设计
// - wx.request 直调 PostgREST / Edge Functions，不依赖 supabase-js（小程序兼容性）
// - edge(name, data, opts)：调 Edge Function；opts.jwt 有值时 Authorization 带业务 JWT
//   （follow-profile / smart-reminders 必须带），否则用 anon key（公开数据）
// - rest(table, query)：PostgREST 直查公开表（anon 只读，不消耗 EF 调用配额）
// - EF 独立熔断：连续 EF_SB_BREAKER_THRESHOLD 次 edge 失败 → 本会话直走云开发
//   （复用 cloudProxy circuitBreakerThreshold 同款模式，独立计数不影响云开发熔断）
// - 安全：anon key 是公开密钥（RLS 保护），JWT 来自 wechat-auth 签发（WX_APPSECRET 在 EF Secrets）

var config = require('./config');

var EF_SB_BREAKER_THRESHOLD = 3;   // 连续失败阈值
var _efFailCount = 0;              // EF 连续失败计数（会话级）
var _efBreakerOpen = false;        // 熔断开关（本会话内不再试 EF）

function sb() { return config.supabase || {}; }

function enabled() {
  return !!(sb().enabled && sb().url && sb().anonKey);
}

function efAvailable() {
  return enabled() && !_efBreakerOpen;
}

/**
 * 调 Edge Function。
 * @param {string} name   function 目录名，如 'wechat-auth'
 * @param {Object} [data] JSON body
 * @param {Object} [opts] { jwt: string } 业务 JWT（需鉴权的 EF 必传）
 * @returns {Promise<Object>} 响应 JSON
 */
function edge(name, data, opts) {
  return new Promise(function (resolve, reject) {
    if (!efAvailable()) { reject(new Error('supabase ef unavailable')); return; }

    var authKey = (opts && opts.jwt) ? opts.jwt : sb().anonKey;
    wx.request({
      url: sb().url + '/functions/v1/' + name,
      method: 'POST',
      data: data || {},
      timeout: 12000,
      header: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + authKey
      },
      success: function (res) {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          _efFailCount = 0;   // 成功复位熔断计数
          resolve(res.data);
        } else if (res.statusCode === 401 && opts && opts.jwt) {
          // JWT 过期/无效：重置熔断计数但不熔断（下次登录换新 JWT 可恢复）
          _efFailCount = 0;
          reject(new Error('EF ' + name + ' auth failed (401)'));
        } else {
          _countFail();
          reject(new Error('EF ' + name + ' HTTP ' + res.statusCode));
        }
      },
      fail: function (err) {
        _countFail();
        reject(new Error(err.errMsg || 'network fail'));
      }
    });
  });
}

/** EF 连续失败计数 + 熔断（3 次后本会话直走云开发，云开发调用零额外延迟） */
function _countFail() {
  _efFailCount++;
  if (_efFailCount >= EF_SB_BREAKER_THRESHOLD) {
    _efBreakerOpen = true;
    console.warn('[supabaseClient] EF breaker OPEN after ' + _efFailCount + ' fails (session)');
  }
}

/**
 * PostgREST 直查公开表（anon 只读）。
 * @param {string} table  表名，如 'curation_events'
 * @param {Object} [query] { select, eq:{col:val}, limit, order }
 * @returns {Promise<Array>}
 */
function rest(table, query) {
  return new Promise(function (resolve, reject) {
    if (!enabled()) { reject(new Error('supabase disabled')); return; }
    var q = query || {};
    var url = sb().url + '/rest/v1/' + table + '?select=' + encodeURIComponent(q.select || '*');
    if (q.eq) {
      Object.keys(q.eq).forEach(function (k) {
        url += '&' + k + '=eq.' + encodeURIComponent(q.eq[k]);
      });
    }
    if (q.limit) url += '&limit=' + q.limit;
    if (q.order) url += '&order=' + q.order;

    wx.request({
      url: url,
      method: 'GET',
      timeout: 12000,
      header: {
        'apikey': sb().anonKey,
        'Authorization': 'Bearer ' + sb().anonKey
      },
      success: function (res) {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(res.data || []);
        else reject(new Error('REST ' + table + ' HTTP ' + res.statusCode));
      },
      fail: function (err) { reject(new Error(err.errMsg || 'network fail')); }
    });
  });
}

module.exports = {
  enabled: enabled,
  efAvailable: efAvailable,
  edge: edge,
  rest: rest
};
