// utils/follow.js
// 关注订阅的本地存储实现。数据结构：{ teams:{id:item}, players:{id:item}, leagues:{id:item} }
// 全部存于本地 Storage，无需登录、无需后端。订阅消息推送需配合微信订阅消息（见 config.subscribeTemplateId）。

const KEY = 'dota2_follow';

function blank() {
  return { teams: {}, players: {}, leagues: {} };
}

function read() {
  try {
    const d = wx.getStorageSync(KEY);
    if (!d || typeof d !== 'object') return blank();
    if (!d.teams) d.teams = {};
    if (!d.players) d.players = {};
    if (!d.leagues) d.leagues = {};
    return d;
  } catch (e) {
    return blank();
  }
}

function write(d) {
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
    players: Object.keys(d.players || {}).length,
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
