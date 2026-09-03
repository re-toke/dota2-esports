// pages/index/index.js
// 24 独立「首页」页（tabBar 首屏）：承载原挂在 leagues 顶部的「我的关注」横向卡片流（spec C.2.1），
// 并作为全局搜索（5.2）等核心入口的常驻承载页。关注数据来自本地 Storage（follow 工具），无需后端。
// 批次2（2026-08-30）· PRD §4：首页转型「数据中枢」——周日历时间轴 + 全量比赛流
//   （proMatches 已结束 + /live 进行中 + 关注战队 upcoming，60s 轮询含指数退避与比分闪光）。
const api = require('../../utils/api.js');
const util = require('../../utils/util.js');
const follow = require('../../utils/follow.js');
const sources = require('../../utils/sources.js');
const subscribe = require('../../utils/subscribe.js');
const reminderStrategy = require('../../utils/reminderStrategy.js');
const logoCache = require('../../utils/logoCache.js');
// v5.1（2026-09-01）：首页「对局级 upcoming」源 —— Liquipedia/Steam/haglund 排期（云代理，30min 缓存）
const liquipedia = require('../../utils/liquipedia.js');
// ★ 2026-09-01：构建时队徽快照（byName 键 = consensus.normName 规范化队名 → Steam CDN 可靠域）。
//   LP 排期卡无 team_id，无法走 logoCache 按 id 查询 → 本地快照按名命中可零网络回填。
const _teamLogoLocal = require('../../utils/team-logo-local-data.js');

// 关注卡片流展示上限，避免关注过多战队时批量请求打满 OpenDota 60 req/min
const FOLLOW_CAP = 15;

// ===== 批次2 常量 =====
// LIVE 轮询：F3a（2026-08-31）基线 60s → 120s。
//   实测 /live 端点 144.5KB/1.4s，100 场中职业场（league_id>0）0 场，每 60s 重复拉纯浪费。
//   改为 120s 基线（含 TTL 缓存兜底），轮询流量减半（8.6 → 4.3 MB/h），职业场刷新延迟可接受。
const POLL_BASE_MS = 120 * 1000;
const POLL_BACKOFF_1_MS = 180 * 1000;
const POLL_BACKOFF_MAX_MS = 300 * 1000;
// 比赛卡 logo 懒加载上限（首屏可见卡片，避免全列表 2N 次 getTeam）
const LOGO_ENRICH_CAP = 8;
// ★ 2026-09-01：按队名查队徽的单次渲染上限（LP 排期卡专用）。
//   这些队无 team_id，只能逐个按名查 Liquipedia（云代理，30 天缓存），
//   首屏只补 8 个队名，滚动/轮询时靠 _nameLogoCache 命中，避免请求轰炸。
const NAME_LOGO_CAP = 8;
// 按队名查队徽的会话级缓存/负缓存（键为规范化队名）。
//   与 logoCache（按 team_id）分开：LP 排期卡根本没有 team_id 可缓存。
const _nameLogoCache = {};
const _nameLogoNeg = {};
// 阶段判定的 6 小时回退规则（沿用全项目约定）
const LIVE_WINDOW_SEC = 6 * 3600;

// ===== v4.2（2026-08-23）：比赛卡信息语义修正 =====
//
// 根因 1：队名被截断为 4 字符大写（旧 tagOf = name.slice(0,4).toUpperCase()）。
//   Team Spirit / Team Liquid / Team Falcons 全部塌成 "TEAM"，
//   Xtreme Gaming → "XTRE"、Gaimin Gladiators → "GAIM"，用户完全无法分辨是哪支队伍。
//   这是「显示的信息不知道是什么」的首要根因。
//   → 卡面改用完整队名；缩写只保留给「队徽加载失败时的占位文字」（圆框里最多放 5 字符）。
const TEAM_NAME_FALLBACK = '待定';
function teamFullName(name) {
  const s = (name == null ? '' : String(name)).trim();
  return s || TEAM_NAME_FALLBACK;
}
function teamShortTag(name) {
  const s = (name == null ? '' : String(name)).replace(/\s+/g, '');
  return s ? s.slice(0, 5).toUpperCase() : '?';
}

// 根因 2：中央大数字其实是「击杀数」，不是系列比分。
//   OpenDota proMatches / live 的 radiant_score / dire_score 都是 kills。
//   旧实现直接把它当比分渲染（如 35 : 20），且底部 BO 局间色点也拿它算：
//     const sa = c.scoreA; for (i=0; i<bo; i++) if (i < sa) t='a';
//   击杀 35 >> BO3 的 3 局 → 色点永远全金，完全失真。
//   → 中央显示系列胜局（v5 由 sources.groupSeries 权威聚合），击杀降级为副行小字。
const BO_META = {
  BO1: { games: 1, label: '单局制' },
  BO2: { games: 2, label: '双局积分' },
  BO3: { games: 3, label: '三局两胜' },
  BO5: { games: 5, label: '五局三胜' }
};

// ★ v5（2026-09-01）：series 聚合统一走 sources.groupSeries（全项目 BO 判定引擎，
//   120 项 test-bo 覆盖：孤儿互并 / 借邻居 / BO2 平局 / 跨源去重等）。
//   不再维护 groupProSeries 私有实现（v4.2 遗留）——它缺孤儿互并与 BO 判定，且与
//   league-detail 的权威链路（buildBoContext → applyBo）重复。删除见 git 历史。

Page({
  data: {
    followLoading: false,
    hasFollow: false,
    hasFollowMatches: false,
    followCards: [],
    nowSec: 0,
    // ===== 批次2：周日历 + 全量比赛流 =====
    weekDays: [],           // 7 天：[{key, label, dateNum, count, isToday}]
    selectedDateKey: '',    // 'YYYY-MM-DD'（本地时区）
    matchCards: [],         // 当前日期 + 筛选下的展示卡
    matchFilter: 'all',     // 'all' | 'live' | 'upcoming' | 'ended'
    matchLoading: false,
    matchCounts: { live: 0, upcoming: 0, ended: 0 },
    matchDegraded: false,   // 数据源降级提示（OpenDota 全挂且无缓存）
    matchEmptyText: '该日暂无对局，看看其他日期吧'   // P1-2：筛选空态文案（动态）
  },

  onLoad() {
    // O-13（2026-08-15）：记录首次加载时间，onShow 节流基准（60s 内切回不重拉 15 卡）
    this._lastReloadMs = Date.now();
    // 批次2：周锚点（0 = 本周），初始选中今天
    this._weekOffset = 0;
    // F1（2026-08-31）：代际守卫 + 比赛流结果缓存，替代原 matchLoading 互斥。
    //   _epoch 每次发起异步拉取 +1，旧回调通过比对 epoch 丢弃，避免并行流交叉污染。
    //   _lastPro/_lastLive 缓存最近一次结果，关注流后到时复用（零额外请求合并）。
    this._epoch = 0;
    this._followRows = [];
    this._lastPro = null;
    this._lastLive = null;
    this._lastProTs = 0;
    this._lastLiveTs = 0;
    // F8（2026-08-31）：logo 兜底请求去重表（teamId -> Promise），同战队并发只发一次。
    //   懒初始化（首次兜底时创建），请求完成后自动清理对应条目。
    this._logoInflight = {};
    this._buildWeekDays();
    this.loadFollowCards();
  },

  onShow() {
    // 同步自定义 tabBar 选中态
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 0 });
    }
    // 首次 onShow 跳过（onLoad 已加载），仅启动定时器；
    // 后续 onShow（从其他 tab 切回）才刷新数据，避免首次进入时 onLoad+onShow 重复执行。
    // O-13：60s 节流——频繁切 tab 时 15 卡 Promise.all 重拉是浪费（api 有 10min 缓存兜底，
    //   数据新鲜度有保障），仅在距上次加载 >60s 时才重拉。
    //   例外：关注/取关数变化（用户刚在别处操作过）→ 突破节流立即重拉，保证关注同步即时性。
    if (this._loaded) {
      const nowMs = Date.now();
      const c = follow.counts();
      const sig = c.teams + '|' + c.leagues;
      const stale = !this._lastReloadMs || (nowMs - this._lastReloadMs > 60 * 1000);
      const followChanged = sig !== this._followSig;
      this._followSig = sig;
      if (stale || followChanged) {
        this._lastReloadMs = nowMs;
        this.loadFollowCards();
      }
    }
    this._loaded = true;
    this.startTimer();
    // 批次2：tab 可见时启动 LIVE 轮询（含退避；onHide 停止）
    this._startMatchPolling();
  },

  onHide() {
    this.stopTimer();
    this._stopMatchPolling();
  },

  onUnload() {
    this.stopTimer();
    this._stopMatchPolling();
    // logoCache 防抖写入（500ms）若未触发就卸载页面会丢最后一次 set —— 强制落盘。
    // 注意：微信小程序首页通常 onHide 不 onUnload（tabBar 页常驻），但用户可能从
    //   非 tabBar 入口进入或被系统回收，此时 onUnload 会触发。
    try { logoCache.persistNow(); } catch (e) { /* 静默：存储不可用不阻塞卸载 */ }
  },

  startTimer() {
    if (this._timer) return;
    this._timer = setInterval(() => this.tickCountdown(), 1000);
  },

  stopTimer() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  },

  // 聚合关注战队的「下一场赛事」卡片。数据来源 api.getTeamMatches（经 10min 缓存层）。
  // 每个战队取：未来最近一场（upcoming）优先；无未来场次则取最近一场（ended）占位。
  //
  // F1（2026-08-31）：比赛流（pro/live）与关注流（15 卡）并行启动。
  //   - 修复 P0：无关注战队时不再 early return 阻塞比赛流（原 bug 导致无关注用户首页永久空白）
  //   - 关注流后到时通过 _kickMatchFlow 复用缓存的 pro/live 增量合并（零额外请求）
  loadFollowCards() {
    const teams = follow.list('teams') || [];

    // ★ F1 P0 修复：无论有无关注，比赛流都要启动。
    //   原实现此处 early return 导致 _loadMatchFlow 永不调用 → 无关注用户首页比赛流/日历永久空白。
    //   现在比赛流由 _kickMatchFlow 独立发起，不再依赖 15 卡完成。
    //   先把空 rows 写入，让 _kickMatchFlow 第一批仅渲染 pro/live（curation 同步铺底）。
    this._followRows = [];
    this._kickMatchFlow();

    if (!teams.length) {
      // 合并：原 hasFollow + followCards + hasFollowMatches + followLoading 多次 setData 为单次
      this.setData({ hasFollow: false, followCards: [], hasFollowMatches: false, followLoading: false });
      return;
    }
    // 合并：原 hasFollow + followLoading 两次 setData 为单次
    this.setData({ hasFollow: true, followLoading: true });
    const now = util.nowSec();
    const limited = teams.slice(0, FOLLOW_CAP);
    // ★ 2026-09-01（P0-2）：关注流请求降载 —— 原 Promise.all(15 并发) 冷启动一次打满
    //   OpenDota 限流窗口（15 × getTeamMatches）。改为分批：首屏先拉前
    //   FOLLOW_FIRST_BATCH=5（横向卡首屏仅可见 2-3 张），剩余按批补拉。
    //   分批实现：先拉第一批（首屏可见），再串行补拉其余（每批 5 个），
    //   全部完成后统一 _followRows + _kickMatchFlow（保持原有增量合并语义）。
    const FOLLOW_FIRST_BATCH = 5;
    const FOLLOW_BATCH_SIZE = 5;
    const fetchBatch = (batchTeams) => Promise.all(batchTeams.map((t) =>
      api.getTeamMatches(String(t.id))
        .then((ms) => ({ t: t, ms: ms || [] }))
        .catch(() => ({ t: t, ms: [] }))
    ));
    const allRows = [];
    const firstBatch = limited.slice(0, FOLLOW_FIRST_BATCH);
    fetchBatch(firstBatch).then((rows) => {
      allRows.push.apply(allRows, rows);
      this._renderFollowCards(allRows, now);
      this._followRows = allRows.slice();
      this._kickMatchFlow();
      // 剩余关注分批补拉（每批 5 个，串行——避免并发打满限流窗口）
      const rest = limited.slice(FOLLOW_FIRST_BATCH);
      let chain = Promise.resolve();
      for (let bi = 0; bi < rest.length; bi += FOLLOW_BATCH_SIZE) {
        const batch = rest.slice(bi, bi + FOLLOW_BATCH_SIZE);
        chain = chain.then(() => fetchBatch(batch)).then((r2) => {
          allRows.push.apply(allRows, r2);
          this._renderFollowCards(allRows, now);
          this._followRows = allRows.slice();
          this._kickMatchFlow();
        });
      }
      return chain;
    }).catch(() => {
      // 首批失败：降级（至少渲染已成功的批次）
      this.setData({ followLoading: false });
      if (allRows.length) this._renderFollowCards(allRows, now);
    });
  },

  // ★ P0-2（2026-09-01）：关注卡渲染（原 loadFollowCards 内联逻辑抽为独立方法，
  //   供分批补拉复用——F4 分步渲染 + checkPreMatchReminders + _followRows 更新）。
  _renderFollowCards(rows, now) {
    const cards = [];
    rows.forEach(({ t, ms }) => {
      const card = this.buildFollowCard(t, ms, now);
      if (card) cards.push(card);
    });
    // F4 分步渲染（2026-07-29）：卡片在横向 scroll-view 中，首屏仅可见 2-3 张。
    const FIRST_BATCH = 3;
    if (cards.length <= FIRST_BATCH) {
      this.setData({
        followCards: cards,
        hasFollowMatches: cards.length > 0,
        followLoading: false
      });
    } else {
      this.setData({
        followCards: cards.slice(0, FIRST_BATCH),
        hasFollowMatches: true,
        followLoading: false
      });
      const remaining = cards.slice(FIRST_BATCH);
      if (remaining.length) {
        const patch = {};
        remaining.forEach((c, i) => {
          patch['followCards[' + (FIRST_BATCH + i) + ']'] = c;
        });
        this.setData(patch);
      }
    }
    // 2.2 闭环：后台静默检查赛前提醒（不阻塞 UI）
    this.checkPreMatchReminders(rows, now);
  },

  // ===== 批次2（2026-08-30）· PRD §4：周日历 + 全量比赛流 =====

  // 本地时区日期 key：'YYYY-MM-DD'（比赛按用户所在地分桶，而非 UTC）
  _dateKeyOf(unixSec) {
    const d = new Date(unixSec * 1000);
    const mo = ('0' + (d.getMonth() + 1)).slice(-2);
    const da = ('0' + d.getDate()).slice(-2);
    return d.getFullYear() + '-' + mo + '-' + da;
  },

  // 本地时区 'HH:mm'（比赛卡开赛时间）
  _timeTextOf(unixSec) {
    const d = new Date(unixSec * 1000);
    const h = ('0' + d.getHours()).slice(-2);
    const mi = ('0' + d.getMinutes()).slice(-2);
    return h + ':' + mi;
  },

  // v4.2：日期语境前缀（今天/明天/昨天，超出 ±1 天则 M月D日）。
  //   周日历虽已选中日期，但横向滑动后用户容易丢失「这是哪天」的语境，
  //   且 LIVE 卡此前完全没有时间锚点（只有进行时长），故在卡底补一行「今天 20:30」。
  _dayTextOf(unixSec) {
    const d = new Date(unixSec * 1000);
    const today = new Date();
    const dayA = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const dayB = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    const diffDays = Math.round((dayA - dayB) / 86400000);
    if (diffDays === 0) return '今天';
    if (diffDays === 1) return '明天';
    if (diffDays === -1) return '昨天';
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  },

  // 构造周日历 7 格（周一~周日）。_weekOffset 控制本周/上周/下周。
  _buildWeekDays() {
    const today = new Date();
    // 锚点 = 今天 + weekOffset 周
    const anchor = new Date(today.getFullYear(), today.getMonth(), today.getDate() + this._weekOffset * 7);
    // 该周的周一（getDay: 0=周日）
    const day = anchor.getDay();
    const mondayOffset = (day === 0) ? -6 : (1 - day);
    const monday = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + mondayOffset);
    const todayKey = this._dateKeyOf(Math.floor(today.getTime() / 1000));
    const labels = ['一', '二', '三', '四', '五', '六', '日'];
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i);
      const mo = ('0' + (d.getMonth() + 1)).slice(-2);
      const da = ('0' + d.getDate()).slice(-2);
      const key = d.getFullYear() + '-' + mo + '-' + da;
      days.push({
        key: key,
        label: labels[i],
        dateNum: d.getDate(),
        count: (this._dayCounts && this._dayCounts[key]) || 0,
        isToday: key === todayKey
      });
    }
    // 默认选中今天（仅当今天在本周窗口内；翻周后保持选中周一）
    let selected = this.data.selectedDateKey;
    if (!selected) {
      selected = todayKey;
      this._selectedIsToday = true;
    }
    this.setData({ weekDays: days, selectedDateKey: selected });
    this._renderMatchFlow();
  },

  // 周日历点选：切日期 → 重渲染比赛流（数据已在本地，无需请求）
  onDaySelect(e) {
    const key = e.detail.key;
    if (!key || key === this.data.selectedDateKey) return;
    const todayKey = this._dateKeyOf(util.nowSec());
    this._selectedIsToday = (key === todayKey);
    this.setData({ selectedDateKey: key });
    this._renderMatchFlow();
  },

  // 跨周切换：±1 周 → 重建日历（比赛数据本地复用）
  onWeekShift(e) {
    const dir = e.detail.dir;
    const next = this._weekOffset + dir;
    // F9（2026-08-31）：-2~+4 → -2~+12 周。向前扩展匹配 curation 覆盖（upcomingRangeSec=180d≈26 周）；
    //   向后保持 -2（proMatches 只覆盖近 2 天，再向后是空周——复核 H4 决定不扩展向后）。
    if (next < -2 || next > 12) return;
    this._weekOffset = next;
    // 翻周后：若原选中天不在新周窗口，回到该周周一
    const days = this.data.weekDays;
    if (days.length) {
      const inWindow = days.some((d) => d.key === this.data.selectedDateKey);
      if (!inWindow) this.setData({ selectedDateKey: '' });
    }
    this._buildWeekDays();
  },

  // 比赛流筛选 chips：'all' | 'live' | 'upcoming' | 'ended'
  onMatchFilter(e) {
    const f = e.detail.filter;
    if (!f || f === this.data.matchFilter) return;
    this.setData({ matchFilter: f });
    this._renderMatchFlow();
  },

  // 比赛卡点击：有 matchId 跳比赛详情，否则按 leagueId 跳赛事详情
  onMatchCardTap(e) {
    const d = e.detail;
    if (d.matchId && Number(d.matchId) > 0) {
      wx.navigateTo({ url: '/subpackages/detail/match-detail/match-detail?matchId=' + d.matchId });
    } else if (d.leagueId && Number(d.leagueId) > 0) {
      wx.navigateTo({ url: '/subpackages/detail/league-detail/league-detail?leagueId=' + d.leagueId });
    }
  },

  // F1（2026-08-31）：比赛流入口（替代原 _loadMatchFlow 的入口职责）。
  //
  // 设计要点（解决三个致命问题 H1/H2/H6）：
  //   - 取消 matchLoading 互斥守卫 → 改用 _epoch 代际计数器防异步交叉
  //   - 60s 内已拉过的 pro/live 直接复用（零请求合并）→ 关注流后到时增量并入
  //   - 15s 超时降级（合并 F10）→ 避免 matchLoading 永久卡骨架屏
  //
  // 触发点：
  //   - loadFollowCards 开头（并行启动第一批，不等 15 卡）
  //   - 15 卡 Promise.all 完成（复用缓存或发起新拉取合并 upcoming）
  //   - LIVE 轮询 tick（刷新比分）
  //   - onShow 重拉条件命中
  _kickMatchFlow() {
    const nowMs = Date.now();
    const PRO_FRESH_MS = 60 * 1000;
    const LIVE_FRESH_MS = 60 * 1000;
    const LP_FRESH_MS = 120 * 1000;
    const proFresh = this._lastPro && (nowMs - this._lastProTs < PRO_FRESH_MS);
    const liveFresh = this._lastLive && (nowMs - this._lastLiveTs < LIVE_FRESH_MS);
    const lpFresh = this._lastLpUp && (nowMs - this._lastLpUpTs < LP_FRESH_MS);
    // ★ 缓存复用路径：pro/live 都新鲜 → 直接合并（零请求）
    //   关注流后到时走这里，避免对 pro/live 重复请求。
    if (proFresh && liveFresh) {
      this._applyMatchSources(this._lastPro, this._lastLive, this._followRows || [],
        lpFresh ? this._lastLpUp : (this._lastLpUp || []));
      return;
    }
    // ★ 发起新一轮拉取
    this._epoch++;                       // 新代际，旧 epoch 的回调一律丢弃
    const myEpoch = this._epoch;
    this.setData({ matchLoading: true });
    const FETCH_TIMEOUT_MS = 15 * 1000;  // F10：15s 超时兜底
    Promise.race([
      Promise.all([
        api.getProMatches().catch(() => null),
        api.getLiveMatches().catch(() => null),
        // v5.1：并行拉「对局级 upcoming」（云代理 30min 缓存；失败 → [] 降级，不影响 pro/live）
        this._fetchLpUpcoming().catch(() => [])
      ]),
      new Promise((_, reject) => setTimeout(() => reject(new Error('matchflow_timeout')), FETCH_TIMEOUT_MS))
    ]).then(([pro, live, lpUp]) => {
      if (myEpoch !== this._epoch) return;  // 已被新一轮取代，丢弃
      this._lastPro = pro; this._lastProTs = Date.now();
      this._lastLive = live; this._lastLiveTs = Date.now();
      this._lastLpUp = lpUp; this._lastLpUpTs = Date.now();
      const degraded = (pro == null) && (live == null) && !this._allMatches;
      this._applyMatchSources(pro, live, this._followRows || [], lpUp);
      this.setData({ matchLoading: false, matchDegraded: !!degraded });
    }).catch(() => {
      if (myEpoch !== this._epoch) return;  // 已被新一轮取代，丢弃
      // F10 超时/失败降级：若有缓存数据，仍降级渲染（避免空白）；否则显示降级提示
      if (this._lastPro || this._lastLive) {
        this._applyMatchSources(this._lastPro, this._lastLive, this._followRows || [],
          this._lastLpUp || []);
      }
      this.setData({ matchLoading: false, matchDegraded: !this._allMatches });
    });
  },

  // v5.1（2026-09-01）：首页「对局级 upcoming」数据源。
  //   数据流：curation 近期活跃赛事（leagueId>0，进行中/即将开始）→ liquipedia.getScheduledMatches
  //   （Steam/Liquipedia/haglund 云代理，内部 30min TTL 缓存）→ sources.buildLpUpcomingSeries
  //   （过滤未开赛+确定队名 → groupLiquipediaMatches 聚合防拆局 → 系列化）。
  //   覆盖场景：进行中赛事（如 EPL Masters II，8/30~9/10）的后续淘汰赛排期 ——
  //   此前 OpenDota 侧无任何对局级 upcoming（team matches 实测只返回历史比赛）。
  //   请求量控制：只取 leagueId>0 的赛事、最多 3 个；getScheduledMatches 30min 缓存 →
  //   每 2min 轮询零网络。失败 → [] 降级（首页回退到 curation 赛事级卡现状）。
  //
  // ★ 2026-09-01（进行中卡修复）：返回值从「纯 upcoming 系列」扩展为「upcoming + live 系列」。
  //   背景：首页「进行中」段只有 curation 赛事级卡（无对阵/比分）——LP/Steam 排期里已开赛
  //   的 LIVE 对局被 buildLpUpcomingSeries 的「start > now」过滤丢弃。现按 phase 分流：
  //     - phase==='live'（或已开赛未结束）→ buildLpLiveSeries（保留，含 series 比分/队标）
  //     - 未开赛 → buildLpUpcomingSeries（原逻辑不变）
  //   _applyMatchSources ⑥ 段对两类 series 统一走 buildBoContext+applyBo + _cardFromSeries。
  _fetchLpUpcoming() {
    if (typeof wx === 'undefined' || !wx.cloud) return Promise.resolve([]);
    const now = util.nowSec();
    let events = [];
    try {
      // ★ 2026-09-01（A2）：候选 3→5 + S 级优先排序。
      //   原 slice(0,3) 只取前 3 个近期赛事，覆盖窄（memory 已知遗留）；且未排序，
      //   curation 返回按 startDate 升序 → 最早开赛的排前面，可能挤掉更重要的 S 级赛事。
      //   现按 tier.rank 降序（S 级优先）后取前 5——请求量仍受控（每赛事一次云调用，
      //   云端 30min 缓存；5 个赛事最坏 5 次，可接受），覆盖显著扩大。
      events = (sources.getUpcomingFromCuration(now) || [])
        .filter((ev) => ev.leagueId && ev.leagueId > 0)   // 有 OpenDota leagueId 才能走 Steam 云代理路径
        .sort((a, b) => ((b.tier && b.tier.rank) || 0) - ((a.tier && a.tier.rank) || 0))  // S 级优先
        .slice(0, 5);                                     // 请求量上限（3→5，A2）
    } catch (e) { return Promise.resolve([]); }
    if (!events.length) return Promise.resolve([]);
    // ★ 2026-09-01 修复「卡头显示『职业赛事』」：
    //   parseScheduledMatches 的输出**不含 leagueName/leagueId**（只有 team1Name/team2Name/
    //   startTime/boType…），mergeLiquipediaGroup 与 buildLpUpcomingSeries 只是透传该空值，
    //   _cardFromSeries 最终兜底成「职业赛事」。而本函数明确知道每条 match 来自哪个赛事
    //   （ev.name/ev.leagueId 就是查询入参）→ 在此按来源回填，下游即可拿到真实赛事名。
    return Promise.all(events.map((ev) =>
      liquipedia.getScheduledMatches(ev.name, { leagueId: ev.leagueId })
        .then((res) => {
          const ms = (res && res.matches) ? res.matches : [];
          return ms.map((m) => Object.assign({}, m, {
            leagueName: ev.name || '',
            _leagueName: ev.name || '',
            leagueId: ev.leagueId || 0
          }));
        })
        .catch(() => [])
    )).then((lists) => {
      const all = [];
      lists.forEach((ms) => { if (ms && ms.length) all.push.apply(all, ms); });
      if (!all.length) return [];
      // ★ 分流：LIVE 场（已开赛未结束）走 buildLpLiveSeries，upcoming 场走原函数。
      //   Steam LIVE 场 startTime 为「当前时间」占位 → 以 phase==='live' 为主判据；
      //   haglund/LPDB 场有真实开赛时间，phase 可能缺失 → 用 start<=now 兜底分流。
      const isLiveMatch = (m) => {
        if (m.phase === 'live') return true;
        if (m.phase === 'recent' || m.phase === 'ended') return false;
        const st = m.startTime || m.start_time || 0;
        return !!st && st <= now;   // 无 phase 标记 + 已开赛 → 归 live（未结束判定由 buildLpLiveSeries 兜底）
      };
      const liveMs = all.filter(isLiveMatch);
      const upMs = all.filter((m) => !isLiveMatch(m));
      const upSeries = sources.buildLpUpcomingSeries(upMs, now);
      const liveSeries = sources.buildLpLiveSeries(liveMs, now);
      return upSeries.concat(liveSeries);
    }).catch(() => []);
  },

  // ★ v5（2026-09-01）series 化改造：三源原始 match 合并 → sources.groupSeries 聚合 →
  //   buildBoContext + applyBo（BO 判定引擎）覆盖 boType。首页卡片从「单局」升级为
  //   「整场 BO 系列」（已结束 BO3 2:1 / 进行中 BO3 1:0 / 即将开始 BO3），与详情页一致。
  //   替代 v4.2 的 groupProSeries + ⑤ 后处理去重（groupSeries 内建孤儿互并/借邻居/跨源聚合）。
  //   v5.1：新增第 ⑥ 参 lpUp —— Liquipedia/Steam/haglund 排期对局 series（详情页同源），
  //   补齐「对局级 upcoming」（OpenDota team matches 实测只返回历史比赛，proMatches//live 均已开赛）。
  _applyMatchSources(pro, live, rows, lpUp) {
    const now = util.nowSec();
    const byKey = {};
    const followTeamIds = {};
    (rows || []).forEach((r) => { followTeamIds[String(r.t.id)] = true; });

    // —— 合并三源原始 match（groupSeries 输入为 OpenDota match 平铺结构）——
    // 去重：match_id 有值按 id 去重；无 id（upcoming 排期赛）按
    //   「leagueid|队ID对(不计顺序)|start_time」弱键去重，防同一场被多战队列表重复注入。
    const raw = [];
    const seenId = {};
    const seenWeak = {};
    const weakKeyOf = (m) => {
      if (!m.leagueid || !m.radiant_team_id || !m.dire_team_id || !m.start_time) return null;
      const a = Math.min(m.radiant_team_id, m.dire_team_id);
      const b = Math.max(m.radiant_team_id, m.dire_team_id);
      return m.leagueid + '|' + a + '|' + b + '|' + m.start_time;
    };
    // ★ 2026-09-02（双卡复现修复 1）：「pro 已结算 ↔ /live 进行中」矛盾数据的优先级裁决。
    //   实测（2026-09-02 晚）：OpenDota 对进行中的 BO3 会把当前局提前写进 proMatches 且
    //   radiant_win 已填（如 EPL s1137089 DYNASTY vs PuckChamp：pro radiant_win=true 但
    //   /live 同 match_id 仍在打）。旧实现 ① pro 先入 seenId → ② /live 同 match_id 被丢 →
    //   series 组内只剩已结算局 → groupSeries 按「比分未达胜场 + series_type≥1」强判 live
    //   但 games 缺当前局 → 卡片信息退化（比分滞后/文案错局号）。
    //   规则：同 match_id 双源并存时，**/live 版本优先**（实时性 > pro 的提前结算写入）。
    //   实现：② 提前到 ① 之前入表；pro 同 match_id 后到 → 被去重跳过（pro 的旧结算数据
    //   不再污染进行中系列；对真实已结束的比赛 /live 早已不返回，无副作用）。
    const pushUnique = (m) => {
      if (!m) return;
      if (m.match_id) {
        const k = String(m.match_id);
        if (seenId[k]) return;
        seenId[k] = true;
        raw.push(m);
        return;
      }
      const wk = weakKeyOf(m);
      if (wk) {
        if (seenWeak[wk]) return;
        seenWeak[wk] = true;
      }
      raw.push(m);
    };

    // ② /live 职业场：进行中局（league_id > 0），normalize 成 OpenDota match 结构后并入。
    //    series_id 缺失 → groupSeries 内建 patchNullSeriesId 借邻居机制把它并入
    //    proMatches 的同队同系列（同队ID对 + 6h 窗口），聚合成「进行中 BO3 1:0」。
    //    ★ 2026-09-02：提前到 ① pro 之前（见上 pushUnique 注释——/live 版本优先）。
    //    ★ 2026-09-02（双卡复现修复 2）：league_name 空值回填 —— OpenDota /live 实测
    //    league_name 恒为空字符串，旧实现直接透传 → 唯一数据源时卡头退化「职业赛事」。
    //    回填来源：① proMatches 同 leagueid 的 league_name（实测有值，如 'EPL Masters 2026 '）；
    //    ② curation canonicalLeagueName(leagueid)；仍无 → 保持空（_cardFromSeries 兜底）。
    const proLeagueNameById = {};
    (pro || []).forEach((m) => {
      if (m && m.leagueid && m.league_name) {
        if (!proLeagueNameById[m.leagueid]) proLeagueNameById[m.leagueid] = m.league_name;
      }
    });
    (live || []).forEach((m) => {
      if (!m || !m.league_id || m.league_id <= 0) return;
      const norm = this._normalizeLiveMatch(m, now);
      // league_name 空值回填（修复 2）
      if (!norm.league_name) {
        norm.league_name = proLeagueNameById[m.league_id] || '';
        if (norm.league_name) norm._leagueNameFromPro = true;   // 审计标记
      }
      pushUnique(norm);
    });
    // ① proMatches：已结束局（近 ~100 场，覆盖近 2-3 天）
    //    ★ 2026-09-02：移到 ② 之后 —— 同 match_id 时让 /live 版本优先入表。
    (pro || []).forEach((m) => {
      if (!m || !m.start_time) return;
      pushUnique(m);
    });
    // ③ 关注战队比赛：upcoming + 6h 窗口内的「正在交锋」（已结束由 proMatches 覆盖）
    (rows || []).forEach(({ t, ms }) => {
      (ms || []).forEach((m) => {
        if (!m || !m.start_time) return;
        const isFollowMatch = (m.radiant_team_id != null && followTeamIds[String(m.radiant_team_id)]) ||
                              (m.dire_team_id != null && followTeamIds[String(m.dire_team_id)]);
        if (!isFollowMatch) return;
        const started = m.start_time <= now;
        const inLiveWindow = started && (now - m.start_time) < LIVE_WINDOW_SEC;
        if (started && !inLiveWindow) return;
        pushUnique(m);
      });
    });

    // ④ 系列聚合 + BO 判定（纯计算，失败不影响主流程）
    let allSeries = [];
    try {
      allSeries = sources.groupSeries(raw);
      const boCtx = sources.buildBoContext(allSeries, null);   // 无 Liquipedia 数据 → S2/S1 缺省，走 S3 series_type / S5 / S6
      allSeries.forEach((s) => sources.applyBo(s, boCtx));
      // ★ 2026-09-02（v8.8 A'）：合并前把 game 层真实队名写回 series（OpenDota /proMatches 的
      //   radiant_name/dire_name 在 groupSeries 时被丢成「天辉/夜魇」占位——groupSeries 读
      //   radiant_team_name 字段，proMatches 提供的是 radiant_name）。mergeSplittedBo3Series
      //   要求真实队名才能可靠归并（占位名无法跨 team_id 判定同队）。
      allSeries.forEach((s) => {
        const games = s.games || [];
        const g0 = games[0] || {};
        const rn = (s.radiantName && s.radiantName !== '天辉' && s.radiantName !== '夜魇')
          ? s.radiantName : (g0.radiant_name || s.radiantName || '');
        const dn = (s.direName && s.direName !== '天辉' && s.direName !== '夜魇')
          ? s.direName : (g0.dire_name || s.direName || '');
        s.radiantName = rn; s.direName = dn;
      });
      // ★ 2026-09-02（v8.8 A'）：RECENT 段「OpenDota 拆裂 BO3」合并（与详情页共用纯函数）。
      //   OpenDota 可能把同一真实 BO3 拆成多个 series_id（甚至同队多 team_id），
      //   groupSeries 聚合成多张单局卡 → 首页「已结束」段显示多场 BO1。按解名队名合并回整场。
      allSeries = sources.mergeSplittedBo3Series(allSeries);
    } catch (e) { allSeries = []; }

    // ★ 2026-09-02（v8.8c）：参赛队白名单过滤（跨联赛误标剔除，与详情页共用）。
    //   首页是多联赛视图 → 按每个 series 的 leagueId（s.leagueId || games[0].leagueid）分组，
    //   对 leagueId>0 且 curation 能命中参赛队的组执行 filterMisattributedRecentSeries：
    //   「已结束 + 双方队名都不在该联赛参赛名单」→ 剔除（如 EPL Masters II 视图里
    //   OpenDota 误标进来的 EPL World Series SEA 对局 Yangon vs Team Kinetix）。
    //   守卫（函数内）：仅 recent、仅 curation 有 participants 的 league、占位名不判。
    try {
      const byLeague = {};     // lid → [series]
      const unTagged = [];     // 无 leagueId 的系列（保持原样）
      allSeries.forEach((s) => {
        const g0 = (s.games && s.games[0]) || {};
        const lid = Number(s.leagueId || g0.leagueid);
        if (lid && lid > 0) {
          if (!byLeague[lid]) byLeague[lid] = [];
          byLeague[lid].push(s);
        } else {
          unTagged.push(s);
        }
      });
      const keptAll = unTagged.slice();
      Object.keys(byLeague).forEach((lidStr) => {
        const lid = Number(lidStr);
        const filtered = sources.filterMisattributedRecentSeries(byLeague[lidStr], lid);
        keptAll.push.apply(keptAll, filtered);
      });
      allSeries = keptAll;
    } catch (e) { /* 过滤失败不影响主流程 */ }

    allSeries.forEach((s) => {
      const card = this._cardFromSeries(s, now, followTeamIds);
      if (card) byKey[card.key] = card;
    });

    // ⑤ F4（2026-08-31）：curation 赛事级卡片（零请求，纯本地策展数据）
    //   覆盖三源不含的未来赛事（如未来 1-12 周的 S 级赛事排期）。
    //   去重：同 leagueId **已有 live 卡**则不铺赛事级卡片（防同一赛事出两张 live 卡）。
    //   ★ 2026-09-01 修复「进行中数据消失」：原实现按「leagueId 已存在」即跳过——
    //     proMatches 含 EPL 已结束系列卡（leagueId=19944）→ existingLeagueIds 命中 →
    //     curation EPL Masters II「进行中」卡被错误跳过 → 首页进行中段为空。
    //     现改为仅当同 leagueId 已有 live 卡才跳过；ended/upcoming 系列卡不阻挡
    //     curation live 卡（赛事级「进行中」信息必须保留）。
    const existingLiveLeagueIds = {};
    Object.keys(byKey).forEach((k) => {
      const c = byKey[k];
      const lid = c.leagueId;
      if (lid && lid > 0 && c.status === 'live') existingLiveLeagueIds[lid] = true;
    });
    try {
      const cuEvents = sources.getUpcomingFromCuration(now) || [];
      cuEvents.forEach((ev) => {
        if (ev.leagueId && existingLiveLeagueIds[ev.leagueId]) return;
        const card = this._cardFromCuration(ev, now);
        if (card) byKey[card.key] = card;
      });
    } catch (e) { /* curation 源不可用静默跳过，不影响主流程 */ }

    // ⑥ v5.1：Liquipedia/Steam/haglund 排期对局 → 「对局级 upcoming」系列卡
    //   顺序在 ⑤ 之后：不反向影响 curation 赛事级卡（如 EPL Masters II 进行中赛事卡保留）。
    //   lpUp 由 _fetchLpUpcoming 产出（buildLpUpcomingSeries + buildLpLiveSeries）。
    //   先走 buildBoContext+applyBo（权威 BO 引擎，与 v5 主链路一致）——buildLpUpcomingSeries
    //   直判 `m.boType || 'BO1'` 在「上游仅带 series_type 无 boType」时会误判 BO1（S3 可救回）。
    //   _cardFromSeries 对 games=[] 系列兼容：真名直出、matchId=0 → 点击走 leagueId 跳转。
    // ★ 2026-09-01（双卡修复 v2）：lpUp live 系列**覆盖** ② /live 的错误卡。
    //   根因：同一对局「Inner Circle x Insanity vs Team Lynx」同时从 ② /live（OpenDota，
    //   league_name 缺失 → 卡头「职业赛事」+ series_type 缺失 → 当局制错误）与 ⑥ lpUp
    //   （Steam 云代理 / haglund 兜底，leagueName/BO 正确）注入 → 两张卡。
    //   v1 只按 series_id 覆盖，但 haglund 兜底源无 series_id（null/0）→ 覆盖被跳过 →
    //   ② 的错误卡残留。v2 改为「队名对（剥离 x 赞助商后缀，与 buildLpLiveSeries._normTeamX
    //   同口径）匹配 OR series_id 匹配」——无论 lpUp 卡来自 Steam（有 series_id）还是
    //   haglund（无 series_id），都能覆盖同对局的 ② 卡。
    //   用户确认：保留 lpUp 卡（Inner Circle vs Team Lynx 简称，leagueName/BO 正确）。
    let lpCtx = null;
    if (lpUp && lpUp.length) lpCtx = sources.buildBoContext(lpUp, null);
    const _normTeamX = (s) => {
      if (!s) return '';
      var n = String(s).toLowerCase().trim();
      n = n.replace(/\s*[x×]\s+\S+.*$/i, '');
      n = n.replace(/\s*(esports|e-sports|gaming|team|club)\s*$/g, '');
      n = n.replace(/[^a-z0-9一-鿿а-яё]/g, '');
      return n;
    };
    const _pairKeyX = (a, b) => {
      var na = _normTeamX(a), nb = _normTeamX(b);
      if (!na || !nb) return null;
      return na < nb ? (na + '|' + nb) : (nb + '|' + na);
    };
    (lpUp || []).forEach((s) => {
      if (lpCtx) sources.applyBo(s, lpCtx);
      const card = this._cardFromSeries(s, now, followTeamIds);
      if (!card) return;
      // ★ 覆盖同对局的旧 live 卡（② /live 或 ④ groupSeries 产物，信息不全）
      //   匹配键：队名对（剥离 x 后缀，顺序无关）优先；series_id 作为补充（队名缺失时兜底）。
      //   守卫：队名对匹配须同时满足 leagueId 一致（lpUp.leagueId>0 时）——防同名队伍
      //   在不同联赛同时开打时误跨联赛覆盖（如 Team X vs Team Y 同时出现在 EPL 和 DreamLeague）。
      // ★ 2026-09-02（双卡复现修复 3）：覆盖判定不再要求「lpUp 卡自身是 live」——
      //   LP 数据有 30min 云缓存，比分可能滞后（真实已 1:0 但缓存仍 0:0 → _seriesEnded/
      //   phase 判定差异）→ lpUp 场被判 upcoming/recent 而 ② 卡是 live 时，旧逻辑不触发
      //   覆盖 → 双卡残留。放宽为「按队名对/series_id 找同对局旧卡」，再用状态规则裁决：
      //     ① lpUp 卡 live → 无条件覆盖（Steam 数据更权威：leagueName/BO/series_id 齐全）
      //     ② lpUp 卡 upcoming → 仅当旧卡是「退化卡」（leagueName 为『职业赛事』兜底值，
      //        即 ② /live 缺 league_name 的产物）才覆盖——保留信息完整的 live 卡（有比分），
      //        替换信息不全的 upcoming 视角（旧卡显示 live 至少说明确实开打了）
      //     ③ lpUp 卡 ended → 不覆盖（已结束的对局 ② 卡按已结束渲染，无信息差）
      const pairKey = _pairKeyX(card.teamA.name, card.teamB.name);
      const isSameMatchCard = (c) => {
        if (c === card) return false;
        if (pairKey) {
          const ck = _pairKeyX(c.teamA.name, c.teamB.name);
          if (ck && ck === pairKey) {
            // leagueId 守卫：两者都有有效 leagueId 且不同 → 不同联赛，不覆盖
            if (c.leagueId > 0 && card.leagueId > 0 && c.leagueId !== card.leagueId) return false;
            return true;   // 队名对相同（含 x 剥离）+ 联赛一致/未知 → 同一对局
          }
        }
        if (s.series_id != null && s.series_id !== 0 && c.seriesId === s.series_id) return true;
        return false;
      };
      if (card.status === 'live') {
        // lpUp live 卡：覆盖一切同对局旧卡（不论旧卡状态——live 数据源里 Steam 最权威）
        const staleKeys = Object.keys(byKey).filter((k) => {
          const c = byKey[k];
          return c.status === 'live' && isSameMatchCard(c);
        });
        staleKeys.forEach((k) => { delete byKey[k]; });
      } else if (card.status === 'upcoming') {
        // lpUp upcoming 卡：只替换「退化 live 卡」（leagueName 为兜底值『职业赛事』——
        //   ② /live 缺 league_name 的产物，正是用户看到的『职业赛事+单局制』卡）
        const DEGENERATE = '职业赛事';
        const staleKeys = Object.keys(byKey).filter((k) => {
          const c = byKey[k];
          return c.status === 'live' && isSameMatchCard(c) &&
                 (!c.leagueName || c.leagueName === DEGENERATE);
        });
        staleKeys.forEach((k) => { delete byKey[k]; });
      }
      // ★ 2026-09-02（修复 3b）：反向去重——lpUp 卡入表后，删除「已被证明是同对局但
      //   状态更旧」的后续注入是不可能的（lpUp 最后入），但存在「④ 产物 live 卡与
      //   lpUp upcoming 卡同对局共存」的场景：上面 upcoming 分支已处理（仅删退化卡）。
      byKey[card.key] = card;
    });

    this._allMatches = Object.keys(byKey).map((k) => byKey[k]);
    // 按日期分桶 → 周日历角标（语义升级：角标 = 当日系列数，非局数）
    const dayCounts = {};
    this._allMatches.forEach((c) => {
      dayCounts[c.dateKey] = (dayCounts[c.dateKey] || 0) + 1;
    });
    this._dayCounts = dayCounts;
    this._buildWeekDays();
  },

  // /live 职业场 → OpenDota match 平铺结构（groupSeries 输入兼容）。
  // 关键补全：start_time（/live 无此字段 → 「现在 - 已进行时长」）与 radiant_win=null
  //   （未结算 → groupSeries 的 isLive 判定成立）。series_type 透传（通常无 → undefined，
  //   由组内 proMatches 局补齐 S3 信号）。_isLiveSource 标记供 liveSubText 提取。
  // ★ 2026-09-01（A3）：start_time 优先用 `activate_time`（Steam 原生精确开赛时间戳，
  //   实测 /live 含此字段）——原 `now - duration` 推断受 duration 更新滞后影响（分钟级偏移），
  //   activate_time 是 Valve 原始值，分桶/排序更准。activate_time 缺失时回退推断。
  // ★ 2026-09-01（双卡修复）：补透传 series_id —— /live 实测含 series_id（Steam 原生），
  //   原实现丢弃 → ② /live 场与 ⑥ lpUp（Steam 云代理）同一对局因系列键不同拆成两张卡
  //   （lpUp 卡 leagueName 正确，/live 卡 league_name 缺失显示「职业赛事」）。
  //   透传后 groupSeries 按 series_id 聚合，② 与 ⑥ 可合并（配合 _applyMatchSources ⑥ 段覆盖）。
  _normalizeLiveMatch(m, now) {
    return {
      match_id: m.match_id,
      start_time: m.activate_time || m.start_time || (now - (m.duration || 0)),
      radiant_win: null,
      leagueid: m.league_id,
      league_name: m.league_name || '',
      radiant_team_id: m.team_id_radiant,
      dire_team_id: m.team_id_dire,
      radiant_name: m.team_name_radiant,
      dire_name: m.team_name_dire,
      series_id: m.series_id || null,      // ★ 2026-09-01：透传 Steam 原生 series_id
      series_type: m.series_type,
      radiant_score: m.radiant_score,
      dire_score: m.dire_score,
      duration: m.duration,
      spectators: m.spectators,
      _isLiveSource: true
    };
  },

  // groupSeries 系列 → 首页卡片（字段对齐 v4.2 体系：name/subScoreText/bo/boText/boGames）
  //   boType 由 applyBo 权威判定（S3 series_type → BO3/BO5/BO2；S5 局数约束兜底）。
  _cardFromSeries(s, now, followTeamIds) {
    const games = s.games || [];
    const g0 = games[0] || {};
    // v5.1：LP upcoming 系列（games=[]）带 leagueName/leagueId 字段，优先读取；
    //   OpenDota 系列回退 g0.league_name。
    const leagueName = s.leagueName || sources.leagueDisplayName(g0) || g0.league_name || '职业赛事';
    const tier = sources.getMatchTier(s.leagueName || g0.league_name || '');
    const bo = s.boType || 'BO1';
    const boMeta = BO_META[bo] || BO_META.BO1;
    // 队名兜底：groupSeries 对 null 队名回退 '天辉'/'夜魇'，组内找首个真实名替换
    const realName = (sideName, side) => {
      if (sideName && sideName !== '天辉' && sideName !== '夜魇') return sideName;
      for (let i = 0; i < games.length; i++) {
        const n = games[i][side];
        if (n && n !== '天辉' && n !== '夜魇') return n;
      }
      return sideName || '';
    };
    const aName = realName(s.radiantName, 'radiant_name');
    const bName = realName(s.direName, 'dire_name');
    // 系列内是否有关注战队（任一局命中即可）
    let isFollow = false;
    games.forEach((g) => {
      if (g.radiant_team_id != null && followTeamIds[String(g.radiant_team_id)]) isFollow = true;
      if (g.dire_team_id != null && followTeamIds[String(g.dire_team_id)]) isFollow = true;
    });
    // 点击目标：系列内第一个有真实 match_id 的局（upcoming 排期赛常为 0 → 走 leagueId 跳转）
    let matchId = 0;
    games.forEach((g) => { if (!matchId && g.match_id && g.match_id > 0) matchId = g.match_id; });
    const status = s.phase === 'recent' ? 'ended' : s.phase;
    // 分桶：进行中系列跟随「今天」（与 curation live 一致，防跨天角标漂移）；
    //   upcoming/ended 按系列最后一场时间（upcoming 的 lastTime 即开赛时间）。
    const lastSec = s.lastTime || 0;
    const dateKey = status === 'live' ? this._dateKeyOf(now) : this._dateKeyOf(lastSec);
    // 击杀标注：取系列最后一局的击杀数（BO1 单局直接标；多局制标注局号）。
    // v4.3 格式「第N局 击杀 23-18」：标签前置、与中央系列比分区分——
    //   旧格式「第N局 23-18 击杀」数字在前，与上方「1 : 0」连读易误以为两套比分。
    let subScoreText = '';
    const lastGame = games[games.length - 1];
    if (lastGame && lastGame.radiant_score != null && lastGame.dire_score != null) {
      subScoreText = (bo !== 'BO1' ? ('第' + games.length + '局 ') : '') + '击杀 ' +
        lastGame.radiant_score + '-' + lastGame.dire_score;
    }
    // v4.3 状态行（自解释核心）：让中央「1 : 0」明确为系列胜局。
    //   ★ 2026-09-01 修复（用户反馈「比分 1:0 时仍显示第1局进行中」）：
    //     原实现用 `games.length` 作为当前局序号——但 games.length 是 OpenDota 已收录局数，
    //     数据滞后几分钟（第2局开打后 OD 还没收录 → length 仍为 1）→ 与比分 1:0 矛盾。
    //     改用「已结算局数（scoreA+scoreB）+ 1」计算当前局序号，与中央比分永远一致；
    //     同时取 max(games.length, ...) 防止「OD 已收录进行中局但未结算」时漏算。
    //   ★ 文案语义优化：
    //     BO1 单局制 →「比赛进行中」（不强调「第1局」，啰嗦）；
    //     多局制决胜局（当前局序号 = 总局数）→「决胜局进行中」（仪式感）；
    //     其他多局 →「第N局进行中」。
    let statusText = '';
    if (status === 'live') {
      const finishedGames = (s.scoreA || 0) + (s.scoreB || 0);
      const currentGameIdx = Math.max(games.length, finishedGames + 1);
      const totalGames = boMeta.games || 1;
      if (bo === 'BO1') {
        statusText = '比赛进行中';
      } else if (currentGameIdx >= totalGames) {
        statusText = '决胜局进行中';
      } else {
        statusText = '第' + currentGameIdx + '局进行中';
      }
    } else if (status === 'ended') statusText = '已结束';
    // LIVE 副文本：进行时长 · 观赛人数（取 live 源局，轮询自动刷新）
    // v4.3：时长用中文格式（34分 / 1小时5分）——原 formatDuration 输出 mm:ss，易与比分混淆
    let liveSubText = '';
    if (status === 'live') {
      const parts = [];
      games.forEach((g) => {
        if (!g._isLiveSource) return;
        if (g.duration) parts.push(this._fmtDurationCN(g.duration));
        if (g.spectators) parts.push(this._fmtSpectators(g.spectators));
      });
      liveSubText = parts.join(' · ');
    }
    // ★ 2026-09-01（图片加载失败修复）：logo 字符串化兜底 —— 上游（Steam 云代理 /
    //   mergeLiquipediaGroup 透传）可能返回对象形态（{logo: url} 或 {url: ...}）而非字符串，
    //   wxml <image src> 收到对象会被微信序列化成 __pageframe__/components/image-fallback/xxx
    //   路径 → 「Failed to load image」频繁报错。统一提取字符串 URL，非 https 一律置空
    //   （空 → image-fallback 走首字母占位，不再发无效请求）。
    const logoUrlOf = (v) => {
      if (v == null) return '';
      if (typeof v === 'string') return /^https?:\/\//i.test(v) ? v : '';
      if (typeof v === 'object') {
        const u = v.logo || v.url || v.src || '';
        return (typeof u === 'string' && /^https?:\/\//i.test(u)) ? u : '';
      }
      return '';
    };
    return {
      key: 's_' + s.key,          // 前缀防与旧键冲突；series key 形如 's123' / 'm456' / 'orphan_...'
      // ★ 2026-09-01（双卡修复）：透传 series_id 供 ⑥ 段覆盖同系列旧卡（② /live vs ⑥ lpUp 去重）
      seriesId: s.series_id || 0,
      matchId: matchId,
      leagueId: s.leagueId || g0.leagueid,   // v5.1：LP 系列 games=[] 时 g0.leagueid 为 undefined → 优先 s.leagueId（点击跳转联赛详情依赖）
      leagueName: leagueName,
      tierLabel: tier ? tier.label : '',
      tierClass: tier ? 'tier-' + tier.grade.toLowerCase() : '',
      bo: bo,                          // 权威 BO 类型（dots 渲染依据）
      boText: boMeta.label,            // 中文赛制说明（单局制 / 三局两胜 …）
      boGames: boMeta.games,           // 局间色点渲染
      boLabel: bo !== 'BO1' ? bo : '', // 头部缩写标签（BO3/BO5/BO2；BO1 不显示）
      // ★ 2026-09-01（进行中卡修复）：LP live 系列（buildLpLiveSeries）带 Steam 原生队标
      //   （team1Logo/team2Logo，UGC URL）。直出免 _enrichMatchLogos 查询；
      //   _enrichMatchLogos 的 `if (!team.logo) return` 会跳过已带 logo 的队，天然兼容。
      teamA: { id: s.radiantTeamId, name: teamFullName(aName), tag: teamShortTag(aName), logo: logoUrlOf(s.team1Logo) },
      teamB: { id: s.direTeamId, name: teamFullName(bName), tag: teamShortTag(bName), logo: logoUrlOf(s.team2Logo) },
      scoreA: s.scoreA || 0,           // ★ 系列胜局（非击杀）
      scoreB: s.scoreB || 0,
      subScoreText: subScoreText,      // 击杀标注（仅 live 卡渲染，模板按 status 过滤）
      statusText: statusText,          // 中央比分下方状态行（第N局进行中 / 已结束）
      winA: !!s.radiantWin,
      winB: !!s.direWin,
      status: status,
      dateKey: dateKey,
      start: lastSec,
      timeText: this._timeTextOf(lastSec),
      dayText: this._dayTextOf(lastSec),
      liveSubText: liveSubText,
      countdownText: status === 'upcoming' ? this.fmtCountdown(lastSec, now) : '',
      isFollow: isFollow,
      flash: false
    };
  },

  // v8.2：观赛人数格式化（856 → '856人'；12345 → '1.2万人'）
  _fmtSpectators(n) {
    if (!n || n <= 0) return '';
    if (n >= 10000) {
      const w = (n / 10000).toFixed(1);
      return (w.endsWith('.0') ? w.slice(0, -2) : w) + '万人';
    }
    return n + '人';
  },

  // v4.3：直播时长中文格式（34分 / 1小时5分）。
  //   避免 util.formatDuration 的 mm:ss 冒号格式被误读成比分（首页 LIVE 行用）。
  _fmtDurationCN(sec) {
    sec = sec || 0;
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (h > 0) return h + '小时' + (m ? m + '分' : '');
    return (m || 1) + '分';
  },

  // F4（2026-08-31）：curation 赛事级卡片（无队伍信息，仅赛事元数据 + 开赛倒计时）
  //   与 _cardFromPro/Live/TeamMatch 的核心区别：
  //   - card.kind='event'（wxml 模板分支依据，渲染主体不含左右队徽/队名）
  //   - teamA/teamB.id=0 → _enrichMatchLogos 的 `if (!team.id) return` 自动跳过
  //   - boLabel='' → BO 色点渲染的 `if (bo < 2) return` 自动跳过
  //   - scoreA=scoreB=0 → 永不触发比分闪光
  //   点击行为：matchId=0 → onMatchCardTap 走 leagueId 分支跳联赛详情（无需改造）
  _cardFromCuration(ev, now) {
    const start = ev.startDate || 0;
    const started = start <= now;
    const ended = !!(ev.endDate && ev.endDate <= now);
    // 卡片状态：未开赛=upcoming；进行中=live（赛事进行中，dateKey 跟随今天）；已结束=ended
    let status = 'upcoming';
    if (ended) status = 'ended';
    else if (started) status = 'live';
    // 进行中每天出现在"今天"（dateKey 跟随 now），否则固定在 startDate 当天。
    // 不按区间展开到每一天——避免 12 天赛事产生 12 格 +1 的日历角标膨胀（H5 修订）。
    const dateKey = (started && !ended) ? this._dateKeyOf(now) : this._dateKeyOf(start);
    const tier = ev.tier || { grade: 'S', rank: 3, label: 'S级' };
    const lidTag = (ev.leagueId != null && ev.leagueId > 0) ? ev.leagueId : (ev.name || 'unk').slice(0, 6);
    return {
      kind: 'event',                          // ★ 模板分支依据
      key: 'cu_' + lidTag + '_' + start,
      matchId: 0,                             // 赛事级无具体对局
      leagueId: (ev.leagueId != null && ev.leagueId > 0) ? ev.leagueId : 0,
      leagueName: ev.name || '',
      tierLabel: tier ? tier.label : '',
      tierClass: tier ? 'tier-' + tier.grade.toLowerCase() : '',
      bo: 'BO1',
      boText: '',                             // 赛事级不展示赛制
      boGames: 0,                             // 0 → 局间色点渲染跳过
      boLabel: '',                            // 赛事级不展示 BO 标签
      teamA: { id: 0, name: '', tag: '', logo: '' },    // wxml 的 event 分支不渲染队伍
      teamB: { id: 0, name: '', tag: '', logo: '' },
      scoreA: 0, scoreB: 0, winA: false, winB: false,
      subScoreText: '',
      status: status,
      dateKey: dateKey,
      start: start,
      eventEndDate: ev.endDate || 0,          // 模板「至 {{endDateText}}」用
      eventRegion: ev.region || '',           // F4：赛区元数据
      eventPrizePool: ev.prizePool || '',     // F4：奖金池元数据
      timeText: this._timeTextOf(start),
      dayText: this._dayTextOf(start),
      countdownText: started ? '' : this.fmtCountdown(start, now),
      isFollow: false,
      flash: false
    };
  },

  // 按选中日期 + 筛选切片渲染 + LIVE 置顶排序 + 比分变化闪光
  _renderMatchFlow() {
    const selected = this.data.selectedDateKey;
    const filter = this.data.matchFilter;
    const all = this._allMatches || [];
    const dayMatches = all.filter((c) => c.dateKey === selected);
    const counts = { live: 0, upcoming: 0, ended: 0 };
    dayMatches.forEach((c) => { counts[c.status] = (counts[c.status] || 0) + 1; });

    // 排序：进行中（开赛早的在前） > 即将开始（先开先排） > 已结束（晚结束的在前）
    // ★ 2026-09-02 修复 0-falsy bug：rank['live']=0，`rank[a.status] || 9` 会把 0 当 falsy
    //   吞成 9 → 进行中卡全部排到已结束后面。改用显式 undefined 判定。
    const rank = { live: 0, upcoming: 1, ended: 2 };
    const rk = (st) => (st in rank ? rank[st] : 9);
    let list = dayMatches.slice().sort((a, b) => {
      const r = rk(a.status) - rk(b.status);
      if (r !== 0) return r;
      if (a.status === 'ended') return b.start - a.start;
      return a.start - b.start;
    });
    if (filter !== 'all') list = list.filter((c) => c.status === filter);

    // ★ 2026-09-01（P1-2）：LIVE 空态文案 —— 筛选「进行中」无结果时给出明确提示
    //   （/live 职业场可能为 0，用户看到空白会误以为数据源坏了）。
    let emptyText = '该日暂无对局，看看其他日期吧';
    if (filter === 'live') {
      emptyText = '当前暂无职业赛进行中';
    } else if (filter === 'upcoming') {
      emptyText = '该日暂无即将开始的比赛';
    } else if (filter === 'ended') {
      emptyText = '该日暂无已结束的比赛';
    }

    // 比分闪光：与上一次渲染对比（轮询刷新后 score 变化的卡 → flash 置位，400ms 后清除）
    const prev = {};
    (this.data.matchCards || []).forEach((c) => { prev[c.key] = c; });
    const flashTimers = [];
    // v4.2：系列比分变化较少（只在某局结算时跳变），击杀数每次轮询都在变
    //   → 两者任一变化都触发闪光，保证 LIVE 卡的「数据是活的」感知不丢失
    // v4.3：statusText（第N局→第N+1局）也纳入对比——新局开打即闪光
    list.forEach((c) => {
      const p = prev[c.key];
      if (p && (p.scoreA !== c.scoreA || p.scoreB !== c.scoreB ||
                p.status !== c.status || p.subScoreText !== c.subScoreText ||
                p.statusText !== c.statusText)) {
        c.flash = true;
        flashTimers.push(c.key);
      } else if (p) {
        c.flash = false;
      }
    });

    // v4.2：局间色点（BO3/BO5 按系列胜局渲染：A胜=金 / B胜=红 / LIVE当前局=脉冲 / 未打=灰空心）
    //   ★ 修正：旧实现用 /BO(\d)/ 从 boLabel 字符串里抠局数，且用 scoreA/scoreB 算已打局数——
    //     而彼时 scoreA 是击杀数（如 35），远大于 BO3 的 3 局 → 色点恒为「全金」，完全失真。
    //     现在 scoreA/scoreB 已是系列胜局，boGames 是权威赛制局数，两者都是 0..5 的小整数。
    //   仅 live/ended 渲染；upcoming 无比分不画。BO1（boGames<2）无色点。
    list.forEach((c) => {
      c.dots = [];
      if (c.status === 'upcoming') return;
      const bo = c.boGames || 0;
      if (bo < 2) return;
      const sa = Math.min(c.scoreA || 0, bo);
      const sb = Math.min(c.scoreB || 0, bo - sa);
      for (let i = 0; i < bo; i++) {
        let t;
        if (i < sa) t = 'a';
        else if (i < sa + sb) t = 'b';
        else if (c.status === 'live' && i === sa + sb) t = 'now';
        else t = 'tbd';
        c.dots.push({ k: i, t: t });
      }
    });

    this.setData({
      matchCards: list,
      matchCounts: counts,
      matchEmptyText: emptyText
    });

    // 周日历角标重算（count 变化 → setData weekDays）
    const days = this.data.weekDays;
    let daysChanged = false;
    const newDays = days.map((d) => {
      const cnt = (this._dayCounts && this._dayCounts[d.key]) || 0;
      if (d.count !== cnt) { daysChanged = true; return Object.assign({}, d, { count: cnt }); }
      return d;
    });
    if (daysChanged) this.setData({ weekDays: newDays });

    if (flashTimers.length) {
      setTimeout(() => this._clearFlash(flashTimers), 400);
    }

    // logo 懒加载（首屏卡片，getTeam 6h 缓存 + logoCache 30d 缓存）
    this._enrichMatchLogos(list.slice(0, LOGO_ENRICH_CAP));
    // ★ 2026-09-01：LP 排期卡无 team_id（buildLpUpcomingSeries 恒 0），
    //   _enrichMatchLogos 的 `if (!team.id) return` 会跳过它们 → 队徽永远空白。
    //   这些队的队名本身就来自 Liquipedia，改用「按队名」查 Liquipedia 队徽补齐。
    this._enrichNameLogos(list.slice(0, LOGO_ENRICH_CAP));
  },

  // 按队名补齐队徽（LP 排期卡专用）。
  //   背景：Liquipedia 排期数据只有队名（team1Name/team2Name），无 OpenDota team_id，
  //   现有 _enrichMatchLogos 依赖 team.id 批量查 explorer，对这类卡完全失效。
  //   ★ 2026-09-01 修复「Failed to load image liquipedia.net/...」：
  //     liquipedia.getTeamLogo 返回的是 liquipedia.net 图片域 URL，小程序渲染层加载
  //     该域图片会被 Liquipedia 热链保护拦截（net::OK 但加载失败）。
  //     → 改为三级可靠链路：
  //       ① 本地 team-logo-map.json byName（构建时快照，全 Steam CDN 可靠域，零网络）
  //       ② api.findTeamByName（OpenDota /teams 24h 缓存，返回 Steam CDN logo_url）
  //       ③ 前两者都未命中 → 记负缓存（liquipedia.getTeamLogo 不再直接用于 <image> src）
  //   控制：按规范化队名去重 + 会话级缓存/负缓存 + 首屏数量上限，避免请求轰炸。
  // ★ 2026-09-01 v2：按队名查快照的统一匹配（与详情页 _snapByNameFuzzy 同规则）。
  //   ① 精确：norm 直接命中 byName 键
  //   ② 正向模糊：快照键以 norm 开头（简称→全名，levelup→levelupesports），取最短键
  //   ③ 反向模糊：norm 以快照键开头且更长，剩余为修饰词（DYNASTY (stack)→dynasty），取最长键
  //   ⚠️ norm 必须是「去非字母数字」——快照 byName 键由此生成（fetch-team-logos.js）。
  //     原实现 trim().toLowerCase() 保留空格（"klim sani4"），与快照键 klimsani4 永不匹配
  //     → 首页快照命中全部 miss（只能走 findTeamByName 网络兜底）。v2 修复。
  _snapLogoByName(nk) {
    const byName = (_teamLogoLocal && _teamLogoLocal.byName) || {};
    if (!byName || !nk) return '';
    const hit = byName[nk];
    if (hit && /^https?:\/\//i.test(hit.logo)) return hit.logo;
    // 正向：快照键以 norm 开头且长于 norm+3（防 mouz→mouzesports 过度扩展）
    let bestKey = null;
    Object.keys(byName).forEach((k) => {
      if (k.length >= nk.length + 3 && k.indexOf(nk) === 0) {
        if (!bestKey || k.length < bestKey.length) bestKey = k;
      }
    });
    if (bestKey && /^https?:\/\//i.test(byName[bestKey].logo)) return byName[bestKey].logo;
    // 反向：norm 以快照键开头且更长，剩余为修饰词（LP 队名带后缀场景）
    const MODS = ['stack', 'academy', 'esports', 'esport', 'gaming', 'team', 'club', 'gg', 'division', 'x'];
    let revKey = null;
    Object.keys(byName).forEach((k) => {
      if (k.length < 4 || k.length >= nk.length) return;
      if (nk.indexOf(k) === 0 && MODS.indexOf(nk.slice(k.length)) >= 0) {
        if (!revKey || k.length > revKey.length) revKey = k;
      }
    });
    if (revKey && /^https?:\/\//i.test(byName[revKey].logo)) return byName[revKey].logo;
    return '';
  },

  _enrichNameLogos(cards) {
    // ★ v2：norm 统一为「去非字母数字」——与快照 byName 键 / findTeamByName / 详情页
    //   nameTeams 的归一化完全一致。原实现 trim().toLowerCase() 保留空格/加号，
    //   与快照键（klimsani4）永不匹配，首页快照命中全 miss。
    const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    // 收集待查：无 id、有真实队名、尚无 logo、未负缓存
    const jobs = [];
    const seen = {};
    cards.forEach((c, idx) => {
      if (!c || c.kind === 'event') return;
      ['teamA', 'teamB'].forEach((side) => {
        const t = c[side];
        if (!t || t.id || !t.name || t.logo) return;
        if (t.name === '天辉' || t.name === '夜魇') return;
        const nk = norm(t.name);
        if (!nk || seen[nk]) return;
        if (_nameLogoNeg[nk]) return;
        if (_nameLogoCache[nk]) {          // 会话缓存命中 → 同步回填
          const patch = {};
          patch['matchCards[' + idx + '].' + side + '.logo'] = _nameLogoCache[nk];
          this.setData(patch);
          return;
        }
        // ① 本地快照（Steam CDN，最可靠）优先，零网络（精确 + 双向模糊）
        const snapLogo = this._snapLogoByName(nk);
        if (snapLogo) {
          _nameLogoCache[nk] = snapLogo;
          const patch = {};
          patch['matchCards[' + idx + '].' + side + '.logo'] = snapLogo;
          this.setData(patch);
          return;
        }
        seen[nk] = true;
        jobs.push({ idx: idx, side: side, name: t.name, nk: nk });
      });
    });
    if (!jobs.length) return;
    // ② OpenDota /teams 按名匹配（24h 缓存）——注意 findTeamByName 内部对相同查询
    //    有 cached() 短时缓存，但每次调用仍会发起（缓存命中则零网络）。
    //    并发上限由 NAME_LOGO_CAP 控制，未命中记负缓存防重复轰炸。
    jobs.slice(0, NAME_LOGO_CAP).forEach((j) => {
      api.findTeamByName(j.name).then((info) => {
        const url = (info && info.logo_url && /^https?:\/\//i.test(info.logo_url)) ? info.logo_url : '';
        if (url) {
          _nameLogoCache[j.nk] = url;
          // 回填所有同名队（去重后可能多处引用）
          const patch = {};
          (this.data.matchCards || []).forEach((c, i) => {
            if (!c || c.kind === 'event') return;
            ['teamA', 'teamB'].forEach((side) => {
              const t = c[side];
              if (t && !t.id && t.name && norm(t.name) === j.nk && !t.logo) {
                patch['matchCards[' + i + '].' + side + '.logo'] = url;
              }
            });
          });
          if (Object.keys(patch).length) this.setData(patch);
        } else {
          _nameLogoNeg[j.nk] = true;       // 负缓存：本会话不再查同名队
        }
      }).catch(() => { _nameLogoNeg[j.nk] = true; });
    });
  },

  // 清除闪光标记（路径式 setData，不重建数组）
  _clearFlash(keys) {
    if (!this.data.matchCards || !this.data.matchCards.length) return;
    const patch = {};
    this.data.matchCards.forEach((c, i) => {
      if (c.flash && keys.indexOf(c.key) >= 0) {
        patch['matchCards[' + i + '].flash'] = false;
      }
    });
    if (Object.keys(patch).length) this.setData(patch);
  },

  // 比赛卡 logo 懒加载 v2（F6/F8，2026-08-31）：
  //   1. logoCache 命中（30d 缓存）→ 直接 setData（F0 解包修复后）
  //   2. 未命中 → 收集去重 teamId → 一条 explorer SQL 批量取 logo（F6：16 次 getTeam → 1 次批量）
  //   3. explorer 仍未命中的 teamId → 逐队 getTeam 兜底，但用 _logoInflight 去重并发（F8）
  //   4. 兜底失败 → markNegative（24h 负缓存），避免重复轰炸
  _enrichMatchLogos(cards) {
    // 第一遍：缓存命中直接回填；未命中收集到 pending（含去重 id）
    const pending = [];      // [{ idx, side, teamId, key }]
    const idSet = {};
    cards.forEach((c, idx) => {
      ['teamA', 'teamB'].forEach((side) => {
        const team = c[side];
        if (!team || !team.id || team.logo) return;
        if (logoCache.hasNegative(team.id)) return;
        const cached = logoCache.get(team.id);
        if (cached && cached.logo) {
          // F0（2026-08-31）：logoCache.get() 返回 {logo, source, ts} 对象，
          //   此前误把整个对象塞给 image src → "<image src='[object Object]'>" 导致 LOGO 必现空白。
          //   修正：解包取 cached.logo（字符串 URL），与 sources.js:477 / league-detail.js:1703 用法一致。
          const patch = {};
          patch['matchCards[' + idx + '].' + side + '.logo'] = cached.logo;
          this.setData(patch);
          return;
        }
        pending.push({ idx: idx, side: side, teamId: team.id, key: c.key });
        idSet[team.id] = true;
      });
    });
    const ids = Object.keys(idSet).map(Number);
    if (!ids.length) return;

    // F6：一条 explorer SQL 批量取 logo（6h 缓存），返回 team_id -> { name, logo_url }
    api.getTeamLogos(ids).then((logoMap) => {
      // explorer 命中的 → 回填 + 写 logoCache
      const patch = {};
      const found = {};
      Object.keys(logoMap || {}).forEach((tid) => {
        const info = logoMap[tid];
        if (!info || !info.logo_url) return;
        found[tid] = info.logo_url;
        logoCache.set(Number(tid), info.logo_url, 'opendota');
      });
      if (Object.keys(found).length) {
        pending.forEach((p) => {
          if (!found[p.teamId]) return;
          patch['matchCards[' + p.idx + '].' + p.side + '.logo'] = found[p.teamId];
        });
        if (Object.keys(patch).length) this.setData(patch);
      }
      // explorer 未命中的 teamId → 逐队兜底（F8 inflight 去重）
      const missing = ids.filter((id) => !found[id]);
      return this._enrichLogosFallback(missing, pending);
    }).catch(() => {
      // explorer 整体失败 → 全部走兜底（F8 去重仍生效）
      return this._enrichLogosFallback(ids, pending);
    });
  },

  // F8（2026-08-31）：explorer 未命中后的逐队 getTeam 兜底。
  //   _logoInflight[teamId] 缓存进行中的 Promise → 同一战队在多张卡重复出现时只发一次请求。
  //   失败 → markNegative（24h 负缓存）防止每帧轮询重复轰炸同一战队。
  _enrichLogosFallback(teamIds, pending) {
    const inflight = this._logoInflight || (this._logoInflight = {});
    const tasks = teamIds.map((teamId) => {
      if (inflight[teamId]) return inflight[teamId];  // 已有进行中请求 → 复用
      const p = api.getTeam(String(teamId)).then((info) => {
        if (!info) return null;
        return sources.enrichTeamLogo({ id: teamId, name: info.name || '', logo: info.logo_url || '' });
      }).then((r) => {
        if (r && r.logo) {
          // 按 key 定位当前索引（卡片可能被重新排序/过滤）
          const patch = {};
          let any = false;
          pending.forEach((pp) => {
            if (pp.teamId !== teamId || !r.logo) return;
            const cur = this.data.matchCards;
            const i = cur.findIndex((x) => x.key === pp.key);
            if (i < 0) return;
            patch['matchCards[' + i + '].' + pp.side + '.logo'] = r.logo;
            any = true;
          });
          if (any) this.setData(patch);
        } else {
          logoCache.markNegative(teamId);  // F8：失败负缓存，防重复轰炸
        }
        return r;
      }).catch(() => {
        logoCache.markNegative(teamId);
        return null;
      }).then((r) => {
        // 请求完成 → 清理 inflight（失败也要清，否则永久占用）
        if (inflight[teamId] === p) delete inflight[teamId];
        return r;
      });
      inflight[teamId] = p;
      return p;
    });
    return Promise.all(tasks).catch(() => null);
  },

  // ===== LIVE 轮询（F3a：120s 基线，失败退避 180s→300s，成功回归 120s，静默） =====
  _startMatchPolling() {
    if (this._pollTimer) return;
    this._pollFails = this._pollFails || 0;
    const tick = () => {
      this._pollTimer = null;
      // F1（2026-08-31）：轮询通过 _kickMatchFlow 统一入口，复用 epoch 代际守卫与缓存逻辑。
      //   _kickMatchFlow 内部会判断 pro/live 缓存新鲜度，仅在必要时发起请求。
      //   失败计数由 _pollFails 在外层维护，控制退避间隔。
      // ★ 2026-09-01（P1-1）：轮询只拉 live（比分最敏感，60s TTL 缓存）；
      //   pro（已结束比分）走 5min TTL 缓存——proFresh 时 _kickMatchFlow 直接复用 _lastPro，
      //   不再每次轮询都触发 pro 网络（命中 cached 本地缓存也零网络，但省一次调用链）。
      //   若 _lastPro 为空（冷启动首轮），补拉一次 pro 建立基线。
      const proTask = (this._lastPro && this._lastProTs && (Date.now() - this._lastProTs < 5 * 60 * 1000))
        ? Promise.resolve(this._lastPro)
        : api.getProMatches().catch(() => null);
      // ★ 2026-09-02（双卡复现修复 4）：LP 数据过期自动重拉。
      //   背景：P1-1 改动后轮询 tick 只拉 live/pro，LP（_lastLpUp）只在 _kickMatchFlow
      //   完整拉取时更新。若首轮 _fetchLpUpcoming 失败返回 []（truthy 空数组），
      //   _lastLpUp 永远是空 → ⑥ 段覆盖永久失效 → ② 退化卡（职业赛事+单局制）残留。
      //   修复：LP 超过 5min 未更新（含失败情形）→ 轮询时异步补拉一次；成功后用
      //   最新 live 数据立即重合并（LP 的 series 比分/leagueName 是覆盖 ② 卡的关键）。
      const LP_POLL_REFRESH_MS = 5 * 60 * 1000;
      if (!this._lastLpUpTs || (Date.now() - this._lastLpUpTs) > LP_POLL_REFRESH_MS) {
        this._fetchLpUpcoming().then((lpUp) => {
          if (!lpUp || !lpUp.length) return;          // 仍空：等下轮，不清空已有数据
          this._lastLpUp = lpUp;
          this._lastLpUpTs = Date.now();
          // 若本 tick 的合并已完成且 LP 到达更晚 → 用最新缓存数据重合并一次
          if (this._lastPro || this._lastLive) {
            this._applyMatchSources(this._lastPro, this._lastLive, this._followRows || [], lpUp);
          }
        }).catch(() => { /* LP 补拉失败静默，等下轮 */ });
      }
      Promise.all([
        api.getLiveMatches().catch(() => null),
        proTask
      ]).then(([live, pro]) => {
        if (live == null && pro == null) {
          this._pollFails++;
        } else {
          this._pollFails = 0;
          // 把轮询结果写入缓存字段，再调 _kickMatchFlow 走合并 + 渲染路径
          this._lastPro = pro; this._lastProTs = Date.now();
          this._lastLive = live; this._lastLiveTs = Date.now();
          this._applyMatchSources(pro, live, this._followRows || [], this._lastLpUp || []);
        }
        const delay = this._pollFails >= 2 ? POLL_BACKOFF_MAX_MS
          : (this._pollFails === 1 ? POLL_BACKOFF_1_MS : POLL_BASE_MS);
        this._pollTimer = setTimeout(tick, delay);
      }).catch(() => {
        this._pollFails++;
        const delay = this._pollFails >= 2 ? POLL_BACKOFF_MAX_MS : POLL_BACKOFF_1_MS;
        this._pollTimer = setTimeout(tick, delay);
      });
    };
    this._pollTimer = setTimeout(tick, POLL_BASE_MS);
  },

  _stopMatchPolling() {
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
  },

  // 由战队比赛列表构造一张「下一场赛事」卡片
  buildFollowCard(team, matches, now) {
    const list = matches || [];
    if (!list.length) return null;
    const upcoming = list.filter((m) => m.start_time > now).sort((a, b) => a.start_time - b.start_time);
    const past = list.filter((m) => m.start_time <= now).sort((a, b) => b.start_time - a.start_time);
    const pick = upcoming[0] || past[0];
    if (!pick) return null;
    const isUpcoming = pick.start_time > now;
    const tier = sources.getMatchTier(pick.league_name || '');
    const won = (pick.radiant === pick.radiant_win);
    const ownScore = pick.radiant ? pick.radiant_score : pick.dire_score;
    const oppScore = pick.radiant ? pick.dire_score : pick.radiant_score;
    const card = {
      teamId: String(team.id),
      teamName: team.name || ('战队 ' + team.id),
      teamTag: team.tag || (team.name || '?').slice(0, 3).toUpperCase(),
      oppId: pick.opposing_team_id,
      oppName: pick.opposing_team_name || '未知对手',
      oppTag: (pick.opposing_team_name || '?').slice(0, 3).toUpperCase(),
      leagueid: pick.leagueid,
      leagueName: sources.leagueDisplayName(pick) || '',
      displayName: sources.leagueDisplayName(pick),
      tierClass: tier ? 'tier-' + tier.grade.toLowerCase() : '',
      tierLabel: tier ? tier.label : '',
      start: pick.start_time,
      status: isUpcoming ? 'upcoming' : 'ended',
      dateText: util.formatTime(pick.start_time),
      score: ownScore + ':' + oppScore,
      won: won,
      countdownText: ''
    };
    card.countdownText = this.fmtCountdown(pick.start_time, now);
    return card;
  },

  // 自绘倒计时文本（TDesign 小程序版无原生 CountDown，前端每秒校准）
  fmtCountdown(start, now) {
    const diff = start - now;
    if (diff <= 0) return '正在交锋';
    const d = Math.floor(diff / 86400);
    const h = Math.floor((diff % 86400) / 3600);
    const m = Math.floor((diff % 3600) / 60);
    const s = diff % 60;
    const pad = (n) => (n < 10 ? '0' + n : '' + n);
    if (d > 0) return d + '天 ' + pad(h) + ':' + pad(m) + ':' + pad(s);
    return pad(h) + ':' + pad(m) + ':' + pad(s);
  },

  // 每秒 tick：仅当某卡片倒计时文本变化时才用路径更新，避免数组全量重建
  // 优化：删除无用的 nowSec setData（wxml 未引用该字段），合并为单次路径式 setData
  tickCountdown() {
    const now = util.nowSec();
    const cards = this.data.followCards;
    if (!cards.length) return;
    const updates = {};
    let hasChange = false;
    for (let i = 0; i < cards.length; i++) {
      const c = cards[i];
      if (c.status !== 'upcoming') continue;
      const ct = this.fmtCountdown(c.start, now);
      if (ct !== c.countdownText) {
        updates['followCards[' + i + '].countdownText'] = ct;
        hasChange = true;
      }
    }
    if (hasChange) this.setData(updates);
  },

  // 卡片点击：有联赛 id 跳赛事详情，否则跳对手战队详情
  openFollowCard(e) {
    const d = e.currentTarget.dataset;
    if (d.leagueid) {
      wx.navigateTo({ url: '/subpackages/detail/league-detail/league-detail?leagueId=' + d.leagueid + '&name=' + encodeURIComponent(d.leaguename || '') });
    } else if (d.oppid) {
      wx.navigateTo({ url: '/subpackages/detail/team-detail/team-detail?teamId=' + d.oppid });
    }
  },

  openFollowCenter() {
    wx.switchTab({ url: '/pages/follow/follow' });
  },

  goFollowTeams() {
    // 批次0（2026-08-30）：teams 已退出 tabBar，switchTab 改 navigateTo
    wx.navigateTo({ url: '/pages/teams/teams' });
  },

  // 5.2 全局搜索入口
  openSearch() {
    wx.navigateTo({ url: '/pages/search/search' });
  },

  // 快捷入口：跳转到对应页面
  // 批次0（2026-08-30）：3-tab 后仅 index/leagues/follow 为 tab 页（switchTab），
  // teams/data 已退出 tabBar，必须走 navigateTo。
  goTab(e) {
    const p = e.currentTarget.dataset.path;
    if (!p) return;
    const TAB_PATHS = ['/pages/index/index', '/pages/leagues/leagues', '/pages/follow/follow'];
    if (TAB_PATHS.indexOf(p) >= 0) {
      wx.switchTab({ url: p });
    } else {
      wx.navigateTo({ url: p });
    }
  },

  // ===== 2.2 订阅闭环：赛前提醒静默检查 =====
  // 遍历关注战队的比赛列表，对「即将开始」且在提醒窗口内的比赛触发推送。
  // 后台执行，失败不响应用户（静默模式）。
  // ★ 优化：优先用 app.js 预热的同步 openid（getOpenIdSync），未就绪时回退异步 ensureOpenId；
  //   候选筛选并行执行（纯计算无副作用），trigger 串行执行（避免 daily_limit 竞态）。
  checkPreMatchReminders(rows, now) {
    var strategy = reminderStrategy.getStrategy();
    var openid = subscribe.getOpenIdSync();
    if (openid) {
      this._runPreMatchReminders(rows, now, strategy, openid);
    } else {
      subscribe.ensureOpenId().then((oid) => {
        if (!oid) return;
        this._runPreMatchReminders(rows, now, strategy, oid);
      });
    }
  },

  // 抽出实际遍历逻辑，与 openid 获取解耦
  _runPreMatchReminders(rows, now, strategy, openid) {
    // 阶段1：并行筛选出真正需要触发的比赛（纯计算，无副作用）
    var candidates = [];
    rows.forEach(function ({ t, ms }) {
      if (!ms || !ms.length) return;
      var upcoming = ms.filter(function (m) { return m.start_time > now; })
        .sort(function (a, b) { return a.start_time - b.start_time; });
      var match = upcoming[0];
      if (!match) return;
      var ev = reminderStrategy.evaluate(match, strategy, now);
      if (!ev.should) {
        return;
      }
      match.radiant_name = match.radiant_name || (match.radiant ? t.name : '');
      match.dire_name = match.dire_name || (!match.radiant ? t.name : match.opposing_team_name || '');
      match.match_id = match.match_id || String(match.leagueid || '') + '_' + String(match.start_time || '');
      candidates.push(match);
    });
    if (!candidates.length) return;

    // 阶段2：串行 trigger（避免 getTodayCount 竞态导致 daily_limit 突破）
    function triggerNext(idx) {
      if (idx >= candidates.length) return;
      subscribe.triggerPreMatchReminder(candidates[idx], openid)
        .then(function (result) {
          if (result.sent) {
            // 提醒已发送（生产环境静默）
          }
          // daily_limit 命中时提前终止，避免无效请求
          if (result.reason === 'daily_limit') {
            return;
          }
          triggerNext(idx + 1);
        })
        .catch(function () { triggerNext(idx + 1); });
    }
    triggerNext(0);
  }
});
