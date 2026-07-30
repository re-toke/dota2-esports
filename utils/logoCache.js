// 本地队标/头像缓存（P2-F）
// 把已解析的 team_id / accountId → { logo, source, ts } 存到 wx.storage，
// 下次进入页面时 enrich 直接命中本地缓存、秒出 LOGO，跳过网络解析往返。
//
// 设计要点：
// - 缓存仅存「最终 URL」，不存图片二进制（小程序图片由微信按 URL 自动缓存）。
//   本缓存的价值是省掉 enrichTeamLogo / enrichPlayerAvatar 的「网络解析」这一步。
// - TTL 30 天 + 上限 2000 条（按 ts 裁剪最旧），避免无限增长。
// - wx 在 Node 测试环境不存在 → 全部 try/catch 安全降级为空（不影响单测/构建）。
// - Phase 1-⑦（2026-07-29）：persist 防抖优化。原实现每次 set() 都全量序列化（200KB+），
//   高频调用（如批量 enrichTeamLogos 16 支队伍）会阻塞主线程。
//   优化：标记 dirty + 500ms 防抖，合并短时间内的多次 set 为单次全量写入。

const KEY = 'dota2_logo_cache_v1';
const MAX = 2000;
const TTL = 30 * 24 * 3600 * 1000; // 30 天
const PERSIST_DEBOUNCE_MS = 500;  // 防抖间隔：500ms 内的多次 set 合并为单次写入

let mem = null;
let dirty = false;       // 是否有未写入的变更
let persistTimer = null; // 防抖定时器

function load() {
  if (mem) return mem;
  try {
    mem = wx.getStorageSync(KEY) || {};
  } catch (e) {
    mem = {};
  }
  return mem;
}

// 防抖持久化：标记 dirty 并在 500ms 后统一写入，避免高频 set 时反复全量序列化。
// 立即写入场景（如 onUnload / 页面销毁）调用 persistNow() 强制刷新。
function persist() {
  dirty = true;
  if (persistTimer) return;  // 已有待执行的写入，等待合并
  persistTimer = setTimeout(function () {
    persistTimer = null;
    persistNow();
  }, PERSIST_DEBOUNCE_MS);
}

// 强制立即写入（用于 onUnload 等需要确保持久化的场景）
function persistNow() {
  if (!dirty) return;
  dirty = false;
  if (!mem) return;  // 未 load 过，无需写入
  try {
    wx.setStorageSync(KEY, mem);
  } catch (e) { /* 忽略：存储不可用（如 Node 环境） */ }
}

function get(id) {
  if (id == null) return null;
  const m = load();
  const e = m[id];
  if (!e || !e.logo) return null;
  if (Date.now() - (e.ts || 0) > TTL) {
    delete m[id];
    return null;
  }
  return e;
}

// §8.4 负命中缓存（2026-07-30）：记录"该 id 已确认无 logo（多源查询失败）"的事实，
//   短期（24h）内跳过重复打 Liquipedia。设计原则：
//   - 与正向 logo 共享 storage KEY 但 schema 不同（无 logo 字段，有 negative=true）
//   - TTL 单独计算（24h，远短于正向 30d），避免永久错过上线后的新 logo
//   - get() 仍返回 null（UI 行为零变化），hasNegative() 仅给调用方做"是否值得再试"判断
function hasNegative(id) {
  if (id == null) return false;
  const m = load();
  const e = m[id];
  if (!e || !e.negative) return false;
  const NEG_TTL = 24 * 3600 * 1000;
  if (Date.now() - (e.ts || 0) > NEG_TTL) {
    delete m[id];
    return false;
  }
  return true;
}

function markNegative(id) {
  if (id == null) return;
  const m = load();
  // 若已有正向 logo 缓存，不覆盖
  if (m[id] && m[id].logo) return;
  m[id] = { negative: true, ts: Date.now() };
  const keys = Object.keys(m);
  if (keys.length > MAX) {
    keys.sort((a, b) => (m[a].ts || 0) - (m[b].ts || 0));
    keys.slice(0, keys.length - MAX).forEach((k) => { delete m[k]; });
  }
  persist();
}

function set(id, logo, source) {
  if (id == null || !logo) return;
  const m = load();
  m[id] = { logo: logo, source: source || '', ts: Date.now() };
  // 超上限则裁剪最旧条目
  const keys = Object.keys(m);
  if (keys.length > MAX) {
    keys.sort((a, b) => (m[a].ts || 0) - (m[b].ts || 0));
    keys.slice(0, keys.length - MAX).forEach((k) => { delete m[k]; });
  }
  persist();  // 防抖写入：500ms 内的多次 set 合并为单次全量序列化
}

module.exports = {
  get: get,
  set: set,
  hasNegative: hasNegative,
  markNegative: markNegative,
  // 暴露 persistNow 供页面 onUnload 时强制刷新（确保离开页面前数据落盘）
  persistNow: persistNow
};
