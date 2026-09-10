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
// ★ 2026-08-07（审核 R1）：openid 管理上移至 utils/auth.js（单点实现），此处转发兼容导出
const auth = require('./auth.js');
const cloudCache = require('./cloudCache.js');
// ★ 2026-09-10（账号体系重构）：云同步开关的唯一判定源（未开启 = 不上传）
const cloudSync = require('./cloudSync.js');
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
 * 取消比赛开始提醒（2026-08-15 补全功能按键）。
 * 说明：微信订阅消息为「一次性授权」，不提供编程式取消 API（用户可在微信设置中彻底关闭）；
 *   但项目内服务端推送（sendSmartReminders）读 follow_profile_{openid}.subs 决定是否推送，
 *   因此「取消」= 清除本地 subscribed 标记 + 同步云端 subs（服务端停止推送）。
 *   本地标记保留 lastStatus 供历史追溯，仅置 subscribed=false。
 * @returns {Promise<{ok:boolean}>} 本地清除必然成功；云端同步失败不阻塞（返回 ok:false 提示）
 */
function unsubscribe() {
  const s = readStatus();
  if (s[TMPL_ID]) {
    s[TMPL_ID] = Object.assign({}, s[TMPL_ID], { subscribed: false, cancelledAt: Date.now() });
  } else {
    s[TMPL_ID] = { subscribed: false, time: null, cancelledAt: Date.now(), lastStatus: 'cancelled' };
  }
  writeStatus(s);
  // 同步云端（fire-and-forget，失败静默；云端旧 subs 仍可能推一次，属可接受边界）
  return syncSubStatus().catch(function () { return { ok: false, reason: 'error' }; });
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
        // ★ 2026-08-07（R3）：授权结果同步云端 profile.subs（fire-and-forget，防本地丢失）
        if (status === 'accept') syncSubStatus().catch(() => {});
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
/**
 * ★ 2026-09-10（复核 B5）：把时间戳归一为**北京时间**的 YYYY-MM-DD。
 *
 * 原实现用 `new Date(ts).toISOString().slice(0,10)` —— 那是 **UTC 日**，
 * 对北京用户而言「今日配额」实际在**次日 08:00** 才重置，与文案「每日重置」的直觉不符。
 * 改为按北京时间（config.time.bjOffsetSec 单一来源）划日 → 0 点重置。
 */
function bjDateStr(ts) {
  var off = 8 * 3600;
  try { off = (config.time && config.time.bjOffsetSec) || off; } catch (e) {}
  return new Date(ts + off * 1000).toISOString().slice(0, 10);
}

function getTodayCount() {
  const log = readLog();
  const today = bjDateStr(Date.now());
  return log.filter((r) => {
    if (!r.time) return false;
    return bjDateStr(new Date(r.time).getTime()) === today && r.status === 'ok';
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

  // ★ 方案 C+ 双分支（2026-09-09）：Supabase 启用时走 subscribe-send EF，
  //   失败回退云开发（返回 network 类型交给上层重试逻辑，行为一致）。
  var sbCfg = config.supabase || {};
  if (sbCfg.enabled && sbCfg.url && sbCfg.anonKey) {
    var sbClient = require('./supabaseClient.js');
    return sbClient.edge(sbCfg.functions.subscribe, {
      touser: opts.toUser,
      template_id: TMPL_ID,
      // ★ 微信 HTTPS 接口 page 不带前导斜杠（云开发路径才带 /），必须剥掉，否则 41030
      page: (opts.page || '/pages/index/index').replace(/^\//, ''),
      miniprogram_state: opts.miniprogramState || 'formal',
      data: opts.data
    }).then(function (result) {
      var ok = result.errcode === 0 || result.errcode === undefined;
      return {
        ok: ok,
        msgid: result.msgid,
        errcode: result.errcode,
        errmsg: result.errmsg || '',
        errorType: ok ? 'ok' : 'errcode'
      };
    }).catch(function (err) {
      // EF 侧失败（熔断打开/网络）→ 交云开发重发（errorType 'network' 命中重试白名单）
      console.warn('[subscribe] supabase send fail, fallback cloud:', err && err.message);
      return _cloudSendOnce(opts);
    });
  }

  return _cloudSendOnce(opts);
}

/** 云开发原链路（灰度回退用，原实现原样保留） */
function _cloudSendOnce(opts) {
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

// ===== OpenID 管理（★ 2026-08-07 上移至 utils/auth.js，此处转发保持兼容导出）=====
// 原实现（OPENID_KEY / getOpenIdSync / ensureOpenId / clearOpenId）已迁至 auth.js 单点，
// 避免双缓存不一致（审核 R1）。新增 syncSubStatus（授权态上云）/ restoreSubFromCloud（云端恢复）。

function getOpenIdSync() { return auth.getOpenIdSync(); }
function ensureOpenId(fresh) { return auth.ensureOpenId(fresh); }
function clearOpenId() { return auth.clearOpenId(); }

/**
 * 订阅授权状态同步到云端（R3）：授权成功/失败写本地后调用，并入 follow_profile_{openid}.subs。
 * @returns {Promise<{ok:boolean}>}
 */
function syncSubStatus() {
  // ★ 2026-09-10：同步未开启时不上传（订阅态属云端画像内容）
  if (!cloudSync.isEnabled()) return Promise.resolve({ ok: false, reason: 'sync_off' });
  return ensureOpenId().then(function (openid) {
    if (!openid) return { ok: false, reason: 'no_openid' };
    var key = 'follow_profile_' + openid;
    return cloudCache.getCached(key).then(function (profile) {
      var merged = Object.assign({}, profile || {}, {
        subs: readStatus() || null,
        savedAt: Date.now()
      });
      return cloudCache.setCached(key, merged, 30 * 24 * 3600).then(function () {
        return { ok: true };
      });
    });
  }).catch(function () { return { ok: false, reason: 'error' }; });
}

/**
 * 从云端恢复订阅授权状态（R3）：登录后调用，mergeSubs（云端有值优先）合并回本地 dota2_sub_status。
 * 解决清缓存/换设备后本地授权丢失的问题。
 * @returns {Promise<{ok:boolean, restored:number}>}
 */
function restoreSubFromCloud() {
  return ensureOpenId().then(function (openid) {
    if (!openid) return { ok: false, reason: 'no_openid', restored: 0 };
    return cloudCache.getCached('follow_profile_' + openid).then(function (profile) {
      var cloudSubs = (profile && profile.subs) || null;
      if (!cloudSubs || !Object.keys(cloudSubs).length) return { ok: true, restored: 0 };
      var merged = auth.mergeSubs(cloudSubs, readStatus());
      writeStatus(merged);
      return { ok: true, restored: Object.keys(cloudSubs).length };
    });
  }).catch(function () { return { ok: false, reason: 'error', restored: 0 }; });
}

// ===== #20 服务端策略引擎数据层 =====
// 把「关注战队 id 列表 + 提醒策略」上传到云端（按 openid 分桶），
// 供云函数 saveFollowProfile / sendSmartReminders 服务端批量推送使用。
// 客户端赛前提醒仍走 checkPreMatchReminders（本地策略评估），此处为服务端引擎补齐数据。
//
// ★★ 2026-09-10（账号体系重构 · P0-2）：**未开启云同步时不得上传**。
//   重构前此函数在 5 处被无条件调用（关注变更/提醒变更×3/onShow）→ 用户无显式同意即上云。
//   现在以 cloudSync.isEnabled() 为唯一守卫：未开启 = 零请求（本地功能不受影响）。
function saveFollowProfile(teamIds, strategy, subs, teamItems) {
  if (!cloudSync.isEnabled()) {
    return Promise.resolve({ ok: false, reason: 'sync_off' });
  }
  return ensureOpenId().then(function (openid) {
    if (!openid) { cloudSync.markFailed('no_openid'); return { ok: false, reason: 'no_openid' }; }
    return cloudCache.setCached(
      'follow_profile_' + openid,
      {
        // teams：**保持 ID 数组**（smart-reminders EF 依赖 `for (tid of profile.teams)`
        // 调 /teams/{tid}/matches，改成对象会破坏该服务端链路）
        teams: teamIds || [],
        // ★ P1 新增：对象数组，供客户端「换机恢复关注」用。
        //   必要性：enrichTeamLogo 只回 logo 不回名字，仅凭 ID 恢复出来的关注会没有队名。
        //   兼容：老数据无此字段 → 恢复时降级为仅 ID（见 restoreFollowFromCloud）。
        teamItems: (teamItems || []).map(function (t) {
          return { id: t && t.id, name: (t && t.name) || '', logo: (t && t.logo) || '' };
        }),
        strategy: strategy || null,
        subs: subs || null,
        savedAt: Date.now()
      },
      30 * 24 * 3600
    ).then(function () {
      cloudSync.markSynced();
      return { ok: true, openid: openid };
    });
  }).catch(function (err) {
    cloudSync.markFailed((err && (err.errMsg || err.message)) || 'error');
    return { ok: false, reason: 'error' };
  });
}

/**
 * ★ P1：从云端**恢复关注列表**（2026-09-10 新增）。
 *
 * 背景：此前云端 `profile.teams` **上传了却从不读回** —— 唯一消费者是服务端推送
 * （smart-reminders），「换机恢复关注」这个用户价值根本不存在。本函数补齐该能力，
 * 让「云同步」的价值主张成立。
 *
 * 语义：**并集合并**（云端 ∪ 本地），不覆盖 —— 换机场景本地为空则等价全量恢复；
 * 同机场景不会误删用户刚在本地新增的关注。返回新增条数供 UI 提示。
 *
 * @returns {Promise<{ok:boolean, restored:number, reason?:string}>}
 */
function restoreFollowFromCloud() {
  if (!cloudSync.isEnabled()) return Promise.resolve({ ok: false, restored: 0, reason: 'sync_off' });
  return ensureOpenId().then(function (openid) {
    if (!openid) return { ok: false, restored: 0, reason: 'no_openid' };
    return cloudCache.getCached('follow_profile_' + openid).then(function (profile) {
      if (!profile) return { ok: true, restored: 0 };
      // 优先用 teamItems（含队名/队标）；老数据只有 teams（纯 ID）→ 降级仅恢复 ID
      var items = (profile.teamItems && profile.teamItems.length)
        ? profile.teamItems
        : (profile.teams || []).map(function (id) { return { id: id, name: '', logo: '' }; });
      if (!items.length) return { ok: true, restored: 0 };

      var follow = require('./follow.js');
      var local = follow.list('teams') || [];
      var localIds = {};
      local.forEach(function (t) { if (t && t.id != null) localIds[String(t.id)] = true; });

      var added = 0;
      items.forEach(function (it) {
        if (!it || it.id == null) return;
        var key = String(it.id);
        if (localIds[key]) return;
        var name = it.name || ('战队 ' + key);   // 老数据无队名时的可读占位
        follow.follow('teams', { id: it.id, name: name, logo: it.logo || '' });
        added++;
      });
      return { ok: true, restored: added };
    });
  }).catch(function () { return { ok: false, restored: 0, reason: 'error' }; });
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

  // OpenID（★ 转发 auth.js，2026-08-07 R1）
  ensureOpenId: ensureOpenId,
  getOpenIdSync: getOpenIdSync,
  clearOpenId: clearOpenId,

  // ★ 2026-08-07（R3）：订阅授权状态上云 / 云端恢复
  syncSubStatus: syncSubStatus,
  restoreSubFromCloud: restoreSubFromCloud,
  // ★ P1（2026-09-10）：换机恢复关注列表（此前云端 teams 上传了却从不读回）
  restoreFollowFromCloud: restoreFollowFromCloud,
  // ★ 2026-08-15：取消比赛开始提醒（清本地 + 同步云端）
  unsubscribe: unsubscribe,

  // #20 服务端策略引擎数据层
  saveFollowProfile: saveFollowProfile
};
