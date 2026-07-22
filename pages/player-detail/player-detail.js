const api = require('../../utils/api.js');
const util = require('../../utils/util.js');
const follow = require('../../utils/follow.js');
const subscribe = require('../../utils/subscribe.js');
const config = require('../../utils/config.js');
const sources = require('../../utils/sources.js');
const app = getApp();

// 来源 key -> 中文标签
const SOURCE_BADGES = {
  opendota: 'OpenDota',
  stratz: 'STRATZ',
  steam: 'Steam',
  liquipedia: 'Liquipedia',
  curation: '本地策展'
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
    accountId: '',
    profile: null,
    stats: null,
    recent: [],
    totalRecent: 0,
    topHeroes: [],
    loading: true,
    loadingMore: false,
    hasMore: false,
    page: 0,
    pageSize: config.pageSize,
    error: '',
    followed: false,
    sourceBadges: [],
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
        const heroWins = {};
        let wins = 0;

        // 合并两次遍历为一次：同时计算 stats 聚合 + 格式化 recent
        const allRecent = list.map((m) => {
          const won = util.playerWon(m);
          if (won) wins++;
          const hid = m.hero_id;
          heroCount[hid] = (heroCount[hid] || 0) + 1;
          if (won) heroWins[hid] = (heroWins[hid] || 0) + 1;
          return {
            match_id: m.match_id,
            heroName: heroMap[hid] || ('英雄' + hid),
            win: won,
            k: m.kills,
            d: m.deaths,
            a: m.assists,
            duration: util.formatDuration(m.duration),
            time: util.formatTime(m.start_time),
            league: m.league_name || ''
          };
        });

        const total = list.length;
        const stats = {
          total: total,
          wins: wins,
          losses: total - wins,
          winRate: util.winRate(wins, total)
        };

        this.playerName = profile.name;

        // 常用英雄（含胜率）
        const topHeroes = Object.keys(heroCount)
          .map((hid) => {
            const games = heroCount[hid];
            const heroWinsCount = heroWins[hid] || 0;
            const winPct = games > 0 ? Math.round(heroWinsCount / games * 100) : 0;
            return {
              id: hid,
              name: heroMap[hid] || ('英雄' + hid),
              games: games,
              wins: heroWinsCount,
              winPct: winPct,
              winRate: util.winRate(heroWinsCount, games)
            };
          })
          .sort((a, b) => b.games - a.games)
          .slice(0, 5);

        this.allRecent = allRecent;
        const pageSize = this.data.pageSize;
        const recent = allRecent.slice(0, pageSize);
        const at = api.fetchedAtOf('player', this.data.accountId) || api.fetchedAtOf('playerMatches', this.data.accountId);
        this.setData({
          profile, stats, recent, topHeroes,
          totalRecent: allRecent.length,
          loading: false,
          page: 0,
          hasMore: allRecent.length > recent.length,
          updatedAt: at,
          updatedLabel: util.formatAgo(at),
          sourceBadges: buildSourceBadges(['opendota'])
        });

        // 异步增强队员头像：多源聚合（STRATZ），不阻塞主流程
        sources.enrichPlayerAvatar({ accountId: this.data.accountId, avatar: profile.avatar })
          .then((r) => {
            if (r && r.avatar && r.avatar !== profile.avatar) {
              // 路径更新：仅刷新 profile.avatar，不整体替换 profile 对象
              const patch = { 'profile.avatar': r.avatar };
              if (r.source) {
                patch['profile.avatarSource'] = r.source;
                const newBadges = (this.data.sourceBadges || []).slice();
                if (!newBadges.find((b) => b.key === r.source)) {
                  newBadges.push({ key: r.source, label: SOURCE_BADGES[r.source] || r.source });
                }
                patch.sourceBadges = newBadges;
              }
              this.setData(patch);
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
