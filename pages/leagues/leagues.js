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

// 焦点卡锁定的重点运营节点（文档建议：TI15 2026 上海为本土流量爆发点）
const FOCUS_EVENT_CANONICAL = 'The International 2026';

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

// ===== 1.2 周轴视图工具：按「周一为界」的周聚合赛事 =====
// 取赛事代表开赛时间（startDate > earliest > latest），归到所在周的周一，
// 同周赛事归入一列；无日期（start=0）归入「未定档期」。
function weekMondayOf(ts) {
  const d = new Date(ts * 1000);
  const dow = d.getDay();                 // 0=周日 … 6=周六
  const diff = (dow + 6) % 7;             // 距本周一的天数
  const mon = new Date(d.getFullYear(), d.getMonth(), d.getDate() - diff);
  return Math.floor(mon.getTime() / 1000);
}
function fmtMD(ts) {
  const d = new Date(ts * 1000);
  return (d.getMonth() + 1) + '/' + d.getDate();
}
// ===== 1.3 智能排序：关注置顶 + S级优先 + 时间 =====
// 用于「全部 / 进行中 / 已结束 / 即将到来」列表的默认排序。
// 排序键：① followed（关注置顶）→ ② grade rank（SSS>S>A>B>C）→ ③ 时间（近的在前）。
// 关注态优先取 item.followed，缺失时回退本地 follow 查询，保证排序准确。
function sortSmart(arr) {
  return (arr || []).slice().sort((a, b) => {
    const fa = (a.followed != null ? a.followed : follow.isFollowed('leagues', a.leagueid)) ? 1 : 0;
    const fb = (b.followed != null ? b.followed : follow.isFollowed('leagues', b.leagueid)) ? 1 : 0;
    if (fa !== fb) return fb - fa;                                  // 关注置顶
    const ra = a.rank || 0, rb = b.rank || 0;
    if (ra !== rb) return rb - ra;                                  // S级优先
    const ta = a.startDate || a.latest || 0;
    const tb = b.startDate || b.latest || 0;
    return tb - ta;                                                 // 时间近的在前
  });
}

function groupByWeek(arr) {
  const map = {};
  const order = [];
  const undated = [];
  (arr || []).forEach((l) => {
    const start = l.startDate || l.earliest || l.latest || 0;
    if (!start) { undated.push(l); return; }
    const mon = weekMondayOf(start);
    if (!map[mon]) { map[mon] = []; order.push(mon); }
    map[mon].push(Object.assign({}, l, { wkDate: fmtMD(start) }));
  });
  order.sort((a, b) => a - b);
  const groups = order.map((mon) => {
    const end = mon + 6 * 86400;
    const leagues = map[mon].slice().sort((a, b) => (b.latest || 0) - (a.latest || 0));
    return { key: String(mon), label: fmtMD(mon) + '–' + fmtMD(end), leagues: leagues, undated: false };
  });
  if (undated.length) {
    groups.push({ key: 'undated', label: '未定档期', leagues: undated, undated: true });
  }
  return groups;
}

// 「全部」Tab 数据源合并（P0-1 / RC1）：
// allLeagues 仅含 OpenDota 已开赛赛事（真实 latest/status），upcomingList 含未来赛事
// （latest=0，如 TI / Major，OpenDota 暂无比赛记录）。两源按 leagueid 去重合并，
// allLeagues 优先（保留真实时间数据），仅存在于 upcomingList 的未来赛事补充进来，
// 确保「全部」能完整展示即将到来的赛事，而不只是「已结束+正在进行」。
function mergeAllWithUpcoming(allLeagues, upcomingList) {
  const seen = Object.create(null);
  const out = [];
  (allLeagues || []).forEach((x) => {
    const k = String(x.leagueid);
    if (!seen[k]) { seen[k] = true; out.push(x); }
  });
  (upcomingList || []).forEach((u) => {
    const k = String(u.leagueid);
    if (!seen[k]) { seen[k] = true; out.push(u); }
  });
  return out;
}

// 按 displayName（curation 规范名）去重：当 OpenDota 返回多个 leagueid 都映射到
// 同一规范名时（如 "EPL Masters 2026" + 另一变体 → 都是 "EPL Masters I"），
// 只保留数据最完整的一条（matchCount 最高 > 有 curation 覆盖 > 任意）。
// 用途：进行中 / 已结束 Tab 的去重（全部 Tab 已有 mergeAllWithUpcoming 按 leagueid 去重）。
function dedupeByDisplayName(arr) {
  const groups = Object.create(null);
  (arr || []).forEach((x) => {
    const key = x.displayName || x.name || ('' + x.leagueid);
    const prev = groups[key];
    if (!prev) { groups[key] = x; return; }
    // 选优：matchCount 高者优先；平局则选有 curation 元数据更丰富的（有 dateRange 说明赛期已解析）
    const aScore = (x.matchCount || 0) * 1000 + (x.dateRange ? 1 : 0) + (x.grade ? 1 : 0);
    const bScore = (prev.matchCount || 0) * 1000 + (prev.dateRange ? 1 : 0) + (prev.grade ? 1 : 0);
    if (aScore > bScore) groups[key] = x;
  });
  return Object.keys(groups).map((k) => groups[k]);
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
    // 1.3 排序模式：smart=智能排序（关注置顶+S级优先+时间）/ time=按时间倒序（默认）
    sortMode: 'time',
    gradeCounts: { all: 0, sss: 0, s: 0, a: 0, b: 0 },
    focusNode: null,       // 焦点卡（重点运营节点）：TI15 2026 上海
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
    updatedLabel: '',
    // ===== 战队筛选（spec A：多选 + 计数徽标 + 与 Tab×级别取交集）=====
    teamOptions: [],          // 弹层可选战队（来源：用户已关注战队）
    teamFilter: [],           // 已确认选中的战队 id 列表
    teamDraft: [],            // 弹层内草稿选中（取消不生效）
    teamPopup: false,         // 战队筛选弹层显隐
    teamFiltering: false,     // 确认后按战队聚合并联赛 id 的加载态
    teamActive: false,        // 战队筛选是否生效（用于空态「清除筛选」）
    teamLeagueIds: null,      // { [leagueid]: true } 选中战队参与过的联赛并集；null=不按战队过滤
    // ===== B 版：筛选抽屉 =====
    filterPanel: false,           // 筛选抽屉显隐
    activeFilterCount: 0,         // 生效的非默认筛选数量（「筛选」按钮角标）
    // ===== 1.2 视图切换：列表(list) / 周轴(week) =====
    viewMode: 'list',
    weekGroups: []            // 周轴分组：[{ key, label, leagues:[...], undated }]
  },

  onLoad() {
    this.allLeagues = [];     // 归一化后的全部 S 级及以上赛事（含时间窗口与状态）
    this.filtered = [];       // 当前 tab 筛选结果
    this.upcomingList = null;  // 即将到来列表（null=未加载，[]=已加载无结果）
    this.teamLeagueIds = null;
    this.loadLeagues();
    this.buildFocusNode();
    this.refreshTeamOptions();
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
        teamFilter: this.data.teamFilter
      });
    } catch (e) { /* 忽略存储异常 */ }
  },

  // I5：返回页面时还原视图状态（首次 onShow 跳过，避免覆盖 onLoad 的初始数据）
  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 1 });
    }
    this.buildFocusNode();
    this.refreshTeamOptions();
    if (this._restored) {
      let saved = null;
      try { saved = wx.getStorageSync(VIEW_KEY) || null; } catch (e) { saved = null; }
      if (saved) {
        const teamFilter = (saved.teamFilter && saved.teamFilter.length) ? saved.teamFilter : [];
        this.setData({
          filter: saved.filter || 'all',
          gradeFilter: saved.gradeFilter || 'all',
          teamFilter: teamFilter,
          teamActive: teamFilter.length > 0
          // teamLeagueIds 在页面实例存活期间保留于内存，无需从存储恢复
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
    // 从 curation（含 remoteCuration 热更新覆盖）取权威补充字段
    // 2026-07-27：传入 leagueId + game 上下文，启用 curation 引擎的
    //   ① leagueId 精确 pin（绕过别名漂移，避免把 CS2/低级别联赛误关联）
    //   ② game 跨游戏隔离（DOTA2 条目只能命中 DOTA2 联赛）
    const cur = remoteCuration.curatedEventFor(l.name, { leagueId: l.leagueid, game: 'dota2' });
    // 分级优先取 curation.tier（与详情页 sources.getLeagueTier 的 curation 输入一致），
    // 未配置时回退 util.unifiedTier（OpenDota tier 映射），保证列表与详情"赛段"一致。
    const curTier = (cur && cur.tier) ? cur.tier : null;
    let grade = curTier ? curTier.grade : ut.grade;
    // RC7 兜底：确保 grade 恒为大写（SSS/S/A/B），与 gradeMatch 的 toLowerCase 比对一致，
    // 避免 curation/外部源分级大小写异常导致静默漏筛。
    grade = (grade || 'S').toUpperCase();
    const rank = curTier ? curTier.rank : ut.rank;
    const label = curTier ? curTier.label : ut.label;
    const t = tagThemeOf(grade);
    const valve = (cur && cur.valve != null) ? cur.valve : tiers.flagValve(l.name);
    const topThirdParty = (cur && cur.topThirdParty != null) ? cur.topThirdParty : tiers.flagTopThirdParty(l.name);
    const defunct = !!(cur && cur.defunct);
    const w = win || {};
    // 传入 curation 日期范围（cur.start/cur.end），使 isOngoing() 的第二条判定路径生效：
    // 当 SQL 聚合的 lastEnd 因缓存陈旧（2h TTL）或进行中比赛 duration=0 未计入时，
    // 仍可依据 curation 的官方赛期正确判定"进行中"。
    // 2026-07-28：统一使用 util.validateLeagueWindow 校验归一化，与详情页 league-detail.js
    //   load() 共用同一函数，确保两页数据源完全一致，防止同类不一致 BUG 复发。
    const mixed = util.validateLeagueWindow({
      earliest: w.earliest || 0,
      latest: w.latest || 0,
      lastEnd: w.lastEnd || 0,
      startDate: (cur && cur.start) || null,
      endDate: (cur && cur.end) || null
    });
    // curation 显式状态硬覆盖：如果策展库明确标记「已结束」/「进行中」，
    // 信任人工维护的状态，不再依赖自动时间窗口判定（避免数据回填/修正导致误判）。
    let status = util.statusOf(mixed);
    if (cur && cur.status === '已结束') status = 'ended';
    else if (cur && cur.status === '进行中') status = 'ongoing';
    const badge = statusBadgeOf(status);
    // 展示名经 leagueDisplayName 单一出口解析（形状无关），与详情页口径一致，避免列表/详情不一致。
    const displayName = sources.leagueDisplayName(l);
    return {
      leagueid: l.leagueid,
      // 展示名走 curation 规范名覆盖（如 "EPL Masters 2026" → "EPL Masters I"）
      name: displayName || ('赛事 ' + l.leagueid),
      displayName: displayName,
      grade: grade,
      rank: rank,
      tierClass: 'tier-' + grade.toLowerCase(),
      label: label,
      displayLabel: tiers.displayOf(grade),   // 文档五档名：官方TI/S-Tier/A-Tier/区域赛/社区赛
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
      // 赛期优先用 curation 完整周期（mixed.startDate/endDate），无则回退真实比赛窗口。
      // 2026-07-28：回退分支使用 lastEnd（最晚结束时间）而非 latest（最晚开赛时间），
      //   与详情页 load() 的 mEnd = max(start_time + duration) 一致。
      //   mixed 已由 validateLeagueWindow 校验，lastEnd >= latest >= earliest 单调性保证。
      dateRange: (mixed.startDate && mixed.endDate)
        ? util.formatDateRange(mixed.startDate, mixed.endDate)
        : util.formatDateRange(mixed.earliest, (mixed.lastEnd || mixed.latest)),
      startDate: mixed.startDate,
      endDate: mixed.endDate,
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

  // ===== B 版：筛选抽屉控制 =====
  // 统计生效的非默认筛选数量，驱动「筛选」按钮角标
  syncFilterBadge() {
    const d = this.data;
    let n = 0;
    if (d.gradeFilter !== 'all') n++;
    if (d.sortMode === 'smart') n++;   // 默认 time；smart 作为「高级模式」计入非默认
    if (d.viewMode !== 'list') n++;
    n += (d.teamFilter && d.teamFilter.length) || 0;
    if (n !== d.activeFilterCount) this.setData({ activeFilterCount: n });
  },

  openFilterPanel() { this.setData({ filterPanel: true }); },
  closeFilterPanel() { this.setData({ filterPanel: false }); },

  // 重置等级/排序/视图/战队筛选为默认
  resetFilters() {
    this.teamLeagueIds = null;
    this.setData({
      filterPanel: false,
      gradeFilter: 'all',
      sortMode: 'time',
      viewMode: 'list',
      teamFilter: [],
      teamActive: false
    });
    this.applyAndSlice(true);
  },

  // 1.2 视图切换：列表 / 周轴（复用同一套筛选结果，仅改渲染维度）
  onToggleView(e) {
    const m = e.currentTarget.dataset.m;
    if (m === this.data.viewMode) return;
    this.setData({ viewMode: m });
    this.applyAndSlice(true);
  },

  // 1.3 切换排序模式（智能 / 时间）
  onToggleSort(e) {
    const m = e.currentTarget.dataset.m;
    if (m === this.data.sortMode) return;
    this.setData({ sortMode: m });
    this.applyAndSlice(true);
  },

  // ===== 战队筛选（spec A）=====
  // 来源：用户已关注战队（D-A2 取「用户已关注战队」，量级小、交互快）
  // 优化：用签名判断关注列表是否变化，未变则跳过 setData（避免 onShow 重复开销）
  refreshTeamOptions() {
    const followed = follow.list('teams') || [];
    // 用 id+name 拼接作为签名，快速判断是否有变化
    const sig = followed.map((t) => t.id + ':' + (t.name || '')).join('|');
    if (this._lastTeamSig === sig) return;  // 未变化，跳过 setData
    this._lastTeamSig = sig;
    const options = followed.map((t) => ({
      id: String(t.id),
      name: t.name || ('战队 ' + t.id),
      tag: t.tag || (t.name || '?').slice(0, 3).toUpperCase()
    }));
    this.setData({ teamOptions: options });
  },

  openTeamFilter() {
    this.setData({ teamPopup: true, teamDraft: this.data.teamFilter.slice() });
  },

  closeTeamFilter() {
    this.setData({ teamPopup: false });
  },

  // 弹层内勾选切换（草稿态，取消不生效）
  onTeamCheck(e) {
    const id = String(e.currentTarget.dataset.id);
    const draft = this.data.teamDraft.slice();
    const i = draft.indexOf(id);
    if (i >= 0) draft.splice(i, 1);
    else draft.push(id);
    this.setData({ teamDraft: draft });
  },

  selectAllTeams() {
    this.setData({ teamDraft: this.data.teamOptions.map((t) => t.id) });
  },

  clearTeamDraft() {
    this.setData({ teamDraft: [] });
  },

  // 确认：按选中战队（OR 逻辑）聚合它们参与过的联赛 id 并集，再与当前结果取交集。
  // 数据来源 api.getTeamMatches(teamId) 含 leagueid，经本地缓存层（10min）避免重复请求。
  confirmTeamFilter() {
    const draft = this.data.teamDraft.slice();
    this.setData({ teamPopup: false });
    if (!draft.length) {
      // 未选任何战队 = 清除筛选
      this.teamLeagueIds = null;
      this.setData({ teamFilter: [], teamActive: false });
      this.applyAndSlice(true);
      return;
    }
    if (draft.length === this.data.teamFilter.length && draft.every((id) => this.data.teamFilter.indexOf(id) >= 0)) {
      // 与已生效筛选一致，无需重新聚合
      return;
    }
    wx.showLoading({ title: '聚合战队赛事...', mask: true });
    Promise.all(draft.map((id) => api.getTeamMatches(id).catch(() => [])))
      .then((lists) => {
        const map = {};
        lists.forEach((ms) => (ms || []).forEach((m) => {
          if (m.leagueid != null) map[m.leagueid] = true;
        }));
        this.teamLeagueIds = map;
        this.setData({ teamFilter: draft, teamActive: true, teamFiltering: false });
        this.applyAndSlice(true);
        wx.hideLoading();
      })
      .catch(() => {
        this.setData({ teamFiltering: false });
        wx.hideLoading();
        wx.showToast({ title: '战队筛选失败，请重试', icon: 'none' });
      });
  },

  clearTeamFilter() {
    this.teamLeagueIds = null;
    this.setData({ teamFilter: [], teamActive: false });
    this.applyAndSlice(true);
  },

  // 空态动作：战队筛选生效时提供「清除筛选」入口（spec A.AC-A4）
  onEmptyAction() {
    if (this.data.teamActive) this.clearTeamFilter();
  },

  // 弹层内容区点击：阻止冒泡到遮罩关闭
  noop() {},

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
        // 2026-07-28 修复：endDate 使用 lastEnd（最晚结束时间 = start_time + duration），
        //   而非 latest（最晚开赛时间），与详情页 league-detail.js load() 和
        //   loadLeagueEntry 的回退分支一致，避免列表赛期少算最后一场 duration。
        //   数据校验：lastEnd 为 0 时回退 latest（纯未来赛未打 duration=0，lastEnd=latest）。
        const endT = (item._win && (item._win.lastEnd || item._win.latest)) || null;
        const daysToStart = Math.ceil((er - nowSec) / 86400);
        results.push(Object.assign({}, item, {
          startDate: er,
          endDate: endT,
          status: 'upcoming',
          statusText: '即将到来',
          statusColor: statusBadgeOf('upcoming').color,
          dateRange: util.formatDateRange(er, endT),
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
    this.syncFilterBadge();
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
      arr = dedupeByDisplayName((this.allLeagues || []).filter((x) => x.status === 'ongoing' && gradeMatch(x)));
    } else if (f === 'ended') {
      // 已结束：直接信任归一化时计算的 status（statusOf 已用真实结束时间 + 缓冲判定）。
      // 移除冗余的「末场开赛须早于 7 天前」cutoff：短期赛事（1–2 天赛程）打完不久时，
      // latest(末场开赛) 尚未超过 7 天，会被错误剔除，导致既不在「正在进行」也不在
      // 「已结束」、只在「全部」能看到（RC2/RC3）。SQL 窗口已限定近 1 年，无需再 cutoff。
      arr = dedupeByDisplayName((this.allLeagues || []).filter((x) => x.status === 'ended' && gradeMatch(x)));
    } else {
      // 全部：allLeagues（已结束+正在进行）+ upcomingList（未来赛事）按 leagueid 去重合并，
      // 未来赛事（OpenDota 暂无比赛记录）一并展示（RC1 / P0-1）。
      arr = mergeAllWithUpcoming(this.allLeagues, this.upcomingList).filter(gradeMatch).slice();
    }
    // 排序：默认按时间倒序；智能排序（关注置顶 + S级优先 + 时间）为高级模式
    if (this.data.sortMode === 'smart') {
      arr = sortSmart(arr);
    } else {
      const tkey = (x) => (f === 'upcoming' ? (x.startDate || x.latest || 0) : (x.latest || 0));
      if (f === 'upcoming') {
        // 即将：按开赛时间从近到远（升序），越近的赛事越靠上
        arr.sort((a, b) => tkey(a) - tkey(b));
      } else {
        // 其他：按最新时间从近到远（降序）
        arr.sort((a, b) => tkey(b) - tkey(a));
      }
    }

    // 战队筛选：取选中战队「参与过的联赛并集」（OR 逻辑，非 AND）与当前结果取交集
    // （spec A.AC-A3：列表仅显示参赛方含选中战队中任一方的赛事）
    const tl = this.teamLeagueIds;
    if (tl) {
      arr = arr.filter((x) => tl[x.leagueid]);
    }

    // 1.2 周轴视图：按周聚合（含 defunct → 未定档期），不分页
    if (this.data.viewMode === 'week') {
      this.setData({ weekGroups: groupByWeek(arr), hasMore: false });
      return;
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

  // P1/RC4：列表底部「加载更多」按钮兜底，不依赖 onReachBottom 触底
  // （吸顶条/自定义滚动容器遮挡时，触底永不触发，第 31 条以后不加载）。
  onLoadMore() {
    if (this.data.hasMore && !this.data.loading && !this.data.upcomingLoading) {
      this.appendPage();
    }
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
    let id = e.currentTarget.dataset.id;
    const name = e.currentTarget.dataset.name;
    // 复发防护（2026-07-27）：若同一展示名存在多条联赛（curation 别名漂移导致），
    // 优先跳转数据最完整（matchCount 最高）的那条，避免落入低级别/占位联赛看到错位队伍。
    // 列表本身已按 dedupeByDisplayName 去重，此处主要兜底深层链接/缓存/其它入口传入的次级 id。
    const arr = this.allLeagues || [];
    const nid = Number(id);
    if (nid > 0 && arr.length) {
      const self = arr.find((x) => Number(x.leagueid) === nid);
      if (self && self.displayName) {
        const peers = arr.filter((x) => x.displayName === self.displayName && Number(x.leagueid) !== nid);
        if (peers.length) {
          const best = peers.reduce((a, b) => ((b.matchCount || 0) > (a.matchCount || 0) ? b : a));
          if ((best.matchCount || 0) > (self.matchCount || 0)) id = best.leagueid;
        }
      }
    }
    wx.navigateTo({
      url: '/subpackages/detail/league-detail/league-detail?leagueId=' + id + '&name=' + encodeURIComponent(name)
    });
  },

  // 「重点运营节点」焦点卡：当前锁定 TI15 2026 上海（Valve 官方年度旗舰）。
  // 纯本地 curation 数据驱动，无需网络；TI 结束后自动隐藏（避免展示过期焦点）。
  // 复用 curation 规范名解析，与赛事详情页 curation 兜底一致；fakeId 与
  // mergeCurationUpcoming 命名归一逻辑相同，保证关注态与「即将到来」列表互通。
  buildFocusNode() {
    // 焦点赛事：按 canonical 字面名查找，无 leagueId 上下文；显式声明 game 防跨游戏污染。
    const cur = remoteCuration.curatedEventFor(FOCUS_EVENT_CANONICAL, { game: 'dota2' });
    if (!cur || !cur.start) {
      if (this._lastFocusSig !== 'null') { this._lastFocusSig = 'null'; this.setData({ focusNode: null }); }
      return;
    }
    const nowSec = Math.floor(Date.now() / 1000);
    const start = cur.start;
    const end = cur.end || (cur.start + 10 * 86400);
    // TI 结束后不再展示焦点卡
    if (nowSec > end) {
      if (this._lastFocusSig !== 'ended') { this._lastFocusSig = 'ended'; this.setData({ focusNode: null }); }
      return;
    }
    const isLive = nowSec >= start && nowSec <= end;
    const daysToStart = Math.ceil((start - nowSec) / 86400);
    // 稳定的负数 id（与 mergeCurationUpcoming 命名归一逻辑一致）
    let hash = 0;
    const k = (cur.canonical || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    for (let j = 0; j < k.length; j++) { hash = ((hash << 5) - hash + k.charCodeAt(j)) | 0; }
    const fakeId = -(Math.abs(hash) % 1000000 + 1000000);
    const followed = follow.isFollowed('leagues', fakeId);
    // 签名：只有「是否直播 + 距开赛天数 + 关注态」变化时才 setData
    // 这三个是用户可感知的状态，其余字段（name/dateRange 等）恒定不变
    const sig = isLive + '|' + daysToStart + '|' + followed;
    if (this._lastFocusSig === sig) return;  // 状态未变，跳过 setData
    this._lastFocusSig = sig;
    this.setData({
      focusNode: {
        leagueid: fakeId,
        name: cur.canonical,
        canonical: cur.canonical,
        start: start,
        end: end,
        dateRange: util.formatDateRange(start, end),
        prizePool: cur.prizePool ? String(cur.prizePool) : '',
        location: cur.region || '上海',
        valve: true,
        isLive: isLive,
        daysToStart: daysToStart,
        followed: followed
      }
    });
  },

  // 焦点卡点击：进入赛事详情（curation-only 赛事由详情页兜底渲染）
  openFocus(e) {
    const id = e.currentTarget.dataset.id;
    const name = e.currentTarget.dataset.name;
    wx.navigateTo({
      url: '/subpackages/detail/league-detail/league-detail?leagueId=' + id + '&name=' + encodeURIComponent(name)
    });
  }
});
