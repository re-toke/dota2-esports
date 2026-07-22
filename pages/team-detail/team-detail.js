const api = require('../../utils/api.js');
const util = require('../../utils/util.js');
const follow = require('../../utils/follow.js');
const subscribe = require('../../utils/subscribe.js');
const config = require('../../utils/config.js');
const sources = require('../../utils/sources.js');

const CONF_TEXT = { low: '待核实', medium: '较可信', high: '可信' };

Page({
  data: {
    teamId: '',
    team: null,
    current: [],
    history: [],
    tab: 'current',
    matches: [],
    matchPage: 0,
    matchHasMore: false,
    matchLoading: false,
    loading: true,
    error: '',
    followed: false,
    memberQuality: null,   // 成员交叉验证结果：{ verifiedCount, total, confidence, sources }
    logoSource: '',        // 战队 logo 来源标注
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
          country: t.country_code || ''
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

        this.setData({ team: teamInfo, current: cur, history: his, loading: false });

        // 新鲜度（OpenDota 采集时间戳）
        const at = api.fetchedAtOf('team', this.data.teamId) || api.fetchedAtOf('teamPlayers', this.data.teamId);
        this.setData({ updatedAt: at, updatedLabel: util.formatAgo(at) });

        // 异步增强（多源聚合，不阻塞主流程）：
        // 1) 成员交叉验证（OpenDota / STRATZ 名册按 account_id 比对）
        // 2) 战队扩展信息（curation 永远可用 / Steam 官方需 key）
        // 3) 战队 logo（STRATZ）
        // 4) 队员头像（STRATZ）
        const crossMembers = sources.crossTeamMembers(this.data.teamId)
          .then((res) => {
            if (!res) return;
            const byId = {};
            (res.members || []).forEach((m) => { byId[m.account_id] = m; });
            [cur, his].forEach((arr) => arr.forEach((p) => {
              const c = byId[p.account_id];
              if (c) {
                p.verified = c.verified;
                p.crossSources = c.crossSources;
                // 多源交叉验证得到的更完整名字覆盖截断名
                if (c.name && c.name.length > (p.name || '').length) p.name = c.name;
              }
            }));
            this.setData({
              current: cur,
              history: his,
              memberQuality: {
                verifiedCount: res.verifiedCount,
                total: res.total,
                confidence: res.confidence,
                text: CONF_TEXT[res.confidence],
                sources: res.sources,
                sourceLabel: res.sourceLabel || ''
              }
            });
          })
          .catch(() => {});

        const enrichInfo = sources.enrichTeamInfo({ id: this.data.teamId, name: teamInfo.name })
          .then((info) => {
            if (!info) return;
            const tm = Object.assign({}, this.data.team);
            if (info.name && info.name.length > (tm.name || '').length) tm.name = info.name;
            if (info.tag) tm.tag = info.tag;
            if (info.country) tm.country = info.country;
            if (info.logo && /^https?:\/\//i.test(info.logo)) tm.logo = info.logo;
            this.setData({ team: tm });
          })
          .catch(() => {});

        const enrichLogo = sources.enrichTeamLogo({ id: this.data.teamId, name: teamInfo.name, logo: teamInfo.logo })
          .then((r) => {
            if (r && r.logo && r.logo !== teamInfo.logo) {
              const tm = Object.assign({}, this.data.team, { logo: r.logo, logoSource: r.source });
              this.setData({ team: tm, logoSource: r.source });
            }
          })
          .catch(() => {});

        const enrichPlayers = Promise.all(
          cur.map((p) =>
            sources.enrichPlayerAvatar({ accountId: p.account_id, avatar: '' })
              .then((r) => {
                if (r && r.avatar) {
                  p.avatar = r.avatar;
                  p.avatarSource = r.source;
                }
              })
              .catch(() => {})
          )
        ).then(() => {
          this.setData({ current: this.data.current });
        });

        Promise.all([crossMembers, enrichInfo, enrichLogo, enrichPlayers]);
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
        this.sliceMatches(true);
        const at = api.fetchedAtOf('teamMatches', this.data.teamId);
        this.setData({ matchLoading: false, updatedAt: at || this.data.updatedAt, updatedLabel: util.formatAgo(at || this.data.updatedAt) });
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
    return {
      match_id: m.match_id,
      oppId: m.opposing_team_id,
      oppName: m.opposing_team_name || '未知对手',
      league: m.league_name || '',
      time: util.formatTime(m.start_time),
      won: won,
      score: won
        ? (m.radiant_score + ' : ' + m.dire_score)
        : (m.dire_score + ' : ' + m.radiant_score)
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
  }
});
