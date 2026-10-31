/**
 * utils/matchView.js —— 战报视图模型纯函数
 *
 * 2026-10-30（Batch C · C5）：从 subpackages/detail/match-detail/match-detail.js 抽出。
 * 约束：不引用 wx / getApp / 页面 data，只做「比赛原始数据 → 渲染数据」的纯映射，
 * 便于单测与复用（后续首页卡也可复用 buildEvents / buildAdvSeries）。
 */
'use strict';

// Steam CDN 英雄头像基址（_sb.png = 小横幅图）
const HERO_IMG_BASE = 'https://cdn.cloudflare.steamstatic.com/apps/dota2/images/heroes/';
// 物品图标统一走 Steam CDN（与英雄头像同源，已加入合法域名白名单）。
const ITEM_CDN_ORIGIN = 'https://cdn.cloudflare.steamstatic.com';

const ITEM_SLOTS = ['item_0', 'item_1', 'item_2', 'item_3', 'item_4', 'item_5', 'item_neutral'];

// 把 item_0~5 + item_neutral 数字 id 转成 { name, img, dname }
function buildItems(p, itemMap) {
  const items = [];
  const map = itemMap || {};
  ITEM_SLOTS.forEach((slot) => {
    const id = p[slot];
    if (id == null || id === 0) return; // 空槽位
    const it = map[id];
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
}

// 从比赛 objectives 提取关键事件标记（肉山/推塔），映射到经济差曲线采样下标。
// 经济差曲线每 5 分钟(300s)采样一次，故 index = floor(time / 300)。
function buildEvents(m, goldLen) {
  if (!goldLen) return [];
  const objs = (m && m.objectives) || [];
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

/**
 * 选手数组构建（含 MVP 综合分）。
 * @param {object} m 比赛原始数据
 * @param {object} opts { heroMap, internalMap, itemMap }
 *   映射来源优先级由调用方决定：globalData（app 预热 / 本页填充）→ heroes 内存表 → 空（降级文字）
 */
function buildPlayers(m, opts) {
  const o = opts || {};
  const heroMap = o.heroMap || {};
  const internalMap = o.internalMap || {};
  const itemMap = o.itemMap || {};
  const radiant = [];
  const dire = [];
  let mvp = null;
  let mvpScore = -1;

  ((m && m.players) || []).forEach((p) => {
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
      items: buildItems(p, itemMap), // 出装栏
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
  return { radiant: radiant, dire: dire, mvp: mvp };
}

/**
 * 经济/经验差曲线 + 图表数据。
 * OpenDota 字段：radiant_gold_advantage_timeline / radiant_xp_advantage_timeline（每分钟一个值）。
 * 采样降密度（默认每 5 分钟取一个）避免 setData 过大。
 */
function buildAdvSeries(m, sampleEvery) {
  const every = sampleEvery || 5;
  const goldFull = (m && (m.radiant_gold_advantage_timeline || m.radiant_gold_adv)) || [];
  const xpFull = (m && (m.radiant_xp_advantage_timeline || m.radiant_xp_adv)) || [];
  const goldAdv = [];
  const xpAdv = [];
  for (let i = 0; i < goldFull.length; i += every) {
    goldAdv.push(Math.round(goldFull[i]));
  }
  for (let i = 0; i < xpFull.length; i += every) {
    xpAdv.push(Math.round(xpFull[i]));
  }
  const goldFinal = goldFull.length ? Math.round(goldFull[goldFull.length - 1]) : 0;
  const chartSeries = [
    { name: '经济差', color: '#C8A951', data: goldAdv },
    { name: '经验差', color: '#3FB950', data: xpAdv }
  ];
  const chartCats = goldAdv.map((_, i) => (i * every) + 'm');
  const chartEvents = buildEvents(m, goldAdv.length);
  return {
    goldAdv: goldAdv,
    xpAdv: xpAdv,
    goldFinal: goldFinal,
    chartSeries: chartSeries,
    chartCats: chartCats,
    chartEvents: chartEvents
  };
}

module.exports = {
  HERO_IMG_BASE: HERO_IMG_BASE,
  ITEM_CDN_ORIGIN: ITEM_CDN_ORIGIN,
  buildItems: buildItems,
  buildEvents: buildEvents,
  buildPlayers: buildPlayers,
  buildAdvSeries: buildAdvSeries
};
