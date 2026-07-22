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

Page({
  data: {
    leagueId: '',
    name: '',
    matches: [],
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
    followed: false
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

    // 分级增强：多源交叉验证（community / curation / OpenDota / STRATZ 计票）
    sources.getLeagueTier({ name: name }).then((t) => {
      if (t && t.grade) {
        this.setData({
          liqTier: {
            label: t.label,
            grade: t.grade,
            cls: 'tag-' + t.grade.toLowerCase(),
            confidence: t.confidence,
            agreement: t.agreement,
            sources: t.sources,
            sourceLabel: t.sourceLabel || ''
          }
        });
        this.refreshQuality();
      }
    });

    // 赛事名增强：多源归一投票，得出规范名 + 可信度
    sources.getLeagueName({ name: name, leagueid: leagueId }).then((n) => {
      if (n && n.value) {
        this.setData({
          nameInfo: {
            value: n.value,
            confidence: n.confidence,
            agreement: n.agreement,
            sources: n.sources,
            sourceLabel: n.sourceLabel || '',
            differs: n.value !== name && n.confidence !== 'low'
          }
        });
        this.refreshQuality();
      }
    });
  },

  // 汇总分级名与赛事名的可信度，给出整体徽标
  refreshQuality() {
    const t = this.data.liqTier;
    const n = this.data.nameInfo;
    const level = worstConfidence(t && t.confidence, n && n.confidence);
    this.setData({
      quality: {
        level: level,
        text: CONF_TEXT[level],
        sources: (t && t.agreement) || 0
      }
    });
  },

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
        this.allMatches = (list || []).map((m) => this.fmt(m));
        this.slicePage(true);
        const at = api.fetchedAtOf('leagueMatches', this.data.leagueId);
        this.setData({ loading: false, updatedAt: at, updatedLabel: util.formatAgo(at) });
        // 队名补全：OpenDota /leagues/{id}/matches 的 radiant_team_name / dire_team_name
        // 普遍为 null，用 team_id 批量反查 teams 表补全，否则联赛列表队名全缺失。
        this.enrichTeamNames();
      })
      .catch(() => {
        this.setData({ loading: false, error: '加载失败，请检查网络或域名配置' });
      });
  },

  // 队名补全：收集队名为空的 team_id，一次 /explorer SQL 批量查 teams.name 回填。
  // 异步执行不阻塞首屏；补全后刷新当前页（已加载的 slice）。
  enrichTeamNames() {
    if (!this.allMatches || !this.allMatches.length) return;
    const need = {};
    this.allMatches.forEach((m) => {
      if (m.radiantTeamId != null && !m.radiantName) need[m.radiantTeamId] = true;
      if (m.direTeamId != null && !m.direName) need[m.direTeamId] = true;
    });
    const ids = Object.keys(need).filter((x) => x !== 'null' && x !== '');
    if (!ids.length) return;
    api.getTeamNames(ids)
      .then((nameMap) => {
        let changed = false;
        this.allMatches.forEach((m) => {
          if (!m.radiantName && m.radiantTeamId != null && nameMap[m.radiantTeamId]) {
            m.radiantName = nameMap[m.radiantTeamId]; changed = true;
          }
          if (!m.direName && m.direTeamId != null && nameMap[m.direTeamId]) {
            m.direName = nameMap[m.direTeamId]; changed = true;
          }
        });
        if (changed) this.slicePage(false);
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
      time: util.formatTime(m.start_time)
    };
  },

  slicePage(reset) {
    const pageSize = this.data.pageSize;
    const page = reset ? 0 : this.data.page;
    const slice = this.allMatches.slice(0, (page + 1) * pageSize);
    this.setData({ matches: slice, page: page, hasMore: this.allMatches.length > slice.length });
  },

  appendPage() {
    const page = this.data.page + 1;
    const pageSize = this.data.pageSize;
    const slice = this.allMatches.slice(0, (page + 1) * pageSize);
    this.setData({ matches: slice, page: page, hasMore: this.allMatches.length > slice.length });
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
  }
});
