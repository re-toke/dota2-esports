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
