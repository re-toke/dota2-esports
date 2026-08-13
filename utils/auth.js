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
 * 确保有可用的 openid。优先本地缓存（零请求），未命中调云函数 getOpenId（静默无感）。
 * @param {boolean} [fresh=false] 强制刷新（忽略缓存）
 * @returns {Promise<string|null>} openid 或 null
 */
function ensureOpenId(fresh) {
  return new Promise(function (resolve) {
    if (!fresh) {
      var cached = getOpenIdSync();
      if (cached) { resolve(cached); return; }
    }
    if (typeof wx === 'undefined' || !wx.cloud || !wx.cloud.callFunction) { resolve(null); return; }
    wx.cloud.callFunction({
      name: 'aggregation',
      data: { action: 'getOpenId' },
      success: function (res) {
        var oid = ((res && res.result) && res.result.openid) || null;
        if (oid) {
          try { wx.setStorageSync(OPENID_KEY, oid); } catch (e) {}
        }
        resolve(oid);
      },
      fail: function () { resolve(null); }
    });
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
}

module.exports = {
  OPENID_KEY: OPENID_KEY,
  isValidOpenId: isValidOpenId,
  mergeSubs: mergeSubs,
  getOpenIdSync: getOpenIdSync,
  isLoggedIn: isLoggedIn,
  ensureOpenId: ensureOpenId,
  ensureLogin: ensureLogin,
  clearOpenId: clearOpenId
};
