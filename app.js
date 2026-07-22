const api = require('./utils/api.js');
const remoteCuration = require('./utils/remoteCuration.js');
const config = require('./utils/config.js');

App({
  globalData: {
    // 英雄 id -> 中文/英文名 映射，启动预加载，避免每页重复请求
    heroMap: {},
    heroReady: false
  },

  onLaunch() {
    // CloudBase 初始化（若启用云代理）；即使未启用也调用一次 wx.cloud = 提前可用
    if (config.cloudProxy && config.cloudProxy.enabled) {
      try { wx.cloud.init(); } catch (e) {}
    }
    // 远程 curation（若配置 url）后台静默加载，失败不阻塞
    remoteCuration.load();
    api.getHeroes()
      .then((list) => {
        const map = {};
        (list || []).forEach((h) => {
          map[h.id] = h.localized_name;
        });
        this.globalData.heroMap = map;
        this.globalData.heroReady = true;
      })
      .catch(() => {
        // 英雄表加载失败不阻塞主流程，队员页会回退显示 hero_id
      });
  }
});
