# DOTA2 赛事收录对比分析与优化方案

> 基准文档：`DOTA2赛事级别分类全景.md`（2026-07-24）
> 项目：`dota2-esports`（微信小程序 · 原生 + TDesign + OpenDota / STRATZ / Liquipedia / Steam）
> 目标：以文档的分类体系为准绳，逐项比对小程序当前的赛事收录现状，找出差距并提出可落地的优化方案。

---

## 一、文档收录标准、分类体系与覆盖范围梳理

### 1.1 影响力金字塔（总览）

文档把 DOTA2 赛事按"受关注度 / 影响力"排成 10 级金字塔：

```
TI（国际邀请赛）
  └─ Riyadh Masters / 电竞世界杯 EWC（顶级第三方，奖金顶格）
       └─ DPC Major（官方顶级积分赛，2023 已取消）
            └─ 顶级第三方 S-Tier 巡回赛（ESL One / DreamLeague / PGL / BLAST / FISSURE / BetBoom）
                 └─ DPC Minor（乙级，2020 已取消）
                      └─ DPC 区域联赛 S 级（Division I，2023 已取消）
                           └─ A-Tier 第三方赛事
                                └─ DPC 区域联赛 A 级（Division II，2023 已取消）
                                     └─ B-Tier / Tier 2–3 区域联赛与次级国际赛
                                          └─ Tier 3–4 / C-D 级：社区赛、公开预选、青训
```

**一句话结论（对小程序最关键）**：Valve 亲自下场的只有 **TI**（2024 起 DPC 取消后 TI 成为唯一官方赛事），其余顶级赛事全部由第三方承办。TI 直邀改为"第三方赛表现 + 战队/解说捆绑包"决定。

### 1.2 10 级明细（按文档排名）

| # | 级别 | 主办方性质 | 奖金规模 | 状态 |
| -- | ---- | ---- | ---- | ---- |
| 1 | The International（TI） | Valve 官方 | 峰值 $40.02M(TI10)；近届 $2.3M–$2.9M | 年度旗舰，持续 |
| 2 | Riyadh Masters / EWC（Dota2） | 第三方（沙特电竞联+ESL） | $15.12M(2023)/$5.05M(2024)/$3M(2025) | 年度夏季顶格 |
| 3 | DPC Major（甲级联赛） | Valve 认证 + 第三方承办 | $1M(2017-20) / $500k(2021-23) | 2023 已取消 |
| 4 | 顶级第三方 S-Tier 巡回赛 | 第三方 | 统一 $1,000,000 | 2024 起主流 |
| 5 | DPC Minor（乙级联赛） | Valve 认证 + 第三方承办 | ~$300,000 | 2020 已取消 |
| 6 | DPC 区域联赛 S 级（Division I） | Valve 官方 | 总池 $280k，S 级冠军 $30k | 2023 已取消 |
| 7 | A-Tier 第三方赛事 | 第三方 | $300k–$1M | 持续 |
| 8 | DPC 区域联赛 A 级（Division II） | Valve 官方 | 冠军 $17k | 2023 已取消 |
| 9 | B-Tier / Tier 2–3 区域联赛与次级国际赛 | 混合 | 数千–数万美元 | 持续 |
| 10 | Tier 3–4 / C-D 级：社区赛、公开预选、青训 | 社区/小主办方 | < $10,000 | 持续 |

### 1.3 Valve 官方体系时间线

| 时期 | 体系 | 顶级官方赛 | 备注 |
| ---- | ---- | ---- | ---- |
| 2011–2014 | TI + 第三方杯赛 | TI | 早期无统一巡回赛 |
| 2015–2017 | Valve「Major」特锦赛制 | TI + 5 站 Major（各 $3M） | 官方 Major 前身 |
| 2017–2020 | DPC Major/Minor | TI + Major(~$1M) + Minor(~$300k) | 积分决定 TI 直邀（前 12） |
| 2021–2023 | DPC 区域联赛 | TI + Major($500k) + 6 赛区两级联赛 | 联赛化、升降级 |
| 2024–至今 | 无 DPC（第三方主导） | 仅 TI 为官方赛事 | 第三方 S-Tier 全年铺开 |

### 1.4 第三方体系（2024 起主流）

ESL FACEIT Group（ESL One / DreamLeague / EPT，$1M）、PGL（Wallachia 马拉松，$1M）、BLAST（Slam $750k–$1M）、FISSURE（Playground / Universe，$1M+）、BetBoom（Dacha，$1M）、沙特电竞联（Riyadh/EWC，$3M–$15M）、完美世界（DPC 中国联赛/区域赛）。

### 1.5 社区分级标准（补充口径）

- **Liquipedia（4 级）**：Tier 1（全球最强齐聚）→ Tier 2 → Tier 3（声望低于 T2 但竞技水平较高）→ Tier 4（最低，无顶级队）。
- **Esportnow（S/A/B/C）**：S-Tier $1M+ / A-Tier $300k–$1M / B-Tier 区域联赛 / C-Tier 公开预选。

### 1.6 文档给小程序的落地建议（关键）

1. 赛事分级标签用 **「官方 TI / S-Tier / A-Tier / 区域赛 / 社区赛」五档**，Valve 赞助高亮。
2. 重点运营节点：**TI 预选（每年 6 月）+ TI 正赛（8–10 月）+ 夏季 Riyadh/EWC**；TI15（2026·上海）是本土流量爆发点。
3. 「双方对战胜负」「战队/队员资料」优先覆盖 **S-Tier 与 TI 参赛队**，数据接入以 OpenDota + Liquipedia 为主。

---

## 二、本项目赛事收录现状比对

### 2.1 当前分级与收录机制（项目现状）

| 组件 | 作用 | 现状 |
| ---- | ---- | ---- |
| `utils/tiers.js` | 社区规则分级（零网络兜底） | 正则匹配：`SSS > S > A > B > C`（rank 4..0）。覆盖 TI / Riyadh·EWC / Major / S-Tier 系列 / 部分 A-Tier / 部分 B-Tier |
| `utils/util.js` → `unifiedTier()` | 统一分级 | **优先 curation 库**；否则回退 OpenDota 4 档枚举：professional→S、premium→A、amateur→B、excluded→C |
| `utils/curation.js` → `CURATED_EVENTS` | 权威赛事库（交叉验证基准 + 兜底） | 收录约 **30 条**事件，覆盖 TI2022–2026、主要 S-Tier 系列、少量 A/B |
| `pages/leagues/leagues.js` | 列表过滤 | **`rank >= 1` 过滤** → 实际只展示 **SSS + S + A + B**，**C 级（社区赛/公开预选/青训）被完全排除** |
| `subpackages/detail/league-detail` | 赛事详情 | 可渲染奖金/地点/赛制/主办方等 **metadata**，来源 Liquipedia + Steam |

> ⚠️ 关键现状：Liquipedia 当前在 `config.js` 中被**禁用**（`liquipedia.enabled = false`，IP 封禁）。因此 league-detail 的 metadata 实际近乎空白，赛事信息深度主要靠 `CURATED_EVENTS` 与 OpenDota 自带字段。

### 2.2 逐档比对（文档 10 级 → 本项目覆盖）

| 文档级别 | 项目现状 | 覆盖评价 | 主要差距 |
| ---- | ---- | ---- | ---- |
| **1. TI（SSS）** | regex `the international`→SSS；curation 含 TI2022–2026 | ✅ 良好 | 缺"TI 直邀战队/预选"节点化运营数据；TI15 上海已收录 ✓ |
| **2. Riyadh Masters / EWC** | 全部归入 **S 级**（rank 3） | ⚠️ 分类偏低 | 文档称"TI 级存在"（顶级第三方，奖金顶格），项目无"顶级第三方"高亮；**EWC 2024/2025、Riyadh 2023（$15.12M 史高）缺失**，仅 EWC 2026 |
| **3. DPC Major** | regex `major(?!.*minor)`→S；OpenDota professional→S | ⚠️ 依赖 OpenDota | curation **未收录任何具体 Major**（KL/CQ/EPICENTER/DreamLeague S10-11）；**无"已取消"标记**，与现役赛事混排 |
| **4. 顶级第三方 S-Tier** | regex 命中 ESL One/DreamLeague/PGL/BLAST/FISSURE/BetBoom → S | ⚠️ 部分 + 自相矛盾 | ① curation 把 **ESL One Raleigh 2025 标为 A**，与 regex(S) 冲突；② 缺分站/新季：ESL One Bangkok、BLAST Slam III–IX、PGL Wallachia S3+、FISSURE 多站、BetBoom 其他系列 |
| **5. DPC Minor** | regex `minor`→A；OpenDota premium→A | ⚠️ 依赖 OpenDota | curation 无具体 Minor；无 defunct 标记 |
| **6. DPC 区域联赛 S 级（Div I）** | ❌ **tiers.js 无对应规则** | ❌ 分类错误 | 只能落到 OpenDota amateur→**B 级**，与文档 A 级不符；无规范名/defunct |
| **7. A-Tier 第三方** | curation：Clavision/Elite League/ESL One Raleigh/KL/PGL Astana；OpenDota premium→A | ⚠️ 稀疏 | 大量 A-Tier（CCT、Pinnacle、Youth 系列等）未收录 |
| **8. DPC 区域联赛 A 级（Div II）** | ❌ 无专门规则，OpenDota amateur→B | ⚠️ 基本合理 | 与文档 B 级大体一致，但无规范名/defunct |
| **9. B-Tier / 区域联赛 / 次级国际赛** | regex：Games of the Future/Triton/Mega Arena/World Invitational→B；OpenDota amateur→B | ⚠️ 稀疏 | curation 仅 5 条；缺主办方/赛区等规范信息 |
| **10. C-D 级 社区赛/公开预选/青训** | C 级（rank 0）存在但 **列表 `rank>=1` 完全不展示** | ❌ 不收录 | 文档视其为"人才库/黑马温床、数据分析向"；与"双方对战胜负"中青训/黑马队数据链相关 |

### 2.3 信息详细度差距

文档为每个级别提供了：**奖金规模、主办方、关注度（收视峰值）、历史、赛制、地点、状态（进行中/已取消）**。

项目 `CURATED_EVENTS` 字段仅：`canonical / tier / aliases / year / 部分 start·end`。**缺失字段**：

- `prizePool`（奖金）—— 文档核心维度，项目完全缺失
- `organizer`（主办方）—— 缺失
- `region`（赛区：CN/EU/SEA…）—— 缺失
- `format`（赛制：BO3/双败/小组赛）—— 缺失
- `participants`（参赛队数）—— 缺失
- `liquipediaSlug`（权威词条链接）—— 缺失
- `status`（active / defunct）—— **缺失，导致已取消的 DPC 赛事与现役混排**
- `viewerPeak`（关注度）—— 缺失

> 结论：`league-detail` 有 metadata 渲染位，但**数据源（Liquipedia 禁用、Steam 有限）与本地 curation 都未供给这些字段**，赛事详情页目前"只有名字 + 等级 + 日期"。

### 2.4 分类准确性问题汇总（按严重度）

1. **🔴 DPC 区域联赛 Division I 落入 B 级**：`tiers.js` 对 Division I 无规则，OpenDota 多标 amateur→B，与文档 A 级不符。Division II 同理无规则。
2. **🔴 ESL One 自相矛盾**：regex `esl one`→S，但 curation 把 `ESL One Raleigh 2025` 标 A。`unifiedTier` 优先 curation，故"同一个品牌 ESL One 一部分 S 一部分 A"，用户困惑。
3. **🟠 Riyadh/EWC 未做"顶级第三方"高亮**：文档明确其"TI 级存在"，项目仅普通 S。
4. **🟠 已取消赛事无 defunct 标记**：DPC Major/Minor/区域联赛（2020–2023）仍与现役赛事混排，易被误读为"进行中/可关注"。
5. **🟠 分级标签体系不统一**：项目内用 SSS/S/A/B/C；文档建议 5 档"官方 TI / S-Tier / A-Tier / 区域赛 / 社区赛"；社区另有 Liquipedia Tier1-4、Esportnow S/A/B/C。需要在展示层做映射与统一命名。
6. **🟡 OpenDota 4 档枚举无法表达细微差异**：TI 唯一官方、顶级第三方 vs 普通 S-Tier、Valve 赞助高亮等 nuanced 区分都做不到，必须靠 curation 补。

### 2.5 收录完整性结论（一句话）

> 项目在 **TI 与主流 S-Tier 系列**上覆盖较好，但在 **DPC 历史赛事（规范名/defunct）、A-Tier 与 B-Tier 代表赛事、Riyadh/EWC 全年代、以及 C 级社区赛**上明显稀疏；更关键的是**奖金/主办方/赛制/状态等元数据几乎全缺**，且存在 **Division I 错级、ESL One 矛盾、缺 defunct 标记**三类分类准确性硬伤。

---

## 三、优化方案

### 3.1 分级体系对齐（核心，向后兼容）

采用文档推荐的 **「五档 + 双标签」**，复用现有 `rank` 数值不变，仅调整**展示标签**与**属性标记**：

| 现有 rank | 现有 grade | 新展示档 | 属性标签 | 备注 |
| ---- | ---- | ---- | ---- | ---- |
| 4 | SSS | **官方 TI** | `valve:true` | 仅 TI |
| 3 | S | **S-Tier** | `valve:false` | 顶级第三方巡回赛 |
| 3* | S（顶第三方） | **S-Tier（顶级第三方）** | `topThirdParty:true` | Riyadh/EWC 高亮 |
| 2 | A | **A-Tier** | — | A-Tier 第三方 + DPC Minor + Div I |
| 1 | B | **区域赛** | — | B-Tier + DPC Div II |
| 0 | C | **社区赛** | — | Tier 3-4 / 公开预选 / 青训 |

实施要点：
- `utils/tiers.js` 增加 `DISPLAY_LABEL`（grade→中文档名）、`PROP_BADGES`（valve / topThirdParty）与判定规则。
- 新增 `topThirdParty` 规则：Riyadh Masters / EWC / Esports World Cup → 高亮徽章（rank 仍 3）。
- 新增 `isValveSponsored`：TI、DPC Major/Minor/区域联赛 → 官方徽章高亮。
- 在 `leagues.js` 的 `tagThemeOf()` 与 WXML 中按新档名渲染（SSS 用 danger 红金、S 用 danger、A 用 warning、B/C 用 default）。

### 3.2 修复分类准确性（P0，影响核心体验）

1. **DPC 区域联赛规则补全**：在 `tiers.js` 增加
   - `/(division\s*(i|1)|division\s*one|super\s*group)/i` → A（rank 2，对齐文档 Div I）
   - `/(division\s*(ii|2)|division\s*two|甲级组)/i` → B（rank 1，对齐文档 Div II）
2. **统一 ESL One 分类**：以 curation 为准。**把所有 ESL One 旗舰 LAN 分站显式写入 curation 并统一 grade**，避免 regex 与 curation 冲突。`unifiedTier` 已优先 curation，只要 curation 覆盖全即可消除矛盾。规则建议：ESL One $1M 级分站（Birmingham/Bangkok/Raleigh/KL 等）= S；小型 ESL 公开赛 = A。
3. **defunct 标记**：为 DPC Major/Minor/区域联赛（2020–2023）加 `defunct:true` + `activeYears`。`leagues.js` 对 defunct 赛事显示"已停办"灰徽，并默认折入"历史归档"分组（不影响现役列表）。
4. **Valve 赞助 / 顶级第三方高亮**：随 3.1 一起落地。

### 3.3 补齐 curation 权威库（P1，收录完整性）

把文档明确列出的"代表赛事"补进 `CURATED_EVENTS`（建议同时迁到远程 JSON 以支持热更新，见 3.5）：

- **S-Tier 分站补全**：ESL One Bangkok 2024、ESL One Raleigh 2024、PGL Wallachia S3+、BLAST Slam III–IX、FISSURE 各站、BetBoom 各系列。
- **Riyadh / EWC 全年代**：Riyadh Masters 2023（$15.12M）、2024、2025；EWC 2024、2025（现有仅 EWC 2026）。
- **A-Tier 代表补全**：Clavision Masters（已）、Elite League（已）、CCT、Pinnacle、各 Youth 系列等。
- **DPC 历史赛事规范名库**：Kuala Lumpur / Chongqing / EPICENTER / DreamLeague S10-11 等 Major；各 Minor；六赛区 Division I/II，均带 `defunct:true`。

### 3.4 提升信息详细度（P2，信息质量）

1. `CURATED_EVENTS` 每条增加可选字段：`prizePool`、`organizer`、`region`、`format`、`participants`、`liquipediaSlug`、`status`、`viewerPeak`。
2. `league-detail` 的 `metadata` 渲染位已存在，补充上述字段展示（奖金、主办方、赛区、赛制、参赛队、词条链接）。
3. **恢复 Liquipedia**：当前 IP 封禁。建议 (a) 经**云函数代理**（服务端带合规 UA + 服务端缓存）规避封禁；(b) 关键赛事 metadata 直接沉淀到远程 curation JSON，降低对 Liquipedia 实时依赖。
4. Steam Web API（DOTA2 League 570）补奖金/官方信息（需 key，已规划在云函数环境变量）。

### 3.5 远程 curation 热更新（P2，可持续运营）

`config.js` 已有 `remoteCuration.url`（为空时仅本地）。把权威库抽成远程 JSON，后台维护、小程序**不发版即可更新**赛事分级与 metadata，特别适合赛事频繁更替的 2024+ 第三方生态。

### 3.6 C 级（社区赛）是否展示（P3，可选）

保持主列表聚焦 SSS+S+A+B（与"关注 S 级及以上"产品定位一致），但：
- 把 `leagues.js` 过滤从 `rank >= 1` 改为 `rank >= 0`，并**新增"社区赛"筛选档（默认折叠/关）**。
- C 级默认不进"全部"主列表，用户主动开启后在筛选中可见，满足"双方对战胜负"中黑马/青训队的数据链需求。

### 3.7 运营节点（P3，配合文档建议 2）

- curation 增加 `keyNode` 标记（TI 预选 6 月 / TI 正赛 8–10 月 / 夏季 Riyadh/EWC）。
- 关注中心增加"赛事日历"，对上述节点高亮提醒；TI15（2026·上海）作为本土爆发点重点运营。

---

## 四、优先级与落地步骤

| 优先级 | 任务 | 涉及文件 | 产出 |
| ---- | ---- | ---- | ---- |
| **P0** | 修复 Division I/II tier 规则 | `utils/tiers.js` | Div I→A、Div II→B |
| **P0** | 统一 ESL One 分类（curation 全覆盖） | `utils/curation.js` | 消除 S/A 矛盾 |
| **P0** | 分级标签对齐 + Valve/顶第三方高亮 | `utils/tiers.js` + `pages/leagues/leagues.js` + WXML | 五档展示 + 双标签 |
| **P0** | defunct 标记 + 历史归档 | `utils/curation.js` + `leagues.js` | 已取消赛事不误排 |
| **P1** | 补全 S-Tier 分站 / Riyadh·EWC 全年代 / A-Tier 代表 | `utils/curation.js` | 收录完整性 |
| **P1** | 补全 DPC 历史赛事规范名库 | `utils/curation.js` | 历史数据规范 |
| **P2** | curation 增 metadata 字段 + league-detail 渲染 | `curation.js` + `league-detail` | 奖金/主办方/赛制/状态 |
| **P2** | 远程 curation 热更新 | `config.js` + 远程 JSON | 不发版更新 |
| **P2** | Liquipedia 经云函数代理恢复 | `utils/liquipedia.js` + 云函数 | metadata 实时源 |
| **P3** | C 级可选展示入口 | `leagues.js` + WXML | 社区赛/青训可见 |
| **P3** | 赛事日历 / 节点运营 | 关注中心 | TI 预选/正赛/夏季节点提醒 |

---

## 五、对照检查表（文档 10 级 → 本项目状态速查）

| 文档级别 | 项目 grade | 收录 | 分类准确 | 信息完整 | 行动 |
| ---- | ---- | ---- | ---- | ---- | ---- |
| 1 TI | SSS | ✅ | ✅ | ⚠️（缺节点运营） | 3.7 |
| 2 Riyadh/EWC | S | ⚠️（缺多年代） | 🟠（应顶第三方） | ❌ | 3.1 / 3.3 |
| 3 DPC Major | S | ⚠️（依赖OD） | ⚠️（无defunct） | ❌ | 3.2 / 3.3 |
| 4 S-Tier 巡回赛 | S | ⚠️（缺分站） | 🔴（ESL One矛盾） | ❌ | 3.2 / 3.3 |
| 5 DPC Minor | A | ⚠️（依赖OD） | ⚠️（无defunct） | ❌ | 3.2 / 3.3 |
| 6 DPC Div I | **B（错）** | ❌ | 🔴（应为A） | ❌ | 3.2 |
| 7 A-Tier 第三方 | A | ⚠️（稀疏） | ✅ | ❌ | 3.3 |
| 8 DPC Div II | B | ⚠️（依赖OD） | ✅（≈文档B） | ❌ | 3.3 |
| 9 B-Tier/区域 | B | ⚠️（稀疏） | ✅ | ❌ | 3.3 |
| 10 C-D 社区赛 | C（不展示） | ❌（不收录） | ✅ | ❌ | 3.6 |

---

## 六、总结

本项目的赛事分级骨架（SSS/S/A/B/C + OpenDota 回退 + curation 兜底）**方向正确且与文档大体同构**，在 TI 与主流 S-Tier 上可用。但对照文档的 10 级全景，存在三类必须修的硬伤：**(1) Division I 错级为 B；(2) ESL One S/A 自相矛盾；(3) 已取消 DPC 赛事无 defunct 标记**。收录上，A-Tier/B-Tier 代表赛事、Riyadh/EWC 全年代、DPC 历史规范名均稀疏；信息上，奖金/主办方/赛制/状态等 metadata 近乎全缺（且 Liquipedia 禁用）。

按"先准确性、再完整性、后信息质量"的顺序落地 P0→P2，即可让小程序赛事收录**更全面、分类更规范、信息更丰富**，并贴合文档的"官方 TI / S-Tier / A-Tier / 区域赛 / 社区赛"五档落地建议与 TI15 上海运营节点。
