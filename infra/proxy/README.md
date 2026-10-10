# 数据中转最小反代（Cloudflare Worker / Pages Functions）

> **要不要买服务器？→ 不要。** 这是 **Serverless**：代码跑在 Cloudflare 边缘，**没有服务器需要你运维**。
> 你只需要：① 一个 Cloudflare 账号（免费）② 一个域名（**也可以先不买**，用免费的 `*.pages.dev` / `*.workers.dev` 先测通）。
>
> 免费额度：Workers **10 万请求/天**（本代理是纯转发，够用）。

## 文件

| 文件 | 用途 |
|---|---|
| `worker.mjs` | **核心**：路由 + 服务端注入 key + `/leagues` 裁剪 + `/healthz` |
| `functions/[[path]].js` | **Pages Functions** 入口（与 Worker 版共用同一逻辑） |
| `test.mjs` | 本地测试（**不需要部署、不需要网络**）：`node infra/proxy/test.mjs` ⇒ 24 断言 |

## 路由（对齐客户端现有 4 处 URL 拼接 ⇒ **客户端只需改 2 个常量**）

| 中转路径 | 转发到 |
|---|---|
| `/healthz` | 健康检查（**浏览器直接打开即可判定"这域名通不通"**） |
| `/sb/functions/v1/<name>` | `https://<ref>.supabase.co/functions/v1/<name>` |
| `/sb/rest/v1/<table>?<query>` | `https://<ref>.supabase.co/rest/v1/<table>?<query>`（仅 GET） |
| `/od/api/<path>?<query>` | `https://api.opendota.com/api/<path>?<query>` |
| `/lp?<query>` | `https://liquipedia.net/dota2/api.php?<query>`（可选；客户端 LP 直连本来就通） |

## ★ 三个关键设计

1. **服务端注入 Supabase key**：客户端当前那把 `anonKey` 是错的（`utils/config.js:226`）。
   本代理用 `env.SB_ANON_KEY` **覆盖**客户端传来的 `apikey`/`Authorization`
   ⇒ **客户端的错 key 直接变得无害**（连通性恢复后也不会再 401）。
2. **`/leagues` 轻量裁剪**：只丢 `tier === 'excluded'` 的条目（**响应形状不变**，客户端 `filterCollectableLeagues`
   本来也会过滤）⇒ 再叠加 CF 自动 gzip ⇒ 避开 12s 超时。
   ⚠️ 刻意**不复制** EF 侧更复杂的裁剪，避免口径漂移。
3. **最小权限**：只放行 `/functions/v1/`、`/rest/v1/`、`/api/` 前缀；方法仅 GET/POST/OPTIONS
   ⇒ 不会变成开放代理/跳板。

## 部署方式 A：Cloudflare Workers（推荐，最快）

```bash
npm i -g wrangler          # 或 npx wrangler
cd infra/proxy
wrangler login

# ① 写入密钥（**不要**写进代码）
wrangler secret put SB_ANON_KEY      # 粘贴 Supabase 后台 Settings → API 的 anon public key

# ② 部署（首次会让你确认 worker 名称；wrangler.toml 已备好）
wrangler deploy
```
部署后会得到 `https://<worker名>.<你的账号>.workers.dev` ⇒ **先做可达性实测**（见下）。

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

★ 记得把 **`<你的域名>` 加进小程序后台 request 白名单**（改域名**不需要重新提审**，对已上线版本立即生效）。

## 本地测试

```bash
node infra/proxy/test.mjs      # 24 断言：路由 / 覆盖 key / Range 透传 / 裁剪 / 最小权限 / 失败信息
```
