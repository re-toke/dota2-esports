// utils/items.js
// 物品数据库封装：物品基础数据来自 OpenDota /constants/items（旧端点 /items 已下线，返回 404）。
// getItemsList() 把该对象转换为数组（id/name/cost/recipe），getItems() 提供按 id 索引的图标/img/dname。
// 两者访问同一缓存键（/constants/items），实际只发一次网络请求。
//
// 数据清洗规则（与 dota2.com.cn 官网对齐）：
//   - 仅保留同时满足两项条件的物品：① 有官方中文名（itemZh.js 收录）；② 存在于官网装备列表（itemscategory/json）。
//   - 被剔除的包括：合成配方(recipe_*)、升级形态(dagon_2~5/necronomicon_2~3 等)、活动特殊物品、信使、
//     增强令牌、旧版中立物品等 —— 这些在 dota2.com.cn 官网商店/Tab2 中均不展示，且无官方中文。
//   - 中立物品通过 neutralItems.js 合并入列表（category='neutral'），不再单独追加（避免 id 冲突）。
//   - 物品图标统一走 Steam CDN（cdn.cloudflare.steamstatic.com，需在小程序后台 downloadFile 合法域名加入）。

const api = require('../../utils/api.js');
const itemZh = require('../../utils/itemZh.js');
const neutralItems = require('../../utils/neutralItems.js');
const heroes = require('../../utils/heroes.js');

// Steam CDN 源站（物品图标绝对地址基址，与英雄头像一致）
const ITEM_CDN_ORIGIN = 'https://cdn.cloudflare.steamstatic.com';

// 将 OpenDota 相对路径 /apps/dota2/images/dota_react/items/{name}.png?t=xxx 规范为绝对地址
function normalizeItemImg(img, name) {
  let v = img || ('/apps/dota2/images/dota_react/items/' + name + '.png');
  if (v.indexOf('http') === 0) return v;
  return ITEM_CDN_ORIGIN + (v.charAt(0) === '/' ? v : '/' + v);
}

let _items = null;   // 合并后的物品数组（常规 + 中立，去重）
let _byId = null;    // String(id) -> item

function buildAll(list, constants) {
  // constants：OpenDota 按 id 索引的常量表 { [id]: { name,img,dname } }
  // neutralItems：dota2.com.cn Tab2 权威中立数据，name -> { id, nameZh, tier, tierName }
  const cMap = constants || {};
  const neuMap = neutralItems || {};
  // 过滤条件：必须有中文名（itemZh 收录）且在中立表中或 itemZh 中存在
  // （itemZh 的 229 条与官网 itemscategory/json 的 229 条完全一致，故等价于「在官网 + 有中文」）
  return (list || [])
    .filter((it) => {
      const hasZh = !!itemZh[it.name];
      const isOfficial = !!neuMap[it.name] || hasZh; // neutralItems 覆盖中立，itemZh 覆盖全部商店
      return hasZh && isOfficial;
    })
    .map((it) => {
      const c = cMap[it.id] || {};
      const enName = it.localized_name || c.dname || it.name || '';
      const zh = itemZh[it.name];              // 官方中文
      const neu = neuMap[it.name];             // 中立层级（含中文兜底）
      const displayName = zh || (neu && neu.nameZh) || enName || it.name;
      const isNeutral = !!neu;
      return {
        id: it.id,
        name: displayName,
        nameEn: it.name,
        localizedName: displayName,
        initial: (displayName || '?').charAt(0),
        cost: it.cost || 0,
        recipe: !!it.recipe,
        secretShop: !!it.secret_shop,
        sideShop: !!it.side_shop,
        category: isNeutral ? 'neutral' : 'basic',
        tier: isNeutral ? neu.tier : 0,
        tierName: isNeutral ? neu.tierName : '',
        img: normalizeItemImg(c.img, it.name),
        // §8.3 物品深度数据（2026-07-29）：合成树组件（来自 OpenDota /constants/items 的 components 字段）
        components: Array.isArray(it.components) ? it.components.slice() : []
      };
    });
}

function loadAll() {
  if (_items) return Promise.resolve(_items);
  // 两个来源都来自 /constants/items（共享缓存，仅一次网络请求）：
  //   - getItemsList()：必需，提供名称/价格/配方（数组形态），列表与详情都依赖它，必须成功；
  //   - getItems()：补充图标(img)与展示名(dname)；列表页不渲染图标，且 img 缺失时可按 name 拼
  //     Steam CDN 兜底，因此该来源失败也不阻塞主加载（用 .catch(() => ({})) 降级为空映射）。
  return Promise.all([
    api.getItemsList(),
    api.getItems().catch(() => ({}))
  ])
    .then((res) => {
      const list = res[0];
      const constants = res[1] || {};
      // 合并：OpenDota 全量 + 中文 + 中立层级（无重复、无 id 冲突）
      _items = buildAll(list, constants);
      _byId = {};
      _items.forEach((it) => { _byId[String(it.id)] = it; });
      return _items;
    })
    .catch((e) => { _items = null; throw e; });
}

function getItems() { return loadAll(); }
function getItem(id) { return loadAll().then(() => _byId[String(id)] || null); }

// §8.3 物品深度数据（2026-07-29）：合成树解析
// 根据物品 id 查询其组件树（递归解析 components），返回扁平组件列表（去重）。
// 用于详情页展示"该物品由 X / Y / Z 合成"。
function getRecipeTree(id) {
  return loadAll().then(() => {
    const visited = {};
    const result = [];
    function dfs(itemId) {
      const key = String(itemId);
      if (visited[key]) return;
      visited[key] = true;
      const item = _byId[key];
      if (!item) return;
      const comps = item.components || [];
      comps.forEach((compId) => {
        const cKey = String(compId);
        const cItem = _byId[cKey];
        if (cItem) {
          result.push({
            id: cItem.id,
            name: cItem.name,
            cost: cItem.cost || 0,
            img: cItem.img
          });
          // 递归解析子组件
          dfs(compId);
        }
      });
    }
    dfs(id);
    return result;
  });
}

// P1 数据缺口补齐（2026-08-31）：物品出装统计（适用英雄 + 常见购买时间窗）。
// 数据源：OpenDota /scenarios/itemTimings（全量对局样本，仅统计价格 >= 1400 金的物品；
// 低价物品端点返回空数组 → 返回 null，由页面展示「暂无统计」说明）。
// 聚合逻辑：
//   - heroes：按 hero_id 累计 games/wins → 过滤样本 <100 场（噪声大）→ 按场次降序取 TOP 8；
//     名称用 heroes.nameOf（官方中文），头像由 internalNameMap 拼 Steam CDN 地址。
//   - timings：按购买时刻（秒→分钟）累计 games → 取占比最高的 5 个时间窗（按时间升序展示）。
// 失败降级：统计数据获取失败不阻塞详情页主内容（catch → null）。
function getItemUsage(nameEn) {
  if (!nameEn) return Promise.resolve(null);
  // 先确保英雄库就绪（nameOf / internalNameMap 依赖 loadAll 完成后的内存映射）
  return heroes.getHeroes()
    .catch(() => null)   // 英雄库失败不阻塞统计（名称降级为「英雄#id」）
    .then(() => api.getItemTimings(nameEn))
    .then((rows) => {
      if (!Array.isArray(rows) || rows.length === 0) return null;
      const heroAgg = {};
      const timeAgg = {};
      let totalGames = 0;
      (rows || []).forEach((r) => {
        if (!r || r.hero_id == null) return;
        const g = Number(r.games) || 0;
        const w = Number(r.wins) || 0;   // OpenDota 返回字符串数字，必须显式转换
        if (g <= 0) return;
        totalGames += g;
        const ha = heroAgg[r.hero_id] || (heroAgg[r.hero_id] = { games: 0, wins: 0 });
        ha.games += g;
        ha.wins += w;
        const tMin = Math.round((Number(r.time) || 0) / 60);
        const ta = timeAgg[tMin] || (timeAgg[tMin] = { games: 0 });
        ta.games += g;
      });
      if (!totalGames) return null;
      const internal = heroes.internalNameMap();
      const HERO_CDN_ORIGIN = 'https://cdn.cloudflare.steamstatic.com';
      const heroRows = Object.keys(heroAgg)
        .map((hid) => {
          const a = heroAgg[hid];
          const idNum = Number(hid);
          const inner = internal[idNum] || '';
          return {
            heroId: idNum,
            name: heroes.nameOf(idNum) || ('英雄#' + hid),
            avatar: inner ? HERO_CDN_ORIGIN + '/apps/dota2/images/heroes/' + inner + '_full.png' : '',
            games: a.games,
            winRate: a.games ? Math.round((a.wins / a.games) * 1000) / 10 : 0
          };
        })
        .filter((h) => h.games >= 100)
        .sort((a, b) => b.games - a.games)
        .slice(0, 8);
      const timingRows = Object.keys(timeAgg)
        .map((t) => ({
          minute: Number(t),
          games: timeAgg[t].games,
          share: totalGames ? Math.round((timeAgg[t].games / totalGames) * 1000) / 10 : 0
        }))
        .sort((a, b) => b.games - a.games)
        .slice(0, 5)
        .sort((a, b) => a.minute - b.minute);
      return { totalGames: totalGames, heroes: heroRows, timings: timingRows };
    })
    .catch(() => null);
}

module.exports = { getItems, getItem, getRecipeTree, getItemUsage };
