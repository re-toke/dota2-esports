const api = require('../../../utils/api.js');
const util = require('../../../utils/util.js');
const app = getApp();
const liveSources = require('../../../utils/liveSources.js');
const realtime = require('../../../utils/realtime.js');
const heroes = require('../../../utils/heroes.js');
const sources = require('../../../utils/sources.js');

// Steam CDN 英雄头像基址（_sb.png = 小横幅图）
const HERO_IMG_BASE = 'https://cdn.cloudflare.steamstatic.com/apps/dota2/images/heroes/';
// 物品图标统一走 Steam CDN（与英雄头像同源，已加入合法域名白名单）。
// api.getItems() 已把 OpenDota 相对路径规范为绝对地址，这里仅做防御性兜底。
const ITEM_CDN_ORIGIN = 'https://cdn.cloudflare.steamstatic.com';

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
    radiantTeamId: '',    // 5.1 内嵌对战：天辉战队 ID（OpenDota 战队赛才有）
    direTeamId: '',       // 5.1 内嵌对战：夜魇战队 ID
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
    chartEvents: [],
    // 4.1 锚点卡（关键指标：比分/胜负/Tier/时间）
    anchorTierLabel: '',
    anchorTierClass: '',
    anchorMeta: [],
    anchorWinSide: ''
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
        // it.img 已由 api.getItems() 规范为 Steam CDN 绝对地址；此处仅做防御性兜底
        let img = it.img || '';
        if (img && img.indexOf('http') !== 0) {
          img = ITEM_CDN_ORIGIN + (img.charAt(0) === '/' ? img : '/' + img);
        }
        items.push({ name: it.name, img: img, dname: it.dname });
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
  // F3/F4 优化（2026-07-29）：实时推送走轻量更新路径，避免每 30s/事件全量重建选手数组+图表。
  //   - 首次加载 / 比赛结束（radiant_win 从 null 变为布尔）→ 完整渲染
  //   - 直播中推送（已有数据 + 仍在进行 + 仅比分/时长变化）→ 仅更新标量
  applyMatch(m) {
    if (!m) return;
    // 轻量更新判定：已有选手数据 + 比赛仍在进行（未分胜负）+ 之前也是直播态
    const hasData = this.data.radiant && this.data.radiant.length > 0;
    const stillLive = m.radiant_win == null && this.data.isLive;
    if (hasData && stillLive) {
      this._applyLiveUpdate(m);
      return;
    }
    const heroMap = (app.globalData && app.globalData.heroMap) || {};
    let itemMap = (app.globalData && app.globalData.itemMap) || {};

    // 并行加载英雄库（拼头像 URL）+ 物品库（若 globalData 尚未就绪则现场加载）
    const heroesP = heroes.getHeroes().catch(() => []);
    const itemsP = (Object.keys(itemMap).length > 0)
      ? Promise.resolve(itemMap)
      : api.getItems().catch(() => ({}));

    Promise.all([heroesP, itemsP]).then((res) => {
      this._applyMatchWithData(m, res[0], res[1]);
    });
  },

  // F3/F4 轻量更新：直播推送时仅更新变化的核心标量（比分/时长/状态/更新时间），
  // 跳过选手数组与图表的全量重建（这些在比赛中变化小，重建开销大）。
  // 比赛结束（radiant_win 有值）会走完整渲染路径，确保最终图表/MVP 正确。
  _applyLiveUpdate(m) {
    const at = Date.now();
    const nowSec = Math.floor(at / 1000);
    const isLive = (m.radiant_win == null) && m.start_time &&
                   (nowSec - m.start_time) > 0 && (nowSec - m.start_time) < 12 * 3600;
    const duration = m.duration ? util.formatDuration(m.duration) : '';
    const patch = {
      radiantScore: m.radiant_score || 0,
      direScore: m.dire_score || 0,
      duration: duration,
      isLive: isLive,
      updatedAt: at,
      updatedLabel: util.formatAgo(at)
    };
    // 比赛结束：补胜负态，下次推送将走完整渲染刷新图表/MVP
    if (m.radiant_win != null) {
      patch.radiantWin = !!m.radiant_win;
      patch.anchorWinSide = m.radiant_win ? 'A' : 'B';
      patch.isLive = false;
    }
    this.setData(patch);
  },

  // 核心渲染逻辑（抽取为独立方法，供 applyMatch 直接调用）
  _applyMatchWithData(m, heroList, itemMap) {
    const heroMap = (app.globalData && app.globalData.heroMap) || {};
    const NPC_PREFIX = 'npc_dota_hero_';
    // id -> 内部名（strip 前缀后拼 Steam CDN 头像 URL）
    const internalMap = {};
    (heroList || []).forEach((h) => {
      if (h && h.id != null) {
        let n = h.name || '';
        if (n.indexOf(NPC_PREFIX) === 0) n = n.slice(NPC_PREFIX.length);
        internalMap[h.id] = n;
      }
    });

    const radiant = [];
    const dire = [];
    let mvp = null;
    let mvpScore = -1;

    (m.players || []).forEach((p) => {
      const isRadiant = (p.isRadiant != null) ? p.isRadiant : (p.player_slot < 128);
      const kdaVal = p.deaths > 0 ? (p.kills + p.assists) / p.deaths : (p.kills + p.assists);
      const heroName = heroMap[p.hero_id] || ('英雄' + p.hero_id);
      // Steam CDN 英雄头像（strip npc_dota_hero_ 前缀）
      const heroInternalName = internalMap[p.hero_id] || '';
      const heroImg = heroInternalName
        ? (HERO_IMG_BASE + encodeURIComponent(heroInternalName) + '_sb.png')
        : '';
      const item = {
        account_id: p.account_id,
        hero_id: p.hero_id,
        heroName: heroName,
        heroShort: (heroName || '?').slice(0, 4),
        heroImg: heroImg,
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

    // 4.1 锚点卡：Tier（联赛分级）+ 时长/开赛 元数据
    // 原始名用于分级判定与直播源匹配（保持社区分级规则/检索稳定），展示名走 curation 规范名
    const rawLeagueName = m.league && m.league.name ? m.league.name : '';
    const leagueName = sources.leagueDisplayName(m);
    const tier = rawLeagueName ? sources.getMatchTier(rawLeagueName) : null;
    const duration = m.duration ? util.formatDuration(m.duration) : '';
    const time = util.formatTime(m.start_time);
    const anchorMeta = [];
    if (duration) anchorMeta.push({ label: '时长', value: duration });
    if (time) anchorMeta.push({ label: '开赛', value: time });

    // F3/F4 分步渲染（2026-07-29）：将原单次大 payload setData 拆为两步。
    //   - 步骤1（骨架）：loading:false + 比分/胜负/状态/锚点/liveSources，用户立即看到核心信息
    //   - 步骤2（明细）：选手数组 + 图表数据，下一帧渲染避免阻塞骨架
    // 收益：首屏可交互时间提前；直播推送场景步骤1即可满足"看比分"需求。
    // 步骤1：骨架（标量 + 锚点，体积小，渲染快）
    this.setData({
      match: {
        match_id: m.match_id,
        radiant_win: m.radiant_win,
        duration: m.duration,
        start_time: m.start_time,
        radiant_team_id: m.radiant_team_id,
        dire_team_id: m.dire_team_id,
        league: m.league
      },
      radiantWin: !!m.radiant_win,
      radiantName: m.radiant_name || m.radiant_team_name || '天辉',
      direName: m.dire_name || m.dire_team_name || '夜魇',
      radiantScore: m.radiant_score || 0,
      direScore: m.dire_score || 0,
      duration: duration,
      time: time,
      league: leagueName,
      radiantTeamId: m.radiant_team_id || '',
      direTeamId: m.dire_team_id || '',
      loading: false,
      updatedAt: at,
      updatedLabel: util.formatAgo(at),
      liveSources: liveSources.buildSources(rawLeagueName),
      isLive: isLive,
      anchorTierLabel: tier ? tier.label : '',
      anchorTierClass: tier ? ('tier-' + (tier.grade || '').toLowerCase()) : '',
      anchorMeta: anchorMeta,
      anchorWinSide: isLive ? '' : (m.radiant_win ? 'A' : 'B')
    });

    // 步骤2：明细（选手数组 + 图表，体积大，独立 setData 避免阻塞骨架渲染）
    this.setData({
      radiant: radiant,
      dire: dire,
      mvp: mvp,
      goldAdv: goldAdv,
      xpAdv: xpAdv,
      goldFinal: goldFinal,
      chartSeries: chartSeries,
      chartCats: chartCats,
      chartEvents: chartEvents
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

  // 5.1 赛事详情内嵌「双方对战」：带双方 team_id 上下文跳 H2H 历史对比
  openH2h() {
    const a = this.data.radiantTeamId;
    const b = this.data.direTeamId;
    if (!a || !b) return;
    wx.navigateTo({
      url: '/subpackages/detail/h2h/h2h?teamA=' + a + '&teamB=' + b
    });
  }
});
