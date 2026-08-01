const follow = require('../../utils/follow.js');
const subscribe = require('../../utils/subscribe.js');
const config = require('../../utils/config.js');
const experiment = require('../../utils/experiment.js');
const reminderStrategy = require('../../utils/reminderStrategy.js');
const sources = require('../../utils/sources.js');

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
    // 空态「发现」按钮文案（按当前 Tab + A/B 实验动态生成）
    exploreText: '去发现战队'
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 3 });
    }
    // 合并 4 次 setData 为 1 次：ctaVariant + items/counts + subStatus + reminder
    // 收集所有字段后一次性 setData，减少 onShow 切回时的渲染开销
    const active = this.data.activeTab;
    const raw = follow.list(active);
    const all = raw.map((it) => this.decorate(it, active));
    this.allItems = all;
    const pageSize = this.data.pageSize;
    const slice = all.slice(0, pageSize);

    const st = subscribe.getSubStatus();
    const history = (subscribe.getSendHistory(10) || []).slice(0, 5);   // P3-3：JS 侧限 5 条，wxml 不再 wx:if
    const today = subscribe.getTodayCount();
    const reminder = reminderStrategy.getStrategy();
    const ctaVariant = experiment.getVariant('follow_cta_variant', 'A');

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
  },

  // refresh 保留给显式调用（如取消关注后），onShow 不再调用
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
      out.iconText = '';
      // 关注存储的是 OpenDota 原始名，展示层统一走 curation 规范名覆盖
      out.name = sources.leagueDisplayName(it);
      out.displayName = sources.leagueDisplayName(it);
      out.sub = '点击查看赛事详情';
      out.target = '/subpackages/detail/league-detail/league-detail?leagueId=' + it.id;
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
      wx.switchTab({ url: '/pages/teams/teams' });
    }
  },

  onSubscribe() {
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
