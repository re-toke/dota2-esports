const api = require('../../utils/api.js');
const util = require('../../utils/util.js');
const follow = require('../../utils/follow.js');
const cache = require('../../utils/cache.js');
const config = require('../../utils/config.js');
const sources = require('../../utils/sources.js');
const stratz = require('../../utils/stratz.js');

// 等级 -> TDesign Tag 主题/变体
function tagThemeOf(grade) {
  if (grade === 'SSS' || grade === 'S') return { theme: 'danger', variant: 'light' };
  if (grade === 'A') return { theme: 'warning', variant: 'light' };
  return { theme: 'default', variant: 'light' };
}

// 状态 -> 中文标签 + 颜色
function statusBadgeOf(status) {
  if (status === 'ongoing') return { text: '进行中', color: '#1ec896' };
  if (status === 'upcoming') return { text: '即将到来', color: '#ffcf5c' };
  return { text: '已结束', color: '#6b7280' };
}

// 知名 S 级赛事关键词（用于「即将到来」优先查询）
const KNOWN_KEYWORDS = /(international|major|esl\s+one|esl\s+pro|dreamleague|blast|riyadh|pgl|betboom|clavision|fissure|the\s+summit|games\s+of\s+the\s+future|heroic|resurrection|weplay|moonstorm|dpc|tour|division\s+i)/i;
function isKnownEvent(name) { return KNOWN_KEYWORDS.test(name || ''); }

Page({
  data: {
    // all = 全部（已结束+正在进行），按最近比赛时间倒序
    // ongoing = 正在进行
    // upcoming = 即将到来（未来两个月内开赛）
    filter: 'all',
    keyword: '',
    list: [],
    loading: true,
    error: '',
    page: 0,
    pageSize: config.pageSize,
    hasMore: false,
    upcomingLoading: false,
    upcomingProgress: '',
    liveGames: [],
    // STRATZ 是否启用（赛程数据主要来源）：未启用且即将到来为空时，据此提示用户
    stratzEnabled: !!stratz.ENABLED,
    updatedAt: 0,
    updatedLabel: ''
  },

  onLoad() {
    this.allLeagues = [];     // 归一化后的全部 S 级及以上赛事（含时间窗口与状态）
    this.filtered = [];       // 当前 tab 筛选结果
    this.upcomingList = null;  // 即将到来列表（null=未加载，[]=已加载无结果）
    this.loadLeagues();
  },

  onPullDownRefresh() {
    // 下拉强制刷新：清掉赛事列表与时间窗口缓存后重新拉取
    cache.remove('/leagues|{}');
    cache.remove('/explorer?sql=' + encodeURIComponent(
      "SELECT leagueid, min(start_time) AS earliest, max(start_time) AS latest, count(*) AS n " +
      "FROM matches WHERE start_time > extract(epoch FROM now() - interval '1 year') " +
      "GROUP BY leagueid"
    ));
    this.upcomingList = null;
    this.setData({ page: 0 });
    this.loadLeagues(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading && !this.data.upcomingLoading) this.appendPage();
  },

  retry() {
    this.loadLeagues();
  },

  loadLeagues(cb) {
    this.setData({ loading: true, error: '' });
    // 并行拉赛事元数据 + 时间窗口（explorer 一条 SQL 拿全部）
    Promise.all([api.getLeagues(), api.getLeagueWindows()])
      .then((res) => {
        const list = res[0] || [];
        const windows = res[1] || {};
        this.allLeagues = list
          .map((l) => this.normalize(l, windows[l.leagueid]))
          .filter((x) => x && x.rank >= 3); // S 级及以上（SSS + S）
        this.applyAndSlice(true);
        const at = api.fetchedAtOf('leagueWindows') || api.fetchedAtOf('leagues');
        this.setData({ loading: false, updatedAt: at, updatedLabel: util.formatAgo(at) });
        cb && cb();

        // 异步获取正在直播的比赛（Steam/STRATZ），不阻塞主流程
        sources.enrichLiveGames().then((games) => {
          this.setData({ liveGames: games });
        });
      })
      .catch(() => {
        this.setData({ loading: false, error: '加载失败，请检查网络或域名配置（开发阶段可勾选「不校验合法域名」）' });
        cb && cb();
      });
  },

  normalize(l, win) {
    if (!l || !l.leagueid) return null;
    const ut = util.unifiedTier(l);
    const t = tagThemeOf(ut.grade);
    const w = win || {};
    const mixed = {
      earliest: w.earliest || 0,
      latest: w.latest || 0,
      startDate: null,
      endDate: null
    };
    const status = util.statusOf(mixed);
    const badge = statusBadgeOf(status);
    return {
      leagueid: l.leagueid,
      name: l.name || ('赛事 ' + l.leagueid),
      grade: ut.grade,
      rank: ut.rank,
      tierClass: 'tier-' + ut.grade.toLowerCase(),
      label: ut.label,
      source: ut.source,
      tagTheme: t.theme,
      tagVariant: t.variant,
      followed: follow.isFollowed('leagues', l.leagueid),
      earliest: mixed.earliest,
      latest: mixed.latest,
      matchCount: w.count || 0,
      status: status,
      statusText: badge.text,
      statusColor: badge.color,
      dateRange: util.formatDateRange(mixed.earliest, mixed.latest),
      _win: mixed
    };
  },

  onFilter(e) {
    const f = e.currentTarget.dataset.f;
    if (f === this.data.filter) return;
    this.setData({ filter: f, page: 0 });
    if (f === 'upcoming') {
      // 即将到来懒加载：首次切到时查赛程
      if (this.upcomingList === null) {
        this.loadUpcoming();
      } else {
        this.applyAndSlice(true);
      }
    } else {
      this.applyAndSlice(true);
    }
  },

  onSearch(e) {
    this.setData({ keyword: (e.detail.value || '').trim(), page: 0 });
    this.applyAndSlice(true);
  },

  // 即将到来：对知名 S 级赛事查赛程，筛未来两个月内开赛。
  // 赛程数据来源：curation 本地精选（部分赛事含日期）+ STRATZ（启用时）。
  // STRATZ 未启用且 curation 无日期时，结果为空 —— 由 wxml 提示用户启用 STRATZ。
  loadUpcoming() {
    if (this.data.upcomingLoading) return;
    this.setData({ upcomingLoading: true, upcomingProgress: '准备查询赛程...' });

    // 候选优先级：知名赛事在前；同优先级下按最近比赛时间倒序（近期活跃的优先）
    const candidates = (this.allLeagues || []).slice().sort((a, b) => {
      const ka = isKnownEvent(a.name) ? 0 : 1;
      const kb = isKnownEvent(b.name) ? 0 : 1;
      if (ka !== kb) return ka - kb;
      return (b.latest || 0) - (a.latest || 0);
    });
    const limit = config.leagueWindow.upcomingQueryLimit;
    const targets = candidates.slice(0, limit);

    const results = [];
    let i = 0;
    const total = targets.length;

    const next = () => {
      if (i >= total) {
        // 完成：按开赛时间升序
        results.sort((a, b) => (a.startDate || 0) - (b.startDate || 0));
        this.upcomingList = results;
        this.setData({ upcomingLoading: false, upcomingProgress: '' });
        this.applyAndSlice(true);
        return;
      }
      const item = targets[i];
      i++;
      this.setData({ upcomingProgress: '正在查询赛程 ' + i + '/' + total });
      sources.getLeagueWindow({ name: item.name })
        .then((win) => {
          if (win && win.startDate) {
            const mixed = Object.assign({}, item._win, { startDate: win.startDate, endDate: win.endDate });
            if (util.isUpcoming(mixed)) {
              results.push(Object.assign({}, item, {
                startDate: win.startDate,
                endDate: win.endDate,
                _win: mixed,
                status: 'upcoming',
                statusText: '即将到来',
                statusColor: statusBadgeOf('upcoming').color,
                dateRange: util.formatDateRange(win.startDate, win.endDate)
              }));
            }
          }
          // sources 内部已做限流/熔断，直接继续
          next();
        })
        .catch(() => { next(); });
    };
    next();
  },

  applyAndSlice(reset) {
    const f = this.data.filter;
    let arr;
    if (f === 'upcoming') {
      arr = (this.upcomingList || []).slice();
    } else if (f === 'ongoing') {
      arr = (this.allLeagues || []).filter((x) => x.status === 'ongoing');
      // 进行中：按最近比赛时间倒序
      arr.sort((a, b) => (b.latest || 0) - (a.latest || 0));
    } else {
      // 全部：按最近比赛时间倒序（无 latest 的排最后）
      arr = (this.allLeagues || []).slice();
      arr.sort((a, b) => {
        const la = a.latest || 0, lb = b.latest || 0;
        return lb - la;
      });
    }

    // 关键词过滤
    const kw = this.data.keyword;
    if (kw) {
      const k = kw.toLowerCase();
      arr = arr.filter((x) => x.name.toLowerCase().indexOf(k) >= 0);
    }

    this.filtered = arr;
    const pageSize = this.data.pageSize;
    const page = reset ? 0 : this.data.page;
    const slice = arr.slice(0, (page + 1) * pageSize);
    this.setData({ list: slice, page: page, hasMore: arr.length > slice.length });
  },

  appendPage() {
    const page = this.data.page + 1;
    const pageSize = this.data.pageSize;
    const slice = this.filtered.slice(0, (page + 1) * pageSize);
    this.setData({ list: slice, page: page, hasMore: this.filtered.length > slice.length });
  },

  toggleFollow(e) {
    const id = e.currentTarget.dataset.id;
    const name = e.currentTarget.dataset.name;
    const followed = follow.toggle('leagues', { id: id, name: name });
    const list = this.data.list.map((x) =>
      x.leagueid === id ? Object.assign({}, x, { followed: followed }) : x);
    this.setData({ list: list });
    // 同步 allLeagues 与 upcomingList 的关注状态
    const sync = (arr) => arr && arr.forEach((x) => { if (x.leagueid === id) x.followed = followed; });
    sync(this.allLeagues);
    sync(this.upcomingList);
    wx.showToast({ title: followed ? '已关注' : '已取消关注', icon: 'none' });
  },

  openLeague(e) {
    const id = e.currentTarget.dataset.id;
    const name = e.currentTarget.dataset.name;
    wx.navigateTo({
      url: '/pages/league-detail/league-detail?leagueId=' + id + '&name=' + encodeURIComponent(name)
    });
  }
});
