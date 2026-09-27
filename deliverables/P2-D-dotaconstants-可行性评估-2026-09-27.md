# P2-D `dotaconstants` 常量层 · 可行性评估（2026-09-27）

> 方案 §9.3 原文：「`P2-D` `dotaconstants` 常量层」（**无任何理由与验收标准**）
> 结论：**不做**。四条独立理由，见 §2~§5。

---

## 1. 实测事实（npm registry 元数据，非估计）

`dotaconstants@10.8.0`：

| 字段 | 值 |
|---|---|
| `dist.unpackedSize` | **5,984,448 字节 ≈ 5.7 MB** |
| `dist.fileCount` | **43** |
| `type` | **`module`（纯 ESM）** |
| `exports` | `./index.js` |

可用数据集（`build/` 目录 24 个文件）：

```
abilities · ability_ids · aghs_desc · ancients · chat_wheel · cluster · countries
game_mode · hero_abilities · hero_lore · heroes · item_colors · item_ids · items
lobby_type · neutral_abilities · order_types · patch · patchnotes
permanent_buffs · player_colors · region · skillshots · xp_level
```

---

## 2. 理由一：体积与小程序硬上限冲突

小程序**主包上限 2MB**（总包 20MB 含子包）。`dotaconstants` 单个包就 **5.7MB**。

- 放主包：**直接超限**，不可行。
- 放分包：吃掉 20MB 总额度的 **~29%**，且其中**绝大多数数据集本项目根本不用**（§5）。

⇒「完整引入」这个选项**不存在**。唯一可行形态是「按需抽取子集 + 生成脚本 + 守卫」——
那是在为一份 **~23KB 的现有数据层**（§4）新增一套构建机制，**成本远大于收益**。

---

## 3. 理由二：纯 ESM，与小程序 CommonJS 不兼容

`"type": "module"` + `exports: "./index.js"` ⇒ 该包**只能 `import`**。
小程序侧用的是 `require()`（本项目全部数据文件均为 CommonJS）。
⇒ 直接 `require('dotaconstants')` 会失败；必须经构建转换（`miniprogram_npm` 构建）或自行抽 JSON。

---

## 4. 理由三：它**没有中文名** ⇒ 替代不了项目最需要维护的那张表

`build/` 文件清单里**不存在任何本地化/中文名字文件**（无 `hero_names.json`、无 `localized_names.json`）。

而项目里最需要维护的正是中文映射：

| 现有文件 | 体积 | 性质 | dotaconstants 能替代吗 |
|---|---|---|---|
| `utils/itemZh.js` | **8,196 B / 229 条** | 官方 `dota2.com.cn` 中文名（`_gen_items.js` 生成） | ❌ **无中文名，不能替代** |
| `utils/neutralItems.js` | 4,826 B | 中立物品本地策展 | ⭕ 部分（但需重做中文） |
| `utils/heroes.js` | 10,040 B | **网络封装**（OpenDota `/heroes` + `/heroStats`），非本地表 | ❌ 不是同一件事 |
| `subpackages/data/items.js` | 9,177 B | **网络封装**（OpenDota `/constants/items`） | ❌ 同上 |

⇒ 引入 `dotaconstants` **无法减少任何现有维护负担**（中文表仍是人工/脚本维护），
只是新增一份 5.7MB 的英文常量。

---

## 5. 理由四：**没有真实缺口**（逐条核实，非推断）

| dotaconstants 独有数据集 | 项目是否在用 | 核实方式 |
|---|---|---|
| `game_mode.json` / `lobby_type.json` | ❌ 未展示任何"模式"字段 | grep `全英雄选择 / 游戏模式 / 对局模式 / 比赛模式` → **0 命中** |
| `region.json` / `countries.json` | ❌ 未按地区展示（curation 的 `region` 是人工录入的字符串） | grep `region` → 仅命中 curation 数据与注释 |
| `patch.json` / `patchnotes.json` | ❌ 未展示版本号/更新日志 | 未发现相关 UI |
| `abilities.json` / `hero_abilities.json` | ❌ 未展示技能 | `hero-detail` 仅 `require utils/heroes.js` |
| `heroes.json` / `items.json` | ⭕ 已有等价来源（OpenDota + 缓存 + 本地中文名） | §4 |

⇒ 项目**没有一处**因缺少 `dotaconstants` 而功能受损或显示错误。
按项目纪律「提『建议做 X』之前先确认前提」——**该前提不成立**。

---

## 6. 结论

### ❌ 不做

1. **5.7MB vs 主包 2MB** ⇒ 完整引入不可行；
2. **纯 ESM** ⇒ 小程序不能直接 `require`；
3. **无中文名** ⇒ 替代不了 `itemZh.js`（最需维护的表），维护负担不降；
4. **无真实缺口**（已逐条 grep 核实）⇒ 没有要解决的问题。

### 🔁 若将来确实需要（触发条件与最小落点）
**触发条件**：出现**具体**的、可复现的缺失，例如"iOS 冷启动无网时英雄名显示为占位符"被用户投诉。
**此时的最小落点不是引入 `dotaconstants`**，而是：
- 只用 `heroes.json` 抽取 **`(id, localized_name)` 两列** → 约 3~5KB 本地表；
- 中文名仍需另配（或沿用现有 OpenDota `localized_name`）；
- 明确它解决的是「**离线可用性**」，**不是**"准确度"（准确度仍取决于 curation/OpenDota）。

> ⚠️ 不要为了"少一次网络请求"引入它：英雄/物品列表**本就有缓存**，
> 请求成本是一次性的，而 5.7MB 的体积成本是**每个用户永久承担**的。

---

## 7. 诚实边界

- 体积/ESM 事实取自 **npm registry 官方元数据**（`dotaconstants@10.8.0`），非估算。
- 数据集清单取自**上游仓库 `build/` 目录**（GitHub API），非本地解包核对。
- 未实测"抽取子集后的真实体积"（未下载该包）——但 §6 的结论**不依赖**该数值：
  即使子集只有 10KB，理由三（无中文名）与理由四（无缺口）依然成立。
