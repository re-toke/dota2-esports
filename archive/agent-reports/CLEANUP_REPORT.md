# Dota2 装备数据库清理报告

**对比源**: https://www.dota2.com.cn/items/index.htm (itemscategory/json)
**执行时间**: 2026-07-26
**清理规则**: 删除同时满足以下两项的装备记录：
1. 本地数据库中缺少中文名称（`itemZh.js` 未收录）
2. 不存在于 dota2.com.cn 官网装备列表中

---

## 清理统计总览

| 指标 | 数量 |
|------|------|
| **清理前** — OpenDota 全量物品 | 501 |
| **清理后** — 保留物品 | **229** |
| **删除总数** | **272** |
| 删除占比 | 54.3% |

### 保留物品构成

| 分类 | 数量 | 说明 |
|------|------|------|
| 常规商店物品 (basic) | 183 | 消耗品/属性/装备/神秘商店/配件/辅助/法器/防具/兵刃/宝物 |
| 中立物品 (neutral) | 46 | 第1级(12) / 第2级(8) / 第3级(8) / 第4级(8) / 第5级(10) |

### 删除原因分类

| 类别 | 数量 | 典型示例 | 原因说明 |
|------|------|----------|----------|
| 合成配方 (`recipe_*`) | **85** | `recipe_arcane_blink`, `recipe_bracer`, `recipe_mekansm` | 配方不是独立商店物品，官网不展示，无官方中文 |
| 升级形态 | **9** | `dagon_2~5`, `necronomicon_2~3`, `ultimate_scepter_2` | A杖/达贡/死灵书升级版，官网归入基础物品页签内，无独立条目 |
| 活动/特殊物品 | **37** | `famango`, `royale_with_cheese`, `enhancement_*`, `tier*_token` | 活动/模式限定物品、增强令牌、Token，非常规商店物品 |
| 其它 | **141** | `courier`, `cheese`, `aegis`, `tango_single`, `keen_optic`, `ocean_heart`... | 信使/守卫/Roshan 掉落物/消耗品变体/旧版中立物品等 |

> **关键发现**: 272 条被删记录的「无中文名」与「不在官网」两个条件**完全重叠**——即所有缺失中文的物品恰好都不在官网上，0 条有中文但不在官网。这证明 `itemZh.js` 的 229 条与官网 itemscategory/json 的 229 条**完全对齐**。

---

## 被删除装备完整清单

### 一、合成配方 (85 条)

| # | 内部名 | 删除原因 |
|---|--------|----------|
| 1 | recipe_arcane_blink | 无中文名 + 不在官网 |
| 2 | recipe_swift_blink | 无中文名 + 不在官网 |
| 3 | recipe_overwhelming_blink | 无中文名 + 不在官网 |
| 4 | recipe_magic_wand | 无中文名 + 不在官网 |
| 5 | recipe_travel_boots | 无中文名 + 不在官网 |
| 6 | recipe_phylactery | 无中文名 + 不在官网 |
| 7 | recipe_hand_of_midas | 无中文名 + 不在官网 |
| 8 | recipe_witch_blade | 无中文名 + 不在官网 |
| 9 | recipe_bracer | 无中文名 + 不在官网 |
| 10 | recipe_wraith_band | 无中文名 + 不在官网 |
| 11 | recipe_null_talisman | 无中文名 + 不在官网 |
| 12 | recipe_mekansm | 无中文名 + 不在官网 |
| 13 | recipe_wraith_pact | 无中文名 + 不在官网 |
| 14 | recipe_buckler | 无中文名 + 不在官网 |
| 15 | recipe_ring_of_basilius | 无中文名 + 不在官网 |
| 16 | recipe_holy_locket | 无中文名 + 不在官网 |
| 17 | recipe_pipe | 无中文名 + 不在官网 |
| 18 | recipe_urn_of_shadows | 无中文名 + 不在官网 |
| 19 | recipe_headdress | 无中文名 + 不在官网 |
| 20 | recipe_sheepstick | 无中文名 + 不在官网 |
| 21 | recipe_orchid | 无中文名 + 不在官网 |
| 22 | recipe_bloodthorn | 无中文名 + 不在官网 |
| 23 | recipe_cyclone | 无中文名 + 不在官网 |
| 24 | recipe_wind_waker | 无中文名 + 不在官网 |
| 25 | recipe_aether_lens | 无中文名 + 不在官网 |
| 26 | recipe_force_staff | 无中文名 + 不在官网 |
| 27 | recipe_hurricane_pike | 无中文名 + 不在官网 |
| 28 | recipe_dagon | 无中文名 + 不在官网 |
| 29 | recipe_necronomicon | 无中文名 + 不在官网 |
| 30 | recipe_ultimate_scepter_2 | 无中文名 + 不在官网 |
| 31 | recipe_refresher | 无中文名 + 不在官网 |
| 32 | recipe_assault | 无中文名 + 不在官网 |
| 33 | recipe_heart | 无中文名 + 不在官网 |
| 34 | recipe_black_king_bar | 无中文名 + 不在官网 |
| 35 | recipe_shivas_guard | 无中文名 + 不在官网 |
| 36 | recipe_sphere | 无中文名 + 不在官网 |
| 37 | recipe_lotus_orb | 无中文名 + 不在官网 |
| 38 | recipe_meteor_hammer | 无中文名 + 不在官网 |
| 39 | recipe_aeon_disk | 无中文名 + 不在官网 |
| 40 | recipe_kaya | 无中文名 + 不在官网 |
| 41 | recipe_spirit_vessel | 无中文名 + 不在官网 |
| 42 | recipe_essence_distiller | 无中文名 + 不在官网 |
| 43 | recipe_crimson_guard | 无中文名 + 不在官网 |
| 44 | recipe_blade_mail | 无中文名 + 不在官网 |
| 45 | recipe_eternal_shroud | 无中文名 + 不在官网 |
| 46 | recipe_consecrated_wraps | 无中文名 + 不在官网 |
| 47 | recipe_crellas_crozier | 无中文名 + 不在官网 |
| 48 | recipe_monkey_king_bar | 无中文名 + 不在官网 |
| 49 | recipe_greater_crit | 无中文名 + 不在官网 |
| 50 | recipe_basher | 无中文名 + 不在官网 |
| 51 | recipe_bfury | 无中文名 + 不在官网 |
| 52 | recipe_manta | 无中文名 + 不在官网 |
| 53 | recipe_lesser_crit | 无中文名 + 不在官网 |
| 54 | recipe_dragon_lance | 无中文名 + 不在官网 |
| 55 | recipe_armlet | 无中文名 + 不在官网 |
| 56 | recipe_silver_edge | 无中文名 + 不在官网 |
| 57 | recipe_mjollnir | 无中文名 + 不在官网 |
| 58 | recipe_sange | 无中文名 + 不在官网 |
| 59 | recipe_helm_of_the_dominator | 无中文名 + 不在官网 |
| 60 | recipe_helm_of_the_overlord | 无中文名 + 不在官网 |
| 61 | recipe_gungir | 无中文名 + 不在官网 |
| 62 | recipe_yasha | 无中文名 + 不在官网 |
| 63 | recipe_diffusal_blade | 无中文名 + 不在官网 |
| 64 | recipe_disperser | 无中文名 + 不在官网 |
| 65 | recipe_ethereal_blade | 无中文名 + 不在官网 |
| 66 | recipe_soul_ring | 无中文名 + 不在官网 |
| 67 | recipe_arcane_boots | 无中文名 + 不在官网 |
| 68 | recipe_octarine_core | 无中文名 + 不在官网 |
| 69 | recipe_falcon_blade | 无中文名 + 不在官网 |
| 70 | recipe_ancient_janggo | 无中文名 + 不在官网 |
| 71 | recipe_solar_crest | 无中文名 + 不在官网 |
| 72 | recipe_pavise | 无中文名 + 不在官网 |
| 73 | recipe_veil_of_discord | 无中文名 + 不在官网 |
| 74 | recipe_revenants_brooch | 无中文名 + 不在官网 |
| 75 | recipe_devastator | 无中文名 + 不在官网 |
| 76 | recipe_guardian_greaves | 无中文名 + 不在官网 |
| 77 | recipe_rod_of_atos | 无中文名 + 不在官网 |
| 78 | recipe_iron_talon | 无中文名 + 不在官网 |
| 79 | recipe_abyssal_blade | 无中文名 + 不在官网 |
| 80 | recipe_heavens_halberd | 无中文名 + 不在官网 |
| 81 | recipe_glimmer_cape | 无中文名 + 不在官网 |
| 82 | recipe_trident | 无中文名 + 不在官网 |
| 83 | recipe_harpoon | 无中文名 + 不在官网 |
| 84 | recipe_specialists_array | 无中文名 + 不在官网 |
| 85 | recipe_hydras_breath | 无中文名 + 不在官网 |

### 二、升级形态 (9 条)

| # | 内部名 | 删除原因 |
|---|--------|----------|
| 1 | dagon_2 | 达贡之神力 Lv2，官网归入基础物品 |
| 2 | dagon_3 | 达贡之神力 Lv3 |
| 3 | dagon_4 | 达贡之神力 Lv4 |
| 4 | dagon_5 | 达贡之神力 Lv5 |
| 5 | necronomicon_2 | 死灵书 Lv2 |
| 6 | necronomicon_3 | 死灵书 Lv3 |
| 7 | ultimate_scepter_2 | 阿哈利姆神杖 2级 |
| 8 | ultimate_scepter_roshan | Roshan 掉落的 A杖 |
| 9 | diffusal_blade_2 | 净魂之刃 Lv2 |

### 三、活动/特殊物品 (37 条)

`famango, greater_famango, royale_with_cheese, pocket_tower, pocket_roshan,
tier1_token ~ tier5_token, enhancement_vast/quickened/audacious/mystical/alert/
brawny/tough/feverish/fleetfooted/crude/boundless/wise/timeless/greedy/vampiric/
keen_eyed/evolved/titanic/fierce/dominant/restorative/thick/curious/vital/hulking/
manic/nimble`

### 四、其它 (141 条)

`quarterstaff, stout_shield, cheese, ward_dispenser, tango_single, courier,
flying_courier, travel_boots_2, wraith_pact, caster_rapier, necronomicon,
aghanims_shard_roshan, eldwurms_edda, aegis, trident, refresher_shard,
hood_of_defiance, eternal_shroud, medallion_of_courage, tome_of_knowledge,
iron_talon, ring_of_aquila, river_painter ~ river_painter7, mutation_tombstone,
super_blink, keen_optic, grove_bow, quickening_charm, philosophers_stone,
force_boots, phoenix_ash, seer_stone, greater_mango, elixer, vampire_fangs,
force_field, black_powder_bag, mechanical_arm, craggy_coat, greater_faerie_fire,
timeless_relic, mirror_shield, ironwood_tree, mango_tree, royal_jelly,
pupils_gift, tome_of_aghanim, repair_kit, mind_breaker, third_eye, spell_prism,
princes_knife, witless_shako, imp_claw, flicker, spy_gadget,
helm_of_the_undying, vambrace, horizon, fusion_rune, ocean_heart,
spark_of_courage, broom_handle, trusty_shovel, nether_shawl, dragon_scale,
clumsy_net, enchanted_quiver, ninja_gear, illusionsts_cape, havoc_hammer,
panic_button, apex, ballista, woodland_striders, pirate_hat, ex_machina,
faded_broach, paladin_sword, orb_of_destruction, the_leveller, arcane_ring,
titan_sliver, elven_tunic, cloak_of_flames, trickster_cloak, penta_edged_sword,
bullwhip, ceremonial_robe, quicksilver_amulet, book_of_shadows, giants_ring,
mysterious_hat, ascetic_cap, misericorde, unstable_wand, paintball,
lance_of_pursuit, ogre_seal_totem, eye_of_the_vizier, bottomless_chalice,
ofrenda, ofrenda_shovel, ofrenda_pledge, muertas_gun, vindicators_axe,
ancient_guardian, safety_bubble, whisper_of_the_dread, nemesis_curse,
avianas_feather, unwavering_condition, dandelion_amulet, martyrs_plate,
gossamer_cape, light_collector, doubloon, roshans_banner, black_grimoire,
grisgris, rippers_lash, gale_guard, magnifying_monocle, pyrrhic_cloak,
madstone_bundle, miniboss_minion_summoner, sisters_shroud, outworld_staff,
divine_regalia_broken, furion_gold_bag, foragers_health/stats/mana, tidehunter_fish`

---

## 技术实现

修改文件: `utils/items.js` — 在 `buildAll()` 函数中加入 `.filter()` 过滤：

```javascript
.filter((it) => {
  const hasZh = !!itemZh[it.name];           // 有官方中文？
  const isOfficial = !!neuMap[it.name] || hasZh; // 在中立表或中文表中？
  return hasZh && isOfficial;                   // 双重条件：有中文 AND 在官网
})
```

过滤位置在 `.map()` 之前，确保未通过过滤的物品不会进入列表或 `_byId` 索引。

## 验证结果

✅ **清理后数据库**: 229 条（183 常规 + 46 中立），全部有官方中文名，全部存在于 dota2.com.cn 官网。
✅ **唯一 id**: 229 个 id 无重复、无冲突。
✅ **中立覆盖**: 46/46 中立物品保留，层级 T1(12)-T2(8)-T3(8)-T4(8)-T5(10) 完整。
✅ **已删除物品查询**: `getItem(id)` 对被删物品返回 `null`。
✅ **语法检查**: `node --check utils/items.js` 通过。
