# DOTA2 赛事小程序 · 项目全景

> 生成时间：2026-07-30 ｜ 用途：项目重新全面认知（架构 / 数据流 / 模块职责 / 已知坑）
> 路径：`D:\WorkBuddy项目文档\2026-07-19-15-21-29\dota2-esports\`

---

## 1. 项目定位与技术栈

**一句话**：一个 DOTA2 电竞赛事数据小程序，聚焦 **S 级及以上赛事、战队成员与历史、双方对战胜负**，原生小程序 + TDesign 组件库，暗色电竞风 UI。

| 维度 | 内容 |
|---|---|
| 形态 | 微信小程序（appid `wx838148b512800a3a`，libVersion 3.0.0） |
| 语言/框架 | 原生 WXML/WXSS/JS + TDesign 小程序组件库（`tdesign-miniprogram@^1.15.3`） |
| 后端 | 单云函数 `aggregation`（CloudBase / wx-server-sdk + got），承担 OpenDota 代理、Liquipedia 抓取、STRATZ/Steam 直连、数据聚合、cron 预热 |
| 数据源 | **OpenDota**（主，赛事/战队/英雄/物品/比赛）、**Liquipedia**（奖金池/阵容/赛程/logo 元数据）、**STRATZ**（GraphQL，已停用）、**Steam Web API**（奖金池/logo 兜底）、**本地 curation**（人工分级/收录/展示名） |
| 状态管理 | 无 mobx/store，跨页共享靠 `app.globalData`（heroMap/itemMap 预加载）+ 各 util 的内存/Storage 缓存 |
| 构建 | `packNpmManually: true`（手动构建 npm）；husky pre-commit 跑 ESLint + `npm test`（canonical 58 断言） |
| 测试 | `npm test`（test-canonical）、`npm test:all`（sources+consensus+canonical）；含 G13/G14/G15 双源一致性闸门 |

---

## 2. 总体架构（多源数据融合）

```
┌─────────────────────────── 微信小程序（前端） ───────────────────────────┐
│  pages/ (5 tab) + subpackages/detail + subpackages/data                  │
│        │ 所有数据请求经 utils/api.js 封装                                   │
│        ▼                                                                 │
│  utils/api.js  ──request()──► 滑动窗口限流 + 429/5xx 重试                  │
│        │  config.cloudProxy.enabled ? 走云函数 : 直连 OpenDota            │
│        ├──────────── cloudBreaker（连续失败3次熔断→回退直连）────────────┤
└────────┼────────────────────────────────────────────────────────────────┘
         ▼
┌────────────────────── 云函数 aggregation（CloudBase） ──────────────────────┐
│  exports.main 按 action 分发：                                            │
│   • OpenDota 代理（got + safeFetch 指数退避，L1 内存 + L2 cloud DB 缓存）  │
│     getLeagues / getLeagueMatches / getLeagueWindows / getTeam(s) /       │
│     getPlayer(s) / getHeroes / searchTeams                               │
│   • 专用 HANDLERS（Map 路由 O(1)）：                                       │
│     liquipediaLeagueMeta / liquipediaScheduledMatches / liquipediaTeamLogo│
│     / liquipediaListTournaments / liquipediaPrewarm / getLiquipediaUpcoming│
│     / getUpcomingSchedule / stratzGql / steamProxy / 搜索+战队索引 /      │
│     订阅消息 / 关注画像                                                    │
│   • handleTimer(cron) 预热热端点                                          │
└────────┬────────────────────────────────────────────────────────────────┘
         ▼
┌──────────────── 多源融合编排（utils/sources.js 为中枢） ────────────────────┐
│  getLeagueMetadata：并行 Liquipedia(全量元数据) + Steam(奖金池兜底) → 合并  │
│  getLeagueTier   ：community/curation/opendota/stratz/liquipedia 五候选    │
│                    → consensus.consensusTier 加权投票 → SSS/S/A/B/C        │
│  getLeagueWindow ：多源时间中位数比对                                       │
│  leagueDisplayName / canonicalLeagueName：展示名单一出口（canonical 优先）  │
└─────────────────────────────────────────────────────────────────────────┘
```

**关键设计**：Liquipedia 走云端而非 `wx.request`，根因是小程序**无法设置 User-Agent**，而 Liquipedia 强制要求 UA；云函数（Node）可以。

---

## 3. 云后端 `cloudfunctions/aggregation/index.js`

单文件单入口，按 action 分发。要点：
- **OpenDota 代理**：`buildPath`/`resolveTtl` 路由；`safeFetch` 对 5xx/429 做指数退避；两级缓存（L1 内存 + L2 cloud DB），key 带 `dataVersion` 前缀（部署即失效）。
- **专用 action** 走 `HANDLERS` Map（O(1) 分发），覆盖 Liquipedia 抓取/预热、STRATZ/Steam 直连、搜索索引、订阅消息、关注画像。
- **不调用外部云函数**；STRATZ/Steam 均 HTTPS 直连（key 取环境变量）。
- **改完后必须重新「上传并部署：所有文件」**——本地改 `index.js` / `liquipedia-parse.js` / `liquipedia-slugmap.json` 不会自动生效。

---

## 4. 数据 API 编排 `utils/api.js` + `utils/sqlFragments.js`

- `api.js` 封装 OpenDota，导出 `getLeagues/getLeagueWindows/getLeagueMatches/getMatch/getMatchPlayers/searchTeams/getTeam*/getHeroes/getHeroStats/getItems` 等。
- `request()` 带滑动窗口限流 + 429/5xx 重试；`cached/cachedFresh/cachedFreshIncremental` 实现 TTL、stale-while-revalidate、增量游标合并（省流量）。
- SQL 片段集中在 `sqlFragments.js`，云函数侧保留同步副本。**赛事列表窗口当前是 `interval '6 months'`（近半年，已收敛自原 1 年）**；`LEAGUE_WINDOWS_SQL` 按 leagueid 聚合 min/max/last_end/count。

---

## 5. 多源数据融合（核心编排）

| 模块 | 职责 |
|---|---|
| `utils/sources.js` | 编排中枢：合成赛事卡片（Liquipedia+Steam）、定级（五源共识）、时间窗、展示名 |
| `utils/consensus.js` | `consensusTier` 加权投票（curation 权重 > opendota），输出 SSS/S/A/B/C |
| `utils/curation.js` | `CURATED_EVENTS`(220 条)/`CURATED_TEAMS`，人工分级/收录/赛期权威；`remoteCuration` 远程覆盖 |
| `utils/liquipedia-parse.js` | 纯函数解析 wikitext：`parseLeagueMetadata/parseScheduledMatches/parseLeagueTier/parseTeamLogo`（client/cloud 双源字节一致，G14 闸门） |
| `utils/liquipedia.js` | 经云代理调云函数抓 wikitext；`liquipediaSlugFor` 走 slugmap |
| `utils/liquipedia-slugmap.json` | **123 条** OpenDota 名→Liquipedia slug 映射（2026-07-28 收敛自原 146，剔除 23 条错配）。直查命中率仅 ~2.5%，映射后显著提升 |
| `utils/stratz.js` | STRATZ GraphQL（**当前 `stratz.enabled=false`，Cloudflare 拦截已停用**） |
| `utils/steam.js` | Steam Web API 奖金池/logo 兜底，走云代理，key 由环境变量注入 |

**赛事收录与分级**：
- S/A 判定：`communityTierFromName` 正则（排除预选/业余/慈善）+ curation 显式 tier；Liquipedia Tier1→S、2→A、3→B、4→C。
- **收录条件**：`rank>=1` 门槛 + curation 数据；OpenDota 仅返已开赛赛事，**未开赛且未写 curation 的 S/A 会漏收**（需定期跑 `curation-coverage.js` 补）。
- 展示名统一走 `canonicalLeagueName`（curation canonical → 共识 → 原始），全站禁用直接渲染 OpenDota `l.name`。

---

## 6. 前端：页面与分包

**主包（5 tab + 搜索）**：
| 页面 | 职责 | 数据源 |
|---|---|---|
| `pages/index` 首页 | 关注战队「下一场」横向卡片流 + S/SSS 推荐位；每秒自绘倒计时 | `follow.list` + `api.getTeamMatches` |
| `pages/leagues` 赛事 | 全部/进行中/已结束/即将到来 + 等级筛选 + 智能排序 + 战队筛选 + 列表/周轴视图 | `getLeagues/getLeagueWindows`，upcoming 三级回退（云缓存→`upcoming-local.json`→sources） |
| `pages/teams` 战队 | 热门预设 + 本地模糊搜索 + OpenDota `/search` | `api.getTeam` 补 logo/rating |
| `pages/follow` 关注 | 战队/赛事双 Tab，纯本地；订阅状态 + `reminderStrategy` 智能提醒 | 本地 `follow.list` |
| `pages/data` 资料库 | 英雄/物品入口；`onShow` 预载 data 分包 | — |
| `pages/search` 搜索 | 跨赛事/战队/物品分组结果 + 纠错 + 历史 | 本地 + OpenDota |

**分包**：
- `subpackages/detail`（league-detail / match-detail / team-detail / h2h / privacy）：详情页；league-detail 并行 OpenDota+Liquipedia 赛程，三段式 LIVE/UPCOMING/RECENT，Tab 赛程/战队/排名；match-detail 含经济/经验曲线 + `realtime` + F1 直播入口。
- `subpackages/data`（hero / hero-detail / item / item-detail）：英雄/物品库，属性筛选 + 胜率排序 + 合成树。

**preloadRule**：`index/leagues/teams` 预载 detail 包；`data` 预载 data 包；`search` 仅 wifi 预载 data 包（双重 `wx.preloadSubpackage` 保障）。

---

## 7. 前端：组件与自定义 tabBar

- **自定义组件**（`components/`，均 `styleIsolation: isolated`）：`anchor-card`(KPI 卡)、`chart`(V4 自绘经济/经验双序列+事件标记)、`empty-state`、`image-fallback`(logo 失败回退首字母圆)、`live-card`(F1 直播聚合)、`onboarding`、`skeleton`。除 `empty-state` 外均不依赖 TDesign。
- **自定义 tabBar**（`custom-tab-bar/`，对应 `app.json` `tabBar.custom:true`）：5 项（首页/赛事/战队/关注/资料库），`getTabBar().setData({selected})` 同步选中态，`env(safe-area-inset-bottom)` 安全区适配，低端机降级关 `backdrop-filter: blur`。

---

## 8. 工具层与状态/缓存/关注/订阅

**缓存**：`cache.js`（本地 Storage TTL，stale-while-revalidate，6MB 超阈值 LRU prune）；`cloudCache.js`（云端跨设备缓存，优先云端回退本地双写）；`cloudProxy.js`（云代理封装）；`cloudBreaker.js`（连续失败 3 次熔断，成功复位）。

**关注与订阅**：`follow.js`（本地关注 teams/leagues，存 `dota2_follow`，无需登录）；`subscribe.js`（微信订阅消息，模板已配，24h 冷却 + 日限 5）；`reminderStrategy.js`（提前量+分级 SSS/S/A 过滤）；`searchHistory.js`（最多 10 条）。

**实时与直播**：`realtime.js`（WebSocket 骨架，断线指数退避降级轮询）；`liveSources.js`（B站/虎牙/斗鱼深链聚合，不抓流）；`eventLifecycle.js`（赛事生命周期状态机，`ongoingBufferSec=2h`）。

**A/B 与监控**：`experiment.js`（云端分组，失败回退本地 DEFAULTS）；`monitor.js`（`wx.reportAnalytics` 仅生产环境，同会话去重）。

**图片/LOGO**：`image.js`(`optimizeImageUrl`/`toLogoUrl`)、`logoCache.js`(30天 TTL)、`logoPreload.js`(**因 `proxyBase` 未填整体 no-op**)、`steam.js`。

**基础工具**：`util.js`(nowSec/formatTime/isOngoing/statusOf/validateLeagueWindow 等)、`heroes.js`/`items.js`/`neutralItems.js`/`itemZh.js`(英雄/物品中文名)。

---

## 9. 设计系统（暗色电竞风）

- `app.wxss` 导入 TDesign token 后**强制暗色覆盖**：主题色 **DOTA2 暗金 `#C8A951`**（替换 TDesign 默认蓝）；胜绿 `#5fd35f` / 负红 `#e8443b` 语义色；背景 `#0e1116`、卡片 `#161b22`。
- Tier 五级色 Token（SSS 亮金 / S 暗金 / A 紫 / B 蓝 / C 灰）单一来源。
- `.container.with-tab-bar` 预留 `160rpx + env(safe-area-inset-bottom)`；每个 tab 页根容器加 `with-tab-bar` 类。

---

## 10. 关键特性与已知坑

**✅ 已落地**：
- Liquipedia 集成（云端抓取 + slugmap + 双源一致性闸门 G14/G15），命中率从直查 2.5% 提升到映射后显著水平。
- 近半年窗口收敛（probe `inWindow` 182 天 + 列表 SQL `6 months` + 预热上限 50），缓解时间成本/影响范围。
- 比赛收录优化（`6bfbce7`）：修复未收录（模糊匹配后缀）、收录错误（rank 误排/静默升 S/正则过宽/重复卡）。

**⚠️ 已知坑 / TODO**：
1. **LOGO 慢（P0 未落地）**：`config.images.proxyBase` 为空，无法走代理缩放；第三方 CDN `cdn.cloudflare.steamstatic.com` 须加入 downloadFile 合法域，否则 logo 404。
2. **无集中式状态管理**：globalData 需页面自行守卫 `heroReady/itemReady`。
3. **STRATZ 已停用**（`stratz.enabled=false`）。
4. **赛事收录漏收风险**：未开赛且未写 curation 的 S/A 必漏，需定期跑 `coverage`。
5. **部署纪律**：改云函数/parse/slugmap 后必须手动「上传并部署：所有文件」，sync 脚本只更新磁盘镜像不触达云端。
6. **npm 构建**：`packNpmManually:true` + tdesign 被 gitignore；拉新代码须 `npm install` + 开发者工具「构建 npm」，否则 `t-*` 缺失初始化崩。

---

## 11. 近期变更脉络（来自工作记忆）

- **2026-07-28**：Liquipedia slugmap 接入 + 近半年窗口收敛 + 双源一致性修复，整包提交 `fd3ef36`（24 文件，58/0）；剔除 14 条 ESL One 等届次/年份错配（ESL One 系列系统性塌缩）；修复 `liquipedia-parse.js` 云/端漂移（G14）。
- **2026-07-30**：比赛收录功能优化，提交 `6bfbce7`（4 文件，test:all 38/0 + 48/0 + 58/0），修复未收录与 4 类收录错误。

---

## 12. 构建与部署要点速查

| 动作 | 命令 / 位置 |
|---|---|
| 静态检查 + 测试 | `npm run check:syntax` / `npm test` / `npm test:all` |
| 同步 slugmap 到云端镜像 | `npm run sync:slugmap`（改 slugmap 后必跑） |
| 同步 parse / canon | `npm run sync:parse` / `npm run sync:canon` |
| Liquipedia 预热 | `npm run prewarm:liquipedia` |
| curation 覆盖检查 | `npm run coverage`（或 `--offline`） |
| 部署云函数 | DevTools 右键 `cloudfunctions/aggregation` → **「上传并部署：所有文件」** |
| 构建 npm | DevTools 工具栏「工具 → 构建 npm」（tdesign 手动打包） |
