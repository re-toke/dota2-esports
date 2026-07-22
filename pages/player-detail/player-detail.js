const api = require('../../utils/api.js');
const util = require('../../utils/util.js');
const follow = require('../../utils/follow.js');
const subscribe = require('../../utils/subscribe.js');
const config = require('../../utils/config.js');
const sources = require('../../utils/sources.js');
const app = getApp();

Page({
  data: {
    accountId: '',
    profile: null,
    stats: null,
    recent: [],
    topHeroes: [],
    loading: true,
    loadingMore: false,
    hasMore: false,
    page: 0,
    pageSize: config.pageSize,
    error: '',
    followed: false,
    updatedAt: 0,
    updatedLabel: ''
  },

  onLoad(options) {
    const accountId = options.accountId;
    this.setData({
      accountId: accountId,
      followed: follow.isFollowed('players', accountId)
    });
    // 选手ID 合法性校验（防御无效/损坏的跳转参数）
    const v = sources.validatePlayerId(accountId);
    if (!v.valid) {
      this.setData({ loading: false, error: '选手 ID 无效' });
      return;
    }
    this.load();
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading && !this.data.loadingMore) this.appendPage();
  },

  load() {
    this.setData({ loading: true, error: '' });
    return Promise.all([
      api.getPlayer(this.data.accountId),
      api.getPlayerMatches(this.data.accountId)
    ])
      .then(([player, matches]) => {
        const p = (player && player.profile) ? player.profile : {};
        const profile = {
          name: p.personaname || p.name || ('ID:' + this.data.accountId),
          realName: p.name || '',
          avatar: p.avatarfull || '',
          country: p.country_code || '',
          steamId: p.steamid || '',
          rankTier: (player && player.rank_tier) ? (Math.floor(player.rank_tier / 10) + ' 星 ' + (player.rank_tier % 10)) : '未定级',
          leaderboard: (player && player.leaderboard_rank) ? ('#' + player.leaderboard_rank) : ''
        };

        const list = matches || [];
        const heroMap = app.globalData.heroMap || {};
        const heroCount = {};
        let wins = 0;

        list.forEach((m) => {
          if (util.playerWon(m)) wins++;
          const hid = m.hero_id;
          heroCount[hid] = (heroCount[hid] || 0) + 1;
        });

        const total = list.length;
        const stats = {
          total: total,
          wins: wins,
          losses: total - wins,
          winRate: util.winRate(wins, total)
        };

        this.playerName = profile.name;

        // 全部战绩（按最近排序，OpenDota 默认即倒序）
        const allRecent = list.map((m) => {
          const won = util.playerWon(m);
          return {
            match_id: m.match_id,
            heroName: heroMap[m.hero_id] || ('英雄' + m.hero_id),
            win: won,
            k: m.kills,
            d: m.deaths,
            a: m.assists,
            duration: util.formatDuration(m.duration),
            time: util.formatTime(m.start_time),
            league: m.league_name || ''
          };
        });

        // 常用英雄
        const topHeroes = Object.keys(heroCount)
          .map((hid) => ({ id: hid, name: heroMap[hid] || ('英雄' + hid), games: heroCount[hid] }))
          .sort((a, b) => b.games - a.games)
          .slice(0, 5);

        this.allRecent = allRecent;
        const pageSize = this.data.pageSize;
        const recent = allRecent.slice(0, pageSize);
        const at = api.fetchedAtOf('player', this.data.accountId) || api.fetchedAtOf('playerMatches', this.data.accountId);
        this.setData({
          profile, stats, recent, topHeroes,
          loading: false,
          page: 0,
          hasMore: allRecent.length > recent.length,
          updatedAt: at,
          updatedLabel: util.formatAgo(at)
        });

        // 异步增强队员头像：多源聚合（STRATZ），不阻塞主流程
        sources.enrichPlayerAvatar({ accountId: this.data.accountId, avatar: profile.avatar })
          .then((r) => {
            if (r && r.avatar && r.avatar !== profile.avatar) {
              const pf = Object.assign({}, profile, { avatar: r.avatar, avatarSource: r.source });
              this.setData({ profile: pf });
            }
          });
      })
      .catch(() => {
        this.setData({ loading: false, error: '加载失败，请检查网络或域名配置' });
      });
  },

  appendPage() {
    if (!this.allRecent || this.data.loadingMore || !this.data.hasMore) return;
    this.setData({ loadingMore: true });
    const pageSize = this.data.pageSize;
    const page = this.data.page + 1;
    const slice = this.allRecent.slice(0, (page + 1) * pageSize);
    this.setData({
      recent: slice,
      page: page,
      hasMore: this.allRecent.length > slice.length,
      loadingMore: false
    });
  },

  toggleFollow() {
    const name = this.playerName || ('ID:' + this.data.accountId);
    const followed = follow.toggle('players', { id: this.data.accountId, name: name });
    this.setData({ followed: followed });
    wx.showToast({ title: followed ? '已关注' : '已取消关注', icon: 'none' });
    if (followed) subscribe.requestSubscribe();
  }
});
