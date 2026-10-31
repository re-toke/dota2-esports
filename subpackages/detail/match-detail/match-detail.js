const api = require('../../../utils/api.js');
const util = require('../../../utils/util.js');
const app = getApp();
const liveSources = require('../../../utils/liveSources.js');
const realtime = require('../realtime.js');
const heroes = require('../../../utils/heroes.js');
const sources = require('../../../utils/sources.js');
const matchView = require('../../../utils/matchView.js');

// ★ 2026-10-30（Batch C · C5）：选手/出装/曲线等纯视图函数已抽到 utils/matchView.js，
//   本页只保留数据编排（请求、setData、实时连接）。
// ★ 2026-10-29（P1-1）：战队官方 logo 的 CDN 规则（OpenDota 响应只给 radiant_logo 布尔，
//   不给 URL）⇒ 有官方 logo 时按 team_id 直接拼，省掉两次 getTeam（实测各约 4.7s）。
const TEAM_LOGO_BASE = 'https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/';
// ★ 2026-10-29（A5 战报预填）：跳转方写入 globalData.matchPrefill 的有效期。
//   超过 30s 视为陈旧（用户可能点了卡又干了别的），宁可走骨架也不上错数据。
const PREFILL_MAX_AGE_MS = 30 * 1000;

// 从比赛 objectives 提取关键事件标记（肉山/推塔）已移至 utils/matchView.js（buildEvents）

Page({
  data: {
    matchId: '',
    match: null,         // 比赛原始数据
    radiant: [],          // 天辉方选手明细（含 hero/kda/gpm/xpm/items）
    dire: [],            // 夜魇方选手明细
    radiantWin: false,
    radiantName: '',
    direName: '',
    radiantScore: 0,
    direScore: 0,
    duration: '',
    time: '',
    league: '',
    radiantTeamId: '',    // 5.1 内嵌对战：天辉战队 ID（OpenDota 战队赛才有）
    direTeamId: '',       // 5.1 内嵌对战：夜魇战队 ID
    mvp: null,           // 系列赛 MVP（综合分最高）
    goldAdv: [],         // 经济差曲线（每分钟 radiant - dire，正数天辉领先）
    xpAdv: [],           // 经验差曲线
    goldFinal: 0,        // 最终经济差（>0 天辉领先）
    loading: true,
    error: '',
    updatedAt: 0,
    updatedLabel: '',
    // F1 直播聚合入口
    liveSources: [],
    isLive: false,
    liveStatus: '',      // realtime: '' | 'connected' | 'polling'
    // V4 图表数据
    chartSeries: [],
    chartCats: [],
    chartEvents: [],
    // 4.1 锚点卡（关键指标：比分/胜负/Tier/时间）
    anchorTierLabel: '',
    anchorTierClass: '',
    anchorMeta: [],
    anchorWinSide: '',
    // 队伍 Logo URL（异步获取后注入 anchor-card）
    radiantLogo: '',
    direLogo: '',
    // ★ 2026-10-29（A5）：预填首帧 —— 锚点卡已知队名/赛事，但比分要等 getMatch，
    //   true 时 anchor-card 的比分位显示「—」而不是误导性的 0。
    scorePending: false
  },

  onLoad(options) {
    const matchId = options.matchId;
    if (!matchId) {
      this.setData({ loading: false, error: '缺少比赛 ID' });
      return;
    }
    this.setData({ matchId: matchId });
    wx.setNavigationBarTitle({ title: '战报 #' + matchId });
    // ★ 2026-10-29（A5）：先用跳转方暂存的队名/队徽/赛事渲染锚点卡（首帧 ≤0.3s），
    //   再走 load() 回源校正。预填缺失时退回原骨架流程。
    this._applyPrefill();
    this.load();
  },

  onPullDownRefresh() {
    // force：下拉刷新主动回源，不吃 stale-first
    this.load(true).finally(() => wx.stopPullDownRefresh());
  },

  onUnload() {
    if (this._realtime) {
      this._realtime.close();
      this._realtime = null;
    }
    this._realtimeStarted = false;
  },

  // P1-2：页面被压栈/切后台时暂停实时连接，返回时按需重启（避免后台 30s 轮询空转）
  onHide() {
    if (this._realtime) {
      this._realtime.close();
      this._realtime = null;
      this._realtimeStarted = false;
    }
  },

  onShow() {
    // 直播中返回页面时重启实时连接
    if (this.data.isLive && !this._realtimeStarted) this.startRealtime(this.data.isLive);
  },

  retry() {
    this.load(true);
  },

  // ★ 2026-10-30（C5）：出装映射已移至 utils/matchView.js（buildItems），本页不再保留。

  // ★ 2026-10-29（A5 战报预填）：跳转方（首页卡 / 赛事对战表 / 系列赛小场 / H2H）
  //   已持有队名、队徽、赛事名与比分，写入 `app.globalData.matchPrefill`。
  //   本页 onLoad 直接用它渲染锚点卡（不额外发请求），随后 load() 回源校正。
  //   `exactScore` 为真才上比分：bo 系列卡给的是「系列胜局」，与战报的「击杀数」
  //   语义不同，此时置 scorePending=true 让 anchor-card 显示「—」。
  _applyPrefill() {
    const gd = app.globalData || {};
    const p = gd.matchPrefill;
    gd.matchPrefill = null;   // 一次性消费：避免串到下一场
    if (!p) return false;
    if (String(p.matchId) !== String(this.data.matchId)) return false;
    if (!p.at || (Date.now() - p.at) > PREFILL_MAX_AGE_MS) return false;

    const league = p.league || '';
    const tier = league ? sources.getMatchTier(league) : null;
    const anchorMeta = [];
    const duration = p.duration ? util.formatDuration(p.duration) : '';
    if (duration) anchorMeta.push({ label: '时长', value: duration });
    const time = p.startTime ? util.formatTime(p.startTime) : '';
    if (time) anchorMeta.push({ label: '开赛', value: time });

    const exact = p.exactScore === true;
    this.setData({
      radiantName: p.radiantName || '天辉',
      direName: p.direName || '夜魇',
      radiantTeamId: p.radiantTeamId || '',
      direTeamId: p.direTeamId || '',
      radiantLogo: p.radiantLogo || '',
      direLogo: p.direLogo || '',
      league: league,
      time: time,
      isLive: !!p.isLive,
      anchorTierLabel: tier ? tier.label : '',
      anchorTierClass: tier ? ('tier-' + (tier.grade || '').toLowerCase()) : '',
      anchorMeta: anchorMeta,
      radiantScore: exact ? (p.radiantScore || 0) : 0,
      direScore: exact ? (p.direScore || 0) : 0,
      anchorWinSide: (exact && p.radiantWin != null) ? (p.radiantWin ? 'A' : 'B') : '',
      scorePending: !exact,
      loading: false
    });
    return true;
  },

  // ★ 2026-10-29（A6 stale-first）：默认走 api.getMatch 的「已完赛旧值先上屏 + 后台刷新」，
  //   刷新成功经 onUpdate 回填；force=true（下拉 / 重试）则跳过缓存直接回源。
  load(force) {
    // 预填已出锚点卡 → 不再回退到骨架屏（否则会把首帧内容闪掉）
    const hasData = !!(this.data.radiant && this.data.radiant.length) || this.data.scorePending;
    if (!hasData) this.setData({ loading: true, error: '' });
    return api.getMatch(this.data.matchId, {
      force: !!force,
      onUpdate: (m) => { if (m) this.applyMatch(m); }
    })
      .then((m) => {
        if (!m) {
          this.setData({ loading: false, error: '未找到该比赛' });
          return;
        }
        this.applyMatch(m);
      })
      .catch(() => {
        // 2026-10-29（P0-5）：不再让用户去「检查域名配置」（普通用户无从处理）
        this.setData({ loading: false, error: '加载失败，请检查网络后重试' });
      });
  },

  // 解析并渲染比赛数据（load 与实时推送共用，避免重复逻辑）
  // F3/F4 优化（2026-07-29）：实时推送走轻量更新路径，避免每 30s/事件全量重建选手数组+图表。
  //   - 首次加载 / 比赛结束（radiant_win 从 null 变为布尔）→ 完整渲染
  //   - 直播中推送（已有数据 + 仍在进行 + 仅比分/时长变化）→ 仅更新标量
  applyMatch(m) {
    if (!m) return;
    // P1-2：比赛已分胜负（任何推送路径）→ 立即关闭实时会话，停止 30s 轮询与赛后全量重渲染。
    // 不能放在 _applyLiveUpdate 里——该函数仅在 stillLive=true（radiant_win==null）时被调用。
    if (m.radiant_win != null && this._realtime) {
      this._realtime.close();
      this._realtime = null;
      this._realtimeStarted = false;
    }
    // 轻量更新判定：已有选手数据 + 比赛仍在进行（未分胜负）+ 之前也是直播态
    const hasData = this.data.radiant && this.data.radiant.length > 0;
    const stillLive = m.radiant_win == null && this.data.isLive;
    if (hasData && stillLive) {
      this._applyLiveUpdate(m);
      return;
    }
    const itemMap = (app.globalData && app.globalData.itemMap) || {};

    // ★ 2026-10-29（P0-2 渐进渲染）：首帧只依赖 getMatch —— 用当前已就绪的英雄/物品映射
    //   立即渲染比分/锚点/选手；缺失的头像与出装图标由 _ensureAssets 异步补齐后局部重绘。
    //   原实现 Promise.all([heroes.getHeroes(), items]) 把 loading:false 推迟到
    //   items(336KB / 12s 超时) 与 heroStats 之后 ⇒ 战报最长白等 12–25s。
    this._applyMatchWithData(m, itemMap);
    this._ensureAssets(m);
  },

  // F3/F4 轻量更新：直播推送时仅更新变化的核心标量（比分/时长/状态/更新时间），
  // 跳过选手数组与图表的全量重建（这些在比赛中变化小，重建开销大）。
  // 比赛结束（radiant_win 有值）会走完整渲染路径，确保最终图表/MVP 正确。
  _applyLiveUpdate(m) {
    const at = Date.now();
    const nowSec = Math.floor(at / 1000);
    const isLive = (m.radiant_win == null) && m.start_time &&
                   (nowSec - m.start_time) > 0 && (nowSec - m.start_time) < 12 * 3600;
    const duration = m.duration ? util.formatDuration(m.duration) : '';
    const patch = {
      radiantScore: m.radiant_score || 0,
      direScore: m.dire_score || 0,
      duration: duration,
      isLive: isLive,
      updatedAt: at,
      updatedLabel: util.formatAgo(at)
    };
    // 比赛结束：补胜负态，下次推送将走完整渲染刷新图表/MVP
    if (m.radiant_win != null) {
      patch.radiantWin = !!m.radiant_win;
      patch.anchorWinSide = m.radiant_win ? 'A' : 'B';
      patch.isLive = false;
    }
    this.setData(patch);
  },

  // ★ 2026-10-29（P0-2）：选手数组构建抽为独立方法 —— 首帧渲染与「资源后补重绘」共用。
  //   映射来源优先级：globalData（app 预热 / 本页填充）→ heroes 内存表 → 空（降级文字）。
  //   2026-10-30（C5）：映射逻辑移至 utils/matchView.js（buildPlayers），此处只组装入参。
  _buildPlayers(m, itemMap) {
    const gd = app.globalData || {};
    return matchView.buildPlayers(m, {
      heroMap: gd.heroMap,
      internalMap: gd.heroInternalMap || heroes.internalNameMap() || {},
      itemMap: itemMap
    });
  },

  // 核心渲染逻辑（抽取为独立方法，供 applyMatch 直接调用）
  _applyMatchWithData(m, itemMap) {
    const built = this._buildPlayers(m, itemMap);
    const radiant = built.radiant;
    const dire = built.dire;
    const mvp = built.mvp;

    // 经济/经验曲线 + V4 图表数据（2026-10-30 C5：移至 utils/matchView.js）
    const series = matchView.buildAdvSeries(m);
    const goldAdv = series.goldAdv;
    const xpAdv = series.xpAdv;
    const goldFinal = series.goldFinal;
    const chartSeries = series.chartSeries;
    const chartCats = series.chartCats;
    const chartEvents = series.chartEvents;

    const at = api.fetchedAtOf('match', this.data.matchId) || Date.now();
    // F1：比赛进行中判定 —— 未分胜负且近 12h 开赛视为直播中
    const nowSec = Math.floor(Date.now() / 1000);
    const isLive = (m.radiant_win == null) && m.start_time && (nowSec - m.start_time) > 0 && (nowSec - m.start_time) < 12 * 3600;

    // 4.1 锚点卡：Tier（联赛分级）+ 时长/开赛 元数据
    // 原始名用于分级判定与直播源匹配（保持社区分级规则/检索稳定），展示名走 curation 规范名
    const rawLeagueName = m.league && m.league.name ? m.league.name : '';
    const leagueName = sources.leagueDisplayName(m);
    const tier = rawLeagueName ? sources.getMatchTier(rawLeagueName) : null;
    const duration = m.duration ? util.formatDuration(m.duration) : '';
    const time = util.formatTime(m.start_time);
    const anchorMeta = [];
    if (duration) anchorMeta.push({ label: '时长', value: duration });
    if (time) anchorMeta.push({ label: '开赛', value: time });

    // F3/F4 分步渲染（2026-07-29）：将原单次大 payload setData 拆为两步。
    //   - 步骤1（骨架）：loading:false + 比分/胜负/状态/锚点/liveSources，用户立即看到核心信息
    //   - 步骤2（明细）：选手数组 + 图表数据，下一帧渲染避免阻塞骨架
    // 收益：首屏可交互时间提前；直播推送场景步骤1即可满足"看比分"需求。
    // 步骤1：骨架（标量 + 锚点，体积小，渲染快）
    this.setData({
      match: {
        match_id: m.match_id,
        radiant_win: m.radiant_win,
        duration: m.duration,
        start_time: m.start_time,
        radiant_team_id: m.radiant_team_id,
        dire_team_id: m.dire_team_id,
        league: m.league
      },
      radiantWin: !!m.radiant_win,
      radiantName: m.radiant_name || m.radiant_team_name || '天辉',
      direName: m.dire_name || m.dire_team_name || '夜魇',
      radiantScore: m.radiant_score || 0,
      direScore: m.dire_score || 0,
      duration: duration,
      time: time,
      league: leagueName,
      radiantTeamId: m.radiant_team_id || '',
      direTeamId: m.dire_team_id || '',
      loading: false,
      updatedAt: at,
      updatedLabel: util.formatAgo(at),
      liveSources: liveSources.buildSources(rawLeagueName),
      isLive: isLive,
      anchorTierLabel: tier ? tier.label : '',
      anchorTierClass: tier ? ('tier-' + (tier.grade || '').toLowerCase()) : '',
      anchorMeta: anchorMeta,
      anchorWinSide: isLive ? '' : (m.radiant_win ? 'A' : 'B'),
      scorePending: false   // A5：真实比分已到，撤掉预填的「—」
    });

    // 步骤2：明细（选手数组 + 图表，体积大，独立 setData 避免阻塞骨架渲染）
    this.setData({
      radiant: radiant,
      dire: dire,
      mvp: mvp,
      goldAdv: goldAdv,
      xpAdv: xpAdv,
      goldFinal: goldFinal,
      chartSeries: chartSeries,
      chartCats: chartCats,
      chartEvents: chartEvents
    });

    // T4：直播中进行时建立实时连接（WebSocket 或降级轮询）
    this.startRealtime(isLive);

    // 队徽：直接用比赛响应字段，不再为两队各打一次 getTeam（P1-1）
    this.enrichMatchLogos(m);
  },

  // ★ 2026-10-29（P0-2）：资源（英雄 / 物品表）后到 → 只重绘选手区，不重跑锚点与图表。
  _refreshPlayers(m) {
    if (!m || !this.data.match || this.data.match.match_id !== m.match_id) return;
    const itemMap = (app.globalData && app.globalData.itemMap) || {};
    const built = this._buildPlayers(m, itemMap);
    try {
      this.setData({ radiant: built.radiant, dire: built.dire, mvp: built.mvp });
    } catch (e) { /* 隔离 */ }
  },

  // ★ 2026-10-29（P0-2）：首帧不等英雄 / 物品表；后台补齐后局部重绘。
  //   英雄只拉 /heroes（id + 名称 + 内部名），不拉 heroStats —— 比 heroes.getHeroes() 少一趟。
  _ensureAssets(m) {
    const gd = app.globalData || {};
    if (!gd.heroReady && !this._heroLoading) {
      this._heroLoading = true;
      api.getHeroes()
        .then((list) => {
          const map = {};
          const internal = {};
          (list || []).forEach((h) => {
            if (!h || h.id == null) return;
            map[h.id] = h.localized_name;
            let n = h.name || '';
            if (n.indexOf('npc_dota_hero_') === 0) n = n.slice('npc_dota_hero_'.length);
            internal[h.id] = n;
          });
          gd.heroMap = map;
          gd.heroInternalMap = internal;
          gd.heroReady = true;
          this._refreshPlayers(m);
        })
        .catch(() => {})
        .then(() => { this._heroLoading = false; });
    }
    if (!gd.itemReady && !this._itemsLoading) {
      this._itemsLoading = true;
      api.getItems()
        .then((map) => {
          gd.itemMap = map || {};
          gd.itemReady = true;
          this._refreshPlayers(m);
        })
        .catch(() => {})
        .then(() => { this._itemsLoading = false; });
    }
  },

  // T4：实时比分连接（WebSocket + 断线重连 + 降级轮询）
  startRealtime(isLive) {
    if (this._realtimeStarted || !isLive) return;
    this._realtimeStarted = true;
    const session = realtime.createSession(this.data.matchId, {
      // ★ 2026-10-29（B2）：**轮询必须回源**（`force: true`）—— 否则 30min 本地缓存会让
      //   直播中的比分"永远停在进页面那一刻"（旧实现就是这个症状）。
      //   中转侧 `/od/api/matches/{id}` 的分状态 TTL（直播 15s）保证回源也不会把上游打爆。
      fetchPoll: () => api.getMatch(this.data.matchId, { force: true }),
      onUpdate: (m) => { if (m) this.applyMatch(m); },
      onStatus: (s) => { this.setData({ liveStatus: s }); }
    });
    this._realtime = session;
  },

  // ★ 2026-10-29（P1-1）：队徽直接用比赛响应字段，不再为两队各打一次 getTeam。
  //   OpenDota /matches/{id} 自带 radiant_logo / dire_logo（布尔：该队是否有官方 logo），
  //   URL 可按 Steam CDN 规则直拼 ⇒ 省掉两次 getTeam（实测单次 4.7s）。
  //   无官方 logo 时才走 sources 的 STRATZ / Liquipedia 兜底（仍不调用 getTeam）。
  enrichMatchLogos(m) {
    if (!m) return;
    const items = [
      { id: m.radiant_team_id, hasLogo: !!m.radiant_logo, name: m.radiant_name || '', key: 'radiantLogo' },
      { id: m.dire_team_id, hasLogo: !!m.dire_logo, name: m.dire_name || '', key: 'direLogo' }
    ];
    const patch = {};
    const tasks = [];
    items.forEach((it) => {
      if (!it.id) return;
      const direct = it.hasLogo ? (TEAM_LOGO_BASE + it.id + '.png') : '';
      tasks.push(
        sources.enrichTeamLogo({ id: it.id, name: it.name, logo: direct })
          .then((r) => (r && r.logo) || direct || null)
          .catch(() => direct || null)
          .then((url) => { if (url) patch[it.key] = url; })
      );
    });
    if (!tasks.length) return;
    Promise.all(tasks).then(() => {
      if (Object.keys(patch).length) {
        try { this.setData(patch); } catch (e) { /* 隔离 */ }
      }
    }).catch(() => { /* 隔离 */ });
  },

  // 5.1 赛事详情内嵌「双方对战」：带双方 team_id 上下文跳 H2H 历史对比
  openH2h() {
    const a = this.data.radiantTeamId;
    const b = this.data.direTeamId;
    if (!a || !b) return;
    wx.navigateTo({
      url: '/subpackages/detail/h2h/h2h?teamA=' + a + '&teamB=' + b
    });
  }
});
