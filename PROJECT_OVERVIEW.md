# DOTA2 赛事通 · 项目全景（现行）

> **文档状态：现行有效** ｜ 最后更新 **2026-10-17** ｜ 代码基线 `14de946` ｜ 线上版本 **v1.3.0（2026-10-17 发布）**
> 与 `README.md` 同为本仓库的**权威文档**；`CODE_WIKI.md` / 根 `DEPLOY.md` / `DOMAIN-NAMING-REFERENCE.md` 为历史文档（已归档）。
> 生成口径：**逐条以当前工作树源码为准**；证据优先级 **代码 / `git log` > `deliverables/` > 本文 > 历史归档文档**。

---

## 1. 定位

一个 DOTA2 电竞赛事信息小程序：聚焦 **S 级及以上赛事**、**战队 / 队员资料**、**双方历史交锋**。
原生小程序 + TDesign，暗色电竞风；**第三方非官方粉丝工具**，无付费 / 无广告 / 无用户生成内容。

**一句话架构**：`客户端 ──(全部流量)──> 中转（境外边缘，国内可达）──> Supabase 单后端 ──> 上游四源`。

> 🔴 中转的**存在理由**（2026-10-10 定论）：`*.supabase.co` 在国内被 **SNI 阻断**（DNS/TCP 均可，**TLS 阶段被 RST**），而 `api.opendota.com` 亦有 DNS 劫持 ⇒ 客户端直连无法取数。中转部署在**境外边缘**（能连上 Supabase），其域名国内可达。

---

## 2. 端到端数据流

### 2.1 首页首屏（`pages/index/index.js`）
```
① pro/live settle   getProMatches + getLiveMatches（api.js → 中转 /od/api/*；滑动窗口限流 + 429/5xx 退避）
② 首批渲染          → 卡片（含量级彩条 / 直播脉冲）
③ ⑥段将来赛程       **延迟发起**（首屏 settle 之后，并发上限 3）⇒ 不抢首屏并发
④ logo/头像补全     explorer 批量（api.getTeamLogos）→ 未命中回落 findTeamByName（OpenDota 24h 缓存）
⑤ 合并渲染窗口      ★ 减少渲染轮次（实测轮次减半）
```

### 2.2 详情页（分包 `subpackages/detail`）
| 页面 | 关键链路 |
|---|---|
| `league-detail` | curation 命中（赛期/分级/展示名）→ explorer 补队伍与对阵 → LP 兜底；队标走**批量** explorer（≤12 次 → 1 次）|
| `team-detail` | **两阶段**：`?recent=50` 先出「最近 50 场」（~0.7s）⇒ 后台全量覆盖（**必须带 `X-Trim: 0`** 豁免中转默认裁剪，否则被裁到 300）|
| `h2h` | 中转 `?vs=<teamId>` **端点级过滤**（全历史交集的精确语义）|
| `match-detail` | OpenDota 对局详情 |

### 2.3 curation 热更新（`utils/remoteCuration.js`）
```
读：curation_events(分页) + curation_teams + curation_meta(ti_contestant_ids)
探针：curation_meta.key='version'（EF admin-write **每次成功写入后** bump {v:Date.now()}；10min 节流）
      回退：curation_events 的最大 data.updatedAt（覆盖所有 upsert）
⇒ 变了才重拉；缓存 6h（近期子集 30min）
```

---

## 3. 模块职责速查（`utils/`）

| 模块 | 职责 |
|---|---|
| `config.js` | **唯一事实源**：`PROXY_HOSTS`、`endpoints`、`cacheTTL` 预算表、`timeWindow`、`debug.verboseLog` |
| `endpoints.js` | 出口切换（主→备 + 会话粘滞 + 开机体检）；`count()===1` 时全部 no-op |
| `api.js` | OpenDota 封装：滑动窗口限流、429/5xx 退避重试、TTL 缓存（SWR）、**透传 `X-Trim`/`X-Gzip-Ok`** |
| `supabaseClient.js` | PostgREST 读 + EF 调用（`_efCall`）；EF 熔断按 `name\|action` 分桶 |
| `cloudProxy.js` | EF action 路由白名单 `EDGE_ACTIONS`、热缓存、去重 |
| `sources.js`（+ `sourcesPure.js`）| **多源融合中枢**：元数据合并、分级加权投票、赛期比对、展示名单一出口 |
| `consensus.js` | 多源共识（分级投票 / 成员合并）|
| `names.js` | 队名归一化**两族**（ASCII / 含 CJK·西里尔）|
| `seriesStatus.js` | 系列赛终局判据**唯一纯实现**（3 处收敛；6 处刻意不收敛并在调用点注明）|
| `remoteCuration.js` | 远端 curation 热更新 + 廉价版本探针 |
| `curation.js` / `curation-shared.js` | 本地 curation 快照与查表记忆化（缓存键含 `game`）|
| `image.js` | 图片 URL 规范化（http→https、死域剔除、**镜像收敛**：`avatars.steamstatic.com` → Akamai 镜像）|
| `cache.js` / `cloudCache.js` / `logoCache.js` / `logoLocal.js` | 各层缓存（含负缓存 `markNegative`）|
| `heroes.js` / `itemZh.js` / `neutralItems.js` | 英雄 / 物品（含中文名）|
| `liquipedia.js` / `liquipedia-parse.js` / `lp-ua.js` | LP 解析与 UA 约束（云端抓取）|
| `haglund.js` / `liveSources.js` | 备用数据源 / 直播源 |
| `diagnostics.js` / `monitor.js` / `experiment.js` | 「我的」页数据健康、埋点上报、实验开关 |
| `indexCardHelpers.js` / `index-builders.js` / `homeDedupe.js` | 首页卡片纯函数层 / 索引构建 / 去重 |
| `incremental.js` / `follow.js` / `followBatch.js` / `reminderStrategy.js` | 增量更新、关注与提醒 |
| `searchHistory.js` / `league-canon-map.js` / `discover-core.js` | 搜索历史 / 联赛规范映射 / 赛事发现 |

> 生成物（**勿手改**）：`utils/team-logo-map.json` + `subpackages/detail/team-logo-local-data.js`（队徽快照，CI 生成）。
> ★ 2026-10-24：原 `utils/upcoming-local*` / `utils/leagues-local*` 内置快照已移除（改为纯联网）。

---

## 4. curation 体系（人工运营面）

| 项 | 说明 |
|---|---|
| 表 | `curation_events`（主键 `canonical_key`）/ `curation_teams`（`team_id`）/ `curation_meta`（`key`，如 `ti_contestant_ids`、`version`）|
| 写入口 | **EF `admin-write`**（服务端 service key + `x-admin-token` 鉴权；每次写入后 bump 版本探针 + 落 `admin_logs`）|
| 后台 | `admin/`（Vue 3 + Element Plus）→ **GitHub Pages** `https://re-toke.github.io/dota2-esports/`（哈希路由）；**经中转 `/sb` 读写** |
| 读策略 | anon + RLS（三表 anon 只读）|
| 版本语义 | ① `curation_meta.key='version'` = 服务端写入时间戳（**探针**，唯一消费方是客户端的廉价比对）；② `ti_contestant_ids.value` = TI 名单（`ids/count/updatedAt`）|

---

## 5. 缓存 · 降级 · 安全

- **缓存五层**：T1 客户端内存热缓存 → T2 客户端 Storage（SWR）→ T3 中转 GET 短路 → T4 EF 内存 L1 → T5 `aggregation_cache`（KV）。
- **降级链**：中转主出口失败 → 切备出口（仅**传输层失败**触发；429/5xx 只退避重试）→ 直连 OpenDota → curation。★ 中转侧另有**陈旧兜底**（见下）。
- **★ 中转「陈旧兜底」（2026-10-24）**：同一 key 曾有成功缓存时，上游只试 **1 次**且超时收紧到 **4s**；失败 / 5xx / body 停滞 ⇒ 直接回上一次成功响应（`X-Proxy-Cache: STALE` + `X-Proxy-Cache-Age`）。无旧缓存时行为不变（12s × 2）。目的：消除上游「头快、body 卡」导致的首页 15s 空窗。
- **失败可见**：「我的」页数据健康卡（`diagnostics`）；EF/中转失败与卡片质量**事件上报**。
- **安全**：客户端**不持有真实 Supabase key**（中转服务端注入）；写权限只在 EF；`007-security-hardening.sql` 加了 `keep_alive` 列约束 + 写入频率触发器；中转按 IP 限流（默认 120/min，取不到 IP 则 **fail-open**）。

---

## 6. 可观测性

| 手段 | 内容 |
|---|---|
| 分段埋点 | 首页/详情页 `[perf]` 分段耗时（`config.debug.verboseLog` 门控热路径日志）|
| 线上事件 | `ef_failure` / `relay_failover` / `card_quality_violation`（微信后台「自定义分析」）|
| 探针脚本 | `scripts/ops/probe-ef.js`（EF 健康）、`check-quota.js`（配额）、`check-snapshot-freshness.js`（**队徽**快照）、`diag-report.js` |
| 中转自检 | `/healthz`（回显 `ipSource`/`rlMax`/`rlSrc`/`routes`）、`/healthz?deep=1`（深检 EF + Supabase 可达）|

---

## 7. CI / 运维

| workflow | 触发 | 作用 |
|---|---|---|
| `ci.yml` | push / PR | 全量门禁（`test:all` 等）|
| `deploy-admin.yml` | push `admin/**` / 手动 | 构建并发布 admin 到 GitHub Pages |
| `sync-upcoming.yml` | 定时 | 刷新**队徽快照**并 commit；抓 LP 写 Supabase `upcoming_schedule`（★ 赛程/联赛内置快照已移除） |
| `sync-liquipedia.yml` | 定时 | LP slug / 解析产物同步 |
| `discover-tournaments.yml` | 定时 | 赛事发现 |
| `ops-maintenance.yml` | 每日 | 清 `aggregation_cache` 过期行 + 快照新鲜度 + 配额探针（失败 → Webhook 二级告警）|
| `ef-health.yml` | 每 6h | 打 EF 健康检查（保活 + 失败告警）|

---

## 8. 工程纪律

- **门禁**：`check:syntax` + `eslint --rulesdir scripts/eslint-rules` + `npm run test:all`（套件清单以 `package.json` 为准）+ `infra/proxy/test.mjs`。
- **契约守卫**（防「改 A 影响 B」）：`check-edge-actions`（`ACTION_MAP ∪ PARAM_MAP ⊆ EDGE_ACTIONS` + `cloudProxy.call('x')` 字面量扫描）、`check-ef-contract`、`check-card-contract`、`check-token-overreach`。
- **pre-commit**：husky 跑 `check:syntax + eslint + npm test`。
- **提交规范**：`feat|fix|perf|refactor|docs|chore(scope): 说明`。
- **成对改动坑**（本项目踩过）：改「中转主机名」必须同时改 `PROXY_HOSTS` 与微信后台白名单；改「出口」勿在别处再写字面量。

---

## 9. 决策记录与已知技术债（现行）

| # | 项 | 状态 |
|---|---|---|
| 1 | 客户端全部流量收口到中转（弃直连 `*.supabase.co`）| ✅ **已发版生效（v1.3.0 · 2026-10-17）**——「数据不更新」已修复 |
| 2 | 中转「默认裁剪 300」（C）+ 客户端 `X-Trim: 0` | ✅ 已实施；**须同包发版**（纪律，当前无回归）|
| 3 | 三出口容灾（`[0]`/`[1]` Deno + `[2]` Netlify）| ⚠️ 只防域名级阻断；**跨提供商未落地**（CF 全系被 RST）|
| 4 | 中转按 IP 限流 120/min | ⚠️ CGNAT 共享出口下有误伤风险；建议阈值上调至 300 |
| 5 | admin 公网站 | ⚠️ 写令牌会内联进公开 bundle ⇒ 建议保持只读 |
| 6 | `BUG-C` 底层设计债（用 `wx.cloud` 真值 gate EF 可用性）| ⚠️ 保留改法待做 |
| 7 | `P1-17` 赛事名 CJK/西里尔归一族 | ⚠️ 未统一（队名两族已收敛）|
| 8 | `aggregation_cache` 配额 | ✅ 2026-10-16 实测 **259/5000**、过期 **0** |
| 9 | P2-21 主包瘦身 | ✅ 结构已核（队徽快照 205KB 已出主包）；**压缩后体积待 DevTools 实测** |
| 10 | 快照新鲜度 | ✅ 队徽快照 0.2 天前（每日 CI）；★ 赛程/联赛内置快照已于 2026-10-24 移除 |
| 11 | 中转「陈旧兜底」（2026-10-24）| ✅ 已实施（有过期缓存时单次 4s + STALE 回退，并给 body 读加超时）；**待重贴 `[0]`/`[1]` 生效** |
| 12 | 内置赛程/联赛快照（2026-10-24）| ✅ 已移除（改为纯联网；CI 只保留队徽快照 + Supabase `upcoming_schedule`）|

---

## 10. 修订日志（近三版）

| 版本 | 日期 | 要点 |
|---|---|---|
| **v1.3.0** | 2026-10-16（**2026-10-17 正式发布**）| 客户端改走中转（**修「数据不更新」**，线上已生效）；批次 1~5 共 30 项修复收口；详情页/首页提速；主包瘦身 ~200KB；admin 上线（GitHub Pages + 经中转读写）；P2-8 队标/头像批量化。**发版材料**：`deliverables/提审版本描述_v1.3.0_2026-10-16.md` |
| v1.2.1 | 2026-09-28 | 对局状态/重复卡修复、BO 赛制误判修正、赛程待补提示、加载提速 |
| v1.2.0 | 2026-09-22 | 「后端单点收敛」（云开发退役 → Supabase 单后端）+ DB 迁移 |

---
