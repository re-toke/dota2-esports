const api = require('../../utils/api.js');
const util = require('../../utils/util.js');
const sources = require('../../utils/sources.js');
const follow = require('../../utils/follow.js');
const subscribe = require('../../utils/subscribe.js');
const config = require('../../utils/config.js');

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

Page({
  data: {
    leagueId: '',
    name: '',
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
    metadata: null,    // 赛事元数据（Liquipedia + Steam 聚合：奖金池/地点/赛制/主办方）
    sourcesText: '',   // 元数据来源中文名拼接（如 'Liquipedia / Steam'）
    sourceBadges: [],  // 数据来源徽标列表（统一展示）
    // ===== 三 Tab 状态（C 风格 Tournament Center） =====
    tab: 'matches',          // matches | players | standings
    expandedGame: '',        // 当前展开的小场 "seriesIdx-gameIdx"（A 风格就地展开英雄阵容）
    // 选手排行
    playerStats: [],
    playersLoading: false,
    playersLoaded: false,    // 是否已加载过（避免反复触发）
    // 赛事排名
    standings: [],
    standingsLoading: false,
    standingsLoaded: false
  },

  onLoad(options) {
    const name = decodeURIComponent(options.name || '');
    const leagueId = options.leagueId;
    this.setData({
      leagueId: leagueId,
      name: name,
      followed: follow.isFollowed('leagues', leagueId)
    });
    wx.setNavigationBarTitle({ title: name || '赛事详情' });
    this.load();

    // 分级 / 名称 / 元数据：3 个异步源用计数器统一收口，避免级联 setData。
    // 每个源返回后暂存到 this._pending，3 个全部完成后（或超时 8s）统一 refreshQuality + refreshSourceBadges 一次。
    this._pending = { tier: null, name: null, meta: null };
    this._pendingCount = 0;
    this._pendingTotal = 3;
    const finalize = () => {
      this._pendingCount++;
      if (this._pendingCount < this._pendingTotal) return;
      // 所有源返回，统一刷新一次
      const p = this._pending || {};
      const patch = {};
      if (p.tier) patch.liqTier = p.tier;
      if (p.name) patch.nameInfo = p.name;
      if (p.meta) {
        patch.metadata = p.meta;
        patch.sourcesText = (p.meta.sources || []).map((s) => sources.SOURCE_LABEL[s] || s).join(' / ');
      }
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

    sources.getLeagueName({ name: name, leagueid: leagueId }).then((n) => {
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
        if (meta) this._pending.meta = meta;
        finalize();
      })
      .catch(() => { finalize(); });
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
    this.setData({ loading: true, error: '' });
    return api.getLeagueMatches(this.data.leagueId)
      .then((list) => {
        const raw = list || [];
        this.allMatches = raw;  // 保留原始（供 loadPlayerStats 聚合用）
        // 系列赛聚合：按 series_id 归组 BO3/BO5，同一系列多场聚到一张卡
        this.allSeries = sources.groupSeries(raw).map((s) => {
          s.games = s.games.map((m) => this.fmt(m));
          return s;
        });
        const pageSize = this.data.pageSize;
        const slice = this.allSeries.slice(0, pageSize);
        const at = api.fetchedAtOf('leagueMatches', this.data.leagueId);
        // 合并为单次 setData
        this.setData({
          totalSeries: this.allSeries.length,
          series: slice,
          page: 0,
          hasMore: this.allSeries.length > slice.length,
          loading: false,
          updatedAt: at,
          updatedLabel: util.formatAgo(at)
        });
        this.enrichTeamNames();
      })
      .catch(() => {
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
        if (Object.keys(patch).length) this.setData(patch);
      })
      .catch(() => {});
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
    wx.navigateTo({ url: '/pages/team-detail/team-detail?teamId=' + id });
  },

  // ===== 三 Tab 切换（C 风格） =====
  switchTab(e) {
    const key = e.currentTarget.dataset.key;
    if (key === this.data.tab) return;
    this.setData({ tab: key, expandedGame: '' });
    // 懒加载选手排行 / 赛事排名
    if (key === 'players' && !this.data.playersLoaded && this.allMatches && this.allMatches.length) {
      this.loadPlayerStats();
    }
    if (key === 'standings' && !this.data.standingsLoaded) {
      this.loadStandings();
    }
  },

  // Tab 2: 选手排行聚合（最多取前 30 场已结束比赛，避免请求过多）
  loadPlayerStats() {
    const ids = (this.allMatches || [])
      .filter((m) => m.match_id)
      .slice(0, 30)
      .map((m) => m.match_id);
    if (!ids.length) {
      this.setData({ playerStats: [], playersLoaded: true });
      return;
    }
    this.setData({ playersLoading: true });
    sources.getPlayerStats(ids).then((list) => {
      // Top 20 + 至少 1 场
      const top = (list || []).filter((p) => p.games >= 1).slice(0, 20);
      this.setData({ playerStats: top, playersLoading: false, playersLoaded: true });
    }).catch(() => {
      this.setData({ playersLoading: false, playersLoaded: true });
    });
  },

  // Tab 3: 赛事排名（按已结束比赛聚合队伍胜负）
  loadStandings() {
    this.setData({ standingsLoading: true });
    sources.getLeagueStandings(this.data.leagueId).then((list) => {
      this.setData({ standings: list || [], standingsLoading: false, standingsLoaded: true });
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

    api.getMatch(m.match_id).then((detail) => {
      if (!detail || !detail.players) {
        this.setData({ [path + '.loadingDetail']: false, [path + '.detail']: null });
        return;
      }
      const heroMap = (getApp().globalData && getApp().globalData.heroMap) || {};
      const radiantHeroes = [];
      const direHeroes = [];
      let mvp = null;
      let mvpScore = -1;
      detail.players.forEach((p) => {
        const isRadiant = (p.isRadiant != null) ? p.isRadiant : (p.player_slot < 128);
        const kda = p.deaths > 0 ? (p.kills + p.assists) / p.deaths : (p.kills + p.assists);
        const heroName = heroMap[p.hero_id] || ('H' + p.hero_id);
        const item = {
          hero_id: p.hero_id,
          name: heroName,
          short: (heroName || '?').slice(0, 4),
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
    wx.navigateTo({ url: '/pages/match-detail/match-detail?matchId=' + id });
  },

  // 跳转选手详情
  openPlayer(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: '/pages/player-detail/player-detail?accountId=' + id });
  }
});
