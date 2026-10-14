# 「6 小时更新」方案说明

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

> 结论先行：**你想要的「6 小时更新一次」其实已经实现，就是已落地的微信云函数方案（而且它实际每 10 分钟刷新，比 6h 更频繁）。** 部署即用，免备案、免域名、¥0。纯前端本地快照做不到 6h 自动更新——这是小程序架构硬限制。

## 一、为什么纯前端做不到「每 6h 自动更新」

- 微信小程序**没有后台定时任务**。前端 `setInterval` / `setTimeout` 只在小程序**前台运行期间**有效，用户退出或微信回收后台即停止。
- 本地快照 A（`utils/upcoming-local.json`）是直接打进主包的静态文件，**用户侧生效必须经过「重新上传 + 审核发布」**，最快也是"发布频率"，无法做到 6h 自动。
- 因此"定时刷新"必然需要一个**常驻服务端**来缓存并按周期重新抓取。

## 二、已有机制：云函数即「6h（实际更频繁）更新」

`cloudfunctions/aggregation` 已内置完整链路：

1. `config.json` 的定时触发器 `prewarm10min`，cron `0 */10 * * * *` → **每 10 分钟**触发一次。
2. 触发进入 `exports.main` 的定时器分支（`event.TriggerName === 'cron'`）→ `handleTimer()` → `preheatAll()`。
3. `preheatAll()` 调用 `preheatUpcoming()`（见 `index.js:354`）。
4. `preheatUpcoming()`：有 `STRATZ_API_KEY` 走 STRATZ，无 key 自动走 `fetchLiquipediaUpcoming()`（解析 Liquipedia `Portal:Tournaments` 的 Upcoming 段）→ `setCache('upcoming_schedule', ..., 6 * 3600 * 1000)`。
5. 客户端 `leagues.js` 的 `tryCloudUpcoming()` → `getUpcomingSchedule` → 读云缓存（秒开）。

→ 缓存 TTL 虽标 6h，但**每 10 分钟被重写一次**，实际新鲜度约 10 分钟级，已满足"非实时、周期更新"诉求。

## 三、方案矩阵（以「6h 更新」为目标）

| 方案 | 需服务端 | 6h 自动 | 备案/域名 | 成本 | 状态 |
|---|---|---|---|---|---|
| **C 微信云函数**（推荐） | 是（微信云） | 是（每 10min，更频繁） | **免** | ¥0 | 代码就绪，仅缺部署 |
| D 静态托管 + 客户端拉 | 是（静态站） | 是（CI 每 6h 生成 JSON） | 国内需备案；境外免备案但慢 | ¥0–几十/月 | 需自建 |
| B 自建函数代理 | 是（自有） | 是 | 需备案 | ¥50–770/年 | 需自建 |
| A 本地快照 | 否 | **否**（发布快照） | 免 | ¥0 | 已做，非实时 |

## 四、可选优化（按需）

1. **想要"严格 6h"而非 10min**：把 `config.json` 触发器 cron 改为 `0 0 */6 * * *`（每 6 小时）。但当前 10min 对 Liquipedia 限流（约 1 req/2s）毫无压力，保持亦可。
2. **减少无谓抓取**：`preheatUpcoming()` 目前每次都实打实打 Liquipedia（无 STRATZ 时）。可在其开头加"缓存命中则跳过抓取"的判断，更优雅、更省第三方负载。
3. **绝不碰微信云、又要 6h**：走方案 D —— 用 CI（GitHub Actions 等）每 6h 跑 `scripts/fetch-liquipedia-upcoming.js` 生成 `upcoming.json` 推到静态托管，客户端在 `onLaunch`/`onShow` 时 `wx.request` 拉取（带本地 6h 缓存）。注意：静态域名仍需在 mp 后台登记 request 合法域名（境外托管免备案但大陆访问慢；国内托管需备案）。

## 五、建议

直接**部署已做好的云函数**（`DEPLOY.md` 有步骤），即获得"周期自动更新 + 免备案免域名"。本地快照 A 作为离线兜底保留，无需改动。
