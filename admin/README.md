# DOTA2 Curation 管理后台

DOTA2 电竞小程序的 curation 数据管理后台，用于在 Web 端管理 Supabase 数据库中的赛事 / 战队 / TI 名单数据。与小程序共用同一个 Supabase 项目（`gkticzdaicpdtxheyxsd`）。

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

## 部署（P2-15 待办）

> ⚠️ **本节为待办（P2-15），当前仅有本地 `npm run build`，尚未接入 CI 静态托管。**

构建产物：

```bash
npm run build        # 输出到 admin/dist/
npm run preview      # 本地预览构建产物
```

静态托管选项（任选其一，需用户侧账号）：

- **Vercel**：导入仓库 → Framework Preset = Vite → Root Directory = `admin` → Build Command `npm run build` → Output Directory `dist` → Environment Variables 填入上述三项。
- **Netlify**：Base directory `admin` → Build command `npm run build` → Publish directory `dist` → 环境变量同上。
- **Cloudflare Pages**：Build command `npm run build` → Build output directory `dist` → Root path `admin`。

部署后冒烟：打开后台 → 三个列表能加载 → 任选一条做一次编辑保存 → 控制台无 401 / 网络错误 → `curation_events` / `curation_teams` / `curation_meta` 数据实际更新。

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
