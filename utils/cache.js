// utils/cache.js
// 基于 wx 本地存储的带 TTL 缓存。缓存命中不计入 OpenDota 限流，可显著降低请求量。

const PREFIX = 'dota2_cache_';

function get(key, ttlSec) {
  try {
    const raw = wx.getStorageSync(PREFIX + key);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (ttlSec && Date.now() > obj.expire) {
      wx.removeStorageSync(PREFIX + key);
      return null;
    }
    return obj.value;
  } catch (e) {
    return null;
  }
}

// 只读查看（不过期判定）：返回 { value, fetchedAt, expire } 或 null。
// 用于 UI 展示「更新于 X 前」的采集时间戳，不影响数据有效性。
function peek(key) {
  try {
    const raw = wx.getStorageSync(PREFIX + key);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return { value: obj.value, fetchedAt: obj.fetchedAt || 0, expire: obj.expire || 0 };
  } catch (e) {
    return null;
  }
}

// 带「软过期」的读取：用于 stale-while-revalidate。
// 返回 { value, fetchedAt, fresh, expired }
//   - expired=true  ：已超过硬 TTL，调用方应重新拉取
//   - fresh=true    ：在新鲜窗口内，可直接用
//   - fresh=false   ：未过期但已超过新鲜窗口，调用方可用旧值并后台刷新
function getStale(key, freshSec, ttlSec) {
  try {
    const raw = wx.getStorageSync(PREFIX + key);
    if (!raw) return { value: null, fetchedAt: 0, fresh: false, expired: true };
    const obj = JSON.parse(raw);
    const now = Date.now();
    if (ttlSec && now > obj.expire) {
      wx.removeStorageSync(PREFIX + key);
      return { value: null, fetchedAt: 0, fresh: false, expired: true };
    }
    const fetchedAt = obj.fetchedAt || 0;
    const fresh = freshSec ? (now - fetchedAt) <= freshSec * 1000 : true;
    return { value: obj.value, fetchedAt: fetchedAt, fresh: fresh, expired: false };
  } catch (e) {
    return { value: null, fetchedAt: 0, fresh: false, expired: true };
  }
}

function set(key, value, ttlSec) {
  try {
    const expire = Date.now() + (ttlSec || 3600) * 1000;
    wx.setStorageSync(PREFIX + key, JSON.stringify({
      value: value, expire: expire, fetchedAt: Date.now()
    }));
  } catch (e) {
    // 存储空间不足等异常静默忽略，不影响主流程
  }
}

function remove(key) {
  try { wx.removeStorageSync(PREFIX + key); } catch (e) {}
}

// 仅刷新采集时间与过期时间，不改变缓存值。
// 用于「无新数据」的轮询心跳：把 stale 刷新标记为本轮已检查，避免立刻再次拉取。
function touch(key, ttlSec) {
  try {
    const raw = wx.getStorageSync(PREFIX + key);
    if (!raw) return;
    const obj = JSON.parse(raw);
    const now = Date.now();
    obj.fetchedAt = now;
    obj.expire = now + (ttlSec || 3600) * 1000;
    wx.setStorageSync(PREFIX + key, JSON.stringify(obj));
  } catch (e) {}
}

// 清空本项目的全部缓存（设置页「清除缓存」用）
function clearAll() {
  try {
    const info = wx.getStorageInfoSync();
    (info.keys || []).forEach((k) => {
      if (k.indexOf(PREFIX) === 0) wx.removeStorageSync(k);
    });
  } catch (e) {}
}

module.exports = { get: get, peek: peek, getStale: getStale, set: set, remove: remove, touch: touch, clearAll: clearAll };
