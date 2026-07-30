# 赛事详情页 · 对阵模块 / 参赛队伍模块 队伍 Logo 显示逻辑分析

> 分析对象：`subpackages/detail/league-detail/`
> 范围：对阵 Tab（`series`）与参赛队伍 Tab（`participantsList`）的 logo 渲染链路
> 日期：2026-07-30

---

## 一、两条链路的渲染逻辑对比

### 1. 对阵模块（series）
**渲染**（`league-detail.wxml` 第 166-168 / 191-193 行）：
```xml
<image-fallback src="{{s.radiantLogo}}" placeholder="{{s.radiantName ? s.radiantName[0] : '?'}}" />
```
- 使用自定义组件 `components/image-fallback`。
- 初始值：`radiantLogo: ''`（空字符串，见 `league-detail.js` 第 476-477 行 series 构建）。
- 异步填充：页面 `onLoad` 后 `Promise.all([enrichTeamNames(), enrichTeamLogos()])`（`league-detail.js` 第 607 行），其中 `enrichTeamLogos()` 收集 `allSeries` 的 `radiantTeamId`，经 `api.getTeam` + `sources.enrichTeamLogo` 拿到 logo URL，再以路径 `series[si].radiantLogo` 批量 `setData` 注入（`league-detail.js` 第 831-850 行）。
- 兜底：`image-fallback` 内部 `src` 为空或加载失败时显示**首字母占位**。

### 2. 参赛队伍模块（participantsList）
**渲染**（`league-detail.wxml` 第 300 行）：
```xml
<image wx:if="{{item.logo}}" class="team-logo-img" src="{{item.logo}}" mode="aspectFill" lazy-load binderror="onParticipantLogoError" data-idx="{{pidx}}" />
```
- 使用**原生 `<image>`**，外加 `binderror` 兜底。
- 初始值：`participantsList` 构建时只有 `{ id, name }`，**无 logo 字段**（`league-detail.js` 第 1004 行）。
- 异步填充：同一 `enrichTeamLogos()` 在 patch series 之后，同步回填 `participantsList[i].logo`（`league-detail.js` 第 881-891 行）。
- 兜底：`item.logo` 为空 → `wx:if` 不成立 → 走 `wx:else` 显示首字母；若加载失败 → `onParticipantLogoError` 把 `logo` 置空再回退首字母。

### 3. 关键差异一览

| 维度 | 对阵模块 | 参赛队伍模块 |
|---|---|---|
| 渲染组件 | `image-fallback`（自定义组件） | 原生 `<image>` |
| 初始 logo 值 | `''`（空字符串，始终进入占位分支） | `undefined`（wx:if 不成立，走 wx:else） |
| 填充来源 | 同一 `enrichTeamLogos` 的 `logoMap` / `nameLogoMap` | 同一 `enrichTeamLogos` |
| 失败兜底 | 组件内首字母 | `binderror` → 置空 → 首字母 |
| **team_id 来源** | OpenDota matches（有 id）+ Liquipedia 赛程补充（**id=0**） | 已参赛队伍有真实 id；未登场/未匹配为**负数占位 id** |

---

## 二、对阵模块 logo 显示失败的根因（按可能性排序）

### 根因 A — 渲染层（已修复，本次重点）✅
`image-fallback` 组件的图片元素 `.imgfb-img` 初始 `opacity: 0`，依赖 `bindload` 事件回调 `onLoad` 加上 `.imgfb-img--loaded` 类才置 `opacity: 1`。

**缺陷**：小程序在 **list 复用 / 动态 `src` 变更** 场景下，`bindload` 可能偶发不回调（已知平台现象）。此时 `loaded` 永远为 `false`：
- 图片永久 `opacity: 0`（不可见）；
- 占位层 `.imgfb-ph` 因 `wx:if="{{!src || !loaded || failed}}"` 中 `!loaded` 为真 → **首字母占位永久覆盖**在已加载成功的图片之上。

表现即「对阵模块队 logo 显示失败」。而参赛队伍用原生 `<image>`（无 `opacity` 淡入依赖），不受此影响——这正是**「对阵失败、参赛正常」差异的渲染层解释**。

**已落实修复**（`components/image-fallback/`）：
- `image-fallback.wxml`：占位层条件由 `!src || !loaded || failed` 改为 `!src || failed`，可见性不再依赖 `loaded`。
- `image-fallback.wxss`：`.imgfb-img` 默认 `opacity: 1`；淡入改为加载时的 CSS `animation`（元素渲染即播放，不依赖 `bindload` 事件）。

> 该组件被 league-detail / team-detail / match-detail 等多处共用，此修复对所有使用方均为安全的稳健性提升。

### 根因 B — 数据层（需验证，待配合）
对阵模块混合了两类 series：
- **OpenDota matches 的 series**：`radiantTeamId` 为真实正数 id → 走 `logoMap[id]` 多源查询（OpenDota → STRATZ → Liquipedia），成功率与参赛队伍一致。
- **Liquipedia 赛程补充的 series**（如大量 upcoming/live 对阵）：`radiantTeamId: 0`（`league-detail.js` 第 466-467 行），其 logo **完全依赖 `nameLogoMap` 按归一化队名匹配**（`enrichTeamLogos` 第 748-761 / 835-839 行），底层只走 `sources.enrichTeamLogo` 的 **Liquipedia 按名兜底**（`sources.js` 第 432-447 行；因 `id=0`，OpenDota existing / STRATZ 均被 `if (id)` 守卫跳过）。

当 Liquipedia 被 CAPTCHA 拦截、或队名归一化（大小写/空格/后缀）与 `allSeries` 收集时不一致，`nameLogoMap[normName]` 命中失败 → `radiantLogo` 始终为空 → 该部分对阵只显示首字母。

**验证方法**（开发者）：查看 Console 中 `[enrichLogos]` 汇总日志（`league-detail.js` 第 820 行），重点看 `失败ids` 里是否大量为 `name:xxx` 形式（即按名兜底失败）；以及 `[enrichTeamLogo]` 的 `liquipedia 兜底无结果/异常` 日志。

**可选增强**（非本次落地，按需）：
- `enrichTeamLogos` 在 `nameLogoMap` 未命中时，尝试用归一化队名从 `participantsList` 已成功获取的 `logo` 反查共享（同一赛事内队名一致，可复用）；
- 放宽 `sources.enrichTeamLogo` 对 `id=0` 的 STRATZ 兜底（若 STRATZ 支持按队名查 logo，可补一路源）。

### 根因 C — 域名层（需配合）
`enrichTeamLogo` 最终返回经 `imageUtil.toLogoUrl` 处理的 URL（OpenDota `cdn.dota2.com` / STRATZ CDN / Liquipedia CDN，见 `sources.js` 第 411-447 行）。若该 CDN 域名**不在微信小程序后台「downloadFile 合法域名」白名单**，图片请求会被拒绝 → `binderror`/`onError` → 回退首字母。此问题两模块**共有**，会放大「失败」体感。

**配合动作**：
- 将实际使用的 logo CDN 域名加入小程序后台 downloadFile 合法域名；或
- 统一走 `imageUtil.toLogoUrl` 的代理域名（`config.images.proxyBase`，见项目 LOGO 优化记录 P0 根治项，目前未填）。

---

## 三、本次已落实的修改

| 文件 | 改动 |
|---|---|
| `components/image-fallback/image-fallback.wxml` | 占位层 `wx:if` 去掉 `!loaded`，可见性不再依赖 `bindload` |
| `components/image-fallback/image-fallback.wxss` | `.imgfb-img` 默认 `opacity:1`；淡入改为 CSS `animation`，消除「卡死在不可见」风险 |

效果：对阵模块 logo 一旦拿到有效 URL，**必定可见**（不再被占位层或 `opacity:0` 遮挡）；仍拿不到 URL 时仍优雅回退首字母。

---

## 四、建议的后续验证顺序
1. **渲染层**：构建 npm 后在开发者工具复现——对阵模块 logo 在 enrich 后应立即显示（不再停留首字母）。
2. **数据层**：看 `[enrichLogos]` 日志，确认 `name:xxx` 失败是否占多数；若是，按「根因 B」增强按名共享。
3. **域名层**：若真机仍大面积首字母，核查 downloadFile 合法域名 / 代理配置。

---
**UI Designer** · 2026-07-30
