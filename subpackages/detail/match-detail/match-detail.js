const api = require('../../../utils/api.js');
const util = require('../../../utils/util.js');
const app = getApp();
const liveSources = require('../../../utils/liveSources.js');
const realtime = require('../../../utils/realtime.js');

// 物品图标 CDN 基址（OpenDota 官方图床）
const ITEM_IMG_BASE = 'https://cdn.opendota.com/apps/dota2/images/dota2/items/';

// 从比赛 objectives 提取关键事件标记（肉山/推塔），映射到经济差曲线采样下标。
// 经济差曲线每 5 分钟(300s)采样一次，故 index = floor(time / 300)。
function buildEvents(m, goldLen) {
  if (!goldLen) return [];
  const objs = m.objectives || [];
  const out = [];
  const seen = {};
  objs.forEach((o) => {
    const t = o.time;
    if (t == null) return;
    const idx = Math.floor(t / 300);
    if (idx < 0 || idx >= goldLen) return;
    if (o.type && /ROSHAN/.test(o.type)) {
      if (!seen['r' + idx]) { seen['r' + idx] = 1; out.push({ index: idx, label: '肉山', color: '#C8A951' }); }
    } else if (o.type === 'building_kill' && (o.key === 'tower' || (o.subtype || '').indexOf('tower') >= 0)) {
      if (!seen['t' + idx]) { seen['t' + idx] = 1; out.push({ index: idx, label: '推塔', color: '#A41E1E' }); }
    }
  });
  return out.slice(0, 10);
}

Page({
  data: {
    matchId: '',
    match: null,         // 比赛原始数据
    radiant: [],          // 天辉方选手明细（含 hero/kda/gpm/xpm/items）
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
    goldAdv: [],         // 经济差曲线（每分钟 radiant - dire，正数天辉领先）
    xpAdv: [],           // 经验差曲线
    goldFinal: 0,        // 最终经济差（>0 天辉领先）
    loading: true,
    error: '',
    updatedAt: 0,
    updatedLabel: '',
    // F1 直播聚合入口
    liveSources: [],
    isLive: false,
    liveStatus: '',      // realtime: '' | 'connected' | 'polling'
    // V4 图表数据
    chartSeries: [],
    chartCats: [],
    chartEvents: []
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

  onUnload() {
    if (this._realtime) {
      this._realtime.close();
      this._realtime = null;
    }
  },

  retry() {
    this.load();
  },

  // 把 item_0~5 + item_neutral 数字 id 转成 { name, img, dname }
  buildItems(p, itemMap) {
    const slots = ['item_0', 'item_1', 'item_2', 'item_3', 'item_4', 'item_5', 'item_neutral'];
    const items = [];
    slots.forEach((slot) => {
      const id = p[slot];
      if (id == null || id === 0) return; // 空槽位
      const it = itemMap[id];
      if (it) {
        items.push({ name: it.name, img: ITEM_IMG_BASE + it.img, dname: it.dname });
      } else {
        items.push({ name: 'item_' + id, img: '', dname: '物品' + id });
      }
    });
    return items;
  },

  load() {
    this.setData({ loading: true, error: '' });
    return api.getMatch(this.data.matchId)
      .then((m) => {
        if (!m) {
          this.setData({ loading: false, error: '未找到该比赛' });
          return;
        }
        this.applyMatch(m);
      })
      .catch(() => {
        this.setData({ loading: false, error: '加载失败，请检查网络或域名配置' });
      });
  },

  // 解析并渲染比赛数据（load 与实时推送共用，避免重复逻辑）
  applyMatch(m) {
    const heroMap = (app.globalData && app.globalData.heroMap) || {};
    const itemMap = (app.globalData && app.globalData.itemMap) || {};
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
        isRadiant: isRadiant,
        items: this.buildItems(p, itemMap),  // 出装栏
        lastHits: p.last_hits || 0,
        denies: p.denies || 0,
        heroDamage: p.hero_damage || 0,
        towerDamage: p.tower_damage || 0
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

    // 经济/经验曲线（OpenDota 字段：radiant_gold_advantage_timeline / radiant_xp_advantage_timeline）
    // 每分钟一个值，正数=天辉领先，负数=夜魇领先。采样降密度（每 5 分钟取一个）避免 setData 过大。
    const goldFull = m.radiant_gold_advantage_timeline || m.radiant_gold_adv || [];
    const xpFull = m.radiant_xp_advantage_timeline || m.radiant_xp_adv || [];
    const sampleEvery = 5;
    const goldAdv = [];
    const xpAdv = [];
    for (let i = 0; i < goldFull.length; i += sampleEvery) {
      goldAdv.push(Math.round(goldFull[i]));
    }
    for (let i = 0; i < xpFull.length; i += sampleEvery) {
      xpAdv.push(Math.round(xpFull[i]));
    }
    const goldFinal = goldFull.length ? Math.round(goldFull[goldFull.length - 1]) : 0;

    // V4 图表：双序列对比 + 关键事件标记
    const chartSeries = [
      { name: '经济差', color: '#C8A951', data: goldAdv },
      { name: '经验差', color: '#3FB950', data: xpAdv }
    ];
    const chartCats = goldAdv.map((_, i) => (i * 5) + 'm');
    const chartEvents = buildEvents(m, goldAdv.length);

    const at = api.fetchedAtOf('match', this.data.matchId) || Date.now();
    // F1：比赛进行中判定 —— 未分胜负且近 12h 开赛视为直播中
    const nowSec = Math.floor(Date.now() / 1000);
    const isLive = (m.radiant_win == null) && m.start_time && (nowSec - m.start_time) > 0 && (nowSec - m.start_time) < 12 * 3600;

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
      goldAdv: goldAdv,
      xpAdv: xpAdv,
      goldFinal: goldFinal,
      chartSeries: chartSeries,
      chartCats: chartCats,
      chartEvents: chartEvents,
      loading: false,
      updatedAt: at,
      updatedLabel: util.formatAgo(at),
      liveSources: liveSources.buildSources(m.league && m.league.name ? m.league.name : ''),
      isLive: isLive
    });

    // T4：直播中进行时建立实时连接（WebSocket 或降级轮询）
    this.startRealtime(isLive);
  },

  // T4：实时比分连接（WebSocket + 断线重连 + 降级轮询）
  startRealtime(isLive) {
    if (this._realtimeStarted || !isLive) return;
    this._realtimeStarted = true;
    const session = realtime.createSession(this.data.matchId, {
      fetchPoll: () => api.getMatch(this.data.matchId),
      onUpdate: (m) => { if (m) this.applyMatch(m); },
      onStatus: (s) => { this.setData({ liveStatus: s }); }
    });
    this._realtime = session;
  },

  openPlayer(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: '/subpackages/detail/player-detail/player-detail?accountId=' + id });
  }
});
