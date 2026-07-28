// 本地队标/头像缓存（P2-F）
// 把已解析的 team_id / accountId → { logo, source, ts } 存到 wx.storage，
// 下次进入页面时 enrich 直接命中本地缓存、秒出 LOGO，跳过网络解析往返。
//
// 设计要点：
// - 缓存仅存「最终 URL」，不存图片二进制（小程序图片由微信按 URL 自动缓存）。
//   本缓存的价值是省掉 enrichTeamLogo / enrichPlayerAvatar 的「网络解析」这一步。
// - TTL 30 天 + 上限 2000 条（按 ts 裁剪最旧），避免无限增长。
// - wx 在 Node 测试环境不存在 → 全部 try/catch 安全降级为空（不影响单测/构建）。

const KEY = 'dota2_logo_cache_v1';
const MAX = 2000;
const TTL = 30 * 24 * 3600 * 1000; // 30 天

let mem = null;

function load() {
  if (mem) return mem;
  try {
    mem = wx.getStorageSync(KEY) || {};
  } catch (e) {
    mem = {};
  }
  return mem;
}

function persist() {
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
  persist();
}

module.exports = { get, set };
