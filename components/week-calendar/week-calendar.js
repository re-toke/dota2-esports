// components/week-calendar/week-calendar.js
// 批次2（2026-08-30）· PRD §4.1 周日历时间轴
// 纯展示组件：7 格横向日历（周一~周日 + 日期数字 + 当日比赛数角标）。
// 数据由页面构造（days），组件只负责渲染与选中态，点选/翻周通过事件回传页面。
Component({
  options: {
    // 允许页面样式类穿透（统一 token 字号/颜色）
    addGlobalClass: true
  },

  properties: {
    // 7 天数组：[{ key: 'YYYY-MM-DD', label: '一', dateNum: 24, count: 3, isToday: true }, ...]
    days: { type: Array, value: [] },
    // 当前选中日期 key（'YYYY-MM-DD'）
    selected: { type: String, value: '' },
    // 是否可跨周切换（显示左右箭头）
    weekSwitchable: { type: Boolean, value: true }
  },

  data: {
    // 按压态（wxml hover-class 由 view 原生支持，这里不额外管理）
  },

  methods: {
    // 点选某天 → 回传页面（页面负责切换比赛流）
    onDayTap(e) {
      const key = e.currentTarget.dataset.key;
      if (!key || key === this.data.selected) return;
      this.triggerEvent('select', { key: key });
    },

    // 翻周：-1 上周 / +1 下周
    onWeekShift(e) {
      const dir = Number(e.currentTarget.dataset.dir) || 0;
      if (!dir) return;
      this.triggerEvent('weekshift', { dir: dir });
    }
  }
});
