# DOTA2赛事通 · UI 全面优化实施总览（v1 三页 P0）

**日期**：2026-07-25
**依据**：`roadmap-v1-single-iteration-2026-07-26.md` + `ui-interaction-spec-dota2-v1-pages-ABC-2026-07-26.md`
**技术栈**：微信小程序原生 + TDesign + 现有暗色电竞主题

## 关键设计约束
- Roadmap 将 Tier 配色统一（S金/A紫/B蓝）明确 **defer 到 v2 的 4.2**。故迭代 1 **不全局重着色**，复用现有暗色主题与既有 5 档 grade bar（ALL/SSS/S/A/B），只新增能力、不推翻视觉。
- 全部为纯前端/既有接口聚合，**无新增后端接口**。

## 页面 B — 双方对战 H2H（新建分包页）
- 新增 `subpackages/detail/h2h/`：`h2h.js` / `h2h.wxml` / `h2h.wxss` / `h2h.json`（已注册进 `app.json` detail 分包）。
- 进入：携带 `teamA`+`teamB`；数据取 `api.getTeamMatches(teamA)` 按 `opposing_team_id===teamB` 过滤得双方交锋。
- 胜负条形：单条双向 CSS 双色 View，主队 `--h2h-a #2DD4A7` / 客队 `--h2h-b #F25C54`（token 已加 `app.wxss`），宽 = `X/(X+Y)`。
- 标签（spec B.3）：连胜 N(≥3) / 压制(|X-Y|/(X+Y)≥.5 且总≥4) / 平分(X==Y)。
- 状态机：加载骨架 / 错误重试 / 无交锋 Empty / 历次交锋列表（Tier 左色条复用）。
- 入口：改写 `team-detail` H2H 行 → `openH2h`（携带双方 id）；对手详情仍可经 H2H 页 VS 头点达。

## 页面 A — 赛事列表·战队筛选（改造 `pages/leagues`）
- 新增「战队筛选」入口（选中显示计数徽标 `(N)`）+ 底部 Popup 多选（全选/清空/确定(计数)/取消）。
- 与现有 Tab × 级别 **取交集**。空态提供「清除筛选」。
- **数据来源**：赛事列表本身不带战队参赛信息 → 用 `api.getTeamMatches(teamId)`（含 `leagueid`，走 10min 缓存）聚合「参与联赛并集」匹配（OR 逻辑，AC-A3）。确认时 `wx.showLoading` 聚合，无新接口。
- 视图态持久化增加 `teamFilter`，onShow 还原 + 刷新可选战队。

## 页面 C — 首页「我的关注」卡片流（改造 `pages/leagues` 顶部）
- 已关注≥1 战队 → 顶部横向 scroll-view 卡片流：每队下一场赛事（Tier 标签 + TeamA VS TeamB + **自绘每秒倒计时** / 已结束比分）；点击跳赛事详情或对手详情。
- 未关注 → 引导卡「关注战队得赛前提醒 → 去关注」；已关注无近期赛事 → 占位卡。
- 计时器 onShow 启动 / onHide(onUnload) 停止，回前台重新校准（AC-C5）；卡片流上限 15 队防打满 OpenDota 60 req/min。

## 验证
- `node --check` 通过：`leagues.js` / `team-detail.js` / `h2h.js`。
- `h2h.json` + `leagues.json` JSON.parse 通过。
- TDesign 图标 `check` / `chevron-down` 确认存在；`empty-state` / `t-empty` / `t-icon` 均已在对应页 `usingComponents` 注册。

## 改动文件清单
- 新增：`subpackages/detail/h2h/h2h.{js,wxml,wxss,json}`
- 改动：`pages/leagues/leagues.{js,wxml,wxss}`、`subpackages/detail/team-detail/team-detail.{js,wxml}`、`app.wxss`（H2H token）、`app.json`（注册 h2h 页）
- 未提交（如需 commit 请告知）。
