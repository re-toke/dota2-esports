// pages/data/data.js
// 「资料库」落地页（第 5 个 tab）：作为英雄 / 物品数据库的入口。
Page({
  data: {},

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 4 });
    }
  },

  goHero() {
    wx.navigateTo({ url: '/subpackages/data/hero/hero' });
  },

  goItem() {
    wx.navigateTo({ url: '/subpackages/data/item/item' });
  }
});
