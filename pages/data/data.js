// pages/data/data.js
// 「资料库」落地页（第 5 个 tab）：作为英雄 / 物品数据库的入口。
Page({
  data: {},

  onShow() {
    // 批次0（2026-08-30）：data 已退出 tabBar，不再渲染 custom-tab-bar，移除高亮同步
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
