const api = require('./utils/api.js');
const remoteCuration = require('./utils/remoteCuration.js');
const config = require('./utils/config.js');
const experiment = require('./utils/experiment.js');
const cache = require('./utils/cache.js');
// ★ 2026-08-07（审核 R2）：账号预登录（openid 预热）——赛前通知订阅授权须在点击手势内同步弹窗，
//   onLaunch 预热保证用户点「开启提醒」时缓存命中（缓存命中后零请求），规避手势校验红线。
const auth = require('./utils/auth.js');
// ★ 2026-08-11 方案 E：迁移老用户 fakeId 关注记录到真实 leagueId
const follow = require('./utils/follow.js');
const curation = require('./utils/curation.js');

// 方案 E 一次性幂等迁移：将 follow.leagues 中的负数 fakeId 关注记录迁移到真实 leagueId。
// 幂等：已迁移过的真实 id 不会被重复处理；无 curation 真实 id 对应的 fakeId 原样保留。
// 安全：失败静默，不影响启动；通过 _migratedLeagues 标记位避免重复执行。
function migrateFakeIdFollows() {
  try {
    const flag = wx.getStorageSync('dota2_follow_fakeid_migrated');
    if (flag) return;  // 已执行过
    const list = follow.list('leagues') || [];
    if (!list.length) { wx.setStorageSync('dota2_follow_fakeid_migrated', 1); return; }
    let migrated = 0;
    list.forEach((item) => {
      const fid = Number(item.id);
      // 只处理负数 fakeId（真实 id 直接跳过）
      if (!isNaN(fid) && fid < 0) {
        // 按 curation 规范名/别名反查真实 leagueId
        const ev = curation.curatedEventFor(item.name || '');
        if (ev && ev.leagueId != null) {
          follow.unfollow('leagues', fid);
          follow.follow('leagues', { id: ev.leagueId, name: item.name });
          migrated++;
        }
      }
    });
    wx.setStorageSync('dota2_follow_fakeid_migrated', 1);
  } catch (e) {
    // 失败静默，下次启动重试
  }
}

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
      // ★ 2026-08-07（R2）：账号预登录预热（fire-and-forget，失败静默；缓存命中后零请求）
      auth.ensureLogin().catch(() => {});
      // ★ 2026-08-11 方案 E：迁移老用户 fakeId 关注记录到真实 leagueId（一次性幂等）
      migrateFakeIdFollows();
      // ★ 2026-09-03（加载优化 A）：冷启动后台预取赛事列表 + 时间窗口（fire-and-forget）。
      //   用户从首页浏览数秒后切到赛事页时本地缓存已热（cachedFresh 1h 新鲜窗口命中），
      //   4493ms 网络段 → 秒开。5min 节流避免短时间多次冷启动重复打云。
      //   预取条件：① 仅在启用云代理时 ② 距上次预取 > 5min 或首次冷启动。
      const _now = Date.now();
      if (
        config.cloudProxy && config.cloudProxy.enabled &&
        (!this._leaguesPrefetchedAt || (_now - this._leaguesPrefetchedAt) > 5 * 60 * 1000)
      ) {
        this._leaguesPrefetchedAt = _now;
        api.getLeagues().catch(() => {});
        api.getLeagueWindows().catch(() => {});
      }
    }, 0);
  },

  // O-27（2026-08-15）：全局错误兜底 —— 线上未捕获 JS 异常静默丢失的补救通道。
  // 复用 utils/monitor.js 的 wx.reportAnalytics 上报（devtools 下自动静默，不影响开发调试），
  // 部署后在 MP 后台「自定义分析」看 js_error / js_unhandled_rejection 事件量感知线上健康度。
  onError(msg) {
    require('./utils/monitor.js').report('js_error', { message: String(msg).slice(0, 200) });
  },
  onUnhandledRejection(res) {
    require('./utils/monitor.js').report('js_unhandled_rejection', {
      reason: String((res && res.reason) || '').slice(0, 200)
    });
  },
  onPageNotFound() {
    // 分享链接指向已下线页面（如已删除的 player-detail）时避免白屏，回退首页
    wx.switchTab({ url: '/pages/index/index' });
  },
  onMemoryWarning(res) {
    require('./utils/monitor.js').report('memory_warning', { level: (res && res.level) || 0 });
  }
});
