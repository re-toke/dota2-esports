# DOTA2 赛事通 · UI 全面诊断与多版本优化设计方案

> 日期：2026-07-27
> 范围：`dota2-esports` 全量页面 / 组件 / 设计系统（`app.wxss`）
> 方法：只读探索 + 关键页 WXML/WXSS 实地核验 + 设计系统审计
> 目标：① 摸清代码结构功能；② 诊断 UI 问题与不足；③ 给出多版优化方案（设计思路 / 改进重点 / 适用场景）

---

## 一、项目代码结构 & 功能全景

### 1.1 技术栈
- **微信小程序原生**（WXML / WXSS / JS），WebView 渲染为主，部分动效依赖客户端。
- **TDesign 小程序组件库**：仅作"零件库"使用——`t-icon / t-button / t-skeleton / t-empty / t-collapse / t-tag / t-search`，主体 UI 为自研。
- **数据多源聚合**：OpenDota 公开 API + STRATZ + Liquipedia + Steam，经云函数 `cloudfunctions/aggregation` 服务端聚合与缓存。
- **本地能力**：缓存（`utils/cache.js`）、限流、关注订阅（`utils/follow.js` + 微信订阅消息）。

### 1.2 目录与页面
| 区域 | 内容 |
|---|---|
| 主包 7 页 | `index`(首页) / `leagues`(赛事) / `teams`(战队) / `follow`(关注) / `data`(资料库入口) / `search`(搜索) / `stratz-test` |
| 分包 `detail` | `league-detail` / `match-detail` / `team-detail` / `h2h` / `privacy` |
| 分包 `data` | `hero` / `hero-detail` / `item` / `item-detail` |
| 自研组件 6 个 | `anchor-card`(关键指标锚点) / `chart`(Canvas 折线·雷达) / `empty-state`(空态) / `image-fallback`(图回退) / `live-card`(直播聚合) / `onboarding`(引导) |
| utils 28 模块 | `api / cache / config / curation / items / heroes / tiers / liquipedia / stratz / follow / searchHistory / teamSearch …` |

### 1.3 信息架构（5 个 tabBar）
- **首页**：品牌栏 + 常驻搜索 + 「我的关注」横向卡片流（自绘每秒倒计时）+ 为你推荐 + 快捷入口。
- **赛事**：焦点卡(TI15) + **5 行筛选控件**（状态 chip / 级别 grade-bar / 视图切换 / 排序 / 战队筛选）+ 列表 / 周轴两种视图。
- **战队**：`t-search` + 卡片列表（logo + 信息 + 关注星 + 3 列 stat-mini）。
- **关注**：KPI 计数 + 分段 + 关注卡 + 订阅状态卡 + 智能提醒 + 推送记录。
- **资料库**：英雄 / 物品两个入口卡。
- **详情链路**：赛事详情（对阵 / 排名 / H2H / 系列赛）→ 比赛详情（图表 / KDA / 出装）→ 战队详情 → 双方 H2H。

### 1.4 数据流对 UI 的约束（设计时必须尊重）
- 赛事列表本身**不带**战队参赛信息 → 战队筛选需经 `getTeamMatches` 聚合（OR 逻辑、10min 缓存），有性能权衡，UI 需给出"聚合中"反馈。
- 关注流自绘**每秒倒计时**，上限 15 队以规避 OpenDota 60 req/min 限流 → 卡片流数量需封顶。
- 这些约束决定了"实时性"与"密度"的天花板，任何方案都要在此框架内优化。

---

## 二、现有 UI 问题诊断

把探索发现的 17 项问题归并为 **5 类**，按严重度排序（均附文件/行号证据）。

### 2.1 正确性缺陷（信息失真 · 最高优先级）
| 级别 | 问题 | 证据 |
|---|---|---|
| **P0** | 排名胜率色失效：`wr-high/wr-mid/wr-low` 仅在 `teams.wxss` 定义，`league-detail` 引用却无样式（实际失效点为 `league-detail.wxml:239`，并非 leagues） | `subpackages/detail/league-detail/league-detail.wxml:239` |
| **P0** | 关注卡 Tier 彩条**错色**：`tier-s` 写成绿(应为金)、`tier-a` 写成琥珀(应为紫) | `pages/leagues/leagues.wxss:638-641`（首页 `index.wxss:52` 正确，两处不一致） |
| **P0** | 资料库品牌栏类名错误：用 `brand-info/brand-name`（全局只有 `brand-text/brand-title`）→ 标题丢失字体/大小 | `pages/data/data.wxml:4-7` |

> **A 版实施记录（2026-07-27，UI Designer 已落地）**：以上三个 P0 已全部修复，改动面仅 4 个文件、零架构风险——
> 1. **P0-1**：将 `wr-high / wr-mid / wr-low` 提升为 `app.wxss` 全局工具类（收敛到 `--kpi-primary / --kpi-warning` token），并删除 `teams.wxss` 本地重复定义；`league-detail.wxml:239` 的战队胜率列现已正确着色（绿=高 / 橙=中 / 灰=低）。
> 2. **P0-2**：将 `leagues.wxss` 关注卡 `.ff-card.tier-*` 的硬编码色（S 绿 / A 琥珀）改为 `var(--tier-*)` token，与首页 `index.wxss` 完全统一（S=金 / A=紫 / B=蓝）。
> 3. **P0-3**：将 `data.wxml` 品牌栏类名 `brand-info / brand-name` 修正为全局 `brand-text / brand-title`，标题字号与配色恢复正常。
> 验证：grep 确认代码内 `brand-info/brand-name` 已无残留；`wr-*` 全局生效且无重复定义；`ff-card` 在 `index` 与 `leagues` 两处 tier 彩条语义一致。

### 2.2 设计系统碎片化（token 未贯彻 · 视觉不一致）
- **混入 Tailwind 灰阶**：`#4b5563 / #9ca3af / #d1d5db` 散落 `follow / league-detail / hero-detail / hero` 等多处，偏离自有灰阶 `#8a8f99/#9aa4b2/#6b7280`。
- **胜方配色冲突**：`anchor-card` 胜方用品牌**金**，而全站"胜=天辉绿 `--radiant`"语义（比分绿、排名绿）→ 详情页胜色割裂。
- **图表/图例硬编码**：`#3FB950 / #58a6ff / #5b9bff` 不在 token 体系（`chart.js` 默认金、match 图例蓝绿）。
- **直播色冲突**：`live-card` 用红 `#ff4d4f`，全站"直播=绿 `--status-live`"语义。
- **死 token**：`--border` 全项目未定义，仅靠 `var(--border, …)` 兜底生效。
- **冗余自绘**：`app.wxss:136-148` 整套 `.tag/.tag-*` 全项目无 wxml 引用（leagues 改用 `t-tag`），且 `.tag-s` 绿与 Tier-s 金冲突。

### 2.3 组件 / 样式冗余与重复（维护成本）
- **空态两套路并存**：`t-empty`（leagues 即将到来、各 detail 错误态）vs 自研 `empty-state`（index/teams/search 主空），视觉不同。
- **搜索框两套**：自绘 `.search-bar`（index/leagues）vs `t-search`（teams/hero/item/search）。
- **跨文件重复**：`quality-pill / source-section / seg` 在 `league-detail` 与 `team-detail` 近乎逐字复制。
- **`section-header` 全局与本地冲突**：详情页本地重定义（30rpx）覆盖全局（28rpx）→ 区块标题大小/间距不一致。
- **`.chip` 行为不一致**：leagues（全宽 `flex:1`）vs hero/item（药丸形），同一类名不同表现。
- **未使用导入**：`teams.json` 的 `t-avatar`、`leagues.json` 的 `t-search` 均未在 wxml 使用。
- **导入路径风格不统一**：部分页用相对路径、部分用 npm 短路径。
- **多处死代码**：`.player-card`、`match-detail` 的 `.report-hero`、league-detail 的 `.liq-banner/.meta-card/.match-card` 等。

### 2.4 信息架构与密度（体验层）
- **赛事页筛选控件过载**：状态 + 级别 + 视图 + 排序 + 战队筛选 = **5 行纵向堆叠**，首屏被筛选占满，列表可视区被挤压到约 40%。
- **适配问题**：英雄网格写死 `repeat(2,1fr)`；多处 `max-width` 写死（如 `.vs-team-name 200rpx`、`.ff-team 110rpx`），异形屏可能过早截断，建议改 `flex:1 + min-width:0`。

### 2.5 布局与反馈细节
- **`live-card` 双重内缩**：组件 `margin:16rpx 24rpx` 又置于 `.container`(padding 24rpx) 内 → 实际 48rpx，比其它卡片窄，视觉突兀。
- 入场 `anim-fade-up` 错峰、`tap-scale` 按压已具备；但 `chart/anchor` 未接 token，动效与主题耦合弱。

---

## 三、多版本优化设计方案

### 总原则
**任何方案都先做"地基"**：修复 2.1 三个 P0 bug + 收编 2.2 的散落色值为 token（即下方**方案 A**）。之后按目标用户选主方向。四版并非互斥——A 是地基，D 可作 B/C 的"省电/极简模式"开关共存。

---

### 版本 A · 设计系统治理版（地基 / 低风险）
- **设计思路**：不动信息架构与视觉语言，纯做"设计系统收敛 + bug 修复 + 去冗余"，让现有暗色电竞风在 token 层面自洽。
- **改进重点**：
  1. 修 3 个 P0 bug（排名色 / 关注卡 Tier 色 / 资料库品牌栏类名）。
  2. **建立色值白名单**：把硬编码色统一收编——红系(`#e74c3c/#ff4d4f/#e0533d`)→ `--dire`；蓝绿系(`#58a6ff/#5b9bff/#3FB950`)→ 新增 `--link / --accent-green`；Tailwind 灰 → `--text-muted-2`；定义 `--border`。
  3. **二选一治理**：空态统一为 `empty-state` 组件；搜索框统一 `t-search`；删除未用 `.tag` 系统、未用导入、死代码。
  4. **跨文件重复抽全局**：`quality-pill / source-section / seg` 上提到 `app.wxss` mixin；`section-header` 去本地重定义。
- **适用场景**：作为任何后续方案的前提；或团队资源紧张、希望"低风险快速上线一致性"时单独交付。改动面小、风险低、可灰度。

---

### 版本 B · 信息密度提升版（数据党 / 老玩家向）
- **设计思路**：以"数据指挥台（C 风格）"为核心，把 5 行筛选**收拢为顶部可折叠抽屉**（"筛选 ▾"一键展开/收起），释放首屏给列表；列表项**表格化**（Tier 彩条 + 名称 + 时间 + 参赛队数 + 状态脉冲 + 奖金池），支持长按/侧滑快速关注。
- **改进重点**：
  1. 筛选收拢：5 行 → 1 行概要 + 展开抽屉（状态/级别/视图/排序/战队同处一屏），信息密度提升约 40%。
  2. 列表表格化 + 紧凑行高，扫读大量赛事/战队更高效。
  3. 全局搜索升级为"命令面板"式：输入即分组（赛事/战队/选手/物品）+ 近期/热门。
  4. KPI strip 复用至战队/赛事概览。
- **适用场景**：核心玩家、数据分析用户、需要快速扫读大量赛事/战队的人群。牺牲一点"好看"，换"高效"。

#### ✅ B 版实施状态（2026-07-27 已落地）
- **B-1 筛选抽屉**：`pages/leagues/` 顶部状态常驻 + 「筛选▾(N)」底部抽屉收纳等级/排序/视图/战队（原 4 行筛选 → 1 行常驻）。详见 `deliverables/B版修复记录_2026-07-27.md`。
- **B-2 列表表格化**：来源并入一行、压缩卡片间距，单卡高度 ~188→150rpx（密度 +20%），叠加首屏释放后列表可视区 ~40%→65%。
- **B-3 搜索命令面板**：`pages/search/` 初始态加热门/历史快捷入口（命令面板感），历史本地存储去重（≤8）。
- **验证**：`node --check` 通过；旧筛选类（grade-bar/view-mode-bar/team-filter-row/league-source-row）零残留；新增绑定方法均有定义。

---

### 版本 C · 赛事沉浸中心版（泛用户 / 直播优先 / 拉新）
- **设计思路**：以"运营 / 直播"视角重构首页与赛事页——大图 **Hero Banner**（焦点赛事）+ **直播优先流**（进行中赛事置顶、LIVE 脉冲卡）+ 卡片化推荐；弱化筛选密度，强化"看点"。
- **改进重点**：
  1. 首页/赛事顶部 Hero 化（复用方案 A 的 `hero-banner`），焦点卡升级为**可横滑焦点轮播**。
  2. 直播/进行中赛事优先渲染；`live-card` 红色语义统一为"直播绿"或明确 `--live-red` 全站同步（消除 2.2 直播色冲突）。
  3. 频道化：赛事/战队/关注作为**内容流**而非静态列表；"为你推荐"算法化。
  4. 视觉更"潮"：更大圆角、玻璃拟态卡片、渐变描边。
- **适用场景**：泛电竞观众、拉新转化、内容运营驱动。重"氛围"与"看点"，适合作为市场/增长向版本。

---

### 版本 D · 极简主义版（性能 / 无障碍 / 低端机）
- **设计思路**：去装饰、去冗余动效，纯信息流；克制配色（仅 Tier 5 色 + 中性灰 + 单一强调金）；骨架/错峰动画降级为简单淡入；修复 `live-card` 双重内缩等 layout bug。
- **改进重点**：
  1. 单一列表 + 最小控件，减少重排。
  2. 动效降级（减少 `animation`）提升低端机帧率。
  3. 无障碍：增大点击热区、对比度达标、字号可放大。
  4. 包体精简（删未用导入/死代码/重复）。
- **适用场景**：低端安卓机、弱网、无障碍需求，或作为"省电模式"开关与 B/C 共存。

---

### 推荐落地路径（组合而非单选）
1. **阶段一（必做 · 低成本）**：版本 A 全套 → 一致性地基。
2. **阶段二（按目标选主方向）**：主打"数据/工具"定位 → **B**；主打"内容/社区/增长" → **C**；两者可并行 A/B 实验分流。
3. **阶段三（可选）**：版本 **D** 作为"极简/省电模式"开关，与 B/C 共存。

---

## 四、风险与验证清单
- **TDesign 深色 token 覆盖**：真机验证 `t-search/t-tag/t-skeleton` 是否有浅色渗漏（依赖 token 覆盖生效，无法静态确认）。
- **token 替换**：全局搜索确认无残留硬编码色值。
- **结构改动回归**：B/C 涉及 wxml 结构变更，需回归各页 `onShow` / 缓存 / 关注流倒计时逻辑。
- **性能**：方案 B 表格化、C 大图 Hero 需注意首屏渲染耗时与包体。

---

## 附：关键问题 → 修复映射速查
| 类别 | 问题 | 归属方案 |
|---|---|---|
| 正确性 | 排名色失效 / 关注卡 Tier 错色 / 资料库品牌栏类名 | A（P0 必修） |
| 配色 | Tailwind 灰 / 胜方金绿冲突 / 图表硬编码 / 直播红 / 死 token | A |
| 冗余 | 空态双方案 / 搜索双方案 / 跨文件重复 / 未用导入 / 死代码 | A |
| 架构 | 5 行筛选堆叠 | B（收拢抽屉） |
| 体验 | 直播优先 / Hero 化 / 频道流 | C |
| 性能 | 动效降级 / 适配 / 包体 | D |
