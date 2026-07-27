// utils/heroes.js
// 英雄数据库封装：合并 OpenDota /heroes（基础属性/定位）与 /heroStats（职业登场/胜/禁），
// 并计算职业胜率与相对登场率；详情页再补 /heroes/{id}/matchups（最佳/最差对位）。
// 不依赖后端，全部走 api.js 既有缓存/限流/云代理回退。英雄头像使用 Steam 官方 CDN 肖像图
// （由 OpenDota 内部名拼接，与英雄身份一一对应）；未加载到内部名时降级为首字母占位。
// 注意：真实设备需在小程序后台「downloadFile 合法域名」加入 cdn.cloudflare.steamstatic.com。

const api = require('./api.js');

// 内存缓存（跨页面复用，避免重复拉取）
let _heroes = null;   // 合并后的英雄数组
let _byId = null;     // id -> hero
let _nameMap = null;  // id -> localizedName（matchups 解析用）
let _internalNameMap = null;  // id -> 内部名（antimage/luna，拼 Steam CDN 头像 URL 用）

// 主属性中文与配色（与 V1 品牌一致）
const ATTR_META = {
  str: { label: '力量', color: '#e0533d' },
  agi: { label: '敏捷', color: '#5fd35f' },
  int: { label: '智力', color: '#4aa3ff' },
  uni: { label: '全能', color: '#C8A951' }
};

function attrMeta(a) { return ATTR_META[a] || ATTR_META.uni; }

// OpenDota /heroes 的 name 带引擎前缀（如 npc_dota_hero_antimage），而 Steam CDN 路径
// 不需要此前缀（antimage_full.png 才存在，npc_dota_hero_antimage_full.png 会 404）。
// 拼头像/内部名前必须剥离此前缀。
const NPC_HERO_PREFIX = 'npc_dota_hero_';
function stripNpcPrefix(n) {
  if (!n) return '';
  return n.indexOf(NPC_HERO_PREFIX) === 0 ? n.slice(NPC_HERO_PREFIX.length) : n;
}

// 英雄中文展示名：Valve 官方简体中文客户端名，按内部名（剥离 npc_dota_hero_ 前缀）索引。
// 仅用于展示 localizedName；内部名(name)与头像(avatar)均不受影响。
// 注：lone_druid / kez / largo 暂未收录（与 Ursa 中文名存在歧义 / 为最新英雄，待客户端核对），
// 缺失时回退英文 localized_name，不会显示错误中文。
const CN_HERO_NAMES = {
  antimage: '敌法师',
  axe: '斧王',
  bane: '祸乱之源',
  bloodseeker: '血魔',
  crystal_maiden: '水晶室女',
  drow_ranger: '卓尔游侠',
  earthshaker: '撼地者',
  juggernaut: '主宰',
  mirana: '米拉娜',
  morphling: '变体精灵',
  nevermore: '影魔',
  phantom_lancer: '幻影长矛手',
  puck: '帕克',
  pudge: '帕吉',
  razor: '剃刀',
  sand_king: '沙王',
  storm_spirit: '风暴之灵',
  sven: '斯温',
  tiny: '小小',
  vengefulspirit: '复仇之魂',
  windrunner: '风行者',
  zuus: '宙斯',
  kunkka: '昆卡',
  lina: '莉娜',
  lion: '莱恩',
  shadow_shaman: '暗影萨满',
  slardar: '斯拉达',
  tidehunter: '潮汐猎人',
  witch_doctor: '巫医',
  lich: '巫妖',
  riki: '力丸',
  enigma: '谜团',
  tinker: '修补匠',
  sniper: '狙击手',
  necrolyte: '瘟疫法师',
  warlock: '术士',
  beastmaster: '兽王',
  queenofpain: '痛苦女王',
  venomancer: '剧毒',
  faceless_void: '虚空假面',
  skeleton_king: '噬魂大帝',
  death_prophet: '死亡先知',
  phantom_assassin: '幻影刺客',
  pugna: '帕格纳',
  templar_assassin: '圣堂刺客',
  viper: '冥界亚龙',
  luna: '露娜',
  dragon_knight: '龙骑士',
  dazzle: '戴泽',
  rattletrap: '发条技师',
  leshrac: '拉席克',
  furion: '先知',
  life_stealer: '噬魂鬼',
  dark_seer: '黑暗贤者',
  clinkz: '克林克兹',
  omniknight: '全能骑士',
  enchantress: '魅惑魔女',
  huskar: '哈斯卡',
  night_stalker: '暗夜魔王',
  broodmother: '育母蜘蛛',
  bounty_hunter: '赏金猎人',
  weaver: '编织者',
  jakiro: '杰奇洛',
  batrider: '蝙蝠骑士',
  chen: '陈',
  spectre: '幽鬼',
  ancient_apparition: '远古冰魄',
  doom_bringer: '末日使者',
  ursa: '熊战士',
  spirit_breaker: '裂魂人',
  gyrocopter: '矮人直升机',
  alchemist: '炼金术士',
  invoker: '祈求者',
  silencer: '沉默术士',
  obsidian_destroyer: '殁境神蚀者',
  lycan: '狼人',
  brewmaster: '酒仙',
  shadow_demon: '暗影恶魔',
  chaos_knight: '混沌骑士',
  meepo: '米波',
  treant: '树精卫士',
  ogre_magi: '食人魔法师',
  undying: '不朽尸王',
  rubick: '拉比克',
  disruptor: '干扰者',
  nyx_assassin: '司夜刺客',
  naga_siren: '娜迦海妖',
  keeper_of_the_light: '光之守卫',
  wisp: '艾欧',
  visage: '维萨吉',
  slark: '斯拉克',
  medusa: '美杜莎',
  troll_warlord: '巨魔战将',
  centaur: '半人马战行者',
  magnataur: '马格纳斯',
  shredder: '伐木机',
  bristleback: '钢背兽',
  tusk: '巨牙海民',
  skywrath_mage: '天怒法师',
  abaddon: '亚巴顿',
  elder_titan: '上古巨神',
  legion_commander: '军团指挥官',
  techies: '工程师',
  ember_spirit: '灰烬之灵',
  earth_spirit: '大地之灵',
  abyssal_underlord: '邪影主宰',
  terrorblade: '恐怖利刃',
  phoenix: '凤凰',
  oracle: '神谕者',
  winter_wyvern: '寒冬飞龙',
  arc_warden: '弧光守卫者',
  monkey_king: '齐天大圣',
  dark_willow: '邪影芳灵',
  pangolier: '石鳞剑士',
  grimstroke: '天涯墨客',
  hoodwink: '森海飞霞',
  void_spirit: '虚无之灵',
  snapfire: '电炎绝手',
  mars: '玛尔斯',
  ringmaster: '戏法师',
  dawnbreaker: '破晓辰星',
  marci: '玛西',
  primal_beast: '原始巨兽',
  muerta: '死亡女神',
  kez: '凯',
  largo: '朗戈'
};

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
    const enName = h.localized_name || h.name || ('英雄#' + h.id);
    // 展示名优先用 Valve 官方简体中文名（CN_HERO_NAMES，按内部名索引）；缺省回退英文。
    const localizedName = CN_HERO_NAMES[stripNpcPrefix(h.name)] || enName;
    // Steam 官方 CDN 肖像图：由 OpenDota 内部名（剥离 npc_dota_hero_ 前缀，如 antimage / shadow_shaman）
    // 拼接，与英雄身份严格一一对应，保证头像正确性。
    const internalName = stripNpcPrefix(h.name);
    const avatar = internalName
      ? 'https://cdn.cloudflare.steamstatic.com/apps/dota2/images/heroes/' + internalName + '_full.png'
      : '';
    // OpenDota 用 'all' 表示「全能 / Universal」主属性（7.33 起），与本项目筛选 chip 约定的 'uni' 不一致；
    // 不归一会导致「全能」筛选 chip（key='uni'）永远匹配不到这些英雄。统一映射为 'uni'。
    const pAttr = (h.primary_attr || 'uni') === 'all' ? 'uni' : (h.primary_attr || 'uni');
    return {
      id: h.id,
      name: h.name,
      localizedName: localizedName,
      initial: localizedName.charAt(0),
      avatar: avatar,
      primaryAttr: pAttr,
      attrLabel: attrMeta(pAttr).label,
      attrColor: attrMeta(pAttr).color,
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
      _byId = {}; _nameMap = {}; _internalNameMap = {};
      _heroes.forEach((h) => { _byId[h.id] = h; _nameMap[h.id] = h.localizedName; _internalNameMap[h.id] = stripNpcPrefix(h.name); });
      return _heroes;
    })
    .catch((e) => { _heroes = null; throw e; });
}

function getHeroes() { return loadAll(); }
function getHero(id) { return loadAll().then(() => _byId[id] || null); }
function nameOf(id) { return (_nameMap && _nameMap[id]) || ''; }
// id -> 英雄内部名（如 antimage/luna/shadow_shaman），用于拼 Steam CDN 头像 URL。
// 英雄库未加载完成时返回空对象，调用方应据此降级（显示文字缩写而非头像）。
function internalNameMap() { return _internalNameMap || {}; }

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

module.exports = { getHeroes, getHero, getMatchups, nameOf, internalNameMap, attrMeta };
