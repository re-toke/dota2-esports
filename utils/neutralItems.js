// utils/neutralItems.js
// 中立物品（Neutral Items）权威数据集：数据源自 dota2.com.cn 官方 itemscategory/json 的 result.neutral（线上 Tab2 实际渲染源）。
// 以内部名(name)为键，值含：id(官方 item_id) / nameZh(官方中文) / tier(1-5) / tierName(第N级)。
// 层级 tier 取自 result.neutral 的分类下标（第1级=1 ... 第5级=5），与官网最新 Tab2 完全一致。
// 注意：OpenDota /constants/items 已包含中立物品（同 id），故 utils/items.js 直接「合并」而非「追加」，避免重复条目与 id 冲突。
// 由 _gen_items.js 从官方 JSON 生成。

const NEUTRAL_ITEMS = {
  "ash_legion_shield": {"id":"1717","nameZh":"余烬军团战盾","tier":1,"tierName":"第1级"},
  "chipped_vest": {"id":"565","nameZh":"碎裂背心","tier":1,"tierName":"第1级"},
  "conjurers_catalyst": {"id":"1864","nameZh":"咒术师触媒","tier":4,"tierName":"第4级"},
  "crippling_crossbow": {"id":"1601","nameZh":"致残之弩","tier":2,"tierName":"第2级"},
  "dagger_of_ristul": {"id":"1077","nameZh":"瑞斯图尔尖匕","tier":1,"tierName":"第1级"},
  "defiant_shell": {"id":"950","nameZh":"不羁甲壳","tier":2,"tierName":"第2级"},
  "demonicon": {"id":"370","nameZh":"冥灵书","tier":5,"tierName":"第5级"},
  "desolator_2": {"id":"292","nameZh":"寂灭","tier":5,"tierName":"第5级"},
  "dezun_bloodrite": {"id":"1642","nameZh":"德尊血式","tier":5,"tierName":"第5级"},
  "divine_regalia": {"id":"1644","nameZh":"天赐华冠","tier":5,"tierName":"第5级"},
  "dormant_curio": {"id":"1638","nameZh":"休眠珍品","tier":1,"tierName":"第1级"},
  "duelist_gloves": {"id":"2097","nameZh":"决斗家手套","tier":1,"tierName":"第1级"},
  "enchanters_bauble": {"id":"1862","nameZh":"附魔师之椟","tier":4,"tierName":"第4级"},
  "essence_ring": {"id":"359","nameZh":"精华指环","tier":2,"tierName":"第2级"},
  "fallen_sky": {"id":"371","nameZh":"天崩","tier":5,"tierName":"第5级"},
  "flayers_bota": {"id":"1721","nameZh":"剥皮血囊","tier":4,"tierName":"第4级"},
  "foragers_kit": {"id":"1868","nameZh":"采菌套具","tier":1,"tierName":"第1级"},
  "giant_maul": {"id":"1643","nameZh":"巨人之槌","tier":4,"tierName":"第4级"},
  "gunpowder_gauntlets": {"id":"1603","nameZh":"火药手套","tier":3,"tierName":"第3级"},
  "harmonizer": {"id":"1863","nameZh":"协和","tier":5,"tierName":"第5级"},
  "heavy_blade": {"id":"837","nameZh":"行巫之祸","tier":5,"tierName":"第5级"},
  "idol_of_screeauk": {"id":"1720","nameZh":"丝奎奥克神像","tier":4,"tierName":"第4级"},
  "jidi_pollen_bag": {"id":"1640","nameZh":"基迪花粉袋","tier":3,"tierName":"第3级"},
  "kobold_cup": {"id":"1637","nameZh":"狗头人酒杯","tier":1,"tierName":"第1级"},
  "mana_draught": {"id":"1599","nameZh":"魔力药水","tier":2,"tierName":"第2级"},
  "metamorphic_mandible": {"id":"1719","nameZh":"变态上颚","tier":4,"tierName":"第4级"},
  "minotaur_horn": {"id":"377","nameZh":"恶牛角","tier":5,"tierName":"第5级"},
  "occult_bracelet": {"id":"947","nameZh":"玄奥手镯","tier":1,"tierName":"第1级"},
  "partisans_brand": {"id":"1873","nameZh":"天游烙印","tier":3,"tierName":"第3级"},
  "pogo_stick": {"id":"840","nameZh":"杂技玩具","tier":2,"tierName":"第2级"},
  "polliwog_charm": {"id":"1606","nameZh":"蝌蚪护符","tier":1,"tierName":"第1级"},
  "poor_mans_shield": {"id":"71","nameZh":"穷鬼盾","tier":2,"tierName":"第2级"},
  "possessed_mask": {"id":"577","nameZh":"附魂面具","tier":1,"tierName":"第1级"},
  "prophets_pendulum": {"id":"1860","nameZh":"先知灵摆","tier":4,"tierName":"第4级"},
  "psychic_headband": {"id":"675","nameZh":"通灵头带","tier":3,"tierName":"第3级"},
  "rattlecage": {"id":"1168","nameZh":"回响之笼","tier":4,"tierName":"第4级"},
  "riftshadow_prism": {"id":"1718","nameZh":"影墟棱晶","tier":5,"tierName":"第5级"},
  "searing_signet": {"id":"1604","nameZh":"炽热纹章","tier":2,"tierName":"第2级"},
  "seeds_of_serenity": {"id":"945","nameZh":"宁静种籽","tier":2,"tierName":"第2级"},
  "serrated_shiv": {"id":"1605","nameZh":"锯齿短刀","tier":3,"tierName":"第3级"},
  "spellslinger": {"id":"1859","nameZh":"咏咒之坠","tier":3,"tierName":"第3级"},
  "spider_legs": {"id":"326","nameZh":"网虫腿","tier":5,"tierName":"第5级"},
  "stonefeather_satchel": {"id":"1861","nameZh":"石羽小包","tier":1,"tierName":"第1级"},
  "stormcrafter": {"id":"585","nameZh":"风暴宝器","tier":3,"tierName":"第3级"},
  "unrelenting_eye": {"id":"1598","nameZh":"不屈之眼","tier":3,"tierName":"第3级"},
  "weighted_dice": {"id":"1716","nameZh":"加重骰子","tier":1,"tierName":"第1级"}
};

module.exports = NEUTRAL_ITEMS;
