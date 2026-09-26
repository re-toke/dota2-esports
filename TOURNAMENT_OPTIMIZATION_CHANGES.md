# 赛事收录优化 — 改动明细表（P0 / P1 / P2）

<!-- ARCHIVED-BANNER -->
> ⚠️ **本文档已归档**（最后更新 2026-07-25，项目此后已演进约 2 个月）。
> **请勿以本文作为现状依据。** 证据优先级：**代码 / `git log` > `deliverables/` > 本文 > 整合版**。
> 已核实的两处典型失真：
> · 文中描述的**微信云函数链路（`aggregation` / `upcoming_schedule` 预热等）已彻底退役** —— 现为 **Supabase 单后端**；
> · **「进行中 = 最近 7 天」已改为「2 小时」**（见 `utils/config.js` 的 `leagueWindow`）。
> 权威入口（均在**本仓库内**且最新）：
> · `deliverables/项目复核与优化方案-v2-2026-09-26.md`
> · `deliverables/复核意见-优化方案v2-2026-09-26.md`
> · `deliverables/P0-B-SLO口径与采集点-2026-09-26.md`
> 完整技术文档：`../DOTA2赛事通-项目技术文档-整合版.md`（工作区外 · v8.93 · 2026-09-25）

依据 `TOURNAMENT_COVERAGE_ANALYSIS.md`，仅执行 P0/P1/P2（跳过 P3）。
核心约束：**复用现有 rank 数值（4/3/2/1/0）仅改展示，功能接口不变，向后兼容，列表默认 rank>=1**。

| 文件 | 改动 | 文档章节 / 优先级 | 是否兼容 |
|---|---|---|---|
| `utils/tiers.js` | 新增 DPC Division 规则：`Upper Division/Division I/甲级组 → A(2)`，`Lower Division/Division II/乙级组 → B(1)`（修复 Division I 误判为 B 的分类 bug，带单词边界避免 II 误匹配 I） | §1 分类体系 / §2 10 档对齐 · **P0** | ✅ rank 数值不变；仅在 communityTierFromName 中新增规则，旧用例仍命中 |
| `utils/tiers.js` | 新增文档五档展示模型 `DISPLAY_TIERS` + `displayOf()` / `displayThemeOf()`：SSS→官方TI、S→S-Tier、A→A-Tier、B→区域赛、C→社区赛 | §1 五档标签 / §2 分类准确性 · **P0** | ✅ 纯新增导出，不改既有 grade/label |
| `utils/tiers.js` | 新增来源高亮推断 `flagValve()`（TI/DPC Major/Division）、`flagTopThirdParty()`（Riyadh/EWC） | §2 信息详细度 · **P0** | ✅ 纯函数，供列表/详情复用，无副作用 |
| `utils/curation.js` | 统一 ESL One 到 S 级：`ESL One Raleigh 2025`、`ESL One Kuala Lumpur 2024` 由 A 改为 S(3)，消除与 tiers 正则（esl one→S）的自相矛盾 | §2 分类准确性 · **P0** | ✅ 仅改 tier 字段，aliases 不变 |
| `utils/curation.js` | 补全 Riyadh Masters 全年代（2023/2024/2025）、EWC 全年代（2024/2025/2026 已在）标记为 `topThirdParty` | §2 收录完整性 · **P1** | ✅ 新增条目 |
| `utils/curation.js` | 补全 S-Tier 分站：ESL One Bangkok、BLAST Slam III–VII、PGL Wallachia S3–S5 | §2 收录完整性 · **P1** | ✅ 新增条目 |
| `utils/curation.js` | 补全 A-Tier 代表：CCT 2024/2025、Pinnacle 2024/2025 | §2 收录完整性 · **P1** | ✅ 新增条目 |
| `utils/curation.js` | 补全 DPC 历史规范名并标记 `defunct:true` + `valve:true`：DPC 2020-21、2021-22、2022-23、2023 Tour，及 Kuala Lumpur/Chongqing/Paris/EPICENTER Major | §2 收录完整性 · **P0** | ✅ 新增字段（defunct/valve 为增量，不影响旧字段） |
| `utils/curation.js` | 为赛事条目新增元数据字段：`prizePool / organizer / region / format / participants / status / liquipediaSlug / valve / topThirdParty` | §2 信息详细度 · **P1** | ✅ 增量字段，buildLookups/consensus 不依赖这些字段 |
| `pages/leagues/leagues.js` | `normalize()` 接入 `remoteCuration.curatedEventFor()`，附加 `displayLabel / valve / topThirdParty / defunct`；`updateGradeCounts()` 跳过 defunct；`applyAndSlice()` 将 defunct 下沉到独立 `archived` 区（不计入主列表分页/计数）；`mergeCurationUpcoming` 同步 displayLabel/valve/topThirdParty/defunct | §2 分类准确性 + defunct 归档 · **P0/P1** | ✅ 新增属性，旧 `label/rank/tierClass` 保留；archived 默认 [] |
| `pages/leagues/leagues.wxml` | 等级筛选条改为五档名（官方TI/S-Tier/A-Tier/区域赛）；赛事项徽标改用 `displayLabel`，新增 Valve官方 / 顶级第三方 / 已停办 高亮；新增「已停办赛事（归档）」分区 | §2 五档渲染 + defunct 归档 · **P0/P1** | ✅ 仅展示层变更，逻辑字段不变 |
| `pages/leagues/leagues.wxss` | 新增 `.hl-badge / .hl-valve / .hl-tp / .defunct-tag / .archive-block / .is-defunct` 样式 | 配套样式 · **P0/P1** | ✅ 纯新增 |
| `subpackages/detail/league-detail/league-detail.js` | 新增 `buildCurationFallback()`：Liquipedia/Steam 元数据缺失时，用 curation 字段兜底（region→location、unix 秒→日期、新增 participants/status/liquipediaSlug）；元数据 handler 接入兜底；新增 `openLiquipedia()` 复制链接 | §2 信息详细度（Liquipedia 禁用兜底）· **P2** | ✅ 仅补充兜底分支，不改动既有 metadata 渲染路径 |
| `subpackages/detail/league-detail/league-detail.wxml` | KPI Strip 新增「参赛队 / 状态」单元；新增 Liquipedia slug 链接行（点击复制） | §2 信息详细度 · **P2** | ✅ 用 `wx:if` 守卫，无数据时不渲染 |
| `subpackages/detail/league-detail/league-detail.wxss` | 新增 `.meta-extra / .meta-extra-link` 样式 | 配套样式 · **P2** | ✅ 纯新增 |
| `utils/config.js` | `liquipedia.enabled: true` 注释修正为「已通过云函数代理恢复」；`remoteCuration` 注释明确「已启用（本地兜底 + 填 url 即热更新）」 | §3 远程策展 / Liquipedia 云代理 · **P2** | ✅ 仅注释与语义明确，url 保持空（本地优先） |

## 验证结果（node 本地逻辑测试）
- `DPC ... Upper Division → A(2)`、`Lower Division → B(1)`、`Division I → A`、`Division II → B`、`Division III → none`（正确不误匹配）
- `ESL One Raleigh 2025 → S(3)`（统一 S 级）
- `displayOf`：官方TI / S-Tier / A-Tier / 区域赛 / 社区赛
- curation 回查：`ESL One Raleigh` 为 S 且含 prizePool；`DPC 2022-2023` defunct+valve；`Riyadh Masters 2023` topThirdParty+奖金池
- 全部改动 JS 文件 `node --check` 通过

## 兼容性结论
全部 16 项改动 **向后兼容**：`rank` 数值与排序/筛选逻辑不变；新增字段均为增量；`label/tierClass/source` 等旧字段保留；`remoteCuration.curatedEventFor` 与 `curation.curatedEventFor` 接口一致；Liquipedia 恢复走既有云代理路径，失败时优雅降级为 null。
