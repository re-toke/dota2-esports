const api = require('../../utils/api.js');
const util = require('../../utils/util.js');
const follow = require('../../utils/follow.js');
const subscribe = require('../../utils/subscribe.js');
const config = require('../../utils/config.js');
const sources = require('../../utils/sources.js');

const CONF_TEXT = { low: '待核实', medium: '较可信', high: '可信' };

// 来源 key -> 中文标签（用于数据溯源徽标）
const SOURCE_BADGES = {
  opendota: 'OpenDota',
  stratz: 'STRATZ',
  steam: 'Steam',
  liquipedia: 'Liquipedia',
  curation: '本地策展',
  community: '社区规则'
};

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
    teamId: '',
    team: null,
    current: [],
    history: [],
    tab: 'current',
    matches: [],
    totalMatches: 0,
    matchPage: 0,
    matchHasMore: false,
    matchLoading: false,
    loading: true,
    error: '',
    followed: false,
    memberQuality: null,   // 成员交叉验证结果：{ verifiedCount, total, confidence, sources }
    logoSource: '',        // 战队 logo 来源标注
    sourceBadges: [],      // 数据来源徽标列表（统一展示）
    updatedAt: 0,
    updatedLabel: ''
  },

  onLoad(options) {
    const teamId = options.teamId;
    this.setData({
      teamId: teamId,
      followed: follow.isFollowed('teams', teamId)
    });
    this.load();
    this.loadMatches();
  },

  onPullDownRefresh() {
    this.retry(() => wx.stopPullDownRefresh());
  },

  retry(cb) {
    this.load().then(() => {
      this.loadMatches().then(() => { if (cb) cb(); });
    });
  },

  onReachBottom() {
    if (this.data.matchHasMore && !this.data.matchLoading) this.appendMatches();
  },

  // 合并所有参与源的徽标
  refreshSourceBadges() {
    const arr = [];
    if (this.data.logoSource) arr.push(this.data.logoSource);
    if (this.data.memberQuality && this.data.memberQuality.sources) {
      this.data.memberQuality.sources.forEach((s) => arr.push(s));
    }
    arr.push('opendota'); // OpenDota 是基础数据源（必出）
    this.setData({ sourceBadges: buildSourceBadges(arr) });
  },

  load() {
    this.setData({ loading: true, error: '' });
    return Promise.all([
      api.getTeam(this.data.teamId),
      api.getTeamPlayers(this.data.teamId)
    ])
      .then(([team, players]) => {
        const t = team || {};
        const teamInfo = {
          name: t.name || '未知战队',
          tag: t.tag || '',
          logo: t.logo_url || '',
          rating: t.rating || 0,
          wins: t.wins || 0,
          losses: t.losses || 0,
          winRate: util.winRate(t.wins, (t.wins || 0) + (t.losses || 0)),
          country: t.country_code || '',
          created: t.last_match_time ? util.formatTime(t.last_match_time) : ''
        };

        const list = players || [];
        const current = [];
        const history = [];
        list.forEach((p) => {
          const item = this.fmtPlayer(p);
          if (util.isCurrentMember(p)) current.push(item);
          else history.push(item);
        });

        let cur = current;
        let his = history;
        if (current.length === 0 && list.length > 0) {
          cur = list.map((p) => this.fmtPlayer(p));
          his = [];
        }

        // 合并首屏 setData（原来 2 次 → 1 次）
        const at = api.fetchedAtOf('team', this.data.teamId) || api.fetchedAtOf('teamPlayers', this.data.teamId);
        this.setData({
          team: teamInfo,
          current: cur,
          history: his,
          loading: false,
          updatedAt: at,
          updatedLabel: util.formatAgo(at)
        });

        // 异步增强：4 个源用计数器统一收口，避免各自独立 setData。
        // crossMembers 修改 current/history + memberQuality；enrichInfo/enrichLogo 修改 team；
        // enrichPlayers 修改 current[i].avatar。收口后统一一次 setData。
        this._enhancePending = { cross: null, info: null, logo: null, players: null };
        this._enhanceCount = 0;
        this._enhanceTotal = 4;
        this._curRef = cur;   // 保留引用供 enrichPlayers 路径更新
        this._hisRef = his;
        const finalizeEnhance = () => {
          this._enhanceCount++;
          if (this._enhanceCount < this._enhanceTotal) return;
          // 所有增强完成，统一刷新 sourceBadges + updatedAt
          const p = this._enhancePending || {};
          const arr = [];
          if (p.logo && p.logo.source) arr.push(p.logo.source);
          if (p.cross && p.cross.sources) p.cross.sources.forEach((s) => arr.push(s));
          arr.push('opendota');
          if (p.info && p.info.source) arr.push(p.info.source);
          this.setData({ sourceBadges: buildSourceBadges(arr) });
        };
        this._enhanceTimer = setTimeout(finalizeEnhance, 8000);

        // 1) 成员交叉验证
        sources.crossTeamMembers(this.data.teamId)
          .then((res) => {
            if (!res) { finalizeEnhance(); return; }
            this._enhancePending.cross = res;
            const byId = {};
            (res.members || []).forEach((m) => { byId[m.account_id] = m; });
            const patch = {};
            [this._curRef, this._hisRef].forEach((arr) => arr.forEach((p, i) => {
              const c = byId[p.account_id];
              if (c) {
                p.verified = c.verified;
                p.crossSources = c.crossSources;
                if (c.name && c.name.length > (p.name || '').length) p.name = c.name;
              }
            }));
            // 路径更新 current 的 verified/name 字段
            this._curRef.forEach((p, i) => {
              if (byId[p.account_id]) {
                patch['current[' + i + '].verified'] = p.verified;
                patch['current[' + i + '].name'] = p.name;
              }
            });
            this._hisRef.forEach((p, i) => {
              if (byId[p.account_id]) {
                patch['history[' + i + '].verified'] = p.verified;
                patch['history[' + i + '].name'] = p.name;
              }
            });
            patch.memberQuality = {
              verifiedCount: res.verifiedCount,
              total: res.total,
              confidence: res.confidence,
              text: CONF_TEXT[res.confidence],
              sources: res.sources,
              sourceLabel: res.sourceLabel || ''
            };
            this.setData(patch);
            finalizeEnhance();
          })
          .catch(() => { finalizeEnhance(); });

        // 2) 战队扩展信息
        sources.enrichTeamInfo({ id: this.data.teamId, name: teamInfo.name })
          .then((info) => {
            this._enhancePending.info = info;
            if (!info) { finalizeEnhance(); return; }
            const patch = {};
            const tm = Object.assign({}, this.data.team);
            if (info.name && info.name.length > (tm.name || '').length) tm.name = info.name;
            if (info.tag) tm.tag = info.tag;
            if (info.country) tm.country = info.country;
            if (info.logo && /^https?:\/\//i.test(info.logo)) tm.logo = info.logo;
            patch.team = tm;
            this.setData(patch);
            finalizeEnhance();
          })
          .catch(() => { finalizeEnhance(); });

        // 3) 战队 logo
        sources.enrichTeamLogo({ id: this.data.teamId, name: teamInfo.name, logo: teamInfo.logo })
          .then((r) => {
            this._enhancePending.logo = r;
            if (r && r.logo && r.logo !== teamInfo.logo) {
              this.setData({
                'team.logo': r.logo,
                logoSource: r.source
              });
            }
            finalizeEnhance();
          })
          .catch(() => { finalizeEnhance(); });

        // 4) 队员头像：路径更新避免整体 current setData
        Promise.all(
          this._curRef.map((p, idx) =>
            sources.enrichPlayerAvatar({ accountId: p.account_id, avatar: '' })
              .then((r) => {
                if (r && r.avatar) {
                  // 路径更新：仅设置单行 avatar，不拷贝整个 current 数组
                  this.setData({ ['current[' + idx + '].avatar']: r.avatar, ['current[' + idx + '].avatarSource']: r.source });
                }
              })
              .catch(() => {})
          )
        ).then(() => {
          finalizeEnhance();
        });
      })
      .catch(() => {
        this.setData({ loading: false, error: '加载失败，请检查网络或域名配置' });
      });
  },

  loadMatches() {
    this.setData({ matchLoading: true });
    return api.getTeamMatches(this.data.teamId)
      .then((list) => {
        this.allMatches = (list || []).map((m) => this.fmtMatch(m));
        const pageSize = config.pageSize;
        const slice = this.allMatches.slice(0, pageSize);
        const at = api.fetchedAtOf('teamMatches', this.data.teamId) || this.data.updatedAt;
        // 合并 4 次 setData → 1 次
        this.setData({
          totalMatches: this.allMatches.length,
          matches: slice,
          matchPage: 0,
          matchHasMore: this.allMatches.length > slice.length,
          matchLoading: false,
          updatedAt: at,
          updatedLabel: util.formatAgo(at)
        });
      })
      .catch(() => this.setData({ matchLoading: false }));
  },

  fmtPlayer(p) {
    const games = p.games_played || 0;
    const wins = p.wins || 0;
    return {
      account_id: p.account_id,
      name: p.name || ('ID:' + p.account_id),
      games: games,
      wins: wins,
      winRate: util.winRate(wins, games),
      winPct: games > 0 ? Math.round(wins / games * 100) : 0,
      avatar: '',
      isCurrent: util.isCurrentMember(p),
      verified: false,
      crossSources: 1
    };
  },

  fmtMatch(m) {
    const won = (m.radiant === m.radiant_win);
    // 本队在天辉方：ownScore = radiant_score；本队在夜魇方：ownScore = dire_score
    const ownScore = m.radiant ? m.radiant_score : m.dire_score;
    const oppScore = m.radiant ? m.dire_score : m.radiant_score;
    const oppName = m.opposing_team_name || '未知对手';
    return {
      match_id: m.match_id,
      oppId: m.opposing_team_id,
      oppName: oppName,
      oppTag: (oppName || '?').slice(0, 3).toUpperCase(),
      league: m.league_name || '',
      time: util.formatTime(m.start_time),
      duration: m.duration ? util.formatDuration(m.duration) : '',
      won: won,
      ownScore: ownScore != null ? ownScore : 0,
      oppScore: oppScore != null ? oppScore : 0
    };
  },

  sliceMatches(reset) {
    const pageSize = config.pageSize;
    const page = reset ? 0 : this.data.matchPage;
    const slice = this.allMatches.slice(0, (page + 1) * pageSize);
    this.setData({ matches: slice, matchPage: page, matchHasMore: this.allMatches.length > slice.length });
  },

  appendMatches() {
    const page = this.data.matchPage + 1;
    const pageSize = config.pageSize;
    const slice = this.allMatches.slice(0, (page + 1) * pageSize);
    this.setData({ matches: slice, matchPage: page, matchHasMore: this.allMatches.length > slice.length });
  },

  onTab(e) {
    const key = e.currentTarget.dataset.key;
    if (key === this.data.tab) return;
    this.setData({ tab: key });
  },

  toggleFollow() {
    const followed = follow.toggle('teams', { id: this.data.teamId, name: this.data.team.name });
    this.setData({ followed: followed });
    wx.showToast({ title: followed ? '已关注' : '已取消关注', icon: 'none' });
    if (followed) subscribe.requestSubscribe();
  },

  openPlayer(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: '/pages/player-detail/player-detail?accountId=' + id });
  },

  openTeam(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: '/pages/team-detail/team-detail?teamId=' + id });
  },

  // 比赛卡跳转到对手战队详情（vs-card 的 data-id 是 oppId）
  openOpp(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: '/pages/team-detail/team-detail?teamId=' + id });
  }
});
