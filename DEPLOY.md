# 云函数部署操作文档（DOTA2 赛事通 · aggregation）

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

本文件说明如何把 `cloudfunctions/aggregation` 这个云函数部署到微信云开发（CloudBase），
让「即将到来」tab 的 **Liquipedia 实时赛程**（无需任何 API key）以及 STRATZ / Steam 代理生效。

> 本地调试（微信开发者工具的「云函数本地调试」）不部署也能用新代码；
> 但**真机预览 / 体验版 / 线上版**必须上传并部署，否则客户端只会回退到本地 curation 静态列表。

---

## 一、前置确认（项目已满足）

| 配置项 | 位置 | 状态 |
| --- | --- | --- |
| 云函数根目录 | `project.config.json` → `cloudfunctionRoot: "cloudfunctions/"` | ✅ 已配置 |
| AppID | `project.config.json` → `appid: "wx6625103427d03523"` | ✅ 已配置 |
| 客户端启用云代理 | `utils/config.js` → `cloudProxy.enabled: true` | ✅ 已开启 |
| 云函数依赖 | `cloudfunctions/aggregation/package.json`（got + wx-server-sdk） | ✅ 已声明 |

---

## 二、第一步：在微信开发者工具里开通云开发环境

如果目录树里 `cloudfunctions/` 文件夹**没有云图标**、右键**没有「上传并部署」**，
99% 是因为这步还没做。

1. 打开 **微信开发者工具**，载入本项目。
2. 顶部工具栏点击 **「云开发」** 按钮（工具栏右侧，云朵图标）。
   - 首次点击会弹出「开通云开发」引导。
3. 按引导创建一个环境：
   - 环境名称：随意（如 `dota2-esports`）
   - 配额：选 **免费版（基础版 1 个）** 即可，Liquipedia 代理流量很小。
   - 开通后会生成一个 **环境 ID**，形如 `dota2-esports-1gabcde1234`。
4. 开通完成后，左侧目录树里 `cloudfunctions/` 文件夹会出现一个 **云朵图标**，
   其下的 `aggregation` 文件夹现在可以被识别为云函数。

> ⚠️ 开通后建议记住你的 **环境 ID**，后面真机部署需要填进 `app.js`。

---

## 三、第二步：上传并部署（3 个入口，任选其一）

### 入口 A：目录树右键文件夹（最常用）
1. 在左侧 **资源管理器（目录树）** 中，找到 `cloudfunctions/aggregation` 这个**文件夹**。
2. **右键点击 `aggregation` 文件夹本身**（不是里面的 `index.js` 文件）。
3. 在弹出的菜单里选择：
   - **「上传并部署：云端安装依赖（不上传 node_modules）」** ✅ 推荐
     （自动在云端 `npm install`，包体最小）
   - 或「上传并部署：所有文件」（把 node_modules 也传上去，较慢，不推荐）

### 入口 B：云开发控制台 → 云函数列表
1. 点顶部 **「云开发」** 打开控制台。
2. 左侧选 **「云函数」**。
3. 在 `aggregation` 这一行右侧，点 **「部署」/「上传」** 按钮（或右键该行）。
4. 同样选「云端安装依赖」。

### 入口 C：选中文件后在编辑器内右键
1. 在编辑器里打开 `cloudfunctions/aggregation/index.js`。
2. 在代码区 **右键** → 选「上传并部署」（同样选云端安装依赖）。

> 部署过程一般 10~40 秒，状态栏会显示「上传中 / 安装依赖中 / 部署成功」。

---

## 四、第三步：配置云函数环境变量（可选，但建议）

本项目的 **Liquipedia 实时赛程不需要任何 key**，不配也能跑。
只有当你想启用 **STRATZ 赛程窗口 / Steam 奖金池** 时才需要配 key。

1. 云开发控制台 → **「云函数」** → 点 `aggregation`。
2. 进入函数详情 → **「配置」/「环境变量」** 标签页。
3. 添加：
   - `STRATZ_API_KEY` = 你的 STRATZ key（免费申请：https://stratz.com/api ）
   - `STEAM_API_KEY` = 你的 Steam key（可选）
4. 保存后，**重新部署一次**云函数使环境变量生效（入口见第三节）。

> 没配 STRATZ_API_KEY 也没关系：`preheatUpcoming()` 会自动改走 Liquipedia 路径，
> 「即将到来」tab 照常显示下半年全部 Tier 1/2 赛事。

---

## 五、第四步：让客户端绑定你的环境（真机必做）

`app.js` 里的 `wx.cloud.init()` 已经改为**从配置自动读取环境 ID**：

```js
// app.js（已实现，无需再改）
wx.cloud.init({ env: config.cloudProxy.envId || undefined, traceUser: true });
```

你**唯一要做的**是在 `utils/config.js` 的 `cloudProxy` 段填入你的环境 ID：

```js
// utils/config.js
cloudProxy: {
  enabled: true,
  envId: 'dota2-esports-1gabcde1234', // ← 换成第二节开通的环境 ID（留空则走默认环境）
  circuitBreakerThreshold: 3
}
```

> 留空 `envId` 时，`wx.cloud.init()` 走默认环境，仅当账号下**只有一个云环境**时安全；
> 若账号下有多个环境，必须显式填写，否则真机会报 `env not found`。
> 填好后在微信开发者工具里**重新编译**即可，无需改动 app.js。

---

## 六、验证是否部署成功

1. 云开发控制台 → **「云函数」** → `aggregation` → **「日志」**，看是否有调用记录。
2. 在小程序里切到 **「赛事」页 → 「即将到来」** tab：
   - 正常会看到 TI 2026、PGL Wallachia S9、BLAST SLAM VIII、Esports Nations Cup 2026、BLAST SLAM IX 等。
   - 来源徽标显示 **Liquipedia** 或 **STRATZ**（不再只显示 OpenDota）。
3. 快速验证云函数本身：云函数详情页 → **「测试」**，传入
   ```json
   { "action": "getLiquipediaUpcoming" }
   ```
   应返回一组未来 Tier 1/2 赛事（含 `name / start / end / tier`）。

---

## 七、常见问题

**Q：右键 `aggregation` 没有「上传并部署」？**
- 确认右键的是**文件夹**不是文件。
- 确认已按 **第二节** 开通云开发（目录树里 `cloudfunctions/` 要有云图标）。
- 确认 `project.config.json` 的 `cloudfunctionRoot` 指向 `cloudfunctions/`（本项目已正确）。

**Q：部署成功但「即将到来」仍只有 TI 2026？**
- 真机需确认 `app.js` 已填 `env`（第五节），否则云调用失败会回退 curation。
- 看云函数日志是否有报错（如 Liquipedia 限流 429，云函数会自动重试/缓存）。

**Q：上传时提示「依赖安装失败」？**
- 选「云端安装依赖」而非「所有文件」；云端会按 `package.json` 自动安装 `got` / `wx-server-sdk`。
- 若仍失败，检查 `package.json` 依赖版本写法（本项目用 `got@^11` + `wx-server-sdk@latest`）。

**Q：能不能不部署就看到效果？**
- 可以：开发者工具里右键 `aggregation` → **「开启云函数本地调试」**，
  本地 Node 跑新代码，无需上传。仅限本地模拟器，真机仍需部署。

**Q：部署成功但「即将到来」仍只有 TI 2026？**
- 真机需确认 `utils/config.js` 的 `cloudProxy.envId` 已填（第五节），否则云调用失败会回退 curation。
- 看云函数日志是否有报错（如 Liquipedia 限流 429，云函数会自动重试/缓存）。
- 未部署云函数时，客户端会自动回退到本地快照 `utils/upcoming-local.json`（8 个真实赛事），
  tab 不会空，只是数据为发布期快照、非实时。

---

## 八、命令行部署（CloudBase CLI，GUI 替代方案）

如果你不想在开发者工具里点菜单，也可以用 **CloudBase CLI** 在终端部署。
首次需要扫码登录（微信扫码授权），之后可脚本化。

### 1. 安装 CLI
```bash
npm install -g @cloudbase/cli
```

### 2. 登录（微信扫码，仅首次）
```bash
tcb login
```

### 3. 部署云函数
在项目根目录执行（把 `YOUR_ENV_ID` 换成第二节开通的环境 ID）：
```bash
tcb fn deploy aggregation --envId YOUR_ENV_ID
```
CLI 会自动按 `cloudfunctions/aggregation/package.json` 安装依赖并部署。

### 4. 验证
```bash
tcb fn invoke aggregation --envId YOUR_ENV_ID --params '{"action":"getLiquipediaUpcoming"}'
```
应返回一组未来 Tier 1/2 赛事。

> ⚠️ CLI 部署与 GUI 部署**二选一**即可，不要混用导致缓存/环境错乱。
> 部署后再把 `config.cloudProxy.envId` 填上、编译客户端即可生效（第五节）。
