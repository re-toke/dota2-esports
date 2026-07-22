// utils/searchHistory.js
// 本地搜索历史（Storage 持久化）。用于战队搜索：降低重复 API 搜索、提供快捷再搜。
// 仅保存「成功返回结果」的关键词，无效词不污染历史。

const PREFIX = 'dota2_search_hist_';
const MAX = 10;

function key(type) { return PREFIX + (type || 'teams'); }

// 返回最近关键词数组（最近在前）。
function get(type) {
  try {
    const raw = wx.getStorageSync(key(type));
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}

// 写入一个关键词：去重并置顶，最多保留 MAX 条。返回最新列表。
function add(type, kw) {
  const word = (kw || '').trim();
  if (!word) return get(type);
  const list = get(type).filter((w) => w !== word);
  list.unshift(word);
  const next = list.slice(0, MAX);
  try { wx.setStorageSync(key(type), JSON.stringify(next)); } catch (e) {}
  return next;
}

// 删除单个关键词，返回最新列表。
function remove(type, kw) {
  const list = get(type).filter((w) => w !== kw);
  try { wx.setStorageSync(key(type), JSON.stringify(list)); } catch (e) {}
  return list;
}

// 清空历史，返回空数组。
function clear(type) {
  try { wx.removeStorageSync(key(type)); } catch (e) {}
  return [];
}

module.exports = { get: get, add: add, remove: remove, clear: clear, MAX: MAX };
