// components/empty-state/empty-state.js
// V3 空状态组件：品牌图标 + 标题 + 描述 + 可选引导按钮。
// 通过 type 区分场景（follow/search/error/nostart/empty），点击按钮触发 bind:action 事件，
// 由页面自行决定跳转 / 重试 / 清空等行为，保持组件无业务耦合。
Component({
  properties: {
    type: { type: String, value: 'empty' }, // follow | search | error | nostart | empty
    title: { type: String, value: '' },
    desc: { type: String, value: '' },
    actionText: { type: String, value: '' } // 为空则不渲染按钮
  },

  data: {
    iconName: 'info-circle'
  },

  observers: {
    type(t) {
      const ICON = {
        follow: 'star',
        search: 'search',
        error: 'error-circle',
        nostart: 'flag',
        empty: 'info-circle'
      };
      this.setData({ iconName: ICON[t] || 'info-circle' });
    }
  },

  methods: {
    onAction() {
      this.triggerEvent('action');
    }
  }
});
