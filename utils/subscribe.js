// utils/subscribe.js
// 微信订阅消息完整闭环实现。
//
// ## 闭环四阶段
// 1. 授权触发：用户关注战队 / 手动点击「开启提醒」→ wx.requestSubscribeMessage
// 2. 状态记录：本地存储授权结果（模板ID → { subscribed, time }）
// 3. 消息发送：云函数 aggregation action=sendSubscribeMessage 调用微信接口推送
// 4. 跳转回链：消息 payload 含 page/miniprogram_state，用户点击回到赛事详情
//
// ## 模板字段映射（模板 ID: eLHDZtOvcGghXBZnnwcvsO3SX3fBPdB9cz9PKi_NwRQ）
//   thing1.DATA → 比赛名称（league name）
//   thing2.DATA → 比赛时间（formatTime 格式）
//   thing6.DATA → 比赛对阵（TeamA VS TeamB）
//   thing5.DATA → 备注（可选，如"即将开始"）

const config = require('./config.js');
const cloudCache = require('./cloudCache.js');
const sources = require('./sources.js');

const TMPL_ID = config.subscribeTemplateId;
const CFG = config.subscribe || {};
const STATUS_KEY = CFG.statusKey || 'dota2_sub_status';
const LOG_KEY = CFG.sendLogKey || 'dota2_sub_send_log';
const COOLDOWN = (CFG.cooldownSec || 86400) * 1000;   // ms
const DAILY_LIMIT = CFG.dailyLimit || 5;
// §8.3 云端推送重试（2026-07-29）：失败退避重试参数
//   - RETRY_MAX: 最大重试次数（总尝试 = 1 + RETRY_MAX）
//   - RETRY_BASE_MS: 退避基数（指数 2x：2000 → 2s/4s）
//   - RETRY_MAX_MS: 单次退避上限，避免赛前提醒窗口内错过推送时机
const RETRY_MAX = CFG.retryMax != null ? CFG.retryMax : 2;
const RETRY_BASE_MS = CFG.retryBaseMs || 2000;
const RETRY_MAX_MS = CFG.retryMaxMs || 30000;

// ===== 本地状态读写 =====

function readStatus() {
  try {
    const d = wx.getStorageSync(STATUS_KEY);
    return (d && typeof d === 'object') ? d : {};
  } catch (e) { return {}; }
}

function writeStatus(s) {
  try { wx.setStorageSync(STATUS_KEY, s); } catch (e) {}
}

/**
 * 返回当前订阅状态对象
 * @returns {{ subscribed: boolean, time: number | null }}
 */
function getSubStatus() {
  if (!TMPL_ID) return { subscribed: false, time: null, reason: 'no_template' };
  const s = readStatus();
  const entry = s[TMPL_ID];
  if (!entry) return { subscribed: false, time: null };
  return { subscribed: !!entry.subscribed, time: entry.time || null };
}

/**
 * 判断是否应该弹出授权弹窗。
 * 规则：未配置模板 → false；已订阅且在冷却期内 → false；否则 true
 */
function canRequest() {
  if (!TMPL_ID) return false;
  const st = getSubStatus();
  if (st.subscribed) {
    // 已订阅过：距上次授权超过冷却期才允许重新弹（用于续期场景）
    if (st.time && (Date.now() - st.time < COOLDOWN)) return false;
  }
  return true;
}

/**
 * 弹出微信订阅消息授权弹窗。
 * @param {Object} [opts]
 * @param {boolean} [opts.force=false]  忽略冷却期强制弹出
 * @returns {Promise<string>} 'accept' | 'reject' | 'ban' | 'fail' | 'skipped'
 */
function requestSubscribe(opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    if (!TMPL_ID) { resolve('skipped'); return; }
    if (!opts.force && !canRequest()) { resolve('reject'); return; }

    wx.requestSubscribeMessage({
      tmplIds: [TMPL_ID],
      success: (res) => {
        const status = res[TMPL_ID]; // 'accept' | 'reject' | 'ban'
        // 记录结果到本地
        const s = readStatus();
        s[TMPL_ID] = {
          subscribed: status === 'accept',
          time: Date.now(),
          lastStatus: status
        };
        writeStatus(s);
        resolve(status || 'fail');
      },
      fail: (err) => {
        // 用户关闭弹窗 / 网络异常等
        const s = readStatus();
        s[TMPL_ID] = {
          subscribed: false,
          time: Date.now(),
          lastStatus: 'fail',
          errMsg: err.errMsg || ''
        };
        writeStatus(s);
        resolve('fail');
      }
    });
  });
}

// ===== 发送记录（本地） =====

function readLog() {
  try {
    const d = wx.getStorageSync(LOG_KEY);
    return (Array.isArray(d)) ? d : [];
  } catch (e) { return []; }
}

function writeLog(arr) {
  try {
    // 只保留最近 200 条，防止存储膨胀
    wx.setStorageSync(LOG_KEY, arr.slice(-200));
  } catch (e) {}
}

/**
 * 记录一次发送结果
 * @param {Object} rec { toUser, templateId, matchId, leagueName, status, error?, time }
 */
function recordSend(rec) {
  const log = readLog();
  log.push(Object.assign({ time: Date.now() }, rec));
  writeLog(log);
}

/**
 * 获取今日发送次数
 */
function getTodayCount() {
  const log = readLog();
  const today = new Date().toISOString().slice(0, 10);
  return log.filter((r) => {
    if (!r.time) return false;
    return new Date(r.time).toISOString().slice(0, 10) === today && r.status === 'ok';
  }).length;
}

/**
 * 获取最近 N 条发送记录
 * @param {number} [limit=20]
 */
function getSendHistory(limit) {
  const log = readLog();
  return log.slice(-(limit || 20)).reverse();
}

/**
 * 清除过期发送记录（保留近 7 天）
 */
function cleanExpiredLogs() {
  const log = readLog();
  const cutoff = Date.now() - 7 * 86400000;
  const filtered = log.filter((r) => (r.time || 0) > cutoff);
  writeLog(filtered);
}

// ===== 构造消息 payload =====

/**
 * 根据比赛数据构造订阅消息 data 字段
 * @param {Object} match { league_name, start_time, radiant_name, dire_name, radiant_team_id, dire_team_id, leagueid, match_id? }
 * @param {string} [note] 备注文字（如"即将开始"）
 * @returns {Object} 微信 subscribe/send 所需 data 字段
 */
function buildMessageData(match, note) {
  var leagueName = (sources.leagueDisplayName(match) || 'DOTA2 赛事').slice(0, 20);  // thing 上限 20 字符
  var timeText = formatMatchTime(match.start_time);
  var radiant = match.radiant_name || '未知战队';
  var dire = match.dire_name || '未知战队';
  var matchup = (radiant + ' VS ' + dire).slice(0, 20);  // thing 上限 20 字符
  var remark = (note || '即将开始').slice(0, 20);

  return {
    thing1: { value: leagueName },
    thing2: { value: timeText },
    thing6: { value: matchup },
    thing5: { value: remark }
  };
}

/**
 * 构造跳转页路径。用户点击消息后进入对应赛事详情或联赛详情。
 * @param {Object} match
 * @returns {string} 小程序页面路径
 */
function buildPagePath(match) {
  // 优先跳转到具体比赛详情（如果 match_id 可用且有 match-detail 页入口）
  // 否则跳转到联赛详情页
  if (match.leagueid) {
    var name = encodeURIComponent(match.league_name || '');
    return '/subpackages/detail/league-detail/league-detail?leagueId=' + match.leagueid + '&name=' + name;
  }
  return '/pages/index/index';
}

/**
 * 格式化比赛时间为中文友好格式
 * @param {number} startTime Unix 时间戳（秒）
 * @returns {string}
 */
function formatMatchTime(startTime) {
  if (!startTime) return '时间待定';
  var d = new Date(startTime * 1000);
  var now = new Date();
  var isToday = (d.toDateString() === now.toDateString());
  var tomorrow = new Date(now.getTime() + 86400000);
  var isTomorrow = (d.toDateString() === tomorrow.toDateString());

  var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
  var h = pad(d.getHours());
  var m = pad(d.getMinutes());

  if (isToday) return '今天 ' + h + ':' + m;
  if (isTomorrow) return '明天 ' + h + ':' + m;

  var month = pad(d.getMonth() + 1);
  var day = pad(d.getDate());
  return month + '-' + day + ' ' + h + ':' + m;
}

// ===== 云函数调用：发送订阅消息 =====

// §8.3 云端推送重试（2026-07-29）
// 判断错误是否可重试。微信订阅消息错误码分类：
//   可重试（瞬时/速率/系统类）：
//     - 'network'  云函数调用失败（网络抖动、超时）
//     - -1         系统繁忙
//     - 45009      接口调用超过限额（等待后可能恢复）
//   不可重试（确定性错误，重试无用且浪费配额）：
//     - 43101      用户拒绝订阅（需用户重新授权）
//     - 43102      用户未订阅（需用户授权）
//     - 43103      用户拒绝次数过多（进入冷却期）
//     - 43004      openid 无效
//     - 40037      template_id 无效
//     - 41030      page 路径无效
//     - 47003      模板参数错误
//     - 40013      appid 无效
//     - 50001      接口未授权
//     - 200011     签名无效
function isRetryableError(errcode, errorType) {
  if (errorType === 'network') return true;     // 云函数调用失败
  if (errcode === -1) return true;              // 系统繁忙
  if (errcode === 45009) return true;           // 限频，等待后可恢复
  return false;
}

// 计算第 attempt 次重试的退避时间（指数退避，封顶 RETRY_MAX_MS）
function backoffMs(attempt) {
  var ms = RETRY_BASE_MS * Math.pow(2, attempt);
  return Math.min(ms, RETRY_MAX_MS);
}

/**
 * 单次发送尝试（不含重试逻辑）。
 * 返回 { ok, msgid, errcode, errmsg, errorType }
 *   errorType: 'ok' | 'network' | 'errcode' | 'no_template'
 * 用于 sendSubscribeMessage 内部重试，外部通常不直接调用。
 */
function sendOnce(opts) {
  if (!TMPL_ID) return Promise.resolve({ ok: false, error: 'no_template', errorType: 'no_template' });

  var payload = {
    action: 'sendSubscribeMessage',
    params: {
      touser: opts.toUser,
      template_id: TMPL_ID,
      page: opts.page || '/pages/index/index',
      miniprogram_state: opts.miniprogramState || 'formal',  // 正式版必须用 formal
      data: opts.data
    }
  };

  return new Promise(function (resolve) {
    wx.cloud.callFunction({
      name: 'aggregation',
      data: payload,
      success: function (res) {
        var result = (res && res.result) || {};
        var ok = result.errcode === 0 || result.errcode === undefined;
        resolve({
          ok: ok,
          msgid: result.msgid,
          errcode: result.errcode,
          errmsg: result.errmsg || '',
          errorType: ok ? 'ok' : 'errcode'
        });
      },
      fail: function (err) {
        resolve({
          ok: false,
          errcode: null,
          errmsg: err.errMsg || 'cloud call failed',
          errorType: 'network'
        });
      }
    });
  });
}

/**
 * 通过云函数发送一条订阅消息（含失败退避重试）。
 *
 * 重试策略（§8.3）：
 *   - 仅对瞬时/可恢复错误重试（网络失败、系统繁忙、限频）
 *   - 指数退避：2s → 4s（最多 RETRY_MAX 次）
 *   - 单次退避封顶 RETRY_MAX_MS（默认 30s），避免赛前提醒窗口内错过推送时机
 *   - 不可重试错误（用户拒绝、参数错误等）立即返回，避免浪费配额
 *   - 最终成功/失败只记录一次 send 日志（含尝试次数）
 *
 * @param {Object} opts
 * @param {string} opts.toUser  用户的 openid（需登录获取）
 * @param {Object} opts.data    消息数据（buildMessageData 的返回值）
 * @param {string} opts.page    点击跳转页路径
 * @param {string} [opts.miniprogramState='formal']  程序状态 formal/developer/trial
 * @returns {Promise<Object>} { ok: boolean, msgid?, errcode?, errmsg?, attempts }
 */
function sendSubscribeMessage(opts) {
  if (!TMPL_ID) return Promise.resolve({ ok: false, error: 'no_template' });

  var attempts = 0;
  var lastResult = null;

  function attemptOnce() {
    attempts++;
    return sendOnce(opts).then(function (res) {
      lastResult = res;
      // 成功 → 返回
      if (res.ok) {
        return finalize(res);
      }
      // 不可重试错误 → 立即返回
      if (!isRetryableError(res.errcode, res.errorType)) {
        return finalize(res);
      }
      // 可重试但已达到上限 → 返回
      if (attempts > RETRY_MAX) {
        return finalize(res);
      }
      // 可重试：等待退避时间后重试
      var delay = backoffMs(attempts - 1);
      return delayPromise(delay).then(attemptOnce);
    });
  }

  function delayPromise(ms) {
    return new Promise(function (resolve) {
      // 微信小程序支持 setTimeout，重试异步进行不阻塞主线程
      setTimeout(resolve, ms);
    });
  }

  function finalize(res) {
    // 仅在最终结果时记录一次发送日志（含尝试次数，避免重试中重复写日志）
    var ok = !!res.ok;
    recordSend({
      toUser: opts.toUser.substring(0, 8) + '***',  // 脱敏
      templateId: TMPL_ID,
      matchId: opts.matchId || '',
      leagueName: opts.leagueName || '',
      status: ok ? 'ok' : (res.errorType === 'network' ? 'cloud_fail' : 'error'),
      errcode: res.errcode,
      errmsg: res.errmsg || '',
      attempts: attempts,          // §8.3 记录总尝试次数（1=未重试，>1=有重试）
      retried: attempts > 1        // 是否发生过重试
    });
    return {
      ok: ok,
      msgid: res.msgid,
      errcode: res.errcode,
      errmsg: res.errmsg,
      // 兼容旧调用方：network 失败时填 'cloud_fail'，errcode 失败时填 'errcode'
      error: ok ? null : (res.errorType === 'network' ? 'cloud_fail' : (res.errcode != null ? 'errcode_' + res.errcode : 'error')),
      attempts: attempts
    };
  }

  return attemptOnce();
}

// ===== 高级接口：赛前提醒触发器 =====

/**
 * 检查一场比赛是否需要发送赛前提醒，并在条件满足时发送。
 *
 * 触发条件：
 * 1. 用户已授权订阅（getSubStatus().subscribed === true）
 * 2. 比赛在未来且在提醒窗口内（start_time - now <= remindBeforeSec）
 * 3. 今日发送次数未超限
 * 4. 该场比赛尚未发送过（去重）
 *
 * @param {Object} match 比赛数据
 * @param {string} [openid] 用户 openid（需提前通过 login 流程获取）
 * @param {Object} [opts]
 * @returns {Promise<{sent:boolean, reason:string}>}
 */
async function triggerPreMatchReminder(match, openid, opts) {
  opts = opts || {};

  // 条件1：检查订阅状态
  var sub = getSubStatus();
  if (!sub.subscribed) return { sent: false, reason: 'not_subscribed' };

  // 条件2：检查 openid
  if (!openid) return { sent: false, reason: 'no_openid' };

  // 条件3：检查时间窗口
  var now = Math.floor(Date.now() / 1000);
  var start = match.start_time || 0;
  if (start <= now) return { sent: false, reason: 'already_started' };
  var diffSec = start - now;
  var windowSec = (CFG.remindBeforeSec || 1800);
  if (diffSec > windowSec) return { sent: false, reason: 'too_early', diffSec: diffSec };

  // 条件4：每日限额
  if (getTodayCount() >= DAILY_LIMIT) return { sent: false, reason: 'daily_limit' };

  // 条件5：去重（该 match_id 今天是否已发过）
  var mid = match.match_id || (match.leagueid + '_' + start);
  var log = readLog();
  var todayStr = new Date().toISOString().slice(0, 10);
  var alreadySent = log.some(function (r) {
    return r.matchId === mid &&
      r.status === 'ok' &&
      new Date(r.time).toISOString().slice(0, 10) === todayStr;
  });
  if (alreadySent) return { sent: false, reason: 'duplicate' };

  // 全部条件满足 → 发送
  var data = buildMessageData(match, opts.note);
  var page = buildPagePath(match);
  var result = await sendSubscribeMessage({
    toUser: openid,
    data: data,
    page: page,
    matchId: mid,
    leagueName: sources.leagueDisplayName(match) || ''
  });

  return {
    sent: result.ok,
    reason: result.ok ? 'sent' : ('send_error:' + (result.errcode || result.error))
  };
}

// ===== OpenID 管理 =====

var OPENID_KEY = 'dota2_openid';

/**
 * 同步读取本地缓存的 openid（不发起云调用）。
 * 仅在 app.js 已预热（globalData.openidReady=true）时使用，避免 await。
 * @returns {string|null}
 */
function getOpenIdSync() {
  try {
    var cached = wx.getStorageSync(OPENID_KEY);
    if (cached && typeof cached === 'string' && cached.length > 10) {
      return cached;
    }
  } catch (e) {}
  return null;
}

/**
 * 确保有可用的 openid。优先从本地缓存读取，缓存未命中时调用云函数获取。
 * @param {boolean} [fresh=false] 强制刷新（忽略缓存）
 * @returns {Promise<string|null>} openid 或 null
 */
function ensureOpenId(fresh) {
  return new Promise(function (resolve) {
    if (!fresh) {
      try {
        var cached = wx.getStorageSync(OPENID_KEY);
        if (cached && typeof cached === 'string' && cached.length > 10) {
          resolve(cached);
          return;
        }
      } catch (e) {}
    }
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
      fail: function () {
        resolve(null);
      }
    });
  });
}

/**
 * 清除本地缓存的 openid（用户退出登录时调用）
 */
function clearOpenId() {
  try { wx.removeStorageSync(OPENID_KEY); } catch (e) {}
}

// ===== #20 服务端策略引擎数据层 =====
// 把「关注战队 id 列表 + 提醒策略」上传到云端（按 openid 分桶），
// 供云函数 saveFollowProfile / sendSmartReminders 服务端批量推送使用。
// 客户端赛前提醒仍走 checkPreMatchReminders（本地策略评估），此处为服务端引擎补齐数据。
function saveFollowProfile(teamIds, strategy) {
  return ensureOpenId().then(function (openid) {
    if (!openid) return { ok: false, reason: 'no_openid' };
    return cloudCache.setCached(
      'follow_profile_' + openid,
      { teams: teamIds || [], strategy: strategy || null, savedAt: Date.now() },
      30 * 24 * 3600
    ).then(function () { return { ok: true, openid: openid }; });
  }).catch(function () { return { ok: false, reason: 'error' }; });
}

module.exports = {
  // 基础查询
  getSubStatus: getSubStatus,
  canRequest: canRequest,
  requestSubscribe: requestSubscribe,

  // 发送相关
  sendSubscribeMessage: sendSubscribeMessage,
  triggerPreMatchReminder: triggerPreMatchReminder,

  // §8.3 重试辅助（供单元测试调用，跳过 wx.cloud 层）
  isRetryableError: isRetryableError,
  backoffMs: backoffMs,

  // Payload 构建
  buildMessageData: buildMessageData,
  buildPagePath: buildPagePath,
  formatMatchTime: formatMatchTime,

  // 日志
  recordSend: recordSend,
  getSendHistory: getSendHistory,
  getTodayCount: getTodayCount,
  cleanExpiredLogs: cleanExpiredLogs,

  // 常量（供页面展示使用）
  TMPL_ID: TMPL_ID,
  TEMPLATE_TITLE: '比赛开始提醒',

  // OpenID
  ensureOpenId: ensureOpenId,
  getOpenIdSync: getOpenIdSync,
  clearOpenId: clearOpenId,

  // #20 服务端策略引擎数据层
  saveFollowProfile: saveFollowProfile
};
