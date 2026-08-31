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

// 关注卡片流展示上限，避免关注过多战队时批量请求打满 OpenDota 60 req/min
const FOLLOW_CAP = 15;

// ===== 批次2 常量 =====
// LIVE 轮询：正常 60s，失败退避 120s → 300s 封顶（PRD §4.2 复核新增）
const POLL_BASE_MS = 60 * 1000;
const POLL_BACKOFF_1_MS = 120 * 1000;
const POLL_BACKOFF_MAX_MS = 300 * 1000;
// 比赛卡 logo 懒加载上限（首屏可见卡片，避免全列表 2N 次 getTeam）
const LOGO_ENRICH_CAP = 8;
// 阶段判定的 6 小时回退规则（沿用全项目约定）
const LIVE_WINDOW_SEC = 6 * 3600;

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
    matchDegraded: false    // 数据源降级提示（OpenDota 全挂且无缓存）
  },

  onLoad() {
    // O-13（2026-08-15）：记录首次加载时间，onShow 节流基准（60s 内切回不重拉 15 卡）
    this._lastReloadMs = Date.now();
    // 批次2：周锚点（0 = 本周），初始选中今天
    this._weekOffset = 0;
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
  loadFollowCards() {
    const teams = follow.list('teams') || [];
    if (!teams.length) {
      // 合并：原 hasFollow + followCards + hasFollowMatches + followLoading 多次 setData 为单次
      this.setData({ hasFollow: false, followCards: [], hasFollowMatches: false, followLoading: false });
      return;
    }
    // 合并：原 hasFollow + followLoading 两次 setData 为单次
    this.setData({ hasFollow: true, followLoading: true });
    const now = util.nowSec();
    const limited = teams.slice(0, FOLLOW_CAP);
    Promise.all(limited.map((t) =>
      api.getTeamMatches(String(t.id))
        .then((ms) => ({ t: t, ms: ms || [] }))
        .catch(() => ({ t: t, ms: [] }))
    )).then((rows) => {
      const cards = [];
      rows.forEach(({ t, ms }) => {
        const card = this.buildFollowCard(t, ms, now);
        if (card) cards.push(card);
      });
      // F4 分步渲染（2026-07-29）：卡片在横向 scroll-view 中，首屏仅可见 2-3 张。
      //   - 步骤1（首屏）：先渲染前 3 张 + loading:false，用户立即看到首批卡片
      //   - 步骤2（补齐）：剩余卡片异步渲染，避免一次 setData 50-80KB 阻塞
      // 收益：首屏可交互时间提前；关注卡片多时（10+）体感更流畅。
      const FIRST_BATCH = 3;
      if (cards.length <= FIRST_BATCH) {
        // 卡片少时无需分步，单次 setData 即可
        this.setData({
          followCards: cards,
          hasFollowMatches: cards.length > 0,
          followLoading: false
        });
      } else {
        // 步骤1：首屏批次 + 状态
        this.setData({
          followCards: cards.slice(0, FIRST_BATCH),
          hasFollowMatches: true,
          followLoading: false
        });
        // 步骤2：补齐剩余卡片（用 splice 合并到已渲染数组，避免全量重建）
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
      // 批次2：比赛流复用本次已拉的战队比赛列表（不再重复请求），
      // 与 proMatches / live 合并渲染
      this._followRows = rows;
      this._loadMatchFlow();
    }).catch(() => {
      this.setData({ followLoading: false });
    });
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
    if (next < -2 || next > 4) return; // 限 -2~+4 周（proMatches 只覆盖近几天，太远无数据）
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

  // 拉取比赛流三源并合并：proMatches（已结束）+ /live（进行中）+ 关注战队（upcoming/进行中）
  // 数据按 dateKey 分桶存 _allMatches，渲染由 _renderMatchFlow 按选中日期+筛选切片。
  _loadMatchFlow() {
    if (this.data.matchLoading) return;
    this.setData({ matchLoading: true });
    const rows = this._followRows || [];
    Promise.all([
      api.getProMatches().catch(() => null),
      api.getLiveMatches().catch(() => null)
    ]).then(([pro, live]) => {
      const degraded = (pro == null) && (live == null) && !this._allMatches;
      this._applyMatchSources(pro, live, rows);
      this.setData({ matchLoading: false, matchDegraded: !!degraded });
    }).catch(() => {
      this.setData({ matchLoading: false, matchDegraded: !this._allMatches });
    });
  },

  // 三源 → 统一卡片数组（全量，含所有日期），并触发重渲染
  _applyMatchSources(pro, live, rows) {
    const now = util.nowSec();
    const byKey = {};  // matchId（或 leagueid_start 兜底）→ card
    const followTeamIds = {};
    (rows || []).forEach((r) => { followTeamIds[String(r.t.id)] = true; });

    // ① proMatches：已结束（近 ~100 场，覆盖近 2-3 天）
    (pro || []).forEach((m) => {
      if (!m || !m.start_time) return;
      const card = this._cardFromPro(m);
      if (card) byKey[card.key] = card;
    });

    // ② /live 职业场：进行中（league_id > 0；含实时比分）
    (live || []).forEach((m) => {
      if (!m || !m.league_id || m.league_id <= 0) return;
      const card = this._cardFromLive(m);
      if (card) byKey[card.key] = card; // live 优先级高于已结束（覆盖同名）
    });

    // ③ 关注战队比赛：upcoming + 6 小时窗口内的「正在交锋」
    (rows || []).forEach(({ t, ms }) => {
      (ms || []).forEach((m) => {
        if (!m || !m.start_time) return;
        const isFollowMatch = (m.radiant_team_id != null && followTeamIds[String(m.radiant_team_id)]) ||
                              (m.dire_team_id != null && followTeamIds[String(m.dire_team_id)]);
        if (!isFollowMatch) return;
        const started = m.start_time <= now;
        const inLiveWindow = started && (now - m.start_time) < LIVE_WINDOW_SEC;
        // 已结束的场次由 proMatches 覆盖（含联赛名/tier），不重复注入
        if (started && !inLiveWindow) return;
        const card = this._cardFromTeamMatch(m, now, inLiveWindow);
        if (card) {
          // 同一场比赛：/live 已有比分则保留 live 卡，仅补 isFollow 标记
          if (byKey[card.key]) {
            byKey[card.key].isFollow = true;
          } else {
            byKey[card.key] = card;
          }
        }
      });
    });

    this._allMatches = Object.keys(byKey).map((k) => byKey[k]);
    // 按日期分桶 → 周日历角标
    const dayCounts = {};
    this._allMatches.forEach((c) => {
      dayCounts[c.dateKey] = (dayCounts[c.dateKey] || 0) + 1;
    });
    this._dayCounts = dayCounts;
    this._buildWeekDays();
  },

  // proMatches 项 → 已结束卡
  _cardFromPro(m) {
    const leagueName = sources.leagueDisplayName(m) || m.league_name || '';
    const tier = sources.getMatchTier(m.league_name || '');
    const tagOf = (name) => (name || '?').slice(0, 4).toUpperCase();
    return {
      key: String(m.match_id),
      matchId: m.match_id,
      leagueId: m.leagueid,
      leagueName: leagueName,
      tierLabel: tier ? tier.label : '',
      tierClass: tier ? 'tier-' + tier.grade.toLowerCase() : '',
      boLabel: m.series_type === 1 ? 'BO3' : (m.series_type === 2 ? 'BO5' : ''),
      teamA: { id: m.radiant_team_id, tag: tagOf(m.radiant_name), logo: '' },
      teamB: { id: m.dire_team_id, tag: tagOf(m.dire_name), logo: '' },
      scoreA: m.radiant_score,
      scoreB: m.dire_score,
      winA: !!m.radiant_win,
      winB: !m.radiant_win,
      status: 'ended',
      dateKey: this._dateKeyOf(m.start_time),
      start: m.start_time,
      timeText: this._timeTextOf(m.start_time),
      countdownText: '',
      isFollow: false,
      flash: false
    };
  },

  // /live 职业场 → 进行中卡（实时比分）
  _cardFromLive(m) {
    const tagOf = (name) => (name || '?').slice(0, 4).toUpperCase();
    return {
      key: String(m.match_id),
      matchId: m.match_id,
      leagueId: m.league_id,
      leagueName: m.league_name || '职业赛事',
      tierLabel: '',
      tierClass: '',
      boLabel: '',
      teamA: { id: m.team_id_radiant, tag: tagOf(m.team_name_radiant), logo: '' },
      teamB: { id: m.team_id_dire, tag: tagOf(m.team_name_dire), logo: '' },
      scoreA: m.radiant_score || 0,
      scoreB: m.dire_score || 0,
      winA: false,
      winB: false,
      status: 'live',
      dateKey: this._dateKeyOf(Math.floor(Date.now() / 1000)),
      start: util.nowSec(),
      timeText: '',
      countdownText: '',
      isFollow: false,
      flash: false
    };
  },

  // 关注战队比赛 → upcoming / 正在交锋卡
  _cardFromTeamMatch(m, now, isLive) {
    const tier = sources.getMatchTier(m.league_name || '');
    const tagOf = (name) => (name || '?').slice(0, 4).toUpperCase();
    const started = m.start_time <= now;
    const card = {
      // match_id 为 0/空的排期赛用 leagueid_start 兜底 key
      key: (m.match_id && m.match_id > 0) ? String(m.match_id) : (m.leagueid + '_' + m.start_time),
      matchId: (m.match_id && m.match_id > 0) ? m.match_id : 0,
      leagueId: m.leagueid,
      leagueName: sources.leagueDisplayName(m) || m.league_name || '',
      tierLabel: tier ? tier.label : '',
      tierClass: tier ? 'tier-' + tier.grade.toLowerCase() : '',
      boLabel: '',
      teamA: { id: m.radiant_team_id, tag: tagOf(m.radiant_name), logo: '' },
      teamB: { id: m.dire_team_id, tag: tagOf(m.dire_name), logo: '' },
      scoreA: m.radiant_score || 0,
      scoreB: m.dire_score || 0,
      winA: false,
      winB: false,
      status: isLive ? 'live' : 'upcoming',
      dateKey: this._dateKeyOf(m.start_time),
      start: m.start_time,
      timeText: this._timeTextOf(m.start_time),
      countdownText: started ? '' : this.fmtCountdown(m.start_time, now),
      isFollow: true,
      flash: false
    };
    return card;
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
    const rank = { live: 0, upcoming: 1, ended: 2 };
    let list = dayMatches.slice().sort((a, b) => {
      const r = (rank[a.status] || 9) - (rank[b.status] || 9);
      if (r !== 0) return r;
      if (a.status === 'ended') return b.start - a.start;
      return a.start - b.start;
    });
    if (filter !== 'all') list = list.filter((c) => c.status === filter);

    // 比分闪光：与上一次渲染对比（轮询刷新后 score 变化的卡 → flash 置位，400ms 后清除）
    const prev = {};
    (this.data.matchCards || []).forEach((c) => { prev[c.key] = c; });
    const flashTimers = [];
    list.forEach((c) => {
      const p = prev[c.key];
      if (p && (p.scoreA !== c.scoreA || p.scoreB !== c.scoreB || p.status !== c.status)) {
        c.flash = true;
        flashTimers.push(c.key);
      } else if (p) {
        c.flash = false;
      }
    });

    this.setData({
      matchCards: list,
      matchCounts: counts
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

  // 比赛卡 logo 懒加载：logoCache 命中直接用，否则 getTeam + enrichTeamLogo
  _enrichMatchLogos(cards) {
    cards.forEach((c, idx) => {
      ['teamA', 'teamB'].forEach((side) => {
        const team = c[side];
        if (!team || !team.id || team.logo) return;
        if (logoCache.hasNegative(team.id)) return;
        const cached = logoCache.get(team.id);
        if (cached) {
          const patch = {};
          patch['matchCards[' + idx + '].' + side + '.logo'] = cached;
          this.setData(patch);
          return;
        }
        // 未命中缓存：仅对首屏卡片请求（卡片索引 < LOGO_ENRICH_CAP 已在外层限定）
        api.getTeam(String(team.id)).then((info) => {
          if (!info) return null;
          return sources.enrichTeamLogo({ id: team.id, name: info.name || '', logo: info.logo_url || '' });
        }).then((r) => {
          if (!r || !r.logo) return;
          // 卡片可能已被重新排序/过滤：按 key 定位当前索引
          const cur = this.data.matchCards;
          const i = cur.findIndex((x) => x.key === c.key);
          if (i < 0) return;
          const patch = {};
          patch['matchCards[' + i + '].' + side + '.logo'] = r.logo;
          this.setData(patch);
        }).catch(() => { /* logo 失败静默，保留占位 */ });
      });
    });
  },

  // ===== LIVE 轮询（PRD §4.2：60s，失败退避 120s→300s，成功回归 60s，静默） =====
  _startMatchPolling() {
    if (this._pollTimer) return;
    this._pollFails = this._pollFails || 0;
    const tick = () => {
      this._pollTimer = null;
      // 仅刷新比分数据（proMatches/live 均有 TTL 缓存，60s 轮询 ≈ 每 tick 最多 1 真实请求）
      Promise.all([
        api.getLiveMatches().catch(() => null),
        api.getProMatches().catch(() => null)
      ]).then(([live, pro]) => {
        if (live == null && pro == null) {
          this._pollFails++;
        } else {
          this._pollFails = 0;
          this._applyMatchSources(pro, live, this._followRows || []);
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
