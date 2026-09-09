// components/empty-state/empty-state.js
// V4 空状态组件：电竞主题插画 + 标题 + 描述 + 可选引导按钮。
// 通过 type 区分场景（follow/search/error/nostart/empty/offline），
// 插画源 assets/illustrations/empty-{type}.png；未知 type 回退 empty，
// 点击按钮触发 bind:action 事件，由页面自行决定跳转 / 重试 / 清空等行为，保持组件无业务耦合。
Component({
  properties: {
    type: { type: String, value: 'empty' }, // follow | team | search | error | nostart | empty | offline
    title: { type: String, value: '' },
    desc: { type: String, value: '' },
    actionText: { type: String, value: '' } // 为空则不渲染按钮
  },

  data: {
    illustration: 'empty'
  },

  observers: {
    type(t) {
      const VALID = ['follow', 'team', 'search', 'error', 'nostart', 'empty', 'offline'];
      this.setData({ illustration: VALID.indexOf(t) !== -1 ? t : 'empty' });
    }
  },

  methods: {
    onAction() {
      this.triggerEvent('action');
    }
  }
});
