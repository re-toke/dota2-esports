# 数据中转最小反代（Cloudflare Worker / Pages Functions）

> **要不要买服务器？→ 不要。** 这是 **Serverless**：代码跑在 Cloudflare 边缘，**没有服务器需要你运维**。
> 你只需要：① 一个 Cloudflare 账号（免费）② 一个域名（**也可以先不买**，用免费的 `*.pages.dev` / `*.workers.dev` 先测通）。
>
> 免费额度：Workers **10 万请求/天**（本代理是纯转发，够用）。

## 文件

| 文件 | 用途 |
|---|---|
| `worker.mjs` | **核心**：路由 + 服务端注入 key + `/leagues` 裁剪 + `/healthz`（CF Workers 与 Node 共用） |
| `node-server.mjs` | **普通服务器（Node 18+）版**：给"香港/境外轻量"这条路用的适配壳（复用同一套逻辑） |
| `functions/[[path]].js` | Cloudflare **Pages Functions** 入口 |
| `wrangler.toml` | Workers 部署配置 |
| **`DEPLOY.md`** | ★ **分步部署手册**（两条路各 8 步 + 常见坑 + 自检） |
| `test.mjs` | 本地测试（**不需要部署、不需要网络**）：`node infra/proxy/test.mjs` ⇒ **39 断言** |

> ★ 已实测：`node-server.mjs` 能真实起服务（`/healthz` 200、未知路径 404、上游失败 502 且**重试生效**）。
> ⚠️ **中转必须部署在境外/香港**：本机（国内）跑同一份代码，`fetch` 到 OpenDota **直接失败**
> （实测 `/od/api/leagues` → 502 `fetch failed`）⇒ 放国内等于白装。

## 路由（对齐客户端现有 4 处 URL 拼接 ⇒ **客户端只需改 2 个常量**）

| 中转路径 | 转发到 |
|---|---|
| `/healthz` | 健康检查（**浏览器直接打开即可判定"这域名通不通"**） |
| `/sb/functions/v1/<name>` | `https://<ref>.supabase.co/functions/v1/<name>` |
| `/sb/rest/v1/<table>?<query>` | `https://<ref>.supabase.co/rest/v1/<table>?<query>`（仅 GET） |
| `/od/api/<path>?<query>` | `https://api.opendota.com/api/<path>?<query>` |
| ~~`/lp?<query>`~~ | **刻意不提供**（2026-10-10）：① `liquipedia.net` 国内**直连可达**，无需中转；② 本项目有「**标识性 UA 单点化**」守卫（单一来源 `utils/lp-ua.js`），在此写 UA 会形成**第二定义** ⇒ 不给自己挖坑 |

## ★ 关键设计（v2，2026-10-10 优化）

1. **服务端注入 Supabase key**：客户端当前那把 `anonKey` 是错的（`utils/config.js:226`）。
   本代理用 `env.SB_ANON_KEY` **覆盖**客户端传来的 `apikey`/`Authorization`
   ⇒ **客户端的错 key 直接变得无害**（连通性恢复后也不会再 401）。
2. **EF 名白名单**（9 个）：只放行客户端真正会调的 EF（出处 `utils/cloudProxy.js` 的 EDGE_ACTIONS）
   ⇒ 中转不会被当作跳板。**改动白名单前先核对代码**（漏一个会让对应功能静默失效，测试里有不变量守卫）。
3. **上游超时 12s + 1 次重试**（仅 5xx / 网络异常；4xx 立即返回，不做无谓重试）。
4. **GET 短路缓存**（模块级内存，isolate 内有效）：多用户复用 ⇒ 省 Supabase/OpenDota 配额。
   ★ **TTL 必须 ≤ 客户端轮询间隔**（`/live` 取 20s < 客户端 30s 轮询），否则会把实时比分缓存成旧数据。
5. **`/healthz?deep=1` 逐段自检**：分别探测「中转→Supabase」与「中转→OpenDota」，一点开就知道哪段断了。
6. **`/od/api/leagues` 轻量裁剪**：只丢 `tier === 'excluded'`（**响应形状不变**，客户端本来也会过滤）；
   刻意**不复制** EF 侧更复杂的裁剪，避免口径漂移。
7. **最小权限**：仅 GET/POST/OPTIONS + 路径白名单；`/sb/rest/v1/*` 仅 GET。
8. **耗时/状态码日志 + 结构化错误**（CF 控制台可查）。

## 部署

> ★ **完整分步手册见 [`DEPLOY.md`](./DEPLOY.md)**（两条路各 8 步 + 每步验证点 + 常见坑 + 部署后的自检）。
> 下面是速查版。

## 部署方式 A：Cloudflare Workers（推荐，最快）

### 🔑 先搞清楚这把 key：**从哪拿**、**放到哪**

| 问题 | 答案 |
|---|---|
| **从哪拿** | Supabase 后台 → 选中项目 → **Settings → API Keys**（旧版叫 **API**）→ 找到 **`anon` / `public`** 那一栏 ⇒ 复制那一长串（**以 `eyJhbGciOiJIUzI1NiIs…` 开头**）<br>★ 就是你上次给我的「前 12 字符 = `eyJhbGciOiJI`」那串；**它很长（约 200+ 字符），不是** `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdrdGljemRhaWNwZHR4aGV5eHNkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg0OTI4NTIsImV4cCI6MjEwNDA2ODg1Mn0.ZzdBSKZskLI-GO-Tz3BsviNg_qNL8OhC1WV9jTJkAe8` 那种短值。<br>⚠️ 若界面给的是新版 `sb_publishable_…`，请优先用老的 **`anon` JWT**（`eyJ…`）——中转与 PostgREST 都按 JWT 走。 |
| **放到哪** | **哪里都不放文件里。** 执行 `wrangler secret put SB_ANON_KEY` 后，终端会提示 `Enter a secret value:` ⇒ **直接粘贴 → 回车**（输入不显示字符）。它会被存进 **Cloudflare 的加密 Secret**，`worker.mjs` 运行时通过 `env.SB_ANON_KEY` 读取。 |
| **⛔ 不要** | 不要写进 `wrangler.toml`（明文且会进 git）、不要贴到聊天/文档里、不要提交到仓库。 |
| **怎么确认配好了** | 浏览器打开 `https://<你的域名>/healthz` ⇒ 看到 **`"hasKey": true`** 就说明读到了 ✓（这是我在 worker 里内置的自检）。 |

> 也可以不用命令行：CF Dashboard → **Workers & Pages → 你的 Worker → Settings → Variables and Secrets
> → Add** → 类型选 **Secret** → 名称填 `SB_ANON_KEY` → 值粘贴 → 保存。
> （**Pages 部署走这条路径**，因为 Pages 的环境变量在 Dashboard 里配。）

### 执行顺序（注意：**先 deploy 再 secret put**，然后复验）

```bash
npm i -g wrangler          # 或全局换成 npx wrangler
cd infra/proxy
wrangler login             # 会打开浏览器授权

# ① 先部署（首次会创建 Worker；未配 key 也能部署成功，只是不带上游鉴权）
wrangler deploy            # 得到 https://dota2-data-proxy.<你的账号>.workers.dev

# ② 再写入密钥（终端提示 Enter a secret value: ⇒ 粘贴 anon key → 回车）
wrangler secret put SB_ANON_KEY

# ③ 若刚才是首次创建，建议再 deploy 一次让 Secret 生效
wrangler deploy
```

**然后做可达性 + 配置自检**（**这一步决定方案成不成立**）：
> ① 浏览器打开 `https://<你的域名>/healthz`
> - ✅ `{"ok":true,"hasKey":true,...}` ⇒ 域名通 + key 已就位
> - ⚠️ `hasKey:false` ⇒ key 没读到 ⇒ 回 Dashboard 确认 Secret 名称**恰好**是 `SB_ANON_KEY`，再 `wrangler deploy`
> - ❌ 连接重置 / 证书错 / 超时 ⇒ **域名不可达** ⇒ 换域名或换宿主（备选 Vercel / Netlify / Deno Deploy）
>
> ② 再打开 `https://<你的域名>/healthz?deep=1`（**v2 新增，逐段自检**）
> - ✅ 期望：`deep.supabase.reachable=true` **且** `deep.opendota.reachable=true`
>   ⇒ **中转能连上后端** ⇒ 可以进下一步（改客户端）
> - ⚠️ `supabase.reachable=false` ⇒ 中转连不上 Supabase（载体出口问题）⇒ 换载体/查 Supabase 状态
> - ⚠️ `opendota.reachable=false` ⇒ 兜底通道不可用（主路径仍可能正常）

**`wrangler.toml` 内容**（若仓库里没有，可自建）：
```toml
name = "dota2-data-proxy"
main = "worker.mjs"
compatibility_date = "2026-10-01"

[vars]
SUPABASE_REF = "gkticzdaicpdtxheyxsd"
```

## 部署方式 B：Cloudflare Pages（本次实测 `pages.dev` 国内可达）

1. 建一个 Pages 项目（可选"直接上传"）；
2. 上传本目录（含 `functions/[[path]].js` 与 `worker.mjs`）；
3. Pages 设置里加环境变量：`SB_ANON_KEY`（类型选 **Secret**）、`SUPABASE_REF`；
4. 会用 `functions/[[path]].js` 处理全部路径 ⇒ 得到 `https://<项目>.pages.dev`。

## ✅ 部署后的可达性实测（**关键一步，决定方案成不成立**）

**先用沙箱/电脑测**（国内网络）：
```bash
node -e "require('https').get('https://<你的域名>/healthz',r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>console.log('HTTP',r.statusCode,b))}).on('error',e=>console.log('❌',e.code||e.message))"
```
**再用手机浏览器打开** `https://<你的域名>/healthz`：
- ✅ **返回 JSON**（`{"ok":true,"hasKey":true,...}`）⇒ **域名通、方案成立** ⇒ 改客户端 2 个常量 + 发版；
- ❌ 连接重置 / 证书错 / 超时 ⇒ 换域名或换宿主（备选：Vercel / Netlify / Deno Deploy；本次实测其主域可达 ✓）。

再补一步，确认**中转能连上后端**（这是"中转→上游"那一半）：
```bash
curl -s -X POST "https://<你的域名>/sb/functions/v1/opendota-proxy" \
  -H 'Content-Type: application/json' -d '{"action":"getProMatches","params":{}}' | head -c 300
```
期望：返回 `{"data":…,"source":"ef"}` 形状的 JSON（而不是 401/502）。

## 客户端两处改动（**待你确认后再改**，本次未落地）

| 位置 | 现值 | 改为 |
|---|---|---|
| `utils/config.js` 的 `supabase.url` | `https://gkticzdaicpdtxheyxsd.supabase.co` | `https://<你的域名>/sb` |
| `utils/api.js:29` 的 `BASE` | `https://api.opendota.com/api` | `https://<你的域名>/od/api` |
| （可选）`utils/liquipedia.js` 的 `BASE` | `https://liquipedia.net/dota2/api.php` | `https://<你的域名>/lp` |
| `utils/config.js` 的 `supabase.anonKey` | `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdrdGljemRhaWNwZHR4aGV5eHNkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg0OTI4NTIsImV4cCI6MjEwNDA2ODg1Mn0.ZzdBSKZskLI-GO-Tz3BsviNg_qNL8OhC1WV9jTJkAe8`（**错值**） | **改成任意非空占位**（如 `via-proxy`）—— 见下方 ⚠️ |

> ⚠️ **别把 `anonKey` 改成空字符串**：`supabaseClient.enabled()` 的判据是
> `!!(enabled && url && anonKey)` ⇒ **空值会让"Supabase 已启用"直接变成 false**，
> 于是 EF 路径**根本不会被调用**（这是很容易踩的坑）。
> 改成 `via-proxy` 这类占位即可 —— 因为**中转会在服务端覆盖**它，客户端不需要持有真 key
> （顺带的好处：**小程序包里不再有 Supabase 凭据**）。

★ 记得把 **`<你的域名>` 加进小程序后台 request 白名单**（改域名**不需要重新提审**，对已上线版本立即生效）。

## 本地测试

```bash
node infra/proxy/test.mjs      # 24 断言：路由 / 覆盖 key / Range 透传 / 裁剪 / 最小权限 / 失败信息
```
