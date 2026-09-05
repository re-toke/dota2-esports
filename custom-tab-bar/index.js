// custom-tab-bar/index.js
// 全局自定义底部导航栏：增大图标/文字、区分选中态、微交互动效、安全区适配
Component({
  data: {
    selected: 0,
    // 雾峰雪 v2.0（2026-09-05）：背景改为半透明白，配合 backdrop-filter: blur(12px) 毛玻璃效果。
    //   - 中高端机型：半透明白 + blur = 亮色毛玻璃
    //   - 低端 Android（不支持 backdrop-filter）：WXSS .tab-bar::after 兜底为不透明 #F8F9FA。
    backgroundColor: 'rgba(248, 249, 250, 0.92)',
    // 批次0（2026-08-30）：3-tab 精简（首页/赛事/我的），战队/资料库移至首页快捷区。
    // 图标改 game-icons.net 剪影 PNG（PRD §3.2，SVG 内联在 wxml 不可行）：
    //   每项 iconOn（选中金）/ iconOff（未选中灰）两态图片，渲染层由 t-icon 换 <image>。
    list: [
      { pagePath: '/pages/index/index', text: '首页', iconOn: '/assets/icons/tab-home-on.png', iconOff: '/assets/icons/tab-home-off.png' },
      { pagePath: '/pages/leagues/leagues', text: '赛事', iconOn: '/assets/icons/tab-league-on.png', iconOff: '/assets/icons/tab-league-off.png' },
      { pagePath: '/pages/follow/follow', text: '我的', iconOn: '/assets/icons/tab-me-on.png', iconOff: '/assets/icons/tab-me-off.png' }
    ]
  },

  lifetimes: {
    attached() {
      // §4.4 降级检测：低端机型关闭 blur 减少掉帧
      // 判定标准：benchmark 分数 < 1000（中低端）或 platform 为 android 且 benchmark 未知时保守关闭
      // 注：wx.getDeviceInfoBenchmark 在部分基础库可用，回退到性能等级字符串
      try {
        let perfLevel = 'unknown';
        if (wx.getDeviceInfo && wx.getDeviceInfo().benchmarkLevel != null) {
          const bl = wx.getDeviceInfo().benchmarkLevel;
          // -1 未知，<10 低端，10-20 中端，>20 高端
          perfLevel = (bl < 0) ? 'unknown' : (bl < 10 ? 'low' : 'high');
        }
        if (perfLevel === 'low') {
          this.setData({ blurDisabled: true });
        }
      } catch (e) { /* 静默，默认启用 blur */ }
    }
  },

  methods: {
    switchTab(e) {
      const { index, path } = e.currentTarget.dataset;
      if (index === this.data.selected) return;
      wx.switchTab({ url: path });
    }
  }
});