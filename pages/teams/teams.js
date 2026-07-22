const api = require('../../utils/api.js');
const follow = require('../../utils/follow.js');
const config = require('../../utils/config.js');
const util = require('../../utils/util.js');
const sources = require('../../utils/sources.js');
const searchHistory = require('../../utils/searchHistory.js');

// 关注的顶级战队预设（team_id 来自 OpenDota）
const HOT_TEAMS = [
  { team_id: 15, name: 'LGD Gaming', tag: 'LGD' },
  { team_id: 7119388, name: 'Team Spirit', tag: 'TS' },
  { team_id: 36, name: 'Natus Vincere', tag: 'NAVI' },
  { team_id: 1838312, name: 'OG', tag: 'OG' },
  { team_id: 2163, name: 'Team Secret', tag: 'SEC' },
  { team_id: 1375614, name: 'Fnatic', tag: 'FNC' },
  { team_id: 8336801, name: 'Tundra Esports', tag: 'TUN' },
  { team_id: 7090336, name: 'Gaimin Gladiators', tag: 'GG' },
  { team_id: 1369577, name: 'Evil Geniuses', tag: 'EG' },
  { team_id: 2506989, name: 'PSG.LGD', tag: 'PSG' }
];

// 来源 key -> 中文标签
const SOURCE_BADGES = {
  opendota: 'OpenDota',
  stratz: 'STRATZ',
  steam: 'Steam',
  liquipedia: 'Liquipedia',
  curation: '本地策展',
  community: '社区规则'
};

// 把 api.getTeam 原始数据合并进展示用的卡片对象
// 保留 followed 状态；新增 logo / country / rating / wins / losses / winRate / lastMatchLabel
function enrichItem(item, t) {
  if (!t) return item;
  const wins = t.wins || 0;
  const losses = t.losses || 0;
  const total = wins + losses;
  const wr = total ? Math.round((wins / total) * 100) : 0;
  const wrClass = wr >= 60 ? 'wr-high' : (wr >= 40 ? 'wr-mid' : 'wr-low');
  const last = t.last_match_time ? util.formatAgo(t.last_match_time * 1000) : '';
  return Object.assign({}, item, {
    logo: t.logo_url || item.logo || '',
    country: t.country_code || item.country || '',
    rating: t.rating || 0,
    wins: wins,
    losses: losses,
    winRate: wr,
    winRateClass: wrClass,
    lastMatchTime: t.last_match_time || 0,
    lastMatchLabel: last,
    hasStats: !!(t.rating || total),
    sourceKey: 'opendota',
    sourceLabel: SOURCE_BADGES.opendota
  });
}

// 二次增强（curation + Steam）：补全 logo / 国家 / 规范名
function applyExtra(item, info) {
  if (!info) return item;
  const next = Object.assign({}, item);
  if (info.logo && /^https?:\/\//i.test(info.logo)) next.logo = info.logo;
  if (info.country) next.country = info.country;
  if (info.name && info.name !== item.name) {
    // 仅当本地策展/Steam 提供了规范名且与原名不同时覆盖
    next.name = info.name;
  }
  if (info.source) {
    next.sourceKey = info.source;
    next.sourceLabel = SOURCE_BADGES[info.source] || info.source;
  }
  return next;
}

Page({
  data: {
    keyword: '',
    mode: 'hot',          // hot | result
    hot: [],
    results: [],
    loading: false,
    loadingMore: false,
    hasMore: false,
    page: 0,
    pageSize: config.pageSize,
    searched: false,
    error: '',
    history: [],
    hotEnriching: false,      // 热门队伍异步补全中
    resultEnriching: false    // 搜索结果异步补全中
  },

  onLoad() {
    this.setData({
      hot: HOT_TEAMS.map((t) => Object.assign({}, t, {
        id: t.team_id,
        followed: follow.isFollowed('teams', t.team_id)
      })),
      history: searchHistory.get('teams')
    });
    // 异步补全：每个热门队伍并行拉取详情（logo/rating/wins/losses/country/last_match_time）
    this.enrichHot();
  },

  // 批量补全热门队伍详情：并行调用 api.getTeam，逐个更新（避免阻塞首屏）。
  // 任一失败被隔离，不影响其它队伍或页面渲染。
  enrichHot() {
    this.setData({ hotEnriching: true });
    const list = this.data.hot.slice();
    const tasks = list.map((item) => {
      return api.getTeam(item.id)
        .then((t) => {
          const merged = enrichItem(item, t);
          // 二次增强：curation + Steam 补 logo / 国家
          return sources.enrichTeamInfo({ id: item.id, name: item.name })
            .then((info) => applyExtra(merged, info))
            .catch(() => merged);
        })
        .catch(() => item); // 隔离错误，保持原样
    });
    Promise.all(tasks).then((enriched) => {
      this.setData({ hot: enriched, hotEnriching: false });
    });
  },

  // 批量补全搜索结果：仅对当前已展示的 slice 进行（避免对未展示项的无谓请求）
  enrichResults() {
    const list = this.data.results.slice();
    if (!list.length) return;
    this.setData({ resultEnriching: true });
    const tasks = list.map((item) => {
      return api.getTeam(item.id)
        .then((t) => enrichItem(item, t))
        .catch(() => item);
    });
    Promise.all(tasks).then((enriched) => {
      // 注意：合并进 allResults，避免 appendPage 时丢失已增强的字段
      if (this.allResults) {
        const map = {};
        enriched.forEach((it) => { map[it.id] = it; });
        this.allResults = this.allResults.map((it) => map[it.id] || it);
      }
      this.setData({ results: enriched, resultEnriching: false });
    });
  },

  onPullDownRefresh() {
    if (this.data.mode === 'result') {
      this.onRetry();
    } else {
      // 热门模式：重新拉一次详情刷新数据
      this.enrichHot();
      wx.stopPullDownRefresh();
    }
  },

  onRetry() {
    this.setData({ error: '', loading: true });
    const kw = (this.data.keyword || '').trim();
    if (!kw) { wx.stopPullDownRefresh(); return; }
    this.runSearch(kw).then(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    if (this.data.mode === 'result' && this.data.hasMore && !this.data.loading && !this.data.loadingMore) {
      this.appendPage();
    }
  },

  // 输入实时回调（t-search bind:change）：仅更新关键词，并防抖 400ms 后再真正请求，
  // 避免逐字触发 OpenDota /search（节省配额、减少无效请求）。
  onSearch(e) {
    const kw = (e.detail.value || '').trim();
    this.setData({ keyword: kw });
    if (this._searchTimer) { clearTimeout(this._searchTimer); this._searchTimer = null; }
    if (!kw) {
      this.allResults = [];
      this.setData({ mode: 'hot', results: [], searched: false, error: '', hasMore: false, page: 0, history: searchHistory.get('teams') });
      return;
    }
    this._searchTimer = setTimeout(() => {
      this._searchTimer = null;
      this.runSearch(kw);
    }, 400);
  },

  // 真正的搜索请求（防抖到期 / 点击历史 / 重试 时直接调用）。
  runSearch(kw) {
    this.setData({ mode: 'result', loading: true, searched: true, error: '' });
    return api.searchTeams(kw)
      .then((list) => {
        const all = (list || []).map((t) => ({
          id: t.team_id,
          name: t.name,
          tag: (t.name || '').slice(0, 3).toUpperCase(),
          followed: follow.isFollowed('teams', t.team_id)
        }));
        this.allResults = all;
        const pageSize = this.data.pageSize;
        const slice = all.slice(0, pageSize);
        // 仅成功返回才写入历史（无效词不污染历史）
        const history = searchHistory.add('teams', kw);
        this.setData({
          results: slice,
          loading: false,
          page: 0,
          hasMore: all.length > slice.length,
          history: history
        });
        // 异步补全搜索结果的详情字段
        this.enrichResults();
      })
      .catch(() => {
        this.allResults = [];
        this.setData({ results: [], loading: false, error: '搜索失败，请检查网络或域名配置', hasMore: false, page: 0 });
      });
  },

  // 点击历史关键词：回填输入框并立即搜索（会把该词置顶）。
  onTapHistory(e) {
    const kw = e.currentTarget.dataset.kw;
    if (!kw) return;
    this.setData({ keyword: kw });
    this.runSearch(kw);
  },

  // 清空历史。
  onClearHistory() {
    this.setData({ history: searchHistory.clear('teams') });
  },

  // 搜索框清除按钮（bind:clear）：回到热门列表并展示历史。
  onClear() {
    this.allResults = [];
    if (this._searchTimer) { clearTimeout(this._searchTimer); this._searchTimer = null; }
    this.setData({ keyword: '', mode: 'hot', results: [], searched: false, error: '', hasMore: false, page: 0, history: searchHistory.get('teams') });
  },

  appendPage() {
    if (!this.allResults || this.data.loadingMore || !this.data.hasMore) return;
    this.setData({ loadingMore: true });
    const pageSize = this.data.pageSize;
    const page = this.data.page + 1;
    const slice = this.allResults.slice(0, (page + 1) * pageSize);
    this.setData({
      results: slice,
      page: page,
      hasMore: this.allResults.length > slice.length,
      loadingMore: false
    });
    // 对新加载的项也异步补全（仅对未增强过的）
    this.enrichResults();
  },

  toggleFollow(e) {
    const id = e.currentTarget.dataset.id;
    const name = e.currentTarget.dataset.name;
    const followed = follow.toggle('teams', { id: id, name: name });
    const upd = (arr) => arr.map((t) => t.id === id ? Object.assign({}, t, { followed: followed }) : t);
    if (this.data.mode === 'hot') this.setData({ hot: upd(this.data.hot) });
    else this.setData({ results: upd(this.data.results) });
    wx.showToast({ title: followed ? '已关注' : '已取消关注', icon: 'none' });
  },

  openTeam(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: '/pages/team-detail/team-detail?teamId=' + id });
  }
});
