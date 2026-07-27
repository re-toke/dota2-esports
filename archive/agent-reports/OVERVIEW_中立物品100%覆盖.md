# 中立物品中文名 & 层级 100% 覆盖校正（Request C）

## 目标
以 dota2.com.cn 官方 Tab2 最新数据为准，校正所有中立物品的中文名称与层级，确保 100% 覆盖。

## 关键修正（修复此前回归）
1. **生成器嵌套 bug**：旧 `_gen_items.js` 把 `cat.basic/upgrade/neutral` 当作物件数组遍历，实际它们是「分类对象数组 `[{name, items:[...]}]`」，导致写出空 `itemZh.js`（回归）与 5 条垃圾 `neutralItems.js`。已重写为下钻 `.items[]`。
2. **权威源确认**：读取线上 `items_new.js` 渲染脚本，确认 Tab2 实际只读 `itemscategory/json` 的 `result.neutral`；`neutralitems/json`(`level_1..5`) 已被**注释废弃**（无中文），不可作为权威源。
3. **架构冲突修复**：OpenDota `/constants/items` 的 501 项**已包含**全部中立物品（同 id 体系）。旧 `regular.concat(neutral)` 会产生 46 条重复 + id 冲突。改为**合并**：`utils/items.js` 遍历 OpenDota 全量，逐项补中文、对中立项标 `category:'neutral'`+tier。

## 交付物
- `utils/itemZh.js`（重生成）：**229 条**官方中文，覆盖 100% 商店物品（basic+upgrade+neutral）。
- `utils/neutralItems.js`（重生成）：**46 条**权威中立数据，内部名→`{id, nameZh, tier, tierName}`，层级取自 `result.neutral` 分类下标（第1级=1…第5级=5）。**中文缺失 0，层级分布 {1:12,2:8,3:8,4:8,5:10}**。
- `utils/items.js`：合并架构，无重复、无 id 冲突。
- `subpackages/data/item-detail/item-detail.js`：注释修正（中立 id 已是 OpenDota 数字串，无 `n_` 前缀）。
- 保留再生成套件（根目录）：`_gen_items.js` + `_d2_itemscategory_json.json` + `_od_keys.txt`。

## 验证结果（wx mock 跑真实 utils/items.js）
- 列表 501 条、唯一 id 501（无重复/无碰撞）；中立 46 条，tier 全 1–5、中文缺失 0。
- 抽样：`foragers_kit` → 采菌套具 / T1；`blink` → 闪烁匕首。
- `getItem(中立数字id)` 命中正确。`node --check` 全通过。

## 覆盖率结论
- **中立物品：100%（46/46 官方中文 + 正确层级）✅** —— 满足明确要求。
- 商店物品：100%（229/229 官方中文）。
- OpenDota 501 全量：229 有官方中文；其余 272 为非商店类（recipe/courier/cheese/stout_shield 等），dota2.com.cn 未收录 → 英文回退（预期，非数据缺失）。

## 仍需用户/环境动作
- **必须**：小程序后台将 `cdn.cloudflare.steamstatic.com` 加入 **downloadFile 合法域名**（图标显示用，未配则回退文字占位，功能不受影响）。
- 下次版本更新：重拉 `itemscategory/json` 覆盖 `_d2_itemscategory_json.json`，跑 `node _gen_items.js` 即刷新中立名称/层级。
