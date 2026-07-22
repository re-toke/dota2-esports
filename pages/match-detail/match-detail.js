const api = require('../../utils/api.js');
const util = require('../../utils/util.js');

Page({
  data: {
    matchId: '',
    match: null,         // 比赛原始数据
    radiant: [],          // 天辉方选手明细（含 hero/kda/gpm/xpm）
    dire: [],            // 夜魇方选手明细
    radiantWin: false,
    radiantName: '',
    direName: '',
    radiantScore: 0,
    direScore: 0,
    duration: '',
    time: '',
    league: '',
    mvp: null,           // 系列赛 MVP（综合分最高）
    loading: true,
    error: '',
    updatedAt: 0,
    updatedLabel: ''
  },

  onLoad(options) {
    const matchId = options.matchId;
    if (!matchId) {
      this.setData({ loading: false, error: '缺少比赛 ID' });
      return;
    }
    this.setData({ matchId: matchId });
    wx.setNavigationBarTitle({ title: '战报 #' + matchId });
    this.load();
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh());
  },

  retry() {
    this.load();
  },

  load() {
    this.setData({ loading: true, error: '' });
    return api.getMatch(this.data.matchId)
      .then((m) => {
        if (!m) {
          this.setData({ loading: false, error: '未找到该比赛' });
          return;
        }
        const heroMap = (getApp().globalData && getApp().globalData.heroMap) || {};
        const radiant = [];
        const dire = [];
        let mvp = null;
        let mvpScore = -1;

        (m.players || []).forEach((p) => {
          const isRadiant = (p.isRadiant != null) ? p.isRadiant : (p.player_slot < 128);
          const kdaVal = p.deaths > 0 ? (p.kills + p.assists) / p.deaths : (p.kills + p.assists);
          const heroName = heroMap[p.hero_id] || ('英雄' + p.hero_id);
          const item = {
            account_id: p.account_id,
            hero_id: p.hero_id,
            heroName: heroName,
            heroShort: (heroName || '?').slice(0, 4),
            name: p.name || p.personaname || '匿名',
            kills: p.kills || 0,
            deaths: p.deaths || 0,
            assists: p.assists || 0,
            kda: (p.kills || 0) + '/' + (p.deaths || 0) + '/' + (p.assists || 0),
            kdaScore: Math.round(kdaVal * 100) / 100,
            gpm: p.gold_per_min || 0,
            xpm: p.xp_per_min || 0,
            isRadiant: isRadiant
          };
          if (isRadiant) radiant.push(item);
          else dire.push(item);
          // MVP 综合分
          const score = kdaVal * 2 + (p.gold_per_min || 0) / 100;
          if (score > mvpScore) {
            mvpScore = score;
            mvp = item;
          }
        });

        const at = api.fetchedAtOf('match', this.data.matchId) || Date.now();
        this.setData({
          match: m,
          radiant: radiant,
          dire: dire,
          radiantWin: !!m.radiant_win,
          radiantName: m.radiant_name || m.radiant_team_name || '天辉',
          direName: m.dire_name || m.dire_team_name || '夜魇',
          radiantScore: m.radiant_score || 0,
          direScore: m.dire_score || 0,
          duration: m.duration ? util.formatDuration(m.duration) : '',
          time: util.formatTime(m.start_time),
          league: m.league && m.league.name ? m.league.name : '',
          mvp: mvp,
          loading: false,
          updatedAt: at,
          updatedLabel: util.formatAgo(at)
        });
      })
      .catch(() => {
        this.setData({ loading: false, error: '加载失败，请检查网络或域名配置' });
      });
  },

  openPlayer(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: '/pages/player-detail/player-detail?accountId=' + id });
  }
});
