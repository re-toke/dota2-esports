# 部署手册（DEPLOY）

> 目标：得到一个**国内可达的域名**，把 Supabase（与 OpenDota 兜底）藏到它后面。
> **两条路任选**；先试 A（免费、免运维），若 A 的域名被阻断再上 B。

## 0. 先记住三条（都是实测出来的）

| # | 结论 | 依据 |
|---|---|---|
| 1 | **中转必须部署在境外/香港** | 本机（国内）跑同一份代码，`fetch('https://api.opendota.com/...')` **直接失败**（实测 `/od/api/leagues` → 502 `fetch failed`）⇒ 放国内等于白装 |
| 2 | **必须用"自有域名"** | 免费子域实测不稳（`pages.dev` 一会儿通一会儿被重置；`workers.dev`/`vercel.app` 不通） |
| 3 | **改域名不需要重新提审** | 小程序后台加 request 白名单后**对已上线版本立即生效** ✓ |

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

## 路径 A · Cloudflare Worker（推荐，约 15 分钟）

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

只要 **一个东西**：`https://api.你的域名.com`（你的中转域名）。

我会：
1. 从这边实测**国内可达性**（沙箱与真机同网络，结果可代表真机）；
2. 通过后改客户端 **6 处**（`url`→`/sb`、`BASE`→`/od/api`、`anonKey`→非空占位、
   **双域名 fallback**、**保留原直连作最后兜底**、失败原因上屏）；
3. 跑门禁（19 道）→ 交付给你发版。
