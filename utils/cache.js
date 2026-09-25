// utils/cache.js
// 基于 wx 本地存储的带 TTL 缓存。缓存命中不计入 OpenDota 限流，可显著降低请求量。
//
// §6.4 缓存膨胀防护（2026-07-29）：
//   - 存储用量超阈值（默认 6MB）时触发 LRU 淘汰，按 fetchedAt 最旧的优先淘汰
//   - set() 内置自动 prune，调用方无感知
//   - prune() 也可外部主动调用（如 onLaunch 启动时清理）

const PREFIX = 'dota2_cache_';
// 缓存占用上限（字节）。微信小程序本地存储上限 10MB，留 4MB 给其他业务数据。
const MAX_BYTES = 6 * 1024 * 1024;
// LRU 淘汰批次：每次淘汰最旧的 20% 条目，避免频繁触发 prune
const PRUNE_BATCH_RATIO = 0.2;

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

// §6.4 LRU 淘汰：当缓存总大小超 MAX_BYTES 时，淘汰最旧的 PRUNE_BATCH_RATIO 条目。
// 返回淘汰条数。调用方通常无需关心返回值。
// 策略：
//   1) 先淘汰已过期条目（最该清理）
//   2) 仍超限则按 fetchedAt 升序淘汰最旧的 20%
//   3) 每次 set() 后自动检测，调用方无感知
function prune() {
  try {
    const info = wx.getStorageInfoSync();
    const keys = (info.keys || []).filter((k) => k.indexOf(PREFIX) === 0);
    if (!keys.length) return 0;
    // 当前缓存大小（字节）。wx.getStorageInfoSync 的 currentSize 单位为 KB
    const curBytes = (info.currentSize || 0) * 1024;
    if (curBytes <= MAX_BYTES) return 0;

    // 收集所有缓存条目的 fetchedAt 用于 LRU 排序
    const items = [];
    const now = Date.now();
    keys.forEach((k) => {
      try {
        const raw = wx.getStorageSync(k);
        if (!raw) return;
        const obj = JSON.parse(raw);
        items.push({
          key: k,
          fetchedAt: obj.fetchedAt || 0,
          expire: obj.expire || 0,
          expired: obj.expire && now > obj.expire
        });
      } catch (e) { /* 畸形条目直接清理 */ wx.removeStorageSync(k); }
    });

    // 1) 先清理已过期条目
    let removed = 0;
    items.forEach((it) => {
      if (it.expired) { wx.removeStorageSync(it.key); removed++; }
    });

    // 2) 仍超限则按 fetchedAt 升序淘汰最旧的 20%
    const curBytesAfterExpiry = (wx.getStorageInfoSync().currentSize || 0) * 1024;
    if (curBytesAfterExpiry > MAX_BYTES) {
      const valid = items.filter((it) => !it.expired).sort((a, b) => a.fetchedAt - b.fetchedAt);
      const evictCount = Math.ceil(valid.length * PRUNE_BATCH_RATIO);
      for (let i = 0; i < evictCount && i < valid.length; i++) {
        wx.removeStorageSync(valid[i].key);
        removed++;
      }
    }
    if (removed && typeof console !== 'undefined' && console.info) {
      console.info('[cache] LRU prune: 淘汰 ' + removed + ' 条，释放空间');
    }
    return removed;
  } catch (e) {
    return 0;
  }
}

// ★★ 2026-09-25：**分片版 prune（仅供启动期调用）** —— 消除启动期长任务。
//
// 真机实测（用户 Console）：`[Violation] 'setTimeout' handler took 922ms` ✗
//   根因：启动定时器首句就是 `cache.prune()` ✓，而超限时它会**逐条同步读 + JSON.parse 全量扫描** ✗
//   算术对账：日志「淘汰 46 条」÷ PRUNE_BATCH_RATIO(0.2) ≈ **230 条**；
//   230 × ~4ms（同步 storage 桥调用）≈ **920ms** ✓ 与实测吻合 ✓
//   （即：**主要成本是"扫描"而非"删除"** —— 删除 46 条仅约 100~200ms）
//
// ⚠️ **为什么另开函数而不是改造 prune()**：`set()` 的写入路径（下方 L132/L136）依赖
//    「prune 返回时空间已腾出」✗ —— 改成异步会破坏该保证 ✗。故保留原同步 `prune()` 一字不动 ✓，
//    本函数仅供 `app.js` 启动期调用 ✓。
//
// ⚠️ 分片**只切分循环**（扫描 / 删除），**淘汰策略逐字不变**（先清过期 → 再按 fetchedAt 淘汰 20% ✓），
//    且未超限时与同步版一样**零成本返回** ✓。
function pruneIdle(chunkSize, onDone) {
  const step = chunkSize || 20;
  let info = null;
  try { info = wx.getStorageInfoSync(); } catch (e) { info = null; }
  if (!info) { if (onDone) onDone(0); return; }
  const keys = (info.keys || []).filter((k) => k.indexOf(PREFIX) === 0);
  if (!keys.length || (info.currentSize || 0) * 1024 <= MAX_BYTES) {
    if (onDone) onDone(0);
    return;
  }
  const t0 = Date.now();
  const now = Date.now();
  const items = [];
  let i = 0;
  let removed = 0;
  function finish() {
    if (typeof console !== 'undefined' && console.info) {
      console.info('[cache] prune(分片): 扫描 ' + keys.length + ' 条 / 淘汰 ' + removed +
                   ' 条 / 耗时 ' + (Date.now() - t0) + 'ms');
    }
    if (onDone) onDone(removed);
  }
  // 阶段 2：分片扫描（读 + parse）
  function scan() {
    const end = Math.min(i + step, keys.length);
    for (; i < end; i++) {
      const k = keys[i];
      try {
        const raw = wx.getStorageSync(k);
        if (!raw) continue;
        const obj = JSON.parse(raw);
        items.push({ key: k, fetchedAt: obj.fetchedAt || 0, expire: obj.expire || 0,
                     expired: obj.expire && now > obj.expire });
      } catch (e) { try { wx.removeStorageSync(k); } catch (e2) {} }
    }
    if (i < keys.length) { setTimeout(scan, 0); return; }
    evict();
  }
  // 阶段 3：分片删除（策略与同步版逐条一致）
  function evict() {
    const expiredKeys = items.filter((it) => it.expired).map((it) => it.key);
    if (expiredKeys.length) { removeKeys(expiredKeys, afterExpired); }
    else { afterExpired(); }
  }
  function removeKeys(list, cb) {
    let j = 0;
    (function step2() {
      const end = Math.min(j + step, list.length);
      for (; j < end; j++) { try { wx.removeStorageSync(list[j]); removed++; } catch (e) {} }
      if (j < list.length) { setTimeout(step2, 0); return; }
      cb();
    })();
  }
  function afterExpired() {
    let after = { currentSize: 0 };
    try { after = wx.getStorageInfoSync() || after; } catch (e) {}
    if ((after.currentSize || 0) * 1024 <= MAX_BYTES) { finish(); return; }
    const valid = items.filter((it) => !it.expired).sort((a, b) => a.fetchedAt - b.fetchedAt);
    const evictCount = Math.ceil(valid.length * PRUNE_BATCH_RATIO);
    const toRemove = valid.slice(0, Math.min(evictCount, valid.length)).map((it) => it.key);
    if (!toRemove.length) { finish(); return; }
    removeKeys(toRemove, finish);
  }
  setTimeout(scan, 0);
}

function set(key, value, ttlSec) {
  try {
    const expire = Date.now() + (ttlSec || 3600) * 1000;
    wx.setStorageSync(PREFIX + key, JSON.stringify({
      value: value, expire: expire, fetchedAt: Date.now()
    }));
    // §6.4 写入后检测容量，超限则 LRU 淘汰
    // 低频检查：仅在写入可能引发超限时才触发（setStorageSync 本身会在超 10MB 时抛错）
    // 这里做主动 prune 避免触发 wx 的硬限制
    prune();
  } catch (e) {
    // 存储空间不足等异常静默忽略，不影响主流程
    // 额外兜底：try-catch 触发时再 prune 一次，释放空间后不重试（避免循环）
    prune();
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
// O-11（2026-08-15）：clearAll 曾 0 引用（follow.js 手写 wx.clearStorageSync 替代）。
// 复核：仍 0 调用，删除。若未来设置页需「清缓存」，改调 wx.clearStorageSync 全清即可。

module.exports = {
  get: get, peek: peek, getStale: getStale,
  set: set, remove: remove, touch: touch,
  prune: prune,
  // ★ 2026-09-25：启动期专用（分片，不阻塞主线程）；写入路径仍用同步 prune ✓
  pruneIdle: pruneIdle
};
