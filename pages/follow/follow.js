const follow = require('../../utils/follow.js');
const subscribe = require('../../utils/subscribe.js');
const config = require('../../utils/config.js');
const experiment = require('../../utils/experiment.js');
const reminderStrategy = require('../../utils/reminderStrategy.js');
const sources = require('../../utils/sources.js');
// ★ 2026-08-07（审核 R1/R2）：账号登录态（ensureOpenId 上移单点实现 + 预登录前置）
const auth = require('../../utils/auth.js');

const TABS = [
  { key: 'teams', label: '战队' },
  { key: 'leagues', label: '赛事' }
];

const LABELS = { teams: '战队', leagues: '赛事' };

Page({
  data: {
    tabs: TABS,
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
    tmplTitle: subscribe.TEMPLATE_TITLE || '',
    sendHistory: [],   // 最近发送记录
    todayCount: 0,      // 今日发送次数
    // #20 智能提醒策略
    reminder: { leadSec: 1800, tiers: ['S', 'A'] },
    leadOptions: reminderStrategy.LEAD_OPTIONS,
    // tierOptions 在 applyReminder 中按 reminder.tiers 预计算 selected 标记（避免 WXML 内调用
    // Array.indexOf 在 setData 新 reminder 对象后不重算的坑，导致「提醒级别」无法选中）
    tierOptions: reminderStrategy.TIER_OPTIONS.map((t) => ({
      grade: t.grade, label: t.label, selected: ['S', 'A'].indexOf(t.grade) >= 0
    })),
    // ★ 批次4（2026-08-30）· PRD §11.2：用户卡身份升级为 chooseAvatar + 昵称 input，
    //   仅存本地 storage（无服务端账号体系）。openid 登录保留（订阅前置），不再驱动用户卡 UI。
    profile: { avatarUrl: '', nickname: '' },
    // ★ 批次4 §11.1：推送记录默认折叠（sendLogExpanded）
    sendLogExpanded: false,
    // 每日推送上限（O2/V1：subscribe.js DAILY_LIMIT 未导出，WXML 无法访问模块对象，故硬编码）
    dailyLimit: 5,
    // 空态「发现」按钮文案（按当前 Tab + A/B 实验动态生成）
    exploreText: '去发现战队',
    // v11 系统配置：关于我们版本号
    appVersion: '1.1.0'
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
    const history = (subscribe.getSendHistory(10) || []).slice(0, 5);   // P3-3：JS 侧限 5 条，wxml 不再 wx:if
    const today = subscribe.getTodayCount();
    const reminder = reminderStrategy.getStrategy();
    const ctaVariant = experiment.getVariant('follow_cta_variant', 'A');
    // ★ 2026-08-07（R2）：预登录预热 + 云端订阅态恢复（fire-and-forget，缓存命中零请求）
    auth.ensureLogin().catch(() => {});
    subscribe.restoreSubFromCloud().catch(() => {});

    const patch = {
      ctaVariant: ctaVariant,
      items: slice,
      counts: follow.counts(),
      activeLabel: LABELS[active],
      exploreText: active === 'leagues'
        ? (ctaVariant === 'B' ? '浏览热门赛事' : '去发现赛事')
        : (ctaVariant === 'B' ? '浏览热门战队' : '去发现战队'),
      page: 0,
      hasMore: all.length > slice.length,
      subStatus: st,
      subReady: !!subscribe.TMPL_ID,
      sendHistory: (history || []).map((h) => Object.assign({}, h, { leagueName: sources.leagueDisplayName(h.leagueName || ''), displayName: sources.leagueDisplayName(h.leagueName || '') })),
      todayCount: today,
      reminder: reminder,
      tierOptions: reminderStrategy.TIER_OPTIONS.map((t) => ({
        grade: t.grade,
        label: t.label,
        selected: (reminder.tiers || []).indexOf(t.grade) >= 0
      }))
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

  // ★ 批次4 §11.1：推送记录折叠/展开
  toggleSendLog() {
    this.setData({ sendLogExpanded: !this.data.sendLogExpanded });
  },

  // ★ 批次4 §11.3：统计行第三格点击 → 滚动至段三「赛前提醒」卡
  scrollToReminder() {
    wx.pageScrollTo({ selector: '#sec-reminder', duration: 300 });
  },

  // ★ 批次4 §11.1：合并卡开关（卡头 pill）——已开启走取消（含确认弹窗），未开启走订阅
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

  // ★ v11 系统配置：清除本地缓存
  clearCache() {
    wx.showModal({
      title: '确认清空本地数据？',
      content: '此操作不可撤销，将清除关注列表、缓存数据与登录态。',
      confirmText: '清空',
      confirmColor: '#e8443b',
      success: (res) => {
        if (!res.confirm) return;
        try {
          wx.clearStorageSync();
          this.onShow();
          wx.showToast({ title: '已清空', icon: 'success' });
        } catch (e) {
          wx.showToast({ title: '清空失败', icon: 'none' });
        }
      }
    });
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
    this.setData({
      items: slice,
      counts: follow.counts(),
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

  // loadSubStatus / loadReminder 保留给显式调用（订阅状态变更后）
  // onShow 已合并其逻辑，不再单独调用

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
    if (!auth.isLoggedIn()) {
      wx.showToast({ title: '正在登录…请稍后重试', icon: 'none' });
      auth.ensureLogin().catch(() => {});
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
    var st = subscribe.getSubStatus();
    var history = (subscribe.getSendHistory(10) || []).slice(0, 5);   // P3-3：JS 侧限 5 条，wxml 不再 wx:if
    var today = subscribe.getTodayCount();
    this.setData({
      subStatus: st,
      subReady: !!subscribe.TMPL_ID,
      sendHistory: (history || []).map((h) => Object.assign({}, h, { leagueName: sources.leagueDisplayName(h.leagueName || ''), displayName: sources.leagueDisplayName(h.leagueName || '') })),
      todayCount: today
    });
  },

  // ===== #20 智能提醒策略 =====
  // 应用策略并同步「提醒级别」选项选中态：在 JS 侧预计算 selected（item.selected），
  // 避免 WXML 内 reminder.tiers.indexOf(item.grade) 在 setData 新 reminder 对象后不重算，
  // 表现为「提醒级别」选项点不动。tierOptions 引用变更也会强制 wx:for 重渲染。
  applyReminder(reminder) {
    this.setData({
      reminder,
      tierOptions: reminderStrategy.TIER_OPTIONS.map((t) => ({
        grade: t.grade,
        label: t.label,
        selected: (reminder.tiers || []).indexOf(t.grade) >= 0
      }))
    });
  },

  loadReminder() {
    this.applyReminder(reminderStrategy.getStrategy());
    this.syncProfile();
  },

  // 切换提前量
  onLeadChange(e) {
    const sec = Number(e.currentTarget.dataset.sec);
    const s = reminderStrategy.setStrategy(Object.assign({}, this.data.reminder, { leadSec: sec }));
    this.setData({ reminder: s });
    this.syncProfile();
  },

  // 切换分级开关（多选）
  onTierToggle(e) {
    const grade = e.currentTarget.dataset.grade;
    if (!grade) return;
    const cur = this.data.reminder.tiers.slice();
    const idx = cur.indexOf(grade);
    if (idx >= 0) cur.splice(idx, 1); else cur.push(grade);
    if (!cur.length) cur.push(grade); // 至少保留一个
    const s = reminderStrategy.setStrategy(Object.assign({}, this.data.reminder, { tiers: cur }));
    this.applyReminder(s);
    this.syncProfile();
  },

  // 把关注战队 + 策略上传云端（#20 服务端策略引擎数据层）
  syncProfile() {
    const teamIds = (follow.list('teams') || []).map((t) => String(t.id));
    subscribe.saveFollowProfile(teamIds, this.data.reminder).catch(() => {});
  },
});
