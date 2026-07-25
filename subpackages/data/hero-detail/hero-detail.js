// subpackages/data/hero-detail/hero-detail.js
// 英雄详情：基础属性 / 定位 / 职业胜率·登场·禁用 / 最佳与最差对位（matchups）。
const heroes = require('../../../utils/heroes.js');

Page({
  data: {
    loading: true,
    error: '',
    hero: null,
    matchups: { best: [], worst: [] }
  },

  onLoad(options) {
    const id = options && options.id;
    if (!id) {
      this.setData({ loading: false, error: '缺少英雄参数' });
      return;
    }
    this.heroId = Number(id);
    this.load();
  },

  load() {
    this.setData({ loading: true, error: '' });
    Promise.all([
      heroes.getHero(this.heroId),
      heroes.getMatchups(this.heroId)
    ]).then((res) => {
      const hero = res[0];
      if (!hero) {
        this.setData({ loading: false, error: '未找到该英雄' });
        return;
      }
      this.setData({ hero: hero, matchups: res[1], loading: false });
    }).catch(() => {
      this.setData({ loading: false, error: '英雄数据加载失败，请检查网络或域名配置' });
    });
  },

  // 对位条目点击：跳转到对应英雄详情（同分包内 navigateTo）
  openMatchup(e) {
    const id = e.currentTarget.dataset.id;
    if (id) wx.navigateTo({ url: '/subpackages/data/hero-detail/hero-detail?id=' + id });
  },

  onRetry() {
    this.load();
  }
});
