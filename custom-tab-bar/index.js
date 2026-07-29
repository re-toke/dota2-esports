// custom-tab-bar/index.js
// 全局自定义底部导航栏：增大图标/文字、区分选中态、微交互动效、安全区适配
Component({
  data: {
    selected: 0,
    color: '#8a8f99',
    selectedColor: '#C8A951',
    // §4.4 blur 降级（2026-07-29）：背景改为半透明，使 backdrop-filter: blur(12px) 生效。
    //   - 中高端机型：半透明 + blur = 毛玻璃效果
    //   - 低端 Android（不支持 backdrop-filter）：WXSS 中 .tab-bar__fallback 提供 rgba 降级色，
    //     inline style 的 rgba(22,27,34,0.82) 在无 blur 时仍为半透明深色，视觉接近纯色。
    //   - blur 渲染开销：低端机型如掉帧，可通过 data 属性切换 className 关闭 blur（预留扩展点）。
    backgroundColor: 'rgba(22, 27, 34, 0.82)',
    list: [
      { pagePath: '/pages/index/index', text: '首页', icon: 'home' },
      { pagePath: '/pages/leagues/leagues', text: '赛事', icon: 'flag' },
      { pagePath: '/pages/teams/teams', text: '战队', icon: 'usergroup' },
      { pagePath: '/pages/follow/follow', text: '关注', icon: 'heart' },
      { pagePath: '/pages/data/data', text: '资料库', icon: 'data' }
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