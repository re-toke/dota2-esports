// utils/items.js
// 物品数据库封装：合并 OpenDota /items（价格/配方/商店类型/本地名）与 /constants/items（图标/展示名）。
// 不依赖后端，走 api.js 既有缓存/限流/云代理回退。物品图标若需展示，需在小程序后台将
// cdn.cloudflare.steamstatic.com 加入 request 合法域名；未配置时 image-fallback 自动回退占位。

const api = require('./api.js');

let _items = null;   // 合并后的物品数组
let _byId = null;    // id -> item

function merge(list, constants) {
  const cMap = constants || {};
  return (list || []).map((it) => {
    const c = cMap[it.name] || {};
    return {
      id: it.id,
      name: it.name,
      localizedName: it.localized_name || c.dname || it.name,
      initial: (it.localized_name || c.dname || it.name || '?').charAt(0),
      cost: it.cost || 0,
      recipe: !!it.recipe,
      secretShop: !!it.secret_shop,
      sideShop: !!it.side_shop,
      img: c.img || ''
    };
  });
}

function loadAll() {
  if (_items) return Promise.resolve(_items);
  return Promise.all([api.getItemsList(), api.getItems()])
    .then((res) => {
      _items = merge(res[0], res[1]);
      _byId = {};
      _items.forEach((it) => { _byId[it.id] = it; });
      return _items;
    })
    .catch((e) => { _items = null; throw e; });
}

function getItems() { return loadAll(); }
function getItem(id) { return loadAll().then(() => _byId[id] || null); }

module.exports = { getItems, getItem };
