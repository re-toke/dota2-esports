# P2-C Realtime 可行性评估（2026-09-27）

> 方案 §9.3 原文：「`P2-C` Realtime 评估（**域名已通，可行性上升**）」
> 结论：**不建议启用**。且方案那句前提有两处不成立 —— 见 §1、§4。

---

## 0. 先回答一个具体的配置问题

**问**：是不是把 `https://gkticzdaicpdtxheyxsd.supabase.co` 加到「request 合法域名」就行？

**答：不是。** 微信后台的「服务器域名」下有**四个独立输入位**，`request` 与 `socket` 是**两张不同的列表**。
官方原文（[基础能力/网络](https://developers.weixin.qq.com/miniprogram/dev/framework/ability/network.html)）：

> 域名只支持 `https`（`wx.request` / `wx.uploadFile` / `wx.downloadFile`）和 `wss`（`wx.connectSocket`）协议
> **对于 `wss` 域名，无需配置端口，默认允许请求该域名下所有端口**

⇒ Realtime 走 `wx.connectSocket`，必须把 **`wss://gkticzdaicpdtxheyxsd.supabase.co`**
填进 **「socket 合法域名」** 那一栏。已加 `https://…` 到 request 只让 `wx.request` 通了，
**对 Realtime 零作用**。

> ⚠️ 另有一条会让人误判的坑：`project.config.json` 里 **`urlCheck: false`**（开发者工具跳过域名校验）。
> ⇒ **模拟器/开发版能连上 wss，不代表真机白名单配好了**；真机会在 `close/error` 回调里报域名不合法。
> 这也意味着**本次评估无法用模拟器"连一下"来验证白名单**（官方亦建议：域名配好后应**关闭**该选项再测）。

---

## 1. 方案前提之一不成立：Realtime **已经实现了**

方案把它当成"尚未接入、待评估是否可行"。实际情况：

| 位置 | 内容 |
|---|---|
| `subpackages/detail/realtime.js` | **已存在的完整客户端会话层**：`createSession(matchId, handlers)` |
| `subpackages/detail/match-detail.js` | **已接入使用**，含 `liveStatus: '' \| 'connected' \| 'polling'` 三态 |
| `utils/config.js:244-252` | `realtime: { url: '', pollInterval: 30000, heartbeat: 25000, maxReconnect: 5 }` |

`config.realtime.url = ''` ⇒ **实现存在但被禁用**：空 url 时直接降级为 **30s 轮询 OpenDota**。

现有骨架质量不错（可直接复用）：指数退避重连（上限 5 次）→ 耗尽后自动降级轮询；
心跳 25s；`close()` 完整清理定时器与 socket。**这部分不需要重写。**

---

## 2. 方案前提之二不成立：指向 Supabase **协议不兼容**

现有客户端说的是**自定义协议**，而 Supabase Realtime 说的是 **Phoenix channels 协议**：

| 阶段 | 现有客户端（`realtime.js`） | Supabase Realtime |
|---|---|---|
| 连接 | `wss://<url>?matchId=<id>` | `wss://<ref>.supabase.co/realtime/v1/websocket?apikey=<anon>&vsn=1.0.0` |
| 订阅 | `send({ type: 'subscribe', matchId })` | `{ topic: 'realtime:public:<表>', event: 'phx_join', payload: { config: … }, ref }` |
| 心跳 | `send({ type: 'ping' })` | `{ topic: 'phoenix', event: 'heartbeat', payload: {}, ref }` |
| 推送 | `if (msg.type === 'score' && msg.match)` | `{ topic, event: 'postgres_changes', payload: { data: … } }` |

⇒ 把 `config.realtime.url` **直接填成** Supabase 地址会得到**最坏形态**：
TCP/WS 握手成功 → `onOpen` 触发 → 状态显示 **`connected`**，
但 `subscribe`/`ping` 帧不被 Phoenix 接受、`{type:'score'}` **永不到达**
⇒ **界面显示"已连接"而数据永不更新**，直到重连耗尽才降级。
（这正是本报告不建议直接改 `url` 的原因 —— 它会造成**静默错误**，而不是明显失败。）

要用 Supabase Realtime，必须**新写一层 Phoenix 适配**（join/heartbeat/postgres_changes 解析），
并在库侧把目标表加入 `supabase_realtime` publication（含 RLS 对 realtime 通道的授权）。

---

## 3. 更根本的阻断：**没有写入方**（这才是关键）

Realtime 的价值是"表变了就推给你"。所以先要问：**PG 里有没有会频繁变、且客户端关心的表？**

| 表 | 写入方 | 写入频率 | 客户端关心吗 |
|---|---|---|---|
| `curation_events` / `curation_teams` / `curation_meta` | 人工策展（admin-write / 脚本推远端） | **天级**、不定期 | ✅ 关心，但见 §4（已有更便宜的方案） |
| `upcoming_schedule` | CI 定时任务 | **约 2 次/天**（且实测常延迟/失败） | ⭕ 弱 |
| **实时比分** | **无人写** | — | ✅ 关心，但**PG 里根本没有这张表** |

**实时比分的来源是 OpenDota API，目前没有任何管道把它写进 Postgres。**
⇒ 即使 Realtime 通了，也**无源可推**。

而"把抓取/中转逻辑搬进服务端并常驻"这条路线，**项目已主动否决**
（`b5d228f Revert` + `bfe7c7f`「撤回不必要的 LP 迁移」），复核报告亦据此把 `P1-A` 降级为
"互补触发、不声称独立双轨"。

> ⇒ **Realtime 的前置不是"配域名"，而是"先有一个会往 PG 写实时数据的写入方"。**
> 那是**新建一条数据管道**，成本量级与方法完全不同 —— 不应以"评估 Realtime 可行性"的名义启动。

---

## 4. 即便有写入方，curation 侧也已有更便宜的替代

`utils/remoteCuration.js` 的**廉价版本探针**（2026-09-20 落地）已解决"远端改动多久生效"：

- 两条**并行**单行读（`curation_meta.version` + `curation_events` 最大 `updatedAt`），实测各 ~400ms；
- 整体 **5s 上限**；**10min 节流**（`PROBE_MIN_INTERVAL_SEC`）；
- 命中差异才重拉，且**在一次启动内生效**（此前需清缓存或等 6h TTL）。

⇒ curation 的"新鲜度"问题**已经以 ~400ms 的天级成本解决**。
用 Realtime 替它，收益是"分钟级 → 秒级"，而这类数据的变更频率是**天级** —— **收益与复杂度不成比例**。

---

## 5. 平台约束（评估必须纳入）

| 约束 | 值 | 影响 |
|---|---|---|
| `wx.connectSocket` 最大并发 | **5** | 页面栈深时（详情→H2H…）多场 LIVE 同时订阅会撞上限 |
| 进入后台 5s 未结束的网络请求 | `fail interrupted` | 切后台回来必须重建连接（现有骨架未处理 `onHide` 断连） |
| socket 合法域名 | 独立列表、需 ICP 备案、无需端口 | §0 |

---

## 6. 结论

### ❌ 不建议启用（也不建议为此配置 socket 域名）

三条独立理由，任一条已足够：
1. **协议不兼容**：直接填 url 会得到"显示已连接、数据永不更新"的**静默错误**。
2. **无写入方**：实时比分的真相源在 OpenDota，PG 里没有对应的会变动的表 ⇒ **无源可推**。
   而"让服务端常驻去抓"这条路线**已被项目否决**。
3. **收益不成立**：唯一有变更的表（curation）已由 10min 节流探针以 ~400ms 成本覆盖，
   而它的变更频率是天级 —— Realtime 把它从"分钟级"提到"秒级"，**没有实际价值**。

### ⏱ 何时值得重启评估（可判定门槛）

出现以下**任一**情形时再评估：
- 项目**新增了一条把实时数据写进 Postgres 的管道**（例：CI/EF 定期把 LIVE 比分落表）——
  **此时 Realtime 才有源可推**；
- 或出现"用户明确要求秒级推送"的产品需求，且能接受上述平台约束与 5 并发上限。

### 🔁 若真要做的**最小落点**
1. 先有写入方（上表）；
2. 在 `subpackages/detail/realtime.js` **新增 Supabase 分支**（Phoenix join/heartbeat/`postgres_changes` 解析），
   **不要改写现有自定义协议分支**（它仍是有后端时的正确形态）；
3. 表格加入 `supabase_realtime` publication + 通道 RLS；
4. 「socket 合法域名」加 `wss://gkticzdaicpdtxheyxsd.supabase.co`，并**关闭 `urlCheck`** 后在真机验证。

---

## 7. 诚实边界

- **未做真机 wss 连通性验证**：`urlCheck: false` 使开发版结果不能代表真机白名单（§0），
  故本报告不提供任何"能连上/连不上"的实测结论。
- **未实测 Realtime 服务端行为**（是否开通、publication 状态）—— 这需要连 Supabase，本沙箱不可达。
- 并发上限 5、后台 5s 中断为**官方文档原文**，非本项目实测。
