// utils/cloudBreaker.js
// 极简熔断器：云函数连续失败达到阈值后，本会话内停用云代理，避免「未部署云函数」
// 的用户每次请求都先失败一次再回退直连的额外开销。状态用 wx storage 持久化，
// 跨页面/冷启动生效；成功一次即复位。
//
// 独立于 cloudProxy / api，避免循环依赖；任何需要判断「云是否可用」的模块都 require 它。

const CB_KEY = 'dota2_cloud_cb';

function state() {
  try {
    const raw = wx.getStorageSync(CB_KEY);
    if (raw && typeof raw === 'object') return raw;
  } catch (e) {}
  return { broken: false, fails: 0 };
}

function save(s) {
  try { wx.setStorageSync(CB_KEY, s); } catch (e) {}
}

// 云代理是否可用：未启用 / 已熔断 均返回 false
function isAvailable(enabled, threshold) {
  if (!enabled) return false;
  if (!threshold || threshold <= 0) return true; // 不启用熔断
  return !state().broken;
}

function markFailure(threshold) {
  if (!threshold || threshold <= 0) return;
  const s = state();
  s.fails = (s.fails || 0) + 1;
  if (s.fails >= threshold) {
    s.broken = true;
    console.warn('[cloudBreaker] 云函数连续失败 ' + threshold + ' 次，本会话熔断 → 回退直连（部署/修复云函数后成功一次自动恢复）');
  }
  save(s);
}

function markSuccess() {
  const s = state();
  if (s.fails !== 0 || s.broken) save({ broken: false, fails: 0 });
}

module.exports = { CB_KEY: CB_KEY, isAvailable: isAvailable, markFailure: markFailure, markSuccess: markSuccess };
