const follow = require('../../utils/follow.js');
const subscribe = require('../../utils/subscribe.js');
const config = require('../../utils/config.js');

const TABS = [
  { key: 'teams', label: '战队' },
  { key: 'players', label: '选手' },
  { key: 'leagues', label: '赛事' }
];

const LABELS = { teams: '战队', players: '选手', leagues: '赛事' };

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
    loadingMore: false
  },

  onShow() {
    this.refresh();
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loadingMore) this.appendPage();
  },

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
      page: 0,
      hasMore: all.length > slice.length
    });
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
      out.target = '/pages/team-detail/team-detail?teamId=' + it.id;
    } else if (type === 'players') {
      out.typeLabel = '选手';
      out.iconText = (it.name || '?').slice(0, 1).toUpperCase();
      out.sub = '点击查看选手详情';
      out.target = '/pages/player-detail/player-detail?accountId=' + it.id;
    } else {
      out.typeLabel = '赛事';
      out.iconText = '';
      out.sub = '点击查看赛事详情';
      out.target = '/pages/league-detail/league-detail?leagueId=' + it.id;
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
  },

  onSubscribe() {
    subscribe.requestSubscribe().then((r) => {
      if (r === 'skipped') {
        wx.showToast({ title: '未配置订阅模板', icon: 'none' });
      } else {
        wx.showToast({ title: '已开启赛事提醒', icon: 'success' });
      }
    });
  }
});
