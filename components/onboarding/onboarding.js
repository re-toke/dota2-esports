// 首次启动引导组件（3 步：赛事 → 关注 → 详情）
// 仅在本地未标记 onboarded 时展示；完成或跳过均写入 Storage 避免重复弹出。
Component({
  options: {
    addGlobalClass: true
  },
  data: {
    visible: false,
    step: 0,
    steps: [
      { icon: '🏆', title: '赛事', desc: '浏览 S 级及以上赛事，按 进行中 / 即将到来 / 已结束 快速筛选。' },
      { icon: '⭐', title: '关注', desc: '点亮赛事或战队旁的星标，在「关注」页集中追踪你关心的动态。' },
      { icon: '🔍', title: '详情', desc: '点进任意赛事或战队，查看对阵、成员与多源数据溯源。' }
    ]
  },
  lifetimes: {
    attached() {
      // 非首次启动则跳过引导
      const done = wx.getStorageSync('onboarded');
      if (!done) this.setData({ visible: true });
    }
  },
  methods: {
    onNext() {
      const step = this.data.step;
      if (step >= this.data.steps.length - 1) {
        this.finish();
      } else {
        this.setData({ step: step + 1 });
      }
    },
    onSkip() {
      this.finish();
    },
    finish() {
      wx.setStorageSync('onboarded', true);
      this.setData({ visible: false });
      this.triggerEvent('finish');
    }
  }
});
