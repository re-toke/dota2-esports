// utils/auth.js —— 账号登录态管理（2026-08-07，审核 R1）
//
// ## 设计（审核 R1：ensureOpenId 上移单点实现，subscribe.js 转发引用，禁双缓存）
// - 账号 = openid（云开发免密，cloud.getWXContext() 直取，无需 code2Session）
// - ensureOpenId 原实现在 subscribe.js，上移至此为唯一实现；subscribe 保持兼容导出（转发）
// - OPENID_KEY 统一 'dota2_openid'；isValidOpenId 结构校验（长度>10）
//
// ## 预登录前置（审核 R2：手势红线规避）
// wx.requestSubscribeMessage 必须用户点击手势内同步调用——若在云函数网络回调后才弹窗
// 会被微信手势校验拒绝（fail can only be invoked by user TAP gesture）。
// 因此 App onLaunch / 关注页 onShow 先 ensureLogin() 预热（缓存命中后零请求），
// 点击「开启提醒」时 isLoggedIn() 命中 → 同步弹授权；未命中 → toast 引导不异步弹。

var OPENID_KEY = 'dota2_openid';
// 方案 C+（2026-09-09）：业务 JWT 存储 key（wechat-auth EF 签发，30 天有效）
var JWT_KEY = 'dota2_jwt';

// ===== 纯函数（可单测，R5）=====

/**
 * openid 合法性校验（结构校验，防缓存损坏）
 * @param {*} s
 * @returns {boolean}
 */
function isValidOpenId(s) {
  return typeof s === 'string' && s.length > 10;
}

/**
 * 云端订阅态与本地合并（R3）——云端有值（已授权）优先，本地为空才保留本地。
 * @param {Object|null} cloudSubs  { tmplId: { subscribed, time, lastStatus } }
 * @param {Object|null} localSubs  本地 dota2_sub_status
 * @returns {Object}
 */
function mergeSubs(cloudSubs, localSubs) {
  var out = Object.assign({}, localSubs || {});
  Object.keys(cloudSubs || {}).forEach(function (k) {
    if (cloudSubs[k] && cloudSubs[k].subscribed) out[k] = cloudSubs[k];
  });
  return out;
}

// ===== 非纯（依赖 wx）=====

/**
 * 同步读取本地缓存的 openid（不发起云调用）。
 * @returns {string|null}
 */
function getOpenIdSync() {
  try {
    var cached = wx.getStorageSync(OPENID_KEY);
    if (isValidOpenId(cached)) return cached;
  } catch (e) {}
  return null;
}

/**
 * 是否已登录（本地 openid 缓存命中）
 * @returns {boolean}
 */
function isLoggedIn() {
  return !!getOpenIdSync();
}

/**
 * 确保有可用的 openid。优先本地缓存（零请求），未命中走登录链路（静默无感）。
 * 双分支（方案 C+ 灰度，2026-09-09）：
 *   - config.supabase.enabled=true：wx.login → Edge Function wechat-auth（拿 openid + JWT）
 *   - 否则/失败回退：wx.cloud.callFunction getOpenId（云开发原链路，灰度期保命）
 * @param {boolean} [fresh=false] 强制刷新（忽略缓存）
 * @returns {Promise<string|null>} openid 或 null
 */
function ensureOpenId(fresh) {
  return new Promise(function (resolve) {
    if (!fresh) {
      var cached = getOpenIdSync();
      if (cached) { resolve(cached); return; }
    }

    // ★ 2026-09-10（真机登录问题诊断）：补结构化日志。
    //   此前 ensureOpenId 全程静默——真机登录失败时无从判断卡在哪一步
    //   （wx.login 失败 / EF 失败 / 云函数回退也失败）。加日志后可据 Console 定位。
    var _t0 = Date.now();
    function _ok(oid, src) {
      console.log('[auth] openid ' + (oid ? 'OK' : 'NULL') + ' via=' + src +
                  ' (' + (Date.now() - _t0) + 'ms) oid=' + (oid ? String(oid).slice(0, 8) + '…' : 'null'));
      resolve(oid);
    }

    // ★ Supabase 分支：wx.login 拿 code → wechat-auth 换 openid + JWT
    if (_sbEnabled()) {
      wx.login({
        success: function (lr) {
          if (!lr.code) {
            console.warn('[auth] wx.login 返回无 code，回退云开发');
            _cloudFallback(resolve);
            return;
          }
          console.log('[auth] wx.login OK，调 Edge Function wechat-auth…');
          _sbClient().edge(_sbCfg().functions.auth, { code: lr.code })
            .then(function (data) {
              var oid = (data && data.openid) || null;
              if (oid) {
                try { wx.setStorageSync(OPENID_KEY, oid); } catch (e) {}
                // JWT 供 follow-profile / smart-reminders 使用（30 天有效）
                if (data && data.token) {
                  try { wx.setStorageSync(JWT_KEY, data.token); } catch (e) {}
                }
                _ok(oid, data.token ? 'supabase+jwt' : 'supabase');
              } else {
                console.warn('[auth] wechat-auth 返回无 openid，回退云开发:', JSON.stringify(data).slice(0, 200));
                _cloudFallback(resolve);
              }
            })
            .catch(function (err) {
              console.warn('[auth] wechat-auth EF 失败，回退云开发:', (err && (err.errMsg || err.message)) || err);
              _cloudFallback(resolve);
            });  // EF 失败回退云开发
        },
        fail: function (lr) {
          console.warn('[auth] wx.login 失败，回退云开发:', (lr && lr.errMsg) || lr);
          _cloudFallback(resolve);
        }
      });
      return;
    }

    console.log('[auth] supabase 未启用，直接走云开发 getOpenId');
    _cloudFallback(resolve);
  });
}

// ---- 方案 C+ 内部辅助（懒加载防循环依赖：subscribe → auth → config 无环；cloudCache 不 require auth）----

function _sbCfg() {
  try { return require('./config.js').supabase || {}; } catch (e) { return {}; }
}
function _sbEnabled() {
  var c = _sbCfg();
  return !!(c.enabled && c.url && c.anonKey);
}
function _sbClient() { return require('./supabaseClient.js'); }

/** 云开发回退路径（灰度期保留，原实现原样） */
function _cloudFallback(resolve) {
  if (typeof wx === 'undefined' || !wx.cloud || !wx.cloud.callFunction) {
    console.warn('[auth] 云开发不可用（wx.cloud 缺失），openid 无法获取');
    resolve(null);
    return;
  }
  var _t0 = Date.now();
  wx.cloud.callFunction({
    name: 'aggregation',
    data: { action: 'getOpenId' },
    success: function (res) {
      var oid = ((res && res.result) && res.result.openid) || null;
      if (oid) {
        try { wx.setStorageSync(OPENID_KEY, oid); } catch (e) {}
      }
      console.log('[auth] 云开发 getOpenId ' + (oid ? 'OK' : 'NULL') +
                  ' (' + (Date.now() - _t0) + 'ms) result=' + JSON.stringify(res && res.result).slice(0, 160));
      resolve(oid);
    },
    fail: function (err) {
      console.error('[auth] 云开发 getOpenId 失败:', (err && err.errMsg) || err);
      resolve(null);
    }
  });
}

/**
 * 预登录（R2 预热入口）：幂等，缓存命中零请求。
 * @param {boolean} [fresh]
 * @returns {Promise<string|null>}
 */
function ensureLogin(fresh) {
  return ensureOpenId(fresh);
}

/**
 * 清除本地缓存的 openid（退出登录时调用）
 */
function clearOpenId() {
  try { wx.removeStorageSync(OPENID_KEY); } catch (e) {}
  try { wx.removeStorageSync(JWT_KEY); } catch (e) {}   // JWT 一并清除
}

/**
 * 读取本地缓存的业务 JWT（方案 C+，follow-profile / smart-reminders 用）
 * @returns {string|null}
 */
function getJwtSync() {
  try {
    var t = wx.getStorageSync(JWT_KEY);
    return (typeof t === 'string' && t.length > 20) ? t : null;
  } catch (e) { return null; }
}

module.exports = {
  OPENID_KEY: OPENID_KEY,
  JWT_KEY: JWT_KEY,
  isValidOpenId: isValidOpenId,
  mergeSubs: mergeSubs,
  getOpenIdSync: getOpenIdSync,
  isLoggedIn: isLoggedIn,
  ensureOpenId: ensureOpenId,
  ensureLogin: ensureLogin,
  clearOpenId: clearOpenId,
  getJwtSync: getJwtSync
};
