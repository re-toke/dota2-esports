# DOTA2赛事 · Code Wiki

<!-- ARCHIVED-BANNER -->
> ⚠️ **本文档已归档**（最后更新 2026-07-27，项目此后已演进约 2 个月）。
> **请勿以本文作为现状依据。** 证据优先级：**代码 / `git log` > `deliverables/` > 本文 > 整合版**。
> 已核实的两处典型失真：
> · 文中描述的**微信云函数链路（`aggregation` / `upcoming_schedule` 预热等）已彻底退役** —— 现为 **Supabase 单后端**；
> · **「进行中 = 最近 7 天」已改为「2 小时」**（见 `utils/config.js` 的 `leagueWindow`）。
> 权威入口（均在**本仓库内**且最新）：
> · `deliverables/项目复核与优化方案-v2-2026-09-26.md`
> · `deliverables/复核意见-优化方案v2-2026-09-26.md`
> · `deliverables/P0-B-SLO口径与采集点-2026-09-26.md`
> 完整技术文档：`../DOTA2赛事通-项目技术文档-整合版.md`（工作区外 · v8.93 · 2026-09-25）

> 本文档是 `dota2-esports` 微信小程序的结构化代码百科，涵盖项目整体架构、主要模块职责、关键类与函数说明、依赖关系以及项目运行方式。
> 生成时间：2026-07-24 · 对应代码版本：`package.json@1.1.0`

---

## 目录

- [1. 项目概述](#1-项目概述)
- [2. 技术栈](#2-技术栈)
- [3. 项目整体架构](#3-项目整体架构)
- [4. 目录结构](#4-目录结构)
- [5. 主要模块职责](#5-主要模块职责)
  - [5.1 数据源层（utils 数据源模块）](#51-数据源层utils-数据源模块)
  - [5.2 编排与共识层](#52-编排与共识层)
  - [5.3 缓存与基础设施层](#53-缓存与基础设施层)
  - [5.4 页面层（pages / subpackages）](#54-页面层pages--subpackages)
  - [5.5 云函数层](#55-云函数层)
- [6. 关键类与函数说明](#6-关键类与函数说明)
- [7. 依赖关系](#7-依赖关系)
- [8. 数据流与核心机制](#8-数据流与核心机制)
- [9. 项目运行方式](#9-项目运行方式)
- [10. 测试体系](#10-测试体系)
- [11. 配置参考](#11-配置参考)

---

## 1. 项目概述

**DOTA2赛事** 是一款原生微信小程序（无前端框架），聚焦 DOTA2 **S 级及以上赛事**，提供赛事列表/详情、战队/选手资料、对战历史（H2H）、关注订阅等能力。

核心定位：

- **数据来源多元化**：采用六源数据编排（community / curation / OpenDota / STRATZ / Steam / Liquipedia），任一源失败优雅降级，不阻塞页面渲染。
- **多源交叉验证**：对赛事名/分级/时间/成员等关键字段做并行采集 + 投票/比对，产出「共识值 + 可信度」。
- **合规优先**：所有外部数据源均为免费 / 开源 / 官方 API，严格遵守各自 ToS 与限流规则。
- **信息及时性**：SWR（stale-while-revalidate）+ 增量游标拉取，平衡时效与流量。

AppID 默认 `touristappid`（游客模式），可直接预览；UI 基于 **TDesign 微信小程序组件库**，采用暗色极简运动风主题。

---

## 2. 技术栈

| 类别 | 技术 |
|------|------|
| 运行时 | 原生微信小程序（无 Vue/React/Taro） |
| UI 组件库 | TDesign 微信小程序组件库 `tdesign-miniprogram@^1.15.3`（已 vendor 到 `miniprogram_npm/`） |
| 语言 | JavaScript（ES2020，CommonJS 模块） |
| 样式 | WXSS（暗色主题，统一在 `app.wxss` 覆盖 TDesign 变量） |
| Lint | ESLint `^8.57.0`（配置见 `.eslintrc.json`） |
| 云函数 | 微信云开发 CloudBase（`wx-server-sdk` + `got`，可选） |
| 测试 | Node.js 自研测试运行器（`scripts/test-*.js`） |
| 主源数据 | OpenDota REST API（免费、无需 key） |
| 辅助数据源 | STRATZ GraphQL / Steam Web API / Liquipedia MediaWiki API |

---

## 3. 项目整体架构

项目采用**分层架构 + 多源编排**设计，自下而上分为五层：

```
┌─────────────────────────────────────────────────────────────┐
│  页面层（pages / subpackages/detail）                        │
│  leagues · teams · follow · league-detail · team-detail     │
│  player-detail · match-detail · privacy                     │
└─────────────────────────────────────────────────────────────┘
          │ 调用
          ▼
┌─────────────────────────────────────────────────────────────┐
│  编排与共识层                                                │
│  sources.js（多源编排）  consensus.js（投票/比对引擎）        │
│  curation.js / remoteCuration.js（权威库 + 远程热更新）       │
│  tiers.js（社区分级规则）                                    │
└─────────────────────────────────────────────────────────────┘
          │ 编排
          ▼
┌─────────────────────────────────────────────────────────────┐
│  数据源层（六个独立数据源，任意失败隔离）                      │
│  api.js（OpenDota 主源）   stratz.js（GraphQL 第二源）        │
│  steam.js（Valve 官方）    liquipedia.js（人工策展 wiki）      │
│  community（tiers.js 本地规则）  curation（本地权威库）        │
└─────────────────────────────────────────────────────────────┘
          │ 依赖
          ▼
┌─────────────────────────────────────────────────────────────┐
│  基础设施层                                                  │
│  cache.js（带 TTL 本地缓存 + SWR）  api.js（限流器）           │
│  incremental.js（增量游标）  sqlFragments.js（共享 SQL）       │
│  cloudProxy.js（云函数代理）  follow.js / subscribe.js       │
│  searchHistory.js  util.js（格式化/分级/状态判定）           │
└─────────────────────────────────────────────────────────────┘
          │ 可选
          ▼
┌─────────────────────────────────────────────────────────────┐
│  云函数层（cloudfunctions/aggregation）                       │
│  OpenDota 代理 + 云 DB 缓存 + STRATZ 中转 + 定时预热          │
└─────────────────────────────────────────────────────────────┘
```

**架构亮点：**

1. **错误隔离彻底**：所有外部源调用都包 `try/catch` + `.catch(() => [])`，单源失败绝不阻塞渲染。
2. **本地优先**：community 规则与 curation 权威库零网络可用，作为兜底与交叉验证基准。
3. **字段对齐契约**：增量 SQL 字段名严格对齐直连端点，避免跨源合并错位（见 `incremental.js` 顶部契约说明）。
4. **无循环依赖**：`api.js ↔ cloudProxy.js` 通过内联逻辑而非反向 require 解耦。

---

## 4. 目录结构

```
dota2-esports/
├── app.js / app.json / app.wxss        # 全局入口、页面注册、暗色主题
├── project.config.json                 # 开发者工具配置
├── package.json                        # tdesign-miniprogram + eslint
├── sitemap.json
├── utils/                              # 核心业务与数据源模块（18 个）
│   ├── api.js                          # OpenDota 封装 + 限流 + SWR 缓存
│   ├── cache.js                        # 带 TTL 的本地缓存（getStale/touch）
│   ├── incremental.js                  # 增量游标纯函数（maxStart/mergeMatches/buildMatchSql）
│   ├── sqlFragments.js                 # 共享 SQL 片段（LEAGUE_WINDOWS_SQL）
│   ├── config.js                       # 缓存 TTL/限流/分页/多源/订阅模板配置
│   ├── consensus.js                    # 多源交叉验证引擎（voteName/voteTime/consensusTier/crossMembers）
│   ├── curation.js                     # 本地权威库（赛事规范名/等级 + 战队 + TI 名单）
│   ├── remoteCuration.js               # 远程 curation 热更新覆盖层
│   ├── tiers.js                        # 社区分级规则（COMMUNITY_TIERS）
│   ├── sources.js                      # 多源编排层（聚合 + 交叉验证 + 系列赛 + H2H 优先级）
│   ├── stratz.js                       # STRATZ GraphQL 第二网络源
│   ├── steam.js                        # Steam Web API 第三网络源
│   ├── liquipedia.js                   # Liquipedia MediaWiki 第四网络源
│   ├── cloudProxy.js                   # 云函数代理层（接口与 api.js 对齐）
│   ├── follow.js                       # 本地关注存储（teams/players/leagues）
│   ├── subscribe.js                    # 微信订阅消息脚手架
│   ├── searchHistory.js                # 搜索历史本地持久化
│   └── util.js                         # 格式化/胜负/分级/状态判定/formatAgo
├── pages/                              # 主包页面（tabBar）
│   ├── leagues/                        # 赛事列表（全部/正在进行/即将到来）
│   ├── teams/                          # 战队搜索 + 热门
│   ├── follow/                         # 关注中心
│   └── stratz-test/                    # STRATZ 调试页
├── subpackages/detail/                 # 详情分包（按需加载）
│   ├── league-detail/                  # 赛事详情（对阵 + 排名 + 元数据）
│   ├── match-detail/                   # 比赛详情（阵容/出装/经济曲线）
│   ├── team-detail/                    # 战队详情（成员/H2H/战绩）
│   ├── player-detail/                  # 选手详情（资料/战绩/常用英雄）
│   └── privacy/                        # 隐私协议页
├── cloudfunctions/aggregation/         # CloudBase 云函数
│   ├── index.js                        # OpenDota 代理 + 缓存 + STRATZ 中转 + 预热
│   └── package.json                    # got + wx-server-sdk
├── scripts/                            # Node.js 测试脚本（9 个）
│   ├── test-sources.js                 # 多源回退链 mock 测试
│   ├── test-consensus.js               # 共识算法测试
│   ├── test-incremental.js             # 增量 SQL + 合并测试
│   ├── test-series.js                  # 系列赛 BO 类型判定测试
│   ├── test-liquiped.js                # Liquipedia 解析测试
│   ├── test-remote-curation.js         # 远程 curation 覆盖测试
│   ├── test-search-history.js          # 搜索历史测试
│   ├── test-formatters.js              # 格式化函数测试
│   ├── validate.js                     # 代码规范校验
│   └── verify-incremental-e2e.js       # 增量拉取端到端验证
└── miniprogram_npm/tdesign-miniprogram/  # TDesign 构建产物（已 vendor）
```

---

## 5. 主要模块职责

### 5.1 数据源层（utils 数据源模块）

#### `utils/api.js` — OpenDota 主源封装

**职责**：封装 OpenDota 公开 API（免费、无需 key），是整个项目的核心数据源。

**关键能力**：
- `request()`：带限流器的请求（最小间隔 1050ms，遇 429 指数退避重试 2 次）。
- `cached()` / `cachedFresh()`：带 TTL 的本地缓存 + SWR（stale-while-revalidate）。
- `cachedFreshIncremental()`：比赛列表增量游标拉取（按 `start_time` 游标只拉新增）。
- `validateResponse()`：响应校验，畸形响应不写缓存、回退旧值。
- 可选云函数代理：`cloudEnabled()` 时优先走云函数，失败回退直连。

**导出方法**：`getLeagues` / `getLeagueWindows` / `getLeagueMatches` / `getMatch` / `getMatchPlayers` / `searchTeams` / `searchPlayers` / `getTeam` / `getTeamPlayers` / `getTeamMatches` / `getPlayer` / `getPlayerMatches` / `getHeroes` / `getTeamNames` / `getItems` / `fetchedAtOf`。

#### `utils/stratz.js` — STRATZ GraphQL 第二源

**职责**：作为 OpenDota 之外的真实第二网络源，提供赛事分级/赛程窗口/名册/logo/头像。

**启用条件**：`config.stratz.enabled === true` 且有 `apiKey`（直连模式）或 `cloudProxy.enabled`（云代理模式）。

**关键能力**：
- `gql()`：GraphQL 请求入口，云代理优先（key 安全），直连兜底，429/5xx 退避重试。
- `findLeagueByName()`：归一名精确匹配 + curation 别名回退（避免子串误匹配）。
- `getLeagues()`：6h 本地缓存，避免「即将到来」Tab 重复查询。
- 各方法均 `resolve(null/[])` 优雅降级。

#### `utils/steam.js` — Steam Web API 第三源

**职责**：Valve 官方接口，提供 OpenDota/STRATZ 无的**奖金池**（`GetTournamentPrizePool`）与战队官方信息。

**启用条件**：`config.steam.enabled === true` 且有 `apiKey`（100,000 次/天）。

#### `utils/liquipedia.js` — Liquipedia 第四源

**职责**：独立人工策展电竞 wiki，提供赛事元数据（规范名/日期/奖金池/地点/赛制/主办方）、战队名册、选手资料。**真正独立于 Valve 比赛数据**的交叉验证源。

**合规要点**：
- 使用 `action=query&prop=revisions` 取 wikitext（2s 限流，比 `action=parse` 的 30s 宽松 15 倍）。
- 必须设 `Accept-Encoding: gzip`；**不设 User-Agent**（微信运行时禁止，需云函数代理）。
- 检测反爬虫拦截页（`temporarily blocked`），6h 本地缓存复用。

**关键解析器**：`parseTemplate()`（MediaWiki 模板参数提取，支持嵌套花括号）、`stripWikitextMarkup()`、`parsePrizePool()`。

#### `utils/tiers.js` — 社区分级规则

**职责**：基于赛事名的精选分级规则，零网络、永远可用，作为兜底与首选快速分级。

**等级模型**：`SSS(4) > S(3) > A(2) > B(1) > C(0)`，通过正则匹配赛事名（如 `the international` → SSS，`major` → S）。

#### `utils/curation.js` — 本地权威库

**职责**：零网络常驻权威库，收录重大赛事规范名/等级/日期与知名战队规范名/国家/标签。作为交叉验证的第二个可信来源。

**关键数据**：
- `CURATED_EVENTS`：TI 系列 / ESL One / DreamLeague / PGL / BLAST / FISSURE / BetBoom 等赛事。
- `CURATED_TEAMS`：LGD / Spirit / OG / Secret / Tundra 等 24 支战队，带 `tier` 字段（SSS=TI 参赛 / S=S-Tier）。
- `TI_CONTESTANT_TEAM_IDS`：2022-2026 历届 TI 主赛事参赛队 ID 集合。

**关键函数**：
- `buildLookups(events, teams)`：构建可复用查找器（支持远程覆盖）。
- `eventFor(name)`：带边界检查的模糊匹配（避免 "TI2026 NA Qualifier" 误匹配 "TI2026" 主赛事）。
- `isTIContestantTeam(teamId)` / `isHighPriorityTeam(nameOrId)`：TI 参赛队 / 高优先级战队判定。

### 5.2 编排与共识层

#### `utils/sources.js` — 多源编排层（核心）

**职责**：把「比赛内容来源」做多元化，在「优先级回退」之外新增「并行采集 + 多源交叉验证」。

**关键函数**：

| 函数 | 职责 | 数据来源 |
|------|------|----------|
| `getLeagueTier(league)` | 赛事分级多源计票 | community / curation / OpenDota / STRATZ |
| `voteLeagueNameForMatch(league)` | 赛事名归一投票（**仅用于匹配/索引，禁止展示**；展示走 `leagueDisplayName`） | OpenDota / curation / STRATZ / Liquipedia |
| `getLeagueName(league)` | ⚠️ 已废弃别名，等价于 `voteLeagueNameForMatch`，勿用于展示 | 同上 |
| `getLeagueWindow(league)` | 赛事时间中位数比对 | curation / STRATZ / Liquipedia |
| `getLeagueMetadata(league)` | 元数据聚合（奖金池/地点/赛制） | Liquipedia + Steam |
| `crossTeamMembers(teamId)` | 成员按 account_id 交叉比对 | OpenDota / STRATZ / Liquipedia |
| `groupSeries(matches)` | 系列赛聚合（BO1/BO2/BO3/BO5 判定） | OpenDota |
| `getLeagueStandings(leagueId)` | 赛事排名聚合 | OpenDota |
| `getTeamPriority(nameOrId)` | 战队优先级（S-Tier/TI 标识） | curation |
| `getMatchTier(leagueName)` | 单场比赛赛事等级（零网络） | tiers |
| `enrichPlayerProfile(player)` | 选手资料多源增强 | Liquipedia |
| `getUpcomingFromCuration(now)` | curation 未来赛事补充 | curation |

**展示联赛名规范（P3 / G1+G3 防护）**：

- 所有展示位统一使用 `sources.leagueDisplayName(league对象)` 取得规范名（形状无关：接受 `{name}` / `{league_name}` / `{league:{name}}` / 字符串）。该函数内部调用 `canonicalLeagueName`，命中 curation 规范名则覆盖（如 `EPL Masters 2026` → `EPL Masters I`），否则原样返回。
- 列表/卡片/详情构建出的展示对象应附带 `displayName` 字段（= leagueDisplayName 结果），WXML 用 `{{item.displayName || item.name}}` 读取，保证「安全路径=默认路径」。
- **禁止**把原始联赛名字段（`<obj>.league_name` / `<obj>.league.name`）直接赋给展示字段（`name` / `leagueName` / `league` / `displayName` / `title`）。静态检查 `scripts/eslint-rules/no-raw-league-name.js`（已在 `.eslintrc.json` 启用为 error）会在 lint/CI 阶段拦截此类赋值；确需原始名用于分级/检索时，请赋给非展示字段（如 `rawLeagueName`）。
- 赛期展示优先用 curation 完整周期（`cur.start`/`cur.end`），回退 OpenDota 真实比赛窗口；不要用「已进行比赛窗口」冒充完整赛期。
- 相关测试：`scripts/test-canonical.js`（`npm test`）断言映射/别名/赛期/状态一致性，P3/P1 回归首次复现即红。

**规范映射单一数据源（G4 防护）**：

- 赛事名规范映射只允许手工维护 `utils/curation.js` 的 `CURATED_EVENTS`（canonical + aliases）。任何新增/修改赛事别名都只改这里。
- 映射产物 `utils/curation-shared.js` 由 `scripts/sync-canon-map.js`（`npm run sync:canon`）从 `CURATED_EVENTS` 生成，并**镜像**到 `cloudfunctions/aggregation/curation-shared.js`；两侧字节必须一致（测试断言）。
- 小程序 `utils/league-canon-map.js` 与云函数 `cloudfunctions/aggregation/league-canon-map.js` 是同一份生成产物的副本，各自 `require('./curation-shared.js')`。`sources.canonicalLeagueName` 先走精确归一映射（`leagueCanon.resolveCanonical`），未命中再回退 `curatedEventFor` 模糊匹配（仅小程序展示用）。
- **禁止**在云函数内联手写 `canonicalLeagueName` MAP（G4 消除的正是该双源漂移）。云函数改动后必须 `npm run sync:canon` 并**重新上传部署 `aggregation`**，推送文案才生效。

**共识投票名仅用于匹配/索引（G5 防护）**：

- `sources.voteLeagueNameForMatch(league)`（旧名 `getLeagueName` 为已废弃别名）产出的是「跨源共识投票名」，**仅供匹配 / 索引 / 检索**，**禁止**直接当作 UI 展示名。原因：consensus「取更长名」规则在缺乏 curation 覆盖时可能选回旧名/错误名（P3 风险依据③）。
- UI 展示名一律走 `sources.leagueDisplayName(对象)` / `displayName`（curation canonical 优先，零网络、确定性强）。
- `league-detail` 中 `voteLeagueNameForMatch` 仅作为 `finalize()` 优先级②的兜底（无 curation canonical 时），展示首选恒为 curation canonical（优先级①），绝不直接以共识名作主展示。

**curation 赛事条目变更 checklist（G6 防护，改 `utils/curation.js` 前必读）**：

新增/修改 `CURATED_EVENTS` 条目时，逐项核对：
1. **canonical 正确性**：规范名以 Liquipedia / Valve 官方为准（如 DOTA2 的 "EPL Masters 2026" 实为 "EPL Masters I"）。`npm test` 的 G6 快照会断言 `canonical==='EPL Masters I'`。
2. **跨游戏隔离**：同一赛事名在其它游戏（如 CS2 的 "EPL Masters 2026"）可能不同义——DOTA2 的 `CURATED_EVENTS` **绝不可**写入其它游戏的 canonical/别名。G6 快照断言「DOTA2 curation 不含 canonical "EPL Masters 2026"」，且展示层 `EPL Masters 2026 → EPL Masters I`。
3. **别名完整**：`aliases` 必须覆盖 OpenDota / 各源可能出现的写法（含小写无分隔形式，如 `eplmasters2026`/`epl2026`/`eplmastersi`）。改完跑 `npm run sync:canon` 重新生成 `curation-shared.js` 并镜像云函数。
4. **赛期完整**：`start`/`end` 用 `Math.floor(Date.UTC(...)/1000)`（Unix **秒**，非毫秒）；`end >= start`；未开赛赛事的赛期用于「即将到来」判定，须与 Liquipedia 公布一致。
5. **status 合法**：取值仅限 `即将到来` / `进行中` / `已结束` / `已取消`，且与 OpenDota 真实比赛窗口相符（列表/详情状态硬覆盖以此为准）。
6. **改完校验**：`npm test` 全绿（含 G2/G4/G6 快照），`npm run lint` 无 error，`npm run sync:canon` 两侧 JSON 一致后再提交/部署。

**运行时监控（G8 防护，兜底发现残余）**：

- `utils/monitor.js` 封装 `wx.reportAnalytics` 安全上报：仅在真机生产环境打点（开发者工具 / 无 wx 时自动降级为 no-op，不阻塞业务、不破坏单测）。
- `leagueNameUncovered(raw)`：当某联赛名经 `leagueDisplayName` 后仍未命中 curation（原样返回）时上报，按原始名去重（同会话一次）。用途：发现「应补进 curation 的赛事」，从源头缩小 P3 数据层缺口。
- `statusConflict(leagueid, list, detail)`：列表 vs 详情状态不一致时上报（P1 兜底发现）。
- 在 MP 后台「自定义分析」查看事件 `league_name_uncovered` / `league_status_conflict`。

**提交前守卫（G9 防护，把 G2/G3 前移到个人提交阶段）**：

- `scripts/hooks/pre-commit.sh`：提交前对「已暂存的 .js」跑 ESLint（含 `no-raw-league-name` 领域规则），并跑离线可靠测试 `npm test`（G2/G4/G6/G8 快照）；任一失败即阻断提交。
- 本仓库已安装原生 `.git/hooks/pre-commit`（立即可用，零依赖）；`husky` 配置（`.husky/pre-commit` + `prepare: husky`）用于跨克隆便携化——克隆后执行一次 `npm install` 即自动接管。
- 跳过守卫（紧急时）：`git commit --no-verify`。仅限已确认无误的纯文档/配置改动。

**系列赛 BO 类型判定逻辑**（基于胜负场数，比 `series_type` 字段更可靠）：
- 一方赢 3 局 → BO5
- 一方赢 2 局：`series_type=0` 且 2 场 → BO2，否则 → BO3
- 1-1 平局 → BO2（BO3 不可能平局）
- 1 场 → BO1

#### `utils/consensus.js` — 交叉验证引擎

**职责**：对关键字段在并行采集后投票/比对，产出 `{ value, sources, confidence, agreement, total }`。

**可信度口径**（`confidenceOf`）：
- `total <= 1` → `low`（单源无法交叉验证）
- `agreement >= total` → `high`（全部一致）
- `agreement >= 2 && total >= 3` → `medium`（多源多数一致）
- 否则 → `low`（任一源冲突）

**核心函数**：
- `normName(s)`：名称归一（转小写，仅保留 `[a-z0-9中文]`）。
- `normNum(n)`：数字归一（非法返回 null）。
- `voteName(candidates)`：名称投票（命中来源数多优先，原文最长优先）。
- `voteTime(candidates, tolSec)`：时间中位数比对（默认 3 天容差）。
- `consensusTier(candidates)`：分级按 rank 计票（平票取更高等级）。
- `crossMembers(memberLists)`：成员按 account_id 交叉比对（≥2 源 → verified）。
- `validatePlayerId(id)`：正整数合法性校验。

#### `utils/remoteCuration.js` — 远程热更新

**职责**：不发版热更新赛事/战队权威库。策略：本地兜底 + 远程优先（同键覆盖 + 追加），缓存到 Storage（6h TTL）。接口与 `curation.js` 完全兼容。

### 5.3 缓存与基础设施层

#### `utils/cache.js` — 带 TTL 本地缓存

**职责**：基于 `wx.getStorageSync` 的带 TTL 缓存，缓存命中不计入限流。

**关键方法**：
- `get(key, ttlSec)`：带过期判定的读取。
- `peek(key)`：只读查看（返回 `{ value, fetchedAt, expire }`），用于「更新于 X 前」。
- `getStale(key, freshSec, ttlSec)`：SWR 读取，返回 `{ value, fetchedAt, fresh, expired }`。
- `touch(key, ttlSec)`：仅刷新采集时间（轮询心跳，无新数据时用）。
- `clearAll()`：清空本项目全部缓存。

#### `utils/incremental.js` — 增量游标纯函数

**职责**：比赛列表增量拉取的纯函数（不依赖 wx/网络，可被 Node 单测）。

**★ 字段对齐契约**（极其重要）：增量 SQL 字段名必须与直连端点完全一致，否则合并后字段错位导致渲染异常。

**核心函数**：
- `maxStart(list)`：取列表中最新的 `start_time`（游标）。
- `mergeMatches(oldList, delta)`：按 `match_id` 去重并入头部。
- `buildMatchSql(resource, id, cursor)`：构造 league/team/player 三种增量 SQL。

#### `utils/util.js` — 工具函数

**职责**：格式化、胜负判定、统一分级、状态判定、新鲜度。

**关键函数**：
- `unifiedTier(league)`：统一分级入口（社区精选优先，OpenDota 回退）。
- `isOngoing(win, now)` / `isUpcoming(win, now)` / `statusOf(win, now)`：赛事状态判定。
- `playerWon(match)`：选手胜负（`player_slot < 128` 为天辉）。
- `formatAgo(fetchedAt)`：「更新于 X 前」相对时间。
- `formatDateRange(start, end)`：日期范围展示。

#### `utils/follow.js` / `subscribe.js` / `searchHistory.js`

- `follow.js`：本地关注存储（`{ teams, players, leagues }`），无需登录/后端。
- `subscribe.js`：微信订阅消息脚手架（未配模板时自动跳过）。
- `searchHistory.js`：搜索历史持久化（最多 10 条、去重置顶）。

### 5.4 页面层（pages / subpackages）

#### 主包页面（tabBar）

| 页面 | 文件 | 职责 |
|------|------|------|
| 赛事 | [pages/leagues/leagues.js](file:///d:/WorkBuddy项目文档/2026-07-19-15-21-29/dota2-esports/pages/leagues/leagues.js) | 三 tab（全部/正在进行/即将到来）+ 等级筛选 + 搜索 + 分页 + 关注 |
| 战队 | [pages/teams/teams.js](file:///d:/WorkBuddy项目文档/2026-07-19-15-21-29/dota2-esports/pages/teams/teams.js) | 热门战队 + 搜索（防抖 400ms）+ 战队/选手切换 + 历史标签 |
| 关注 | [pages/follow/follow.js](file:///d:/WorkBuddy项目文档/2026-07-19-15-21-29/dota2-esports/pages/follow/follow.js) | 三 tab（战队/选手/赛事）查看已关注项 + 跳转 + 取消 + 订阅提醒 |

#### 详情分包（subpackages/detail，按需加载）

| 页面 | 文件 | 职责 |
|------|------|------|
| 赛事详情 | [league-detail.js](file:///d:/WorkBuddy项目文档/2026-07-19-15-21-29/dota2-esports/subpackages/detail/league-detail/league-detail.js) | 系列赛对阵 + 排名 tab + 多源可信度徽标 + 元数据（奖金池/地点）+ 队名补全 |
| 比赛详情 | [match-detail.js](file:///d:/WorkBuddy项目文档/2026-07-19-15-21-29/dota2-esports/subpackages/detail/match-detail/match-detail.js) | 阵容（英雄/KDA/GPM/XPM）+ 出装 + 经济/经验曲线 + MVP |
| 战队详情 | [team-detail.js](file:///d:/WorkBuddy项目文档/2026-07-19-15-21-29/dota2-esports/subpackages/detail/team-detail/team-detail.js) | 信息 + 现役/历史成员（多源核实）+ 近期战绩 + H2H 对战历史 + TI 优先级标识 |
| 选手详情 | [player-detail.js](file:///d:/WorkBuddy项目文档/2026-07-19-15-21-29/dota2-esports/subpackages/detail/player-detail/player-detail.js) | 资料 + 战绩 + 常用英雄 + Liquipedia 真实姓名/国籍/位置/队伍履历 |
| 隐私协议 | privacy.js | 微信审核要求的隐私协议页（`__usePrivacyCheck__: true`） |

### 5.5 云函数层

#### `cloudfunctions/aggregation/index.js`

**职责**：CloudBase 聚合云函数，四个核心能力：

1. **OpenDota 代理**：国内访问加速，路由 `action → path`，失败用过期缓存兜底。
2. **云 DB 缓存**：`aggregation_cache` collection，带 `expire` + `fetchedAt`。
3. **STRATZ 中转**：`stratzGql` action，apiKey 从环境变量 `STRATZ_API_KEY` 读取（客户端不存 key）。
4. **定时预热**：`handleTimer()` 预热热端点 + `preheatUpcoming()` 预热赛程（解决「即将到来」首次加载慢）。

**部署步骤**：开通云开发 → 上传部署 → `npm install`（got）→ 可选创建 `aggregation_cache` collection。

---

## 6. 关键类与函数说明

### consensus.js — 共识引擎

```javascript
// 名称投票：命中来源数多优先，原文最长优先
voteName(candidates: [{value, source}]) 
  → { value, sources, confidence, agreement, total }

// 时间中位数比对（默认 3 天容差）
voteTime(candidates: [{value:unixSec, source}], tolSec) 
  → { value, sources, confidence, agreement, total, spreadSec }

// 分级计票（按 rank，平票取更高等级）
consensusTier(candidates: [{grade, rank, label, source}]) 
  → { grade, rank, label, sources, confidence, agreement, total }

// 成员交叉比对（≥2 源 → verified，排在前）
crossMembers(memberLists: [{source, members:[{account_id, name}]}]) 
  → { members, total, verifiedCount, confidence, sources }
```

### sources.js — 编排层核心

```javascript
// 系列赛聚合：基于胜负场数判定 BO 类型（比 series_type 可靠）
groupSeries(matches) → [{
  key, games, scoreA, scoreB, boType, boLabel,
  isLive, isRecent, isDraw, isMulti,
  radiantName, direName, radiantTeamId, direTeamId,
  scoreACls, scoreBCls, teamACls, teamBCls,  // 预计算 class
  lastTime
}]

// 战队优先级判定（H2H/资料功能优先覆盖 S-Tier 与 TI 参赛队）
getTeamPriority(nameOrId) 
  → { isHighPriority, isTI, tier, label }

// 单场比赛赛事等级（零网络，用于 H2H 按 S-Tier 优先聚合）
getMatchTier(leagueName) → { grade, rank, label } | null
```

### api.js — SWR 缓存策略

```javascript
// 三级新鲜度策略：
cachedFresh(path, data, freshSec, ttlSec)
  // 1. 硬 TTL 内且新鲜 → 直接返回缓存（最省流量）
  // 2. 未过期但已陈旧 → 先返回旧值，后台静默刷新（用户无感）
  // 3. 已过期/无缓存 → 正常拉取

// 增量版（大列表用）：
cachedFreshIncremental(resPath, resource, id, freshSec, ttlSec)
  // 陈旧时用 start_time 游标只拉新增比赛，按 match_id 去重并入头部
  // 无新数据时 cache.touch() 刷新采集时间（轮询心跳）
```

### incremental.js — 字段对齐契约

| 资源 | 直连端点 | 增量 SQL 用表 | 关键对齐字段 |
|------|----------|----------------|--------------|
| league | `/leagues/{id}/matches` | `matches` LEFT JOIN `teams` ×2 | `radiant_team_name`/`dire_team_name`（COALESCE 补全） |
| team | `/teams/{id}/matches` | `matches` + CASE 计算 | `opposing_team_id`/`opposing_team_name`/`radiant` 布尔 |
| player | `/players/{id}/matches` | `player_matches` JOIN `matches` | `player_slot`（胜负判断依赖，必选） |

### util.js — 状态判定

```javascript
// 赛事状态：基于 OpenDota earliest/latest 或外部源 startDate/endDate
isOngoing(win, now)   // 已开赛且最近 7 天内仍有比赛
isUpcoming(win, now)  // 未来 60 天内开赛
statusOf(win, now)     // 'ongoing' | 'upcoming' | 'ended'
```

---

## 7. 依赖关系

### 模块依赖图

```
页面层 ──→ sources.js ──→ consensus.js
    │           │              │
    │           ├──→ api.js ───┤ (normName/normNum)
    │           │      │
    │           │      ├──→ cache.js
    │           │      ├──→ incremental.js
    │           │      └──→ sqlFragments.js
    │           │
    │           ├──→ stratz.js ──→ cache.js / consensus.js / remoteCuration.js
    │           ├──→ steam.js
    │           ├──→ liquipedia.js ──→ cache.js / consensus.js
    │           ├──→ curation.js (经 remoteCuration.js 包装)
    │           │       └── remoteCuration.js ──→ cache.js / config.js
    │           └──→ tiers.js
    │
    ├──→ util.js ──→ api.js (TIER_RANK) / tiers.js
    ├──→ follow.js
    ├──→ subscribe.js ──→ config.js
    ├──→ searchHistory.js
    └──→ cloudProxy.js ──→ api.js (回退，无循环依赖)
```

### 外部依赖

| 依赖 | 类型 | 用途 |
|------|------|------|
| OpenDota API | 网络（主源） | 比赛结果/战队/选手/英雄/时间窗口 |
| STRATZ GraphQL | 网络（第二源） | 分级/赛程/名册/logo/头像 |
| Steam Web API | 网络（第三源） | 奖金池/战队官方信息 |
| Liquipedia API | 网络（第四源） | 赛事元数据/名册/选手资料 |
| `tdesign-miniprogram` | npm | UI 组件库 |
| `wx-server-sdk` | npm（云函数） | CloudBase SDK |
| `got` | npm（云函数） | HTTP 请求 |
| `eslint` | devDependency | 代码规范 |

### 循环依赖处理

`api.js ↔ cloudProxy.js`：`cloudProxy.js` 顶部 `require('./api.js')` 用于回退，故 `api.js` 顶部**不可反向 require cloudProxy**。`api.js` 内联了相同的云函数调用逻辑（`cloudFetch`），避免循环依赖。

---

## 8. 数据流与核心机制

### 8.1 多源交叉验证流

```
页面调用 sources.voteLeagueNameForMatch(league)   // G5：共识投票名，仅供匹配/索引，非展示用
        │
        ▼ 并行采集候选
  ┌─────────────┬─────────────┬─────────────┬─────────────┐
  │  OpenDota   │  curation   │   STRATZ    │  Liquipedia │
  │  (name)     │ (canonical) │(displayName)│ (canonical) │
  └─────────────┴─────────────┴─────────────┴─────────────┘
        │ 归一投票
        ▼
  consensus.voteName(candidates)
        │
        ▼
  { value, sources, confidence: high/medium/low, agreement, total }
```

### 8.2 SWR + 增量拉取流

```
页面调用 api.getTeamMatches(teamId)
        │
        ▼
  cachedFreshIncremental('/teams/{id}/matches', 'team', id, 10min, 30min)
        │
        ├── 缓存新鲜（< 10min）→ 直接返回缓存
        │
        ├── 缓存陈旧（10min ~ 30min）→ 返回旧值 + 后台刷新：
        │       │
        │       ▼
        │   inc.maxStart(cached)  // 取游标
        │       │
        │       ▼
        │   fetchMatchDelta('team', id, cursor)  // /explorer SQL 只拉新增
        │       │
        │       ▼
        │   inc.mergeMatches(old, delta)  // 按 match_id 去重并入头部
        │       │
        │       ▼
        │   cache.set(merged)  // 更新缓存
        │
        └── 缓存过期/无缓存 → 直连端点全量拉取
```

### 8.3 「即将到来」加载流

```
loadUpcoming()
  │
  ├── tryCloudUpcoming()  // 优先读云函数预热缓存（秒开）
  │       └── 命中 → 合并 curation → 显示
  │
  └── loadUpcomingSerial()  // 未命中，串行回退
          │
          ├── 1. allLeagues 中 earliest 在未来的 → 直接添加（OpenDota explorer）
          ├── 2. curation 库未来赛事（如 TI 2026）→ 补充
          └── 3. 串行查剩余（STRATZ 2s 限流）→ 后台补充
```

### 8.4 限流与缓存策略

| 数据源 | 限流策略 | 缓存 TTL |
|--------|----------|----------|
| OpenDota | 最小间隔 1050ms + 429 退避重试 | 赛事 6h / 比赛 30min / 战队 6h |
| STRATZ | 退避重试（1s/2.5s） | 联赛列表 6h |
| Liquipedia | 串行 2200ms 间隔 + 重试（2.2s/6s） | 6h |
| Steam | 无显式限流 | 跟随各接口 |

---

## 9. 项目运行方式

### 9.1 本地预览（开发者工具）

1. 用**微信开发者工具**导入项目目录 `dota2-esports/`。
2. AppID：已设为 `touristappid`（游客模式），可直接预览；真机调试改成自己的 AppID。
3. `project.config.json` 中 `urlCheck: false`，开发者工具默认不校验合法域名，可直接联调。
4. TDesign 组件已 vendor 到 `miniprogram_npm/`，导入即运行，无需「构建 npm」。

### 9.2 配置数据源（utils/config.js）

```javascript
// STRATZ（第二源，可选）
stratz: { enabled: true, apiKey: '...', base: 'https://api.stratz.com/graphql' }

// Steam（第三源，可选）
steam: { enabled: false, apiKey: '', base: 'https://api.steampowered.com/IDOTA2Match_570' }

// Liquipedia（第四源，默认启用）
liquipedia: { enabled: true, base: 'https://liquipedia.net/dota2/api.php', rateLimitMs: 2200 }

// 远程 curation 热更新（可选）
remoteCuration: { url: '', ttlSec: 6 * 3600 }

// 云函数代理（可选）
cloudProxy: { enabled: false }
```

### 9.3 上线前检查清单

1. **域名白名单**（小程序后台 → 开发 → 开发管理 → 服务器域名）：
   - `https://api.opendota.com`（必需）
   - `https://api.stratz.com`（启用 STRATZ 时）
   - `https://api.steampowered.com`（启用 Steam 时）
   - `https://liquipedia.net`（启用 Liquipedia 时）

2. **urlCheck**：上线前 `project.config.json` 改回 `true`（当前为 `false` 便于开发）。

3. **隐私协议**：已包含 `pages/privacy/privacy`，`app.json` 已配 `__usePrivacyCheck__: true`。

4. **apiKey 安全**：STRATZ/Steam key 当前在 `config.js` 明文（开发用），上线推荐迁移到云函数环境变量。

### 9.4 云函数部署（可选）

1. 微信开发者工具 → 云开发 → 开通 → 创建环境。
2. 右键 `cloudfunctions/aggregation` → 上传并部署 → 云端安装依赖。
3. 环境变量配置 `STRATZ_API_KEY`（云函数控制台）。
4. 可选：创建 `aggregation_cache` 云 DB collection。
5. `app.js` 已调用 `wx.cloud.init()`（启用时）。

### 9.5 Lint 与测试

```bash
# ESLint 检查
npm run lint

# 自动修复
npm run lint:fix

# 运行测试（Node.js 环境）
node scripts/test-sources.js
node scripts/test-consensus.js
node scripts/test-incremental.js
node scripts/test-series.js
# ...其他 test-*.js
```

---

## 10. 测试体系

项目采用自研 Node.js 测试运行器（`scripts/test-*.js`），通过 mock `wx` 全局对象在 Node 环境运行，不依赖微信开发者工具。

| 测试脚本 | 覆盖范围 |
|----------|----------|
| `test-sources.js` | 多源回退链、优雅降级（mock 网络不可达） |
| `test-consensus.js` | 名称/时间/分级投票算法、成员交叉比对 |
| `test-incremental.js` | 增量 SQL 构造 + mergeMatches 去重 + 字段对齐 |
| `test-series.js` | 系列赛 BO1/BO2/BO3/BO5 判定（含 3 胜 BO5、1-1 平局 BO2） |
| `test-liquiped.js` | wikitext 模板解析、奖金池解析、反爬虫检测 |
| `test-remote-curation.js` | 远程覆盖 + 本地兜底 + 缓存回退 |
| `test-search-history.js` | 去重置顶、最大 10 条 |
| `test-formatters.js` | formatDuration / formatTime / formatAgo |
| `validate.js` | 代码规范校验 |
| `verify-incremental-e2e.js` | 增量拉取端到端验证（联网） |

**测试运行器模式**：`section()` 登记分段标题，`check()` 登记测试（支持 async），`runAll()` 顺序执行并输出汇总与退出码。

---

## 11. 配置参考

### 缓存 TTL（utils/config.js → cacheTTL）

| 接口 | 硬 TTL | 新鲜窗口 |
|------|--------|----------|
| leagues（赛事列表） | 6h | — |
| leagueWindows（时间窗口） | 2h | — |
| leagueMatches（赛事比赛） | 30min | 10min |
| match（单场详情） | 30min | — |
| team（战队详情） | 6h | 1h |
| teamPlayers（成员） | 3h | 1h |
| teamMatches（战队战绩） | 30min | 10min |
| player（选手详情） | 6h | 1h |
| playerMatches（选手战绩） | 30min | 10min |
| heroes（英雄表） | 24h | — |

### 赛事时间窗口判定（config.leagueWindow）

| 参数 | 值 | 含义 |
|------|----|------|
| ongoingBufferSec | 2 小时 | 「正在进行」缓冲（真实结束时间 last_end 之后再保留 2 小时；旧值为 7 天，会造成赛事结束很久仍显示进行中） |
| upcomingRangeSec | 60 天 | 「即将到来」范围 |
| upcomingQueryLimit | 60 | 懒加载最大查询数 |

### 限流参数（config.rateLimit）

| 参数 | 值 | 含义 |
|------|----|------|
| minGapMs | 1050 | 两次请求最小间隔（略 >1000ms 保 60/min） |
| maxRetries | 2 | 429 最大重试次数 |
| retryBaseMs | 1500 | 指数退避基数 |

---

> **扩展权威库**：在 `utils/curation.js` 的 `CURATED_EVENTS` / `CURATED_TEAMS` 中按示例增补即可，无需后端，增补后即参与交叉验证。或配置 `remoteCuration.url` 实现不发版热更新。
