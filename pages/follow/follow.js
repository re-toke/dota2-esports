const follow = require('../../utils/follow.js');
// ★ 2026-09-21：队标本地化兜底（绕开 UGC 的 octet-stream MIME；见 utils/logoLocal.js）
const logoLocal = require('../../utils/logoLocal.js');
const subscribe = require('../../utils/subscribe.js');
const config = require('../../utils/config.js');
const experiment = require('../../utils/experiment.js');
const reminderStrategy = require('../../utils/reminderStrategy.js');
const sources = require('../../utils/sources.js');
// ★ 2026-08-07（审核 R1/R2）：账号登录态（ensureOpenId 上移单点实现 + 预登录前置）
const auth = require('../../utils/auth.js');
const diagnostics = require('../../utils/diagnostics.js');   // ★ P0-B 下半：数据健康展示
// ★ 2026-09-10（账号体系重构）：云同步开关状态（替代原「隐式自动上云」）
const cloudSync = require('../../utils/cloudSync.js');
// ★ 2026-09-14（极简改造）：数据管理 3 项 + 资料重置已下沉到 /subpackages/detail/settings
//   → 本页不再 require storageReset。

const TABS = [
  { key: 'teams', label: '战队' },
  { key: 'leagues', label: '赛事' }
];

const LABELS = { teams: '战队', leagues: '赛事' };

/** 相对时间文案（同步时间展示用） */
function formatLastSync(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return min + ' 分钟前';
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + ' 小时前';
  return Math.floor(hr / 24) + ' 天前';
}

Page({
  data: {
    // 分段标签带关注计数（原独立统计行已移除 —— 计数并入此处）
    tabs: TABS.map((t) => ({ key: t.key, label: t.label, count: 0 })),
    activeTab: 'teams',
    activeLabel: '战队',
    items: [],
    counts: { teams: 0, players: 0, leagues: 0 },
    page: 0,
    pageSize: config.pageSize,
    hasMore: false,
    loadingMore: false,
    ctaVariant: 'A',   // T6 A/B：关注页空态 CTA 文案分组
    // 2.2 订阅状态
    subStatus: null,   // { subscribed, time } | null
    subReady: false,   // 是否已配置模板
    // ★ P0-B 下半：数据健康（快照新鲜度 + 本机融合指标）—— 让"静默问题"可见
    health: null,
    // #20 智能提醒策略（提前量/级别的编辑入口已下沉到「设置」页；本页只读展示提前量）
    reminder: { leadSec: 1800, tiers: ['S', 'A'] },
    // ★ 批次4（2026-08-30）· PRD §11.2：用户卡身份升级为 chooseAvatar + 昵称 input，
    //   仅存本地 storage（无服务端账号体系）。openid 登录保留（订阅前置），不再驱动用户卡 UI。
    profile: { avatarUrl: '', nickname: '' },
    // ★ 2026-09-10（账号体系重构）：云同步四态（off/syncing/synced/failed）
    //   对外不叫「微信登录」—— 该概念已不存在（getUserInfo/getUserProfile 被回收，
    //   openid 只能静默获取、无授权界面），改叫「云同步」= 换设备可恢复关注与提醒。
    sync: { enabled: false, status: 'off', lastSyncText: '' },
    // ★ 2026-09-10（复核 A4）：隐私授权状态——未授权时 <input type="nickname"> 会
    //   降级为普通文本框（官方行为），用户会误以为「填不出微信昵称 = 坏了」
    privacyNeedAuth: false,
    // ★ 2026-09-14（极简改造）：sendLogExpanded / dailyLimit 随「推送记录」与「每日上限」文案一并移除。
    // 空态「发现」按钮文案（按当前 Tab + A/B 实验动态生成）
    exploreText: '去发现战队'
    // ★ 2026-09-14（极简改造）：appVersion 随「关于」区块下沉到设置页，本页不再需要。
  },

  onShow() {
    // 批次0（2026-08-30）：3-tab 后「我的」索引 3 → 2（首页0/赛事1/我的2）
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 2 });
    }
    // 合并 4 次 setData 为 1 次：ctaVariant + items/counts + subStatus + reminder
    // 收集所有字段后一次性 setData，减少 onShow 切回时的渲染开销
    const active = this.data.activeTab;
    const raw = follow.list(active);
    const all = raw.map((it) => this.decorate(it, active));
    this.allItems = all;
    const pageSize = this.data.pageSize;
    const slice = all.slice(0, pageSize);

    // ★ 2026-08-13（关注页头像区优化 · 1b）：老关注数据（无 logo）异步补全队标
    this._enrichFollowLogos(all);

    const st = subscribe.getSubStatus();
    const reminder = reminderStrategy.getStrategy();
    const ctaVariant = experiment.getVariant('follow_cta_variant', 'A');
    // ★ 2026-08-07（R2）：预登录预热 + 云端订阅态恢复（fire-and-forget，缓存命中零请求）
    auth.ensureLogin().catch(() => {});
    subscribe.restoreSubFromCloud().catch(() => {});
    // ★ 2026-09-10：刷新云同步状态（四态展示）
    this._refreshSyncState();
    // ★ 2026-09-10（复核 A4）：查询隐私授权状态（未授权时昵称填充会降级）
    this._checkPrivacy();
    // ★ 2026-09-10（复核修正）：已开启同步时自动恢复云端关注 ——
    //   补上这一步，「清本地缓存后云端数据会自动恢复」这句文案才成立（原方案前提不成立）
    if (cloudSync.isEnabled()) {
      subscribe.restoreFollowFromCloud().then((r) => {
        if (r && r.restored > 0) this.reload();
      }).catch(() => {});
    }

    const counts = follow.counts();
    // ★★ 2026-09-26（P0-B 下半）：**数据健康**（让指标与新鲜度"有人消费"）
    //   · 新鲜度：读本地快照 generatedAt，取**最旧**者（保守口径 —— 不被最新那个掩盖；
    //     实测两个快照刷新周期不同，差可达十余天）
    //   · 本机指标：首页融合后写入的最近一次快照（内存态；未访问首页/刚重启时为空 ⇒ 展示层须容忍）
    const _fresh = diagnostics.describeFreshness();
    const _last = diagnostics.getLast();
    const _lm = _last && _last.metrics;
    const _health = {
      ageText: _fresh.ageText,
      overTarget: _fresh.overTarget,
      targetHours: Math.round(_fresh.targetSec / 3600),
      oldestName: _fresh.oldest ? _fresh.oldest.name : '',
      items: _fresh.items,
      hasMetrics: !!_lm,
      metricHint: _lm
        ? ('降级率 ' + diagnostics.formatPct(_lm.heuristicRate) +
           ' · 结束无比分 ' + diagnostics.formatPct(_lm.endedNoScoreRate) +
           ' · 状态误判 ' + _lm.statusMismatch + ' · 样本 ' + _lm.total)
        : '打开一次「首页」后生成'
    };
    const patch = {
      health: _health,
      ctaVariant: ctaVariant,
      items: slice,
      counts: counts,
      // 分段标签带计数（原独立统计行已移除）
      tabs: [
        { key: 'teams', label: '战队', count: counts.teams || 0 },
        { key: 'leagues', label: '赛事', count: counts.leagues || 0 }
      ],
      activeLabel: LABELS[active],
      exploreText: active === 'leagues'
        ? (ctaVariant === 'B' ? '浏览热门赛事' : '去发现赛事')
        : (ctaVariant === 'B' ? '浏览热门战队' : '去发现战队'),
      page: 0,
      hasMore: all.length > slice.length,
      subStatus: st,
      subReady: !!subscribe.TMPL_ID,
      reminder: reminder
    };
    this.setData(patch);
    this.syncProfile();
    this._loadProfile();
  },

  // ★ 批次4 §11.2：chooseAvatar 回调——持久化到用户目录（临时路径重启失效），
  //   saveFile 失败（如磁盘满）时退回存临时路径（本次会话内仍可显示）。
  onChooseAvatar(e) {
    const url = e.detail && e.detail.avatarUrl;
    if (!url) return;
    try {
      const fs = wx.getFileSystemManager();
      const dest = wx.env.USER_DATA_PATH + '/user_avatar_' + Date.now() + '.png';
      fs.saveFile({
        tempFilePath: url,
        filePath: dest,
        success: () => this._saveProfile({ avatarUrl: dest }),
        fail: () => this._saveProfile({ avatarUrl: url })
      });
    } catch (err) {
      this._saveProfile({ avatarUrl: url });
    }
  },

  // ★ 批次4 §11.2：昵称 input（type=nickname）失焦保存。空值/未变化不写。
  onNicknameBlur(e) {
    const v = (e.detail.value || '').trim();
    if (!v || v === this.data.profile.nickname) return;
    this._saveProfile({ nickname: v });
  },

  // 读写本地 profile（key: user_profile）。clearCache 的 clearStorageSync 会一并清空，
  //   其后 onShow 重新 _loadProfile 回到默认态（龙首剪影 + 占位文案），符合预期。
  _loadProfile() {
    let p = null;
    try { p = wx.getStorageSync('user_profile'); } catch (e) { /* 忽略 */ }
    if (p && typeof p === 'object') {
      this.setData({ profile: { avatarUrl: p.avatarUrl || '', nickname: p.nickname || '' } });
    } else {
      this.setData({ profile: { avatarUrl: '', nickname: '' } });
    }
  },

  _saveProfile(patch) {
    const p = Object.assign({}, this.data.profile, patch);
    try { wx.setStorageSync('user_profile', p); } catch (e) { /* 忽略写失败 */ }
    this.setData({ profile: p });
  },

  // ★ 2026-09-14（极简改造）：推送记录与统计行已移除 → toggleSendLog / scrollToReminder 删除。

  // ★ 批次4 §11.1：提醒开关（已开启走取消，未开启走订阅）
  onToggleReminder() {
    if (this.data.subStatus && this.data.subStatus.subscribed) {
      this.onUnsubscribe();
    } else {
      this.onSubscribe();
    }
  },

  // ★ v11 系统配置：隐私与协议入口
  openPrivacy() {
    wx.navigateTo({ url: '/subpackages/detail/privacy/privacy' });
  },

  // ===== 设置入口（2026-09-14 极简改造） =====
  //   原「云同步内容明细 + 提醒策略 chips + 数据管理 3 项 + 关于 3 项」已全部下沉到设置二级页，
  //   本页只保留一个入口。合规上「删除云端数据」路径 = 我的 → 设置 → 数据管理（入口仍可达）。
  goSettings() {
    wx.navigateTo({ url: '/subpackages/detail/settings/settings' });
  },

  // ===== ★ A4：隐私授权状态 =====
  //   官方行为：隐私未授权时 <input type="nickname"> 会**降级为普通文本框**，
  //   用户点击后看不到「微信昵称一键填充」，会误以为是 bug → 需显式提示。
  _checkPrivacy() {
    if (typeof wx.getPrivacySetting !== 'function') return;
    wx.getPrivacySetting({
      success: (res) => {
        this.setData({ privacyNeedAuth: !!res.needAuthorization });
      },
      fail: () => {}
    });
  },

  /** 打开隐私协议（官方入口，未授权时用于完成同意） */
  onOpenPrivacyContract() {
    if (typeof wx.openPrivacyContract === 'function') {
      wx.openPrivacyContract({ fail: () => this.openPrivacy() });
    } else {
      this.openPrivacy();
    }
  },

  // refresh 保留给显式调用（如取消关注后），onShow 不再调用
  // （批次4：refreshUserInfo 已随 userInfo 登录态展示移除，改 _loadProfile 本地 profile）
  refresh() {
    const active = this.data.activeTab;
    const raw = follow.list(active);
    const all = raw.map((it) => this.decorate(it, active));
    this.allItems = all;
    const pageSize = this.data.pageSize;
    const slice = all.slice(0, pageSize);
    const counts = follow.counts();
    this.setData({
      items: slice,
      counts: counts,
      // 分段计数同步（取消关注后需立即反映）
      tabs: [
        { key: 'teams', label: '战队', count: counts.teams || 0 },
        { key: 'leagues', label: '赛事', count: counts.leagues || 0 }
      ],
      activeLabel: LABELS[active],
      exploreText: this.buildExploreText(active),
      page: 0,
      hasMore: all.length > slice.length
    });
    // ★ 2026-08-13（关注页头像区优化 · 1b）：老关注数据（无 logo）异步补全队标。
    //   放 refresh 而非仅 onShow：switchTab 切回战队 tab 也走 refresh，保证补全覆盖。
    this._enrichFollowLogos(all);
  },

  // ★ 2026-08-13（关注页头像区优化 · 1b）：对无 logo 的关注战队异步补全队标。
  //   sources.enrichTeamLogo 多源兜底（OpenDota → STRATZ → Liquipedia）+ logoCache
  //   缓存 + 负命中标记，失败静默（保持字母显示）。拿到后回写关注存储，下次进入零网络。
  //   ⚠️ 复核 P1-1 修正：更新渲染用「路径更新 items[idx].logo」而非整体重建数组——
  //   固定 slice(0, pageSize) 会把翻页用户（page>0）的列表重置回第一页。
  _enrichFollowLogos(items) {
    const need = items.filter((it) => it.type === 'teams' && !it.logo);
    if (!need.length) return;
    need.forEach((it) => {
      sources.enrichTeamLogo({ id: Number(it.id), name: it.name }).then((r) => {
        if (!r || !r.logo) return;
        // 回写关注存储（下次进入零网络直接有）
        const cur = follow.list('teams').find((x) => String(x.id) === String(it.id));
        if (cur) { cur.logo = r.logo; follow.follow('teams', cur); }
        // 增量更新当前渲染（allItems 与 items 索引对齐：items = allItems.slice(0, n)）
        const idx = this.allItems.findIndex((x) => x.type === 'teams' && String(x.id) === String(it.id));
        if (idx < 0) return;
        if (idx < (this.data.page + 1) * this.data.pageSize) {
          this.setData({ ['items[' + idx + '].logo']: r.logo });
        } else {
          this.allItems[idx].logo = r.logo;  // 未渲染到，只更新源数组
        }
      }).catch(() => {});
    });
  },

  // loadSubStatus 保留给显式调用（订阅状态变更后）；onShow 已合并其逻辑。
  // ★ 2026-09-14：loadReminder 已删除（策略编辑下沉到「设置」页）。

  onReachBottom() {
    if (this.data.hasMore && !this.data.loadingMore) this.appendPage();
  },

  appendPage() {
    if (!this.allItems || this.data.loadingMore || !this.data.hasMore) return;
    this.setData({ loadingMore: true });
    const pageSize = this.data.pageSize;
    const page = this.data.page + 1;
    const slice = this.allItems.slice(0, (page + 1) * pageSize);
    this.setData({
      items: slice,
      page: page,
      hasMore: this.allItems.length > slice.length,
      loadingMore: false
    });
  },

  decorate(it, type) {
    const out = Object.assign({}, it);
    out.type = type;
    if (type === 'teams') {
      out.typeLabel = '战队';
      out.iconText = (it.name || '?').slice(0, 1).toUpperCase();
      out.sub = '点击查看战队详情';
      out.target = '/subpackages/detail/team-detail/team-detail?teamId=' + it.id;
    } else {
      out.typeLabel = '赛事';
      // 关注存储的是 OpenDota 原始名，展示层统一走 curation 规范名覆盖
      out.name = sources.leagueDisplayName(it);
      out.displayName = sources.leagueDisplayName(it);
      // ★ 2026-08-13（关注页头像区优化 · 2b）：取消「★」收藏图标 → 显示赛事名首字母
      //   （与战队 tab 的字母风格统一）。注意需在 displayName 赋值之后计算。
      out.iconText = (out.displayName || out.name || '?').slice(0, 1).toUpperCase();
      out.sub = '点击查看赛事详情';
      // ★ 2026-08-11：跳转补传 name（encodeURIComponent）——详情页 onLoad 需要 name 做
      //   curation 名称匹配（重定向 + participants 数组取数）。此前只传 leagueId：
      //   关注记录若是老 fakeId（-1653808）时，name 缺失 → eventFor 无法按名匹配 →
      //   详情页不重定向 + 参赛队伍全「待定队伍 N」。
      out.target = '/subpackages/detail/league-detail/league-detail?leagueId=' + it.id +
        '&name=' + encodeURIComponent(out.displayName || out.name || '');
    }
    return out;
  },

  switchTab(e) {
    const key = e.currentTarget.dataset.key;
    if (key === this.data.activeTab) return;
    this.setData({ activeTab: key, items: [], page: 0, hasMore: false }, () => this.refresh());
  },

  // ★ 2026-09-21：队标加载失败 → 先尝试本地化兜底（downloadFile 绕开 UGC 的 octet-stream MIME），
  //   成功则换本地路径；失败才清空 logo → wxml 的 wx:elif 显示 iconText 首字母（原为破图）。
  //   与 _enrichFollowLogos 一致，用「路径更新 items[idx].logo」而非整体重建数组。
  onFollowLogoError(e) {
    const idx = Number((e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.idx));
    if (!Number.isFinite(idx)) return;
    const item = (this.data.items || [])[idx];
    const url = item && item.logo;
    logoLocal.localizeOnError(
      url,
      (localPath) => this.setData({ ['items[' + idx + '].logo']: localPath }),
      () => this.setData({ ['items[' + idx + '].logo']: '' })
    );
  },

  openItem(e) {
    const url = e.currentTarget.dataset.url;
    if (url) wx.navigateTo({ url: url });
  },

  removeItem(e) {
    const id = e.currentTarget.dataset.id;
    const type = this.data.activeTab;
    follow.unfollow(type, id);
    wx.showToast({ title: '已取消关注', icon: 'none' });
    this.refresh();
    if (type === 'teams') this.syncProfile();
  },

  // 空态「发现」CTA 文案：随当前 Tab + A/B 实验动态生成
  buildExploreText(active) {
    const label = LABELS[active] || '战队'; // 战队 / 选手 / 赛事
    return this.data.ctaVariant === 'B' ? ('浏览热门' + label) : ('去发现' + label);
  },

  // 空态「发现」CTA：按当前 Tab 跳到对应发现页。
  // 战队/选手 → teams 统一发现页（选手需预设 players 搜索模式）；赛事 → leagues 发现页。
  goExplore() {
    // T6 A/B：记录 CTA 点击转化
    experiment.track('follow_cta_variant', this.data.ctaVariant, 'click');
    const tab = this.data.activeTab;
    if (tab === 'leagues') {
      wx.switchTab({ url: '/pages/leagues/leagues' });
    } else {
      // 批次0（2026-08-30）：teams 已退出 tabBar，改 navigateTo
      wx.navigateTo({ url: '/pages/teams/teams' });
    }
  },

  onSubscribe() {
    // ★ 2026-08-07（R2 预登录前置，手势红线）：订阅授权必须用户点击手势内同步调用。
    //   openid 缓存命中（onShow/app onLaunch 已预热）→ 直接弹（手势内）；
    //   未命中（首次弱网）→ toast 引导 + 后台补登录，绝不在网络回调后弹授权（会被微信手势校验拒绝）。
    // ★★ P0-4（2026-09-10 账号体系重构）：**服务端推送必须上云** ——
    //   所以这里就是「云同步」最自然的开启时机（用户想要提醒 → 提醒本就依赖云端），
    //   不需要凭空弹一个「要不要开启同步」的框。同时符合微信「不得强制授权」规范：
    //   拒绝开启只是不能推送，浏览/关注等全部功能照常。
    if (!cloudSync.isEnabled()) {
      wx.showModal({
        title: '赛事提醒需要云同步',
        content: '开赛提醒由服务端推送，需要把你的关注战队同步到云端（可在「我的」随时关闭并删除）。是否开启？',
        confirmText: '开启同步',
        cancelText: '暂不开启',
        success: (r) => {
          if (!r.confirm) return;
          this._enableSync();
          wx.showToast({ title: '开启后请再次点击提醒开关', icon: 'none' });
        }
      });
      return;
    }

    if (!auth.isLoggedIn()) {
      wx.showToast({ title: '正在登录…请稍后重试', icon: 'none' });
      // ★ 2026-09-10（真机登录问题）：补失败分支——此前登录失败会**静默回到同一状态**，
      //   用户反复点击只看到同一句 toast，无法区分「首次预热」与「登录链路挂了」。
      auth.ensureLogin().then((oid) => {
        if (!oid) {
          wx.showToast({ title: '登录失败，请检查网络后重试', icon: 'none' });
        }
      }).catch(() => {
        wx.showToast({ title: '登录失败，请检查网络后重试', icon: 'none' });
      });
      return;
    }
    subscribe.requestSubscribe({ force: true }).then((r) => {
      if (r === 'skipped') {
        wx.showToast({ title: '未配置订阅模板', icon: 'none' });
      } else if (r === 'accept') {
        wx.showToast({ title: '已开启赛事提醒', icon: 'success' });
        this.loadSubStatus(); // 刷新状态
      } else if (r === 'ban') {
        wx.showToast({ title: '已在设置中屏蔽订阅消息', icon: 'none' });
      } else {
        wx.showToast({ title: '已取消', icon: 'none' });
      }
      this.loadSubStatus();
    });
  },

  // ★ 2026-08-15：取消比赛开始提醒（补全功能按键）。
  //   微信订阅是「一次性授权」无法编程式取消，取消 = 清本地 subscribed + 同步云端 subs，
  //   服务端（sendSmartReminders）据此停止推送。加确认弹窗防误触。
  onUnsubscribe() {
    wx.showModal({
      title: '取消赛事提醒',
      content: '取消后将不再收到关注的战队赛前提醒，确定取消吗？',
      confirmText: '取消提醒',
      confirmColor: '#e64340',
      success: (res) => {
        if (!res.confirm) return;
        subscribe.unsubscribe().then((r) => {
          wx.showToast({
            title: r && r.ok ? '已取消赛事提醒' : '已在本机取消',
            icon: 'none'
          });
          this.loadSubStatus();
        });
      }
    });
  },

  // ===== 2.2 订阅状态展示 =====
  loadSubStatus() {
    this.setData({
      subStatus: subscribe.getSubStatus(),
      subReady: !!subscribe.TMPL_ID
    });
  },

  // ===== #20 智能提醒策略 =====
  // ★ 2026-09-14（极简改造）：提前量/级别的编辑入口（chips）已下沉到「设置」页
  //   （/subpackages/detail/settings）。本页只读展示 leadSec；策略变更由设置页负责
  //   即时上传，本页 onShow 的 syncProfile 作为兜底再次对齐。

  // 把关注战队 + 策略上传云端（#20 服务端策略引擎数据层）
  syncProfile() {
    // ★ 2026-09-10（账号体系重构 · P0-2）：未开启云同步时**零请求**直接返回。
    //   守卫同时存在于 subscribe.saveFollowProfile（双保险，防其他调用点漏改）。
    if (!cloudSync.isEnabled()) return;
    const teams = follow.list('teams') || [];
    const teamIds = teams.map((t) => String(t.id));
    // teamItems：云端额外存对象（含队名/队标），供「换机恢复关注」用 —— 仅凭 ID 恢复会没队名
    const teamItems = teams.map((t) => ({ id: t.id, name: t.name, logo: t.logo }));
    subscribe.saveFollowProfile(teamIds, this.data.reminder, undefined, teamItems)
      .then(() => this._refreshSyncState())
      .catch(() => this._refreshSyncState());
  },

  // ===== ★ 2026-09-10（账号体系重构）：云同步开关 =====
  //   把原来「隐式自动上云」改为「显式开关 + 四态可见 + 可撤回」。
  //   对外不叫「微信登录」（该概念已不存在：getUserInfo/getUserProfile 被回收，
  //   openid 只能静默获取），而叫「云同步」，价值主张 = 换设备可恢复关注与提醒。

  /** 读同步状态写入 data（UI 渲染用） */
  _refreshSyncState() {
    const s = cloudSync.getState();
    this.setData({
      sync: {
        enabled: s.enabled,
        status: s.status,
        lastSyncText: formatLastSync(s.lastSyncAt)
      }
    });
  },

  /** 开关切换 */
  onSyncToggle() {
    const s = cloudSync.getState();
    if (s.status === 'syncing') return;                  // 进行中防重
    if (!s.enabled) return this._enableSync();

    wx.showModal({
      title: '关闭云同步',
      // ★ B9′（复核修正）：如实说明影响范围 —— 影响的是**恢复能力**，不是推送本身。
      //   原方案误判为「推送会失效」（实际推送走客户端触发链路，不依赖云端 profile）。
      content: '将删除云端保存的关注与提醒数据。本机的关注与提醒**不受影响**，但换设备或清缓存后无法自动恢复。',
      confirmText: '关闭并删除',
      confirmColor: '#E8443B',
      success: (r) => {
        if (!r.confirm) return;
        this.setData({ 'sync.status': 'syncing' });
        cloudSync.disable().then((res) => {
          this._refreshSyncState();
          if (res.ok) {
            wx.showToast({ title: '已关闭并删除云端数据', icon: 'success' });
          } else {
            // ★ 不得报假成功：明确告知「云端数据可能仍在」
            wx.showModal({
              title: '云端数据未能删除',
              content: '已停止同步，但云端数据删除失败（可能是网络问题）。可稍后点「删除云端数据」重试。',
              showCancel: false,
              confirmText: '知道了'
            });
          }
        });
      }
    });
  },

  /** 开启同步：登录 → 全量上传 → 尝试恢复云端关注 */
  _enableSync() {
    this.setData({ 'sync.status': 'syncing' });
    cloudSync.enable().then((r) => {
      if (!r.ok) {
        this._refreshSyncState();
        wx.showToast({ title: '开启失败，请检查网络后重试', icon: 'none' });
        return;
      }
      // ① 先把本地现状推上去（含队名/队标）
      const teams = follow.list('teams') || [];
      const teamIds = teams.map((t) => String(t.id));
      const teamItems = teams.map((t) => ({ id: t.id, name: t.name, logo: t.logo }));
      subscribe.saveFollowProfile(teamIds, this.data.reminder, undefined, teamItems)
        .then(() => {
          // ② 再把云端已有的关注并回本地（换机场景：本地为空 → 等价全量恢复）
          return subscribe.restoreFollowFromCloud();
        })
        .then((res) => {
          this._refreshSyncState();
          this.reload();
          if (res && res.restored > 0) {
            wx.showToast({ title: '已同步，恢复 ' + res.restored + ' 个关注', icon: 'none' });
          } else {
            wx.showToast({ title: '云同步已开启', icon: 'success' });
          }
        })
        .catch(() => {
          this._refreshSyncState();
          wx.showToast({ title: '已开启，首次同步稍后重试', icon: 'none' });
        });
    });
  },

  /** 同步失败时点击重试 */
  onSyncRetry() {
    if (cloudSync.getState().enabled) this.syncProfile();
    else this._enableSync();
  },
});
