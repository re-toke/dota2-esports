# DOTA2赛事 · 微信小程序（TDesign 版）

关注 DOTA2 **S 级及以上赛事**、查看**战队成员 / 队员资料与历史**、对比**双方历史胜负**的轻量小程序。
UI 基于 **TDesign 微信小程序组件库**，支持**关注订阅**、**社区分级**与**本地缓存 + 限流**。

## 功能

| 模块 | 页面 | 能力 |
|------|------|------|
| 赛事 | `pages/leagues` | 列出 S 级及以上赛事，按「全部 / 正在进行 / 即将到来」筛选；搜索；分页加载；社区分级徽标；状态徽标与日期范围；一键关注 |
| 赛事详情 | `pages/league-detail` | 该赛事对阵列表（双方、比分、时间）；多源社区分级提示；关注入口 |
| 战队 | `pages/teams` | 搜索战队 + 分页；点击进详情 |
| 战队详情 | `pages/team-detail` | 战队积分/胜负/胜率、现役/历史成员（分段切换）、近期战绩分页、关注 |
| 队员详情 | `pages/player-detail` | 选手资料、总胜率、常用英雄、近期战绩分页；关注入口 |
| 关注中心 | `pages/follow` | 分「战队 / 选手 / 赛事」查看已关注项，TDesign 组件 + 分页，可跳转详情、取消关注、开启订阅提醒 |

## 技术栈

- 原生微信小程序（无框架），AppID 设为 `touristappid` 可直接预览。
- **TDesign 微信小程序组件库**：已把构建产物 vendor 到 `miniprogram_npm/tdesign-miniprogram/`，
  开发者工具**无需点击「构建 npm」**即可渲染（已配 `packNpmManually: true`）。
  如需重新生成：`npm install` 后执行开发者工具「工具 → 构建 npm」。
- 暗色极简运动风主题：深色底 + 等级彩条 + 天辉绿/夜魇红胜负语义，在 `app.wxss` 覆盖 TDesign 设计变量实现。

## 视觉主题（暗色极简运动风）

采用暗色极简风，深底 + 彩条 + 天辉夜魇胜负色：

- **底色**：页面 `#0e1116` / 卡片 `#161b22` / 分割线 `#232a33`；无边框，靠圆角与留白区隔。
- **文字**：主文字 `#f0f3f6` 亮白 / 次要 `#8a8f99` / 占位 `#5b626d`。
- **胜负语义**（DOTA2 阵营色）：天辉绿 `#5fd35f`=胜 / 夜魇红 `#e8443b`=负。
- **等级色标**：赛事/战队卡左侧 6rpx 彩条——TI 金 `#ffcf5c` / S 绿 `#5fd35f` / A 琥珀 `#f0aa28` / B-C 灰。
- **选中态**：筛选 chip / 分段控件选中=天辉绿底 `#5fd35f`。
- **直播**：绿色脉冲圆点 `#1ec896` + 深色卡片 + 绿色描边。
- **导航栏**：深底白字 tabBar 选中天辉绿。
- **文字**：主文字 `#1d1d1f` 近黑 / 次要 `#86868b` / 占位 `#c7c7cc`。
- **胜负语义**（保留 DOTA2 阵营色）：天辉绿 `#2ba846`=胜 / 夜魇红 `#d12d24`=负（浅底用稍深色保证对比度）。
- **等级彩条**：赛事/战队卡左侧用彩条标识等级（金 `#8a5e0a` TI / 绿 `#1d8a36` S / 琥珀 A / 灰 B-C）。
- **选中态**：筛选 chip / 分段控件选中=黑底白字 `#1d1d1f`，极简克制。
- **直播**：绿色脉冲圆点 `#1ec896` + 白底卡片 + 绿色描边。

全站统一在 `app.wxss` 覆盖 TDesign 设计变量。如需换肤，只改 `app.wxss` 顶部几个变量即可。

## 运行方式

1. 用**微信开发者工具**导入本项目目录（`dota2-esports`）。
2. AppID：项目已设为 `touristappid`（游客模式），可直接预览；真机调试/发布时改成你自己的小程序 AppID。
3. `project.config.json` 中 `urlCheck: false`，开发者工具默认**不校验合法域名**，可直接联调 OpenDota。
4. TDesign 组件已内置，导入即可运行，无需额外构建。

### 真机 / 发布前：配置域名白名单

进入**微信公众平台 → 开发 → 开发管理 → 开发设置 → 服务器域名**，在
`request 合法域名` 添加：

```
https://api.opendota.com
```

若页面要显示战队 logo / 选手头像（来自 Steam CDN），还需在
`downloadFile 合法域名` / `业务域名` 加对应 CDN 域名；或在开发者工具
「详情 → 本地设置」勾选「不校验合法域名、TLS 版本以及 HTTPS 证书」临时调试。

## 数据来源与分级口径

核心比赛数据来自 **OpenDota 公开 API**（https://docs.opendota.com/，免费无需 key）。
用到的主要端点：`/leagues`、`/explorer`（SQL 聚合查询赛事时间窗口）、`/leagues/{id}/matches`、
`/search`、`/teams/{id}`、`/teams/{id}/players`、`/teams/{id}/matches`、`/players/{id}`、
`/players/{id}/matches`、`/heroes`。

为提升**赛事名、时间、队伍成员、选手ID 的准确性与完整性**，本小程序在 OpenDota 之外引入
**多源交叉验证**（详见下文「多源交叉验证与信息可信度」），现有 5 个数据来源：
- **本地权威库**（`utils/curation.js`，零网络永远可用）提供重大赛事的规范名/等级与知名战队的规范名/国家。
- **STRATZ / Steam**（需免费 key）参与「并行采集 + 投票比对」。
- **Liquipedia**（`utils/liquipedia.js`，免费、无需 key）—— 独立人工策展的电竞 wiki，
  提供 OpenDota/STRATZ/Steam 均无的赛事元数据（规范名/日期/奖金池/地点/赛制/主办方）与战队名册，
  作为**真正独立于 Valve 比赛数据**的交叉验证来源。

### 赛事分级（utils/tiers.js）

OpenDota 的 `tier` 是字符串枚举（`professional`/`premium`/`amateur`/`excluded`），口径较粗。
本小程序采用**两级分级**并合并为统一模型 `SSS > S > A > B > C`（rank 4→0）：

- **社区分级（优先）**：基于赛事名的精选规则（`tiers.js` 的 `COMMUNITY_TIERS`），
  例如 `The International` → SSS、`Major`/`Premier` → S、常见职业赛 `ESL One/DreamLeague/...` → A。
  零网络即可用，作为列表快速分级的兜底。
- **OpenDota 回退**：未命中社区规则时，`professional` → S、`premium` → A、`amateur` → B。
- **多源实时分级**：在赛事详情页经由多源编排层（`utils/sources.js`）尝试 STRATZ 解析赛事等级，
  结果更精准；失败自动回退到上面的社区规则。
- 「S级及以上」筛选 = `rank >= 3`（SSS + S）。

修改分级口径只需改 `utils/tiers.js`；统一入口在 `utils/util.js` 的 `unifiedTier()`。

### 赛事时间筛选（全部 / 正在进行 / 即将到来）

赛事页三个 tab 按时间维度筛选 S 级及以上赛事：

- **全部**：所有 S 级及以上赛事，按最近比赛时间（`latest`）倒序排列，最近有比赛的在最前。包含已结束和正在进行的。
- **正在进行**：已开赛且最近 7 天内仍有比赛的赛事（基于 OpenDota 比赛的 `start_time` 判定）。
- **即将到来**：未来约半年（180 天）内开赛的赛事，按 `start` 升序排列。客户端按如下回退链取数，
  任意一层命中即用，保证「即将到来」在任意部署形态（含完全不部署云函数）下都不为空：
  1. **云端实时源（推荐，无需 STRATZ key）**：部署云函数 `aggregation` 后，`tryCloudUpcoming()` 优先读
     云函数预热的 `upcoming_schedule` 缓存（秒开）；`preheatUpcoming()` 在**未配置 STRATZ_API_KEY 时自动改用
     Liquipedia**（`action=parse` 解析 `Portal:Tournaments` 的「Upcoming」表格，取 Tier 1/2 赛事，6h 缓存），
     **自动跟随 Liquipedia 实时赛程**——下半年 Tier 1 赛事（BLAST SLAM IX、Esports Nations Cup 2026、BLAST SLAM VIII、
     PGL Wallachia S9 等）及近期 Tier 2 赛事（EPL Masters I、Games of the Future 2026 等）都会进入列表。
  2. **本地预构建快照（零服务端，无需云函数）**：未部署云函数或云端不可用时，`tryLocalUpcoming()` 读取
     `utils/upcoming-local.json`（由 `scripts/fetch-liquipedia-upcoming.js` 在构建前抓取 Liquipedia 生成，
     当前含 8 个未来 Tier 1/2 赛事）。数据为「抓取那一刻」的**快照，非实时**，刷新需重跑脚本并重新构建发布。
  3. **本地精选库（curation）+ 串行查询兜底**：兜底补充 OpenDota 已有未来比赛记录的赛事及重大赛事日期。
  若已配置 STRATZ_API_KEY，则 `preheatUpcoming()` 优先走 STRATZ（数据最全，含真实联赛 id 便于跳转详情）。

时间窗口的数据来源：
- **OpenDota `/explorer`**：一条 SQL 聚合拿所有赛事近一年的 `{earliest, latest, count}`
  （`api.getLeagueWindows()`），避免逐个拉 `/leagues/{id}/matches`，单次请求即可覆盖全部赛事。
- **云端 `getUpcomingSchedule`（Liquipedia / STRATZ）**：客户端 `tryCloudUpcoming()` 优先读云函数预热的
  `upcoming_schedule` 缓存（秒开）；未命中则现场预热一次（Liquipedia 实时解析，无需 key）。
- **curation 兜底**：云端不可达时，`mergeCurationUpcoming()` 用本地精选库补充未来赛事，保证 tab 不为空。

判定逻辑见 `utils/util.js` 的 `isOngoing()` / `isUpcoming()` / `statusOf()`；
判定参数（进行中缓冲 7 天、即将到来范围 180 天、查询上限）在 `utils/config.js` 的 `leagueWindow`。

## 数据来源多元化（多数据源编排）

为了让「比赛内容来源」不依赖单一接口，本小程序采用 **多数据源编排层**（`utils/sources.js`）：

- **OpenDota**（主源，比赛/对阵/战队/选手，免费无需 key）
- **STRATZ**（第二网络源，GraphQL，免费 key 启用；见下）
- **Steam Web API**（第三网络源，Valve 官方 DOTA2 接口，免费 key；GetLiveLeagueGames 提供正在直播的比分；
  另扩展 GetTournamentPrizePool 奖金池 / GetTournamentPlayerStats 选手赛事统计 / GetMatchDetails 单场详情 / GetTopLiveGame 顶级实时比赛）
- **Liquipedia**（第四网络源，独立人工策展电竞 wiki，MediaWiki action API，**免费无需 key**；
  提供赛事元数据/奖金池/地点/赛制、战队名册、选手资料——**独立于 Valve 比赛数据**，是真正的交叉验证来源）
- **本地精选**（`utils/tiers.js`，基于赛事名的规则，零网络永远可用，作为兜底与快速分级）

`sources` 对 **logo / 头像 / 直播** 仍按 `config.sources` 的优先级顺序取「第一个有效值」；
对 **赛事名 / 分级 / 时间 / 队伍成员** 则走 `utils/consensus.js` 的**并行采集 + 多源投票/比对**
（见「多源交叉验证与信息可信度」）。**任意源抛错都被隔离**，绝不影响其它源或页面渲染。

**战队 logo 与队员头像**同样走多源聚合：
- `sources.enrichTeamLogo()` 按 [STRATZ] 查找 logo，已有有效 logo 则直接跳过
- `sources.enrichPlayerAvatar()` 按 [STRATZ] 查找 Steam 头像，已有则跳过
- 页面加载完成后异步增强，不阻塞主流程；`t-avatar` 组件在 logo 为空时自动展示战队名缩写兜底

### 启用 STRATZ 作为第二网络源

1. 到 https://stratz.com/api 申请免费 API key；
2. 在 `utils/config.js` 设置 `stratz.apiKey` 并把 `stratz.enabled` 设为 `true`；
3. 把 `https://api.stratz.com` 加入小程序 request 合法域名。

未启用时 `sources.js` 不会调用 STRATZ，对现有行为零影响。

### 启用 Steam Web API（直播比分）

1. 到 https://steamcommunity.com/dev/apikey 申请免费 key（需 Steam 账号，100,000 次/天）；
2. 在 `utils/config.js` 设置 `steam.apiKey` 并把 `steam.enabled` 设为 `true`；
3. 把 `https://api.steampowered.com` 加入小程序 request 合法域名；
4. 启用后赛事页顶部出现「直播中 · N 场」实时比分卡片（脉冲绿点动画）。

未启用时 `sources.js` 不会调用 Steam，对现有行为零影响。

### 启用 Liquipedia 作为第四网络源（默认已启用）

Liquipedia 是独立人工策展的电竞 wiki，提供 OpenDota/STRATZ/Steam 均无的赛事元数据（规范名/日期/
**奖金池**/地点/赛制/主办方）与战队名册。**免费、无需 key**，默认 `enabled: true`。

1. 把 `https://liquipedia.net` 加入小程序 request 合法域名（微信公众平台 → 开发设置 → 服务器域名）；
2. 启用后赛事详情页显示「奖金池」与多源徽标，战队详情页成员列表「多源核实」升级为三源（OpenDota/STRATZ/Liquipedia）。

Liquipedia 要求描述性 `User-Agent` 头（已在 `config.liquipedia.userAgent` 配置）并遵守速率限制
（默认串行 + 1500ms 间隔，6h 本地缓存）。请求失败优雅降级为 null/[]，不影响其它源。
**注意**：Liquipedia 名册的 `account_id` 多为 null（HTML 不可靠），当前仅参与 name 匹配验证。

## 多源交叉验证与信息可信度

针对「赛事信息和队伍队员信息不准确」的痛点，本小程序在 `utils/consensus.js` 实现了一个
**交叉验证引擎**，对关键字段做「并行采集 + 投票/比对」，每个字段产出
`共识值 + 参与来源 + 可信度(high/medium/low) + 一致来源数`：

| 关键字段 | 验证方式 | 对应函数 |
|----------|----------|----------|
| 赛事名称 | OpenDota / 本地权威库 / STRATZ / Liquipedia 归一投票（**仅供匹配/索引**，展示走 `sources.leagueDisplayName`） | `sources.voteLeagueNameForMatch()` |
| 赛事分级 | 本地精选 / 本地权威库 / OpenDota / STRATZ 按等级计票 | `sources.getLeagueTier()` |
| 赛事时间 | 本地权威库 / STRATZ / Steam / Liquipedia 时间中位数比对（容差 3 天） | `sources.getLeagueWindow()` |
| 赛事元数据 | Liquipedia（规范名/日期/奖金池/地点/赛制/主办方）+ Steam（奖金池兜底） | `sources.getLeagueMetadata()` |
| 队伍成员 | OpenDota / STRATZ / Liquipedia 名册按 `account_id` 主键合并，≥2 源出现即「多源核实」 | `sources.crossTeamMembers()` |
| 选手 ID | 正整数合法性校验 | `sources.validatePlayerId()` |

**可信度口径（`consensus.confidenceOf`）**：仅当「全部来源一致」才算 `high`；多源（≥3）中多数一致算 `medium`；
任一来源明显冲突（一致数 < 来源总数）一律 `low`，避免误报可信。

**UI 呈现**：赛事详情页顶部显示「数据可信度：可信/较可信/待核实」徽标与规范名提示；
战队详情页成员列表对「多源核实」成员打 `✓ 多源核实` 标，并显示「N/M 已多源核实」整体可信度；
列表/详情页均展示「更新于 X 前」新鲜度。所有来源均为「尽力而为」，单源缺失或异常不影响渲染。

> 扩展权威库：在 `utils/curation.js` 的 `CURATED_EVENTS` / `CURATED_TEAMS` 中按示例增补即可，
> 无需后端，增补后即参与交叉验证。

## 信息更新的及时性（stale-while-revalidate）

为避免展示过期数据，本小程序在 `utils/cache.js` + `utils/api.js` 实现了 **SWR（陈旧即重验）** 机制：

- 缓存写入时记录 `fetchedAt` 采集时间戳；`api.cachedFresh()` 区分「新鲜窗口」与「硬 TTL」：
  - 在新鲜窗口内（如比赛 10 分钟、战队详情 1 小时）→ 直接返回缓存，最省流量；
  - 超过新鲜窗口但未过期 → **先返回旧值，再在后台静默刷新**，用户无感拿到新数据；
  - 已过期/无缓存 → 正常重新拉取。
- 易变数据 TTL 已调短（`config.cacheTTL`）：比赛/战绩 30 分钟硬 TTL（10 分钟新鲜窗口），
  战队/选手详情 6 小时硬 TTL（1 小时新鲜窗口）。
- 页面顶部展示「更新于 X 前」（`util.formatAgo()`，基于真实采集时间戳），下拉刷新立即失效缓存重拉。
- 后台刷新带去重（同一 key 不重复触发），避免浪费 OpenDota 配额。

### 比赛列表的增量拉取（incremental cursor）

针对「比赛列表」这类**大列表**（尤其选手数千场历史），`getLeagueMatches / getTeamMatches / getPlayerMatches`
改用 **`cachedFreshIncremental`**（见 `utils/incremental.js` + `utils/api.js`）：

- **首次 / 硬过期** → 走直连端点（如 `/players/{id}/matches`）**全量拉取并整体替换**；
- **陈旧未过期（后台刷新）** → 不重拉全量，而是用 `utils/incremental.js` 的 `buildMatchSql`
  构造 OpenDota `/explorer` 查询，以本地缓存最新一场的 `start_time` 为**游标**，
  只拉取 `start_time >= 游标` 的比赛，再按 `match_id` 去重（见 `mergeMatches`）并入缓存头部。

收益：把「每次陈旧刷新都重拉整段历史」降为「只拉新增的少量比赛」，大幅降低请求量与流量。
无新数据时仅 `cache.touch()` 刷新采集时间戳（轮询心跳）。

> **★ 字段对齐契约（务必遵守）★**
> 增量 SQL 选出的字段名必须与**直连端点**返回的字段名完全一致，否则 `mergeMatches`
> 合并后新旧比赛字段结构错位，会导致页面渲染**缺字段 / 胜负反转 / 队名丢失**。
> 经 OpenDota `/explorer` 实测确认的对齐关系（见 `utils/incremental.js`）：
>
> | 资源 | 直连端点 | 增量 SQL 用表 | 关键对齐字段 |
> |---|---|---|---|
> | league | `/leagues/{id}/matches` | `matches` LEFT JOIN `teams` ×2 | `radiant_team_name`/`dire_team_name`（COALESCE 从 teams 补全，matches 表此字段常为 null） |
> | team | `/teams/{id}/matches` | `matches` LEFT JOIN `teams` ×2 + `leagues` | `opposing_team_id`/`opposing_team_name`（CASE 计算）、`radiant` 布尔 |
> | player | `/players/{id}/matches` | `player_matches` JOIN `matches` LEFT JOIN `leagues` | `player_slot`（胜负判断依赖）、`radiant_win`/`duration`/`start_time`（来自 matches） |
>
> 已修复的历史问题（2026-07）：早期 league SQL 误用 `radiant_name`/`dire_name`/`radiant`（matches 表不存在）、
> team SQL 误用 `team_match_history` 视图（不存在）、player SQL 漏选 `player_slot` 且误用 `player_matches` 的 match 级字段，
> 导致三个增量 SQL **全部 HTTP 400**、增量拉取永久失效（且被 `.catch(()=>{})` 静默吞错）。
> 修复后增量 SQL 全部验证通过，`cachedFreshIncremental` 的 catch 已改为 `console.warn` 暴露错误。
>
> 此外，`/leagues/{id}/matches` 直连端点的 `radiant_team_name`/`dire_team_name` 普遍为 `null`（OpenDota 未存），
> `pages/league-detail` 在 `load()` 后异步调 `api.getTeamNames(ids)`（一次 `/explorer` SQL 批量查 `teams.name`）
> 回填空队名，避免联赛列表队名全部缺失（兜底显示"天辉/夜魇"）。

## 缓存与限流（utils/cache.js + utils/api.js）

OpenDota 默认约 **60 次/分钟**限流。本小程序做了两层保护：

- **本地缓存（TTL）**：`api.js` 的所有对外方法默认走 `cached()`，命中缓存直接返回、
  **不计入限流**。各接口 TTL 见 `utils/config.js` 的 `cacheTTL`（如赛事列表 10 分钟、战队详情 1 小时）。
- **请求限流器**：`request()` 串行保留最小请求间隔（`config.rateLimit.minGapMs`），
  遇 `429` 指数退避重试（`maxRetries` 次）。
- **搜索防抖 + 本地历史**：战队搜索（`pages/teams`）输入实时回调只更新关键词，
  **防抖 400ms** 后才真正请求 OpenDota `/search`，避免逐字触发；搜索成功的关键词写入
  `utils/searchHistory.js`（Storage 持久化，最多 10 条、去重置顶），热门模式展示为可点击的
  「最近搜索」标签，二次搜索免输入、免再请求。
- **远程 curation（可选热更新）**：`utils/remoteCuration.js` 在 `utils/config.js` 的 `remoteCuration.url`
  填入远程 JSON 地址后，启动时自动拉取，以**同键覆盖 + 追加**的方式更新本地 `CURATED_EVENTS` / `CURATED_TEAMS`，
  并缓存到 Storage（TTL 6h）。拉取失败静默回退本地，不影响页面渲染。JSON 形状与 `curation.js` 条目一致
  （`{ events: [...], teams: {...} }`）。不配置 URL 时完全离线，无网络请求。

页面层还做了**分页加载**（`onReachBottom` 加载更多 / `appendPage`），避免一次拉全量数据。

## 关注订阅（utils/follow.js + utils/subscribe.js）

- **本地关注**：关注数据存于本机 Storage（结构 `{ teams, players, leagues }`），无需登录/后端。
  各详情页有「关注/已关注」按钮，底部「关注」tab 是关注中心，可查看、跳转、取消关注。
- **订阅消息**：`utils/subscribe.js` 封装了 `wx.requestSubscribeMessage`。
  在微信公众平台「订阅消息」申请模板后，把模板 id 填入 `utils/config.js` 的
  `subscribeTemplateId`，点击「开启赛事提醒」即可申请授权；未配置模板时自动跳过，不影响本地关注。

## 目录结构

```
dota2-esports/
├── app.js / app.json / app.wxss        # 全局配置、暗色主题、英雄预加载
├── project.config.json                 # 开发者工具配置（urlCheck:false、packNpmManually:true）
├── sitemap.json
├── package.json                        # tdesign-miniprogram 依赖（构建 npm 用）
├── miniprogram_npm/tdesign-miniprogram/  # TDesign 构建产物（已 vendor，无需构建）
├── utils/
│   ├── api.js          # OpenDota API 封装 + 限流 + 缓存请求（cached/cachedFresh/cachedFreshIncremental SWR）
│   ├── cache.js        # 本地带 TTL 缓存；记录 fetchedAt、支持 getStale/peek/touch（SWR + 新鲜度）
│   ├── incremental.js  # 比赛列表增量拉取纯函数：maxStart / mergeMatches / buildMatchSql（可被 Node 单测）
│   ├── config.js       # 缓存 TTL、限流参数、分页大小、订阅模板 id、多源配置
│   ├── consensus.js    # 多源交叉验证引擎：名称/时间/分级投票、成员交叉比对、ID 校验
│   ├── curation.js     # 常驻权威库（重大赛事规范名/等级、知名战队），零网络第二可信源
│   ├── tiers.js        # 社区分级规则（赛事名，零网络兜底）
│   ├── stratz.js       # STRATZ GraphQL 第二网络源（需 key，默认关闭）
│   ├── steam.js        # Steam Web API 第三网络源（需 key；直播比分 + 奖金池/赛事统计/单场详情/顶级实时）
│   ├── liquipedia.js   # Liquipedia 第四网络源（免费无 key；赛事元数据/奖金池/战队名册/选手资料）
│   ├── sources.js      # 多数据源编排层：优先级聚合 + 多源交叉验证（名称/分级/时间/元数据/成员/直播）
│   ├── follow.js       # 关注订阅的本地存储
│   ├── subscribe.js    # 微信订阅消息脚手架
│   └── util.js         # 格式化、胜负判定、统一分级 unifiedTier()、formatAgo 新鲜度
└── pages/
    ├── leagues/        leagues.*
    ├── league-detail/  league-detail.*
    ├── teams/          teams.*
    ├── team-detail/    team-detail.*
    ├── player-detail/  player-detail.*
    ├── follow/         follow.*
```

## 已知限制 / 后续

- 选手关注入口已在 `player-detail` 接出（资料卡右上角星标），与战队/赛事页一致。
- 多源增强为「尽力而为」：STRATZ/Steam 未启用时自动降级到本地精选 / OpenDota，不影响核心功能。
- **多源交叉验证**已落地：即使仅启用 OpenDota，本地权威库（`curation.js`）也作为第二可信源参与
  赛事名/分级/成员的比对，修正名称不一致；启用 STRATZ/Steam 后比对维度进一步增强。
- 信息更新及时性：SWR 后台刷新 + 「更新于 X 前」新鲜度提示，避免展示过期数据。
- 关注数据存于本机，换设备/清缓存会丢失；如需跨设备同步，可接入云开发。
- 可继续扩展：赛事直播（`/live`）、订阅消息实际推送、更细的社区分级、权威库数据扩充、数据预拉取。


## 上线前检查清单（必做）

### 1. 服务器域名白名单（小程序后台 → 开发 → 开发管理 → 服务器域名）

在 `request 合法域名` 中添加以下域名（按启用的数据源配置）：

| 域名 | 数据源 | 必需性 |
|---|---|---|
| `https://api.opendota.com` | OpenDota（主源） | ✅ 必需 |
| `https://api.stratz.com` | STRATZ GraphQL | 启用 STRATZ 时必需 |
| `https://api.steampowered.com` | Steam Web API | 启用 Steam 时必需 |
| `https://liquipedia.net` | Liquipedia MediaWiki API | 启用 Liquipedia 时必需 |

> 开发阶段可在微信开发者工具「详情 → 本地设置」勾选「不校验合法域名」临时跳过；
> **上线前必须取消勾选并在后台配齐域名**，否则正式版无法发起请求。

### 2. urlCheck 已开启

`project.config.json` 的 `setting.urlCheck` 已设为 `true`，开发工具会校验请求域名是否在白名单内。
若开发时需临时关闭，改回 `false`，但**上线前必须改回 `true`**。

### 3. 隐私协议页

小程序已包含 `pages/privacy/privacy` 隐私协议页，并在 `app.json` 配置 `__usePrivacyCheck__: true`。
微信审核要求所有小程序必须声明隐私协议，即使不使用隐私 API（本小程序未使用 getUserInfo/getLocation 等敏感 API）。

### 4. STRATZ / Steam / Liquipedia API Key 配置

在 `utils/config.js` 中按需配置（参见各配置段顶部的步骤注释）：
- `stratz.enabled: true` + `stratz.apiKey`（云函数环境变量）— 启用后「即将到来」优先走 STRATZ 赛程
- `steam.enabled: true` + `steam.apiKey`（云函数环境变量）— 启用后可获取官方奖金池/战队信息
- `liquipedia.enabled: true` — 启用后获取人工策展的赛事元数据（无需 key）；**且是「即将到来」tab 在无 STRATZ key 时的默认实时来源**（云函数 `aggregation` 的 `fetchLiquipediaUpcoming` 解析 `Portal:Tournaments`）

**无需任何 key 即可获得「即将到来」实时赛程**：只要部署了云函数 `aggregation` 且 `cloudProxy.enabled: true`，
「即将到来」tab 就会经 Liquipedia 自动填充下半年 Tier 1/2 赛事；本地 curation 仅在云端不可达时兜底。

配置后在微信开发者工具 Console 顶部查看：
- `[stratz] ✅ ENABLED: true` 确认 STRATZ 生效
- `[liquipedia] ✅ ENABLED: true` 确认 Liquipedia 生效

### 5. 直播功能已下线

本小程序不含任何直播比赛功能（代码/页面/入口/数据源已全部清理）。
Steam `GetLiveLeagueGames` / STRATZ `live.matches` / `sources.enrichLiveGames` 均已移除。

### 6. 实时比分后端契约（T4）

`utils/realtime.js` 已实现客户端连接层（WebSocket + 断线指数退避重连 + 超时降级为 30s 轮询 OpenDota）。
未配置后端时自动降级轮询，**无需后端即可运行**；接入后端后体验为真正的实时推送。

**部署后端后需做两件事：**

1. 在 `utils/config.js` 的 `realtime.url` 填入 wss 地址，例如：
   ```js
   realtime: { url: 'wss://realtime.your-domain.com/realtime', pollInterval: 30000, heartbeat: 25000, maxReconnect: 5 }
   ```
2. 在微信公众平台「开发 → 开发管理 → 服务器域名 → socket 合法域名」添加该 `wss://` 域名。

**消息契约：**

- 客户端 → 服务端（连接后先发订阅，再按 heartbeat 周期发 ping）：
  ```json
  { "type": "subscribe", "matchId": 123456 }
  { "type": "ping" }
  ```
- 服务端 → 客户端（比分变化时推送，match 为 OpenDota `/matches/{id}` 全量对象）：
  ```json
  { "type": "score", "match": { "radiant_score": 1, "dire_score": 0, "radiant_gold_advantage_timeline": [...], ... } }
  ```
- 数据源建议：后端定时（≤30s）轮询 OpenDota `/matches/{id}` → 聚合 → 经 WebSocket 推送给订阅该 matchId 的客户端；客户端 `match-detail` 在 `isLive` 时自动建立连接，`onUnload` 自动关闭。

> 注意：微信小程序 WebSocket 必须走 `wss://` 且域名需备案并加入 socket 合法域名；CloudBase 原生不提供裸 WebSocket 服务端端点，需自建或使用第三方实时通道。

### 7. A/B 实验后端契约（T6）

`utils/experiment.js` 已实现客户端实验框架（启动拉取分组、本地缓存、variant 灰度开关、转化埋点）。
无后端时回退到 `utils/experiment.js` 内 `DEFAULTS`，**离线可用**。

**部署后端后：**

1. 云函数 `cloudfunctions/aggregation` 已实现 `getExperiments` action，返回实验配置：
   ```json
   { "experiments": { "follow_cta_variant": { "variant": "A", "enabled": true } } }
   ```
2. 生产环境应改为读取云数据库 `experiments` collection，并按用户（openid）稳定分桶，保证同一用户分组不变。
3. 客户端通过 `experiment.getVariant('follow_cta_variant', 'A')` 取分组、`experiment.track(...)` 记转化（当前本地缓存，生产应上报分析后端）。

**已实装开关：** 关注页（`pages/follow`）空态 CTA 文案 A/B（`follow_cta_variant`：A=去发现战队 / B=浏览热门战队），在 `onShow` 读取分组并 `track` 点击转化。

