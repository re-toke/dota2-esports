const api = require('../../../utils/api.js');
const util = require('../../../utils/util.js');
const sources = require('../../../utils/sources.js');
const follow = require('../../../utils/follow.js');
const subscribe = require('../../../utils/subscribe.js');
const config = require('../../../utils/config.js');
const liveSources = require('../../../utils/liveSources.js');
const remoteCuration = require('../../../utils/remoteCuration.js');
const liquipedia = require('../../../utils/liquipedia.js');
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
    // ===== 三段式分段计数（2026-07-28 新增） =====
    // series[] 按 phase 分段：live(desc) → upcoming(asc) → recent(desc)
    // liveCount/upcomingCount/recentCount 供 wxml 渲染分段分隔符与计数
    liveCount: 0,
    upcomingCount: 0,
    recentCount: 0,
    // 已结束段默认折叠（聚焦 LIVE/UPCOMING），点击分隔符展开
    recentCollapsed: false,
    // ===== 三 Tab 状态（C 风格 Tournament Center） =====
    tab: 'matches',          // matches | teams | standings
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
      // 2026-07-28 修复 BUG 3：统一 KPI 名称与头部名称的取值来源。
      // 此前 meta.canonical 来自 Liquipedia（tpl.name），patch.displayName 来自 curation canonical，
      // 两者走不同路径，可能产生「头部显示 EPL Masters I 而 KPI 显示 EPL Masters 2026」的不一致。
      // 修复：以已计算的 display（curation canonical 优先）覆盖 meta.canonical，
      // 保证 KPI 概述卡与头部展示名完全一致。
      if (display && display !== mergedMeta.canonical) {
        mergedMeta.canonical = display;
      }
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

    sources.getLeagueTier({ name: name, leagueid: leagueId }).then((t) => {
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
    // ★ 并行拉取 OpenDota 比赛数据 + Liquipedia 赛程数据
    // OpenDota 只返回已结束的比赛（duration>0, radiant_win 有值），
    // 进行中（LIVE）和未开赛（UPCOMING）的对阵需要从 Liquipedia {{Match}} 模板补充。
    // Liquipedia 请求失败时静默降级，仅显示 OpenDota 数据。
    return Promise.all([
      api.getLeagueMatches(this.data.leagueId),
      liquipedia.getScheduledMatches(this.data.name)
    ])
      .then(([list, scheduledMatches]) => {
        const raw = list || [];
        const liqScheduled = scheduledMatches || [];
        console.log('[league-detail] 原始比赛数:', raw.length, 'Liquipedia 赛程数:', liqScheduled.length,
          raw[0] ? '首场字段:' + Object.keys(raw[0]).join(',') : '无数据');
        this.allMatches = raw;  // 保留原始（供系列赛聚合用）
        // 系列赛聚合：按 series_id 归组 BO3/BO5，同一系列多场聚到一张卡
        // 2026-07-28 修复小圆点颜色 BUG：传入 series 的 A/B 队 team_id 锚点给 fmt，
        // 让每场 game 计算 aWin（A 队是否赢该场），WXML 据此着色。
        // 此前 fmt 只赋值 radiantWin（=radiant_win 原始值），WXML 用 g.radiantWin 判定颜色，
        // 但 radiant_win 只代表「天辉是否赢」，不等于「A 队（首场 radiant 方）是否赢」。
        // BO3/BO5 中双方会换边，第 2/3 场 radiant 可能是首场的 dire（B 队），
        // 此时 radiant_win=true 反而代表 B 队赢，小圆点会显示错误颜色。
        // 此外 radiant_win=null（未结束）会走 else 分支显示红色，未结束比赛不应着色。
        const seriesAnchor = { teamAId: 0, teamBId: 0 };
        // nowSec 用于 upcoming 倒计时格式化（与 groupSeries 内部判定保持一致）
        const fmtNowSec = Math.floor(Date.now() / 1000);
        this.allSeries = sources.groupSeries(raw).map((s) => {
          seriesAnchor.teamAId = s.radiantTeamId;
          seriesAnchor.teamBId = s.direTeamId;
          s.games = s.games.map((m) => this.fmt(m, seriesAnchor));
          // ★ 为 upcoming series 补全展示字段（2026-07-28 新增）
          // scheduledTimeText：开赛时间紧凑格式 'M/D HH:MM'，替代比分位显示
          // countdownText：距开赛时长，如 '2小时后' / '3天后' / '即将开始'（<5分钟）
          if (s.isUpcoming) {
            const st = s.lastTime;  // upcoming 段 lastTime 即开赛时间
            const d = new Date(st * 1000);
            const md = (d.getMonth() + 1) + '/' + d.getDate();
            const hh = ('0' + d.getHours()).slice(-2);
            const mm = ('0' + d.getMinutes()).slice(-2);
            s.scheduledTimeText = md + ' ' + hh + ':' + mm;
            const diffSec = st - fmtNowSec;
            if (diffSec <= 300) {
              s.countdownText = '即将开始';
            } else if (diffSec < 3600) {
              s.countdownText = Math.floor(diffSec / 60) + '分钟后';
            } else if (diffSec < 86400) {
              s.countdownText = Math.floor(diffSec / 3600) + '小时后';
            } else {
              s.countdownText = Math.floor(diffSec / 86400) + '天后';
            }
          }
          return s;
        });
        console.log('[league-detail] 聚合后系列赛数:', this.allSeries.length,
          'BO分布:', this.allSeries.map(function(s){return s.boType;}).join(','));

        // ★ 合并 Liquipedia 赛程数据（2026-07-28 新增）
        // OpenDota 只返回已结束比赛，进行中/未开赛的对阵需要从 Liquipedia {{Match}} 模板补充。
        // 转换为与 groupSeries 返回值兼容的 series 对象，去重后合并到 allSeries。
        if (liqScheduled && liqScheduled.length) {
          // 构建 OpenDota 已有对阵的去重键（队名归一化：小写+去空格）
          // 用于剔除 Liquipedia 中已被 OpenDota 返回的已结束对阵
          const openDotaKeys = new Set();
          this.allSeries.forEach(function (s) {
            if (s.radiantName && s.direName) {
              const k1 = (s.radiantName.toLowerCase().replace(/\s+/g, '')) + '__' +
                         (s.direName.toLowerCase().replace(/\s+/g, ''));
              openDotaKeys.add(k1);
              // 反向也加入（Liquipedia 的 team1/team2 顺序可能与 OpenDota 相反）
              openDotaKeys.add(k1.split('__').reverse().join('__'));
            }
          });
          // 将 Liquipedia 赛程转换为 series 对象
          const liqSeries = liqScheduled
            .filter(function (m) {
              // 去重：剔除 OpenDota 已返回的对阵（队名归一化后匹配）
              if (!m.team1Name || !m.team2Name) return false;
              const k = (m.team1Name.toLowerCase().replace(/\s+/g, '')) + '__' +
                        (m.team2Name.toLowerCase().replace(/\s+/g, ''));
              const kRev = k.split('__').reverse().join('__');
              return !openDotaKeys.has(k) && !openDotaKeys.has(kRev);
            })
            .map(function (m, idx) {
              // 为 upcoming series 补全展示字段
              var scheduledTimeText = '', countdownText = '';
              if (m.startTime) {
                var d = new Date(m.startTime * 1000);
                var md = (d.getMonth() + 1) + '/' + d.getDate();
                var hh = ('0' + d.getHours()).slice(-2);
                var mm = ('0' + d.getMinutes()).slice(-2);
                scheduledTimeText = md + ' ' + hh + ':' + mm;
                var diffSec = m.startTime - fmtNowSec;
                if (diffSec <= 300) countdownText = '即将开始';
                else if (diffSec < 3600) countdownText = Math.floor(diffSec / 60) + '分钟后';
                else if (diffSec < 86400) countdownText = Math.floor(diffSec / 3600) + '小时后';
                else countdownText = Math.floor(diffSec / 86400) + '天后';
              }
              return {
                key: 'liq-' + idx + '-' + m.startTime,
                games: [],               // Liquipedia 赛程无小场数据
                scoreA: 0,
                scoreB: 0,
                boType: m.boType,
                boLabel: m.boType === 'BO1' ? '单局制' : (m.boType === 'BO2' ? '双局积分' : (m.boType === 'BO3' ? '三局两胜' : '五局三胜')),
                boTagCls: m.boType === 'BO2' ? 'bo-bo2' : (m.boType === 'BO5' ? 'bo-bo5' : ''),
                isDraw: false,
                isLive: m.phase === 'live',
                isRecent: m.phase === 'recent',
                isUpcoming: m.phase === 'upcoming',
                phase: m.phase,
                isMulti: m.boType !== 'BO1',
                radiantName: m.team1Name,
                direName: m.team2Name,
                radiantTeamId: 0,        // Liquipedia 赛程无 team_id
                direTeamId: 0,
                radiantWin: false,
                direWin: false,
                scoreACls: '',
                scoreBCls: '',
                teamACls: '',
                teamBCls: '',
                teamALogoCls: '',
                teamBLogoCls: '',
                radiantLogo: '',
                direLogo: '',
                radiantLogoSource: '',
                direLogoSource: '',
                scheduledTimeText: scheduledTimeText,
                countdownText: countdownText,
                lastTime: m.startTime
              };
            });
          console.log('[league-detail] Liquipedia 补充赛程:', liqSeries.length, '场 (去重后)',
            '其中 LIVE:', liqSeries.filter(s => s.phase === 'live').length,
            'UPCOMING:', liqSeries.filter(s => s.phase === 'upcoming').length,
            'RECENT:', liqSeries.filter(s => s.phase === 'recent').length);
          this.allSeries = this.allSeries.concat(liqSeries);
        }

        // ★ 三段式分段排序（2026-07-28 新增）
        // groupSeries 末尾已 sort by lastTime desc，但未区分 phase；
        // 这里按 phase 重新分段排序：
        //   LIVE：进行中（isLive），按 lastTime desc —— 最近开赛的在前
        //   UPCOMING：未开赛（isUpcoming），按 lastTime asc —— 最早开赛的在前
        //   RECENT：已结束（其他），按 lastTime desc —— 最近结束的在前
        // 合并顺序：live → upcoming → recent
        // 注意：groupSeries 返回的 series 已含 phase/isLive/isUpcoming 字段（步骤 1 新增）
        // ★ 2026-07-28 修复：统一用 s.phase 判定（而非 isLive/isUpcoming），避免字段语义冲突
        const liveList = [], upcomingList = [], recentList = [];
        this.allSeries.forEach(function (s) {
          if (s.phase === 'live') liveList.push(s);
          else if (s.phase === 'upcoming') upcomingList.push(s);
          else recentList.push(s);
        });
        liveList.sort(function (a, b) { return b.lastTime - a.lastTime; });
        upcomingList.sort(function (a, b) { return a.lastTime - b.lastTime; });
        recentList.sort(function (a, b) { return b.lastTime - a.lastTime; });
        this.allSeries = liveList.concat(upcomingList, recentList);
        console.log('[league-detail] 分段统计: LIVE=%d UPCOMING=%d RECENT=%d',
          liveList.length, upcomingList.length, recentList.length);

        const pageSize = this.data.pageSize;
        const slice = this.allSeries.slice(0, pageSize);
        const at = api.fetchedAtOf('leagueMatches', this.data.leagueId);
        // F1：赛事进行中判定 —— 存在「未分胜负 + 近 12h 开赛」的比赛即视为直播中
        // 注意：isLive 表示「当前有比赛正在打」，与「赛事窗口进行中」(ongoing) 是不同概念：
        //   - isLive：F1 直播聚合入口高亮，必须基于真实未结算比赛（curation 无法感知）。
        //   - ongoing：赛事处于官方赛期内，包含「DOTA2 比赛已结束但嘉年华仍在进行」场景。
        const nowSec = Math.floor(Date.now() / 1000);
        const isLive = (raw || []).some((m) =>
          (m.radiant_win == null) && m.start_time && (nowSec - m.start_time) > 0 && (nowSec - m.start_time) < 12 * 3600
        );
        // 统一赛事窗口（与列表页 leagues.js loadLeagueEntry 完全一致）：
        // 构建 mixed 对象同时包含真实比赛数据（earliest/latest/lastEnd）和 curation 权威赛期
        //（startDate/endDate），让 util.statusOf 走 isOngoing 全部三条判定路径：
        //   ① 真实 lastEnd 在缓冲期内 → 精确匹配
        //   ② curation 赛期窗口内 → 覆盖 DOTA2 比赛已结束但赛事仍在进行（如 EWC 嘉年华）
        //   ③ 未结算比赛兜底
        // 并应用 cur.status 显式覆盖（与列表页 leagues.js 第 362-364 行一致），
        // 防止「赛事仍在进行但 DOTA2 比赛已结束」被误判为「已结束」。
        // 2026-07-28 修复：此前详情页仅用真实比赛窗口，导致与列表页赛期/状态显示不一致。
        const mList = raw || [];
        let mStart = 0, mEnd = 0, mLatestStart = 0;
        mList.forEach((m) => {
          const st = m.start_time || 0;
          const en = st + (m.duration || 0);
          if (st && (!mStart || st < mStart)) mStart = st;       // 最早开赛
          if (st > mLatestStart) mLatestStart = st;               // 最晚开赛（供 isOngoing 路径③）
          if (en > mEnd) mEnd = en;                               // 最晚结束
        });
        // 数据校验：真实比赛窗口完整性（start>0 且 end>=start）
        const hasRealWindow = mStart > 0 && mEnd >= mStart;
        // 2026-07-27：传入 leagueId + game 上下文，启用 curation 精确 pin + 跨游戏隔离
        const cur = remoteCuration.curatedEventFor(this.data.name, { leagueId: Number(this.data.leagueId), game: 'dota2' });
        // 2026-07-28：统一使用 util.validateLeagueWindow 校验，与列表页 leagues.js 共用同一函数，
        // 确保两页对赛期/状态的数据源完全一致，防止同类不一致 BUG 复发。
        const mixed = util.validateLeagueWindow({
          earliest: mStart,
          latest: mLatestStart,
          lastEnd: mEnd,
          startDate: (cur && cur.start) || null,
          endDate: (cur && cur.end) || null
        });
        // 状态判定：statusOf(mixed) + curation 显式状态覆盖（与列表页完全一致）
        let status = util.statusOf(mixed);
        if (cur && cur.status === '已结束') status = 'ended';
        else if (cur && cur.status === '进行中') status = 'ongoing';
        const badge = statusBadgeOf(status);
        // 赛期显示优先级（与列表页 leagues.js loadLeagueEntry 完全一致）：
        //   ① curation 完整周期（mixed.startDate/endDate）—— 覆盖嘉年华全周期
        //   ② 真实比赛窗口（mStart/mEnd）—— 非策展赛事兜底
        // 数据校验：winStart/winEnd 必须都 > 0 才构建 eventWindow，避免半空数据导致渲染异常
        // 注意：mixed 已由 validateLeagueWindow 校验归一化，startDate/endDate 为 null 表示无有效 curation 日期
        const winStart = mixed.startDate || (hasRealWindow ? mStart : 0);
        const winEnd = mixed.endDate || (hasRealWindow ? mEnd : 0);
        let eventWindow = null;
        if (winStart > 0 && winEnd >= winStart) {
          eventWindow = {
            start: winStart,
            end: winEnd,
            range: util.formatDateRange(winStart, winEnd),                        // M/D，与列表页一致
            fullRange: util.formatTime(winStart) + ' ~ ' + util.formatTime(winEnd), // KPI 全日期
            status: status,
            statusText: badge.text,
            statusColor: badge.color
          };
        }
        this._matchWindow = hasRealWindow ? { start: mStart, end: mEnd } : null;
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
          eventWindow: eventWindow,
          // ★ 三段式分段计数（供 wxml 渲染分隔符与计数）
          liveCount: liveList.length,
          upcomingCount: upcomingList.length,
          recentCount: recentList.length,
          recentCollapsed: false   // 每次重新加载时重置折叠状态
        });
        this.refreshMetadataDerived();
        this.enrichTeamNames();
        this.enrichTeamLogos();
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

  // 异步批量补全 series 头部战队 logo
  // 设计要点：
  //   ① 全段去重：所有 series 的 radiantTeamId/direTeamId 汇总去重，跨 LIVE/UPCOMING/RECENT 段复用
  //   ② 并行查询：用 Promise.all 并发，每个内部 .catch 隔离，任一失败不影响其他
  //   ③ 跳过已有 logo：allSeries 内存缓存中已有 http logo 字段的队伍跳过，避免重复请求
  //   ④ 路径更新：用 series[i].radiantLogo 形式批量 setData，不重建整个 series 数组
  //   ⑤ 失败静默：logo 非关键信息，加载失败时 wxml 走 fallback 显示首字母圆
  //   ⑥ 同步更新 participantsList：参赛队伍 Tab 的 logo 也一并补全
  enrichTeamLogos() {
    if (!this.allSeries || !this.allSeries.length) return;

    // ★ inflight 去重守卫（2026-07-28 步骤 5 新增）
    // 用户快速滚动触发多次 appendPage → enrichTeamLogos 时，避免并发重复请求同一批 team_id。
    // 复用 _enrichLogosInflight Promise，并发调用方都 await 同一个 Promise，结果共享。
    if (this._enrichLogosInflight) return this._enrichLogosInflight;

    this._enrichLogosInflight = this._doEnrichTeamLogos().then((done) => {
      this._enrichLogosInflight = null;  // 清理 inflight 标记
      return done;
    }).catch(() => {
      this._enrichLogosInflight = null;
    });
    return this._enrichLogosInflight;
  },

  // 实际执行 logo 批量补全（由 enrichTeamLogos 调用，含 inflight 去重）
  _doEnrichTeamLogos() {
    // 1) 收集所有 team_id（去重）
    //    同时收集 participantsList 中的占位 id（与 enrichTeamNames 一致）
    const teamIds = {};
    this.allSeries.forEach((s) => {
      const aids = [s.radiantTeamId, s.direTeamId];
      aids.forEach((tid) => {
        if (tid != null && tid > 0 && !teamIds[tid]) {
          // allSeries 中已有 logo 的直接跳过，避免重复请求
          if (s.radiantLogo && /^https?:\/\//i.test(s.radiantLogo) && tid === s.radiantTeamId) {
            teamIds[tid] = { id: tid, name: s.radiantName || '', skip: true };
          } else if (s.direLogo && /^https?:\/\//i.test(s.direLogo) && tid === s.direTeamId) {
            teamIds[tid] = { id: tid, name: s.direName || '', skip: true };
          } else {
            // ★ 2026-07-28 修复 name 归属 BUG：
            //   原 name: s.radiantName || s.direName 会把 dire 队名误赋给 radiant team_id
            //   修复：按 tid 归属取对应队名
            const teamName = (tid === s.radiantTeamId) ? (s.radiantName || '')
                          : (tid === s.direTeamId) ? (s.direName || '')
                          : '';
            teamIds[tid] = { id: tid, name: teamName };
          }
        }
      });
    });
    (this.data.participantsList || []).forEach((t) => {
      if (t && t.id > 0 && !teamIds[t.id]) {
        teamIds[t.id] = { id: t.id, name: t.name || '' };
      }
    });

    // 过滤出需要查询的 team_id（skip=true 的跳过）
    const needQueryIds = Object.keys(teamIds).filter((tid) => !teamIds[tid].skip);
    if (!needQueryIds.length) return Promise.resolve(false);

    // 2) 并行批量查询（每个 .catch 隔离，任一失败不影响其他）
    //    ★ 2026-07-28 修复 LOGO 不显示 BUG：
    //    原 BUG：直接传 { id, name } 给 enrichTeamLogo，但 enrichTeamLogo 依赖 team.logo 字段
    //           OpenDota /leagues/{id}/matches 不返回 team.logo_url，导致 existing='' → 走 STRATZ
    //           STRATZ 限流/失败时返回 null，logo 永远为空
    //    修复：先调 api.getTeam(id) 获取 logo_url，再传给 enrichTeamLogo
    //         enrichTeamLogo 内部 existing 命中 → 直接返回，不走 STRATZ
    //    参考：team-detail.js L250 也是先获取 team.logo 再传给 enrichTeamLogo
    //    缓存：api.getTeam 内部有 15min 新鲜 + team TTL 缓存，跨赛事复用
    const tasks = needQueryIds.map((tid) => {
      const team = teamIds[tid];
      // 先调 api.getTeam 拿 logo_url（OpenDota /teams/{id} 端点返回 logo_url 字段）
      return api.getTeam(team.id)
        .then((teamInfo) => {
          const logoUrl = (teamInfo && teamInfo.logo_url) || '';
          // 再传给 enrichTeamLogo：existing 命中 → 直接返回；未命中 → 走 STRATZ 兜底
          return sources.enrichTeamLogo({ id: team.id, name: team.name, logo: logoUrl });
        })
        .then((r) => ({ id: team.id, logo: r && r.logo, source: r && r.source }))
        .catch(() => ({ id: team.id, logo: null, source: '' }));
    });

    return Promise.all(tasks).then((results) => {
      // 3) 构建 team_id → logo 映射（仅保留有效 http URL）
      const logoMap = {};
      results.forEach((r) => {
        if (r.logo && /^https?:\/\//i.test(r.logo)) {
          logoMap[r.id] = { logo: r.logo, source: r.source };
        }
      });
      if (!Object.keys(logoMap).length) return false;

      // 4) 路径更新：仅更新当前可见的 series 头部 logo
      //    （不可见 series 不更新，避免无谓 setData；allSeries 内存缓存同步更新，
      //     loadMore 加载新页时 enrichTeamLogos 会从内存读取并路径更新）
      const patch = {};
      const visible = this.data.series;
      visible.forEach((s, si) => {
        if (s.radiantTeamId && logoMap[s.radiantTeamId] &&
            (!s.radiantLogo || !/^https?:\/\//i.test(s.radiantLogo))) {
          patch['series[' + si + '].radiantLogo'] = logoMap[s.radiantTeamId].logo;
          patch['series[' + si + '].radiantLogoSource'] = logoMap[s.radiantTeamId].source;
        }
        if (s.direTeamId && logoMap[s.direTeamId] &&
            (!s.direLogo || !/^https?:\/\//i.test(s.direLogo))) {
          patch['series[' + si + '].direLogo'] = logoMap[s.direTeamId].logo;
          patch['series[' + si + '].direLogoSource'] = logoMap[s.direTeamId].source;
        }
      });

      // 5) 同步更新 allSeries 内存缓存（loadMore 加载新页时可直接用）
      this.allSeries.forEach((s) => {
        if (s.radiantTeamId && logoMap[s.radiantTeamId] &&
            (!s.radiantLogo || !/^https?:\/\//i.test(s.radiantLogo))) {
          s.radiantLogo = logoMap[s.radiantTeamId].logo;
          s.radiantLogoSource = logoMap[s.radiantTeamId].source;
        }
        if (s.direTeamId && logoMap[s.direTeamId] &&
            (!s.direLogo || !/^https?:\/\//i.test(s.direLogo))) {
          s.direLogo = logoMap[s.direTeamId].logo;
          s.direLogoSource = logoMap[s.direTeamId].source;
        }
      });

      // 6) 参赛队伍 Tab 的 participantsList logo 同步更新
      const curParticipants = this.data.participantsList || [];
      if (curParticipants.length) {
        const patched = curParticipants.map((t) => {
          if (t && t.id && logoMap[t.id] && (!t.logo || !/^https?:\/\//i.test(t.logo))) {
            return Object.assign({}, t, { logo: logoMap[t.id].logo });
          }
          return t;
        });
        const changed = patched.some((t, i) => t.logo !== curParticipants[i].logo);
        if (changed) patch.participantsList = patched;
      }

      if (Object.keys(patch).length) this.setData(patch);
      return true;
    });
  },

  // logo <image> 加载失败时回退到首字母圆，避免破图
  // 通过清空对应 series 的 logo URL，触发 wxml 走 wx:else 分支显示首字母
  onLogoError(e) {
    const { si, side } = e.currentTarget.dataset;
    if (si == null || !side) return;
    const key = side === 'radiant' ? 'radiantLogo' : 'direLogo';
    // 清空 logo URL，触发 wxml 走 wx:else 分支显示首字母
    this.setData({
      ['series[' + si + '].' + key]: ''
    });
  },

  // 参赛队伍 Tab 的 logo <image> 加载失败时回退到首字母圆
  // 路径更新 participantsList[idx].logo = ''，触发 wxml 走 wx:else 分支
  onParticipantLogoError(e) {
    const { idx } = e.currentTarget.dataset;
    if (idx == null) return;
    this.setData({
      ['participantsList[' + idx + '].logo']: ''
    });
  },

  fmt(m, anchor) {
    // 2026-07-28 修复小圆点颜色 BUG：新增 aWin/bWin 字段，表示该场 A 队/B 队是否赢。
    // A 队 = 系列赛首场的 radiant 方（anchor.teamAId）；B 队 = 首场的 dire 方。
    // 必须按 team_id 归属，不能直接用 radiant_win：
    //   ① BO3/BO5 换边：第 2/3 场 radiant 可能是 B 队，radiant_win=true 反而代表 B 队赢；
    //   ② 未结束：radiant_win=null，不应显示任何颜色（aWin/bWin 均为 false）；
    //   ③ 数据异常：team_id 缺失时回退到 radiant_win，与 groupSeries 的回退逻辑一致。
    const aId = anchor && anchor.teamAId > 0 ? anchor.teamAId : 0;
    const bId = anchor && anchor.teamBId > 0 ? anchor.teamBId : 0;
    let aWin = false, bWin = false;
    if (m.radiant_win === true || m.radiant_win === false) {
      const winnerId = m.radiant_win ? m.radiant_team_id : m.dire_team_id;
      if (aId > 0 && bId > 0 && winnerId > 0) {
        // 有有效锚点：按 team_id 归属
        if (winnerId === aId) aWin = true;
        else if (winnerId === bId) bWin = true;
      } else {
        // 无有效锚点：回退到按边归属（A=radiant, B=dire）
        if (m.radiant_win) aWin = true; else bWin = true;
      }
    }
    // 未结束（radiant_win=null）→ aWin/bWin 均为 false，WXML 显示灰色（未着色）
    return {
      match_id: m.match_id,
      // 队名兜底用 '天辉'/'夜魇'，与 groupSeries 保持一致，
      // 避免 enrichTeamNames 中 !m.radiantName 对空字符串和 '天辉' 行为不一致。
      radiantName: m.radiant_team_name || '天辉',
      direName: m.dire_team_name || '夜魇',
      radiantTeamId: m.radiant_team_id,
      direTeamId: m.dire_team_id,
      // 比分兜底 0，防止 null/undefined 在 wxml 算术运算中产生 NaN
      radiantScore: Number(m.radiant_score) || 0,
      direScore: Number(m.dire_score) || 0,
      radiantWin: m.radiant_win,
      // 小圆点颜色用 aWin/bWin（按 A/B 队归属），不用 radiantWin（按天辉/夜魇边）
      aWin: aWin,
      bWin: bWin,
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

    // ===== 参赛队数一致性策略（2026-07-28 重构，修复 EWC 2026 显示 16 实际 24 的 BUG） =====
    // metadata.participants 来源：curation 硬编码 / Liquipedia 人工策展。
    // 实际参赛队数：从 OpenDota /leagues/{id}/matches 的 team_id 去重得到。
    // 两者不一致时的优先级（按可信度从高到低）：
    //   ① 实际 > meta  → curation 过时，以实际为准（覆盖 meta.participants，并告警）
    //   ② meta > 实际  → 赛事进行中尚有未登场队伍（常见于 BO3 小组赛未全部开打），
    //                    补「待定队伍 N」占位至 meta 一致（保留 2026-07-27 的 Roster 完成逻辑）
    //   ③ meta == 实际 → 一致，无需处理
    //   ④ 无比赛数据   → 仅用 meta 生成纯占位列表（保留旧行为）
    // 设计原则：硬编码 curation 永远不可信过实际比赛数据；占位仅用于"已知未登场"场景。
    // 2026-07-28：meta.participants 可能是数字（curation）或数组（Liquipedia parseParticipants）。
    //   - 数字：直接用作品数判定
    //   - 数组：用长度作 meta 参赛队数，数组本身保留供分支④兜底使用
    //   Liquipedia 数组优先于 curation 数字（mergeMetadataWithFallback 中 Object.assign 已覆盖）。
    //   2026-07-28 增强：curation 的 participants 也可为数组（含 name/region/group），
    //   当 Liquipedia 被 CAPTCHA 拦截时，curation 数组作为同等数据源参与重建。
    const liqParticipantsArr = Array.isArray(meta.participants) ? meta.participants : null;
    const metaParticipants = liqParticipantsArr ? liqParticipantsArr.length : (Number(meta.participants) || 0);
    const actualCount = participantsList.length;

    if (actualCount > 0 && actualCount > metaParticipants && metaParticipants > 0) {
      // ① 实际 > meta（且 meta > 0）：curation/Liquipedia 过时，以实际为准
      // 2026-07-28：增加 metaParticipants > 0 守卫，避免 meta=0（Liquipedia 尚未返回）
      //   的加载中间态误报"curation 过时"。meta=0 时仅静默更新 meta.participants，
      //   不输出警告，等 finalize 后 Liquipedia 返回再做一致性校验。
      meta.participants = actualCount;
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[league-detail] 参赛队数实际 > metadata：curation 可能过时',
          'actual=' + actualCount, 'meta=' + metaParticipants,
          '— 已以实际数据为准更新 KPI');
      }
    } else if (actualCount > 0 && metaParticipants === 0) {
      // ①-bis meta=0：Liquipedia/curation 尚未加载，静默用实际数填充，不警告
      meta.participants = actualCount;
    } else if (metaParticipants > 0 && metaParticipants > actualCount) {
      // ② meta > 实际：赛事进行中尚有未登场队伍
      // 2026-07-28 修复 EPL Masters I BUG：Liquipedia 已公布 16 支队伍但比赛数据只有 7 支时，
      // 此前用「待定队伍 N」占位，丢失真实队名（如 Team Jenz / Level UP）。
      // 修复：Liquipedia 提供完整队伍列表时，以该列表为基础重建 participantsList，
      //   并通过队名匹配关联实际比赛数据中的 team_id（保留已参赛队伍的真实 id 用于跳转/统计）。
      //   未参赛队伍用负数占位 id，未公布队伍（TBD）显示「待公布」。
      if (liqParticipantsArr && liqParticipantsArr.length) {
        // 1) 构建实际队名(lower) -> team_id 映射（仅真实队名，排除 "Team {id}" 占位）
        const nameToId = {};
        const normList = [];
        participantsList.forEach((t) => {
          if (!t || !t.name || t.id == null || t.id < 0) return;
          if (/^Team \d+$/.test(t.name)) return;
          nameToId[t.name.toLowerCase()] = t.id;
          normList.push({ name: t.name, id: t.id });
        });
        // 2) 模糊匹配规范化：去 esports/gaming/team 等后缀 + 非字母数字字符
        const normalize = function (s) {
          return (s || '').toLowerCase()
            .replace(/\s*(esports|eports?|gaming|team|dota)\s*/gi, '')
            .replace(/[^a-z0-9]/g, '');
        };
        const normIndexed = normList.map((it) => ({ norm: normalize(it.name), id: it.id, name: it.name }));
        // 3) 以 Liquipedia 列表为基础重建，关联 team_id
        participantsList = liqParticipantsArr.map((t, i) => {
          const liqName = (t && t.name) || '';
          const isTBD = !liqName || liqName === 'TBD';
          let matchedId = null;
          if (!isTBD) {
            // 精确匹配（忽略大小写）
            matchedId = nameToId[liqName.toLowerCase()];
            // 模糊匹配（去后缀 + 包含关系）
            if (matchedId == null) {
              const liqNorm = normalize(liqName);
              if (liqNorm) {
                for (let j = 0; j < normIndexed.length; j++) {
                  const it = normIndexed[j];
                  if (!it.norm) continue;
                  if (it.norm === liqNorm ||
                      (it.norm.length >= 3 && (it.norm.indexOf(liqNorm) >= 0 || liqNorm.indexOf(it.norm) >= 0))) {
                    matchedId = it.id;
                    break;
                  }
                }
              }
            }
          }
          return {
            id: matchedId != null ? matchedId : -1 - i,
            name: isTBD ? '待公布' : liqName,
            status: (t && t.status) || 'TBD',
            liquipediaSlug: (t && t.liquipediaSlug) || null,
            // 2026-07-28 透传扩展字段：curation/Liquipedia 数据源可能提供 region/group 等信息，
            // 统一拷贝到 participantsList 供 WXML 渲染赛区标签与分组徽标。
            region: (t && t.region) || null,
            group: (t && t.group) || null
          };
        });
      } else {
        // 无 Liquipedia 列表（meta.participants 是数字，来自 curation 兜底）：
        // 保留原「待定队伍 N」占位逻辑，但不再输出 warn（这是预期场景）。
        // 2026-07-28：Liquipedia API 失败/限流时，mergeMetadataWithFallback 会用 curation
        //   的数字 participants 兜底（如 EPL Masters I = 16），此时分支②走此 else 分支，
        //   补占位是预期行为，不是 BUG。改为 console.log 避免海量 warn 污染控制台。
        const need = metaParticipants - actualCount;
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
          // 仅 devtools 下输出 info 级别日志，生产环境静默
          if (typeof console !== 'undefined' && console.info) {
            console.info('[league-detail] 参赛队伍占位补齐（Liquipedia 未返回列表，用 curation 数字兜底）',
              'actual=' + actualCount, 'meta=' + metaParticipants,
              '— 已补 ' + fillers.length + ' 个待定队伍占位');
          }
        }
      }
    } else if (metaParticipants > 0 && metaParticipants !== actualCount && actualCount === 0) {
      // ④ 无比赛数据：赛事未开赛场景
      // 2026-07-28 新增 Liquipedia 兜底：若 meta.participants 是数组（来自 Liquipedia
      //   getLeagueMetadata 的 parseParticipants 解析），优先使用已公布的参赛队伍，
      //   而非纯「待定队伍 N」占位。与 Liquipedia 公示保持一致。
      //   - 已公布的队伍（name !== 'TBD'）显示真实队名，id 用负数占位（无 OpenDota team_id）
      //   - 未公布的队伍（name === 'TBD'）仍显示「待公布」，区分已公布与未公布
      //   - 若 Liquipedia 无 participants 数据，回退到原纯占位逻辑
      const liqParticipants = Array.isArray(meta.participants) ? meta.participants : null;
      if (liqParticipants && liqParticipants.length) {
        participantsList = liqParticipants.map((t, i) => ({
          id: -1 - i,
          name: (t.name && t.name !== 'TBD') ? t.name : '待公布',
          status: t.status || 'TBD',
          liquipediaSlug: t.liquipediaSlug || null
        }));
        // 更新 meta.participants 为实际解析到的队伍数
        meta.participants = participantsList.length;
      } else {
        participantsList = Array.from({ length: metaParticipants }, (_, i) => ({ id: -1 - i, name: '待定队伍 ' + (i + 1) }));
      }
    }

    // 2) 用统一赛事窗口补齐 metadata（与列表页 leagues.js loadLeagueEntry 完全一致）
    // 优先级（与列表页完全一致）：
    //   - status：eventWindow.statusText（已用 mixed + cur.status 覆盖计算）
    //   - 赛期：eventWindow.start/end（已优先 curation 宽窗口，回退真实比赛窗口）
    // 数据校验：eventWindow 存在时直接覆盖 meta 的 status/startDate/endDate，
    //   保证 KPI Strip 与头部徽标完全一致；eventWindow 为 null（无 curation 也无真实比赛）
    //   时保留 mergeMetadataWithFallback 注入的 Liquipedia/curation 兜底值，避免 KPI 空白。
    // 2026-07-28 修复：此前详情页仅用真实比赛窗口覆盖 meta，导致：
    //   ① KPI 赛期（真实窗口 7/15-7/25）与列表页赛期（curation 宽窗口 7/6-8/23）不一致；
    //   ② 状态评定缺少 curation 路径②，DOTA2 比赛已结束但赛事仍在进行时误判为「已结束」。
    const ew = this.data.eventWindow;
    if (ew) {
      meta.status = ew.statusText;
      meta.startDate = util.formatTime(ew.start);
      meta.endDate = util.formatTime(ew.end);
    }
    // 3) 参赛队数兜底：若 meta.participants 仍为空（curation/Liquipedia 均无数据），
    //    用实际比赛数据推导的参赛队数填入。
    //    注意：实际 > meta 的覆盖已在上方「参赛队数一致性策略①」处理，
    //    这里仅处理 meta 为空的边缘场景，避免重复赋值。
    if ((meta.participants == null || meta.participants === '') && participantsList.length) {
      meta.participants = participantsList.length;
    }
    // 2026-07-28：归一化 participants 为数字（KPI Strip 显示用）。
    //   meta.participants 可能是数组（Liquipedia parseParticipants）或数字（curation/推导）。
    //   WXML 直接显示 metadata.participants，若为数组会渲染为 [object Object]。
    //   保留 liqParticipantsArr 供分支④兜底使用，最终 setData 前统一转为数字。
    if (Array.isArray(meta.participants)) {
      meta.participants = meta.participants.length;
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
    this.setData({
      series: slice,
      page: page,
      hasMore: this.allSeries.length > slice.length
    }, () => {
      // ★ 新页加载后补全可见 series 的 logo（allSeries 内存已有则路径更新直接命中）
      this.enrichTeamLogos();
    });
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
    // 2026-07-28：id < 0 是待公布/占位队伍（无 OpenDota team_id），不跳转
    if (!id || id < 0) return;
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

  // ===== 三段式：已结束段折叠/展开（2026-07-28 新增） =====
  // 点击 RECENT 分隔符切换折叠态。折叠时隐藏 RECENT 段所有 series-card，
  // 让用户聚焦 LIVE/UPCOMING。展开时恢复显示。
  // 注意：仅切换 recentCollapsed 布尔，不重建 series 数组（wxml 用 wx:if 控制可见性）
  toggleRecentCollapse() {
    this.setData({ recentCollapsed: !this.data.recentCollapsed });
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
