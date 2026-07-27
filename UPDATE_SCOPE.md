# DOTA2赛事 · 本轮优化更新范围报告（UPDATE_SCOPE）

> 依据 `OPTIMIZATION_PLAN.md` 对项目的全面更新。本报告覆盖 **T1 / F1（前序）+ V1 / T2 / T3 / I3 / I4 / F2 / I5 / V2 / V3 / F3（前序本轮）+ V4 / T4 / T6（本轮客户端骨架）**。
> 代码已通过 ESLint 校验：**0 error**；其余 warning 均为历史存量（`no-var`/`no-return-await`），本轮新增文件无 warning。

> ⚠️ **资讯（资讯流 F2）模块已于 2026-07-25 移除**：删除 `pages/news/` 页面、`app.json` 中 `pages` 数组与 `tabBar` 第 4 项「资讯」、`curation.NEWS_SOURCES`、`aggregation` 的 `getLiquipediaRecentChanges` action 与 `news_sort` 实验位，以及 `liquipedia.getRecentChanges` / `cloudProxy.recentChanges` 配套方法。下方「F2 · 资讯流」及相关 news 条目为**历史记录**，当前代码库中已不存在。

---

## 一、已落地（Implemented）

### T1 · apiKey 迁移到云函数（前序）
- `utils/config.js`：移除硬编码 STRATZ JWT；客户端 `apiKey` 留空（小程序运行时无 `process` 全局变量，不能读 `process.env`），密钥统一由云函数服务端环境变量 `STRATZ_API_KEY` / `STEAM_API_KEY` 注入；启用 `steam` 与 `cloudProxy`。
- `utils/cloudBreaker.js`（新增）：独立熔断器模块，避免 `api.js ↔ cloudProxy.js` 循环依赖。
- `utils/cloudProxy.js` / `utils/api.js` / `utils/stratz.js` / `utils/steam.js` / `utils/liquipedia.js`：接入熔断器与云代理。
- `cloudfunctions/aggregation/index.js`：新增 `steamProxy`、`getLiquipediaRecentChanges` 等 action。

### F1 · 直播聚合入口（前序）
- `utils/liveSources.js`（新增）、`components/live-card/*`（新增）。
- `subpackages/detail/league-detail`、`match-detail`：注入 `live-card` 并接入直播态判定。

### V1 · 品牌识别度建立（本轮）
**目标**：确立 DOTA2 暗红 `#A41E1E` + 暗金 `#C8A951` 强调色，区别于 TDesign 默认蓝；保留胜=绿/负=红语义不冲突。
- `app.wxss`
  - 品牌 token 由天辉绿切换为暗金：`--td-brand-color` 等改为 `#C8A951`；新增 `--dota-red / --dota-gold / --dota-gold-soft` 等品牌变量。
  - `.filter-bar .chip.active`、`.seg-item.active` 选中态改用 `var(--dota-gold)`。
  - 新增 `.brand-logo`（纯 CSS DOTA2 风格标识，红盾+暗金描边+“D2”）、`.brand-header` 品牌栏类。
- `app.json`：`tabBar.selectedColor` 由 `#5fd35f` 改为 `#C8A951`。
- `pages/leagues/leagues.wxml`：顶部新增品牌栏（Logo + 名称 + 副标题）。
- `pages/leagues/leagues.wxss`：随品牌 header 适配（无独立品牌样式需求，复用全局类）。

### T2 · 按需注入（本轮）
- `project.config.json`：`setting` 新增 `"lazyCodeLoading": "requiredComponents"`，按页加载所用组件，降低启动耗时。

### T3 · 图片加载优化（本轮）
- `components/image-fallback/*`（新增）：通用图片占位/容错组件，统一处理「无图 / 加载中 / 加载失败」三态，品牌色首字母占位 + 懒加载 + 列表复用重置。
- `utils/image.js`（新增）：`optimizeImageUrl()` 仅对白名单 CDN（OpenDota）追加 `?w=&h=` 缩略图参数，安全不破坏未知 CDN。
- `utils/sources.js`：`enrichTeamLogo` / `enrichPlayerAvatar` 返回前调用 `optimizeImageUrl`。
- `subpackages/detail/team-detail/team-detail.wxml` + `.json`：头部 Logo 与成员头像改用 `image-fallback`。
- `subpackages/detail/player-detail/player-detail.wxml` + `.json`：头部头像改用 `image-fallback`。
- 同步清理两处详情页已失效的 `-img` / `-ph` 旧样式类（死代码）。

### I3 · 新手引导（本轮）
- `components/onboarding/*`（新增）：首次启动 3 步引导（赛事→关注→详情），完成/跳过写入 `Storage('onboarded')` 防重复。
- `pages/leagues/leagues.json` + `leagues.wxml`：注册并挂载 `<onboarding/>`。

### I4 · 搜索增强（本轮）
- `pages/teams/teams.js`
  - 新增 `HOT_KEYWORDS` 热门搜索推荐词。
  - 新增 `editDistance`（Levenshtein）与 `buildSuggestion`（编辑距离 ≤2 纠错建议）。
  - `runSearch` 无结果时计算并下发 `suggestion`；新增 `onTapHotWord`、`onTapSuggestion` 处理器；清空/切换类型/空输入时重置建议。
  - `data` 新增 `hotWords`、`suggestion`。
- `pages/teams/teams.wxml`：热门模式新增「热门搜索」词 chips；战队/选手空结果处新增「你是不是想搜：XXX」纠错入口。
- `pages/teams/teams.wxss`：新增 `.hot-words` / `.sug` 等样式。
- 历史标签此前已实现前置展示 + 一键清空（保持不变）。

### F2 · 资讯流（本轮 · 已移除 2026-07-25）
- `utils/curation.js`：新增 `NEWS_SOURCES` 权威资讯源目录并导出（顺序已修正，避免 TDZ 报错）。
- `pages/news/news.{js,wxml,wxss,json}`（新增）：资讯页，含 Liquipedia 近期更新（经云函数代理合规获取）+ 权威源目录；骨架/空态/降级完备；点击复制外链。
- `app.json`：`pages` 新增 `pages/news/news`；`tabBar` 新增第 4 个 tab「资讯」。

### I5 · 跨页状态（本轮）
- `pages/leagues/leagues.js`：新增 `onPageScroll`/`onHide`/`onShow`，持久化并还原 `filter / gradeFilter / keyword / scrollTop`（首次 `onShow` 跳过，避免覆盖初始数据；upcoming 未加载则补拉）。
- `pages/teams/teams.js`：同上，持久化并还原 `searchType / keyword / scrollTop`，返回时从 `allResults` 还原或重搜。

### V2 · 动效与过渡（本轮）
**目标**：缓解「动效克制过度」，提升流畅感与高级感（计划 V2 中客户端可控部分）。
- `app.wxss`：新增 `@keyframes fadeUp / fadeIn` 与工具类 `.anim-fade-up`（错峰淡入+上滑）、`.anim-fade`（内容一次性淡入）、`.tap-scale`（按压微缩放 hover-class）。
- 列表项入场：leagues / teams（战队卡+选手卡）/ follow / news 的列表项统一接入 `anim-fade-up`，内联 `animation-delay: {{ (index % 12) * 50 }}ms` 做错峰（取模避免 loadmore 追加项延迟过大）；该项仅存在于 `wx:else`（非 loading）分支，天然实现骨架屏 → 真实内容的 cross-fade。
- 按压反馈：`league-item` 补 `hover-class="tap-scale"`；`team-card`（原有 scale）、`player-card`、`.follow-card`、`.news-item` / `.src-item` 的 hover 类补 `transform: scale(.99)` 微缩放。
- **未落地项**：页面级转场（计划 V2 第 1 点）需 Skyline 渲染引擎，WebView 下转场由小程序系统控制，暂不可控，留待 Skyline 迁移评估。

### V3 · 空状态升级（本轮）
**目标**：无数据时不显简陋，区分场景并配引导按钮。
- `components/empty-state/*`（新增）：统一空态组件，按 `type`（follow / search / error / nostart / empty）渲染品牌图标（TDesign 图标，金色调）+ 标题 + 描述 + 可选引导按钮，点击触发 `bind:action` 交由页面处理，组件零业务耦合。
- 接入点：
  - `pages/follow/follow`：无关注 → `type=follow`「去发现战队」（`wx.switchTab` 到战队 Tab）。
  - `pages/leagues/leagues`：加载失败 → `type=error`「重试」；列表为空 → `type=empty`（stratz 禁用分支仍保留原 `hint-card` 详细说明）。
  - `pages/teams/teams`：加载失败 → `type=error`「重试」；战队/选手无结果 → `type=search`「重新搜索」(`onClear`)，并保留「你是不是想搜」纠错入口。
  - `pages/news/news`：近期更新为空 → `type=empty`「刷新」(`onRetry`)。
- 同步清理两页已失效的 `.error-block` / `.retry-wrap` 死样式，移除 teams 未使用的 `t-empty` 注册。

---

### F3 · 英雄/物品数据库深化（本轮）
**目标**：补全游戏基础数据深度（计划 F3）。全部数据来自 OpenDota 公开 API（`api.opendota.com`，已在用，**不新增域名白名单**、**不依赖后端**，走既有缓存/限流/云代理回退）。英雄/物品头像用属性色+首字母占位（不拉远程图，避免新域名）。
- `utils/api.js`
  - 新增 `getHeroStats()`（`/heroStats`：职业登场/胜/禁）、`getHeroMatchups(id)`（`/heroes/{id}/matchups`：同场胜负样本）、`getItemsList()`（物品基础表；**原 `/items` 端点已被 OpenDota 下线(404)，现改读 `/constants/items` 并转数组：价格/配方由 components 推导，商店类型该端点已不提供**）。
  - `validateResponse` 补 `/heroStats` `/items` `/heroes/{id}/matchups` 数组白名单；`module.exports` 导出三者。
- `utils/heroes.js`（新增）：合并 `/heroes` + `/heroStats`，计算职业胜率与相对登场率；`getMatchups(id)` 按同场胜率取最佳/最差对位（过滤样本 <20 场）。
- `utils/items.js`（新增）：合并 `/items` + `/constants/items`（图标/展示名），返回统一物品结构。
- `pages/data/data.{js,wxml,wxss,json}`（新增）：第 5 个 tab「资料库」落地页（英雄/物品两张入口卡）。
- `subpackages/data/hero/hero.*`（新增）：英雄列表（搜索 + 主属性/攻击类型筛选 + 排序 + 网格卡片 + 错峰动效 + 空态/错误态）。
- `subpackages/data/hero-detail/hero-detail.*`（新增）：英雄详情（基础属性/定位/职业胜率·登场·禁用/最佳与最差对位，对位可点跳同分包详情）。
- `subpackages/data/item/item.*`（新增）：物品列表（搜索 + 按价格排序 + 仅看配方 + 列表卡片）。
- `subpackages/data/item-detail/item-detail.*`（新增）：物品详情（价格/配方/商店类型 + `image-fallback` 图标占位；深度项标注待补充）。
- `app.json`：`pages` 新增 `pages/data/data`；`subpackages` 新增 `data` 分包（hero/hero-detail/item/item-detail）；`tabBar` 新增第 5 项「资料库」。
- **深度项待补（需策展/赛后分析数据）**：英雄技能详解、克制/搭配的「同队 vs 敌对」区分；物品合成树（OpenDota 未直接提供组件清单）、适用英雄、赛事出装率。已在详情页明确标注「待补充」，不影响基础查询体验。

### V4 · 图表可视化增强（本轮 · 客户端完整可用）
**目标**：经济/经验曲线可读性提升（计划 V4）。**完全客户端实现，零第三方依赖**，数据均来自已接入的 OpenDota。
- `components/chart/*`（新增）：自研 Canvas 2D 图表组件，`<canvas type="2d">` + dpr 适配 + observer 重绘。
  - `type="line"`：多序列对比 + 零线 + 关键事件标记（肉山/推塔虚线）+ 点击 tooltip（命中最近数据点）。
  - `type="radar"`：多维能力雷达（如选手 KDA/GPM/XPM/参战率/伤害）。
- `subpackages/detail/match-detail`：经济差/经验差双序列折线图替换原迷你条形图；从 `match.objectives` 提取肉山/推塔事件标记；点击曲线显示该时间点数值。`onUnload` 关闭实时连接。
- `subpackages/detail/player-detail`：新增「能力雷达」卡片，基于近 20 场聚合 KDA/GPM/XPM/参战率/伤害。
- `match-detail.json` / `player-detail.json`：`usingComponents` 注册 `chart`。

### T4 · WebSocket 实时比分（本轮 · 客户端骨架就绪，待后端激活）
**目标**：赛事进行中实时更新（计划 T4）。客户端连接层已完整实现，真实推送需部署 `wss` 后端。
- `utils/realtime.js`（新增）：`createSession(matchId, handlers)` —— `wx.connectSocket` 封装，订阅 + 心跳 + 指数退避重连（上限 `maxReconnect`）+ 超时降级为 30s 轮询 OpenDota `/matches/{id}`。`config.realtime.url` 为空时直接轮询，无需后端即可运行。
- `subpackages/detail/match-detail`：`applyMatch` 抽出供实时复用；`isLive` 时自动 `startRealtime`，`onUnload` 关闭。
- `utils/config.js`：新增 `realtime` 配置段（url/pollInterval/heartbeat/maxReconnect）。
- `README.md §6`：补充 wss 域名白名单与消息契约（客户端→服务端 subscribe/ping；服务端→客户端 `{type:'score', match}`）。

### T6 · A/B 实验框架（本轮 · 客户端骨架就绪，待后端分桶）
**目标**：灰度验证功能改动（计划 T6）。客户端框架已完整实现，分桶与转化上报需后端 `experiments` 配置。
- `utils/experiment.js`（新增）：`refresh()`（拉取实验分组并缓存）/ `getVariant()` / `isEnabled()` / `track()`。无云端时回退 `DEFAULTS`，离线可用。
- `cloudfunctions/aggregation/index.js`：新增 `getExperiments` action，返回样本实验配置（含 `follow_cta_variant` / `news_sort`）。
- `app.js` `onLaunch`：best-effort 调 `experiment.refresh()`（失败不阻塞启动）。
- `pages/follow`：实装首个开关 `follow_cta_variant`（A=去发现战队 / B=浏览热门战队），`onShow` 读分组、`goExplore` 记转化。
- `utils/config.js`：新增 `experiment` 配置段（action/storageKey）。
  - `README.md §7`：补充实验配置契约与分桶建议。

### F4 · 即将到来自动跟随 Liquipedia 实时赛程（本轮 · 无需 STRATZ key）
**目标**：修复「即将到来」tab 仅显示 TI 2026、缺失下半年其余 Tier 1 赛事的问题（用户反馈 + Liquipedia 核对：OpenDota `/leagues` 不含未开赛赛事、STRATZ key 缺失、旧 `upcomingRangeSec` 仅 60 天）。
- `cloudfunctions/aggregation/index.js`：
  - 新增 `fetchLiquipediaUpcoming()`：经 `action=parse` 取 `Portal:Tournaments` 渲染后的 HTML，切片「Upcoming」段落，正则解析每行 `Tier / 名称 / 日期`（Tier 链接 `Tier_N_Tournaments`、名称 `column__tournament`、日期 `Mon DD–DD, YYYY` 兼容 en-dash / 跨月 / 单日），Tier≤2 过滤，日期转 Unix（`parseLiquipediaDate`），`end >= now` 过滤已结束项。
  - `preheatUpcoming()` 重构为「有 `STRATZ_API_KEY` 走 STRATZ（含真实联赛 id 便于跳转详情），无 key 自动改走 Liquipedia」，两者均写入云缓存 `upcoming_schedule`（6h TTL）。
  - 新增 `getLiquipediaUpcoming` action（调试 / 直读）。
- `pages/leagues/leagues.js`：`tryCloudUpcoming()` 复用云端下发的 `grade/rank/label`（避免 Tier 2 被错标 S 级），补齐 `countdownText` / `daysToStart` / `source`（Liquipedia / STRATZ 来源徽标）。
- `pages/leagues/leagues.wxml`：来源徽标支持 `Liquipedia` / `STRATZ` 显示；空态提示改写（赛程来自 STRATZ/Liquipedia 云端代理，本地 curation 兜底）。
- `utils/curation.js`：保留 4 个下半年 Tier 1 赛事作为离线兜底（Liquipedia 不可达时仍可显示），与云端实时数据按规范名去重。
- 实测（2026-07-25，系统时钟 7/25）：Liquipedia 解析返回 8 个未来 Tier 1/2 赛事（BLAST SLAM IX、Esports Nations Cup 2026、BLAST SLAM VIII、PGL Wallachia S9 + 近期 Tier 2 如 EPL Masters I / Games of the Future 2026），日期与 curation 一致，tab 自动跟随 Liquipedia。
- **不依赖云函数的本地替代方案（用户追加需求）**：新增 `scripts/fetch-liquipedia-upcoming.js`（纯 Node 内置 https+zlib，无需 npm install）抓取 Liquipedia 生成 `utils/upcoming-local.json`；客户端新增 `tryLocalUpcoming()` 作为云端之后的回退层，`loadUpcoming` 回退链改为 `tryCloudUpcoming → tryLocalUpcoming → loadUpcomingSerial`。抽出共享 `buildUpcomingCard(entry, ctx)` 构造器，云端缓存与本地快照共用，渲染字段完全一致，后续增删字段只改一处（可维护性）。`mergeCurationUpcoming` 按归一名去重，本地快照与 curation 重叠赛事不会重复。

---

## 二、已具备但非本轮新增（Already satisfied）
- **I1 骨架屏**：全站已使用 TDesign `t-skeleton`，无需重复自定义组件。
- **I2 错误兜底**：全站已使用 TDesign `t-empty` + `t-button` 重试，统一错误态。
- **T5 分包拆分**：已于 `app.json` subpackages 落地（detail 分包）。

---

## 三、待后续（Pending / Follow-up · 需设计/基础设施/后端）
| 项 | 说明 | 阻塞点 |
|----|------|--------|
| B1 商业化 | 广告/赞助/增值 | 需资质与变现策略 |
| F3 深度项 | 英雄技能详解/克制·搭配区分；物品合成树/适用英雄/赛事出装率 | 需策展数据或赛后分析样本（基础查询已可用） |

> **V4 / T4 / T6 客户端骨架已于 2026-07-25 落地（见「一、本轮新增」V4/T4/T6 条目）：**
> - V4 图表已完整客户端可用（自研 Canvas 2D 组件，经济/经验曲线 + 选手雷达图，零依赖）。
> - T4 实时连接层就绪（WebSocket + 断线重连 + 降级轮询），但**真实实时推送仍需部署 wss 后端**（见 README §6）。
> - T6 实验框架就绪（分组拉取/缓存/灰度/埋点），但**分桶与转化上报仍需后端 experiments 配置**（见 README §7）。
> 三者当前在无后端时均能降级运行，不阻塞基本功能。

> 说明：STRATZ 图床尺寸参数化（`optimizeImageUrl`）当前仅对 OpenDota CDN 生效；STRATZ/Steam CDN 缩放行为未经验证，暂未纳入白名单，以避免未知 query 触发 404（已在代码注释标注，待确认后扩展）。

---

## 四、兼容性 & 错误处理校验
- 所有新增组件均声明于对应页面 `usingComponents`，与 `lazyCodeLoading: requiredComponents` 兼容。
- `image-fallback` 用 `observers` 监听 `src` 变化重置状态，避免列表项复用残留；`binderror` 回退占位不丢布局。
- `onboarding` 自管 `Storage` 标记，重复启动不弹；组件异常不影响主流程。
- `news` 页 Liquipedia 未部署云函数时优雅降级（空列表 + 提示），权威源目录始终本地可用。
- `I5` 还原逻辑对页面被系统销毁重建的边界场景做了 `allResults` 存在性判断，避免空列表误显。
- `curation.js` 修复 `NEWS_SOURCES` 声明顺序（TDZ）问题。

## 五、校验命令
```bash
node node_modules/eslint/bin/eslint.js utils/ pages/ subpackages/ cloudfunctions/ scripts/ --ext .js
# 结果：✖ 132 problems (0 errors, 132 warnings)
```
