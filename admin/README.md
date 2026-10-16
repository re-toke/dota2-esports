# DOTA2 Curation 管理后台

DOTA2 电竞小程序的 curation 数据管理后台，用于在 Web 端管理 Supabase 数据库中的赛事 / 战队 / TI 名单数据。与小程序共用同一个 Supabase 项目（`gkticzdaicpdtxheyxsd`）。

## ⚠️ 网络要求（重要 · 2026-10-16 实测）

本后台的**读与写都走直连 `*.supabase.co`**（读 = PostgREST `${VITE_SUPABASE_URL}/rest/v1`；写 = EF `${VITE_SUPABASE_URL}/functions/v1/admin-write`）。

- 🔴 **`*.supabase.co` 在国内网络被 SNI 阻断** —— 2026-10-16 实测：`curl: (35) Recv failure: Connection was reset`（DNS 0.01s / TCP 0.26s 均成功，**TLS 阶段被 RST**）。
- ⇒ **本后台必须在能直连 `*.supabase.co` 的网络下使用**（VPN / 非国内网络）；否则列表读不出、写操作也失败。
- ✅ 开发机已确认可直连 ⇒ 本地 `npm run dev` 与已部署站点可用。

### 为什么**不能**改成走中转 `/sb`（已实测，两条路都堵住）

- **读分页会拿错页**：中转 `/sb/rest/v1` **仅允许 GET**，且 **`Range` 头不生效** —— 实测送 `Range: 1000-1001` 仍返回 `content-range: 0-999/3683`（拿到的是第 0-999 行）。而本后台 `restAll` 用 **`Range` 分页** ⇒ 经中转会取到**重复/错误页**。（另：中转该 REST 路径的缓存键**不含 `Range`**。）
- **写被白名单挡住**：`POST /sb/functions/v1/admin-write` → **404 `{"error":"ef not allowed","name":"admin-write"}`** ⇒ 中转的 EF 白名单（`infra/proxy/worker.mjs` 的 `EF_ALLOW`）**未放行 `admin-write`**。
- 若将来确需脱离直连，须**同时改两处**：① `worker.mjs` 的 `EF_ALLOW` 放行 `admin-write`；② 本后台 `restAll` 改用 `limit`/`offset` 查询参数（**已验证 query 参数会被中转转发**）。

## 技术栈

- **Vue 3**（Composition API，`<script setup>`）
- **Vite 5**（构建与开发服务器）
- **Element Plus**（UI 组件库，按需导入）
- **Vue Router 4**（路由）
- **Pinia**（状态管理，预留）
- **Supabase PostgREST**（读：anon key + RLS）
- **Supabase Edge Function `admin-write`**（写：管理令牌鉴权，EF 用 service key 写入）

> ⚠️ **历史遗留**：`@cloudbase/js-sdk` 依赖与 `src/cloudbase/index.js` 是云开发时代的残留（已无任何 import 引用），可在后续清理时移除。`src/api/cloudbase.js` 是兼容垫片（`export * from './supabase.js'`），视图仍从该路径 import。

## 认证 / 权限模型

- **读**：浏览器用 **anon key** 直连 PostgREST，依赖 Supabase RLS 策略（`curation_*` 三表现役 anon 读策略）。anon key 是公开密钥，受 RLS 保护，放前端安全。
- **写**：浏览器**不能**用 service key（会暴露 + 绕过 RLS）。所有写操作统一 POST 到 EF `admin-write`，由请求头 `x-admin-token` 鉴权（须与 EF secret `ADMIN_TOKEN` 一致），EF 用服务端 service key 完成写入并记 `admin_logs`。
- 顶栏不再显示「未认证模式」标签；写操作是否生效取决于 `VITE_ADMIN_TOKEN` 是否配置且与 EF 侧一致。

## 功能说明

赛事 / 战队 / TI 名单的 **CRUD 全部生效**（读走 PostgREST，写走 EF admin-write）。

| 模块 | 查询（读） | 写操作（新增/编辑/删除） |
| ---- | ---------- | ------------------------ |
| 赛事管理（`/events`） | ✅ 真实查询 `curation_events`，按规范名 / 别名模糊搜索、前端分页（pageSize=20） | ✅ `writeEvent` / `deleteEvent` → EF `admin-write` |
| 战队管理（`/teams`） | ✅ 真实查询 `curation_teams`，按名称 / 缩写 / 别名模糊搜索 | ✅ `writeTeam` / `deleteTeam` → EF `admin-write` |
| TI 名单管理（`/meta`） | ✅ 真实查询 `curation_meta`，展示 version / count / updatedAt / ids | ✅ `updateMeta` → EF `admin-write`（key 已参数化，默认 `ti_contestant_ids`） |

## 数据访问层

`src/api/supabase.js` 是**真实实现**；`src/api/cloudbase.js` 仅为 `export * from './supabase.js'` 的兼容垫片（视图仍从 `@/api/cloudbase` import，文件名保留以兼容既有 import）。

- **读**：`restAll(table, select)` 用 `Range` 头分页拉全量（绕过 PostgREST 单次 max-rows 上限）。
  - `fetchEvents()` → `curation_events`（`canonical_key, league_id, data`）→ 统一转 `{ _id, ...data }`。
  - `fetchTeams()` → `curation_teams`（`team_id, data`）→ 统一转 `{ _id: String(team_id), team_id, ...data }`。
  - `fetchMeta()` → `curation_meta`（`key=eq.ti_contestant_ids`，取 `value`）。
- **写**：`callAdminWrite(operation, params)` POST 到 `${VITE_SUPABASE_URL}/functions/v1/admin-write`，头带 `x-admin-token`。
  - `writeEvent` / `deleteEvent` / `writeTeam` / `deleteTeam` / `updateMeta`。
  - 返回 `{ success, version, source }`（与云函数时期契约一致）。
- **纯函数工具**：`normalizeEventName(name)`（与 `utils/consensus.js` 的 `normName` 一致）、`versionFromData(events, teams, tiIds)`（MD5 前 8 位数据指纹，浏览器端内嵌 RFC 1321 实现，与 Node `crypto.createHash('md5')` 输出一致）。

## 字段约定（Supabase 现行 schema）

- **curation_events**：`canonical_key`（= 规范名归一化）为主键；`league_id`（int，可空）；`data`（jsonb：canonical / aliases / tier / year / start / end / liquipediaSlug 等）。
- **curation_teams**：`team_id`（int8）为主键；`data`（jsonb：name / tag / country / tier / aliases 等）。
- **curation_meta**：`key`（text，默认 `ti_contestant_ids`）为主键；`value`（jsonb：ids / version / count / updatedAt）。
- 表单层用 `_id` 统一指代主键（视图层兼容），写回 EF 时由 `admin-write` 映射到 `canonical_key` / `team_id` / `key`。

## 环境准备

复制环境变量示例文件并填入真实值：

```bash
# 在 admin/ 目录下
copy .env.example .env.local          # Windows cmd
Copy-Item .env.example .env.local     # PowerShell
```

`.env.local` 已在 `admin/.gitignore` 中忽略，**绝不提交**。需配置三项：

| 变量 | 说明 | 来源 |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | Supabase 项目 URL | Dashboard → Project Settings → API |
| `VITE_SUPABASE_ANON_KEY` | anon public key（公开，受 RLS 保护） | 同上 → Project API keys → anon / public |
| `VITE_ADMIN_TOKEN` | 管理令牌（写 EF 用） | 与 EF secret `ADMIN_TOKEN` 完全一致 |

生成并配置管理令牌：

```bash
# 1. 生成令牌（项目根目录，node 已在环境）
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"

# 2. 设到 EF（与上一步同一个令牌）
supabase secrets set ADMIN_TOKEN=<令牌>

# 3. 把同一个令牌填入 admin/.env.local 的 VITE_ADMIN_TOKEN
```

> 缺 `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` 时页面不白屏，但控制台会警告且数据无法加载；缺 `VITE_ADMIN_TOKEN` 时写操作会抛错「缺少 VITE_ADMIN_TOKEN」。

## 本地开发

```bash
cd admin
npm install
npm run dev
```

启动后访问：http://localhost:5173

## Supabase 权限 / RLS

后台读写依赖的表与策略：

| 表 | anon 读 | 写 |
| --- | --- | --- |
| `curation_events` | ✅ RLS 读策略 | 经 EF `admin-write`（service key） |
| `curation_teams` | ✅ RLS 读策略 | 经 EF `admin-write`（service key） |
| `curation_meta` | ✅ RLS 读策略 | 经 EF `admin-write`（service key） |
| `admin_logs` | — | EF 写入（审计） |

读策略与迁移见 `supabase/migrations/`（anon 读 + `admin-write` 相关安全策略见 `007-security-hardening.sql`）。

## 部署（CI 静态托管 · GitHub Pages）

已接入 CI：`.github/workflows/deploy-admin.yml` —— `push admin/**`（或手工 `workflow_dispatch`）→ `npm ci && npm run build` → 发布到 **GitHub Pages**。

产物 URL：**`https://re-toke.github.io/dota2-esports/`**（路由为**哈希模式** `#/events`）。

**为什么是 GitHub Pages（而非 Netlify）**：本仓库是 **public** ⇒ Pages 免费，且用内置 `GITHUB_TOKEN` ⇒ **零第三方账号、零新增 secret**。（原 Netlify 方案需 `NETLIFY_AUTH_TOKEN` + `NETLIFY_SITE_ID`，2026-10-16 因取不到这两个值而改方案。）

**前置（一次性）**：

1. 仓库 **Settings → Pages → Source = "GitHub Actions"**（工作流已带 `enablement: true` 尝试自动启用；若首次部署报 Pages 未启用，则手动按此句打开）。
2. `SUPABASE_ANON_KEY` secret —— **已配置**（公开安全、受 RLS 保护）。
3. `ADMIN_TOKEN` secret —— **可选**：写入口 EF 令牌（= 本地 `VITE_ADMIN_TOKEN` / EF secret `ADMIN_TOKEN` 同值）。🔴 **配它 = 把写令牌内联进公开 bundle** ⇒ **务必先给站点加访问限制再配**；不配则站点为**只读**（写操作报缺令牌，不泄露写权限）。

本地构建（等价于 CI 构建步，可先自检）：

```bash
cd admin
npm ci
npm run build        # 输出到 admin/dist/；CI 传 VITE_BASE=/dota2-esports/
npm run preview      # 本地预览构建产物
```

🔴 **访问前提**：见顶部「网络要求」—— 后台必须能直连 `*.supabase.co`（VPN / 非国内网络）。

部署后冒烟：打开站点 → 三个列表能加载 →（若配了 `ADMIN_TOKEN`）任选一条编辑保存 → 控制台无 401 / 网络错误 → `curation_events` / `curation_teams` / `curation_meta` 数据实际更新。

## 目录结构

```
admin/
├── .env.example              # Supabase 环境变量示例（复制为 .env.local）
├── .env.local                # 本机真实值（gitignored，不提交）
├── .gitignore
├── index.html                # Vue 3 入口 HTML
├── package.json
├── vite.config.js            # Vite + Element Plus 按需导入配置
├── README.md
└── src/
    ├── App.vue               # 根组件（router-view 出口）
    ├── main.js               # 应用入口（注册 Pinia / Router / 图标）
    ├── api/
    │   ├── supabase.js       # ★ 真实数据层（PostgREST 读 + EF admin-write 写 + 纯函数工具）
    │   └── cloudbase.js      # 兼容垫片：export * from './supabase.js'（视图仍从此 import）
    ├── cloudbase/
    │   └── index.js          # 历史残留（已无引用，可清理）
    ├── stores/               # Pinia store（预留）
    ├── router/
    │   └── index.js          # 路由配置（events / teams / meta）
    ├── layouts/
    │   └── MainLayout.vue    # 后台主布局（侧边栏 + 顶栏）
    ├── components/
    │   ├── EventFormDialog.vue
    │   └── TeamFormDialog.vue
    └── views/
        ├── Events.vue        # 赛事管理
        ├── Teams.vue         # 战队管理
        └── Meta.vue          # TI 名单管理
```

## 历史阶段说明

- **阶段2-②**：CRUD 界面就绪，读走 CloudBase，写仅 UI（待云函数）。
- **阶段2-⑤**：数据层从 CloudBase 迁移到 Supabase（PostgREST 读 + EF `admin-write` 写），写操作真实生效。
- **P2-15 待办**：补 CI 静态托管部署（Vercel/Netlify/Pages），移除 `@cloudbase/js-sdk` 依赖与 `src/cloudbase/` 残留，把视图 import 从 `@/api/cloudbase` 重命名到 `@/api/supabase`。
