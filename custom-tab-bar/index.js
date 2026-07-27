// custom-tab-bar/index.js
// 全局自定义底部导航栏：增大图标/文字、区分选中态、微交互动效、安全区适配
Component({
  data: {
    selected: 0,
    color: '#8a8f99',
    selectedColor: '#C8A951',
    backgroundColor: '#161b22',
    list: [
      { pagePath: '/pages/index/index', text: '首页', icon: 'home' },
      { pagePath: '/pages/leagues/leagues', text: '赛事', icon: 'flag' },
      { pagePath: '/pages/teams/teams', text: '战队', icon: 'usergroup' },
      { pagePath: '/pages/follow/follow', text: '关注', icon: 'heart' },
      { pagePath: '/pages/data/data', text: '资料库', icon: 'data' }
    ]
  },

  methods: {
    switchTab(e) {
      const { index, path } = e.currentTarget.dataset;
      if (index === this.data.selected) return;
      wx.switchTab({ url: path });
    }
  }
});