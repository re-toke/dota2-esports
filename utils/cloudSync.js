// utils/cloudSync.js
// ============================================================
// 云同步状态管理（v1.2 账号体系重构 · 2026-09-10）
//
// ## 为什么需要它
// 重构前：关注/提醒变更会在 5 处**无条件**上云（`follow.js syncProfile`），
//   用户无显式同意开关、无状态可见、也**无法撤回**（EF 无 delete，且协议承诺的
//   「意见反馈」删除路径该功能并不存在）—— 属合规缺口（《个人信息保护法》要求
//   告知同意 + 可撤回 + 可删除）。
//
// 重构后：把这件事从「隐式自动上云」改为「**显式开关 + 四态可见 + 可撤回**」，
//   对外不再叫「微信登录」（该概念在 2026 年小程序里已不存在：getUserInfo /
//   getUserProfile 已被回收，openid 只能静默获取、无授权界面），
//   而是叫「**云同步**」，价值主张 = 「换设备也能恢复你的关注与提醒」。
//
// ## 四态
//   off      未开启（默认）—— 关注/提醒只写本地，**零请求**
//   syncing  同步中
//   synced   已同步（记录 lastSyncAt）
//   failed   同步失败（可重试）
//
// ## 依赖
//   仅依赖 auth（openid/JWT）与 supabaseClient（EF 调用），
//   **不依赖 subscribe**（避免环：subscribe → cloudSync 单向）。
// ============================================================

var STORE_KEY = 'dota2_cloud_sync';

/** 内存态，避免频繁读 storage */
var _state = null;
/** 变更监听（UI 订阅） */
var _listeners = [];

function _read() {
  if (_state) return _state;
  var raw = null;
  try { raw = wx.getStorageSync(STORE_KEY); } catch (e) {}
  _state = {
    enabled: !!(raw && raw.enabled),
    lastSyncAt: (raw && raw.lastSyncAt) || 0,
    status: (raw && raw.enabled) ? 'synced' : 'off',
    lastError: ''
  };
  return _state;
}

function _persist() {
  var s = _read();
  try {
    wx.setStorageSync(STORE_KEY, { enabled: s.enabled, lastSyncAt: s.lastSyncAt });
  } catch (e) {}
  _emit();
}

function _emit() {
  var s = getState();
  for (var i = 0; i < _listeners.length; i++) {
    try { _listeners[i](s); } catch (e) {}
  }
}

function _setStatus(status, err) {
  var s = _read();
  s.status = status;
  s.lastError = err || '';
  _emit();
}

// ===== 对外 API =====

/** 当前状态快照（供 UI 渲染） */
function getState() {
  var s = _read();
  return {
    enabled: s.enabled,
    status: s.status,
    lastSyncAt: s.lastSyncAt,
    lastError: s.lastError
  };
}

/** 是否已开启同步（上传守卫的唯一判定入口） */
function isEnabled() {
  return _read().enabled;
}

/**
 * 开启云同步：确保 openid 就绪 → 标记开启。
 * 注意：**仅完成登录与状态切换**，首次全量上传由调用方（follow.js）紧接着执行，
 * 因为「关注列表」的读取方在 pages/follow（避免 utils 反向依赖页面）。
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
function enable() {
  _setStatus('syncing');
  var auth = require('./auth.js');
  return auth.ensureLogin().then(function (oid) {
    if (!oid) {
      _setStatus('failed', 'no_openid');
      return { ok: false, reason: 'no_openid' };
    }
    var s = _read();
    s.enabled = true;
    s.lastSyncAt = Date.now();
    _persist();
    _setStatus('synced');
    return { ok: true };
  }).catch(function (err) {
    _setStatus('failed', (err && (err.errMsg || err.message)) || 'error');
    return { ok: false, reason: 'error' };
  });
}

/**
 * 关闭云同步 = **撤回同意**：删除云端画像后置为未开启。
 * ★ 必须真实删除（对应协议承诺的删除权）；删除失败仍会关闭本地开关，
 *   但状态置 failed 让用户可重试（避免「以为删了其实没删」）。
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
function disable() {
  var auth = require('./auth.js');
  var jwt = auth.getJwtSync();
  var s = _read();

  function finishLocal() {
    s.enabled = false;
    s.lastSyncAt = 0;
    _persist();
  }

  if (!jwt) {
    // 无 JWT 说明云端从未建立过画像（或已过期）→ 直接关本地即可
    finishLocal();
    _setStatus('off');
    return Promise.resolve({ ok: true, reason: 'no_jwt' });
  }

  _setStatus('syncing');
  var sb = require('./supabaseClient.js');
  var name = '';
  try { name = (require('./config.js').supabase.functions || {}).followProfile; } catch (e) {}
  if (!name) name = 'follow-profile';

  return sb.edge(name, { op: 'delete' }, { jwt: jwt }).then(function (r) {
    if (r && r.ok) {
      finishLocal();
      _setStatus('off');
      return { ok: true };
    }
    // 云端删除失败：本地仍关闭（尊重用户撤回意图），但状态置 failed 供重试
    finishLocal();
    _setStatus('failed', 'delete_failed');
    return { ok: false, reason: 'delete_failed' };
  }).catch(function (err) {
    finishLocal();
    _setStatus('failed', (err && (err.errMsg || err.message)) || 'delete_error');
    return { ok: false, reason: 'delete_error' };
  });
}

/** 标记一次成功同步（由上传方在成功后调用） */
function markSynced() {
  var s = _read();
  s.lastSyncAt = Date.now();
  _persist();
  if (s.enabled) _setStatus('synced');
}

/** 标记同步失败（由上传方在失败后调用） */
function markFailed(reason) {
  var s = _read();
  if (!s.enabled) return;
  _setStatus('failed', reason || 'error');
}

/** 订阅状态变更（返回退订函数） */
function onChange(cb) {
  if (typeof cb !== 'function') return function () {};
  _listeners.push(cb);
  return function () {
    var i = _listeners.indexOf(cb);
    if (i >= 0) _listeners.splice(i, 1);
  };
}

/** 测试用：清空内存态 */
function _reset() { _state = null; }

module.exports = {
  getState: getState,
  isEnabled: isEnabled,
  enable: enable,
  disable: disable,
  markSynced: markSynced,
  markFailed: markFailed,
  onChange: onChange,
  _reset: _reset
};
