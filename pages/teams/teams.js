const api = require('../../utils/api.js');
const follow = require('../../utils/follow.js');
const config = require('../../utils/config.js');
const util = require('../../utils/util.js');
const sources = require('../../utils/sources.js');
const searchHistory = require('../../utils/searchHistory.js');
const curation = require('../../utils/curation.js');
const teamSearch = require('../../utils/teamSearch.js');

// 跨页状态持久化键（I5）：离开页面时保存搜索类型/关键词/滚动位置，返回时还原
const VIEW_KEY = 'teams_view_state';

// 关注的顶级战队预设（team_id 来自 OpenDota）
const HOT_TEAMS = [
  { team_id: 10150538, name: 'LGD Gaming', tag: 'LGD' },
  { team_id: 7119388, name: 'Team Spirit', tag: 'TS' },
  { team_id: 36, name: 'Natus Vincere', tag: 'NAVI' },
  { team_id: 2586976, name: 'OG', tag: 'OG' },
  { team_id: 1838315, name: 'Team Secret', tag: 'SEC' },
  { team_id: 2163, name: 'Team Liquid', tag: 'TL' },     // 原 1375614 标为 Fnatic 但实际是 Newbee；Fnatic DOTA2 已解散(2023)，替换为 TL(TI 冠军/活跃)
  { team_id: 8291895, name: 'Tundra Esports', tag: 'TUN' },
  { team_id: 8599101, name: 'Gaimin Gladiators', tag: 'GG' },
  { team_id: 8255756, name: 'Evil Geniuses', tag: 'EG' },
  { team_id: 9580444, name: 'PSG.LGD', tag: 'PSG' }
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
function buildSuggestion(kw) {
  const k = (kw || '').trim().toLowerCase();
  if (k.length < 2) return '';
  const candidates = [];
  HOT_TEAMS.forEach((t) => { candidates.push(t.name); if (t.tag) candidates.push(t.tag); });
  (searchHistory.get('teams') || []).forEach((h) => candidates.push(h));
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

// 本地战队模糊匹配已抽到 utils/teamSearch.js（与 pages/search 共用同一套语料/兜底逻辑）。
// 此处仅保留卡片字段合并等页面级逻辑。

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
    name: t.name || item.name,
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
    // hot 模式无限下拉分页状态（与 result 模式的 page/hasMore/loadingMore 相互独立）
    hotPage: 0,
    hotPageSize: 12,
    hotHasMore: false,
    hotLoadingMore: false,
    searched: false,
    error: '',
    history: [],
    hotWords: HOT_KEYWORDS,   // 热门搜索推荐词（点击直接搜）
    suggestion: '',           // 搜索无结果时的纠错建议
    liveSuggestions: [],      // 输入时实时联想（本地索引：名/缩写/别名）
    hotEnriching: false,      // 热门队伍异步补全中
    resultEnriching: false    // 搜索结果异步补全中
  },

  onLoad() {
    // hot 池 = 策展 top 队(HOT_TEAMS) + 本地知名战队索引(teamSearch)，按 id 去重后客户端分页，
    // 实现 hot 模式无限下拉（不再仅 10 队就到底）。
    const pool = this.buildHotPool();
    this.allHot = pool;
    const first = pool.slice(0, this.data.hotPageSize).map((t) => this.decorateHot(t));
    this.setData({
      hot: first,
      hotPage: 0,
      hotHasMore: pool.length > first.length,
      hotLoadingMore: false,
      history: searchHistory.get('teams')
    });
    this.enrichHotSlice();
  },

  // 构建 hot 滚动池：HOT_TEAMS（策展 top 队）优先，再并入 teamSearch 本地索引里的其余知名战队，
  // 按 id 去重。返回 [{id,name,tag,navigable}]（不含 followed，渲染时再补）。零网络、稳定 id。
  buildHotPool() {
    const pool = [];
    const seen = {};
    HOT_TEAMS.forEach((t) => {
      const id = t.team_id;
      if (!seen[id]) { seen[id] = true; pool.push({ id: id, name: t.name, tag: t.tag, navigable: true }); }
    });
    teamSearch.buildLocalTeamIndex().forEach((t) => {
      if (!seen[t.id]) { seen[t.id] = true; pool.push({ id: t.id, name: t.name, tag: t.tag, navigable: t.navigable !== false }); }
    });
    return pool;
  },

  // 给 hot 池项补 followed 状态，返回展示用对象。
  decorateHot(t) {
    return Object.assign({}, t, { followed: follow.isFollowed('teams', t.id) });
  },

  // 懒补全：仅对当前可见 hot 切片中尚未补全的项拉取详情（logo/rating/wins 等）。
  // 逐页滚动时只对可见部分触发，分散 OpenDota 请求、避免一次性 40+ 并行（原 enrichHot 全量补全）。
  // 已补全项带 _enriched 标记，直接跳过；navigable:false 的占位历史队（负数 id）不请求。
  enrichHotSlice() {
    const list = this.data.hot.slice();
    if (!list.length) return;
    const tasks = list.map((item) => {
      if (item._enriched || item.navigable === false) {
        return Promise.resolve(Object.assign({}, item, { _enriched: true }));
      }
      return api.getTeam(item.id)
        .then((t) => enrichItem(item, t))
        .then((merged) => sources.enrichTeamInfo({ id: item.id, name: item.name })
          .then((info) => applyExtra(merged, info))
          .catch(() => merged))
        .catch(() => item)
        .then((enriched) => Object.assign({}, enriched, { _enriched: true }));
    });
    this.setData({ hotEnriching: true });
    Promise.all(tasks).then((enriched) => {
      this.setData({ hot: enriched, hotEnriching: false });
    });
  },

  // 下拉刷新：清除补全标记后重新补全可见页。
  refreshHot() {
    const reset = this.data.hot.map((t) => {
      const r = Object.assign({}, t);
      delete r._enriched;
      return r;
    });
    this.setData({ hot: reset, hotEnriching: true });
    this.enrichHotSlice();
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
      this.refreshHot();
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
    if (this.data.mode === 'result') {
      if (this.data.hasMore && !this.data.loading && !this.data.loadingMore) {
        this.appendPage();
      }
    } else if (this.data.mode === 'hot') {
      // hot 模式无限下拉：滚到底加载下一页（与 result 模式的分页状态相互独立）
      if (this.data.hotHasMore && !this.data.hotLoadingMore) {
        this.appendHotPage();
      }
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
        keyword: this.data.keyword
      });
    } catch (e) { /* 忽略存储异常 */ }
  },

  // I5：返回页面时还原视图状态（首次 onShow 跳过，避免覆盖 onLoad 的初始数据）
  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 2 });
    }
    if (this._restored) {
      let saved = null;
      try { saved = wx.getStorageSync(VIEW_KEY) || null; } catch (e) { saved = null; }
      if (saved) {
        const kw = saved.keyword || '';
        this.setData({ keyword: kw });
        if (kw) {
          if (this.allResults && this.allResults.length) {
            const pageSize = this.data.pageSize;
            const slice = this.allResults.slice(0, pageSize);
            const patch = { mode: 'result', searched: true, hasMore: this.allResults.length > slice.length, page: 0, results: slice };
            this.setData(patch);
            this.enrichResults();
          } else {
            this.runSearch(kw);
          }
        } else {
          this.setData({ mode: 'hot', results: [], searched: false, hasMore: false, page: 0 });
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
      this.setData({ mode: 'hot', results: [], searched: false, error: '', hasMore: false, page: 0, history: searchHistory.get('teams'), suggestion: '', liveSuggestions: [] });
      return;
    }
    // 实时联想：输入即提示（本地索引，零网络），不等防抖
    const live = teamSearch.matchLocalTeams(kw, 8).map((t) => ({ id: t.id, name: t.name, tag: t.tag, navigable: t.navigable !== false }));
    this.setData({ liveSuggestions: live });
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
        const main = (list || []).map((t) => ({
          id: t.team_id,
          name: t.name,
          tag: (t.name || '').slice(0, 3).toUpperCase(),
          followed: follow.isFollowed('teams', t.team_id),
          isPlayer: false,
          navigable: true
        }));
        // 本地索引兜底：OpenDota /search 常漏掉缩写/别名匹配（如「LGD」「GG」）与历史 S 级队
        const local = teamSearch.matchLocalTeams(kw, 20).map((t) => ({
          id: t.id,
          name: t.name,
          tag: t.tag,
          followed: follow.isFollowed('teams', t.id),
          isPlayer: false,
          navigable: t.navigable !== false
        }));
        const seen = {};
        const all = [];
        main.concat(local).forEach((t) => {
          if (!seen[t.id]) { seen[t.id] = true; all.push(t); }
        });
        this.allResults = all;
        const pageSize = this.data.pageSize;
        const slice = all.slice(0, pageSize);
        // 仅成功返回才写入历史
        const history = searchHistory.add('teams', kw);
        // 无结果时计算纠错建议（编辑距离 ≤2）
        const suggestion = slice.length === 0 ? buildSuggestion(kw) : '';
        this.setData({
          loading: false,
          page: 0,
          hasMore: all.length > slice.length,
          history: history,
          suggestion: suggestion,
          results: slice
        });
        // 异步补全搜索结果的详情字段（战队补全）
        this.enrichResults();
      })
      .catch(() => {
        this.allResults = [];
        this.setData({ loading: false, error: '搜索失败，请检查网络或域名配置', hasMore: false, page: 0, suggestion: '', results: [] });
      });
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
    this.setData({ keyword: '', mode: 'hot', results: [], searched: false, error: '', hasMore: false, page: 0, history: searchHistory.get('teams'), suggestion: '', liveSuggestions: [] });
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

  // hot 模式加载下一页：从 allHot 追加下一页切片到 hot，更新 hotHasMore，并对新增项做懒补全。
  appendHotPage() {
    if (this.data.hotLoadingMore || !this.data.hotHasMore || !this.allHot) return;
    const pageSize = this.data.hotPageSize;
    const page = this.data.hotPage + 1;
    const appended = this.allHot
      .slice(page * pageSize, (page + 1) * pageSize)
      .map((t) => this.decorateHot(t));
    const hot = this.data.hot.concat(appended);
    this.setData({
      hot: hot,
      hotPage: page,
      hotHasMore: this.allHot.length > hot.length,
      hotLoadingMore: false
    });
    this.enrichHotSlice();
  },

  toggleFollow(e) {
    const id = e.currentTarget.dataset.id;
    const name = e.currentTarget.dataset.name;
    const followed = follow.toggle('teams', { id: id, name: name });
    // 优化：用路径更新替代整体数组重建，避免大数据量 setData 拷贝开销
    const arr = this.data.mode === 'hot' ? this.data.hot : this.data.results;
    const idx = arr.findIndex((t) => t.id === id);
    if (idx >= 0) {
      const key = (this.data.mode === 'hot' ? 'hot' : 'results') + '[' + idx + '].followed';
      this.setData({ [key]: followed });
    }
    wx.showToast({ title: followed ? '已关注' : '已取消关注', icon: 'none' });
  },

  openTeam(e) {
    const id = e.currentTarget.dataset.id;
    const navigable = e.currentTarget.dataset.navigable;
    // 历史战队占位（负数 id / navigable:false）：仅搜索可见、无正确详情页，不跳转。
    if (navigable === false || !id || Number(id) <= 0) {
      wx.showToast({ title: '该历史战队资料暂未收录', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: '/subpackages/detail/team-detail/team-detail?teamId=' + id });
  }
});
