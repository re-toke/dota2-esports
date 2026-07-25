const api = require('../../utils/api.js');
const util = require('../../utils/util.js');
const follow = require('../../utils/follow.js');
const cache = require('../../utils/cache.js');
const config = require('../../utils/config.js');
const sources = require('../../utils/sources.js');
const stratz = require('../../utils/stratz.js');
const cloudProxy = require('../../utils/cloudProxy.js');
const tiers = require('../../utils/tiers.js');
const remoteCuration = require('../../utils/remoteCuration.js');

// 跨页状态持久化键（I5）：离开页面时保存筛选/关键词/滚动位置，返回时还原
const VIEW_KEY = 'leagues_view_state';

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

// 将「赛程原始条目」统一转换为渲染卡片对象。
// 云端缓存（getUpcomingSchedule）与本地预构建快照（upcoming-local.json）共用此构造器，
// 保证两路数据源渲染字段完全一致；后续增删字段只需改这一处（可维护性/可扩展性）。
// entry: { id, name, grade, rank, label, tier, start, end, source, valve?, topThirdParty? }
// ctx:   { now, allLeagues, lid }  lid 用于回查 allLeagues 复用分级/关注等；本地快照可传 entry.id
function buildUpcomingCard(entry, ctx) {
  const now = ctx.now;
  const lid = ctx.lid != null ? String(ctx.lid) : String(entry.id);
  const matched = (ctx.allLeagues || []).find((x) => String(x.leagueid) === lid);
  const grade = entry.grade || (matched && matched.grade) || 'S';
  const rank = entry.rank || (matched && matched.rank) || 3;
  const label = entry.label || (matched && matched.label) || 'S级';
  const name = entry.name || (matched && matched.name) || '';
  const daysToStart = Math.ceil((entry.start - now) / 86400);
  return {
    leagueid: Number(entry.id),
    name: name,
    grade: grade,
    rank: rank,
    label: label,
    tierClass: 'tier-' + grade.toLowerCase(),
    displayLabel: tiers.displayOf(grade),
    tagTheme: tagThemeOf(grade).theme,
    tagVariant: tagThemeOf(grade).variant,
    startDate: entry.start,
    endDate: entry.end,
    status: 'upcoming',
    statusText: '即将到来',
    statusColor: statusBadgeOf('upcoming').color,
    dateRange: util.formatDateRange(entry.start, entry.end),
    daysToStart: daysToStart,
    countdownText: daysToStart <= 0 ? '今日开赛' : (daysToStart === 1 ? '明天开赛' : daysToStart + ' 天后开赛'),
    source: entry.source || (matched && matched.source) || 'liquipedia',
    valve: !!(entry.valve != null ? entry.valve : tiers.flagValve(name)),
    topThirdParty: !!(entry.topThirdParty != null ? entry.topThirdParty : tiers.flagTopThirdParty(name)),
    followed: follow.isFollowed('leagues', Number(entry.id)),
    matchCount: 0,
    earliest: 0,
    latest: 0,
    _win: { startDate: entry.start, endDate: entry.end }
  };
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
    // 等级筛选：all=全部 / sss=TI顶级 / s=S级 / a=A级 / b=B级
    gradeFilter: 'all',
    gradeCounts: { all: 0, sss: 0, s: 0, a: 0, b: 0 },
    keyword: '',
    list: [],
    archived: [],
    loading: true,
    error: '',
    page: 0,
    pageSize: config.pageSize,
    hasMore: false,
    upcomingLoading: false,
    upcomingProgress: '',
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

  // I5：记录页面滚动位置（不写 setData，避免滚动时频繁刷新）
  onPageScroll(e) {
    this._scrollTop = e.scrollTop;
  },

  // I5：离开页面时持久化视图状态
  onHide() {
    try {
      wx.setStorageSync(VIEW_KEY, {
        scrollTop: this._scrollTop || 0,
        filter: this.data.filter,
        gradeFilter: this.data.gradeFilter,
        keyword: this.data.keyword
      });
    } catch (e) { /* 忽略存储异常 */ }
  },

  // I5：返回页面时还原视图状态（首次 onShow 跳过，避免覆盖 onLoad 的初始数据）
  onShow() {
    if (this._restored) {
      let saved = null;
      try { saved = wx.getStorageSync(VIEW_KEY) || null; } catch (e) { saved = null; }
      if (saved) {
        this.setData({
          filter: saved.filter || 'all',
          gradeFilter: saved.gradeFilter || 'all',
          keyword: saved.keyword || ''
        });
        // 即将到来未加载则补拉，否则直接套用筛选
        if (saved.filter === 'upcoming' && this.upcomingList === null) {
          this.loadUpcoming();
        } else {
          this.applyAndSlice(true);
        }
        const top = saved.scrollTop || 0;
        if (top > 0) {
          setTimeout(() => { wx.pageScrollTo({ scrollTop: top, duration: 0 }); }, 60);
        }
      }
    }
    this._restored = true;
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
          .filter((x) => x && x.rank >= 1); // SSS + S + A + B 级（含次级联赛/杯赛）
        // 预计算各等级计数，供筛选条展示
        this.updateGradeCounts();
        this.applyAndSlice(true);
        const at = api.fetchedAtOf('leagueWindows') || api.fetchedAtOf('leagues');
        this.setData({ loading: false, updatedAt: at, updatedLabel: util.formatAgo(at) });
        cb && cb();
      })
      .catch(() => {
        this.setData({ loading: false, error: '加载失败，请检查网络或域名配置（开发阶段可勾选「不校验合法域名」）' });
        cb && cb();
      });
  },

  // 预计算各等级的赛事数量，供等级筛选条展示（已停办 defunct 不计入，归入归档区）
  updateGradeCounts() {
    const counts = { all: 0, sss: 0, s: 0, a: 0, b: 0 };
    (this.allLeagues || []).forEach((x) => {
      if (x.defunct) return;
      counts.all++;
      const g = (x.grade || '').toLowerCase();
      if (counts[g] !== undefined) counts[g]++;
    });
    this.setData({ gradeCounts: counts });
  },

  normalize(l, win) {
    if (!l || !l.leagueid) return null;
    const ut = util.unifiedTier(l);
    const t = tagThemeOf(ut.grade);
    // 从 curation（含 remoteCuration 热更新覆盖）取权威补充字段
    const cur = remoteCuration.curatedEventFor(l.name);
    const valve = (cur && cur.valve != null) ? cur.valve : tiers.flagValve(l.name);
    const topThirdParty = (cur && cur.topThirdParty != null) ? cur.topThirdParty : tiers.flagTopThirdParty(l.name);
    const defunct = !!(cur && cur.defunct);
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
      displayLabel: tiers.displayOf(ut.grade),   // 文档五档名：官方TI/S-Tier/A-Tier/区域赛/社区赛
      source: ut.source,
      tagTheme: t.theme,
      tagVariant: t.variant,
      valve: valve,
      topThirdParty: topThirdParty,
      defunct: defunct,
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

  // 等级筛选：all=全部 / sss / s / a / b
  onGradeFilter(e) {
    const g = e.currentTarget.dataset.g;
    if (g === this.data.gradeFilter) return;
    this.setData({ gradeFilter: g, page: 0 });
    this.applyAndSlice(true);
  },

  onSearch(e) {
    this.setData({ keyword: (e.detail.value || '').trim(), page: 0 });
    this.applyAndSlice(true);
  },

  // 即将到来：对知名 S 级赛事查赛程，筛未来两个月内开赛。
  // 赛程数据来源：curation 本地精选（部分赛事含日期）+ STRATZ（启用时）。
  // ★ 优化：优先读云函数预热的赛程缓存（秒开），失败回退逐个串行查询。
  // STRATZ 未启用且 curation 无日期时，结果为空 —— 由 wxml 提示用户启用 STRATZ。
  loadUpcoming() {
    if (this.data.upcomingLoading) return;
    this.setData({ upcomingLoading: true, upcomingProgress: '准备查询赛程...' });

    // 赛程数据源回退链：云函数预热缓存 → 本地预构建快照 → 串行查询（OpenDota + curation）
    // 任一层命中即用其数据，无需后续层；保证「即将到来」在任意部署形态下都不为空。
    this.tryCloudUpcoming().then((hit) => {
      if (hit) return;
      return this.tryLocalUpcoming().then((hit2) => {
        if (hit2) return;
        this.loadUpcomingSerial();
      });
    });
  },

  // 尝试从云函数读取预热的赛程缓存。命中返回 true，未命中/失败返回 false。
  tryCloudUpcoming() {
    if (!cloudProxy.isAvailable()) return Promise.resolve(false);
    return wx.cloud.callFunction({ name: 'aggregation', data: { action: 'getUpcomingSchedule' } })
      .then((res) => {
        const result = res && res.result;
        if (!result || result.error || !result.data) return false;
        const schedule = result.data; // { id: { id, name, grade, rank, label, tier, start, end, source } }
        const now = util.nowSec();
        const horizon = now + config.leagueWindow.upcomingRangeSec;
        const results = [];
        Object.keys(schedule).forEach((lid) => {
          const s = schedule[lid];
          if (!s || !s.start) return;
          if (s.start > now && s.start <= horizon) {
            // 复用 buildUpcomingCard 统一构造（STRATZ 真实联赛 id 经 lid 回查 allLeagues 复用分级/关注）
            results.push(buildUpcomingCard(s, { now: now, allLeagues: this.allLeagues, lid: lid }));
          }
        });
        results.sort((a, b) => (a.startDate || 0) - (b.startDate || 0));
        // 合并 curation 库的未来赛事（云函数缓存可能未含未举办的重大赛事）
        this.mergeCurationUpcoming(results, null);
        results.sort((a, b) => (a.startDate || 0) - (b.startDate || 0));
        this.upcomingList = results;
        this.setData({ upcomingLoading: false, upcomingProgress: '' });
        this.applyAndSlice(true);
        return true;
      })
      .catch(() => false);
  },

  // 本地预构建快照（不依赖云函数）：读取 build-time 生成的 utils/upcoming-local.json。
  // 适用：未部署云函数 / 云函数不可用 / 想零服务端运行。
  // 数据为「运行抓取脚本那一刻」的快照，非实时；刷新需重跑脚本并重新构建发布：
  //   node scripts/fetch-liquipedia-upcoming.js
  // 与云端缓存共用 buildUpcomingCard，字段形状一致；同样经 mergeCurationUpcoming 去重/补充。
  tryLocalUpcoming() {
    let data;
    try {
      data = require('../../utils/upcoming-local.json');
    } catch (e) {
      return Promise.resolve(false);
    }
    const events = (data && data.events) || [];
    if (!events.length) return Promise.resolve(false);

    const now = util.nowSec();
    const horizon = now + config.leagueWindow.upcomingRangeSec;
    const results = events
      .filter((e) => e.start > now && e.start <= horizon)
      .map((e) => buildUpcomingCard(e, { now: now, allLeagues: this.allLeagues, lid: e.id }));
    if (!results.length) return Promise.resolve(false);

    results.sort((a, b) => (a.startDate || 0) - (b.startDate || 0));
    // 合并 curation 库的未来赛事（按归一名去重 + 补充本地快照未覆盖的重大赛事，如 TI 2026）
    this.mergeCurationUpcoming(results, null);
    results.sort((a, b) => (a.startDate || 0) - (b.startDate || 0));
    this.upcomingList = results;
    this.setData({ upcomingLoading: false, upcomingProgress: '' });
    this.applyAndSlice(true);
    return Promise.resolve(true);
  },

  // 串行查询回退：逐个赛事查赛程（STRATZ 2s 限流，首次较慢）
  // 优化：
  //   1. 先从 allLeagues 中找出 earliest 在未来的赛事（OpenDota 已有未来比赛记录），直接添加
  //   2. 再从 curation 库补充已知的未来赛事（如 TI 2026），立即显示
  //   3. 串行查询剩余赛事（earliest 不在未来的），作为后台补充
  // 这样即使 STRATZ/Liquipedia 失败，也能利用 OpenDota 已有数据显示即将到来的赛事
  loadUpcomingSerial() {
    const results = [];
    const diag = { total: 0, curationHit: 0, explorerHit: 0, stratzHit: 0, stratzFail: 0, liqHit: 0, liqFail: 0, noDate: 0 };
    const nowSec = Math.floor(Date.now() / 1000);
    const horizon = nowSec + config.leagueWindow.upcomingRangeSec;

    // 1. 先从 allLeagues 中找出 earliest 在未来的赛事（OpenDota explorer 已有未来比赛记录）
    //    这些赛事不需要查 STRATZ/Liquipedia，直接使用已有数据
    const needQuery = [];  // earliest 不在未来的赛事，需要串行查询
    (this.allLeagues || []).forEach((item) => {
      const er = item._win && item._win.earliest;
      if (er && er > nowSec && er <= horizon) {
        // earliest 在未来范围内：直接添加到 results
        const daysToStart = Math.ceil((er - nowSec) / 86400);
        results.push(Object.assign({}, item, {
          startDate: er,
          endDate: item._win.latest || null,
          status: 'upcoming',
          statusText: '即将到来',
          statusColor: statusBadgeOf('upcoming').color,
          dateRange: util.formatDateRange(er, item._win.latest),
          daysToStart: daysToStart,
          countdownText: daysToStart <= 0 ? '今日开赛' : (daysToStart === 1 ? '明天开赛' : daysToStart + ' 天后开赛')
        }));
        diag.explorerHit++;
      } else {
        // earliest 不在未来范围内，需要串行查询外部源
        needQuery.push(item);
      }
    });

    // 2. 从 curation 库补充已知的未来赛事（如 TI 2026）
    this.mergeCurationUpcoming(results, diag);

    // 立即显示已收集的结果（explorer + curation）
    if (results.length > 0) {
      results.sort((a, b) => (a.startDate || 0) - (b.startDate || 0));
      this.upcomingList = results.slice();
      this.setData({ upcomingLoading: false, upcomingProgress: '' });
      this.applyAndSlice(true);
    }

    // 3. 串行查询剩余赛事（earliest 不在未来的），作为后台补充
    //    优先查知名赛事；同优先级下按最近比赛时间倒序（近期活跃的优先）
    const candidates = needQuery.sort((a, b) => {
      const ka = isKnownEvent(a.name) ? 0 : 1;
      const kb = isKnownEvent(b.name) ? 0 : 1;
      if (ka !== kb) return ka - kb;
      return (b.latest || 0) - (a.latest || 0);
    });
    const limit = config.leagueWindow.upcomingQueryLimit;
    const targets = candidates.slice(0, limit);

    let i = 0;
    const total = targets.length;
    diag.total = total;

    if (total === 0) {
      // 无候选需要查询：explorer + curation 结果（若有）已显示，否则为空
      this.upcomingList = results;
      this.setData({ upcomingLoading: false, upcomingProgress: '' });
      this.applyAndSlice(true);
      console.log('[upcoming] 无串行候选，explorer+curation 结果', {
        命中即将到来: results.length,
        explorerHit: diag.explorerHit,
        curationHit: diag.curationHit,
        结果: results.map(function(r){return r.name + '(' + r.dateRange + ')';})
      });
      return;
    }

    const next = () => {
      if (i >= total) {
        // 完成：按开赛时间升序
        results.sort((a, b) => (a.startDate || 0) - (b.startDate || 0));
        this.upcomingList = results;
        this.setData({ upcomingLoading: false, upcomingProgress: '' });
        console.log('[upcoming] 查询完成', {
          候选赛事数: diag.total, 命中即将到来: results.length,
          数据源统计: diag,
          结果: results.map(function(r){return r.name + '(' + r.dateRange + ')';})
        });
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
              // 计算距开赛天数（比日期范围更直观）
              const nowSec = Math.floor(Date.now() / 1000);
              const daysToStart = Math.ceil((win.startDate - nowSec) / 86400);
              results.push(Object.assign({}, item, {
                startDate: win.startDate,
                endDate: win.endDate,
                _win: mixed,
                status: 'upcoming',
                statusText: '即将到来',
                statusColor: statusBadgeOf('upcoming').color,
                dateRange: util.formatDateRange(win.startDate, win.endDate),
                daysToStart: daysToStart,
                countdownText: daysToStart <= 0 ? '今日开赛' : (daysToStart === 1 ? '明天开赛' : daysToStart + ' 天后开赛')
              }));
            }
          } else {
            diag.noDate++;
            // 首次查询时输出前 5 个无日期的赛事名，帮助定位
            if (diag.noDate <= 5) {
              console.log('[upcoming] 无日期数据:', item.name, '→ 所有数据源均未返回');
            }
          }
          // sources 内部已做限流/熔断，直接继续
          next();
        })
        .catch(() => { next(); });
    };
    next();
  },

  // 把 curation 库中「有未来日期」的赛事合并到 results。
  // 用于补充 OpenDota 尚未记录的未举办重大赛事（如 TI 2026 主赛事）。
  // 去重：只检查 results（已添加的），不检查 allLeagues。
  //   原因：allLeagues 中可能有同名赛事但无未来日期（status≠upcoming），
  //   不应阻止 curation 的补充；否则会导致 curation 赛事被误跳过。
  // leagueId：curation 赛事无真实 leagueid，用基于规范名的负数哈希作为占位 id，
  //   避免与真实 leagueid 冲突，同时保证同一赛事多次查询 id 稳定。
  mergeCurationUpcoming(results, diag) {
    if (!results || typeof sources.getUpcomingFromCuration !== 'function') return;
    const nowSec = Math.floor(Date.now() / 1000);
    // 只收集 results 中已添加的归一名（allLeagues 中同名但非 upcoming 的不应阻止补充）
    const seen = {};
    const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    results.forEach((r) => {
      const k = norm(r.name);
      if (k) seen[k] = true;
    });

    const extra = sources.getUpcomingFromCuration(nowSec) || [];
    extra.forEach((ev) => {
      const k = norm(ev.name);
      if (!k || seen[k]) return;  // 已存在则跳过
      seen[k] = true;

      const ut = ev.tier || { grade: 'S', rank: 3, label: 'S级' };
      const t = tagThemeOf(ut.grade);
      const daysToStart = Math.ceil((ev.startDate - nowSec) / 86400);
      // 基于归一名生成稳定的负数 id（避免与真实 leagueid 冲突）
      let hash = 0;
      for (let j = 0; j < k.length; j++) {
        hash = ((hash << 5) - hash + k.charCodeAt(j)) | 0;
      }
      const fakeId = -(Math.abs(hash) % 1000000 + 1000000);  // 负数区间 -1999999..-1000000
      results.push({
        leagueid: fakeId,
        name: ev.name,
        grade: ut.grade,
        rank: ut.rank,
        tierClass: 'tier-' + ut.grade.toLowerCase(),
        label: ut.label,
        displayLabel: tiers.displayOf(ut.grade),
        valve: !!(ev.valve != null ? ev.valve : tiers.flagValve(ev.name)),
        topThirdParty: !!(ev.topThirdParty != null ? ev.topThirdParty : tiers.flagTopThirdParty(ev.name)),
        defunct: !!ev.defunct,
        source: 'community',  // 标注为本地精选（curation）
        tagTheme: t.theme,
        tagVariant: t.variant,
        followed: follow.isFollowed('leagues', fakeId),
        startDate: ev.startDate,
        endDate: ev.endDate,
        status: 'upcoming',
        statusText: '即将到来',
        statusColor: statusBadgeOf('upcoming').color,
        dateRange: util.formatDateRange(ev.startDate, ev.endDate),
        daysToStart: daysToStart,
        countdownText: daysToStart <= 0 ? '今日开赛' : (daysToStart === 1 ? '明天开赛' : daysToStart + ' 天后开赛'),
        matchCount: 0,
        earliest: 0,
        latest: 0,
        _win: { startDate: ev.startDate, endDate: ev.endDate }
      });
      if (diag) diag.curationHit = (diag.curationHit || 0) + 1;
    });
  },

  applyAndSlice(reset) {
    const f = this.data.filter;
    const gf = this.data.gradeFilter;
    // 等级过滤函数：gradeFilter=all 不过滤，否则只保留对应等级
    // SSS 与 S 都属于「顶级+S级」范畴，sss 筛选只保留 SSS，s 筛选只保留 S
    const gradeMatch = (x) => {
      if (gf === 'all') return true;
      return (x.grade || '').toLowerCase() === gf;
    };
    let arr;
    if (f === 'upcoming') {
      arr = (this.upcomingList || []).filter(gradeMatch).slice();
    } else if (f === 'ongoing') {
      arr = (this.allLeagues || []).filter((x) => x.status === 'ongoing' && gradeMatch(x));
      // 进行中：按最近比赛时间倒序
      arr.sort((a, b) => (b.latest || 0) - (a.latest || 0));
    } else if (f === 'ended') {
      // 已结束：最近比赛在 7 天前的赛事，按最近比赛时间倒序
      const cutoff = Date.now() / 1000 - 7 * 86400;
      arr = (this.allLeagues || []).filter((x) => x.status === 'ended' && (x.latest || 0) < cutoff && gradeMatch(x));
      arr.sort((a, b) => (b.latest || 0) - (a.latest || 0));
    } else {
      // 全部：按最近比赛时间倒序（无 latest 的排最后）
      arr = (this.allLeagues || []).filter(gradeMatch).slice();
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
    // defunct 归档：已停办赛事下沉到独立归档区，不计入主列表分页/计数
    const archived = arr.filter((x) => x.defunct).sort((a, b) => (b.latest || 0) - (a.latest || 0));
    const active = arr.filter((x) => !x.defunct);
    this.filtered = active;
    const pageSize = this.data.pageSize;
    const page = reset ? 0 : this.data.page;
    const slice = active.slice(0, (page + 1) * pageSize);
    this.setData({ list: slice, archived: archived, page: page, hasMore: active.length > slice.length });
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
    // 路径更新：仅刷新当前行的 followed 状态，避免整体 list setData
    const idx = this.data.list.findIndex((x) => x.leagueid === id);
    if (idx >= 0) this.setData({ ['list[' + idx + '].followed']: followed });
    // 同步 allLeagues 与 upcomingList 的关注状态（不触发 setData）
    const sync = (arr) => arr && arr.forEach((x) => { if (x.leagueid === id) x.followed = followed; });
    sync(this.allLeagues);
    sync(this.upcomingList);
    wx.showToast({ title: followed ? '已关注' : '已取消关注', icon: 'none' });
  },

  openLeague(e) {
    const id = e.currentTarget.dataset.id;
    const name = e.currentTarget.dataset.name;
    wx.navigateTo({
      url: '/subpackages/detail/league-detail/league-detail?leagueId=' + id + '&name=' + encodeURIComponent(name)
    });
  }
});
