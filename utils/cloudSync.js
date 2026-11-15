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
//
// ★★ 2026-11-15（v1.3「关闭不可取消」修复）：
//   ① 关闭改为**本地先行**：先关开关 + 记 `pendingDelete`，再删云端 —— 删除失败也不会半开；
//   ② 引入 `withTimeout`（15s）：「关闭」不再是永挂 promise，状态不会永久卡 syncing；
//   ③ 新增 `retryPendingDelete()` / `hasPendingDelete()`：「关闭失败但云端有数据」可被重试删除
//      （原实现页面上的「重试」反而会把同步重新打开 —— 见 follow.js onSyncRetry）。
// ============================================================

var STORE_KEY = 'dota2_cloud_sync';

/** 单次云端操作的超时上限（毫秒）★ 2026-11-15：默认 15s，测试可注入 */
var DEFAULT_TIMEOUT_MS = 15000;
var _timeoutMs = DEFAULT_TIMEOUT_MS;

/** 内存态，避免频繁读 storage */
var _state = null;
/** 变更监听（UI 订阅） */
var _listeners = [];

/**
 * ★ 2026-11-15：给任意 promise 加超时，超时以 `{ok:false, reason:'timeout'}` 收口。
 * 保证返回的 promise **绝不悬空**（否则调用方状态机会永久卡在 syncing）。
 * @param {Promise} promise 原始 promise（其 reject 也被收口为 {ok:false, reason:'error'}）
 * @param {number} ms 超时毫秒
 * @param {string} from 来源标记（'credential' / 'delete' / 'enable'，仅便于排查）
 * @returns {Promise<Object>} 恒 resolve
 */
function withTimeout(promise, ms, from) {
  var limit = (typeof ms === 'number' && ms > 0) ? ms : DEFAULT_TIMEOUT_MS;
  return new Promise(function (resolve) {
    var settled = false;
    var timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      resolve({ ok: false, reason: 'timeout', from: from || '' });
    }, limit);
    Promise.resolve(promise).then(function (v) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    }, function (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, reason: 'error', from: from || '', error: err });
    });
  });
}

/** 测试注入超时（不传则复位为默认 15s） */
function setTimeoutMs(ms) {
  _timeoutMs = (typeof ms === 'number' && ms > 0) ? ms : DEFAULT_TIMEOUT_MS;
}

function _read() {
  if (_state) return _state;
  var raw = null;
  try { raw = wx.getStorageSync(STORE_KEY); } catch (e) {}
  _state = {
    enabled: !!(raw && raw.enabled),
    lastSyncAt: (raw && raw.lastSyncAt) || 0,
    // ★ 2026-11-15：云端待清理标记（开关已关但删除没成功，需重试删除）
    pendingDelete: !!(raw && raw.pendingDelete),
    status: (raw && raw.enabled) ? 'synced' : ((raw && raw.pendingDelete) ? 'failed' : 'off'),
    lastError: (raw && raw.pendingDelete && !(raw && raw.enabled)) ? 'pending_delete' : ''
  };
  return _state;
}

function _persist() {
  var s = _read();
  try {
    wx.setStorageSync(STORE_KEY, {
      enabled: s.enabled,
      lastSyncAt: s.lastSyncAt,
      pendingDelete: !!s.pendingDelete
    });
  } catch (e) {}
  _emit();
}

/** ★ 2026-11-15：清「云端待清理」标记（不动开关态） */
function _clearPendingDelete() {
  var s = _read();
  if (!s.pendingDelete) return;
  s.pendingDelete = false;
  _persist();
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
    lastError: s.lastError,
    // ★ 2026-11-15：开关已关但云端数据未删成功（UI 需展示「已关闭（云端待清理）」+ 重试删除）
    pendingDelete: !!s.pendingDelete
  };
}

/** 是否已开启同步（上传守卫的唯一判定入口） */
function isEnabled() {
  return _read().enabled;
}

/** ★ 2026-11-15：是否还有「待清理的云端数据」 */
function hasPendingDelete() {
  return !!_read().pendingDelete;
}

/**
 * ★ 2026-11-15：重试动作选择（**纯函数**，便于单测）。
 *
 * 缺陷背景：原 follow.js `onSyncRetry()` 写成 `enabled ? syncProfile() : _enableSync()`，
 * 而 disable() 失败时是 enabled=false + status='failed' ⇒ 用户点「重试删除」实际**重新开启了同步**。
 * 抽成纯函数后，「pendingDelete ⇒ 必须删除、不得 enable」可被直接断言。
 *
 * @param {{enabled:boolean, pendingDelete:boolean}} state
 * @returns {'delete'|'sync'|'enable'}
 */
function resolveRetryAction(state) {
  var s = state || {};
  if (s.pendingDelete && !s.enabled) return 'delete';
  if (s.enabled) return 'sync';
  return 'enable';
}

/**
 * 取可用于删除的 JWT：优先本地，没有则尝试重新登录**取回**（同一用户 openid 不变）。
 * 全程 withTimeout 收口，恒 resolve 为 {ok, jwt?, reason?}。
 */
function _acquireJwt() {
  var auth = require('./auth.js');
  var p = Promise.resolve().then(function () {
    var jwt = '';
    try { jwt = auth.getJwtSync() || ''; } catch (e) { jwt = ''; }
    if (jwt) return { ok: true, jwt: jwt };
    return Promise.resolve(auth.ensureLogin()).then(function () {
      var j2 = '';
      try { j2 = auth.getJwtSync() || ''; } catch (e) { j2 = ''; }
      return j2 ? { ok: true, jwt: j2 } : { ok: false, reason: 'no_credential' };
    });
  }).catch(function () {
    return { ok: false, reason: 'no_credential' };
  });
  return withTimeout(p, _timeoutMs, 'credential').then(function (r) {
    if (r && r.ok && r.jwt) return r;
    return { ok: false, reason: (r && r.reason) || 'no_credential' };
  });
}

/**
 * ★ 2026-11-15：请求云端删除画像（唯一的删除网络出口，带 15s 超时）。恒 resolve。
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
function _requestCloudDelete(jwt) {
  var name = '';
  try { name = (require('./config.js').supabase.functions || {}).followProfile; } catch (e) {}
  if (!name) name = 'follow-profile';
  var p = Promise.resolve().then(function () {
    var sb = require('./supabaseClient.js');
    return sb.edge(name, { op: 'delete' }, { jwt: jwt });
  }).then(function (r) {
    return (r && r.ok) ? { ok: true } : { ok: false, reason: 'delete_failed' };
  });
  return withTimeout(p, _timeoutMs, 'delete').then(function (r) {
    if (r && r.ok) return { ok: true };
    return { ok: false, reason: (r && r.reason) || 'delete_failed' };
  });
}

/**
 * 开启云同步：确保 openid 就绪 → 标记开启。
 * 注意：**仅完成登录与状态切换**，首次全量上传由调用方（follow.js）紧接着执行，
 * 因为「关注列表」的读取方在 pages/follow（避免 utils 反向依赖页面）。
 *
 * ★ 2026-11-15：走 withTimeout，且**失败必须回滚为关闭态**。
 *   原实现在失败/超时时把 status 置 failed 却留下半开态（enabled 可能已被写成 true，
 *   或调用方页面以为还在 syncing），用户看不到可点的开关反馈。
 *
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
function enable() {
  var auth = require('./auth.js');
  var s = _read();
  s.status = 'syncing';
  s.lastError = '';
  // ★ 2026-11-15：用户主动重新开启 = 撤回「删除」意图，清掉残留的待删标记
  s.pendingDelete = false;
  _persist();

  var p = Promise.resolve().then(function () {
    return auth.ensureLogin();
  }).then(function (oid) {
    return oid ? { ok: true } : { ok: false, reason: 'no_openid' };
  }).catch(function (err) {
    return { ok: false, reason: (err && (err.errMsg || err.message)) || 'error' };
  });

  return withTimeout(p, _timeoutMs, 'enable').then(function (r) {
    if (r && r.ok) {
      s.enabled = true;
      s.lastSyncAt = Date.now();
      s.status = 'synced';
      s.lastError = '';
      _persist();
      return { ok: true };
    }
    s.enabled = false;
    s.lastSyncAt = 0;
    s.status = 'failed';
    s.lastError = (r && r.reason) || 'error';
    _persist();
    return { ok: false, reason: (r && r.reason) || 'error' };
  });
}

/**
 * 关闭云同步 = **撤回同意**：删除云端画像后置为未开启。
 *
 * ★★ 2026-09-10 修复（复核发现的缺陷）：**无 JWT 时不得报假成功**。
 *   原实现 `if (!jwt) { finishLocal(); return {ok:true} }` —— 若本地 JWT 被清
 *   （执行过清缓存 / 30 天过期）而**云端仍有数据**，会返回成功、UI 提示「已删除云端数据」，
 *   但云端**根本没删** → 虚假承诺，且直接违反隐私协议的删除权条款。
 *   现改为：无 JWT 时**先尝试登录取回**（同一用户 openid 不变，能拿回），
 *   拿到 → 正常删除；拿不到 → 本地可关，但返回 ok:false 并如实报「云端数据未能删除」。
 *
 * ★★ 2026-11-15（**本地先行**，修「云同步无法取消」）：
 *   原实现先删云端、成功后才关本地 ⇒ 中间态是「开关仍开着 + status=syncing」，
 *   删除失败/超时后开关虽关，但**没有任何地方记住「云端还有数据待删」**，页面上的
 *   「重试」还会把同步重新打开（onSyncRetry 旧逻辑），用户永远取消不掉。
 *   现顺序固定为：① 落盘 enabled=false / lastSyncAt=0 / pendingDelete=true 并 _emit()
 *   （UI 立刻关闭，不再看网络脸色）→ ② 异步删云端：
 *     成功 → pendingDelete=false + status='off' + ok:true
 *     失败/无凭证/超时 → 保留 pendingDelete=true + status='failed' + ok:false
 *     （开关**仍是关闭态**，用户可用 retryPendingDelete 继续删）。
 *
 * @returns {Promise<{ok:boolean, reason?:string}>} ok:false 表示**云端未删除**（但已停止同步）
 */
function disable() {
  var s = _read();

  // ① 本地先行：开关立即关闭 + 记待删标记（即使后面全失败，也绝不会「关不掉」）
  s.enabled = false;
  s.lastSyncAt = 0;
  s.pendingDelete = true;
  s.status = 'syncing';
  s.lastError = '';
  _persist();   // 落盘 + _emit() ⇒ 页面开关立刻变为关闭态

  function settleFail(reason) {
    _setStatus('failed', reason);
    return { ok: false, reason: reason };
  }

  // ② 异步删云端（取凭证与删除都带超时，绝不悬空）
  return _acquireJwt().then(function (cred) {
    if (!cred.ok) {
      // 拿不到凭证 → 无法删除云端。开关已关，但**如实报失败**（reason='no_credential'）
      console.info('[cloudSync] 无可用凭证，云端数据未能删除（保留待删标记）: ' + cred.reason);
      return settleFail(cred.reason || 'no_credential');
    }
    return _requestCloudDelete(cred.jwt).then(function (r) {
      if (r.ok) {
        _clearPendingDelete();
        _setStatus('off');
        return { ok: true };
      }
      return settleFail(r.reason || 'delete_failed');
    });
  });
}

/**
 * ★ 2026-11-15：重试「删除云端数据」—— **仅在 pendingDelete 时**执行删除，
 * 不发其它请求（不上传、不开启同步）。这是「关闭失败后仍能撤回同意」的唯一正路。
 * @returns {Promise<{ok:boolean, reason?:string, skipped?:boolean}>}
 */
function retryPendingDelete() {
  var s = _read();
  if (!s.pendingDelete) return Promise.resolve({ ok: true, skipped: true });

  s.status = 'syncing';
  s.lastError = '';
  _emit();

  return _acquireJwt().then(function (cred) {
    if (!cred.ok) {
      _setStatus('failed', cred.reason || 'no_credential');
      return { ok: false, reason: cred.reason || 'no_credential' };
    }
    return _requestCloudDelete(cred.jwt).then(function (r) {
      if (r.ok) {
        _clearPendingDelete();
        _setStatus('off');
        return { ok: true };
      }
      _setStatus('failed', r.reason || 'delete_failed');
      return { ok: false, reason: r.reason || 'delete_failed' };
    });
  });
}

/**
 * ★ 2026-09-10（复核漏洞 1）：**恒定可用**的「删除云端数据」—— 与开关状态无关。
 *
 * 为什么需要：A2 曾导致「云端孤儿」（本地开关被清成 off，但云端画像还在），
 * 而原设计的删除入口只在开关为开启态时可点 → 孤儿**永远删不掉**。
 * 本函数不读开关状态，直接登录 + 删云端，用于清理孤儿。
 *
 * ★ 2026-11-15：改走 withTimeout，且成功后**一并清掉 pendingDelete**
 *   （设置页「删除云端数据」本来就是给「开关已关但云端有数据」兜底的入口，
 *   删成功却留着待删标记 ⇒ 页面一直显示「云端待清理」）。
 *
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
function deleteCloudData() {
  var auth = require('./auth.js');
  var p = Promise.resolve().then(function () {
    return auth.ensureLogin();
  }).then(function (oid) {
    var jwt = '';
    try { jwt = auth.getJwtSync() || ''; } catch (e) { jwt = ''; }
    if (!oid || !jwt) return { ok: false, reason: 'no_credential' };
    return _requestCloudDelete(jwt).then(function (r) {
      if (!r.ok) return r;
      // 云端删了 → 本地开关也应回到 off（否则状态与事实不符），待删标记同时清除
      var s = _read();
      s.enabled = false;
      s.lastSyncAt = 0;
      s.pendingDelete = false;
      s.status = 'off';
      s.lastError = '';
      _persist();
      return { ok: true };
    });
  }).catch(function () { return { ok: false, reason: 'error' }; });
  return withTimeout(p, _timeoutMs, 'delete');
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
  // ★ 2026-09-10（复核漏洞 1）：恒定可用的「删除云端数据」（清理云端孤儿，与开关状态无关）
  deleteCloudData: deleteCloudData,
  // ★ 2026-11-15：「开关已关但云端未删」的重试删除路径（只删不发其它请求）
  retryPendingDelete: retryPendingDelete,
  hasPendingDelete: hasPendingDelete,
  // ★ 2026-11-15：重试动作选择（纯函数：delete / sync / enable），页面与单测共用
  resolveRetryAction: resolveRetryAction,
  // ★ 2026-11-15：超时注入（测试用，不传则复位 15s）
  setTimeoutMs: setTimeoutMs,
  markSynced: markSynced,
  markFailed: markFailed,
  onChange: onChange,
  _reset: _reset
};
