const api = require('../../utils/api.js');
const util = require('../../utils/util.js');
const follow = require('../../utils/follow.js');
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

// 状态 -> 中文标签 + 颜色（v11 品牌声音 §2.6：竞技场风格文案）
function statusBadgeOf(status) {
  if (status === 'ongoing') return { text: '正在交锋', color: '#1ec896' };
  if (status === 'upcoming') return { text: '即将到来', color: '#ffcf5c' };
  return { text: '战局已定', color: '#6b7280' };
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
// 排序键：① followed（关注置顶）→ ② grade rank（S>A>B>C）→ ③ 时间（近的在前）。
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
  const nameSeen = Object.create(null);
  const normName = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/^the/, '');
  const out = [];
  (allLeagues || []).forEach((x) => {
    const k = String(x.leagueid);
    if (!seen[k]) { seen[k] = true; out.push(x); nameSeen[normName(x.displayName || x.name)] = true; }
  });
  (upcomingList || []).forEach((u) => {
    const k = String(u.leagueid);
    if (seen[k]) return;            // 同 leagueid 已收录
    // 防重复卡：curation 未来赛事用负数 fakeId，若其规范名已存在于 allLeagues（真实已开赛赛事），
    // 说明是同一赛事的两条记录，优先保留真实数据那条，跳过 curation 占位（收录错误：重复卡片）。
    if (nameSeen[normName(u.displayName || u.name)]) return;
    seen[k] = true; out.push(u);
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
// 赛程卡片的真实状态：按日期窗口判定「进行中」还是「即将到来」，
// 避免已开赛的 Liquipedia 赛事（如 1win Essence II）因 status 被硬编码为 'upcoming'
// 而永远进不了「进行中」tab（end + 1天宽限，与 util.isOngoing 路径②口径一致）。
function upcomingCardStatus(entry, now) {
  const s = entry.start || 0;
  const e = entry.end || 0;
  if (s && e && now >= s && now <= e + 86400) return 'ongoing';
  return 'upcoming';
}
function buildUpcomingCard(entry, ctx) {
  const now = ctx.now;
  const lid = ctx.lid != null ? String(ctx.lid) : String(entry.id);
  const matched = (ctx.allLeagues || []).find((x) => String(x.leagueid) === lid);
  const grade = entry.grade || (matched && matched.grade) || 'S';
  const rank = entry.rank || (matched && matched.rank) || 3;
  const label = entry.label || (matched && matched.label) || 'S级';
  const name = entry.name || (matched && matched.name) || '';
  const daysToStart = Math.ceil((entry.start - now) / 86400);
  const cardStatus = upcomingCardStatus(entry, now);
  const cardBadge = statusBadgeOf(cardStatus);
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
    status: cardStatus,
    statusText: cardBadge.text,
    statusColor: cardBadge.color,
    dateRange: util.formatDateRange(entry.start, entry.end),
    daysToStart: daysToStart,
    countdownText: cardStatus === 'ongoing' ? '正在交锋' : (daysToStart <= 0 ? '今日开赛' : (daysToStart === 1 ? '明天开赛' : daysToStart + ' 天后开赛')),
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
    loadingMore: false,    // 2026-08-07（v1.3）：下一页加载态，驱动底部提示条三态切换
    armedMore: false,      // 2026-08-07（v1.4）：触底确认态（ARMED）——提示条高亮，点击才真正加载
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
    // 2026-08-07（v1.4）：缓存屏幕高度，供 onPageScroll 检测「上滚超一屏」解除 ARMED 态
    try {
      const sysInfo = wx.getSystemInfoSync();
      this._winH = sysInfo.windowHeight || sysInfo.screenHeight || 667;
    } catch (e) { this._winH = 667; }
    // 2026-08-07（v1.1，B 层渲染分阶段优化）：
    //   _normalizeGen 代际标记——onHide / onPullDownRefresh / retry 时递增，
    //   让阶段 2 后台补全的 setTimeout 链在下一个检查点自动放弃（防竞态 + 防死锁）。
    //   _normalizeDone 表示全量 normalize 是否已完成（阶段 2 跑完置 true）。
    this._normalizeGen = 0;
    this._normalizeDone = true;   // 首次 loadLeagues 调用前先设 true，避免守卫拦截
    this.loadLeagues();
    this.buildFocusNode();
    // Phase 1-④：refreshTeamOptions 延迟到首次点击战队筛选按钮（openTeamFilter）
    // 收益：赛事列表启动 -50ms（跳过 follow.list 同步读 + 数组遍历 + setData）
  },

  onPullDownRefresh() {
    // 下拉强制刷新：清掉赛事列表与时间窗口缓存后重新拉取
    // O-2（2026-08-15）：改用 api.invalidateLeagues() 封装，复用写入侧完全一致的
    //   _v() 版本前缀 + sqlFragments.LEAGUE_WINDOWS_SQL，根治 key 漂移导致删不到旧缓存。
    //   旧实现 cache.remove('/leagues|{}') 缺版本前缀 + 手拼 SQL 缺 last_end，均失效。
    api.invalidateLeagues();
    this.upcomingList = null;
    this.setData({ page: 0 });
    this.loadLeagues(() => wx.stopPullDownRefresh());
  },

  // 2026-08-07（v1.2→v1.3→v1.4→v1.4.2）：
  //   第一次触底 → 进入 ARMED 确认态（提示条高亮「上拉或点击加载」），不加载。
  //   ARMED 态下用户上滑一段再下滑回来（微下拉手势）→ onPageScroll 检测到即触发加载。
  //   上滚超过一屏 → 解除 ARMED（视为放弃意图）。
  //   点击提示条 → 直接加载（零等待路径，不经 ARMED）。
  onReachBottom() {
    if (!this.data.hasMore || this.data.loading || this.data.upcomingLoading) return;
    if (this.data.loadingMore || this.data.armedMore) return;
    this._armedScrollTop = this._scrollTop || 0;
    this._armedMinScroll = this._armedScrollTop;  // 追踪 ARMED 后用户上滑的最低点
    this.setData({ armedMore: true });
  },

  // I5：记录页面滚动位置（不写 setData，避免滚动时频繁刷新）
  // v1.4.2：ARMED 态下检测「微下拉手势」——用户上滑一小段后回滑，
  //   只要回滑到接近底部（距底 < 屏幕高度的 25%）就触发加载，无需完全滑回底部。
  //   同时检测「上滚超一屏」解除 ARMED（用户放弃加载意图）。
  onPageScroll(e) {
    this._scrollTop = e.scrollTop;
    if (!this.data.armedMore || !this._armedScrollTop) return;

    const winH = this._winH || 667;
    // 追踪用户上滑的最低点（scrollTop 最小值）
    if (e.scrollTop < this._armedMinScroll) this._armedMinScroll = e.scrollTop;

    // ① 检测「上滚超一屏」→ 解除 ARMED（用户放弃加载意图）
    const base = Math.min(winH, this._armedScrollTop);
    if (e.scrollTop < this._armedScrollTop - base) {
      this.setData({ armedMore: false });
      this._armedScrollTop = 0;
      this._armedMinScroll = 0;
      return;
    }

    // ② 检测「微下拉手势」→ 触发加载
    // 条件：用户上滑过（最低点比触底位置小至少 20px），且当前回滑到接近底部（距底 < 25% 屏高）。
    // 20px 的上滑门槛防手指微抖误触；25% 屏高的接近阈值让回滑动作不需精确对准底部。
    if (this._armedMinScroll < this._armedScrollTop - 20 &&
        e.scrollTop > this._armedScrollTop - winH * 0.25) {
      this.appendPageSafe();
    }
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
    // P1-1：离开页面取消所有进行中的元数据增强链（代际递增，旧链在下一个检查点放弃）
    this._metaGen = (this._metaGen || 0) + 1;
    this._metaEnriching = false;
    // 2026-08-07（v1.1）：同时取消阶段 2 后台 normalize 链，防 setTimeout 泄漏
    this._normalizeGen = (this._normalizeGen || 0) + 1;
    // 2026-08-07（v1.3）：清理加载更多的节流锁和 loadingMore 态
    this._lastAppendAt = 0;
    if (this.data.loadingMore) this.setData({ loadingMore: false });
    // 2026-08-07（v1.4）：离开页面清理 ARMED 确认态
    this._armedScrollTop = 0;
    this._armedMinScroll = 0;
    if (this.data.armedMore) this.setData({ armedMore: false });
    // 2026-08-13（「即将」加载优化 · P0）：离开页面递增 upcoming 代际 + 清超时 timer，
    // 让挂起的云函数调用 / 超时回调在 gen 检查点自动放弃（防晚到结果写入 + setTimeout 泄漏）
    this._upcomingGen = (this._upcomingGen || 0) + 1;
    if (this._upcomingTimer) { clearTimeout(this._upcomingTimer); this._upcomingTimer = null; }
    // 2026-08-13（焦点卡动态化 · P1）：页面隐藏时停止 30s 焦点刷新定时器
    this._stopFocusTimer();
  },

  // I5：返回页面时还原视图状态（首次 onShow 跳过，避免覆盖 onLoad 的初始数据）
  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 1 });
    }
    this.buildFocusNode();
    // 2026-08-13（焦点卡动态化 · P1）：页面可见期间每 30s 刷新焦点卡
    // （跨开赛/结束时刻自动更新 + 焦点自动轮替），onHide 停止
    this._startFocusTimer();
    // Phase 1-④：refreshTeamOptions 延迟到首次点击战队筛选按钮（openTeamFilter）
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

  // 2026-08-07（v1.1，B 层渲染分阶段优化）：
  //   阶段 1 · normalizeLite —— 只算排序/筛选必需的「轻」字段（followed/rank/grade/latest/status/
  //   name/displayName/leagueid），跳过最重的 remoteCuration.curatedEventFor() 和 upcoming-local
  //   赛期查找。排序键与最终 sortSmart/时间排序完全对齐，零跳变。立即 setData 首屏可见。
  //   阶段 2 · normalizeFull —— setTimeout(0) 让出主线程后，对每条赛事跑完整 normalize 补齐
  //   奖金池/赛期/标签等剩余字段，完成后自动触发 applyAndSlice(true) 刷新视图。
  //   _normalizeGen 代际标记防竞态：onHide / 重拉 时递增，让阶段 2 旧链自动放弃。
  normalizeLite(l, win) {
    // 轻量 normalize：只用 util.unifiedTier（OpenDota tier 映射，无网络/无 curation），
    // 不调 remoteCuration.curatedEventFor()（最重的遍历，单条 1-3ms × 150-300 条 = 150-900ms）。
    if (!l || !l.leagueid) return null;
    const ut = util.unifiedTier(l);
    const grade = (ut.grade || 'S').toUpperCase();
    const rank = ut.rank || 0;
    const w = win || {};
    const latest = w.latest || 0;
    const earliest = w.earliest || 0;
    const lastEnd = w.lastEnd || 0;
    // 状态判定：阶段 1 不查 curation 显式覆盖（最简路径），只用 OpenDota 时间窗。
    // 阶段 2 完成后会用 curation 状态硬覆盖修正，短暂的不精确可接受（< 300ms）。
    const status = util.statusOf({ earliest: earliest, latest: latest, lastEnd: lastEnd, startDate: null, endDate: null });
    const displayName = sources.leagueDisplayName(l);
    return {
      leagueid: l.leagueid,
      name: displayName || ('赛事 ' + l.leagueid),
      displayName: displayName,
      grade: grade,
      rank: rank,
      tierClass: 'tier-' + grade.toLowerCase(),
      label: ut.label,
      displayLabel: tiers.displayOf(grade),
      source: ut.source,
      tagTheme: tagThemeOf(grade).theme,
      tagVariant: tagThemeOf(grade).variant,
      followed: follow.isFollowed('leagues', l.leagueid),
      earliest: earliest,
      latest: latest,
      matchCount: w.count || 0,
      status: status,
      statusText: statusBadgeOf(status).text,
      statusColor: statusBadgeOf(status).color,
      // 阶段 1 标记：表示此条尚未跑完整 normalize（阶段 2 会重写整个对象）。
      // 卡片渲染依赖的字段（name/grade/status/dateRange）阶段 1 已基本齐全，
      // 唯一缺失的是精确赛期 dateRange——先用混合窗口粗略日期兜底，阶段 2 修正。
      startDate: null,
      endDate: null,
      dateRange: (earliest && lastEnd) ? util.formatDateRange(earliest, lastEnd) : '',
      prizePool: null,
      organizer: null,
      region: null,
      format: null,
      valve: false,
      topThirdParty: false,
      defunct: false,
      _metaEnriched: true,    // 阶段 1 期间不触发 enhanceListMetadata（字段不全，请求无意义）
      _lite: true             // 标记：阶段 2 检查此字段决定是否需要补全
    };
  },

  loadLeagues(cb) {
    this.setData({ loading: true, error: '' });
    // 2026-08-07（v1.1，B 层渲染分阶段优化）：
    //   新一轮拉取前递增代际，让上一轮阶段 2 的 setTimeout 链自动放弃。
    //   _normalizeDone 置 false 表示阶段 2 还未完成（守卫用）。
    this._normalizeGen = (this._normalizeGen || 0) + 1;
    const gen = this._normalizeGen;
    this._normalizeDone = false;

    // 并行拉赛事元数据 + 时间窗口（explorer 一条 SQL 拿全部）
    Promise.all([api.getLeagues(), api.getLeagueWindows()])
      .then((res) => {
        if (gen !== this._normalizeGen) return;   // 已被新一轮拉取取代，放弃
        const list = res[0] || [];
        const windows = res[1] || {};

        // ===== 阶段 1 · 快速路径（normalizeLite 全量）=====
        // 对全量赛事跑轻量 normalize（只用 util.unifiedTier + follow.isFollowed，
        // 跳过最重的 remoteCuration.curatedEventFor 和赛期查找）。
        // 单条约 0.1-0.3ms，全量 300 条 ~30-90ms，可在阶段 1 同步完成，
        // 切 tab 也有全量数据可用，零竞态。
        // 排序键 followed/rank/latest 已全部算出，与最终 sortSmart/时间排序完全对齐，零跳变。
        this._leagueMap = {};
        this.allLeagues = list
          .map((l) => this.normalizeLite(l, windows[l.leagueid]))
          .filter((x) => x && x.rank >= 1);
        this.allLeagues.forEach((x) => { this._leagueMap[x.leagueid] = x; });
        this.updateGradeCounts();
        this.applyAndSlice(true);
        const at = api.fetchedAtOf('leagueWindows') || api.fetchedAtOf('leagues');
        this.setData({ loading: false, updatedAt: at, updatedLabel: util.formatAgo(at) });
        cb && cb();

        // ===== 阶段 2 · 后台补全（setTimeout 让出主线程，分批 normalizeFull）=====
        // 对每条赛事跑完整 normalize（包含 curation、赛期查找等重逻辑），
        // 覆盖 _leagueMap 中对应的 lite 结果（_lite: false）。
        const allItems = list;     // 全量，不切片
        const BATCH = 50;          // 每批最多处理条数（让出主线程节奏）
        let i = 0;
        const next = () => {
          if (gen !== this._normalizeGen) return;   // 已被取代，放弃
          const end = Math.min(i + BATCH, allItems.length);
          for (; i < end; i++) {
            const l = allItems[i];
            const full = this.normalize(l, windows[l.leagueid]);
            if (full && full.rank >= 1) {
              this._leagueMap[full.leagueid] = full;
            }
          }
          if (i < allItems.length) {
            setTimeout(next, 0);   // 让出主线程，继续下一批
          } else {
            // 全量完成：组装 allLeagues 并触发一次刷新
            this.allLeagues = Object.keys(this._leagueMap)
              .map((k) => this._leagueMap[k])
              .filter((x) => x && x.rank >= 1);
            this._normalizeDone = true;
            this.updateGradeCounts();
            // 当前 tab 不是 upcoming 时才刷新（upcoming 走独立数据源 upcomingList）
            if (this.data.filter !== 'upcoming') {
              this.applyAndSlice(true);
            }
            // 阶段 2 完成后启动元数据增强（此时字段齐全，enhanceListMetadata 才有意义）
            this.enhanceListMetadata();
          }
        };
        // 用 setTimeout(0) 启动阶段 2，确保阶段 1 的 setData 先渲染到屏幕
        setTimeout(next, 0);
      })
      .catch(() => {
        this.setData({ loading: false, error: '加载失败，请检查网络或域名配置（开发阶段可勾选「不校验合法域名」）' });
        this._normalizeDone = true;   // 出错也算「完成」，避免守卫永久拦截
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
    // 修复：原 `(grade || 'S')` 会在 curation 分级缺失时把任意赛事静默提升为 S 级；
    // 改为回退到 unifiedTier 的 OpenDota 枚举值（恒为有效等级），杜绝误升 S（收录错误）。
    grade = (grade || ut.grade).toUpperCase();
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
    // curation 显式状态硬覆盖（2026-08-14 方案 B：加时间窗口守卫）：
    //   原实现无条件信任 curation status，导致人工初值过期后赛事卡死为「僵尸进行中」
    //   （如 EPL Masters I 标记"进行中"但实际已结束 2 天仍显示 ongoing）。
    //   修正原则：curation status 是「人工初值」，只能把状态往前推（加速到位），
    //   不能卡住状态不让它随时间流转。
    //     ①「已结束」是终态，永远信任（人工主动标记，不会误伤进行中赛事）；
    //     ②「进行中」仅在时间窗口仍支持时才覆盖（防僵尸）；
    //     ③「即将到来」仅在开赛时间确实还在未来窗口内才覆盖（防过期预告）。
    //   与 league-detail.js _renderLocalSkeleton / load() 两处保持字节级一致。
    let status = util.statusOf(mixed);
    if (cur && cur.status === '已结束') {
      status = 'ended';
    } else if (cur && cur.status === '进行中') {
      if (util.isOngoing(mixed)) status = 'ongoing';
    } else if (cur && cur.status === '即将到来') {
      if (util.isUpcoming(mixed)) status = 'upcoming';
    }
    // 展示名经 leagueDisplayName 单一出口解析（形状无关），与详情页口径一致；
    // 提前在此声明，供下方赛期快照名称匹配复用（避免 TDZ 引用错误）。
    const displayName = sources.leagueDisplayName(l);
    // 赛期日期计算（提前到 return 外，避免对象字面量内 let 声明语法错误）
    // 优先级（2026-07-30 修正「本末倒置」：以 Liquipedia 正确时间为准）：
    //   ① curation 完整周期（人工策展，最高权威）
    //   ② 🆕 upcoming-local.json 官方赛期（Liquipedia 正确时间，主力）
    //   ③ OpenDota 比赛窗口（仅当 Liquipedia 也无对应赛事时兜底）
    let _drStart = mixed.startDate, _drEnd = mixed.endDate;
    if (!(_drStart || _drEnd)) {
      // ② Liquipedia 快照（官方赛期，主力）— 以 Liquipedia 正确时间为准
      let _fromSnap = null;
      try {
        // 2026-07-30 修复：优先用 JS 包装模块（稳定可靠），回退到 JSON
        let _snap;
        try { _snap = require('../../utils/upcoming-local-data.js'); }
        catch (_e) { _snap = require('../../utils/upcoming-local.json'); }
        if (_snap && _snap.events) {
          const _dn = (displayName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
          const _hit = _snap.events.find((e) => {
            const _en = (e.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
            return _en && (_en === _dn || _dn.indexOf(_en) >= 0 || _en.indexOf(_dn) >= 0);
          });
          if (_hit && _hit.start && _hit.end) _fromSnap = { start: _hit.start, end: _hit.end };
        }
      } catch (_e) { /* local snapshot 缺失时静默跳过 */ }
      if (_fromSnap) {
        _drStart = _fromSnap.start; _drEnd = _fromSnap.end;
      } else {
        // ③ OpenDota 比赛窗口兜底（Liquipedia 无对应赛事时）
        _drStart = mixed.earliest; _drEnd = mixed.lastEnd || mixed.latest;
      }
    }
    const badge = statusBadgeOf(status);
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
      // 赛期优先级（与详情页 league-detail.js load() eventWindow 构建一致）：
      //   ① curation 完整周期 → ② 真实比赛窗口 → ③ upcoming-local.json 快照（_drStart/_drEnd 已预计算）
      // 2026-07-28：回退分支使用 lastEnd（最晚结束时间）而非 latest（最晚开赛时间），
      //   与详情页 load() 的 mEnd = max(start_time + duration) 一致。
      //   mixed 已由 validateLeagueWindow 校验，lastEnd >= latest >= earliest 单调性保证。
      // 2026-07-30 修复列表页赛期截断：OpenDota 已收录赛事的比赛窗口可能集中在同一天
      //   （如 1win Essence II 3 场均在 7/30），导致 formatDateRange 显示 "7/30 ~ 7/30"。
      //   _drStart/_drEnd 在 return 前已通过 upcoming-local.json 快照回退修正。
      dateRange: (_drStart && _drEnd) ? util.formatDateRange(_drStart, _drEnd) : '',
      startDate: mixed.startDate,  // 保留原始 curation 日期供其他逻辑使用
      endDate: mixed.endDate,
      // 2026-07-30 列表元数据增强：从 curation 权威库传递奖金池/主办方/地点/赛制（零网络）
      prizePool: (cur && cur.prizePool) || null,
      organizer: (cur && cur.organizer) || null,
      region: (cur && cur.region) || null,
      format: (cur && cur.format) || null,
      // Liquipedia 异步增强标记：curation 已覆盖的不再重复请求
      _metaEnriched: !!(cur && (cur.prizePool || cur.organizer || cur.region)),
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
    // Phase 1-④：延迟构建战队选项，首次打开弹层时才执行
    // refreshTeamOptions 内部有签名守卫，关注列表未变化时直接 return，开销极小
    this.refreshTeamOptions();
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
    // 2026-08-13（「即将」加载优化 · P0 防死锁）：代际标记 + 超时兜底。
    //   之前：tryCloudUpcoming 的 callFunction 若挂起（云函数冷缓存现场预热 30-60s），
    //   upcomingLoading 永不复位，用户切走再切回 → loadUpcoming 短路 → 永远卡 spinner。
    //   现在：8s 超时后走 finishUpcoming（本地快照兜底），gen 递增丢弃晚到云函数结果。
    this._upcomingGen = (this._upcomingGen || 0) + 1;
    const gen = this._upcomingGen;
    this.setData({ upcomingLoading: true, upcomingProgress: '准备查询赛程...' });
    if (this._upcomingTimer) { clearTimeout(this._upcomingTimer); }
    this._upcomingTimer = setTimeout(() => {
      if (gen !== this._upcomingGen) return;   // 已被新链路取代，放弃
      this.finishUpcoming('云函数超时，使用本地赛程', gen);
    }, config.leagueWindow.upcomingTimeoutMs);

    // 赛程数据源回退链：云函数预热缓存 → 本地预构建快照 → 串行查询（OpenDota + curation）
    // 任一层命中即用其数据，无需后续层；保证「即将到来」在任意部署形态下都不为空。
    this.tryCloudUpcoming(gen).then((hit) => {
      if (gen !== this._upcomingGen) return;   // 已被超时/新链路取代，丢弃
      if (this._upcomingTimer) { clearTimeout(this._upcomingTimer); this._upcomingTimer = null; }
      if (hit) return;
      return this.tryLocalUpcoming().then((hit2) => {
        if (gen !== this._upcomingGen) return;
        if (hit2) return;
        this.loadUpcomingSerial();
      });
    });
  },

  // 2026-08-13（「即将」加载优化 · P0 防死锁）：超时/降级兜底——本地快照 + curation 注入。
  // 与 tryLocalUpcoming 复用同一数据源，但保证在任何路径下 upcomingLoading 都能复位
  // （tryLocalUpcoming 的 events 为空时会 return false 且不复位，超时路径必须兜底）。
  finishUpcoming(reason, gen) {
    if (gen !== this._upcomingGen) return;
    if (this._upcomingTimer) { clearTimeout(this._upcomingTimer); this._upcomingTimer = null; }
    this.tryLocalUpcoming().then((hit) => {
      if (gen !== this._upcomingGen) return;
      if (!hit) {
        // 本地快照为空：串行查询兜底（其内部各分支都会复位 upcomingLoading）
        this.loadUpcomingSerial();
      }
    });
  },

  // 尝试从云函数读取预热的赛程缓存。命中返回 true，未命中/失败返回 false。
  // 2026-08-13（P0-2 判空 + P1-1 gen）：① gen 参数——超时/新链路后丢弃晚到结果；
  //   ② 判空修正——云函数冷缓存 fire-and-forget 后返回 {data:{}, source:'cold'}，
  //   空对象是 truthy，原 `!result.data` 判不出 → 会把空列表当命中。改为键数判空。
  tryCloudUpcoming(gen) {
    if (!cloudProxy.isAvailable()) return Promise.resolve(false);
    return wx.cloud.callFunction({ name: 'aggregation', data: { action: 'getUpcomingSchedule' } })
      .then((res) => {
        if (gen != null && gen !== this._upcomingGen) return false;   // 已被超时/新链路取代
        const result = res && res.result;
        if (!result || result.error || !result.data) return false;
        if (Object.keys(result.data).length === 0) return false;      // 冷缓存空 data = miss
        const schedule = result.data; // { id: { id, name, grade, rank, label, tier, start, end, source } }
        const now = util.nowSec();
        const horizon = now + config.leagueWindow.upcomingRangeSec;
        const results = [];
        Object.keys(schedule).forEach((lid) => {
          const s = schedule[lid];
          if (!s || !s.start) return;
          // 关键修复：保留「未结束」的赛事（含已开赛的进行中赛事），不再用 start > now
          // 把已开赛的 Liquipedia 赛事（如 1win Essence II）排除掉。end 缺失时按 start 在
          // 视野内放行（无法判定是否结束），避免误杀。
          if (s.start <= horizon && (!s.end || s.end >= now)) {
            // 复用 buildUpcomingCard 统一构造（STRATZ 真实联赛 id 经 lid 回查 allLeagues 复用分级/关注）
            results.push(buildUpcomingCard(s, { now: now, allLeagues: this.allLeagues, lid: lid }));
          }
        });
        results.sort((a, b) => (a.startDate || 0) - (b.startDate || 0));
        // 本地快照补充：云缓存可能未含已开赛的进行中赛事（Liquipedia 仅 Upcoming 段抓取，
        // 赛事开赛后转到 Ongoing 段）。用 upcoming-local.json 兜底，确保进行中赛事一定能进入
        // 赛程列表，再经 upcomingCardStatus 判定归入「进行中」tab（部署新的云函数前尤其关键）。
        this.mergeLocalSnapshot(results, now);
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
      // 2026-07-30 修复：优先用 JS 包装模块（稳定可靠），回退到 JSON
      try { data = require('../../utils/upcoming-local-data.js'); }
      catch (_e) { data = require('../../utils/upcoming-local.json'); }
    } catch (e) {
      return Promise.resolve(false);
    }
    const events = (data && data.events) || [];
    if (!events.length) return Promise.resolve(false);

    const now = util.nowSec();
    const horizon = now + config.leagueWindow.upcomingRangeSec;
    const results = events
      .filter((e) => e.start && e.start <= horizon && (!e.end || e.end >= now))
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
      return;
    }

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
          }
          // sources 内部已做限流/熔断，直接继续
          next();
        })
        .catch(() => { next(); });
    };
    next();
  },

  // 本地快照补充：读取 build-time 生成的 utils/upcoming-local.json，
  // 把云缓存可能遗漏的「进行中 / 即将到来」赛事并入 results（按归一名去重）。
  // 用途：Liquipedia 仅抓取 Portal 的 Upcoming 段，已开赛赛事转到 Ongoing 段后云缓存会漏，
  // 本地快照（含 1win Essence II 等）可兜底，确保进行中赛事一定能进入赛程列表。
  mergeLocalSnapshot(results, now) {
    let data;
    // 2026-07-30 修复：优先用 JS 包装模块（稳定可靠），回退到 JSON
    try { data = require('../../utils/upcoming-local-data.js'); }
    catch (e) { try { data = require('../../utils/upcoming-local.json'); } catch (_e) { return; } }
    const events = (data && data.events) || [];
    if (!events.length) return;
    const horizon = now + config.leagueWindow.upcomingRangeSec;
    const seen = {};
    const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/^the/, '');
    results.forEach((r) => { const k = norm(r.name); if (k) seen[k] = true; });
    events
      .filter((e) => e.start && e.start <= horizon && (!e.end || e.end >= now))
      .forEach((e) => {
        const k = norm(e.name);
        if (!k) return;
        if (seen[k]) {
          // 2026-07-30 修复：云缓存已含同名赛事（来自 Liquipedia Ongoing 段）时，
          // 不再直接跳过——用 local 快照更完整的日期修正它。
          // 根源：云函数 fetchLiquipediaUpcoming 抓 Portal:Tournaments 的 Ongoing 段，
          // 该段日期单元格仅显示开始日（如 "Jul 30, 2026"），parseLiquipediaDate
          // 无结束月/日 → 回退 end=start，导致 endDate 截断为 startDate。
          // local 快照（fetch-liquipedia-upcoming.js 生成）含完整 start+end，
          // 仅当 local 的 end 比云缓存的 endDate 更晚时才覆盖，避免改错正确日期。
          const existing = results.find((r) => norm(r.name) === k);
          if (existing && e.end && e.end > (existing.endDate || 0)) {
            existing.startDate = e.start;
            existing.endDate = e.end;
            existing.dateRange = util.formatDateRange(e.start, e.end);
            existing._win = Object.assign({}, existing._win, { startDate: e.start, endDate: e.end });
          }
          return;
        }
        seen[k] = true;
        results.push(buildUpcomingCard(e, { now: now, allLeagues: this.allLeagues, lid: e.id }));
      });
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
    const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/^the/, '');
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
      // 真实状态：已开赛的 curation 赛事（如 TI 主赛事开打）应归入「进行中」而非「即将到来」
      const cardStatus = (ev.startDate && ev.endDate && nowSec >= ev.startDate && nowSec <= ev.endDate + 86400) ? 'ongoing' : 'upcoming';
      const cardBadge = statusBadgeOf(cardStatus);
      // 基于 id 生成稳定的负数 id（避免与真实 leagueid 冲突）
      // 方案 E：curation 有真实 leagueId 时直接用，无则回退哈希 fakeId
      let hash = 0;
      for (let j = 0; j < k.length; j++) {
        hash = ((hash << 5) - hash + k.charCodeAt(j)) | 0;
      }
      const fallbackFakeId = -(Math.abs(hash) % 1000000 + 1000000);  // 负数区间 -1999999..-1000000
      const cardId = (ev.leagueId != null) ? ev.leagueId : fallbackFakeId;
      results.push({
        leagueid: cardId,
        legacyFakeId: (ev.leagueId != null) ? fallbackFakeId : null,  // 详情页兼容层用
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
        followed: follow.isFollowed('leagues', cardId),
        startDate: ev.startDate,
        endDate: ev.endDate,
        status: cardStatus,
        statusText: cardBadge.text,
        statusColor: cardBadge.color,
        dateRange: util.formatDateRange(ev.startDate, ev.endDate),
        daysToStart: daysToStart,
        countdownText: cardStatus === 'ongoing' ? '正在交锋' : (daysToStart <= 0 ? '今日开赛' : (daysToStart === 1 ? '明天开赛' : daysToStart + ' 天后开赛')),
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
    // TI 现已对齐 Liquipedia 同为 S 级，SSS 不再用于赛事分级
    const gradeMatch = (x) => {
      if (gf === 'all') return true;
      return (x.grade || '').toLowerCase() === gf;
    };
    let arr;
    if (f === 'upcoming') {
      // 仅显示「即将到来」状态：已开赛的进行中赛事归入「进行中」tab，不在此重复出现
      arr = (this.upcomingList || []).filter((x) => gradeMatch(x) && x.status === 'upcoming').slice();
    } else if (f === 'ongoing') {
      // 主源：OpenDota 已收录且状态为进行中的赛事
      const ong = (this.allLeagues || []).filter((x) => x.status === 'ongoing' && gradeMatch(x));
      const seen = {};
      ong.forEach((x) => { seen[String(x.leagueid)] = true; });
      // 补充：Liquipedia/本地快照中「已开赛但 OpenDota 尚未收录」的赛事（如 1win Essence II）。
      // 这些赛事仅存在于 upcomingList（赛程数据源），按日期窗口判定为「进行中」，应在此展示。
      (this.upcomingList || []).forEach((u) => {
        if (seen[String(u.leagueid)]) return;
        if (u.status === 'ongoing' && gradeMatch(u)) ong.push(u);
      });
      arr = dedupeByDisplayName(ong);
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
      // 2026-08-13（TI 2026 不可见修复 · P0）：time 模式排序键与 smart 模式（sortSmart 用
      // startDate || latest）对齐——latest 兜底 startDate。修复「OpenDota 已收录元数据但无比赛
      // 记录（latest=0，如 TI 2026 开赛首日）」的赛事在「全部」tab 沉底到分页外不可见。
      // 有真实比赛记录的赛事 latest>0 行为不变；阶段 2 normalize 完成前 startDate=null 仍沉底，
      // 完成后 applyAndSlice(true) 自动上浮（<300ms 过渡）。
      const tkey = (x) => (f === 'upcoming' ? (x.startDate || x.latest || 0) : (x.latest || x.startDate || 0));
      if (f === 'upcoming') {
        // 即将：按开赛时间从近到远（升序），越近的赛事越靠上
        arr.sort((a, b) => tkey(a) - tkey(b));
      } else if (f === 'all') {
        // 2026-08-13（「全部」tab 排序优化）：三段式状态分组——进行中 → 即将 → 已结束。
        // 组内排序：
        //   ongoing：最新时间降序（正在交锋的赛事按最新比赛时间排）
        //   upcoming：开赛时间升序（越近开赛越靠前，与「即将到来」tab 口径一致）
        //   ended：最新时间降序（越新结束越靠前）
        // 说明：smart 模式（关注置顶）不受影响；阶段 2 修正 status 后 applyAndSlice(true) 自动重排。
        const STATUS_ORDER = { ongoing: 0, upcoming: 1, ended: 2 };
        arr.sort((a, b) => {
          const oa = STATUS_ORDER[a.status] != null ? STATUS_ORDER[a.status] : 3;
          const ob = STATUS_ORDER[b.status] != null ? STATUS_ORDER[b.status] : 3;
          if (oa !== ob) return oa - ob;
          if (oa === 1) { // upcoming 组：升序（越近越靠前）
            return tkey(a) - tkey(b);
          }
          return tkey(b) - tkey(a); // ongoing / ended 组：降序
        });
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
    // 2026-08-07（v1.2）：已停办赛事（defunct）不再展示归档区，直接从列表中剔除。
    // 原因：归档区占位过大且用户关注度低，移除后主列表更聚焦有效赛事。
    const active = arr.filter((x) => !x.defunct);
    this.filtered = active;
    const pageSize = this.data.pageSize;
    const page = reset ? 0 : this.data.page;
    const slice = active.slice(0, (page + 1) * pageSize);
    // 2026-08-07（v1.3）：重置 loadingMore——切 tab/筛选后，挂起的 appendPageSafe setTimeout
    // 回调会在检查 `if (!this.data.loadingMore) return;` 时自动跳过，避免用旧 page 切出两页。
    // v1.4：同时重置 armedMore——切 tab/筛选后 ARMED 确认态不再有意义。
    this.setData({ list: slice, archived: [], page: page, hasMore: active.length > slice.length, loadingMore: false, armedMore: false });
    this._armedScrollTop = 0;
    this._armedMinScroll = 0;
    this.enhanceListMetadata();
  },

  // 2026-08-07（v1.3/v1.4）：统一的「安全加载下一页」入口——v1.4 起**只有点击提示条触发**（onLoadMore），
  //   触底只进入 ARMED 确认态（onReachBottom），不再直接调这里。
  //   三层防护：
  //   ① 基本守卫：无更多数据 / 首次加载中 / 即将到来懒加载中 → 跳过
  //   ② loadingMore 态：已在加载下一页 → 跳过（防重复触发）
  //   ③ 节流锁：上次点击后 5 秒内 → 跳过（防弱网下重复叠加）
  appendPageSafe() {
    if (!this.data.hasMore || this.data.loading || this.data.upcomingLoading) return;
    if (this.data.loadingMore) return;
    const now = Date.now();
    if (this._lastAppendAt && now - this._lastAppendAt < 5000) return;
    this._lastAppendAt = now;
    // 进入加载态：同步解除 ARMED 确认（点击/微下拉即确认，无需再保持高亮）
    this._armedScrollTop = 0;
    this._armedMinScroll = 0;
    this.setData({ loadingMore: true, armedMore: false });
    // 用 setTimeout(0) 让 loadingMore 态渲染一帧（三态提示条切「正在加载...」），
    // 再执行同步切片。切片纯内存操作，通常极快，但渲染慢的设备上用户能看到反馈。
    // 注意：不能在同一同步栈内连续两次 setData（渲染层会合并，loadingMore 态不可见）。
    setTimeout(() => {
      if (!this.data.loadingMore) return;   // 已被 onHide 重置，跳过
      const page = this.data.page + 1;
      const pageSize = this.data.pageSize;
      const slice = this.filtered.slice(0, (page + 1) * pageSize);
      this.setData({
        list: slice,
        page: page,
        hasMore: this.filtered.length > slice.length,
        loadingMore: false
      });
      this.enhanceListMetadata();
    }, 0);
  },

  // 2026-08-07（v1.4）：底部提示条点击入口——IDLE / ARMED 态点击都直接加载。
  // 点击即最明确的意图，无需再经过 ARMED 确认（复核 P1-2：两态点击行为统一）。
  onLoadMore() {
    this.appendPageSafe();
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
    // 2026-08-13（焦点卡动态化 · P1）：焦点卡关注态即时同步——焦点卡星星点击后
    // 无需等下次 onShow，立即更新（含 _lastFocusSig 刷新，避免定时器把它当旧状态跳过）
    if (this.data.focusNode && Number(this.data.focusNode.leagueid) === Number(id)) {
      this.setData({ 'focusNode.followed': followed });
      this._lastFocusSig = (this.data.focusNode.isLive ? 'true' : 'false') + '|' + this.data.focusNode.daysToStart + '|' + followed;
    }
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

  // 「重点运营节点」焦点卡：仅 TI + Esports World Cup 双旗舰（2026-08-13 收窄，按复核修正）。
  // 纯本地 curation 数据驱动，无需网络；无合适候选时隐藏（避免展示过期/空焦点）。
  // 候选：仅 TI / EWC 系列主赛事（排除预选赛变体），赛前 30 天预热期起展示，结束即隐藏。
  // 简化评分：进行中恒优先（层优先级）；未开始按临近开赛线性加分。
  // ⚠️ 修正（2026-08-13 复核）：① tagline 动态取 ev.region（EWC 2026 在巴黎，2024/25 在沙特，
  //    不能写死地点）；② IS_FLAGSHIP 排除 qualifier/open/regional 预选赛变体；
  //    ③ 时间窗口统一为赛前 30 天（§2.1 与决策 2 不再矛盾）。
  buildFocusNode() {
    const nowSec = Math.floor(Date.now() / 1000);
    // 候选窗口：赛前 30 天预热期 起，进行中延续，结束后立即排除
    const windowStart = nowSec - 30 * 86400;
    const windowEnd = nowSec + 30 * 86400;
    // 双旗舰白名单：TI / EWC 主赛事（排除预选赛/海选/区域赛变体）
    const IS_FLAGSHIP = (c) => {
      if (!c) return false;
      if (/qualifier|open|regional/i.test(c)) return false;   // 预选赛/海选/区域赛排除
      return /^the international/i.test(c) || /^esports world cup/i.test(c);
    };
    let best = null, bestScore = 0, bestLive = false;

    (remoteCuration.getEffectiveEvents() || []).forEach((ev) => {
      if (!ev || !ev.start) return;
      if (!IS_FLAGSHIP(ev.canonical)) return;                  // 仅 TI / EWC 主赛事
      const start = ev.start;
      const end = ev.end || (start + 10 * 86400);
      if (start > windowEnd || end < windowStart) return;      // 预热期外（>30 天前/超30天后）
      // 已结束排除（对齐 util.isOngoing 口径：end 是"最后一天 00:00"，加 1 天宽限，
      // 避免 TI 最后一天 00:00 后被提前隐藏）
      if (end + 86400 < nowSec) return;
      const isLive = nowSec >= start && nowSec <= end;
      const daysToStart = Math.ceil((start - nowSec) / 86400);
      // 简化评分（双旗舰专属，无需 valve/topThirdParty/等级加分——两者天然是旗舰）：
      //   进行中恒优先（层优先级）；未开始按临近开赛线性加分
      const score = isLive ? 100 : Math.max(0, 60 - daysToStart * 2);
      const liveRank = isLive ? 1 : 0;
      if (liveRank > (bestLive ? 1 : 0) || (liveRank === (bestLive ? 1 : 0) && score > bestScore)) {
        bestScore = score; bestLive = isLive; best = { ev, start, end, isLive, daysToStart };
      }
    });

    if (!best) {
      if (this._lastFocusSig !== 'null') { this._lastFocusSig = 'null'; this.setData({ focusNode: null }); }
      return;
    }
    const { ev, start, end, isLive, daysToStart } = best;
    // 稳定的 id：优先 curation 真实 leagueId（方案 E），无则回退哈希 fakeId（与 mergeCurationUpcoming 一致）
    // ⚠️ 哈希须剥离 'the' 前缀，与 mergeCurationUpcoming 的 norm() 对齐，否则焦点卡与列表 tab 关注态割裂
    let hash = 0;
    const k = (ev.canonical || '').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/^the/, '');
    for (let j = 0; j < k.length; j++) { hash = ((hash << 5) - hash + k.charCodeAt(j)) | 0; }
    const fallbackFakeId = -(Math.abs(hash) % 1000000 + 1000000);
    const focusId = (ev.leagueId != null) ? ev.leagueId : fallbackFakeId;
    const followed = follow.isFollowed('leagues', focusId);
    // 动态展示文案（wxml 去 TI 硬编码）：
    //   flagText：年度旗舰（Valve/TI）/ 顶级第三方（EWC）
    //   tagline：Valve→"Valve 官方 · 地点"；EWC→"顶级第三方 · 地点"（地点动态取 ev.region，
    //     2026 巴黎 / 2024-25 沙特，随 curation 数据自动正确，不写死）
    //   liveText："{name} 正赛进行中"
    const flagText = ev.valve ? '年度旗舰' : (ev.topThirdParty ? '顶级第三方' : '年度旗舰');
    const loc = ev.region || ev.location || '';
    const tagline = ev.valve ? ('Valve 官方 · ' + (loc || '线下')) : ('顶级第三方 · ' + (loc || '线上'));
    const liveText = (ev.canonical || '赛事') + ' 正赛进行中';
    // 签名：只有「是否直播 + 距开赛天数 + 关注态」变化时才 setData
    // 这三个是用户可感知的状态，其余字段（name/dateRange 等）恒定不变
    const sig = isLive + '|' + daysToStart + '|' + followed;
    if (this._lastFocusSig === sig) return;  // 状态未变，跳过 setData
    this._lastFocusSig = sig;
    this.setData({
      focusNode: {
        leagueid: focusId,
        legacyFakeId: (ev.leagueId != null) ? fallbackFakeId : null,  // 详情页兼容层用
        name: ev.canonical,
        canonical: ev.canonical,
        start: start,
        end: end,
        dateRange: util.formatDateRange(start, end),
        prizePool: ev.prizePool ? String(ev.prizePool) : '',
        location: ev.region || ev.location || '',
        valve: !!ev.valve,
        topThirdParty: !!ev.topThirdParty,
        flagText: flagText,
        tagline: tagline,
        liveText: liveText,
        isLive: isLive,
        daysToStart: daysToStart,
        followed: followed
      }
    });
  },

  // 2026-08-13（焦点卡动态化 · P1）：30s 定时刷新焦点卡。
  // onShow 启动 / onHide 停止 / onUnload 清理；buildFocusNode 内部有 _lastFocusSig 签名防抖，
  // 只有 isLive/daysToStart/followed 变化才 setData，跨开赛/结束时刻自动更新 + 焦点自动轮替。
  _startFocusTimer() {
    this._stopFocusTimer();
    this._focusTimer = setInterval(() => this.buildFocusNode(), 30000);
  },
  _stopFocusTimer() {
    if (this._focusTimer) { clearInterval(this._focusTimer); this._focusTimer = null; }
  },

  // 焦点卡点击：进入赛事详情（curation-only 赛事由详情页兜底渲染）
  openFocus(e) {
    const id = e.currentTarget.dataset.id;
    const name = e.currentTarget.dataset.name;
    wx.navigateTo({
      url: '/subpackages/detail/league-detail/league-detail?leagueId=' + id + '&name=' + encodeURIComponent(name)
    });
  },

  // 2026-07-30 异步 Liquipedia 元数据增强：列表加载完成后，对可见卡片中
  // curation 未覆盖的赛事（_metaEnriched===false）逐个调 Liquipedia 获取元数据。
  // 串行执行（2.2s 间隔尊重 Liquipedia 限流），最多增强前 N 个可见赛事，
  // 成功后只更新对应索引的字段（路径 setData，最小化渲染范围）。
  enhanceListMetadata() {
    // P1-1：并发防重（检查在前、gen+1 在后——避免误杀运行中链导致 _metaEnriching 残留死锁）
    if (this._metaEnriching) return;   // 已有链在跑，跳过本次（不递增代际，运行中链继续）
    const gen = (this._metaGen = (this._metaGen || 0) + 1);
    this._metaEnriching = true;
    var list = this.data.list || [];
    if (!list.length) { this._metaEnriching = false; return; }
    var sources = require('../../utils/sources.js');
    var MAX_ENRICH = 10;     // 最多增强前 10 个可见的未覆盖赛事
    var count = 0;
    var i = 0;

    var next = function () {
      if (gen !== this._metaGen) return;            // 本链已被更新的调用/离开页面取代，直接放弃
      // 找下一个需要增强的赛事
      while (i < list.length && list[i]._metaEnriched) i++;
      if (i >= list.length || count >= MAX_ENRICH) { this._metaEnriching = false; return; }

      var item = list[i];
      var idx = i;
      i++;
      count++;
      // 2.2s 间隔由 liquipedia 限流器保证；此处 100ms 仅为循环节奏
      setTimeout(function () {
        if (gen !== this._metaGen) return;          // 链已取消，不再发起请求
        sources.getLeagueMetadata({ name: item.name, leagueid: item.leagueid }).then(function (meta) {
          if (gen !== this._metaGen) return;        // 返回时链已取消，不写 setData
          if (!meta) { next(); return; }
          // 索引校验：当前 list[idx] 仍指向同一赛事才写入，防筛选/翻页后错位
          var cur = this.data.list && this.data.list[idx];
          if (!cur || cur.leagueid !== item.leagueid) { next(); return; }
          var patch = {};
          if (meta.prizePool) patch['list[' + idx + '].prizePool'] = meta.prizePool;
          if (meta.organizer) patch['list[' + idx + '].organizer'] = meta.organizer;
          if (meta.location) patch['list[' + idx + '].region'] = meta.location;
          if (meta.format) patch['list[' + idx + '].format'] = meta.format;
          patch['list[' + idx + ']._metaEnriched'] = true;
          try { this.setData(patch); } catch (e) {}
          next();
        }.bind(this)).catch(function () { next(); });
      }.bind(this), 100);  // 首项立即，后续靠递归
    }.bind(this);
    next();
  }
});
