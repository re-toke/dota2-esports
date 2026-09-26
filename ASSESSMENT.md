# DOTA2赛事小程序 — 全面评估报告与优化方案

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

> 评估时间：2026-07-24
> 评估范围：`dota2-esports/` 全项目
> 评估维度：代码质量 / 功能完整性 / 用户体验 / 性能瓶颈 / 安全合规 / 数据来源

---

## 一、项目概览

### 规模
| 维度 | 数据 |
|---|---|
| 页面 | 7 个（leagues / league-detail / match-detail / teams / team-detail / player-detail / follow） |
| 核心模块 | 18 个 utils（3363 行）+ 1 个云函数 |
| 页面逻辑 | 1782 行 js |
| 测试脚本 | 9 个（含 e2e 验证） |
| 主包大小 | 1.3 MB（限额 2MB，余量 700KB） |
| 全局样式 | app.wxss 18KB |

### 架构亮点（已经做得很好的部分）
1. **六源数据编排**：community（本地规则）/ curation（本地+远程权威库）/ OpenDota / STRATZ / Steam / Liquipedia，任一源失败优雅降级
2. **多源共识机制**（`consensus.js`）：赛事名/分级/时间/成员走投票或中位数比对，带可信度标注
3. **SWR 缓存 + 增量游标拉取**：`cachedFreshIncremental` 按 `start_time` 游标只拉新增比赛，大幅降低流量
4. **系列赛智能聚合**（`groupSeries`）：基于胜负场数判定 BO1/BO2/BO3/BO5，比 `series_type` 字段更可靠
5. **Liquipedia 合规采集**：User-Agent + gzip + 2s 限流 + wikitext 模板解析 + 反爬虫拦截检测，符合官方 ToS
6. **字段对齐契约**：增量 SQL 字段名严格对齐直连端点，附契约测试防回归
7. **远程 curation 热更新**：不发版更新赛事/战队权威库
8. **CloudBase 云函数骨架**：代理 OpenDota 加速 + 共享缓存

---

## 二、五维评估

### 2.1 代码质量 — 评级 A-

**现状优势：**
- 模块职责清晰：`api.js`（网络+缓存）/ `sources.js`（多源编排）/ `consensus.js`（共识算法）/ `curation.js`（权威库）分层明确
- 错误隔离彻底：所有外部源调用都包 `try/catch` + `.catch(() => [])`，单源失败不阻塞
- 注释质量高：每个模块顶部有设计说明，复杂函数有「为什么这么做」的注释（如 incremental.js 的字段对齐契约、liquipedia.js 的合规要点）
- 测试覆盖较好：9 个测试脚本覆盖 consensus / incremental / liquipedia / remote-curation / search-history / series / sources 核心逻辑

**问题：**

| 问题 | 严重度 | 说明 |
|---|---|---|
| 无自定义组件目录 | P1 | 比赛卡、队名行、loading 骨架、空状态在多页面重复，未抽成 components/ |
| 无 ESLint 配置 | P1 | 无 `.eslintrc`，代码风格靠人工维持，容易回归（如 var/const 混用：liquipedia.js 用 var，其他用 const） |
| `league-detail.js` 425 行 | P2 | 最长页面，混合了加载/格式化/分页/关注/队名补全/系列赛聚合，可拆分 |
| 页面 js 无单测 | P2 | 核心 utils 有测试，但页面 fmt/slicePage 等纯函数未测 |
| `app.wxss` 18KB | P2 | 全局样式过大，部分样式应下沉到页面 wxss |
| `cloudfunctions/aggregation/index.js` 与 `sqlFragments.js` 重复 | P3 | SQL 文本在云函数和客户端各存一份，靠注释同步，易漂移 |

**改进方向：**
- 抽 `components/`：`match-card`、`team-name-row`、`loading-skeleton`、`empty-state`、`source-badge`（可信度标签）
- 加 `.eslintrc`：统一 var→const/let、强制分号、禁止未使用变量
- `league-detail.js` 拆分：把系列赛聚合/队名补全抽到 utils 或 behaviors
- 页面纯函数（fmt/slicePage）补单测

### 2.2 功能完整性 — 评级 A

**现状覆盖：**
- ✅ 赛事列表（全部/正在进行/即将到来，三 tab）
- ✅ 赛事详情（比赛列表 + 系列赛聚合 + 排名 + 选手统计）
- ✅ 战队列表（搜索 + 防抖 + 本地历史）
- ✅ 战队详情（信息 + 现役/历史成员 + 比赛历史 + 成员交叉验证）
- ✅ 选手详情（资料 + 战绩 + 常用英雄 + 胜率）
- ✅ 比赛详情（基础信息）
- ✅ 关注中心（本地关注 + 订阅消息）
- ✅ 直播比赛（Steam + STRATZ 跨源去重）

**功能缺口：**

| 缺口 | 价值 | 难度 |
|---|---|---|
| 对战历史（两队 H2H） | 高 | 中（已有数据，需聚合） |
| 选手生涯轨迹图 | 中 | 高（需可视化） |
| 赛事奖金池/赛制/地点展示 | 中 | 低（Liquipedia 已采集，未展示） |
| 战队世界排名 | 中 | 高（需引入第三方排名源） |
| 比赛详情（阵容/出装/经济曲线） | 高 | 高（需 `/matches/{id}` 详情接口） |
| 推送通知（关注赛事开赛/结果） | 高 | 中（订阅消息已接，缺触发逻辑） |
| 搜索选手（仅搜战队） | 中 | 低 |

**改进方向：**
- P0：比赛详情页补阵容/出装/经济曲线（OpenDota `/matches/{id}` 已有数据）
- P1：赛事详情页展示 Liquipedia 已采集的奖金池/地点/赛制（数据已在 `sources.getLeagueMetadata`）
- P1：两队 H2H 对战历史（按 radiant_team_id + dire_team_id 过滤已有比赛）
- P2：选手搜索（复用 teams 页搜索防抖模式）

### 2.3 用户体验 — 评级 B+

**现状优势：**
- 暗色电竞风 UI（`#0e1116` 背景 + `#5fd35f` 强调色），符合目标用户审美
- TDesign 组件库统一交互语言
- 多源可信度徽标（「较可信/可信/待核实」+ 来源标注）
- 「更新于 X 前」新鲜度提示
- 搜索防抖 + 本地历史 + 最近搜索标签
- 空状态有引导（STRATZ 未启用时提示配置步骤）
- 错误重试按钮

**问题：**

| 问题 | 严重度 | 说明 |
|---|---|---|
| 即将到来 tab 首次加载慢 | P0 | 逐个赛事串行查 STRATZ/Liquipedia 赛程，60 个赛事 × 2s 限流 = 最长 2 分钟 |
| 无加载进度条 | P2 | 仅有文字"正在查询 1/60"，无顶部进度条 |
| 无下拉刷新反馈不一致 | P2 | 部分页面下拉刷新无 loading 态 |
| 比赛详情页过于简陋 | P1 | 仅 116 行，相比赛事/战队详情信息密度低 |
| 无骨架屏统一组件 | P2 | 各页面骨架屏写法不一 |
| 字体不可调 | P3 | 无字号设置 |

**改进方向：**
- P0：即将到来 tab 改为云函数批量预热 + 客户端读缓存（首次也秒开），或并行查询（突破 2s 限流需云函数中转）
- P1：比赛详情页补全（阵容/出装/经济曲线/击杀时间线）
- P2：抽统一 `loading-skeleton` 组件 + 统一下拉刷新交互

### 2.4 性能瓶颈 — 评级 B

**现状优势：**
- SWR 缓存 + 增量游标拉取，大幅降低重复请求
- 图片懒加载已用（`lazy-load="{{true}}"`）
- 请求限流器（OpenDota 60/min、STRATZ 重试退避、Liquipedia 2s 间隔）
- 列表分页加载（`onReachBottom` + `appendPage`）

**瓶颈：**

| 瓶颈 | 影响 | 严重度 |
|---|---|---|
| `league-detail.js` 25 次 setData | 每次跨 JS-Native 桥，列表滚动可能卡顿 | P1 |
| 无虚拟列表 | 长列表（选手数千场历史）渲染全量 DOM | P1 |
| 无分包 | 主包 1.3MB，所有页面一次性加载 | P2 |
| Liquipedia 串行 2s 限流 | 即将到来首次查询最长 2 分钟 | P0 |
| 无图片尺寸优化 | 队伍 logo/选手头像原图加载 | P2 |
| `groupSeries` 在主线程聚合 | 大赛事数百场比赛聚合阻塞渲染 | P2 |

**改进方向：**
- P0：即将到来改云函数预热（见 2.3）
- P1：setData 优化——用 path 更新（`this.setData({ 'list[0].followed': true })`）+ 合并多次 setData
- P1：长列表用 `recycle-view` 或 TDesign `virtual-list`
- P2：分包——`subpackages/` 拆分详情页（league-detail/team-detail/player-detail/match-detail）
- P2：图片走 CDN 缩略图（OpenDota logo 可加 `?width=80`）

### 2.5 安全合规 — 评级 B-

**现状优势：**
- 未使用隐私 API（getUserInfo/getLocation 等），隐私合规风险低
- Liquipedia 采集严格合规（User-Agent + 限流 + 缓存 + 不抓 HTML）
- STRATZ/Steam 通过官方 API + key 访问
- 增量 SQL 数字化防注入

**问题：**

| 问题 | 严重度 | 说明 |
|---|---|---|
| `project.config.json` urlCheck: false | P0 | 开发期 OK，**上线前必须改 true** 并在小程序后台配域名白名单 |
| 无独立隐私协议文件 | P0 | 微信审核要求，即使不用隐私 API 也需 `__private__.json` 或隐私协议页 |
| apiKey 硬编码在 config.js | P1 | STRATZ/Steam key 随源码上传，反编译可获取；应改云函数中转 |
| 无域名白名单文档 | P1 | 需配置 `api.opendota.com` / `api.stratz.com` / `api.steampowered.com` / `liquipedia.net`，未文档化 |
| 无小程序后台 request 合法域名配置说明 | P1 | README 未提 |
| `appid` 在 project.config.json 明文 | P2 | 正常，但开源时需注意 |

**改进方向（上线前必做）：**
- P0：`urlCheck: true` + 小程序后台「服务器域名」配置 4 个 request 合法域名
- P0：创建隐私协议页（`pages/privacy/privacy`）并在 `app.json` 的 `__usePrivacyCheck__` 配置
- P1：apiKey 迁移到云函数环境变量，客户端不存 key，所有外部 API 调用走云函数中转
- P1：README 补「上线前检查清单」（域名白名单/隐私协议/urlCheck/key 迁移）

---

## 三、数据来源梳理与拓宽方案

### 3.1 现有数据来源全景

| 源 | 类型 | 覆盖数据 | 更新频率 | 需要 key | 启用状态 |
|---|---|---|---|---|---|
| **OpenDota** | REST API | 比赛结果/战队/选手/英雄/时间窗口 | 实时（延迟 ~1h） | 否 | ✅ 主源 |
| **STRATZ** | GraphQL | 赛事分级/赛程窗口/名册/直播/logo/头像 | 实时 | 是 | 配置后启用 |
| **Steam Web API** | REST | 直播比赛/官方奖金池/战队信息 | 实时 | 是 | 配置后启用 |
| **Liquipedia** | MediaWiki API | 赛事元数据(奖金池/地点/赛制)/名册/选手资料 | 人工维护（天级） | 否 | 配置后启用 |
| **curation（本地+远程）** | JSON | 权威赛事分级/规范名/日期/战队标签 | 远程热更新 | 否 | ✅ 启用 |
| **community tiers** | 本地规则 | 赛事分级（关键词匹配） | 随版本 | 否 | ✅ 启用 |

### 3.2 覆盖范围评估

**已覆盖（且多源交叉验证）：**
- ✅ 赛事分级（4 源共识：community/curation/OpenDota/STRATZ）
- ✅ 赛事名称（3 源投票：OpenDota/curation/STRATZ/Liquipedia）
- ✅ 赛事时间窗口（3 源：curation/STRATZ/Liquipedia）
- ✅ 战队成员（3 源交叉：OpenDota/STRATZ/Liquipedia）
- ✅ 比赛结果（OpenDota 主源）
- ✅ 直播比赛（2 源去重：Steam/STRATZ）

**覆盖不足：**
- ⚠️ 比赛详情（阵容/出装/经济曲线）——OpenDota `/matches/{id}` 已接但页面未展示
- ⚠️ 赛事奖金池——Liquipedia 已采集但页面未展示
- ⚠️ 选手生涯轨迹——Liquipedia 已采集 teamHistory 但页面未展示
- ⚠️ 战队世界排名——无源
- ⚠️ 历史 DPC 积分——无源
- ⚠️ 赛事 VOD/回放链接——无源

### 3.3 数据质量评估

| 维度 | 评估 |
|---|---|
| **准确性** | 优。多源共识 + 可信度标注，关键字段（名/级/时间）有交叉验证 |
| **完整性** | 良。OpenDota 覆盖全量比赛，但部分字段 null（如 radiant_team_name 需补全） |
| **时效性** | 良。OpenDota 延迟 ~1h，直播实时；Liquipedia 人工维护有天级延迟 |
| **一致性** | 良。字段对齐契约 + 共识归一，但 STRATZ schema 变更需持续维护 |
| **可用性** | 中。STRATZ/Steam/Liquipedia 默认关闭，用户需手动配置才能享受全量数据 |

### 3.4 更新频率不足

- **即将到来**：依赖 STRATZ/Liquipedia，首次加载慢（串行 2s 限流），且无后台定时刷新
- **直播**：仅在前端打开页面时拉取，无推送
- **比赛结果**：SWR 10min 新鲜窗口，足够
- **赛事分级**：curation 远程 6h TTL，可接受

### 3.5 数据来源拓宽方案（合规优先）

#### 方案 A：激活已有数据源（推荐，零新增合规风险）

1. **比赛详情页补全**（P0）：OpenDota `/matches/{id}` 已返回阵容/出装/经济曲线/击杀时间线，只需页面开发
2. **赛事元数据展示**（P1）：Liquipedia `getLeagueMetadata` 已采集奖金池/地点/赛制/主办方，在 league-detail 展示
3. **选手生涯轨迹**（P1）：Liquipedia `getPlayerProfile` 已有 teamHistory，在 player-detail 展示
4. **云函数预热即将到来**（P0）：CloudBase 定时触发器每 10min 拉取赛程，客户端读缓存秒开

#### 方案 B：引入新数据源（需逐一评估合规）

| 候选源 | 数据 | 合规评估 | 建议 |
|---|---|---|---|
| **DATDota** (datdota.com) | 历史赛事 Elo/排名 | 有公开 API，但无明确 ToS，需邮件确认 | 谨慎，先联系作者 |
| **Dota 2 Pro Circuit 官网** | DPC 积分/赛程 | 官方网站，无公开 API，爬取需查 robots.txt | 不建议爬取，风险高 |
| **GitHub 社区数据集** (如 dota2patches) | 英雄改动/版本 | MIT/GPL 开源，合规 | ✅ 可接 |
| **赛事方官网** (ESL/DreamHack) | 赛程/直播流 | 各自 ToS 不同，爬取成本高 | 不建议，用 Liquipedia 聚合已够 |
| **Twitch/YouTube Live** | 直播流地址 | 有官方 API，但需 OAuth | P3，价值有限 |
| **小黑盒/Max+** | 国内社区数据 | 无公开 API，爬取违反 ToS | ❌ 禁止 |

#### 方案 C：爬虫合规红线（明确禁止）

- ❌ **不得**爬取 Liquipedia HTML 页面（只走 MediaWiki action API，已合规）
- ❌ **不得**爬取 OpenDota/STRATZ 非 API 端点
- ❌ **不得**爬取小黑盒/Max+/DOTA2 MAX 等国内电竞数据站（ToS 明确禁止）
- ❌ **不得**绕过任何网站的 CAPTCHA / 反爬虫机制
- ❌ **不得**在未设描述性 User-Agent 的情况下访问任何 wiki/API
- ✅ **应当**优先使用官方 API（OpenDota/STRATZ/Steam 均提供）
- ✅ **应当**遵守 robots.txt（Liquipedia `/dota2/api.php` 路径允许）
- ✅ **应当**所有第三方数据缓存复用，降低请求频率
- ✅ **应当**数据来源在 UI 标注（已做：`sourceLabel`）

### 3.6 数据源拓宽优先级

| 优先级 | 方案 | 工作量 | 收益 |
|---|---|---|---|
| P0 | 激活比赛详情页（OpenDota `/matches/{id}`） | 中 | 高（核心功能补全） |
| P0 | 云函数预热即将到来 | 中 | 高（解决首次加载慢） |
| P1 | 展示 Liquipedia 赛事元数据 | 小 | 中（信息密度提升） |
| P1 | 展示选手生涯轨迹 | 小 | 中 |
| P2 | 接入 GitHub 英雄改动数据集 | 小 | 低 |
| P3 | DATDota Elo 排名（需确认合规） | 中 | 中 |

---

## 四、改进建议（按优先级排序）

### P0 — 上线前必做

1. **`urlCheck: true` + 域名白名单**：小程序后台配置 4 个 request 合法域名（opendota/stratz/steampowered/liquipedia）
2. **隐私协议页**：创建 `pages/privacy/privacy`，`app.json` 加 `__usePrivacyCheck__: true`
3. **比赛详情页补全**：OpenDota `/matches/{id}` 已有数据，补阵容/出装/经济曲线展示
4. **即将到来云函数预热**：CloudBase 定时触发器每 10min 拉赛程，客户端读缓存

### P1 — 体验与质量提升

5. **抽自定义组件**：`match-card` / `team-name-row` / `loading-skeleton` / `empty-state` / `source-badge`
6. **ESLint 配置**：统一代码风格，防回归
7. **setData 优化**：用 path 更新 + 合并多次调用
8. **长列表虚拟化**：选手历史/大赛事比赛列表用 `virtual-list`
9. **apiKey 迁移云函数**：客户端不存 key，外部 API 调用走云函数中转
10. **展示 Liquipedia 赛事元数据**：奖金池/地点/赛制在 league-detail 展示
11. **两队 H2H 对战历史**：按 team_id 对过滤已有比赛

### P2 — 锦上添花

12. **分包**：详情页拆到 `subpackages/`
13. **图片 CDN 缩略图**：logo/avatar 加尺寸参数
14. **选手搜索**：复用 teams 页搜索防抖模式
15. **页面纯函数单测**：fmt/slicePage/groupSeries 补测
16. **README 上线检查清单**：域名/隐私/urlCheck/key 迁移
17. **`league-detail.js` 拆分**：系列赛聚合/队名补全抽到 utils

### P3 — 长期

18. **推送通知**：关注赛事开赛/结果触发订阅消息
19. **战队世界排名**（需引入第三方源，先确认合规）
20. **选手生涯轨迹可视化**（图表组件）

---

## 五、总结

DOTA2赛事在**数据源编排**和**架构分层**上已经做到了相当成熟的水准——六源共识、SWR 增量缓存、Liquipedia 合规采集、系列赛智能聚合，这些都是项目的核心亮点，在同类小程序中属于高完成度。

主要短板集中在：
1. **上线前合规**（urlCheck/隐私协议/apiKey）——必须解决
2. **性能**（setData 频次/虚拟列表/即将到来加载慢）——影响体验
3. **已有数据未充分展示**（比赛详情/赛事元数据/选手轨迹）——投入产出比最高的改进方向
4. **工程化**（无 ESLint/无自定义组件/无分包）——影响可维护性

**建议优先级**：先完成 P0 的 4 项（合规 + 核心功能补全），再逐步推进 P1 的体验与质量提升。数据源拓宽方面，**激活已有数据源的投入产出比远高于引入新源**，应优先做方案 A。
