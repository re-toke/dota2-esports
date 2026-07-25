// utils/heroes.js
// 英雄数据库封装：合并 OpenDota /heroes（基础属性/定位）与 /heroStats（职业登场/胜/禁），
// 并计算职业胜率与相对登场率；详情页再补 /heroes/{id}/matchups（最佳/最差对位）。
// 不依赖后端，全部走 api.js 既有缓存/限流/云代理回退。英雄头像改用属性色 + 首字母占位，
// 不拉远程图（避免新增 CDN 域名白名单）。

const api = require('./api.js');

// 内存缓存（跨页面复用，避免重复拉取）
let _heroes = null;   // 合并后的英雄数组
let _byId = null;     // id -> hero
let _nameMap = null;  // id -> localizedName（matchups 解析用）

// 主属性中文与配色（与 V1 品牌一致）
const ATTR_META = {
  str: { label: '力量', color: '#e0533d' },
  agi: { label: '敏捷', color: '#5fd35f' },
  int: { label: '智力', color: '#4aa3ff' },
  uni: { label: '全能', color: '#C8A951' }
};

function attrMeta(a) { return ATTR_META[a] || ATTR_META.uni; }

function merge(heroes, stats) {
  const statMap = {};
  (stats || []).forEach((s) => { if (s && s.id != null) statMap[s.id] = s; });
  let totalPicks = 0;
  (stats || []).forEach((s) => { totalPicks += (s && s.pro_pick) || 0; });

  return (heroes || []).map((h) => {
    const st = statMap[h.id] || {};
    const proPick = st.pro_pick || 0;
    const proWin = st.pro_win || 0;
    const proBan = st.pro_ban || 0;
    const winRate = proPick ? Math.round((proWin / proPick) * 1000) / 10 : 0;
    const pickRate = totalPicks ? Math.round((proPick / totalPicks) * 1000) / 10 : 0;
    const name = h.localized_name || h.name || ('英雄#' + h.id);
    return {
      id: h.id,
      name: h.name,
      localizedName: name,
      initial: name.charAt(0),
      primaryAttr: h.primary_attr || 'uni',
      attrLabel: attrMeta(h.primary_attr || 'uni').label,
      attrColor: attrMeta(h.primary_attr || 'uni').color,
      attackType: h.attack_type || '',
      attackLabel: h.attack_type === 'Melee' ? '近战' : (h.attack_type === 'Ranged' ? '远程' : ''),
      roles: h.roles || [],
      legs: h.legs,
      baseStr: h.base_str, baseAgi: h.base_agi, baseInt: h.base_int,
      strGain: h.str_gain, agiGain: h.agi_gain, intGain: h.int_gain,
      baseHealth: h.base_health, baseMana: h.base_mana, baseArmor: h.base_armor,
      attackMin: h.base_attack_min, attackMax: h.base_attack_max,
      attackRange: h.attack_range, moveSpeed: h.base_movement,
      proPick: proPick, proWin: proWin, proBan: proBan,
      winRate: winRate, pickRate: pickRate
    };
  });
}

function loadAll() {
  if (_heroes) return Promise.resolve(_heroes);
  return Promise.all([api.getHeroes(), api.getHeroStats()])
    .then((res) => {
      _heroes = merge(res[0], res[1]);
      _byId = {}; _nameMap = {};
      _heroes.forEach((h) => { _byId[h.id] = h; _nameMap[h.id] = h.localizedName; });
      return _heroes;
    })
    .catch((e) => { _heroes = null; throw e; });
}

function getHeroes() { return loadAll(); }
function getHero(id) { return loadAll().then(() => _byId[id] || null); }
function nameOf(id) { return (_nameMap && _nameMap[id]) || ''; }

// 最佳 / 最差对位：按同场胜率排序，过滤样本过少（<20 场）的对局以降低噪声。
function getMatchups(id) {
  return loadAll()
    .then(() => api.getHeroMatchups(id))
    .then((list) => {
      const withNames = (list || [])
        .filter((m) => m && m.games_played >= 20)
        .map((m) => ({
          heroId: m.hero_id,
          name: nameOf(m.hero_id) || ('英雄#' + m.hero_id),
          games: m.games_played,
          winRate: Math.round((m.wins / m.games_played) * 1000) / 10
        }));
      const sorted = withNames.slice().sort((a, b) => b.winRate - a.winRate);
      // best：胜率最高（压制力）；worst：胜率最低（被压制）。各取 6 个。
      return {
        best: sorted.slice(0, 6),
        worst: sorted.slice(-6).reverse()
      };
    });
}

module.exports = { getHeroes, getHero, getMatchups, nameOf, attrMeta };
