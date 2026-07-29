const api = require('./utils/api.js');
const remoteCuration = require('./utils/remoteCuration.js');
const config = require('./utils/config.js');
const experiment = require('./utils/experiment.js');
const cache = require('./utils/cache.js');

App({
  globalData: {
    // 英雄 id -> 中文名 映射，启动预加载，避免每页重复请求
    heroMap: {},
    heroReady: false,
    // 物品 id -> { name, img, dname } 映射，比赛详情页出装展示用
    itemMap: {},
    itemReady: false
  },

  onLaunch() {
    // 所有「后台预热 / 非关键预取」一律推迟到首屏渲染之后执行，
    // 避免 onLaunch 同步阶段堆满 wx.getStorageSync / JSON.parse / 云调用而触发长任务告警。
    // 页面已用 heroReady / itemReady 守卫，延迟填充不影响首屏与交互。
    setTimeout(() => {
      // §6.4 启动时清理过期/超限缓存（LRU prune），释放存储空间
      try { cache.prune(); } catch (e) {}
      // CloudBase 初始化（若启用云代理）。
      // 传入 envId（config.cloudProxy.envId）确保真机与模拟器行为一致；
      // 留空则走默认环境（仅单环境账号有效）。
      if (config.cloudProxy && config.cloudProxy.enabled) {
        try {
          const envId = config.cloudProxy.envId;
          wx.cloud.init({
            env: envId || undefined,
            traceUser: true
          });
        } catch (e) {}
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
      // 物品表预加载（比赛详情页出装展示用，失败不阻塞）
      api.getItems()
        .then((map) => {
          this.globalData.itemMap = map || {};
          this.globalData.itemReady = true;
        })
        .catch(() => {});
      // T6 A/B 实验分组拉取（best-effort，失败回退本地 DEFAULTS，不阻塞启动）
      experiment.refresh().catch(() => {});
    }, 0);
  }
});
