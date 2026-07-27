const api = require('../../../utils/api.js');
const util = require('../../../utils/util.js');
const sources = require('../../../utils/sources.js');
const follow = require('../../../utils/follow.js');
const subscribe = require('../../../utils/subscribe.js');
const config = require('../../../utils/config.js');
const liveSources = require('../../../utils/liveSources.js');
const remoteCuration = require('../../../utils/remoteCuration.js');
const heroes = require('../../../utils/heroes.js');

// Steam CDN 英雄头像基址（_sb.png = 小横幅图，约 59x33，aspectFill 裁切填满方形框）
const HERO_IMG_BASE = 'https://cdn.cloudflare.steamstatic.com/apps/dota2/images/heroes/';

// 可信度数值化，取两者中最保守者作为整体可信度
const CONF_RANK = { low: 1, medium: 2, high: 3 };
const CONF_TEXT = { low: '待核实', medium: '较可信', high: '可信' };
function worstConfidence(a, b) {
  if (!a && !b) return 'low';
  const ra = CONF_RANK[a || 'low'];
  const rb = CONF_RANK[b || 'low'];
  const min = Math.min(ra, rb);
  return min >= 3 ? 'high' : (min === 2 ? 'medium' : 'low');
}

// 来源 key -> 中文标签
const SOURCE_BADGES = {
  opendota: 'OpenDota',
  stratz: 'STRATZ',
  steam: 'Steam',
  liquipedia: 'Liquipedia',
  curation: '本地策展',
  community: '社区规则'
};

// 把 sources 返回的 source 标签数组转成统一徽标对象
function buildSourceBadges(srcArr) {
  if (!srcArr || !srcArr.length) return [];
  const seen = {};
  const out = [];
  for (let i = 0; i < srcArr.length; i++) {
    const k = (srcArr[i] || '').toLowerCase();
    if (!k || seen[k]) continue;
    seen[k] = true;
    out.push({ key: k, label: SOURCE_BADGES[k] || srcArr[i] });
  }
  return out;
}

// 状态 -> 中文标签 + 颜色（与赛事列表页 leagues.js 的 statusBadgeOf 保持一致）
function statusBadgeOf(status) {
  if (status === 'ongoing') return { text: '进行中', color: '#1ec896' };
  if (status === 'upcoming') return { text: '即将到来', color: '#ffcf5c' };
  return { text: '已结束', color: '#6b7280' };
}

// 生成 metadata 骨架：确保 KPI Strip 每个字段都有 key，无数据时统一展示 '--'。
function buildMetadataSkeleton() {
  return {
    canonical: null,
    prizePool: null,
    prizePoolCurrency: null,
    location: null,
    format: null,
    organizer: null,
    startDate: null,
    endDate: null,
    participants: null,
    status: null,
    liquipediaSlug: null,
    sources: []
  };
}

// 当 Liquipedia / Steam 元数据缺失（禁用或拉取失败）时，用 curation 本地策展字段兜底，
// 拼成与 kpi-strip 兼容的 metadata 结构（奖金池/地点/赛制/主办方/赛期/参赛队/状态/Liquipedia slug）。
function buildCurationFallback(cur) {
  if (!cur) return null;
  const fmt = function (sec) { return sec ? util.formatTime(sec) : null; };
  return {
    source: 'curation',
    sources: ['curation'],
    canonical: cur.canonical || '',
    prizePool: cur.prizePool != null ? String(cur.prizePool) : null,
    prizePoolCurrency: cur.prizePoolCurrency || null,
    location: cur.region || null,            // curation 用 region，kpi-strip 用 location
    format: cur.format || null,
    organizer: cur.organizer || null,
    startDate: fmt(cur.start) || cur.startDate || null,   // curation 历史字段为 unix 秒
    endDate: fmt(cur.end) || cur.endDate || null,
    participants: cur.participants != null ? cur.participants : null,
    status: cur.status || null,
    liquipediaSlug: cur.liquipediaSlug || null
  };
}

// 合并已有网络元数据与 curation 兜底，确保返回完整骨架。
// 2026-07-27：传入 leagueId + game 上下文，让 curation 引擎走精确 pin + 跨游戏隔离，
// 防止 CS2 同名联赛（如「ESL Pro League S24」）的元数据污染 DOTA2 详情页。
function mergeMetadataWithFallback(meta, name, leagueId) {
  const cur = remoteCuration.curatedEventFor(name, { leagueId: leagueId, game: 'dota2' });
  const fb = cur ? buildCurationFallback(cur) : buildMetadataSkeleton();
  return Object.assign({}, fb, meta || {});
}

Page({
  data: {
    leagueId: '',
    name: '',           // OpenDota 原始联赛名（导航参数传入）
    displayName: '',    // 展示用名称：优先取多源共识名/curation canonical，回退 raw name
    series: [],
    totalSeries: 0,
    loading: true,
    error: '',
    page: 0,
    pageSize: config.pageSize,
    hasMore: false,
    liqTier: null,     // 分级（多源交叉验证：community / curation / OpenDota / STRATZ）
    nameInfo: null,    // 规范赛事名（多源交叉验证：OpenDota / curation / STRATZ）
    quality: null,     // 整体数据可信度徽标
    updatedAt: 0,      // 数据最后采集时间戳（新鲜度）
    updatedLabel: '',
    followed: false,
    metadata: buildMetadataSkeleton(),  // 赛事元数据（Liquipedia + Steam + curation 兜底）
    sourcesText: '',                    // 元数据来源中文名拼接（如 'Liquipedia / Steam'）
    sourceBadges: [],                   // 数据来源徽标列表（统一展示）
    // F1 直播聚合入口
    liveSources: [],   // 各平台直播搜索入口
    isLive: false,     // 赛事是否正在进行（卡片高亮置顶）
    // ===== 两 Tab 状态（C 风格 Tournament Center） =====
    tab: 'matches',          // matches | standings
    expandedGame: '',        // 当前展开的小场 "seriesIdx-gameIdx"（A 风格就地展开英雄阵容）
    // 赛事排名
    standings: [],
    standingsLoading: false,
    standingsLoaded: false,
    // 参赛队伍（从比赛数据推导）
    participantsList: []
  },

  onLoad(options) {
    const name = decodeURIComponent(options.name || '');
    const leagueId = Number(options.leagueId);
    // 2026-07-27 防复发：若传入的 leagueId 不是该赛事在 curation 中 pin 的权威 leagueId，
    // 而 curation 中确有对应精确 pin，尝试重定向到 pin 的 leagueId，避免深层链接/缓存落入次级/低级别 id。
    // （例如：openLeague/data-name 传入的 name 可能与 pin 的 canonical 匹配，但 id 是旧缓存的 19080，
    //   需纠正回 19944）
    const cur = remoteCuration.curatedEventFor(name, { leagueId: leagueId, game: 'dota2' });
    const effectiveId = (cur && cur.leagueId != null && cur.leagueId !== leagueId) ? cur.leagueId : leagueId;
    if (effectiveId !== leagueId) {
      console.log('[league-detail] 联赛 Id 重定向: ' + leagueId + ' -> ' + effectiveId + ' (curation pin)');
      wx.redirectTo({
        url: '/subpackages/detail/league-detail/league-detail?leagueId=' + effectiveId + '&name=' + encodeURIComponent(name)
      });
      return;
    }
    const lid = String(effectiveId);
    this.setData({
      leagueId: lid,
      name: name,
      displayName: name,
      followed: follow.isFollowed('leagues', lid)
    });
    wx.setNavigationBarTitle({ title: name || '赛事详情' });
    // F1 直播聚合入口：按赛事名构建各平台搜索链接
    this.setData({ liveSources: liveSources.buildSources(name) });
    this.load();

    // 分级 / 名称 / 元数据：3 个异步源用计数器统一收口，避免级联 setData。
    // 每个源返回后暂存到 this._pending，3 个全部完成后（或超时 8s）统一 refreshQuality + refreshSourceBadges 一次。
    this._pending = { tier: null, name: null, meta: null };
    this._pendingCount = 0;
    this._pendingTotal = 3;
    const finalize = () => {
      this._pendingCount++;
      if (this._pendingCount < this._pendingTotal) return;
      // 所有源返回，清理超时 timer 并统一刷新一次
      if (this._pendingTimer) {
        clearTimeout(this._pendingTimer);
        this._pendingTimer = null;
      }
      const p = this._pending || {};
      const patch = {};
      if (p.tier) patch.liqTier = p.tier;
      if (p.name) patch.nameInfo = p.name;
      // 展示名优先级：curation canonical（人工校正，最高）> 多源共识名 > 原始 OpenDota 名
      // 理由：curation 条目是人工核实的权威名称（如 "EPL Masters 2026" 实为 "EPL Masters I"），
      //       consensus 投票在名称归一化后分组的票数相同时可能选错（如选了更长的原始名）
      // G5：p.name 来自 voteLeagueNameForMatch（共识投票名），仅在本分支②作为兜底，
      //     展示首选恒为 curation canonical（分支①），绝不直接以共识名作主展示。
      const raw = this.data.name;
      // 2026-07-27：传入 leagueId + game，启用精确 pin + 跨游戏隔离
      const cur2 = remoteCuration.curatedEventFor(raw, { leagueId: this.data.leagueId, game: 'dota2' });
      let display = raw;
      if (cur2 && cur2.canonical && cur2.canonical !== raw) {
        display = cur2.canonical;                           // ① curation 显式校正
      } else if (p.name && p.name.value && p.name.value !== raw) {
        display = p.name.value;                             // ② 多源共识名与原始名不同
      }
      if (display !== raw) {
        patch.displayName = display;
        // 异步更新导航栏标题（避免在 setData 之前调用）
        setTimeout(() => wx.setNavigationBarTitle({ title: display }), 0);
      }
      // 元数据：Liquipedia/Steam 结果 与 curation 兜底合并，确保所有赛事都有完整 KPI 结构
      const mergedMeta = mergeMetadataWithFallback(p.meta, this.data.name, this.data.leagueId);
      patch.metadata = mergedMeta;
      patch.sourcesText = (mergedMeta.sources || []).map((s) => sources.SOURCE_LABEL[s] || s).join(' / ');
      // 合并 quality + sourceBadges 计算
      const t = p.tier, n = p.name, m = p.meta;
      const level = worstConfidence(t && t.confidence, n && n.confidence);
      patch.quality = {
        level: level,
        text: CONF_TEXT[level],
        sources: (t && t.agreement) || 0
      };
      const arr = [];
      if (t && t.sources) t.sources.forEach((s) => arr.push(s));
      if (n && n.sources) n.sources.forEach((s) => arr.push(s));
      if (m && m.sources) m.sources.forEach((s) => arr.push(s));
      patch.sourceBadges = buildSourceBadges(arr);
      this.setData(patch);
      // 元数据兜底后再用比赛窗口/参赛队伍推导一次，保证与 load() 结果最终一致
      this.refreshMetadataDerived();
    };
    // 8s 超时兜底，避免某个源 hang 住导致永远不刷新
    this._pendingTimer = setTimeout(finalize, 8000);

    sources.getLeagueTier({ name: name }).then((t) => {
      if (t && t.grade) {
        this._pending.tier = {
          label: t.label,
          grade: t.grade,
          cls: 'tag-' + t.grade.toLowerCase(),
          confidence: t.confidence,
          agreement: t.agreement,
          sources: t.sources,
          sourceLabel: t.sourceLabel || ''
        };
      }
      finalize();
    }).catch(finalize);

    // G5：voteLeagueNameForMatch 是共识投票名，仅作「无 curation canonical 时的兜底」，
    // 展示首选由 finalize() 的 curation canonical 优先级①保证，切勿直接当主展示名。
    sources.voteLeagueNameForMatch({ name: name, leagueid: leagueId }).then((n) => {
      if (n && n.value) {
        this._pending.name = {
          value: n.value,
          confidence: n.confidence,
          agreement: n.agreement,
          sources: n.sources,
          sourceLabel: n.sourceLabel || '',
          differs: n.value !== name && n.confidence !== 'low'
        };
      }
      finalize();
    }).catch(finalize);

    sources.getLeagueMetadata({ name: name, leagueid: leagueId })
      .then((meta) => {
        if (meta) {
          this._pending.meta = meta;
        } else {
          // Liquipedia 禁用/失败：用 curation 本地策展字段兜底，保证 KPI 仍有数据
          // 2026-07-27：传入 leagueId + game 上下文，启用精确 pin + 跨游戏隔离
          const fb = buildCurationFallback(remoteCuration.curatedEventFor(name, { leagueId: this.data.leagueId, game: 'dota2' }));
          if (fb) this._pending.meta = fb;
        }
        finalize();
      })
      .catch(() => {
        // 2026-07-27：传入 leagueId + game 上下文，启用精确 pin + 跨游戏隔离
        const fb = buildCurationFallback(remoteCuration.curatedEventFor(name, { leagueId: this.data.leagueId, game: 'dota2' }));
        if (fb) this._pending.meta = fb;
        finalize();
      });
  },

  onUnload() {
    // 清理超时 timer，避免离开页面后 setData 触发「Page not exist」错误
    if (this._pendingTimer) {
      clearTimeout(this._pendingTimer);
      this._pendingTimer = null;
    }
  },

  // refreshQuality / refreshSourceBadges 已内联到 onLoad 的 finalize，
  // 保留空壳避免外部调用报错。
  refreshQuality() {},
  refreshSourceBadges() {},

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh());
  },

  retry() {
    this.load();
  },

  load() {
    // 防御：curation 补充的未举办赛事（leagueId 为负数占位 id）没有真实比赛数据，
    // 直接显示「暂无比赛数据」提示，避免发起无效的 API 请求。
    const lid = Number(this.data.leagueId);
    if (!lid || lid < 0 || isNaN(lid)) {
      this.allMatches = [];
      this.allSeries = [];
      this.setData({
        totalSeries: 0,
        series: [],
        page: 0,
        hasMore: false,
        loading: false,
        error: ''
      });
      console.log('[league-detail] leagueId 无效或为 curation 占位(' + this.data.leagueId + ')，跳过 API 请求');
      return Promise.resolve([]);
    }
    this.setData({ loading: true, error: '' });
    return api.getLeagueMatches(this.data.leagueId)
      .then((list) => {
        const raw = list || [];
        console.log('[league-detail] 原始比赛数:', raw.length, '首场字段:', raw[0] ? Object.keys(raw[0]).join(',') : '无数据');
        this.allMatches = raw;  // 保留原始（供系列赛聚合用）
        // 系列赛聚合：按 series_id 归组 BO3/BO5，同一系列多场聚到一张卡
        this.allSeries = sources.groupSeries(raw).map((s) => {
          s.games = s.games.map((m) => this.fmt(m));
          return s;
        });
        console.log('[league-detail] 聚合后系列赛数:', this.allSeries.length,
          'BO分布:', this.allSeries.map(function(s){return s.boType;}).join(','));
        const pageSize = this.data.pageSize;
        const slice = this.allSeries.slice(0, pageSize);
        const at = api.fetchedAtOf('leagueMatches', this.data.leagueId);
        // F1：赛事进行中判定 —— 存在「未分胜负 + 近 12h 开赛」的比赛即视为直播中
        const nowSec = Math.floor(Date.now() / 1000);
        const isLive = (raw || []).some((m) =>
          (m.radiant_win == null) && m.start_time && (nowSec - m.start_time) > 0 && (nowSec - m.start_time) < 12 * 3600
        );
        // 统一赛事窗口（与列表页一致）：用真实比赛数据 min(start_time) ~ max(start_time + duration)。
        // 有比赛时，覆盖 curation/Liquipedia 的"嘉年华"宽窗口（如 EWC 全代 07-06~08-23），
        // 避免与列表的 7/20-7/25 冲突；状态同样基于真实结束时间，已结束即显示"已结束"。
        const mList = raw || [];
        let mStart = 0, mEnd = 0;
        mList.forEach((m) => {
          const st = m.start_time || 0;
          const en = st + (m.duration || 0);
          if (st && (!mStart || st < mStart)) mStart = st;
          if (en > mEnd) mEnd = en;
        });
        let eventWindow = null;
        if (mStart && mEnd) {
          const wn = { earliest: mStart, latest: mStart, lastEnd: mEnd };
          const st = util.statusOf(wn);
          const badge = statusBadgeOf(st);
          eventWindow = {
            start: mStart,
            end: mEnd,
            range: util.formatDateRange(mStart, mEnd),                        // M/D，与列表一致
            fullRange: util.formatTime(mStart) + ' ~ ' + util.formatTime(mEnd), // KPI 全日期
            status: st,
            statusText: badge.text,
            statusColor: badge.color
          };
        }
        this._matchWindow = eventWindow ? { start: mStart, end: mEnd } : null;
        // 合并为单次 setData
        this.setData({
          totalSeries: this.allSeries.length,
          series: slice,
          page: 0,
          hasMore: this.allSeries.length > slice.length,
          loading: false,
          updatedAt: at,
          updatedLabel: util.formatAgo(at),
          isLive: isLive,
          eventWindow: eventWindow
        });
        this.refreshMetadataDerived();
        this.enrichTeamNames();
      })
      .catch((err) => {
        console.error('[league-detail] 加载失败:', err);
        this.setData({ loading: false, error: '加载失败，请检查网络或域名配置' });
      });
  },

  // 队名补全：收集队名为空的 team_id，一次 /explorer SQL 批量查 teams.name 回填。
  // 补全后用路径更新仅刷新受影响行（series[i].games[j] + series 头部队名）。
  enrichTeamNames() {
    if (!this.allSeries || !this.allSeries.length) return;
    const need = {};
    this.allSeries.forEach((s) => {
      s.games.forEach((m) => {
        if (m.radiantTeamId != null && !m.radiantName) need[m.radiantTeamId] = true;
        if (m.direTeamId != null && !m.direName) need[m.direTeamId] = true;
      });
    });
    // 参赛队伍（participantsList）中"Team {id}"占位名的 id 一并加入查询，避免漏网。
    // 仅占位被命中，真名（如"Team Secret"）不会被误匹配（/^Team \d+$/ 要求纯数字 id）。
    (this.data.participantsList || []).forEach((t) => {
      if (t && /^Team \d+$/.test(t.name) && t.id != null) need[t.id] = true;
    });
    const ids = Object.keys(need).filter((x) => x !== 'null' && x !== '');
    if (!ids.length) return;
    api.getTeamNames(ids)
      .then((nameMap) => {
        const patch = {};
        const visible = this.data.series;
        visible.forEach((s, si) => {
          s.games.forEach((m, gi) => {
            if (!m.radiantName && m.radiantTeamId != null && nameMap[m.radiantTeamId]) {
              patch['series[' + si + '].games[' + gi + '].radiantName'] = nameMap[m.radiantTeamId];
            }
            if (!m.direName && m.direTeamId != null && nameMap[m.direTeamId]) {
              patch['series[' + si + '].games[' + gi + '].direName'] = nameMap[m.direTeamId];
            }
          });
          // 系列头部队名若为占位（天辉/夜魇）则用第一场补全
          const fg = s.games[0];
          if (s.radiantName === '天辉' && fg && nameMap[fg.radiantTeamId]) {
            patch['series[' + si + '].radiantName'] = nameMap[fg.radiantTeamId];
          }
          if (s.direName === '夜魇' && fg && nameMap[fg.direTeamId]) {
            patch['series[' + si + '].direName'] = nameMap[fg.direTeamId];
          }
        });
        // 同步更新 allSeries 内存缓存
        this.allSeries.forEach((s) => {
          s.games.forEach((m) => {
            if (!m.radiantName && m.radiantTeamId != null && nameMap[m.radiantTeamId]) m.radiantName = nameMap[m.radiantTeamId];
            if (!m.direName && m.direTeamId != null && nameMap[m.direTeamId]) m.direName = nameMap[m.direTeamId];
          });
          const fg = s.games[0];
          if (s.radiantName === '天辉' && fg && nameMap[fg.radiantTeamId]) s.radiantName = nameMap[fg.radiantTeamId];
          if (s.direName === '夜魇' && fg && nameMap[fg.direTeamId]) s.direName = nameMap[fg.direTeamId];
        });
        // 参赛队伍（participantsList）占位名补全：同步覆盖"Team {id}"为真实队名
        const curParticipants = this.data.participantsList || [];
        if (curParticipants.length) {
          const patchedParticipants = curParticipants.map((t) => {
            if (t && /^Team \d+$/.test(t.name) && nameMap[t.id]) {
              return Object.assign({}, t, { name: nameMap[t.id] });
            }
            return t;
          });
          const participantsChanged = patchedParticipants.some((t, i) => t.name !== curParticipants[i].name);
          if (participantsChanged) patch.participantsList = patchedParticipants;
        }
        if (Object.keys(patch).length) this.setData(patch);
      })
      .catch((err) => {
        // 2026-07-27：队名补全失败日志（非静默吞错），方便排查「队伍名显示为占位」的根因。
        console.warn('[league-detail] enrichTeamNames 失败，队伍将保留为 "Team {id}" 占位:', err);
      });
  },

  fmt(m) {
    return {
      match_id: m.match_id,
      radiantName: m.radiant_team_name || '',
      direName: m.dire_team_name || '',
      radiantTeamId: m.radiant_team_id,
      direTeamId: m.dire_team_id,
      radiantScore: m.radiant_score,
      direScore: m.dire_score,
      radiantWin: m.radiant_win,
      time: util.formatTime(m.start_time),
      duration: m.duration ? util.formatDuration(m.duration) : ''
    };
  },

  // 从比赛数据推导参赛队伍，并补充 metadata 中缺失的字段（状态/日期/参赛队数）。
  // 在 load() 和 finalize() 都会调用，保证无论网络源快慢最终状态一致。
  refreshMetadataDerived() {
    const meta = Object.assign({}, buildMetadataSkeleton(), this.data.metadata || {});
    const raw = this.allMatches || [];

    // 1) 参赛队伍列表：按 team_id 去重，优先用已有队名，占位名后续 enrichTeamNames 会回填
    const teamMap = {};
    raw.forEach((m) => {
      if (m.radiant_team_id != null) teamMap[m.radiant_team_id] = m.radiant_team_name || null;
      if (m.dire_team_id != null) teamMap[m.dire_team_id] = m.dire_team_name || null;
    });
    // 防 finalize 后调用覆盖 enrichTeamNames 的真实名：
    // 仅当 t.id 在 raw 中出现过（teamMap 已有该 key）时，才用 prev 的真名填补 raw 缺的 name。
    // "待定队伍 N"（id 为负，不在 teamMap 中）会被正确丢弃，避免混入真实参赛队列表。
    (this.data.participantsList || []).forEach((t) => {
      if (!t || t.id == null || !(t.id in teamMap)) return;
      if (!teamMap[t.id] && t.name && !/^Team \d+$/.test(t.name)) {
        teamMap[t.id] = t.name;
      }
    });
    // 占位兜底：仍无名的用 "Team {id}"，等 enrichTeamNames 回填
    Object.keys(teamMap).forEach((k) => { if (!teamMap[k]) teamMap[k] = 'Team ' + k; });
    let participantsList = Object.keys(teamMap).map((id) => ({ id: Number(id), name: teamMap[id] }));

    // 1.5) Roster 完成（2026-07-27）：赛事进行中常出现「metadata 标 16 队但仅 13 队登场」的场景
    // （如 EPL Masters I 86 场只覆盖 13 支队伍）。原先只在 participantsList 为空时才补占位，
    // 导致 metadata 「参赛队 16」与实际显示「13 支」长期不一致 —— 给人"数据错误"的错觉。
    // 修复：只要 metadata.participants > 实际参赛队数，补足到与 metadata 一致（占位「待定队伍 N」，
    // id 用负数，避免与真实 team_id 冲突，且不会被 teamMap 反向覆盖）。
    const metaParticipants = Number(meta.participants);
    if (metaParticipants > 0 && metaParticipants > participantsList.length) {
      const need = metaParticipants - participantsList.length;
      const existingIds = new Set(participantsList.map((t) => t && t.id));
      const fillers = [];
      for (let i = 0; i < need; i++) {
        const fakeId = -1 - i;
        if (!existingIds.has(fakeId)) {
          fillers.push({ id: fakeId, name: '待定队伍 ' + (i + 1) });
        }
      }
      if (fillers.length) {
        participantsList = participantsList.concat(fillers);
        // 数据完整性告警：与 metadata 不一致便于排查（云函数缓存/Curation 漂移）
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('[league-detail] 参赛队数与 metadata 不一致：',
            'actual=' + (participantsList.length - fillers.length),
            'meta=' + metaParticipants,
            '— 已补 ' + fillers.length + ' 个待定队伍占位');
        }
      }
    }
    // 1.6) 无比赛数据时，用 curation/Liquipedia 提供的参赛队数生成纯占位列表（保留旧行为）
    if (!participantsList.length && metaParticipants > 0) {
      participantsList = Array.from({ length: metaParticipants }, (_, i) => ({ id: -1 - i, name: '待定队伍 ' + (i + 1) }));
    }

    // 2) 用真实比赛窗口补齐 metadata
    const ew = this.data.eventWindow;
    if (ew) {
      meta.status = meta.status || ew.statusText;
      meta.startDate = meta.startDate || util.formatTime(ew.start);
      meta.endDate = meta.endDate || util.formatTime(ew.end);
    }
    // 3) 参赛队数：curation/Liquipedia 优先；无则用比赛数据推导
    if ((meta.participants == null || meta.participants === '') && participantsList.length) {
      meta.participants = participantsList.length;
    }

    this.setData({ metadata: meta, participantsList: participantsList });
  },

  slicePage(reset) {
    const pageSize = this.data.pageSize;
    const page = reset ? 0 : this.data.page;
    const slice = this.allSeries.slice(0, (page + 1) * pageSize);
    this.setData({ series: slice, page: page, hasMore: this.allSeries.length > slice.length });
  },

  appendPage() {
    const page = this.data.page + 1;
    const pageSize = this.data.pageSize;
    const slice = this.allSeries.slice(0, (page + 1) * pageSize);
    this.setData({ series: slice, page: page, hasMore: this.allSeries.length > slice.length });
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) this.appendPage();
  },

  toggleFollow() {
    const followed = follow.toggle('leagues', { id: this.data.leagueId, name: this.data.name });
    this.setData({ followed: followed });
    wx.showToast({ title: followed ? '已关注' : '已取消关注', icon: 'none' });
    if (followed) subscribe.requestSubscribe();
  },

  openTeam(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: '/subpackages/detail/team-detail/team-detail?teamId=' + id });
  },

  // 复制 Liquipedia 赛事页链接（小程序 web-view 需业务域名白名单，故采用复制兜底）
  openLiquipedia(e) {
    const slug = e.currentTarget.dataset.slug;
    if (!slug) return;
    const url = 'https://liquipedia.net/dota2/' + encodeURIComponent(slug);
    wx.setClipboardData({ data: url, success: () => wx.showToast({ title: '链接已复制', icon: 'none' }) });
  },

  // ===== 两 Tab 切换（C 风格） =====
  switchTab(e) {
    const key = e.currentTarget.dataset.key;
    if (key === this.data.tab) return;
    this.setData({ tab: key, expandedGame: '' });
    // 懒加载赛事排名
    if (key === 'standings' && !this.data.standingsLoaded) {
      this.loadStandings();
    }
  },

  // Tab 2: 赛事排名（按已结束比赛聚合队伍胜负）
  loadStandings() {
    this.setData({ standingsLoading: true });
    sources.getLeagueStandings(this.data.leagueId).then((list) => {
      const standings = list || [];
      // 队名补全：OpenDota /api/matches 返回的 radiant_team_name / dire_team_name
      // 可能为空，导致 getLeagueStandings 回退为 "Team {id}" 占位符。
      // 收集所有占位名称的 team_id，一次 explorer SQL 批量查 teams.name 回填（与 enrichTeamNames 同模式）。
      const need = {};
      standings.forEach((row) => {
        if (row.name && /^Team \d+$/.test(row.name) && row.team_id) {
          need[row.team_id] = true;
        }
      });
      const ids = Object.keys(need).filter((x) => x !== 'null' && x !== '');
      if (ids.length) {
        api.getTeamNames(ids).then((nameMap) => {
          const patched = standings.map((row) => {
            if (row.team_id != null && nameMap[row.team_id]) {
              return Object.assign({}, row, { name: nameMap[row.team_id], tag: (nameMap[row.team_id] || '').slice(0, 4).toUpperCase() });
            }
            return row;
          });
          this.setData({ standings: patched, standingsLoading: false, standingsLoaded: true });
        }).catch(() => {
          this.setData({ standings: standings, standingsLoading: false, standingsLoaded: true });
        });
      } else {
        this.setData({ standings: standings, standingsLoading: false, standingsLoaded: true });
      }
    }).catch(() => {
      this.setData({ standingsLoading: false, standingsLoaded: true });
    });
  },

  // ===== A 风格就地展开小场英雄阵容（双索引 seriesIdx-gameIdx） =====
  toggleGame(e) {
    const idx = e.currentTarget.dataset.idx;  // "si-gi" 格式
    if (this.data.expandedGame === idx) {
      this.setData({ expandedGame: '' });
      return;
    }
    this.setData({ expandedGame: idx });
    const parts = idx.split('-');
    const si = Number(parts[0]);
    const gi = Number(parts[1]);
    const s = this.data.series[si];
    if (!s) return;
    const m = s.games[gi];
    if (!m || m.detail) return;
    const path = 'series[' + si + '].games[' + gi + ']';
    this.setData({ [path + '.loadingDetail']: true });

    // 并行取比赛详情 + 英雄库（英雄库已内存缓存，二次调用零网络）。
    // 注意：OpenDota /matches/{id} 的 player 仅含 hero_id（数字），不含 hero 对象，
    // 故头像 URL 必须靠 hero_id → 英雄内部名（antimage/luna）映射，再拼 Steam CDN。
    const detailP = api.getMatch(m.match_id);
    const heroesP = heroes.getHeroes().catch(() => []);
    Promise.all([detailP, heroesP]).then((res) => {
      const detail = res[0];
      const heroList = res[1] || [];
      if (!detail || !detail.players) {
        this.setData({ [path + '.loadingDetail']: false, [path + '.detail']: null });
        return;
      }
      // id -> 内部名（拼 CDN 头像 URL）
      // 注意：OpenDota /heroes 的 name 带 npc_dota_hero_ 前缀（如 npc_dota_hero_antimage），
      // Steam CDN 路径不需要此前缀（只需 antimage），故需 strip。
      const NPC_PREFIX = 'npc_dota_hero_';
      const internalMap = {};
      heroList.forEach((h) => {
        if (h && h.id != null) {
          let n = h.name || '';
          if (n.indexOf(NPC_PREFIX) === 0) n = n.slice(NPC_PREFIX.length);
          internalMap[h.id] = n;
        }
      });
      const heroMap = (getApp().globalData && getApp().globalData.heroMap) || {};
      const radiantHeroes = [];
      const direHeroes = [];
      let mvp = null;
      let mvpScore = -1;
      detail.players.forEach((p) => {
        const isRadiant = (p.isRadiant != null) ? p.isRadiant : (p.player_slot < 128);
        const kda = p.deaths > 0 ? (p.kills + p.assists) / p.deaths : (p.kills + p.assists);
        const heroName = heroMap[p.hero_id] || ('H' + p.hero_id);
        // Steam CDN 英雄头像：hero_id → 内部名（已 strip npc_dota_hero_ 前缀，如 antimage/luna）
        const heroInternalName = internalMap[p.hero_id] || '';
        const heroImg = heroInternalName
          ? (HERO_IMG_BASE + encodeURIComponent(heroInternalName) + '_sb.png')
          : '';
        const item = {
          hero_id: p.hero_id,
          name: heroName,
          short: (heroName || '?').slice(0, 4),
          img: heroImg,
          kda: (p.kills || 0) + '/' + (p.deaths || 0) + '/' + (p.assists || 0),
          kdaScore: Math.round(kda * 100) / 100,
          gpm: p.gold_per_min || 0,
          playerName: p.name || p.personaname || ''
        };
        if (isRadiant) radiantHeroes.push(item);
        else direHeroes.push(item);
        const score = kda * 2 + (p.gold_per_min || 0) / 100;
        if (score > mvpScore) {
          mvpScore = score;
          mvp = {
            name: item.playerName,
            kda: item.kda,
            kdaScore: item.kdaScore,
            gpm: item.gpm,
            hero: item.name
          };
        }
      });
      // 路径更新：仅设置该小场的 detail
      this.setData({
        [path + '.loadingDetail']: false,
        [path + '.detail']: { radiantHeroes: radiantHeroes, direHeroes: direHeroes, mvp: mvp }
      });
    }).catch(() => {
      this.setData({ [path + '.loadingDetail']: false, [path + '.detail']: null });
    });
  },

  // 跳转战报二级页（B 风格 match-detail）
  openMatch(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: '/subpackages/detail/match-detail/match-detail?matchId=' + id });
  }
});
