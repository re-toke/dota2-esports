// utils/experiment.js
// T6 A/B 实验框架（客户端骨架）。
// 启动拉取实验分组（云函数 getExperiments），缓存到本地；无后端时回退到 DEFAULTS。
// 关键功能通过 getVariant / isEnabled 灰度开关，track 记录转化（本地）。
//
// 后端契约：云函数 aggregation 的 getExperiments action 返回
//   { experiments: { <expKey>: { variant: 'A'|'B', enabled: true } } }
// 详见 README「A/B 实验后端契约」。

const config = require('./config.js');

// 无云端时的兜底实验配置（保证框架离线可用）
const DEFAULTS = {
  // 关注页空态 CTA 文案 A/B：A=去发现战队 / B=浏览热门战队
  follow_cta_variant: { variant: 'A', enabled: true }
};

let _flags = null;
let _events = [];

function storageKey() {
  return (config && config.experiment && config.experiment.storageKey) || 'ab_flags';
}

function loadFromStorage() {
  try {
    _flags = wx.getStorageSync(storageKey()) || null;
  } catch (e) {
    _flags = null;
  }
  return _flags;
}

function getFlags() {
  if (_flags == null) loadFromStorage();
  return _flags || {};
}

// 启动拉取实验分组（best-effort，失败回退 DEFAULTS）。在 app.js onLaunch 调用。
// ⚠️ 非 async（移除云调用后已无 await → 保留 async 会触发 eslint `require-await` error 阻断 CI）；
//    仍**返回 Promise** 以保持对调用方的契约不变（await/then 均可继续使用）。
function refresh() {
  // ★★ 2026-09-22（微信云开发脱离）：**移除唯一的云开发调用**。
  //   原实现 `wx.cloud.callFunction({action:'getExperiments'})` 是**云专一**（EDGE_ACTIONS 无此 action，
  //   也无任何替代路径）；而其返回体只是云函数里**硬编码**的一份 experiment（`follow_cta_variant`），
  //   与本文件 `DEFAULTS` 等价 ⇒ 改为直接使用本地默认值，**行为不变、零风险**。
  //   若将来需要真正的服务端实验开关，应新增一个 EF action 并在此接入（届时仍是 EF，不回云开发）。
  _flags = Object.assign({}, DEFAULTS);
  return Promise.resolve(_flags);
}

// 取实验分组（A/B）；优先级：云端 > 本地 DEFAULTS > 传入默认
function getVariant(expKey, def) {
  const f = getFlags();
  if (f[expKey] && f[expKey].variant) return f[expKey].variant;
  if (DEFAULTS[expKey] && DEFAULTS[expKey].variant) return DEFAULTS[expKey].variant;
  return def || 'A';
}

// 实验是否启用
function isEnabled(flagKey) {
  const f = getFlags();
  if (f[flagKey] && typeof f[flagKey].enabled === 'boolean') return f[flagKey].enabled;
  if (DEFAULTS[flagKey]) return !!DEFAULTS[flagKey].enabled;
  return false;
}

// 记录转化事件（本地，生产环境应上报分析后端）
function track(expKey, variant, event) {
  try {
    _events.push({ expKey: expKey, variant: variant, event: event, ts: Date.now() });
    if (_events.length > 200) _events = _events.slice(-200);
    wx.setStorageSync('ab_events', _events);
  } catch (e) {}
}

module.exports = { refresh, getFlags, getVariant, isEnabled, track };
