# 部署手册（DEPLOY）

> 目标：得到一个**国内可达的域名**，把 Supabase（与 OpenDota 兜底）藏到它后面。
> **两条路任选**；先试 A（免费、免运维），若 A 的域名被阻断再上 B。

## 0. 先记住三条（都是实测出来的）

| # | 结论 | 依据 |
|---|---|---|
| 1 | **中转必须部署在境外/香港** | 本机（国内）跑同一份代码，`fetch('https://api.opendota.com/...')` **直接失败**（实测 `/od/api/leagues` → 502 `fetch failed`）⇒ 放国内等于白装 |
| 2 | **必须用"自有域名"** | 免费子域实测不稳（`pages.dev` 一会儿通一会儿被重置；`workers.dev`/`vercel.app` 不通） |
| 3 | **改域名不需要重新提审** | 小程序后台加 request 白名单后**对已上线版本立即生效** ✓ |

### 0.1 「必须要自有域名吗？」—— 要，但只需买一个域名

**⚠️ 先看这条（关系到"买域名值不值"）：小程序 request 域名可能要求 ICP 备案**
- 项目内既有研究（`DOMAIN-NAMING-REFERENCE.md` §8）与微信文档均写：**合法域名"必须 ICP 备案"，且备案主体须与小程序主体一致**；
- 但实践中也有**未备案域名通过**的案例 ⇒ **不要听任何人（包括我）的判断，用 1 分钟实测**：

> **决定性验证（先做这个，再决定买不买域名）**：
> 随便拿一个**已存在的域名**（或先买最便宜的）→ 小程序后台「开发管理 → 开发设置 → 服务器域名 → request」
> 尝试添加 → **看后台是否接受**。
> · ✅ 接受 ⇒ 备案不卡你 ⇒ 按本手册继续；
> · ❌ 被拒（提示需备案）⇒ **必须走 ICP 备案**：备案本身**免费**，但需要 ① **国内云资源**作为接入
>   （腾讯云/阿里云的一台最低配轻量或备案专用实例）② **主体与小程序一致** ③ 耗时 **1~20 个工作日**。
>   ⇒ 这种情况下请回头比较 **方案 D（微信云开发：免域名、免备案、免白名单）** 是否更划算。

**技术上不必须自有域名**：CF Worker 部署后自带免费入口 `https://<worker名>.<账号>.workers.dev`。
**但实测它在国内基本不可用** ⇒ 线上入口**必须**是自有域名：

| 入口 | 免费 | 国内可达（实测） | 能否作线上入口 |
|---|---|---|---|
| `*.workers.dev`（CF 默认） | ✅ | ❌ **DNS 被污染（解析到 65.49.26.97）+ TIMEOUT** | ❌ |
| `*.pages.dev`（CF Pages） | ✅ | ⚠️ **不稳定**：一次 CF 真实 IP + 301 ✓，另一次被污染 + `ECONNRESET` | ❌ |
| **自有域名 + CF Custom Domain** | 仅域名费 | ✅ 稳（同类参照 `dota.haglund.dev` 多轮一致 ✓） | ✅ **唯一稳的** |

**所以真正要花的只有"一个域名"**（+ 可能的备案），Worker / 证书 / CDN **全都免费**。

- 💰 **成本与续费**（详见 §10 成本表）：域名是**按年租用、每年续费**；
  建议买 **`.com`（~¥60~90/年）** —— 我**不推荐** `.top`/`.xyz`（首年虽 ¥1~10，但**续费更贵**，
  且这类后缀被垃圾站大量滥用 ⇒ **更容易进各种名单**，与"我们要的就是国内可达"直接冲突）。
- 🔧 **必须接入 Cloudflare**：CF 的 Custom Domain 要求域名在该 CF 账号下 ⇒ 买完去注册商**改 NS**（免费、几分钟生效）。
- 🧪 **`workers.dev` 仍有用途**：**先在开发者工具里用它验证"代码跑起来了"**（本地 `urlCheck:false` 不受域名限制），
  但**不要把它当线上入口**。（这也解释了为什么很多教程说"免费就能用"——他们没在国内真机测过。）

> 若**连一个域名都不想买**（或不想面对备案）⇒ 换路线：**方案 D（微信云开发，免域名/免备案/免白名单）**
> 或 **方案 G（零后端：只直连 haglund/LP/Valve + curation 烘焙）**。代价见
> `deliverables/真机数据不更新-方案全景对比与推荐-2026-10-10.md` §8。
> ⚠️ **注意**：香港轻量那条路（路径 B）**同样需要域名**（小程序白名单**只接受域名、不接受 IP**）。

### 0.2 长期成本一览（回答"后面还需付费吗"）

| 项 | 一次性 | **每年/持续** | 说明 |
|---|---|---|---|
| **域名** | 注册费 | **✅ 每年续费** ¥60~90（.com） | **这是唯一的长期新增支出**；建议开**自动续费**；国内注册商需**实名**（免费） |
| **ICP 备案**（若必须） | 1~20 工作日（免费） | 免费（到期随域名续） | 但要**国内云资源作接入** + 主体一致 ⇒ 可能多一台最低配云资源 |
| Cloudflare Workers | 免费 | **免费**（10 万请求/天；超了 $5/月） | 当前量级：日活 100 × 3 次刷新 × ~30 请求 ≈ 9 千/天 ⇒ **远在免费额度内** |
| Cloudflare DNS / SSL / CDN | 免费 | 免费 | 证书自动续期 |
| **Supabase** | — | **本方案不新增**（中转加了缓存 ⇒ 反而**降低**上游调用量） | 若将来升套餐是另一笔，与本方案无关 |
| 微信小程序认证费 | — | ¥300/年（**既有成本**，非本次新增） | 与域名无关 |

⇒ **一句话**：**新增的长期支出 = 域名的年费（¥60~90/年）**；可能还多一步**备案**（免费但费时间，且要国内云资源）。
其余（Worker/DNS/证书/CDN）**长期免费**。

---

## 路径对比（先选一条）

| | **A · Cloudflare Worker + 自定义域名** | **B · 香港轻量服务器 + Caddy** |
|---|---|---|
| 成本 | **免费**（Workers 10 万请求/天）+ 域名 ~¥10~80/年 | 轻量 ~¥24~30/月 + 域名 |
| 运维 | **零**（Serverless） | 要管服务器（systemd/证书/续费） |
| 上手 | 一条 `wrangler deploy` | 装 Node + Caddy + 上传文件 |
| 稳定性 | 好（CF 边缘）；域名是变量 | 好（自有 IP）；域名/IP 都是变量 |
| **建议** | ★ **先试这个** | A 被墙时再上 |

---

## 路径 C · **免费 PaaS 子域（零成本，优先试这个）**

> 如果你**不想花任何钱** ⇒ 走这条。不需要域名、不需要备案、不需要服务器。
> 我们只是**换一个免费载体**（CF 的 `pages.dev`/`workers.dev` 实测不可达，但**别的 PaaS 主域都可达**）。

> ★★ **先分清用途（2026-10-12，关系到 P1-2）**：
> **本节下方的方式 A / B / C 全都是 Deno Deploy** ⇒
> · ✅ 适合：**第一次**部署中转（主出口，现状就是它）；
> · ❌ **不适合：P1-2 的「第二台（备出口）」** —— 与主出口（`*.deno.net`）**同提供商**，
>   起不到"跨提供商"的作用。第二台请用本节末尾「**备选平台**」里的
>   **Netlify / Render / Fly.io**（同样零成本），**逐步操作见 §路径 E**。
> · ⚠️ 例外的取舍：若你**自愿接受「同提供商、仅换域名」**，方式 A（Deno Playground）仍能防
>   **域名级阻断**（这正是本项目实测到的主要故障形态），但**防不了 Deno 整体故障**。要不要接受，由你定。

**实测依据（2026-10-10）**：
| 服务 | 主域国内可达 | 结论 |
|---|---|---|
| **`deno.dev` / `deno.net`** | ✅ 307 | ★ **首选**（免费额度 10 万请求/天；**原生支持本项目的 `worker.mjs`**，无需改代码）。⚠️ 现行项目域名是 **`deno.net`**（`deno.dev` 属已关停的 Deploy Classic） |
| **`netlify.app`** | ✅ 301 | 备选（有 **Netlify Drop**，拖文件夹即部署，连 Git 都不用） |
| `render.com` / `fly.io` | ✅ 200 | 备选 |
| `pages.dev` / `workers.dev`（CF） | ❌ 不通 / 不稳 | 不要用这两个 |
| `duckdns.org` | ❌ ECONNRESET | 已被滥用进名单，别用 |

### ★ 前置验证已通过（2026-10-10 实测）
**不是只测了主域** —— 我实测了**已存在的子域**：`fresh.deno.dev` **TLS OK + HTTP 301 ✓**、
`blog.deno.dev`/`hono.deno.dev`/`oakserver.deno.dev` **TLS OK + 404 ✓**（不存在但**域名族可达**）
⇒ **`*.deno.dev` 子域在国内可达** ⇒ 这条路值得走。
> ★ **更正（2026-10-12 实测）**：上面的 `*.deno.dev` 是 **Deploy Classic 的旧域名**（Classic 已于 2026-07-20 关停），
> 现存子域只是**遗留项目**。**Deno 现行 scheme 一律 `*.deno.net`**（实测新项目拿到 `*.deno.net`，
> 且与 `fresh.deno.dev` 解析到**同一个 IP**）⇒ 结论不变（域名族国内可达），但**别指望新项目能给 `deno.dev`**。

### 方式 A · Deno Playground（最简单，约 10 分钟，推荐先试）

`infra/proxy/worker.mjs` **本身就是 Deno 兼容的**（`export default { fetch }` + Web 标准 API）。

1. 打开 <https://console.deno.com> → 用 **GitHub 账号登录**（免费）；
   ⚠️ 旧地址 `dash.deno.com`（Deploy Classic）**已于 2026-07-20 关停**，打不开；现行控制台是 `console.deno.com`；
2. 进入 **Playground**（或 New Playground）；
3. **打开本仓库的 `infra/proxy/worker.mjs`，全选复制，粘贴进 Playground**；
4. **只改一行**：文件靠上位置有
   ```js
   const SB_ANON_KEY_FALLBACK = '';
   ```
   ⇒ 把你的 **Supabase `anon` key**（`eyJhbGciOiJI…` 那一长串）填进引号里。
   > 为什么可以直接写在代码里：**anon key 是「公开键」**（受 RLS 保护，本来就随小程序包分发）⇒ 不是机密泄露；
   > **但 `service_role` key 绝不可以这样放。** 若你想用环境变量（更规范）⇒ 见方式 B。
5. 点 **Save & Deploy** ⇒ 得到一个 `https://<名字>.<你的org>.deno.net`（**注意是 `.deno.net`**，见下方更正）；
6. 部署后自检（**这一步决定成不成**）：

   | 浏览器打开 | 期望 |
   |---|---|
   | `https://<名字>.<org>.deno.net/healthz` | `{"ok":true,"hasKey":true,...}` |
   | `https://<名字>.<org>.deno.net/healthz?deep=1` | `deep.supabase.reachable=true` **且** `deep.opendota.reachable=true` |

7. **把这个域名发我** ⇒ 我从这边实测国内可达性 + 深检 ⇒ 通了就填进 `utils/config.js` 的 `PROXY_HOSTS`（**一处**；`/sb`、`/od/api`、双出口 fallback 都已实现，不再是"6 处"）。

### 方式 B · 从 GitHub 部署（推荐长期维护，可用环境变量）

1. 建一个 **私有** GitHub 仓库，放 `infra/proxy/worker.mjs`（保持 `SB_ANON_KEY_FALLBACK = ''` 留空）；
2. Deno Deploy → **New Project → Deploy from GitHub** → 选该仓库 → 入口文件填 `worker.mjs`；
3. 项目 **Settings → Environment Variables** 加两条：
   - `SB_ANON_KEY` = 你的 anon key（类型选 **Secret**）
   - `SUPABASE_REF` = `gkticzdaicpdtxheyxsd`
4. 部署 ⇒ 同样跑上面第 6 步的两个自检 URL。
> 优先级：`env.SB_ANON_KEY` **覆盖**代码里的 `SB_ANON_KEY_FALLBACK`。

### 方式 C · 命令行

```bash
npx deployctl deploy --project=<项目名> infra/proxy/worker.mjs
```

### ⚠️ 三个注意点
1. **免费额度以官网当前页为准**（我无法在此核实它的实时政策）；**若注册流程要求绑卡/付费，先停下来告诉我** —— 那就换备选平台。
2. **`*.deno.net` 子域无法备案** —— 你的现状已证微信接受未备案境外域名，但**"野生子域"可能被风控** ⚠️
   ⇒ 加白名单时若被拒，告诉我（这不代表方案失败，换 netlify/render/fly 或加个自有域名即可）。
3. **中转必须跑在境外**（Deno Deploy 的边缘在境外 ✓ 符合）—— 在国内跑同一份代码会 `fetch failed`（实测）。

### 备选平台（若 Deno 不可用，逐个试）
> ★ **这三个同时也是 P1-2「第二台（备出口）」的合法选项**（跨提供商）；**逐步操作见 §路径 E**。

| 平台 | 免费子域形态 | 特点 |
|---|---|---|
| **Netlify** | `*.netlify.app` | 有 **Netlify Drop**：把文件夹拖进网页即部署（连 Git 都不用）⚠️ Edge Functions 跑在 **Deno 运行时**（与主出口同族） |
| Render | `*.onrender.com` | 支持 Node（**零改代码**复用 `node-server.mjs`）；免费实例会休眠 |
| Fly.io | `*.fly.dev` | 需要 CLI + 信用卡验证 ⚠️ |

> ⚠️ 免费子域**无法备案** —— 但你的现状已证明**微信后台接受未备案的境外域名**（`liquipedia.net`/`api.opendota.com` 都在你的白名单里且小程序在跑）⇒ **可以直接加白名单试**。

### 若 Deno/netlify 子域也被阻断

按 §5 退到**零后端**路线（客户端直连已实测可达的 `dota.haglund.dev` ✓ / `liquipedia.net` ✓ / `api.steampowered.com` ✓ + curation 烘焙）。


## 路径 E · **跨提供商第二台中转**（P1-2 双出口备槽，约 20 分钟）

> **什么时候需要**：现网只有**一台**中转（`hungry-pike-9907.re-toke.deno.net`）⇒ 它挂即全挂。
> 客户端已在 `utils/config.js` 的 `PROXY_HOSTS` 预留**备槽**（`PROXY_HOSTS[1]`，当前为空串），
> 并配套实现了「主→备失败切换 + 会话粘滞 + 开机通道体检」（`utils/endpoints.js`）。
> **你只需部署第二台并把域名填进备槽**，其余客户端逻辑已就绪。

### E0. 先看这四条（省得白试）

| # | 结论 |
|---|---|
| 1 | **换域名 ≠ 换提供商**：本条要求**跨提供商**部署（防「一家整体挂」）；在同一家再开一台**不算** |
| 2 | ❌ **已被本项目实测排掉、不要浪费时间**：`*.workers.dev`、`*.pages.dev`（CF 免费子域）、**`*.vercel.app`**（DEPLOY.md §0.1 已记「不通」）；同族 `*.deno.net` 再开一台**不算"跨提供商"**（实测与主出口**同注册域 + 同 IP**） |
| 3 | ⚠️ **「主域可达」≠「函数子域可达」**（阻断是**域名粒度**；P1-2 实测只证明了 `netlify.com`/`render.com` 的 **apex** 可达）⇒ 每一步都必须**部署后对真实子域复测**，且**用你的本机（国内网络）**跑 |
| 4 | 中转**必须跑在境外**（国内跑同一份代码会 `fetch failed`，见 §0 第 1 条）—— 下列平台都符合 |

### E1. 方案取舍（选一个）

| | **A · Render**（Node Web Service） | **B · Netlify**（Edge Function） | C · Fly.io |
|---|---|---|---|
| 代码改动 | **零**（直接用现成的 `node-server.mjs`） | 需 2 个小文件（下方已给全文） | 需 Dockerfile |
| 免费子域 | `*.onrender.com` | `*.netlify.app` | `*.fly.dev` |
| 冷启动 | ⚠️ **免费实例空闲 15 分钟休眠**（唤醒**约 1 分钟**，官方口径） | 无（边缘） | 无 |
| 运行时族 | Node（与主出口**不同族**） | ⚠️ Edge Functions 跑在 **Deno 运行时**（与主出口同族） | Node |
| 门槛 | 免费层公开说法是"无需卡"，但**本机实测被"需要银行卡"挡住**（2026-10-12，疑账号/区域风控） | 需 GitHub 或 CLI（**不卡卡**） | **需信用卡验证** |

> **建议（2026-10-12 修正）**：若你**有可用的卡** ⇒ 选 **A（Render）**（零改代码、运行时与主出口不同族）；
> **没有卡 ⇒ 选 B（Netlify）**，免费且不卡卡，`*.netlify.app` 已实测国内可达（代价：无冷启动但**同运行时族**）。
> ⚠️ B 的「同族」影响：域名不同 ⇒ **能防「域名级阻断」**（本项目实测到的主要形态）；但 Deno 系边缘整体故障时两台**会一起挂**。

#### ★ 已定方案：**两台都加**（2026-10-12 用户择定 C）

不二选一 —— **Deno 新项目 + Render 都上**。`PROXY_HOSTS` 支持 N 台（`failover` 是模运算循环、`probe` 遍历全部候选）⇒ **无需改代码**。

| 槽位 | 载体 | 防什么 | 代价 |
|---|---|---|---|
| `[0]` | Deno Deploy 现网（`hungry-pike-9907.re-toke.deno.net`）★ 2026-10-13 替换旧 `tough-ferret-3579`（其 App 构建损坏、无法更新） | —（主出口） | — |
| `[1]` | **Deno Deploy 新项目**（`sparkly-gharial-1210.re-toke.deno.net`） | ⚠️ **仅「主机名级 SNI 阻断」**（同注册域 + 同 IP，见下） | 无冷启动 |
| `[2]` | **Netlify Edge Function**（§E3 全文） | **域名级阻断**（`*.netlify.app` ≠ `*.deno.net`）。⚠️ 运行时是 Deno ⇒ **与主出口同族**，防不了"Deno 系整体故障"；真跨提供商因无卡本轮未落地 | 无冷启动。⚠️ **免费额度仅 300 credits/月** ⇒ **勿对 `[2]` 压测**（2026-10-13 一次压测即用掉 75%）；它是**第 3 顺位、常态零流量**，只在 `[0]`+`[1]` 都挂时才被切到 |

**⚠️ 顺序**：`probe()` 取「第一个可达」、`failover()` 取「下一个」⇒ **快的放前面**。
（本条原是给 Render 的 ~1 分钟冷启动而设；改用 Netlify 后两台都无冷启动 ⇒ 顺序影响变小，但仍保持"快者在前"的原则。）

**Deno 新项目怎么做**：在 **Deno Deploy 现行控制台 `console.deno.com`** 新建项目（旧 `dash.deno.com` 已随
**Deploy Classic 于 2026-07-20 关停**，打不开）→ 粘贴 `infra/proxy/worker.mjs` → 填 `SB_ANON_KEY_FALLBACK`
（或配环境变量 `SB_ANON_KEY`）→ 部署 → 跑 **§E4 三条自检**。

> ★★ **实测更正（2026-10-12，本节原写"必须拿到 `*.deno.dev`"——那条是错的）**：
> 实测已部署的 Deno 新项目拿到的是 **`*.deno.net`**，且
> `sparkly-gharial-1210.re-toke.deno.net`、`tough-ferret-3579.re-toke.deno.net`、`fresh.deno.dev`
> **三者解析到同一个 IP `69.67.170.170`**（`server: deployd` / `via: …deno-cluster.net`）。
> ⇒ ① **`*.deno.dev` 是 Deploy Classic 的旧域名**，Classic 已关停 ⇒ **新项目拿不到**；
> ② Deno 现行 scheme **一律 `*.deno.net`** ⇒ 两台 Deno **同 provider + 同注册域 + 同 IP**，
> 所以 `[1]` **只能防"某个主机名被单独 SNI 阻断"**，**防不了整域/整 provider 故障**。
> ③ ⇒ **真正的冗余是 `[2]` Render**；把 `[1]` 当作"顺手加的、几乎零成本"的一道薄保险即可。

⛔ **拿不到真域名时，`PROXY_HOSTS` 里就留空串，不要填占位符/假域名** ——
`endpoints.js` 只过滤**空串**，非空的假域名会被当成真候选（`failover()` 可能切过去、`probe()` 会去打它 ⇒ 自伤）。

---

### E2. 方案 A · Render（推荐先试）

> ★★ **实测依据（2026-10-12，本机=国内网络）** —— 这次测的是**子域族**，不是主域（§E0 第 3 条的坑）：
>
> | 测试 URL | 结果 | 结论 |
> |---|---|---|
> | `https://example.onrender.com/` | **404**（curl exit 0，DNS `216.24.57.18`） | ✅ **域名族可达**（TLS/DNS 通，404 只因该子域不存在） |
> | `https://example.netlify.app/` | **200** | ✅ 可达（备选平台同样可用） |
> | `https://example.vercel.app/` | **000 / 超时** | ❌ **不可达**（与 §0.1 记录一致，别用 Vercel） |
>
> **免费额度与休眠（官方口径）**：空闲 **15 分钟**休眠，下次请求**约 1 分钟**唤醒；
> **750 instance-hours/工作区/月**（用尽则当月停用）；**不需要信用卡**。
> ⚠️ 我先前写的"冷启动 30~60s"偏乐观，**以官方"约 1 分钟"为准**。
>
> **对"备用出口"的含义**：这类休眠只在**真的要切过去**时才让你多等（合理）；
> 而 `endpoints.probe()` 每次启动会并发探一遍所有候选 ⇒ 大概率**顺手把 Render 唤醒**
> （⚠️ 但探活自身 4s 超时 < 1min 唤醒，所以 probe 那一次会把它判成"不可达"、仍留在主出口 —— 这是**预期行为**，不是 bug）。
> 极端情形（主+备Deno 同时挂）：failover 到 Render 的**第一个请求**会超时，**下一个请求**就正常了。

**A-1. 先搞懂"为什么要仓库"**：Render 的部署方式是**从 Git 仓库拉代码后跑起来**，
它**不像 Deno Playground 那样能直接粘贴代码** ⇒ 代码必须先存在于某个 GitHub 仓库里。
（这一步最容易卡住，所以给了两条路。）

**A-1a（推荐 · 最省事）**：**不新建仓库**，直接把 Render 连到**你现在这个仓库** —— 参见 A-3 的 `Root Directory = infra/proxy`。
> ✅ 好处：以后改了 `infra/proxy/worker.mjs`，**Render 会自动重新部署**（少一处"忘记同步"的漂移）。
> 这个免费的 `anon` key 本来就不该进仓库：代码里 `SB_ANON_KEY_FALLBACK` **保持空串**，真 key 只放 Render 环境变量。

**A-1b（要干净就选这条）**：新建一个**私有**仓库，从本仓库 `infra/proxy/` 里**原样复制两个文件**到新仓库根目录：
```
infra/proxy/worker.mjs        → worker.mjs
infra/proxy/node-server.mjs   → node-server.mjs
```
> ⚠️ 复制后**不要**去填空 `const SB_ANON_KEY_FALLBACK = '';` —— 保持空串，key 由 Render 环境变量注入（代码优先读 env）。
> 注：Supabase `anon` key 是**公开键**（受 RLS 保护、本就随小程序包分发），即便泄露风险也低；
> 但 **`service_role` key 绝不能进任何仓库**。用环境变量的做法对两者都安全。

**A-2.** 打开 <https://dashboard.render.com> → **New +** → **Web Service** → 连上仓库
（A-1a 选**现在这个仓库**；A-1b 选**新建的那个私有仓库**）。首次会要求授权 Render 读取该仓库
（仓库若为私有，需在 GitHub 上给 Render 的 App 授权）。

> **本项目 A-1a 的实例值**：Repository = `re-toke/dota2-esports`；Branch = **`master`**。

**A-3. 填配置**：

| 项 | 值 |
|---|---|
| Runtime / Language | **Node** |
| Build Command | **留空**（无依赖）。若界面强制必填，填 `echo no-build` |
| Start Command | `node node-server.mjs` |
| Health Check Path | `/healthz`（**建议填**；`worker.mjs` 已提供该端点，返回 200） |
| Instance Type | **Free** |
| Region | 任选**非中国大陆**（如 Singapore / Oregon） |
| Root Directory | **A-1a 走本仓库 ⇒ 填 `infra/proxy`**；A-1b 走新仓库 ⇒ 留空（默认根目录） |

**A-4. 加环境变量**（Environment → Add Environment Variable）：

| Key | Value | 说明 |
|---|---|---|
| `SB_ANON_KEY` | `<你的 Supabase anon key>` | Supabase 后台 → Settings → API Keys → **`anon` `public`** |
| `SUPABASE_REF` | `gkticzdaicpdtxheyxsd` | 不填也有默认值，建议显式写 |
| `HOST` | `0.0.0.0` | ⚠️ **必须**。`node-server.mjs` 默认只听 `127.0.0.1`（给 Caddy 反代用的），在 PaaS 上会导致**外部访问不到** |
| `PROXY_RATE_LIMIT_MAX` | **先不要设** | P1-12 的限流开关；确认 IP 头存在后再开（见 §E6 末注） |

> `PORT` **不要自己设** —— Render 会注入，`node-server.mjs` 已读 `process.env.PORT`。

**A-5.** Deploy → 得到 `https://<名字>.onrender.com` ⇒ 立刻做 **§E4 的三个自检**（第一次可能要等 ~1 分钟唤醒）。

> ⚠️ **运维代价（三台方案的隐性成本，务必知道）**：`worker.mjs` 现在有**三份副本** ——
> 本仓库 + Deno 项目 + Render 私有仓库。**以后任何一次改 `worker.mjs`（中转裁剪/限流/CORS…）
> 都要同步部署三次**，否则三台行为漂移、故障时表现不一致。改完请把这条当 checklist。

---

### E3. 方案 B · Netlify Edge Function（无冷启动）

> ★★ **2026-10-12 起本方案的文件已就绪**：三个文件**已经加在本仓库里**（见下），
> 你**不需要创建任何文件**，只要在 Netlify 上连仓库 → 配两个环境变量 → 部署。
> **为什么改用 Netlify**：Render 在本机注册时被「需要银行卡」挡住（属账号/区域风控，
> 与"免费层是否要卡"的公开说法不符）；Netlify 免费且不卡卡，且 `*.netlify.app` **已实测国内可达**（§E2 表）。

**B-1. 已就绪的三个文件（无需你动手）**

| 路径 | 作用 |
|---|---|
| `netlify.toml`（仓库根） | 声明发布目录 `infra/proxy/netlify-public`；Edge Function 走**默认目录**不自定义（自定义目录名写错会造成"函数没被发现"的静默失败） |
| `infra/proxy/netlify-public/index.html` | 纯占位页（Netlify 要求站点有发布目录），**不承载业务** |
| `netlify/edge-functions/dota2-proxy.ts` | **适配壳**：把 Netlify Edge 的调用约定转成 `infra/proxy/worker.mjs` 的 `handle()`（**共用同一份路由代码**）。★ 用 `.ts`（非 `.js`）：Edge Function 是 ESM，而 pre-commit 对已暂存 `.js` 跑 CJS 口径 `node --check` ⇒ `.js` 会被提交门禁阻断 |

适配壳的关键两行（供你核对，不用改）：
```js
import { handle } from '../../infra/proxy/worker.mjs';
export const config = { path: '/*' };   // ⚠️ 必须 '/*'；只写 '/' 会让 /sb/* 与 /od/api/* 404
```
> ⚠️ **同族提示**：Edge Functions 跑在 **Deno 运行时**（与主出口 Deno Deploy 同族）⇒ 本台的价值是
> **「不同注册域」**（`*.netlify.app` ≠ `*.deno.net`，能防**域名级阻断**），**不是**「不同提供商」。
> 若打包报「找不到 `../../infra/proxy/worker.mjs`」⇒ 把 `worker.mjs` 复制到 `netlify/edge-functions/`
> 同目录并把 import 改成 `./worker.mjs`（代价：多一份副本需同步）。

**B-2. 设环境变量**（Site configuration → Environment variables；或 `netlify env:set SB_ANON_KEY ...`）

| Key | Value |
|---|---|
| `SB_ANON_KEY` | 你的 Supabase **anon** key（建议标记为 Secret） |
| `SUPABASE_REF` | `gkticzdaicpdtxheyxsd` |

**不要设** `PROXY_RATE_LIMIT_MAX`（限流先不开，理由见 §E6 末注）。

**B-3. 部署**（二选一）

- **网页（★ 2026-10-12 实测更正：新版 UI 已没有 `Add new site` 按钮）**：
  登录后进 `https://app.netlify.com/teams/<你的团队>/projects` —— 页面标题是 **「Add your project to Netlify」**，
  在中间的 **「Import a Git repository」** 一行点 **GitHub**
  （★ **不是**上面的 "Start building with an AI Agent"；也**不要**用下面的 "Upload your project files" 拖拽 ——
  **拖拽部署不支持 Edge Function**，适配壳会被丢掉）
  → 授权 GitHub → 选 `re-toke/dota2-esports`、分支 `master`
  → Build command **留空**、Publish directory **留空**（`netlify.toml` 已声明）→ Deploy；
- CLI：在仓库根跑 `npx netlify deploy --prod`。

⇒ 得到 `https://<名字>.netlify.app` ⇒ 做 **§E4 的三个自检**（尤其第 3 条：验证 `/sb/*`、`/od/api/*` 没 404）。

**B-4. ★★ 必查：Project visibility 必须是 `Public`（2026-10-12 实测踩到）**

新站的默认可见性是 **Private** ⇒ **未登录访问一律 401**，正文是一个跳转页：
```
<title>Login Redirect</title>  →  https://app.netlify.com/edge-access?domain=<你的站>...
```
而中转是**公开 API**，小程序没有登录态 ⇒ **必须**改成公开：
**Project configuration → General → Visitor access → `Edit visibility`** →
把 `Production visibility` 与 `Deploy Preview visibility` 都改成 **Public**（"Anyone can visit your project"）。
> 症状识别：在浏览器里（已登录 Netlify）打开 `/healthz` **是 200**，但用 `curl` 或小程序访问 **是 401**
> ⇒ 就是这个开关。（Security 页会提示 visitor access 已迁到 General。）

---

### E4. 部署后自检（**三个，全部用你的本机/国内网络跑**）

只测 `/healthz` **不够** —— 它只证明"函数被调度起来了"，不证明**业务路径**能过。

| # | 命令 | 期望 |
|---|---|---|
| 1 | `curl -s https://<子域>/healthz` | `{"ok":true,"hasKey":true,...}`（`hasKey` 为 false ⇒ 环境变量名/生效问题） |
| 2 | `curl -s "https://<子域>/healthz?deep=1"` | `deep.supabase.reachable=true` **且** `deep.opendota.reachable=true`（前=能连 Supabase 主路径；后=OpenDota 兜底通） |
| 3 | `curl -s "https://<子域>/od/api/proMatches" \| head -c 200`<br>`curl -s -X POST https://<子域>/sb/functions/v1/opendota-proxy -H 'Content-Type: application/json' -d '{"action":"getProMatches","params":{}}' \| head -c 200` | 都返回 JSON 数据（不是 404/502） |

- ❌ **整条命令超时/连接被重置** ⇒ **子域被阻断** ⇒ 换平台（这正是 `vercel.app` 的情况）。
- ❌ `deep.supabase.reachable=false` ⇒ 载体出口连不上 Supabase ⇒ 换 Region 或换平台。
- ❌ 第 3 条 404 ⇒ 路由没挂全（Netlify 方案检查 `config.path`）。
- ⚠️ 证书必须是**有效 HTTPS**（微信只允许 https/wss）。

---

### E5. 接进客户端（3 步，改完即生效）

1. **填备槽** —— [utils/config.js](../../utils/config.js) 顶部的 `PROXY_HOSTS`：
   ```js
   const PROXY_HOSTS = [
     'https://hungry-pike-9907.re-toke.deno.net',    // 主
     'https://<你的新子域>',                          // ← 填这里
   ];
   ```
   ⚠️ **只填 `https://<host>`**：**不带** `/sb`、**不带**尾斜杠（`/sb`、`/od/api` 由 `endpoints.js` 拼）。
2. **微信白名单**：后台 → 开发管理 → 开发设置 → 服务器域名 → **request 合法域名** → 加 `https://<你的新子域>`
   （**不需要重新提审**，对已上线版本**立即生效** ✓）。
3. **跑门禁**（改 `utils/api.js`/`config.js` 属"改动即回归"范围）：
   ```bash
   node scripts/ops/check-syntax.js
   node infra/proxy/test.mjs          # 期望 81/81（测试用注入宿主，与你填几台无关）
   node scripts/test/test-api-inflight.js
   ```
   （`test:all` 亦可，耗时更长。）

**真机验证「真的会切」** ⇒ 完整步骤见下方 **E7**（含逐条日志断言与两个必须知道的边界）。

---

### E6. 常见坑

| 现象 | 原因 / 处理 |
|---|---|
| Render 上外部一直 502 / timeout | 忘了 `HOST=0.0.0.0`（默认只听 127.0.0.1） |
| Render 第一次打开很慢 | 免费实例**空闲休眠**，冷启动 30–60s ⇒ 作备用可接受；介意就换 E3 或升付费 |
| Netlify 上 `/` 正常但 `/sb/...` 404 | Edge Function 少了 `export const config = { path: '/*' }` |
| `/healthz` 的 `hasKey:false` | 环境变量名必须**恰好** `SB_ANON_KEY`；改完**重新部署**才生效 |
| 子域被阻断 | 换平台（`*.vercel.app` / `*.workers.dev` / `*.pages.dev` 已证不可用） |
| 加了备域名后小程序报「不在合法域名列表」 | 白名单只加了主域 ⇒ 把备域也加上（两条都要） |
| 想确认当前走哪台 | `endpoints.js` 在切换/体检命中时会打 `[endpoints] 出口切换 …` / `[endpoints] 体检选中 …` |

> **注意（P1-12 相关）**：`worker.mjs` 含**轻量限流**（按 IP 固定窗口，**默认关闭**）。
> `PROXY_RATE_LIMIT_MAX`（每分钟/每 IP）各台可分别设置，**建议都先不设**，按下表验完再开。

**★ IP 来源已核实（2026-10-13）——`CF-Connecting-IP` 在本项目两台主力平台上都不存在**

| 宿主 | 平台 | 客户端 IP 的正规来源 | worker 内的 `ipSource` |
|---|---|---|---|
| `[0]` `[1]` | Deno Deploy | handler **第二参数** `connInfo.remoteAddr.hostname` | `ctx` |
| `[2]` | Netlify Edge | **第二参数** `context.ip` | `ctx` |
| （自建 Node） | Caddy 反代后 | 反代写入的 `X-Forwarded-For`（须**覆写**，见 `node-server.mjs` 注释） | `xff` |

> ⚠️ 连带修正：**Deno 上第二个参数是 `connInfo`、不是 `env`** ⇒ 环境变量必须用 `Deno.env.get()`。
> 这解释了为何 Deno 那两台从未配过环境变量、`/healthz` 却一直 `hasKey:true`（key 取自 `SB_ANON_KEY_FALLBACK` 常量）。

**开限流前的验证（4 步，别跳）**

1. 部署含本改动的 `worker.mjs`（`[2]` Netlify push 即自动部署；`[0]`/`[1]` 是手贴副本，**建议与发版同步做**）。
2. 三台各 `curl /healthz` ⇒ 都应回 **`ipSource !== "none"`**（如 `ctx`），且 `ipMasked` 非空。
3. **换一个网络**（手机热点）访问同一 URL ⇒ **`ipMasked` 必须不同**。这一步才是关键：证明是「每客户端一个桶」，而不是所有人共用一个桶。
4. 全绿后再设 `PROXY_RATE_LIMIT_MAX`（建议从 120/分钟起）。
   ⚠️ 取不到 IP 时 worker **fail-open（不限流）**——宁可暂不限流，也不会把全体用户一起 429。

**★ 实开结论（2026-10-13 实测，三台逐一验证）——两家平台的 env 都是「部署时注入」：**

> ⚠️ **关键前提（踩过坑）**：两家文档都明确 env 只在**部署时**注入（Netlify「须 build + deploy」；
> Deno Deploy「部署不可变，含 env」）⇒ **改完 env 必须重新部署**，否则运行的仍是"没 env 的旧部署"。

| 宿主 | 平台 | env 是否注入 | 实测 |
|---|---|---|---|
| `[2]` | Netlify Edge | ✅ **注入**（须重新部署） | 404×120 + 429×26 ⇒ 第 121 次起如期限流 |
| `[0]`/`[1]` | Deno Deploy | ✅ **同样注入** | 第一轮"重新部署"时 env **尚未生效**（404×200、0 个 429）⇒ 曾**误判为"不注入"**；**重贴后** `/healthz` 回 **`rlSrc:"env"`** 并出现 429 ⇒ **已更正：Deno Playground 同样读得到 env**（根因是部署时机，不是平台） |

> ⇒ `worker.mjs` 另加了 **`PROXY_RATE_LIMIT_MAX_FALLBACK = '120'`** 常量兜底（**env 优先、常量兜底**）——
> **非必需**（三台 env 都能读到），只作「万一漏配 env」的保险；Netlify 侧 env=120 与本常量同值，无冲突。
> `/healthz` 回显 **`rlMax` + `rlSrc`**（`'env'` / `'fallback'` / `'off'`）⇒ 一眼判定平台是否真的注入了 env，**不必再"靠猜"**。
> ⚠️ **诚实边界**：限流是**模块内内存计数**（仅 isolate 生命周期有效）：
> · **单客户端顺序请求 ⇒ 精确生效**（实测 130 顺序 = 404×120 + 429×10，**首个 429 恰在第 121 次**）—— 这是限流的**威胁模型**（单客户端狂刷），✅ 已达成；
> · **高并发洪峰 ⇒ 计数分散**（250 并发：`[0]` 248×404/0×429、`[1]` 151×404/10×429/89×失败）⇒ **不保证**；若要抗并发洪峰须换 KV / 边缘 WAF。
> 平台文档依据：Netlify「edge function 的 env 变更须 **build + deploy** 才生效」；Deno Deploy「**部署不可变**（含 env），改项目 env 不改现有部署」。
>
> ⛔ **压测约定（2026-10-13 教训，务必遵守）**：**限流/并发压测只打 Deno 两台（`[0]`/`[1]`）**，**绝不打 `[2]` Netlify**
> （其免费额度仅 300 credits/月；本轮 200 并发×2 + 130 顺序即用掉 75% ⇒ 已影响团队其它项目）。
> `[2]` 为第 3 顺位，**常态零流量**，额度应留给"真实故障切换"。

---

### E7. 切出口演练（验证「主不可达时真的会切」）

> **为什么用「改配置」来模拟**：设备上没法真去封一个域名。**逻辑层**已由 `infra/proxy/test.mjs` 的
> 18 条断言覆盖（failover 轮转 / `probe()` 选可达 / 主优先）；本演练验的是**接线**（app.js → endpoints → api/supabaseClient 真串起来了）。

**① 改动（只动一处，验完**必须**改回）**

[utils/config.js](../../utils/config.js) 顶部 `PROXY_HOSTS[0]` 改为：

```js
const PROXY_HOSTS = [
  'https://invalid.example.invalid',                 // ← 临时：模拟主出口不可达
  'https://sparkly-gharial-1210.re-toke.deno.net',
  'https://velvety-llama-a7700e.netlify.app'
];
```

选 `.invalid` 的原因：它是**保留 TLD，必然解析失败**；且**不在微信白名单里** ⇒ `wx.request` 会**立即**失败，
不用等超时（最快、最可控）。想更贴近真实故障（已加白名单但网络层不通），可换 `https://example.vercel.app`（本项目实测超时），代价是要等超时。

**② 跑**

1. 微信开发者工具 → **重新编译**（等价于重启小程序）—— 这样 `app.js:62` 的 `endpoints.probe()` 才会执行。
2. Console 面板过滤 `endpoints`，核对日志：

| 日志 | 出处 | 含义 |
|---|---|---|
| `[endpoints] 体检选中 https://sparkly-gharial-…` | `endpoints.probe()` ← `app.js:62` | 开机体检跳过不可达的主出口，选中可达的备出口 |
| `[endpoints] 出口切换 https://invalid… → https://sparkly-…` | `api.js:142-147` | 请求期**传输层**失败 ⇒ 切出口，并把**这次请求在备出口重放** |

> ⚠️ **`出口切换` 可能出现也可能不出现**：若体检先完成（本例大概率如此），首个数据请求就直接走备出口、
> 不再经过「失败 → 切」这一步。**只出现 `体检选中` 同样算通过**，不是失败。
>
> 📌 **期望的切换次数 ≈ 1**（2026-10-13 修「过冲」后）：修复前真机实测出现 **8 次轮转** ——
> 原因是并发请求各自失败、各自从「当前出口」盲转，把出口推过可用备台甚至绕回起点。
> 修法见 `endpoints.failover(fromHost)`。**再跑到多次轮转就是回归**，请核对调用点是否都传了「本次使用的宿主」。

3. **功能断言（三条都要过）**：
   - 首页有数据（比赛流 / 关注流不再空转）
   - 详情页（`league-detail` / `team-detail`）能出内容
   - **不出现**「数据源暂不可用」告警（即 BUG-A 修好的那条 `dataHealth.check`）

**③ 想单独验证「请求期切换 + 重放」（可选，隔离体检的干扰）**

体检会抢先把出口改成备 ⇒ 要隔离它，临时把 `app.js:62` 注释掉：

```js
// try { endpoints.probe(); } catch (e) {}   // 演练临时注释
```

再重新编译。此时 `_idx` 恒为 0 ⇒ 首个数据请求打到不可达的 `[0]`，应看到 `出口切换` 且**数据仍出得来**
（证明 `api.js:144` 的重放在起作用）。**验完把这行恢复。**

**④ 收尾（必做）**

1. `PROXY_HOSTS[0]` 改回 `'https://hungry-pike-9907.re-toke.deno.net'`
2. 若做过 ③，恢复 `app.js:62`
3. 跑门禁：`node scripts/ops/check-syntax.js` + `node infra/proxy/test.mjs`（应仍 81/81）

**⑤ 两个必须知道的边界（不然会误判成 bug）**

- **有状态码的失败不切**：`api.js:142` 的守卫是 `!code`（**无**响应码）。若中转返回 404/500，说明**链路是通的**，
  按设计**不切** —— 换了备出口也一样错，切没有意义。
- **Supabase 链路（EF / REST）不重放**：`utils/supabaseClient.js:131,198` 在 `wx.request` fail 时**只**调
  `failover()`，本次请求仍失败、由上层重试 ⇒ 立刻看 EF 相关卡片可能仍然缺，**下一次**请求才走备出口。这是有意为之（不放大重试）。

---

### E8. `[0]`/`[1]` 一次贴齐三样（C 裁剪 + IP 来源 + gzip）后的自检

> 背景：这两台是**手贴副本**（`[0]` 还是**现网主出口**），所以别零散重贴 —— 一次把三样带齐：
> ① P0-1 **C 的默认裁剪**（`DEFAULT_TEAM_TRIM`）；② P1-12 **IP 来源改造**（`clientIp(request, ctx)` + `ctx.ip` + fail-open）；③ 方案 B **按需 gzip**（`X-Gzip-Ok` 门控）。
> 操作：把仓库 [infra/proxy/worker.mjs](worker.mjs) **整份**贴进 Deno 项目的入口文件（注意新模型要求入口叫 `src/main.ts`，见下方"坑"），保存并部署。

**贴完跑这三条自检（本机执行，逐条对）**

```powershell
$H = 'https://hungry-pike-9907.re-toke.deno.net'   # 另一台同理换成 sparkly-gharial-1210

# ① C 的默认裁剪：未声明的 /teams/*/matches 应回 X-Proxy-Trim: recent:300
curl.exe -sS -D - -o NUL "$H/od/api/teams/7119388/matches" | Select-String 'X-Proxy-Trim'

# ② IP 来源：应回 ipSource 非 none（Deno 上期望 ctx）+ 打码 IP
curl.exe -sS "$H/healthz" | Select-String 'ipSource|ipMasked'

# ③ gzip：带 X-Gzip-Ok 才有 Content-Encoding: gzip + X-Proxy-Gzip: 1（且体积骤降）
curl.exe -sS --compressed -D - -o NUL -w "size=%{size_download}`n" -H "X-Gzip-Ok: 1" "$H/od/api/leagues"
curl.exe -sS --compressed -D - -o NUL -w "size=%{size_download}`n" "$H/od/api/leagues"   # 期望：无 gzip、体积大
```

**通过标准**：①有 `X-Proxy-Trim`；②`ipSource` 非 `none`；③带头的 43KB 级 / 不带的 320KB 级。
**老客户端零回归**：不带 `X-Gzip-Ok` 的请求**行为逐字节不变**（②③ 的"不带"那两条就是它的镜像）。

> **坑**：Deno 新模型的 App 构建要求入口路径为 `src/main.ts`（草稿文件叫 `new.ts` 会 build 失败：
> `Entrypoint at '/tmp/build/src/main.ts' not found`）。Playground 那份部署**目前仍在服务**，
> 别在没验证替代品之前动它。另：**验证组织**后额度已从 `0.2 GiB` 提到 **20 GiB** 出网。

---

## 路径 A · Cloudflare Worker（约 15 分钟）

### A1. 准备域名（10 分钟，一次性）
- 在哪买都行：**腾讯云 / 阿里云**（微信支付、实名方便）或 **Cloudflare Registrar**（要信用卡）。
- **不需要 ICP 备案**（域名指向境外托管；备案只针对境内服务器）。
- 建议名字**别用敏感词**（域名级名单里更不容易被命中）。

### A2. 把域名接入 Cloudflare（免费套餐）
1. 登录 <https://dash.cloudflare.com> → **Add a site** → 填你的域名 → 选 **Free**；
2. CF 给你**两个 NS 地址**；
3. 回**域名注册商**控制台，把 DNS 服务器改成那两个 NS；
4. 等生效（一般几分钟，最长 24h）。**此时可以先做 A3~A5**，因为 Worker 会先用免费子域跑起来。

### A3. 部署 Worker
```bash
npm i -g wrangler          # 或每次用 npx wrangler
cd <你的仓库>/infra/proxy
wrangler login             # 浏览器点授权
wrangler deploy            # 首次会创建 Worker
```
⚠️ 首次部署会问是否创建/命名，按提示确认即可；`wrangler.toml` 已备好（`main = "worker.mjs"`）。

### A4. 写入 Supabase anon key（**不放文件里**）
```bash
wrangler secret put SB_ANON_KEY
# 终端提示 Enter a secret value: ⇒ 粘贴 anon key（以 eyJhbGciOiJ… 开头那一长串）→ 回车
wrangler deploy            # 让 Secret 生效
```
- key 从哪拿：Supabase 后台 → 项目 → **Settings → API Keys** → **`anon` `public`**；
- 也可以走 Dashboard：Workers → 你的 Worker → **Settings → Variables and Secrets** → Add → **Secret** → 名 `SB_ANON_KEY`。

### A5. 先用免费子域自检
浏览器打开：`https://dota2-data-proxy.<你的账号>.workers.dev/healthz`
✅ 期望 **`{"ok":true,"hasKey":true,...}`**
（⚠️ 这个 `workers.dev` 域名国内**可能被阻断**，只用于"确认代码跑起来了"；正式用自定义域名。）

### A6. 绑定自定义域名（关键一步）
CF Dashboard → **Workers & Pages → 你的 Worker → Settings → Domains & Routes → Add → Custom Domain**
→ 填 `api.你的域名.com` → CF 自动配 DNS + 签发证书（1~5 分钟）。
（等价命令行：在 `wrangler.toml` 里按注释打开 `routes` 段再 `wrangler deploy`。）

### A7. 正式自检（**这一步决定方案成不成立**）
| 打开 | 期望 |
|---|---|
| `https://api.你的域名.com/healthz` | `{"ok":true,"hasKey":true,...}` |
| `https://api.你的域名.com/healthz?deep=1` | `deep.supabase.reachable=true` **且** `deep.opendota.reachable=true` |

- 第 2 条**必须两个都 true**：前者=中转能连上 Supabase（主路径），后者=兜底通道可用；
- ❌ 若 `supabase.reachable=false` ⇒ 载体出口有问题（换 Cloudflare 区域/换路径 B）；
- ❌ 若整页连不上 ⇒ **域名被阻断** ⇒ 换域名，或直接上路径 B。

### A8. 加进小程序白名单
后台 → 开发管理 → 开发设置 → **服务器域名 → request 合法域名** → 加 `https://api.你的域名.com`
（**不需要重新提审**，已上线版本立即生效 ✓）

---

## 路径 B · 香港轻量服务器（A 被墙时用，约 30 分钟）

### B1. 买服务器 + 域名
- 腾讯云/阿里云 **香港地域** 轻量（2C2G 够用，~¥24~30/月）；
- 安全组放行 **80 / 443**（22 只放你的 IP 更好）。

### B2. 装环境
```bash
# Node 20+ 与 Caddy（以 Ubuntu/Debian 为例）
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs caddy
node -v   # 需 ≥ 18（本项目用到了全局 fetch / Request / Response）
```

### B3. 上传两个文件
把仓库里的 `infra/proxy/worker.mjs` 与 `infra/proxy/node-server.mjs` 放到 `/opt/dota2-proxy/`。
（两者**共用同一套路由逻辑**，`node-server.mjs` 只是 Node 的适配壳。）

### B4. 写环境变量
```bash
sudo tee /opt/dota2-proxy/.env >/dev/null <<'EOF'
SB_ANON_KEY=<粘贴真实 anon key>
SUPABASE_REF=gkticzdaicpdtxheyxsd
PORT=8787
HOST=127.0.0.1
EOF
sudo chmod 600 /opt/dota2-proxy/.env      # 只 root 可读
```

### B5. 常驻（systemd）
```ini
# /etc/systemd/system/dota2-proxy.service
[Unit]
Description=Dota2 data proxy (node)
After=network.target

[Service]
WorkingDirectory=/opt/dota2-proxy
EnvironmentFile=/opt/dota2-proxy/.env
ExecStart=/usr/bin/node node-server.mjs
Restart=always
RestartSec=3
User=www-data

[Install]
WantedBy=multi-user.target
```
```bash
sudo systemctl daemon-reload && sudo systemctl enable --now dota2-proxy
sudo systemctl status dota2-proxy --no-pager
curl -s http://127.0.0.1:8787/healthz      # 本机自检
```

### B6. Caddy 自动 HTTPS
```caddyfile
# /etc/caddy/Caddyfile
api.你的域名.com {
    reverse_proxy 127.0.0.1:8787
}
```
```bash
# 先把 api.你的域名.com 的 A 记录指向这台服务器的公网 IP，再：
sudo systemctl reload caddy
```
Caddy 会自动申请并续期证书 ✓

### B7 / B8
同 **A7（两个自检 URL）** 与 **A8（加白名单）**。

---

## 常见坑（都踩过或实测过）

| 现象 | 原因 / 处理 |
|---|---|
| `/healthz` 里 `hasKey:false` | Secret 名**必须恰好** `SB_ANON_KEY`；写完要再 `wrangler deploy` 一次 |
| `workers.dev` 打不开但代码正常 | 该免费子域国内不稳 ⇒ **绑自定义域名**（A6） |
| 自定义域名一直 522/526 | DNS 未生效或证书未签发 ⇒ 等 1~5 分钟，确认 CF 里域名为 **Active** |
| 中转连不上 Supabase | 载体在**国内** ⇒ 换境外/香港（见 §0 第 1 条） |
| 客户端改完仍报 401 | 客户端 `anonKey` 被改成了**空串** ⇒ `enabled()` 会直接禁用 EF 路径；填**非空占位**如 `via-proxy` |
| `/od/api/leagues` 很大 | 中转已丢 `tier=excluded` + CF/浏览器 gzip；若仍慢，把该请求尽量交给 EF 主路径 |
| 想看每段是否通 | 打开 `/healthz?deep=1`（v2 新增） |

---

## 部署完成后交给我的信息

**第一台（换主出口）**：只要 **一个东西** —— `https://api.你的域名.com`。
**第二台（P1-2 备出口）**：同样只要 `https://<新子域>`，但先自测 §E4 的三条。

我会：
1. 从这边实测**国内可达性**（沙箱与真机同网络，结果可代表真机）；
2. 通过后接客户端 —— ⚠️ **2026-10-12 起已简化**：`/sb`、`/od/api`、`anonKey` 占位、
   **双域名 fallback**、失败原因上屏这些**都已实现**并收敛到 `utils/config.js` 的 `PROXY_HOSTS`；
   换主出口 = 改 `PROXY_HOSTS[0]`，加备出口 = 填 `PROXY_HOSTS[1]`（**一处**，不再是"6 处"）。
3. 跑门禁 → 交付给你发版。
