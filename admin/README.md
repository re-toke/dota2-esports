# DOTA2 Curation 管理后台

DOTA2 电竞小程序的 curation 数据管理后台（阶段2-②），用于在 Web 端管理云数据库中的赛事 / 战队 / TI 名单数据。与小程序共用同一个微信云开发环境。

## 技术栈

- **Vue 3**（Composition API，`<script setup>`）
- **Vite 5**（构建与开发服务器）
- **Element Plus**（UI 组件库，按需导入）
- **Vue Router 4**（路由）
- **Pinia**（状态管理，预留）
- **@cloudbase/js-sdk**（Web 端访问微信云开发数据库）

## 认证模式

当前阶段**暂不做认证**（阶段2-① / ② 简化方案）：

- 不需要微信扫码登录，打开页面直接进入管理后台
- 顶栏显示「未认证模式」标签提示当前状态
- 数据库**读取**：需将 collection 权限设为「所有用户可读」
- 数据库**写入**：前端无法直写，需走云函数中转（阶段2-③ 实现）

> 后续如需启用认证，可在阶段2-③ 接入 CloudBase 微信扫码登录或自建账号密码体系。

## 阶段2-② 功能说明

阶段2-② 已实现赛事 / 战队 / TI 名单的 **CRUD 界面与查询能力**，写操作受云函数未接入限制。

### 已完成功能

| 模块 | 查询（读） | 写操作（新增/编辑/删除） |
| ---- | ---------- | ------------------------ |
| 赛事管理（`/events`） | ✅ 真实查询 `curation_events`，支持按规范名 / 别名模糊搜索、前端分页（pageSize=20） | ⚠️ UI 已就绪，点击时提示「写操作将在阶段2-③ 接入云函数后可用」 |
| 战队管理（`/teams`） | ✅ 真实查询 `curation_teams`，支持按名称 / 缩写 / 别名模糊搜索 | ⚠️ 同上 |
| TI 名单管理（`/meta`） | ✅ 真实查询 `curation_meta`，展示 version / count / updatedAt / ids | ⚠️ 添加 / 删除 team_id、写入 version 均提示待阶段2-③ |

### 写操作限制说明

微信云开发数据库在 **Web 端**调用时，不能在客户端 SDK 直接调用 `add` / `update` / `remove`（会报权限错误），只能查询。因此：

- 阶段2-② 的查询（读）操作直接用 CloudBase JS SDK 调用 `db.collection().limit(100).get()`，无需云函数。
- 阶段2-② 的所有写操作按钮（新增 / 编辑 / 删除 / 添加 ID / 重算 version）在点击时通过 `ElMessage.warning` 提示用户「写操作将在阶段2-③ 接入云函数后可用」，**不会真正写入数据库**。
- 阶段2-③ 将通过云函数中转写操作（云函数以管理员身份写入），届时写操作按钮将正式生效。

### 数据访问层

`src/api/cloudbase.js` 封装了所有数据访问逻辑：

- `fetchEvents()` / `fetchTeams()` / `fetchMeta()`：查询接口（读，可直接用 SDK）。
- `normalizeEventName(name)`：规范名归一化（与 `utils/consensus.js` 的 `normName` 一致）。
- `versionFromData(events, teams, tiIds)`：计算数据指纹（MD5 前 8 位），与 `scripts/migrate-curation-to-db.js` 的 `computeVersion` 逻辑一致。浏览器端无 Node `crypto`，内嵌 Paul Johnston 的 RFC 1321 MD5 实现（BSD License），输出与 Node `crypto.createHash('md5')` 一致。

### 字段约定

- **curation_events**：`_id` = 规范名归一化；`tier = { grade, rank, label }`；`start` / `end` 为 Unix 秒（UTC）；表单用 `el-date-picker`（`value-format="x"` 毫秒）中转后 `/1000` 转秒。
- **curation_teams**：`_id` = `String(team_id)`；`tier = { grade, label }`，grade 可选 S/A/B/C/SSS。
- **curation_meta**：`_id = "ti_contestant_ids"`；`ids: number[]`；`version` 为 8 位数据指纹。

## 环境准备

1. 复制环境变量示例文件：

   ```bash
   cp .env.example .env
   ```

2. 确认 `.env` 中的云开发 envId（默认已填入与小程序共用的环境）：

   ```bash
   VITE_CLOUDBASE_ENV=cloud1-d2g0wufv8f2ce3871
   ```

## 本地开发

```bash
cd admin
npm install
npm run dev
```

启动后访问：http://localhost:5173

## 云数据库权限配置

后台访问的 collection：

| collection         | _id                         | 主要字段                                       |
| ------------------ | --------------------------- | ---------------------------------------------- |
| `curation_events`  | 规范名归一化                 | canonical / aliases / tier / year / start / end / liquipediaSlug |
| `curation_teams`   | team_id 字符串              | name / tag / country / tier / aliases          |
| `curation_meta`    | `ti_contestant_ids`         | ids / version / count                          |

**权限设置**（在微信开发者工具 → 云开发 → 数据库 → 对应 collection → 权限设置）：

- 阶段2-① / ②（仅读取）：设为「**所有用户可读，仅创建者可写**」
- 阶段2-③（读写分离）：读取保持「所有用户可读」，写入通过云函数中转（云函数以管理员身份写入）

> 阶段2-② 已通过 `db.collection().limit(100).get()` 真实读取上述 collection；写操作因权限限制暂未生效。

## 部署到云开发静态托管（阶段2 后期）

```bash
npm run build
tcb hosting deploy ./dist -e cloud1-d2g0wufv8f2ce3871
```

## 目录结构

```
admin/
├── .env.example              # 云开发 envId 示例
├── .gitignore
├── index.html                # Vue 3 入口 HTML
├── package.json
├── vite.config.js            # Vite + Element Plus 按需导入配置
├── README.md
└── src/
    ├── App.vue               # 根组件（router-view 出口）
    ├── main.js               # 应用入口（注册 Pinia / Router / 图标）
    ├── api/
    │   └── cloudbase.js      # 数据访问层（查询 + 归一化 + version 计算 + 浏览器端 MD5）
    ├── cloudbase/
    │   └── index.js          # CloudBase 实例初始化（app / db）
    ├── stores/               # Pinia store（预留，阶段2-③ 可扩展）
    ├── router/
    │   └── index.js          # 路由配置（events / teams / meta）
    ├── layouts/
    │   └── MainLayout.vue    # 后台主布局（侧边栏 + 顶栏）
    ├── components/
    │   ├── EventFormDialog.vue # 赛事新增 / 编辑对话框
    │   └── TeamFormDialog.vue  # 战队新增 / 编辑对话框
    └── views/
        ├── Events.vue        # 赛事管理（列表查询 + CRUD UI）
        ├── Teams.vue         # 战队管理（列表查询 + CRUD UI）
        └── Meta.vue          # TI 名单管理（meta 展示 + ID 管理 + version 重算）
```

## 阶段待办

- **阶段2-②**（✅ 已完成）：实现赛事 / 战队 / TI 名单的列表查询、新增 / 编辑 / 删除等 CRUD 界面，接入 `curation_events` / `curation_teams` / `curation_meta` collection。查询操作真实生效，写操作 UI 就绪但暂不写入（提示待阶段2-③）。
- **阶段2-③**（待办）：通过云函数中转写操作，避免前端直写数据库带来的权限与安全问题；完善 `curation_meta` 的版本管理（写入 version）；可选接入认证。
