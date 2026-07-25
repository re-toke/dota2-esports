# DOTA2赛事 · Code Wiki

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
| `getLeagueName(league)` | 赛事名归一投票 | OpenDota / curation / STRATZ / Liquipedia |
| `getLeagueWindow(league)` | 赛事时间中位数比对 | curation / STRATZ / Liquipedia |
| `getLeagueMetadata(league)` | 元数据聚合（奖金池/地点/赛制） | Liquipedia + Steam |
| `crossTeamMembers(teamId)` | 成员按 account_id 交叉比对 | OpenDota / STRATZ / Liquipedia |
| `groupSeries(matches)` | 系列赛聚合（BO1/BO2/BO3/BO5 判定） | OpenDota |
| `getLeagueStandings(leagueId)` | 赛事排名聚合 | OpenDota |
| `getTeamPriority(nameOrId)` | 战队优先级（S-Tier/TI 标识） | curation |
| `getMatchTier(leagueName)` | 单场比赛赛事等级（零网络） | tiers |
| `enrichPlayerProfile(player)` | 选手资料多源增强 | Liquipedia |
| `getUpcomingFromCuration(now)` | curation 未来赛事补充 | curation |

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
页面调用 sources.getLeagueName(league)
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
| ongoingBufferSec | 7 天 | 「正在进行」缓冲 |
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
