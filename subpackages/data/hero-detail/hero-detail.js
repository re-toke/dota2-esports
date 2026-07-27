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

  // 头像加载失败兜底（两阶段）：
  // 1) 当前 src 是 _full.png 时，自动切到 _lg.png 重试——Valve 部分英雄（如 Dawnbreaker 破晓辰星）
  //    只提供 _lg.png 而无 _full.png，这样无需枚举特例即可兼容；
  // 2) _lg 仍失败（或非 _full 后缀）才回退到首字母占位。
  onAvatarError() {
    const hero = this.data.hero;
    if (!hero || !hero.avatar) return;
    const cur = hero.avatar;
    if (cur.endsWith('_full.png')) {
      this.setData({ 'hero.avatar': cur.replace(/_full\.png$/, '_lg.png') });
      return;
    }
    this.setData({ 'hero.avatar': '' });
  },

  onRetry() {
    this.load();
  }
});
