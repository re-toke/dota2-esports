// utils/follow.js
// 关注订阅的本地存储实现。数据结构：{ teams:{id:item}, leagues:{id:item} }
// 全部存于本地 Storage，无需登录、无需后端。订阅消息推送需配合微信订阅消息（见 config.subscribeTemplateId）。

const KEY = 'dota2_follow';
// P1-3：模块级内存缓存，避免每次查询同步读 Storage。
// 所有写入统一走 write()，写入后同步更新 memo 即保证一致性（当前无外部绕过 follow.js 写该 key）。
let _memo = null;

function blank() {
  return { teams: {}, leagues: {} };
}

function read() {
  if (_memo) return _memo;
  try {
    const d = wx.getStorageSync(KEY);
    if (!d || typeof d !== 'object') return blank();
    if (!d.teams) d.teams = {};
    if (!d.leagues) d.leagues = {};
    _memo = d;
    return d;
  } catch (e) {
    return blank();
  }
}

function write(d) {
  _memo = d;   // 同步更新内存缓存（与落盘对象同一引用）
  try { wx.setStorageSync(KEY, d); } catch (e) {}
}

function isFollowed(type, id) {
  const d = read();
  return !!(d[type] && d[type][String(id)]);
}

function follow(type, item) {
  const d = read();
  if (!d[type]) d[type] = {};
  d[type][String(item.id)] = item;
  write(d);
  return true;
}

function unfollow(type, id) {
  const d = read();
  if (d[type]) delete d[type][String(id)];
  write(d);
  return false;
}

// 切换关注状态，返回切换后的「是否已关注」
function toggle(type, item) {
  if (isFollowed(type, item.id)) {
    unfollow(type, item.id);
    return false;
  }
  follow(type, item);
  return true;
}

function list(type) {
  const d = read();
  const obj = d[type] || {};
  return Object.keys(obj).map((k) => obj[k]);
}

function counts() {
  const d = read();
  return {
    teams: Object.keys(d.teams || {}).length,
    leagues: Object.keys(d.leagues || {}).length
  };
}

module.exports = {
  isFollowed: isFollowed,
  follow: follow,
  unfollow: unfollow,
  toggle: toggle,
  list: list,
  counts: counts
};
