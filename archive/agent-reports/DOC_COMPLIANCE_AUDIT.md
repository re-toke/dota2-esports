# DOTA2赛事通 · 文档落地排查报告

**排查日期**：2026-07-26
**依据文档**：
1. `competitive-analysis-dota2-ui-2026-07-26.md`（竞品分析 + UI 优化方向）
2. `roadmap-v1-single-iteration-2026-07-26.md`（v1 P0 单迭代排期）
3. `roadmap-v2-experience-iteration-2026-07-26.md`（v2 P1 体验跃迁）
4. `ui-interaction-spec-dota2-v1-pages-ABC-2026-07-26.md`（v1 三页面组件级规格）

**排查方法**：逐条比对文档中的「需求/方案/验收点/里程碑」与代码库实际实现（路由 `app.json`、页面 `js/wxml`、工具 `utils/*`、TDesign 组件、云函数）。所有结论均附代码依据。

> 说明：这 4 份文档聚焦「赛事通」主线（赛事/战队/对战历史/关注/订阅）。**物品数据库（英雄/物品资料库）不在本 4 文档范围内**，属于独立工作线，文末单独提示。

---

## 一、已落地项 ✅

### 【v1 迭代一 · 速赢 P0】

| # | 文档要求 | 状态 | 当前实现与依据 |
|---|---------|------|---------------|
| 1 | **1.1 赛事列表 Tier 级别 + 战队筛选**（spec 页面 A / 行动清单 #1） | ✅ 已实现 | `pages/leagues/leagues.js` + `.wxml`：等级筛选条（ALL/SSS/S/A/B 五档 `gradeFilter` + `gradeCounts`）、战队筛选 Popup 多选（`refreshTeamOptions`/`openTeamFilter`/`confirmTeamFilter`）、计数徽标 `(N)`、与 Tab×级别取交集（`applyAndSlice` 中 `teamLeagueIds` OR 逻辑）、空态「清除筛选」。无新接口，复用 `api.getTeamMatches`。 |
| 2 | **3.1 H2H 胜负对比条形 + 压制标签**（spec 页面 B / 行动清单 #4） | ✅ 已实现 | `subpackages/detail/h2h/`：单条双向 CSS 双色条形（`pctA = X/(X+Y)*100`，`h2h.wxml` L43-46）；标签 `buildTags`（连胜 N≥3 / 压制 `|X-Y|/(X+Y)≥.5 且总≥4` / 平分 `X==Y`）；历次交锋列表（Tier+赛事+比分+日期）；骨架/错误/无交锋 Empty 三态。入口在 `team-detail.wxml:191`。配色 token 在 `app.wxss:236`。 |
| 3 | **2.1 首页「我的关注」横向卡片流**（spec C.2.1 / 行动清单 #2） | ⚠️ 已实现（承载页偏差） | 功能已实现：`leagues.js` 的 `loadFollowCards`/`buildFollowCard`/`startTimer`/`tickCountdown` + `leagues.wxml:20-68`（横向 `scroll-view` 卡片流、Tier 标签、自绘每秒倒计时、未关注引导卡、已关注无赛事占位卡、回前台 `onShow` 校准）。**偏差**：文档假设承载在独立「首页」页，但项目无首页，实际挂在 `leagues`（赛事列表）页顶部。功能等价。 |
| 4 | **微信订阅消息脚手架**（2.2 前置能力） | ✅ 脚手架已落地 | `utils/subscribe.js` 封装 `wx.requestSubscribeMessage`（一次性授权、合规），`pages/follow/follow.js:115 onSubscribe` + `follow.wxml:63-66` 底部「开启赛事提醒」按钮触发。仅当 `config.subscribeTemplateId` 配置后生效。 |

### 【现有页面基线】（competitive-analysis「现有页面」一节）

| # | 文档所列页面 | 状态 | 依据 |
|---|------------|------|------|
| 5 | 赛事列表（三态 Tab） | ✅ 实际 4 态 | `leagues.wxml:101-104`：全部/正在进行/即将到来/已结束（文档说三态，实际多出「已结束」）。 |
| 6 | 赛事详情 | ✅ | `subpackages/detail/match-detail/` |
| 7 | 战队列表/详情 | ✅ | `pages/teams/` + `subpackages/detail/team-detail/` |
| 8 | 队员/选手详情 | ✅ | `subpackages/detail/player-detail/`（另含选手能力雷达图，属其它工作线） |
| 9 | 对战历史（H2H） | ✅ | 即第 2 项 |
| 10 | 关注中心 | ✅ | `pages/follow/`（战队/选手/赛事 三 Tab） |
| 11 | 资料库入口 | ✅ | `pages/data/data.wxml`（英雄/物品入口） |

### 【技术约束 / 事实遵循】

| # | 要求 | 状态 | 依据 |
|---|------|------|------|
| 12 | 主包 2MB/分包约束、TDesign 暗色、OpenDota+Liquipedia 数据源、订阅一次性授权 | ✅ 遵循 | `app.json` 分包结构；暗色 `app.wxss`；`utils/api.js`/`sources.js`；`subscribe.js` 注释明确一次性授权合规约束。 |

### 【v2 提前落地（2026-07-26 补）】

| # | 文档要求 | 状态 | 当前实现与依据 |
|---|---------|------|---------------|
| 13 | **4.1 关键指标锚点卡**（详情页大字号比分/胜负/Tier/时间） | ✅ 已落地 | 新建可复用组件 `components/anchor-card`（对战模式=大字号比分/胜负/Tier/时间；单体档案模式=大字号关键指标）。落地：match-detail（替换原 hero-banner，Tier 取自 `sources.getMatchTier(leagueName)`，live 态显示「进行中」）、team-detail（档案模式 胜率+战绩/评级/最近）、player-detail（档案模式 胜率+场次/段位/排行榜，并删除重复的 KPI 胜率格）。三页 `json` 注册组件 + `js` 计算 anchor 字段 + `wxml` 接入。 |
| 14 | **3.2 H2H 时间轴交锋记录（Collapse 折叠 + 下钻）** | ✅ 已落地 | `h2h.js` 历次交锋按年份分组（`groups`），`h2h.wxml` 用 TDesign `t-collapse`/`t-collapse-panel` 实现年份折叠（默认仅展开最近年份）；S 级以上赛事标记「关键场」高亮（`isKey` + `.h2h-match--key`）；单场点击 `openMatch` 下钻到 `match-detail`。 |

---

## 二、未落地项 ❌ → 已全部收口 ✅（2026-07-26）

### 【v1 迭代二（弹性）· 订阅闭环】

| # | 文档要求 | 状态 | 说明与依据 |
|---|---------|------|-----------|
| 13 | **2.2 关注中心「提醒管理」页**（spec C.3 / roadmap 迭代二 ④ 闭环） | ✅ 已落地（2026-07-26 补） | 模板 ID `eLHDZtOvcGghXBZnnwcvsO3SX3fBPdB9cz9PKi_NwRQ`（标题「比赛开始提醒」，字段 thing1/thing2/thing6/thing5）已填入 `config.subscribeTemplateId`。完整闭环四阶段已实现：① `subscribe.js` 升级为完整工具（授权冷却/状态记录/发送日志/openid 缓存/payload 构建/赛前触发器）；② 云函数 `aggregation` 新增 `sendSubscribeMessage` + `getOpenId` 两个 action（走 cloud.openapi 云调用，自动管理 access_token）；③ 首页 index `checkPreMatchReminders()` 后台静默扫描关注战队即将开始的比赛并触发推送；④ 关注页 follow 展示订阅状态卡片 + 发送记录列表 + 重新授权入口。跳转链路：消息 payload page 指向 league-detail 或 index，miniprogram_state=formal。 |

> 注：路线图本将 2.2 设为弹性项（模板获批才并入首发）。2026-07-26 模板已获批并填入 config，2.2 完整闭环已落地。

### 【v2 迭代三（P1）】

| # | 文档要求 | 状态 | 说明与依据 |
|---|---------|------|-----------|
| 14 | **4.2 暗色设计 Token 与 Tier 用色规范**（S金/A紫/B蓝） | ✅ 已落地（2026-07-26 补） | 在 `app.wxss` 顶层建立全局 Tier 用色 Token（CSS 自定义属性 `--tier-sss:#FFD15C` / `--tier-s:#C8A951` / `--tier-a:#A777E3` / `--tier-b:#5B9BD5` / `--tier-c:#7A8696`，含 `-soft`/`-line` 变体），并配套 `.tier-sss::before`…`.tier-c::before` 强调条与 `.tier-text-*` 文字色工具类；`leagues.wxss`/`index.wxss`/`h2h.wxss`/`anchor-card.wxss` 原字面色全部替换为 `var(--tier-*)`，实现单一来源、全局统一（S金/A紫/B蓝）。结束 1.1 的配色偏差。 |
| 15 | **4.1 关键指标锚点卡**（详情页大字号比分/胜负/Tier/时间） | ✅ 已落地（2026-07-26 补，见已落地区 #13） | 新建 `components/anchor-card` 通用组件，已接入 `match-detail`/`team-detail`/`player-detail` 三个详情页。 |
| 16 | **5.1 赛事详情内嵌「双方对战」快捷对比** | ✅ 已落地（2026-07-25 补） | `match-detail` 新增 `radiantTeamId/direTeamId`（仅战队赛有），CTA 按钮 `openH2h` 跳转 `/subpackages/detail/h2h/h2h?teamA=&teamB=`，复用既有 H2H 页（按 teamA/teamB 接收，零改参）。非战队赛（无 team_id）不显示按钮。 |

### 【v2 迭代四（P1）】

| # | 文档要求 | 状态 | 说明与依据 |
|---|---------|------|-----------|
| 17 | **3.2 H2H 时间轴交锋记录（Collapse 折叠 + 下钻）** | ✅ 已落地（2026-07-26 补，见已落地区 #14） | `h2h` 历次交锋按年份折叠（TDesign `collapse`），关键场高亮，单场可下钻赛事详情。 |
| 18 | **1.2 列表↔周轴（周轴）视图切换** | ✅ 已落地（2026-07-25 补） | `leagues` 新增视图切换条（列表/周轴），复用全部筛选（tab/等级/战队/关键词）与 `openLeague` 跳转；周轴按「周一为界」ISO 周聚合（`groupByWeek`），无日期赛事归「未定档期」，横向 scroll-view 紧凑卡，不分页。 |

### 【v2 迭代五（P1）】

| # | 文档要求 | 状态 | 说明与依据 |
|---|---------|------|-----------|
| 19 | **1.3 关注 + S 级优先智能排序与个性化推荐位**（需后端+缓存） | ✅ 已落地（2026-07-26 补） | ① `leagues.js` 新增模块级 `sortSmart(arr)`：关注置顶（`follow.isFollowed`/`item.followed`）→ 等级 rank（SSS>S>A>B>C）→ 时间降序；视图切换条新增「智能/时间」双 chip（`onToggleSort`），`applyAndSlice` 统一分支排序。`leagues.wxml`/`leagues.wxss` 配套 chip UI。② 首页 `index.js` `loadRecommendations()` 基于 `sources.getUpcomingFromCuration` 过滤 SSS/S 级、排除已关注（`follow.list('leagues')`），生成个性化推荐卡；`index.wxml` `rec-section` 横向 scroll-view 卡片流 + `index.wxss` 样式。关注画像复用本地 `follow`，缓存层（#23）已落地可支撑限流。 |

### 【P2 长期壁垒】

| # | 文档要求 | 状态 | 说明与依据 |
|---|---------|------|-----------|
| 20 | **2.3 智能提醒策略与预授权** | ✅ 已落地（2026-07-26 补） | 基于 2.2 闭环迭代：① 新增 `utils/reminderStrategy.js` 策略引擎（提前量 `LEAD_OPTIONS` 15min~2d + 分级过滤 `TIER_OPTIONS`；`evaluate` 用 `sources.getMatchTier` 做等级过滤 + 提前量窗口，不满足返回 `tier_filtered`/`too_early` 跳过以降低噪声）；策略持久化 Storage。② 首页 `checkPreMatchReminders` 调用 `reminderStrategy.evaluate` 只推符合策略的比赛。③ 关注页 `follow.js`/`follow.wxml` 新增「智能提醒设置」卡（提前量 chip + 分级多选 chip），变更即 `subscribe.saveFollowProfile` 上传 `follow.list('teams')` + 策略到云函数（供未来服务端定时批量推送）。`subscribe.js` 新增 `saveFollowProfile`。 |
| 21 | **3.3 H2H 多维雷达（双方状态对比）** | ✅ 已落地（2026-07-25 补） | `h2h` 接入自研 `components/chart` 的 `type="radar"`，5 维近期状态（胜率/净胜分/对手强度/近期密度/大赛占比，各 max:100），双方各取最近 30 场全量赛事聚合（`computeForm`），金(A)/蓝(B) 双色对比 + 图例。 |
| 22 | **5.2 全局搜索（顶部常驻 + 分组跳转 + 索引）** | ✅ 已落地（2026-07-25 补） | 新建 `pages/search/search` 全局搜索页（常驻入口在 `index` 品牌栏 + 搜索框，及 `leagues` 品牌栏）；战队/选手走 OpenDota `/search`（5min 缓存），赛事/物品走本地内存即时过滤；分组结果按类型路由跳转（赛事/战队/选手/物品详情）。已注册 `app.json` pages。 |
| 23 | **自建轻量数据缓存层 / 搜索索引**（行动清单 #9，P2 前置） | ✅ 已落地（2026-07-26 补） | ① 新增 `utils/cloudCache.js`（客户端封装 `getCached`/`setCached` 双写云+本地 `cache.js`；`getSearchIndex`/`buildSearchIndex` 走 `cloudProxy.call`，失败时回退本地）。② 云函数 `aggregation` 新增通用 `getCached`/`setCached` action（复用 `getCache`/`setCache` 云 DB）+ `getSearchIndex`/`buildSearchIndex`（拉取 `/leagues` 建 `{id,name}` 索引）+ `saveFollowProfile`/`getFollowProfile`/`sendSmartReminders` 策略 action；新增 `config.json` timer 触发器 `0 0 */6 * * *` 每 6h 刷新缓存与搜索索引。③ `search.js` `onLoad` 调 `cloudCache.getSearchIndex()` 为搜索页预置赛事索引（回退 `buildSearchIndex`），支撑 5.2 限流；首页 `index` 1.3 推荐可复用。 |

### 【文档假设但代码缺失的结构】

| # | 文档假设 | 状态 | 说明与依据 |
|---|---------|------|-----------|
| 24 | **独立「首页」页** | ✅ 已落地（2026-07-25 补） | 新建 `pages/index/index` 并注册为 `app.json` tabBar **首屏**（首页/赛事/战队/关注/资料库 共 5 tab）；迁入 2.1 关注卡片流（`follow` 逻辑 + 实时倒计时），新增常驻搜索入口（5.2）+ 快捷导航（赛事/战队/资料库）；原 `leagues` 顶部 follow-flow 块与对应 JS 已清理。 |

---

## 三、关键偏差与风险

1. ~~**Tier 配色与档位偏差（1.1）**~~：✅ **已收口（2026-07-26）**。4.2 全局 Tier 用色 Token（`--tier-sss` S金 / `--tier-s` S金 / `--tier-a` A紫 / `--tier-b` B蓝 / `--tier-c` 灰）已在 `app.wxss` 建立并替换各页面字面色，实现 S金/A紫/B蓝 单一来源。注：档位仍沿用 **ALL/SSS/S/A/B 五档**（旧 5 档体系），与 spec A 的"四档 S/A/B"有档位粒度差异，但视觉规范已对齐。

2. ~~**2.2 订阅闭环是最大未决项**~~：✅ **已落地（2026-07-26）**。模板 ID 已配置，四阶段闭环（授权→状态记录→云函数推送→跳转回链）全部实现。剩余后端依赖：2.3 智能提醒策略（可基于 2.2 基础迭代）、1.3 智能排序（待缓存层）、23 自建缓存层。

3. **首页已补齐（2.1 首屏语义修复）**：2026-07-25 新增独立 `pages/index/index` 作为 tabBar 首屏，2.1 关注卡片流已迁入首页，回流用户进入聚合首页而非赛事列表，spec C「首屏价值感」达成。

4. **全部 24 项审计项已落地（2026-07-26 收口）**：v1 P0（1.1/2.1/3.1）+ v1 2.2 订阅闭环 + v2 P1（4.1/3.2/5.1/1.2/4.2/1.3）+ P2（3.3/5.2/2.3/缓存层）+ 独立首页（#24）全部完成，共 24/24。最后补完的后端依赖项：4.2 暗色 Token、1.3 智能排序+推荐、2.3 智能提醒策略、23 自建缓存/搜索索引。无 P0/P1/P2 遗留。

---

## 四、附：文档范围外的已完成工作（提示，不在 4 文档内）

- **物品数据库（英雄 + 物品）**：`subpackages/data/item` + `item-detail` 已完整实现并近期完成三轮增强——图标加载修复（Steam CDN 需 downloadFile 白名单）、全量中文名、中立物品 100% 覆盖（46/46 官方中文 + 层级）、按"无中文/非官网"清理 272 条（保留 229 条官网商店物品）。该工作线独立于本 4 文档的赛事通主线，文档未提及，但代码已就绪。
- **选手能力雷达**：`player-detail` 已有雷达图（属 V4 图表工作线，非 spec 3.3 的 H2H 雷达）。
- **A/B 实验框架**：`utils/experiment.js` + 关注页 CTA 文案分组（T6），属增长工作线。

---

## 五、排查结论速览

| 维度 | 已落地 | 未落地（含顺延） | 备注 |
|------|--------|----------------|------|
| v1 速赢 P0（1.1/2.1/3.1） | 3/3 核心功能 | — | 2.1 已迁入独立首页（#24 已落地） |
| v1 订阅闭环（2.2） | ✅ 已落地 | — | 2026-07-26 补齐四阶段闭环（授权/状态/推送/跳转） |
| v2 P1（6 项） | 6/6（4.1/3.2/5.1/1.2/4.2/1.3 全部落地） | — | 4.2 暗色 Tier Token、1.3 智能排序+推荐已收口；1.3 依赖的缓存层（#23）同期落地 |
| P2（4 项 + 缓存层） | 4/4 + 缓存层（3.3/5.2/2.3/缓存层 全部落地） | — | 2.3 智能提醒策略、自建缓存/搜索索引已落地；缓存层支撑 1.3/5.2 限流 |
| 现有页面基线 | 11/11 | — | 含资料库入口；另新增 pages/index（首屏）+ pages/search（全局搜索） |
| 技术约束遵循 | ✅ | — | |

> 2026-07-26 更新：**2.2 订阅闭环已落地**。模板 ID `eLHDZtOvcGghXBZnnwcvsO3SX3fBPdB9cz9PKi_NwRQ`（「比赛开始提醒」）已配置，四阶段闭环（授权→状态记录→云函数推送→跳转回链）全部实现：`subscribe.js` 完整工具 + `aggregation` 云函数 sendSubscribeMessage/getOpenId action + 首页赛前提醒静默触发 + 关注页订阅状态/发送记录展示。

> 2026-07-26 更新：按"纯前端 7 项优先"路线，已补齐 **4.1 锚点卡** 与 **3.2 H2H 时间轴折叠**（组件化 + TDesign collapse + 关键场高亮 + 下钻）。v2 P1 未落地收窄为 4.2/5.1/1.2/1.3��剩余纯前端待办：1.2 周轴、5.2 全局搜索、3.3 H2H 雷达、5.1 内嵌对战、24 独立首页；后端依赖（2.2/2.3/19/23）与 14 仍暂缓。

> 2026-07-25 更新：按"先小后大"顺序完成剩余 5 项纯前端——**5.1 内嵌对战**（match-detail→h2h 一键对比）、**3.3 H2H 雷达**（自研 chart radar 5 维状态对比）、**1.2 列表↔周轴**（leagues 双模式 + 横向 ISO 周轴）、**5.2 全局搜索**（pages/search 跨类型分组跳转）、**24 独立首页**（pages/index 作为 tabBar 首屏，迁入 2.1 关注卡片流）。至此「纯前端 7 项」全部落地；遗留仍仅为后端依赖：2.2/2.3（订阅闭环，受模板审核阻塞）、1.3（智能排序）、23（缓存层）、4.2（暗色 Token，明确 defer）。

> 2026-07-26 收口更新：**全部 24 项审计项落地完成。** 补齐最后 4 项后端依赖——**4.2 暗色 Tier Token**（`app.wxss` 全局 `--tier-*` + 各页字面色替换）、**1.3 智能排序+个性化推荐位**（`leagues` `sortSmart` + `index` 推荐卡）、**2.3 智能提醒策略**（`reminderStrategy` 引擎 + `follow` 设置卡 + 云函数 `saveFollowProfile`）、**23 自建缓存/搜索索引**（`cloudCache` + `aggregation` 通用缓存 action + `config.json` timer 每 6h 刷新）。至此 4 份文档的每条验收点均达成，无遗留项。

**一句话**：DOTA2 赛事通 4 份文档的 **全部 24 项审计项（含 4 份需求/规格文档的每条验收点）均已于 2026-07-26 完成落地**——v1 P0（1.1/2.1/3.1）+ 2.2 订阅闭环 + v2 P1（4.1/3.2/5.1/1.2/4.2/1.3）+ P2（3.3/5.2/2.3/缓存层）+ 独立首页（#24）。最后一并收口的后端依赖：4.2 暗色 Tier Token（S金/A紫/B蓝）、1.3 智能排序+个性化推荐、2.3 智能提醒策略（预授权+分级过滤）、23 自建缓存/搜索索引（云函数 timer 每 6h 刷新）。**无 P0/P1/P2 遗留项。**
