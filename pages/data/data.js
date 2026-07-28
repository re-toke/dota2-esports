// pages/data/data.js
// 「资料库」落地页（第 5 个 tab）：作为英雄 / 物品数据库的入口。
Page({
  data: {},

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 4 });
    }
    // 进入资料库时主动预加载 data 分包，后续 hero/item 跳转秒开
    // 已加载过分包会自动跳过，无副作用
    if (wx.preloadSubpackage) {
      wx.preloadSubpackage({ name: 'data', success() {}, fail() {} });
    }
  },

  goHero() {
    wx.navigateTo({ url: '/subpackages/data/hero/hero' });
  },

  goItem() {
    wx.navigateTo({ url: '/subpackages/data/item/item' });
  }
});
