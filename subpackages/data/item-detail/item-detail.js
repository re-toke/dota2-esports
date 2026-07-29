// subpackages/data/item-detail/item-detail.js
// 物品详情：名称 / 价格 / 是否配方 / 商店类型 / 合成树（§8.3 深度数据，2026-07-29）
// 适用英雄 / 赛事出装率需策展数据或赛后分析，已在详情页标注为「待补充」。
const items = require('../../../utils/items.js');

Page({
  data: {
    loading: true,
    error: '',
    item: null,
    recipeTree: []    // §8.3 合成树组件列表
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
    this.setData({ loading: true, error: '' });
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
      })
      .catch(() => {
        this.setData({ loading: false, error: '物品数据加载失败，请检查网络或域名配置' });
      });
  },

  onRetry() {
    this.load();
  }
});
