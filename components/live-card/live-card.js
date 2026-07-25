// components/live-card/live-card.js
// 直播聚合入口卡片：展示主流平台 DOTA2 直播搜索入口，isLive 时高亮置顶。
const liveSources = require('../../utils/liveSources.js');

Component({
  properties: {
    // 各平台入口 [{ key, name, color, url, miniApp }]
    sources: { type: Array, value: [] },
    // 赛事是否正在进行（高亮置顶）
    live: { type: Boolean, value: false },
    // 搜索关键词（赛事名）；缺省 DOTA2
    eventName: { type: String, value: 'DOTA2' }
  },

  methods: {
    onTapSource(e) {
      const url = e.currentTarget.dataset.url;
      const miniApp = e.currentTarget.dataset.mini;
      liveSources.openSource({ url: url, miniApp: miniApp });
    }
  }
});
