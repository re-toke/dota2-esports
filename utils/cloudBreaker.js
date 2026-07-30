// utils/cloudBreaker.js
// 极简熔断器：云函数连续失败达到阈值后，本会话内停用云代理，避免「未部署云函数」
// 的用户每次请求都先失败一次再回退直连的额外开销。状态用 wx storage 持久化，
// 跨页面/冷启动生效；成功一次即复位。
//
// ★ 熔断 TTL（2026-07-30）：原实现熔断后永久持续，即使云函数修复部署也不会重试。
//   现实现：熔断后 10 分钟自动过期，允许重新尝试云调用（云函数修复后自动恢复）。
//   10 分钟平衡：足够避免未部署用户的频繁失败开销，又能让修复后用户尽快恢复。
//
// 独立于 cloudProxy / api，避免循环依赖；任何需要判断「云是否可用」的模块都 require 它。

const CB_KEY = 'dota2_cloud_cb';
const BROKEN_TTL = 10 * 60 * 1000;  // 熔断状态 10 分钟 TTL

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

// 云代理是否可用：未启用 / 已熔断（且未过期）均返回 false
function isAvailable(enabled, threshold) {
  if (!enabled) return false;
  if (!threshold || threshold <= 0) return true; // 不启用熔断
  const s = state();
  if (!s.broken) return true;
  // 熔断中：检查是否已过期（10 分钟 TTL）
  if (Date.now() - (s.brokenAt || 0) > BROKEN_TTL) {
    // 过期：自动复位，允许重试
    save({ broken: false, fails: 0 });
    return true;
  }
  return false;
}

function markFailure(threshold) {
  if (!threshold || threshold <= 0) return;
  const s = state();
  s.fails = (s.fails || 0) + 1;
  if (s.fails >= threshold) {
    // 仅在首次熔断时记录时间戳 + 打印警告
    if (!s.broken) {
      s.brokenAt = Date.now();
      console.warn('[cloudBreaker] 云函数连续失败 ' + threshold + ' 次，熔断 ' + (BROKEN_TTL / 60000) + ' 分钟 → 回退直连（到期自动重试，成功一次即复位）');
    }
    s.broken = true;
  }
  save(s);
}

function markSuccess() {
  const s = state();
  if (s.fails !== 0 || s.broken) save({ broken: false, fails: 0 });
}

module.exports = { CB_KEY: CB_KEY, isAvailable: isAvailable, markFailure: markFailure, markSuccess: markSuccess };
