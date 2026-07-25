const api = require('../../utils/api.js');
const follow = require('../../utils/follow.js');
const config = require('../../utils/config.js');
const util = require('../../utils/util.js');
const sources = require('../../utils/sources.js');
const searchHistory = require('../../utils/searchHistory.js');

// 跨页状态持久化键（I5）：离开页面时保存搜索类型/关键词/滚动位置，返回时还原
const VIEW_KEY = 'teams_view_state';

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

// 热门搜索推荐词（点击直接搜索）
const HOT_KEYWORDS = ['LGD', 'Spirit', 'OG', 'NAVI', 'Secret', 'Tundra', 'TI', 'Major'];

// 来源 key -> 中文标签
const SOURCE_BADGES = {
  opendota: 'OpenDota',
  stratz: 'STRATZ',
  steam: 'Steam',
  liquipedia: 'Liquipedia',
  curation: '本地策展',
  community: '社区规则'
};

// 编辑距离（Levenshtein），用于搜索纠错建议
function editDistance(a, b) {
  a = (a || '').toLowerCase();
  b = (b || '').toLowerCase();
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  const dp = Array.from({ length: m + 1 }, (_, i) => { const r = [i]; return r; });
  for (let j = 1; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

// 当搜索无结果时，从已知词（热门战队名/标签 + 历史）中找出编辑距离 ≤2 的近似词作为纠错建议。
function buildSuggestion(kw, isPlayer) {
  const k = (kw || '').trim().toLowerCase();
  if (k.length < 2) return '';
  let candidates = [];
  if (isPlayer) {
    candidates = (searchHistory.get('players') || []).slice();
  } else {
    HOT_TEAMS.forEach((t) => { candidates.push(t.name); if (t.tag) candidates.push(t.tag); });
    (searchHistory.get('teams') || []).forEach((h) => candidates.push(h));
  }
  const seen = {};
  const uniq = [];
  candidates.forEach((c) => {
    const lc = (c || '').toLowerCase();
    if (lc && !seen[lc]) { seen[lc] = true; uniq.push(c); }
  });
  let best = '';
  let bestD = 99;
  uniq.forEach((c) => {
    const d = editDistance(k, c);
    if (d > 0 && d <= 2 && d < bestD) { best = c; bestD = d; }
  });
  return best;
}

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
    searchType: 'teams',  // teams | players（搜索类型切换）
    hot: [],
    results: [],
    playerResults: [],    // 选手搜索结果
    loading: false,
    loadingMore: false,
    hasMore: false,
    page: 0,
    pageSize: config.pageSize,
    searched: false,
    error: '',
    history: [],
    hotWords: HOT_KEYWORDS,   // 热门搜索推荐词（点击直接搜）
    suggestion: '',           // 搜索无结果时的纠错建议
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

  // I5：记录页面滚动位置（不写 setData，避免滚动时频繁刷新）
  onPageScroll(e) {
    this._scrollTop = e.scrollTop;
  },

  // I5：离开页面时持久化视图状态
  onHide() {
    try {
      wx.setStorageSync(VIEW_KEY, {
        scrollTop: this._scrollTop || 0,
        keyword: this.data.keyword,
        searchType: this.data.searchType
      });
    } catch (e) { /* 忽略存储异常 */ }
  },

  // I5：返回页面时还原视图状态（首次 onShow 跳过，避免覆盖 onLoad 的初始数据）
  onShow() {
    if (this._restored) {
      let saved = null;
      try { saved = wx.getStorageSync(VIEW_KEY) || null; } catch (e) { saved = null; }
      if (saved) {
        const kw = saved.keyword || '';
        const type = saved.searchType || 'teams';
        this.setData({ searchType: type, keyword: kw });
        if (kw) {
          if (this.allResults && this.allResults.length) {
            const pageSize = this.data.pageSize;
            const slice = this.allResults.slice(0, pageSize);
            const patch = { mode: 'result', searched: true, hasMore: this.allResults.length > slice.length, page: 0 };
            if (type === 'players') patch.playerResults = slice; else patch.results = slice;
            this.setData(patch);
            if (type !== 'players') this.enrichResults();
          } else {
            this.runSearch(kw);
          }
        } else {
          this.setData({ mode: 'hot', results: [], playerResults: [], searched: false, hasMore: false, page: 0 });
        }
        const top = saved.scrollTop || 0;
        if (top > 0) setTimeout(() => { wx.pageScrollTo({ scrollTop: top, duration: 0 }); }, 60);
      }
    }
    this._restored = true;
  },

  // 输入实时回调（t-search bind:change）：仅更新关键词，并防抖 400ms 后再真正请求，
  // 避免逐字触发 OpenDota /search（节省配额、减少无效请求）。
  onSearch(e) {
    const kw = (e.detail.value || '').trim();
    this.setData({ keyword: kw });
    if (this._searchTimer) { clearTimeout(this._searchTimer); this._searchTimer = null; }
    if (!kw) {
      this.allResults = [];
      this.setData({ mode: 'hot', results: [], searched: false, error: '', hasMore: false, page: 0, history: searchHistory.get('teams'), suggestion: '' });
      return;
    }
    this._searchTimer = setTimeout(() => {
      this._searchTimer = null;
      this.runSearch(kw);
    }, 400);
  },

  // 真正的搜索请求（防抖到期 / 点击历史 / 重试 时直接调用）。
  runSearch(kw) {
    const isPlayer = this.data.searchType === 'players';
    this.setData({ mode: 'result', loading: true, searched: true, error: '' });
    const doSearch = isPlayer ? api.searchPlayers(kw) : api.searchTeams(kw);
    return doSearch
      .then((list) => {
        const historyType = isPlayer ? 'players' : 'teams';
        const all = (list || []).map((t) => {
          if (isPlayer) {
            return {
              id: t.account_id,
              name: t.name || ('ID:' + t.account_id),
              followed: follow.isFollowed('players', t.account_id),
              isPlayer: true
            };
          }
          return {
            id: t.team_id,
            name: t.name,
            tag: (t.name || '').slice(0, 3).toUpperCase(),
            followed: follow.isFollowed('teams', t.team_id),
            isPlayer: false
          };
        });
        this.allResults = all;
        const pageSize = this.data.pageSize;
        const slice = all.slice(0, pageSize);
        // 仅成功返回才写入历史
        const history = searchHistory.add(historyType, kw);
        // 无结果时计算纠错建议（编辑距离 ≤2）
        const suggestion = slice.length === 0 ? buildSuggestion(kw, isPlayer) : '';
        const patch = {
          loading: false,
          page: 0,
          hasMore: all.length > slice.length,
          history: history,
          suggestion: suggestion
        };
        if (isPlayer) {
          patch.playerResults = slice;
        } else {
          patch.results = slice;
        }
        this.setData(patch);
        // 异步补全搜索结果的详情字段（仅战队补全）
        if (!isPlayer) this.enrichResults();
      })
      .catch(() => {
        this.allResults = [];
        const patch = { loading: false, error: '搜索失败，请检查网络或域名配置', hasMore: false, page: 0, suggestion: '' };
        if (isPlayer) patch.playerResults = []; else patch.results = [];
        this.setData(patch);
      });
  },

  // 切换搜索类型（战队 / 选手），清空当前结果
  onSearchType(e) {
    const type = e.currentTarget.dataset.type;
    if (type === this.data.searchType) return;
    this.setData({ searchType: type, results: [], playerResults: [], mode: 'hot', keyword: '', searched: false, error: '', suggestion: '' });
  },

  // 点击历史关键词：回填输入框并立即搜索（会把该词置顶）。
  onTapHistory(e) {
    const kw = e.currentTarget.dataset.kw;
    if (!kw) return;
    this.setData({ keyword: kw });
    this.runSearch(kw);
  },

  // 点击热门搜索推荐词：直接搜索
  onTapHotWord(e) {
    const kw = e.currentTarget.dataset.kw;
    if (!kw) return;
    this.setData({ keyword: kw });
    this.runSearch(kw);
  },

  // 点击纠错建议：用建议词重新搜索
  onTapSuggestion(e) {
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
    this.setData({ keyword: '', mode: 'hot', results: [], searched: false, error: '', hasMore: false, page: 0, history: searchHistory.get('teams'), suggestion: '' });
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
    wx.navigateTo({ url: '/subpackages/detail/team-detail/team-detail?teamId=' + id });
  },

  openPlayer(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: '/subpackages/detail/player-detail/player-detail?accountId=' + id });
  },

  toggleFollowPlayer(e) {
    const id = e.currentTarget.dataset.id;
    const name = e.currentTarget.dataset.name;
    const followed = follow.toggle('players', { id: String(id), name: name });
    // 路径更新：仅刷新当前行
    const idx = this.data.playerResults.findIndex((x) => x.id === id);
    if (idx >= 0) this.setData({ ['playerResults[' + idx + '].followed']: followed });
    const sync = (arr) => arr && arr.forEach((x) => { if (x.id === id) x.followed = followed; });
    sync(this.allResults);
    wx.showToast({ title: followed ? '已关注' : '已取消关注', icon: 'none' });
  }
});
