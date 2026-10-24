# DOTA2 赛事通 · 微信小程序

> **文档状态：现行有效** ｜ 最后更新 **2026-10-17** ｜ 代码基线 `14de946` ｜ 线上版本 **v1.3.0（2026-10-17 发布）**
> 本文是**仓库内的权威入口**。同目录 `PROJECT_OVERVIEW.md`（现状全景）、`CODE_WIKI.md`、`DEPLOY.md`、`DOMAIN-NAMING-REFERENCE.md` 为**历史文档**（其顶部横幅已标注归档，勿作现状依据）。
> **v1.3.0 已正式发布（2026-10-17）**；发版材料留档：`deliverables/提审版本描述_v1.3.0_2026-10-16.md`。

---

## 1. 一分钟了解

| 维度 | 内容 |
|---|---|
| 是什么 | 关注 **DOTA2 S 级及以上赛事**、查看**战队 / 队员资料**、对比**双方历史交锋**的轻量微信小程序（**第三方非官方粉丝工具**，仅展示公开电竞数据） |
| 形态 | 原生微信小程序（WXML/WXSS/JS）+ **TDesign** 组件库；appid `wx838148b512800a3a`，基础库 `3.16.3`，`packNpmManually: true` |
| 数据面 | 客户端 → **中转** → **Supabase 单后端**（PostgREST + Edge Functions）→ 上游 OpenDota / Liquipedia / STRATZ / Steam |
| 为什么有「中转」 | 🔴 `*.supabase.co` 在国内被 **SNI 阻断**（TLS 阶段 RST，DNS/TCP 均通）⇒ 客户端直连会「数据不更新」；全部流量因此收口到**境外边缘的中转**（国内可达） |
| 当前版本 | **v1.3.0 · 已发布（2026-10-17）**（上线于 2026-10-17；上一版 v1.2.1 / 2026-09-28）；线上客户端已收口到中转 ⇒ 「数据不更新」已修复 |
| 数据分级 | 赛事分级 SSS/S/A/B/C 由多源（curation / OpenDota / STRATZ / Liquipedia / 社区）**加权投票**共识得出，人工 curation 优先 |

---

## 2. 架构（现行）

```
┌──────────────────────── 客户端（微信小程序） ────────────────────────┐
│  pages/（6 主包页） + subpackages/detail（6） + subpackages/data（4）  │
│        │                                                              │
│  utils/api.js ──────────────── 限流（滑动窗口）+ 429/5xx 退避重试 + TTL 缓存
│  utils/supabaseClient.js ───── PostgREST 读 + EF 调用（_efCall，熔断按 name|action 分桶）
│  utils/cloudProxy.js ───────── EF action 路由白名单（EDGE_ACTIONS）
│  utils/remoteCuration.js ───── 远端 curation 热更新 + 廉价版本探针
│        │                                                              │
│  utils/endpoints.js ────────── 出口切换（主→备，会话粘滞）+ 开机体检     │
└────────┼─────────────────────────────────────────────────────────────┘
         │ PROXY_HOSTS[0..2]（utils/config.js 单一事实源；supabase.url = [0] + '/sb'）
         ▼
┌────────────────── 中转 infra/proxy/worker.mjs（三条部署） ──────────────┐
│  [0] Deno Deploy  https://hungry-pike-9907.re-toke.deno.net   （主出口） │
│  [1] Deno Deploy  https://sparkly-gharial-1210.re-toke.deno.net（备①）  │
│  [2] Netlify Edge https://velvety-llama-a7700e.netlify.app     （备②）  │
│                                                                        │
│  /od/api/*            → api.opendota.com（端点级裁剪 recent / X-Trim；带 vs 时按对手过滤）
│  /sb/rest/v1/*        → Supabase PostgREST（**服务端注入 key**，客户端只持占位串）
│  /sb/functions/v1/*   → Supabase Edge Functions（白名单 EF_ALLOW，转发 x-admin-token）
│  /healthz[?deep=1]    → 探活（回显 ipSource/ipMasked/rlMax/rlSrc/routes）│
│  通用：gzip（`X-Gzip-Ok: 1` 显式门控）、Rate Limit（按 IP 固定窗口）、CORS │
└────────┼─────────────────────────────────────────────────────────────┘
         ▼
┌──────────────────────── Supabase（单后端） ──────────────────────────┐
│  PostgREST 表：curation_events / curation_teams / curation_meta        │
│                aggregation_cache（中转/EF 的 KV 缓存层）               │
│                keep_alive / admin_logs / upcoming_schedule …           │
│  Edge Functions（supabase/functions/）：                               │
│    opendota-proxy · liquipedia-proxy · stratz-proxy · steam-proxy      │
│    haglund-proxy · bundle-aggregator · admin-write · follow-profile    │
│    wechat-auth · subscribe-send · smart-reminders · refresh-wx-token   │
└────────┼─────────────────────────────────────────────────────────────┘
         ▼
   上游：OpenDota（赛事/战队/英雄/物品/比赛）· Liquipedia（奖金池/阵容/排期/logo）
         STRATZ（GraphQL 头像/资料）· Steam CDN（队标/头像图片）
```

**关键切换点**：`config.endpoints.proxy = PROXY_HOSTS`（唯一事实源）。改出口 = 只改 `utils/config.js:28-32`。

---

## 3. 目录结构

```
dota2-esports/
├── pages/                    主包 6 页：index / leagues / teams / follow / data / search
├── subpackages/
│   ├── detail/               分包：league-detail / match-detail / team-detail / h2h / privacy / settings
│   │   └── team-logo-local-data.js   ★ 队徽快照（P2-21 已移出主包）
│   └── data/                 分包：hero / hero-detail / item / item-detail
├── utils/                    客户端模块（api / sources / config / endpoints / cloudProxy / image / …）
├── infra/proxy/              中转：worker.mjs + DEPLOY.md + test.mjs（断言套件）
├── supabase/
│   ├── functions/            12 个 Edge Function + _shared
│   └── migrations/           001 ~ 007（索引 / 安全加固 / 限流触发器）
├── scripts/
│   ├── sync/                 数据同步（canon 映射 / 队徽快照 / curation 迁移 / LP 抓取 → upcoming_schedule）
│   ├── ops/                  运维与守卫（check-syntax / check-quota / cleanup-cache / alert / 4 个契约守卫）
│   └── test/                 离线测试套件（由 `npm run test:all` 调度）
├── admin/                    curation 管理后台（Vue 3 + Element Plus；GitHub Pages 部署）
├── .github/workflows/        ci / deploy-admin / sync-upcoming / sync-liquipedia / discover-tournaments / ops-maintenance / ef-health
├── deliverables/             方案、复核、提审材料、诊断报告（**当前证据优先级最高的一类**）
└── archive/legacy-docs/      历史文档
```

---

## 4. 数据源与融合

| 源 | 用途 | 接入方式 |
|---|---|---|
| **OpenDota** | 赛事/战队/英雄/物品/比赛 | 中转 `/od/api/*`（Node/curl 侧同样经它）；EF `opendota-proxy` 作为备用出口 |
| **Liquipedia** | 奖金池 / 阵容 / 赛程 / 队标元数据 | EF `liquipedia-proxy`（**云端抓取**：小程序无法自定义 UA，而 LP 强制 UA）|
| **STRATZ** | 选手头像 / 资料 | EF `stratz-proxy`（GraphQL，批量 alias 合并请求）|
| **Steam** | 队标 / 头像图片 | 图片直连 CDN（`downloadFile` 白名单）|
| **curation（人工）** | 分级 / 展示名 / 收录 / TI 名单 | Supabase 三表；写入口 = EF `admin-write`，后台 = `admin/` |

**融合中枢**：`utils/sources.js`（分级加权投票 `consensus.consensusTier`、赛期中位数比对、展示名单一出口）。

---

## 5. 缓存体系（五层，见 `config.js` 预算表）

| 层 | 位置 | 说明 |
|---|---|---|
| T1 | 客户端内存热缓存 | `cloudProxy.HOT_TTL_SEC`（仅 `HOT_ACTIONS`）|
| T2 | 客户端本地 Storage | `api.js` 的 `cachedFresh` / `cached`（SWR）|
| T3 | 中转 | GET 短路 TTL + EF 白名单 `EF_CACHE_MS` |
| T4 | EF 内存 L1 | `_shared/l1cache.ts`（Map + TTL + FIFO）|
| T5 | EF Postgres | `aggregation_cache`（KV 表，每日由 CI 清理过期行）|

> ⚠️ 三条一致性约束（见 §P2-7）：中转 GET TTL ≤ 客户端轮询间隔；EF-PG TTL ≤ 客户端硬 TTL；SWR 新鲜窗口仅当 ≥ EF-PG TTL 才有效。

---

## 6. 本地开发与门禁

```bash
# 小程序：用微信开发者工具打开本目录（packNpmManually = true，无需「构建 npm」）
npm test          # 3 套快检（canonical / BO / LP 抓取守卫）—— pre-commit 钩子会跑
npm run test:all  # 全量离线门禁（套件清单以 package.json 的 test:all 为准）
npm run check:syntax        # 全仓语法体检
npm run lint                # ESLint（--rulesdir scripts/eslint-rules；含自定义规则）
node infra/proxy/test.mjs   # 中转断言套件（已并入 test:all）
node scripts/ops/check-quota.js            # 配额探针（需服务端凭据）
node scripts/ops/check-snapshot-freshness.js  # 队徽快照新鲜度（★ 2026-10-24 起仅此一项）
```

**契约守卫**（防「改 A 影响 B」）：`check-edge-actions`（映射 ⊆ EDGE_ACTIONS + call 字面量扫描）、`check-ef-contract`、`check-card-contract`、`check-token-overreach`。

**提交纪律**：husky pre-commit 跑 `check:syntax + eslint + npm test`；提交信息用 `feat|fix|perf|refactor|docs|chore(scope): 说明`。

---

## 7. 部署

| 目标 | 方式 |
|---|---|
| **中转**（`infra/proxy/worker.mjs`）| `[2]` 随 push 自动；`[0]`/`[1]` 为 **Deno 手贴副本**，改完须**同步重贴三台**（否则版本漂移）。步骤见 `infra/proxy/DEPLOY.md`。自检：`/healthz?deep=1` + 三台灰度和 |
| **Edge Functions** | `supabase functions deploy <name> --project-ref gkticzdaicpdtxheyxsd --no-verify-jwt`，再用 `functions list` 核 VERSION（**命令不报错 ≠ 部署生效**）|
| **admin 后台** | `.github/workflows/deploy-admin.yml` → **GitHub Pages**：`https://re-toke.github.io/dota2-esports/`（哈希路由 `#/events`）。详见 `admin/README.md` |
| **快照** | `.github/workflows/sync-upcoming.yml` 定时刷新**队徽快照**（`utils/team-logo-map.json` + `subpackages/detail/team-logo-local-data.js`）并 commit；赛程写 Supabase `upcoming_schedule`。**★ 2026-10-24：内置「赛程 / 联赛」快照已移除**（改为纯联网） |
| **运维** | `.github/workflows/ops-maintenance.yml` 每日：清 `aggregation_cache` 过期行 + 快照新鲜度 + 配额探针（超阈值推 Webhook）|

---

## 8. 服务器域名清单（微信后台配置）

| 列表 | 值 | 说明 |
|---|---|---|
| **request** | `https://hungry-pike-9907.re-toke.deno.net`<br>`https://sparkly-gharial-1210.re-toke.deno.net`<br>`https://velvety-llama-a7700e.netlify.app` | **三个中转域名缺一不可**（客户端已不直连 `*.supabase.co`）|
| **downloadFile** | `https://cdn.cloudflare.steamstatic.com`<br>`https://cdn.steamusercontent.com`<br>`https://avatars.akamai.steamstatic.com` | 第三条为 P1-22 头像镜像（原域 `avatars.steamstatic.com` 被 RST）|
| **socket** | 不需要 | — |

---

## 9. 发版流程

1. 读 `deliverables/提审版本描述_v*.md`（版本描述 + 页面清单 + 审前必查 + 上传命令）。
2. 上传（开发者工具 CLI）：`wechat-devtools-cli` 的 `devtools.py upload --version <x.y.z> --desc "<一行>"`。
3. 后台设为**体验版**自测 → 提交审核。
4. ⚠️ 提审表单必须选「采集用户隐私」；隐私指引需「已通过」；需已备案。

---

## 10. 已知限制与技术债（现行）

- ✅ **「数据不更新」已修复（v1.3.0 · 2026-10-17 发布）**：线上客户端已改走中转 + 携带 `X-Trim: 0` ⇒ 直连 `*.supabase.co` 的阻断不再影响用户；中转「默认裁剪 300」的约束亦**已满足**（与客户端**同包上线**，未出现中间态）。
- 🔴 **发版纪律**：中转「默认裁剪 300」（C）与客户端 `X-Trim: 0` 必须**在同一个包里一起发**（本项目从未出现过中间态）。
- ⚠️ **中转「陈旧兜底」需重贴才能生效**（2026-10-24 改动 `worker.mjs`）：`[2]` 随 push 自动，`[0]`/`[1]` 为 Deno 手贴副本，**三台都要重贴**。未重贴前行为与旧版一致（12s×2），不会出错但不享受提速。
- ⚠️ **跨提供商冗余未落地**：`[0]`/`[1]` 同注册域同 IP（Deno），`[2]` 运行时同为 Deno ⇒ 只防「域名级」阻断，不防「Deno 系整体故障」。
- ⚠️ **中转限流** 按 IP（120/min/IP，CGNAT 共享出口下有误伤风险；客户端对 429 只退避重试、不切出口）。
- ⚠️ **admin 公网站写令牌风险**：`VITE_ADMIN_TOKEN` 会被内联进公开 bundle ⇒ **建议保持只读**（不配 `ADMIN_TOKEN`）。
- ⚠️ **BUG-C 底层设计债**：用「云开发真值(`wx.cloud`)」gate「EF 可用性」的脆弱设计保留待改。
- ⚠️ **P1-17 未收敛**：赛事名含 CJK/西里尔的归一族未统一（队名两族已收敛）。
- ✅ **配额现状**（2026-10-16 实测）：`aggregation_cache` **259 / 5000 行**、过期 **0**。

---

## 11. 文档索引（都在**本仓库内**）

| 文档 | 性质 |
|---|---|
| `README.md`（本文） | **现行权威入口** |
| `PROJECT_OVERVIEW.md` | **现行**：现状全景（架构 / 数据流 / 模块职责 / 缓存 / 债）|
| `deliverables/优化方案-数据加载-后端-代码-2026-10-10.md` | 现行优化方案与逐项实施/验证记录（§5 总表）|
| `deliverables/提审版本描述_v*.md` | 发版材料 |
| `deliverables/优化方案-…-复核意见-2026-10-10.md` | 方案复核（D1~D10）|
| `admin/README.md` | 后台部署与网络要求 |
| `infra/proxy/DEPLOY.md` | 中转部署分步手册 |
| `CODE_WIKI.md` / `DEPLOY.md`(根) / `DOMAIN-NAMING-REFERENCE.md` | **历史文档**（已归档，勿作现状依据）|
| `archive/legacy-docs/` | 更早的历史文档 |

> 证据优先级：**代码 / `git log` > `deliverables/` > 本文 > 历史归档文档**。
