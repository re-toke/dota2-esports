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
// ★ 2026-10-12（P1-2 双出口）：开机「通道体检」——并发探候选中转宿主 /healthz 选可达出口。
const endpoints = require('./utils/endpoints.js');

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
    // 英雄 id -> 内部名（antimage/luna…），战报拼 Steam CDN 头像 URL 用；
    // 与 heroMap 同批填充，避免页面为拿内部名再拉一次 /heroes（2026-10-29 P0-2）
    heroInternalMap: {},
    heroReady: false,
    // 物品 id -> { name, img, dname } 映射，比赛详情页出装展示用
    itemMap: {},
    itemReady: false
  },

  onLaunch() {
    // ★ 2026-10-29（P0-1 启动网络预算）：t0 只发首屏关键 pro / live；
    //   其余非关键请求整体后移到 t+3s（见下方第二个 setTimeout），
    //   避免启动期 6–8 个请求（items 336KB / windows 25.5s）与首屏抢连接与带宽。
    // 2026-10-28（首页冷启动 P0）：pro/live 是首屏关键数据，必须在页面 onLoad 之前发出。
    //   这里只发起网络（异步、不解析），不违反「首屏前不做重活」；
    //   页面随后调用同一 action 时会命中 cloudProxy 的前台并发去重（action+载荷），不会重复请求。
    api.getProMatches().catch(() => {});
    api.getLiveMatches().catch(() => {});

    // ★ 2026-10-29（P0-1）：t0 只做**本地**工作 —— 清理过期缓存 / 幂等迁移，
    //   不产生任何网络请求（prune 已分片，不阻塞首帧）。
    setTimeout(() => {
      // §6.4 启动时清理过期/超限缓存（LRU prune），释放存储空间
      // ★ 2026-09-25：启动期改用**分片版** prune（原同步版会一次阻塞 ~900ms ✗）；
      //   写入路径（cache.set 内部）仍用同步 prune ✓ —— 那条路径依赖"返回时空间已腾出" ✓
      try { cache.pruneIdle(); } catch (e) {}
      // ★ 2026-08-11 方案 E：迁移老用户 fakeId 关注记录到真实 leagueId（一次性幂等）
      migrateFakeIdFollows();
    }, 0);

    // ★ 2026-10-29（P0-1 启动网络预算）：非关键预热整体后移到首帧之后（t+3s）。
    //   原实现与 pro/live 同时在 t0 发出：实测启动期 6–8 个请求，items 336KB（TTFB 105s）、
    //   windows 25.5s、leagues 67KB ⇒ 与首屏抢同一条出口带宽/连接。
    //   ⚠️ items **移出启动链路**：只在战报页按需加载（配合 P0-2 渐进渲染）。
    //   微信云开发已彻底退役（全库 0 处 wx.cloud.*）；config.cloudProxy.enabled
    //   仍作为「是否尝试走 EF」的开关，EF 可用性由 cloudProxy.efAvailable() 判定。
    setTimeout(() => {
      // ★ 2026-10-12（P1-2 开机通道体检）：并发探测候选中转宿主 /healthz，结果异步写回
      //   utils/endpoints.js 作为首选出口（不阻塞首屏、失败静默）。
      try { endpoints.probe(); } catch (e) {}
      // 远程 curation（若配置 url）后台静默加载，失败不阻塞
      remoteCuration.load();
      // 英雄表：一次填充 heroMap（中文名）+ heroInternalMap（拼头像 URL 的内部名）
      api.getHeroes()
        .then((list) => {
          const map = {};
          const internal = {};
          (list || []).forEach((h) => {
            if (!h || h.id == null) return;
            map[h.id] = h.localized_name;
            let n = h.name || '';
            if (n.indexOf('npc_dota_hero_') === 0) n = n.slice('npc_dota_hero_'.length);
            internal[h.id] = n;
          });
          this.globalData.heroMap = map;
          this.globalData.heroInternalMap = internal;
          this.globalData.heroReady = true;
        })
        .catch(() => {
          // 英雄表加载失败不阻塞主流程；战报页会按需重试并降级为文字
        });
      // T6 A/B 实验分组拉取（best-effort，失败回退本地 DEFAULTS，不阻塞启动）
      experiment.refresh().catch(() => {});
      // ★ 2026-08-07（R2）：账号预登录预热（fire-and-forget，失败静默；缓存命中后零请求）
      auth.ensureLogin().catch(() => {});
      // ★ 2026-09-03（加载优化 A）：赛事列表 + 时间窗口预取（5min 节流，失败静默）
      const _now = Date.now();
      if (
        config.cloudProxy && config.cloudProxy.enabled &&
        (!this._leaguesPrefetchedAt || (_now - this._leaguesPrefetchedAt) > 5 * 60 * 1000)
      ) {
        this._leaguesPrefetchedAt = _now;
        api.getLeagues().catch(() => {});
        api.getLeagueWindows().catch(() => {});
      }
    }, 3000);
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
