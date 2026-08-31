// subpackages/data/item-detail/item-detail.js
// 物品详情：名称 / 价格 / 是否配方 / 商店类型 / 合成树（§8.3 深度数据，2026-07-29）
// P1 缺口补齐（2026-08-31）：出装统计（适用英雄 TOP / 常见购买时间窗），
// 数据源 OpenDota /scenarios/itemTimings（全量对局口径，仅价格 >= 1400 金的物品），
// 主内容渲染后异步加载，失败/无样本时展示「暂无统计」说明，不阻塞页面。
const items = require('../items.js');

Page({
  data: {
    loading: true,
    error: '',
    item: null,
    recipeTree: [],   // §8.3 合成树组件列表
    usage: null,          // 出装统计 { totalGames, heroes[], timings[] }
    usageState: 'loading' // loading | ready | empty
  },

  onLoad(options) {
    const id = options && options.id;
    if (!id) {
      this.setData({ loading: false, error: '缺少物品参数' });
      return;
    }
    this.itemId = id;   // 保留原始字符串：常规/中立物品均为 OpenDota 数字 id 字符串（已合并，无 'n_' 前缀）
    this.load();
  },

  load() {
    this.setData({ loading: true, error: '', usage: null, usageState: 'loading' });
    // §8.3 并行加载基础信息 + 合成树
    Promise.all([
      items.getItem(this.itemId),
      items.getRecipeTree(this.itemId).catch(() => [])  // 合成树失败不阻塞主加载
    ])
      .then((res) => {
        const item = res[0];
        const recipeTree = res[1] || [];
        if (!item) {
          this.setData({ loading: false, error: '未找到该物品' });
          return;
        }
        this.setData({ item: item, recipeTree: recipeTree, loading: false });
        // 出装统计异步追载：主内容（名称/价格/合成树）已可渲染，统计慢一点无感
        this.loadUsage(item);
      })
      .catch(() => {
        this.setData({ loading: false, error: '物品数据加载失败，请检查网络或域名配置' });
      });
  },

  // P1（2026-08-31）：出装统计追载。usageState: loading→ready（有数据）/ empty（无样本或失败）。
  loadUsage(item) {
    const p = item.nameEn
      ? items.getItemUsage(item.nameEn)
      : Promise.resolve(null);
    p.then((usage) => {
      // 快速切换物品时丢弃过期响应
      if (item.id !== Number(this.itemId)) return;
      this.setData({
        usage: usage,
        usageState: usage ? 'ready' : 'empty'
      });
    });
  },

  onRetry() {
    this.load();
  }
});
