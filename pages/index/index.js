// pages/index/index.js
// 24 独立「首页」页（tabBar 首屏）：承载原挂在 leagues 顶部的「我的关注」横向卡片流（spec C.2.1），
// 并作为全局搜索（5.2）等核心入口的常驻承载页。关注数据来自本地 Storage（follow 工具），无需后端。
const api = require('../../utils/api.js');
const util = require('../../utils/util.js');
const follow = require('../../utils/follow.js');
const sources = require('../../utils/sources.js');
const tiers = require('../../utils/tiers.js');
const subscribe = require('../../utils/subscribe.js');
const reminderStrategy = require('../../utils/reminderStrategy.js');

// 关注卡片流展示上限，避免关注过多战队时批量请求打满 OpenDota 60 req/min
const FOLLOW_CAP = 15;

Page({
  data: {
    followLoading: false,
    hasFollow: false,
    hasFollowMatches: false,
    followCards: [],
    nowSec: 0,
    // 1.3 个性化推荐位：热门 S 级赛事（排除已关注，个性化发现流）
    recLeagues: []
  },

  onLoad() {
    this.loadFollowCards();
    this.loadRecommendations();
  },

  onShow() {
    // 同步自定义 tabBar 选中态
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 0 });
    }
    // 首次 onShow 跳过（onLoad 已加载），仅启动定时器；
    // 后续 onShow（从其他 tab 切回）才刷新数据，避免首次进入时 onLoad+onShow 重复执行
    if (this._loaded) {
      this.loadFollowCards();
      this.loadRecommendations();
    }
    this._loaded = true;
    this.startTimer();
  },

  onHide() {
    this.stopTimer();
  },

  onUnload() {
    this.stopTimer();
  },

  startTimer() {
    if (this._timer) return;
    this._timer = setInterval(() => this.tickCountdown(), 1000);
  },

  stopTimer() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  },

  // 聚合关注战队的「下一场赛事」卡片。数据来源 api.getTeamMatches（经 10min 缓存层）。
  // 每个战队取：未来最近一场（upcoming）优先；无未来场次则取最近一场（ended）占位。
  loadFollowCards() {
    const teams = follow.list('teams') || [];
    if (!teams.length) {
      // 合并：原 hasFollow + followCards + hasFollowMatches + followLoading 多次 setData 为单次
      this.setData({ hasFollow: false, followCards: [], hasFollowMatches: false, followLoading: false });
      return;
    }
    // 合并：原 hasFollow + followLoading 两次 setData 为单次
    this.setData({ hasFollow: true, followLoading: true });
    const now = util.nowSec();
    const limited = teams.slice(0, FOLLOW_CAP);
    Promise.all(limited.map((t) =>
      api.getTeamMatches(String(t.id))
        .then((ms) => ({ t: t, ms: ms || [] }))
        .catch(() => ({ t: t, ms: [] }))
    )).then((rows) => {
      const cards = [];
      rows.forEach(({ t, ms }) => {
        const card = this.buildFollowCard(t, ms, now);
        if (card) cards.push(card);
      });
      this.setData({
        followCards: cards,
        hasFollowMatches: cards.length > 0,
        followLoading: false
      });
      // 2.2 闭环：后台静默检查赛前提醒（不阻塞 UI）
      this.checkPreMatchReminders(rows, now);
    }).catch(() => {
      this.setData({ followLoading: false });
    });
  },

  // 1.3 个性化推荐位：从本地 curation 取「即将到来」的 S/SSS 顶级赛事，
  // 排除用户已关注的联赛，构成个性化发现流（无需网络，永远可用）。
  // 关注画像（follow.list('leagues')）驱动「排除已关注」，实现个性化。
  loadRecommendations() {
    const now = util.nowSec();
    const followedIds = (follow.list('leagues') || []).map((x) => String(x.id));
    const events = sources.getUpcomingFromCuration(now) || [];
    const recs = events
      .filter((ev) => ev.tier && (ev.tier.grade === 'SSS' || ev.tier.grade === 'S'))
      .filter((ev) => followedIds.indexOf(String(ev.id)) < 0)
      .slice(0, 8)
      .map((ev) => {
        const grade = ev.tier.grade;
        return {
          leagueid: Number(ev.id),
          name: ev.name,
          grade: grade,
          rank: ev.tier.rank,
          label: ev.tier.label,
          displayLabel: tiers.displayOf(grade),
          tagTheme: (tiers.displayThemeOf(grade) || {}).theme || 'default',
          tierClass: 'tier-' + grade.toLowerCase(),
          startDate: ev.startDate,
          endDate: ev.endDate,
          dateRange: util.formatDateRange(ev.startDate, ev.endDate),
          daysToStart: Math.ceil((ev.startDate - now) / 86400)
        };
      });
    this.setData({ recLeagues: recs });
  },

  // 由战队比赛列表构造一张「下一场赛事」卡片
  buildFollowCard(team, matches, now) {
    const list = matches || [];
    if (!list.length) return null;
    const upcoming = list.filter((m) => m.start_time > now).sort((a, b) => a.start_time - b.start_time);
    const past = list.filter((m) => m.start_time <= now).sort((a, b) => b.start_time - a.start_time);
    const pick = upcoming[0] || past[0];
    if (!pick) return null;
    const isUpcoming = pick.start_time > now;
    const tier = sources.getMatchTier(pick.league_name || '');
    const won = (pick.radiant === pick.radiant_win);
    const ownScore = pick.radiant ? pick.radiant_score : pick.dire_score;
    const oppScore = pick.radiant ? pick.dire_score : pick.radiant_score;
    const card = {
      teamId: String(team.id),
      teamName: team.name || ('战队 ' + team.id),
      teamTag: team.tag || (team.name || '?').slice(0, 3).toUpperCase(),
      oppId: pick.opposing_team_id,
      oppName: pick.opposing_team_name || '未知对手',
      oppTag: (pick.opposing_team_name || '?').slice(0, 3).toUpperCase(),
      leagueid: pick.leagueid,
      leagueName: sources.leagueDisplayName(pick) || '',
      displayName: sources.leagueDisplayName(pick),
      tierClass: tier ? 'tier-' + tier.grade.toLowerCase() : '',
      tierLabel: tier ? tier.label : '',
      start: pick.start_time,
      status: isUpcoming ? 'upcoming' : 'ended',
      dateText: util.formatTime(pick.start_time),
      score: ownScore + ':' + oppScore,
      won: won,
      countdownText: ''
    };
    card.countdownText = this.fmtCountdown(pick.start_time, now);
    return card;
  },

  // 自绘倒计时文本（TDesign 小程序版无原生 CountDown，前端每秒校准）
  fmtCountdown(start, now) {
    let diff = start - now;
    if (diff <= 0) return '进行中';
    const d = Math.floor(diff / 86400);
    const h = Math.floor((diff % 86400) / 3600);
    const m = Math.floor((diff % 3600) / 60);
    const s = diff % 60;
    const pad = (n) => (n < 10 ? '0' + n : '' + n);
    if (d > 0) return d + '天 ' + pad(h) + ':' + pad(m) + ':' + pad(s);
    return pad(h) + ':' + pad(m) + ':' + pad(s);
  },

  // 每秒 tick：仅当某卡片倒计时文本变化时才用路径更新，避免数组全量重建
  // 优化：删除无用的 nowSec setData（wxml 未引用该字段），合并为单次路径式 setData
  tickCountdown() {
    const now = util.nowSec();
    const cards = this.data.followCards;
    if (!cards.length) return;
    const updates = {};
    let hasChange = false;
    for (let i = 0; i < cards.length; i++) {
      const c = cards[i];
      if (c.status !== 'upcoming') continue;
      const ct = this.fmtCountdown(c.start, now);
      if (ct !== c.countdownText) {
        updates['followCards[' + i + '].countdownText'] = ct;
        hasChange = true;
      }
    }
    if (hasChange) this.setData(updates);
  },

  // 卡片点击：有联赛 id 跳赛事详情，否则跳对手战队详情
  openFollowCard(e) {
    const d = e.currentTarget.dataset;
    if (d.leagueid) {
      wx.navigateTo({ url: '/subpackages/detail/league-detail/league-detail?leagueId=' + d.leagueid + '&name=' + encodeURIComponent(d.leaguename || '') });
    } else if (d.oppid) {
      wx.navigateTo({ url: '/subpackages/detail/team-detail/team-detail?teamId=' + d.oppid });
    }
  },

  openFollowCenter() {
    wx.switchTab({ url: '/pages/follow/follow' });
  },

  // 1.3 推荐位：点击热门赛事卡 → 赛事详情
  openLeague(e) {
    const id = e.currentTarget.dataset.id;
    const name = e.currentTarget.dataset.name;
    if (!id) return;
    wx.navigateTo({ url: '/subpackages/detail/league-detail/league-detail?leagueId=' + id + '&name=' + encodeURIComponent(name || '') });
  },

  goFollowTeams() {
    wx.switchTab({ url: '/pages/teams/teams' });
  },

  // 5.2 全局搜索入口
  openSearch() {
    wx.navigateTo({ url: '/pages/search/search' });
  },

  // 快捷入口：跳转到对应 tab
  goTab(e) {
    const p = e.currentTarget.dataset.path;
    if (p) wx.switchTab({ url: p });
  },

  // ===== 2.2 订阅闭环：赛前提醒静默检查 =====
  // 遍历关注战队的比赛列表，对「即将开始」且在提醒窗口内的比赛触发推送。
  // 后台执行，失败不响应用户（静默模式）。
  // ★ 优化：优先用 app.js 预热的同步 openid（getOpenIdSync），未就绪时回退异步 ensureOpenId；
  //   候选筛选并行执行（纯计算无副作用），trigger 串行执行（避免 daily_limit 竞态）。
  checkPreMatchReminders(rows, now) {
    var strategy = reminderStrategy.getStrategy();
    var openid = subscribe.getOpenIdSync();
    if (openid) {
      this._runPreMatchReminders(rows, now, strategy, openid);
    } else {
      subscribe.ensureOpenId().then((oid) => {
        if (!oid) return;
        this._runPreMatchReminders(rows, now, strategy, oid);
      });
    }
  },

  // 抽出实际遍历逻辑，与 openid 获取解耦
  _runPreMatchReminders(rows, now, strategy, openid) {
    // 阶段1：并行筛选出真正需要触发的比赛（纯计算，无副作用）
    var candidates = [];
    rows.forEach(function ({ t, ms }) {
      if (!ms || !ms.length) return;
      var upcoming = ms.filter(function (m) { return m.start_time > now; })
        .sort(function (a, b) { return a.start_time - b.start_time; });
      var match = upcoming[0];
      if (!match) return;
      var ev = reminderStrategy.evaluate(match, strategy, now);
      if (!ev.should) {
        console.log('[subscribe] skip reminder:', match.league_name, '| reason=', ev.reason, '| grade=', ev.grade);
        return;
      }
      match.radiant_name = match.radiant_name || (match.radiant ? t.name : '');
      match.dire_name = match.dire_name || (!match.radiant ? t.name : match.opposing_team_name || '');
      match.match_id = match.match_id || String(match.leagueid || '') + '_' + String(match.start_time || '');
      candidates.push(match);
    });
    if (!candidates.length) return;

    // 阶段2：串行 trigger（避免 getTodayCount 竞态导致 daily_limit 突破）
    function triggerNext(idx) {
      if (idx >= candidates.length) return;
      subscribe.triggerPreMatchReminder(candidates[idx], openid)
        .then(function (result) {
          if (result.sent) {
            console.log('[subscribe] 提醒已发送:',
              candidates[idx].league_name,
              candidates[idx].radiant_name, 'VS', candidates[idx].dire_name);
          }
          // daily_limit 命中时提前终止，避免无效请求
          if (result.reason === 'daily_limit') {
            console.log('[subscribe] 今日限额已达，停止后续 trigger');
            return;
          }
          triggerNext(idx + 1);
        })
        .catch(function () { triggerNext(idx + 1); });
    }
    triggerNext(0);
  }
});
