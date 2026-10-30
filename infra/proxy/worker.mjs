// infra/proxy/worker.mjs
// ─────────────────────────────────────────────────────────────────────────────
// 「数据中转最小反代」· Cloudflare Worker / Pages Functions 版（**无服务器**）
//
// ## 前提（用户 2026-10-10 决定：**不换后端**）
// **继续用 Supabase 作为后端**，只把它藏在一个国内可达的域名后面 ⇒ 本中转**不改后端架构**，
// 只是给客户端换一个"能连上的入口"。
//
// ## 为什么需要它
// 国内网络对 `*.supabase.co` 做 **SNI 阻断**（DNS 正常但 TLS 握手被 RST），
// 且 `api.opendota.com` 被 **DNS 劫持 + 自签证书** ⇒ 客户端两条路都取不到数据；
// 而 CF 边缘实测在国内可达（`haglund.dev` 302 ✓）⇒ 用自有域名做入口。
//
// ## 路由（对齐客户端现有 4 处 URL 拼接 ⇒ **客户端只改 2 个常量**）
//   /healthz[?deep=1]             → 健康检查（`deep=1` 逐段探测上游，一点开就知道哪段断了）
//   /sb/functions/v1/<name>       → https://<ref>.supabase.co/functions/v1/<name>    （EF）
//   /sb/rest/v1/<table>?<query>   → https://<ref>.supabase.co/rest/v1/<table>?<query>（PostgREST 只读）
//   /od/api/<path>?<query>        → https://api.opendota.com/api/<path>?<query>
//   /lp?<query>                   → https://liquipedia.net/dota2/api.php?<query>（可选）
//
// ## ★ v2 优化点（2026-10-10）
// 1. **服务端注入 Supabase key**：用 `env.SB_ANON_KEY` **覆盖**客户端的 `apikey`/`Authorization`
//    ⇒ 客户端那把错 anonKey 变得无害（连通性恢复后也不会再 401）。
// 2. **EF 名白名单**：只放行客户端真正会调的 9 个 EF（回 `utils/cloudProxy.js` 核准过）
//    ⇒ 中转不会被当作跳板去调任意函数。
// 3. **上游超时 + 1 次重试**：单条慢上游不会把整页拖死；仅 5xx / 网络异常重试（4xx 立即返回，不做无谓重试）。
// 4. **GET 短路缓存**：多用户复用同一份上游响应 ⇒ 省 Supabase/OpenDota 配额、响应更快。
//    （模块级内存缓存，isolate 生命周期内有效；要持久化可换 KV —— 见 README）
// 5. **`/healthz?deep=1` 逐段自检**：分别探测"中转→Supabase"与"中转→OpenDota"，真机排查不用再猜。
// 6. **`/od/api/leagues` 轻量裁剪**：只丢 `tier === 'excluded'`（**形状不变**，客户端本来也会过滤）；
//    刻意**不复制** EF 侧更复杂的裁剪，避免与服务端口径漂移。
// 7. **最小权限**：仅 GET/POST/OPTIONS + 路径白名单；`/sb/rest/v1/*` 仅 GET。
// 8. **耗时/状态码日志**：CF 控制台可查（便于定位真机问题）。
// 9. 凭据只存在 CF Secret（`env.SB_ANON_KEY`），**不写进代码、不打印**。
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_SUPABASE_REF = 'gkticzdaicpdtxheyxsd';

// ★ Deno Playground / 无环境变量部署入口：把 anon key 填在这里即可**不配环境变量直接跑**。
//   为什么可以写在代码里：**Supabase 的 `anon` key 是「公开键」**（受 RLS 保护、本就随小程序包分发）
//   ⇒ 不是机密泄露。**但 `service_role` key 绝不可如此。**
//   ★ 优先级：`env.SB_ANON_KEY`（Dashboard/Secret，推荐） > 下面这个常量。
const SB_ANON_KEY_FALLBACK = '';

// 客户端真正会调的 EF —— 不在名单内一律 404（名单由 `utils/cloudProxy.js` 的 EDGE_ACTIONS 核准）
const EF_ALLOW = new Set([
  'opendota-proxy', 'liquipedia-proxy', 'steam-proxy', 'stratz-proxy', 'haglund-proxy', 'bundle-aggregator',
  'wechat-auth', 'subscribe-send', 'follow-profile',
  // ★ 2026-10-16（方案 ③）：放行 admin 后台的写入口 EF —— 使 admin **经中转**也能写（国内可用）。
  //   ⚠️ 鉴权仍在 EF 侧（`x-admin-token` 必须匹配 EF secret `ADMIN_TOKEN`）；中转只做透传（见下方 x-admin-token 转发）。
  'admin-write'
]);

// GET 短路缓存时长（ms）
// ★ 约束：**必须 ≤ 客户端对该接口的轮询间隔**，否则会把"实时"数据缓存成过期数据
//   —— 客户端对 `/live` 是 **120s 轮询**（`config.timeWindow.livePollSec` = `pages/index/index.js POLL_BASE_MS`；
//     ★ 2026-10-13 由 60s 对齐为 120s）⇒ 这里给 20s（宁可多打一次上游，也不让用户看到旧比分）
const TTL = { proMatches: 60e3, live: 20e3, leagues: 30 * 60e3, 'default': 120e3 };

// ★★ 2026-10-10（详情页"慢"的修法）／2026-10-29（B3 扩面 + stale-while-revalidate）：
//   **EF 路径的白名单式缓存**（只缓只读 action；默认不缓 ⇒ 不会误缓写类/鉴权类 EF）。
//   背景（实测）：`getLeagueDetailBundle` 首访 6.87s / 二次 1.35s；EF 冷启动首调 8–33s。
//   做法：白名单 (EF, action) 命中即回；**过期但仍在 stale 窗口内 → 立即回旧值（`X-Proxy-Cache: STALE`）
//         + 后台单次刷新**（`_efRefreshing` 去重）⇒ 复访不再干等 EF。
//   ⚠️ 生命周期：模块内存（isolate 内）⇒ 命中率取决于流量。**不承诺"首访变快"，只承诺"复访不等 EF"**。
//   ⚠️ `force:true`（客户端下拉刷新 / 重试）**跳过读缓存**（但仍写缓存）。
const EF_CACHE = {
  'opendota-proxy|getLiveMatches': { fresh: 20e3, stale: 60e3 },              // 与 /live 的 20s 对齐
  'opendota-proxy|getHomeBundle': { fresh: 30e3, stale: 2 * 60e3 },           // 含 live ⇒ 短缓存
  'opendota-proxy|getProMatches': { fresh: 60e3, stale: 5 * 60e3 },           // 职业赛列表（变化慢）
  'opendota-proxy|getLeagueMatches': { fresh: 60e3, stale: 10 * 60e3 },       // 赛事比赛列表（含比分）
  'opendota-proxy|getTeam': { fresh: 15 * 60e3, stale: 60 * 60e3 },           // 队名 / 队徽
  'opendota-proxy|getLeagues': { fresh: 30 * 60e3, stale: 2 * 3600e3 },       // 赛事列表
  'opendota-proxy|getLeagueWindows': { fresh: 30 * 60e3, stale: 2 * 3600e3 }, // 赛期窗口
  'opendota-proxy|getHeroes': { fresh: 6 * 3600e3, stale: 24 * 3600e3 },      // 常量表
  // ★ B4：赛事详情聚合（对阵 / 队名 / 排名，变化慢）由 60s 上调到 6min。
  //   安全依据：bundle 的 `matches` 字段无客户端消费方（详情页只读 `teamNames`，比分另走
  //   `/live` 与 `getLeagueMatches`），见 supabase/functions/bundle-aggregator/index.ts L29-34。
  'bundle-aggregator|getLeagueDetailBundle': { fresh: 6 * 60e3, stale: 30 * 60e3 }
};
// 后台刷新（不阻塞用户）给足冷启动时间 —— 4s 的 STALE_TIMEOUT_MS 对冷 EF 太短，会永远刷新不上
const EF_REFRESH_TIMEOUT_MS = 15000;

const UPSTREAM_TIMEOUT_MS = 12000;
const RETRY_ON = (status) => status >= 500;

// ★★ 2026-10-24：**陈旧兜底（stale-if-error / stale-if-slow）**
//   问题（实测）：上游 OpenDota 偶发「首字节 1.4~2.8s、随后**传输长时间停滞**」（wall 2.9s / 11s / 30s+）。
//     而本中转是 **12s 超时 × 2 次尝试 = 最坏 24s**，已超过客户端单请求 20s、首页首屏 15s
//     ⇒ 用户侧表现就是「打开首页对局卡十几秒」。
//   做法：只要该 key **曾成功缓存过**（哪怕已过期），就
//     ① 只试 **1 次**，且超时收紧到 `STALE_TIMEOUT_MS`；
//     ② 失败 / 5xx ⇒ 直接回上一次成功的响应体（`X-Proxy-Cache: STALE` + `X-Proxy-Cache-Age`）。
//   ⇒ 有旧缓存时：**最多等 4s** 必有内容；**无旧缓存时行为完全不变**（仍 12s × 2）。
//   ⚠️ 陈旧响应只是「比空窗好」，**不是"新鲜"** —— 客户端仍会按自己的 TTL 继续刷新。
const STALE_TIMEOUT_MS = 4000;

const CORS = {
  'Access-Control-Allow-Origin': '*',            // 只读代理、不带凭据 ⇒ 放开便于浏览器自测
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,apikey,Prefer,Range,X-Trim,X-Admin-Token',
  'Access-Control-Expose-Headers': 'Content-Range, X-Proxy-Cache, X-Proxy-Trim, X-Proxy-Cache-Age'
};

// 模块级短路缓存（isolate 内有效）
const _cache = new Map();          // key -> { at, exp, body, status, ct, cr }

// ★★ 2026-10-29（B3）：EF 缓存**后台刷新去重** —— 同一 key 同时只刷一次（避免 STALE 窗口内
//   多用户并发各触发一次后台刷新，反而把 EF 打热）。
const _efRefreshing = new Set();

// 后台任务托管：Deno Deploy 提供 `EdgeRuntime.waitUntil`（响应返回后仍允许跑完）；
// 没有该 API 时退回"尽力而为"（refreshEfCache 内部已吞掉所有异常，不会有未处理拒绝）。
function keepAlive(p) {
  try {
    if (typeof EdgeRuntime !== 'undefined' && typeof EdgeRuntime.waitUntil === 'function') {
      EdgeRuntime.waitUntil(p);
      return;
    }
  } catch (e) { /* 落到尽力而为 */ }
  p.catch(function () { /* 静默 */ });
}

function efCacheSet(key, body, status, policy) {
  _cache.set(key, {
    at: Date.now(), exp: Date.now() + policy.fresh,
    body: body, status: status, ct: 'application/json', cr: null
  });
}

/** 后台单次刷新（不阻塞响应）。失败静默 —— 旧值仍可继续服务。 */
function refreshEfCache(key, url, init, label, policy) {
  if (_efRefreshing.has(key)) return;
  _efRefreshing.add(key);
  const p = (async function () {
    try {
      const r = await fetchUpstream(url, init, label + '（后台刷新）',
        { attempts: 1, timeoutMs: EF_REFRESH_TIMEOUT_MS });
      if (!r.ok) return;
      const body = await readText(r, EF_REFRESH_TIMEOUT_MS);
      efCacheSet(key, body, r.status, policy);
    } catch (e) { /* 静默：旧值继续服务 */ }
  })().then(function () { _efRefreshing.delete(key); }, function () { _efRefreshing.delete(key); });
  keepAlive(p);
}

function json(body, status, extra) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, CORS, extra || {})
  });
}

function passHeaders(src, keep) {
  const out = {};
  (keep || []).forEach((k) => { const v = src.get(k); if (v) out[k] = v; });
  return out;
}

// ★★ P1-12（2026-10-12）：**轻量速率限制**（按调用方 IP 的固定窗口计数，模块内存）。
//   背景：EF 均为 `--no-verify-jwt` 部署且**无任何频控**（本文件原先只有函数名白名单）
//   ⇒ 中转可被当跳板，单客户端可刷爆上游 OpenDota / Supabase 配额。
//   ⚠️ **默认关闭**：`PROXY_RATE_LIMIT_MAX`（每分钟/每 IP）缺省 0 = 不限流。
//      关闭的诚实理由（2026-10-12）：限流依赖调用方 IP，而当时**未核实平台上到底有没有**
//      `CF-Connecting-IP` / `X-Forwarded-For`；取不到时会把所有客户端混进同一个桶 ⇒ 可能误伤。
//      ⇒ **已按平台核实并改造（2026-10-13）**：见 `clientIp()` —— 平台注入值优先、取不到则 **fail-open**；
//        且 Deno 侧须用 `Deno.env.get('PROXY_RATE_LIMIT_MAX')`（第二参数是 connInfo，不是 env）。
//        ⚠️ 打开前仍须按 DEPLOY.md 的「IP 头验证」步骤确认 `ipSource` 非 `none`、且**换网络后 IP 不同**。
//   ⚠️ `/healthz` **天然豁免**（在上方分支已 return）—— 探活/开机体检不得被限流限死。
const _rl = new Map();   // ip -> { win, n }

// 客户端 IP 解析：**优先 adapter 注入的可信值**，请求头只作兜底。
// ★★ 2026-10-13（P1-12 复核，已核实平台事实）：**`CF-Connecting-IP` 在本项目的两个平台都不存在**——
//   ① **Deno Deploy**：正规来源是 handler 的**第二参数** `connInfo.remoteAddr.hostname`（不是 Cloudflare）；
//   ② **Netlify Edge**：正规来源是**第二参数** `context.ip`（另有 `x-nf-client-connection-ip` 头可用）；
//   ③ **Node 自建**（`node-server.mjs`）：**刻意不注入** `ctx.ip` —— 它按设计跑在 Caddy 反代之后，
//      那时 socket IP 是反代自己；应由反代把 `X-Forwarded-For` **覆写**成真实客户端 IP，
//      再走本函数末段的头兜底链（否则会把所有用户归到反代那一个 IP 上）。
//   ⇒ 各入口通过 `handle(request, env, ctx)` 的 `ctx = { ip }` 注入；缺省回落到请求头。
//   ⚠️ 头是**可伪造**的：只有平台/反代注入的 `ctx.ip` 才可信；本中转是只读代理，风险有限。
function clientIp(request, ctx) {
  var h = (request && request.headers) || null;
  var get = function (k) { try { return h && h.get ? h.get(k) : null; } catch (e) { return null; } };
  var v = (ctx && ctx.ip) || '';
  if (v) return { ip: String(v).trim(), source: 'ctx' };
  v = get('CF-Connecting-IP'); if (v) return { ip: String(v).trim(), source: 'cf' };
  v = get('x-nf-client-connection-ip'); if (v) return { ip: String(v).trim(), source: 'nf' };
  v = get('X-Forwarded-For'); if (v) return { ip: String(v).split(',')[0].trim(), source: 'xff' };
  return { ip: '', source: 'none' };
}

// `/healthz` 回显用的打码（避免探活接口变成 IP 收集器）：IPv4 留前三段、IPv6 留前 3 组
function maskIp(ip) {
  var s = String(ip || '');
  if (!s) return '';
  // ★ 2026-10-13：**先剥掉 IPv4-mapped IPv6 前缀** —— Deno Deploy 的 `connInfo.remoteAddr.hostname`
  //   对 IPv4 客户端返回的是 `::ffff:1.2.3.4`。若不剥，就会走下面的 IPv6 分支、打码成 `::ffff::x`
  //   ⇒ **所有 IPv4 客户端看起来一模一样**，`/healthz` 的 `ipMasked` 就再也不能用来核对
  //   「是不是每客户端一个桶」（开 `PROXY_RATE_LIMIT_MAX` 前的必做验证）。
  var m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(s);
  if (m) s = m[1];
  if (s.indexOf(':') >= 0) return s.split(':').slice(0, 3).join(':') + '::x';
  var p = s.split('.');
  return p.length === 4 ? p[0] + '.' + p[1] + '.' + p[2] + '.x' : s;
}

// ★★ 2026-10-13（P1-12 实开）：**限流阈值兜底常量**（`env` 优先、本常量兜底）。
//   平台差异（两轮实测 + 一次自我更正）：两家平台的 env 都是**部署时注入**（文档口径一致：Netlify
//   「edge function 的 env 变更须 build + deploy」、Deno Deploy「**部署不可变**（含 env），改项目 env
//   不改现有部署」）⇒ **改 env 后必须重新部署才生效**。
//     · `[2]` **Netlify**：设 env + 重新部署 ⇒ 生效（实测 404×120 + 429×26）。
//     · `[0]`/`[1]` **Deno**：**第一轮"重新部署"时 env 尚未生效**（404×200、0 个 429），
//       ⇒ 当时一度**误判为"Playground 不注入 env"**；**重贴（=重新部署）后即读到**
//       （`/healthz` 回 **`rlSrc:"env"`**）并出现 429 ⇒ ★ **更正：Deno Playground 同样注入 env**，
//       先前的判断是错的——根因在**部署时机**，不在平台。
//   ⇒ 本常量**并非必需**，只作「env 缺失时」的兜底（万一将来漏配 env，Deno 两台也不至于失去限流）。
//   ⚠️ 阈值**非机密**（本中转是公开只读代理，知晓阈值无实质危害）⇒ 可安全写入代码。
//   ⚠️ 仍未取到客户端 IP 时**照旧 fail-open**（见下），绝不把全体用户一起 429。
//   ⚠️ 诚实边界：三台均为**模块内内存计数**（仅 isolate 生命周期内有效）⇒ **并发跨 isolate 时计数会分散**
//      （实测 250 并发：151×404 / 10×429 / 89×连接失败）；**常态（顺序、单客户端）流量下可靠**。
const PROXY_RATE_LIMIT_MAX_FALLBACK = '120';

function rateLimited(request, env, ctx, now) {
  const max = parseInt((env && env.PROXY_RATE_LIMIT_MAX) || PROXY_RATE_LIMIT_MAX_FALLBACK || '0', 10) || 0;
  if (max <= 0) return false;                       // 阈值 0 ⇒ 关闭
  // ★ 取不到 IP ⇒ **fail-open（不限流）**。旧实现把"取不到"的客户端都塞进 `'unknown'` 同一个桶，
  //   一旦开启限流会**把全体用户一起 429**（误伤远大于收益）⇒ 宁可暂不限流。
  const ci = clientIp(request, ctx);
  if (!ci.ip) return false;
  const win = Math.floor(now / 60000);
  const ip = ci.ip;
  let e = _rl.get(ip);
  if (!e || e.win !== win) { e = { win, n: 0 }; _rl.set(ip, e); }
  e.n++;
  // 防内存膨胀：条目过多时清掉非当前窗口
  if (_rl.size > 10000) { for (const [k, v] of _rl) { if (v.win !== win) _rl.delete(k); } }
  return e.n > max;
}

/**
 * 「按需裁剪」解析：`?recent=N` 或请求头 `X-Trim: N`，两者取其一。
 * ★ P0-1 C（2026-10-12）语义升级 —— **区分「未声明」与「显式不裁」**：
 *   · 未声明（既无 `recent` 也无 `X-Trim`）→ `{n:0, declared:false}` ⇒ 交由默认白名单（见 DEFAULT_TEAM_TRIM）；
 *   · 显式 `?recent=0` / `X-Trim: 0`（或负数）→ `{n:0, declared:true}` ⇒ **明确要全量，豁免默认裁剪**。
 *   ⇒ 这样「后台补全量」这类调用可主动声明全量，而未来漏声明的调用点被默认值兜住（零回归保证靠显式豁免）。
 * 上限 500，避免被传巨大值当"绕过"。
 */
function trimInfo(request, url) {
  let raw = null, declared = false;
  if (url.searchParams.has('recent')) { raw = url.searchParams.get('recent'); declared = true; }
  else { try { const h = request.headers.get('X-Trim'); if (h !== null && h !== '') { raw = h; declared = true; } } catch (e) {} }
  if (!declared) return { n: 0, declared: false };
  const n = parseInt(raw, 10);
  if (!isFinite(n) || n <= 0) return { n: 0, declared: true };   // 显式不裁
  return { n: Math.min(n, 500), declared: true };
}

// ★ P0-1 C：端点级**默认裁剪白名单** —— 调用方未声明时的保守默认
//   （避免未来新调用点重蹈"拉 480KB 全量 ⇒ 超时"覆辙）。需要全量的调用用 `X-Trim: 0` 显式豁免。
const DEFAULT_TEAM_TRIM = 300;

// ★★ 2026-10-30（team-detail 近期段慢的修因）：**战队比赛「原始全量」二级缓存**。
//   背景（实测 2026-10-30）：`?recent=50` 与 `X-Trim:0` 各自回源一次 OpenDota（480~630KB），
//   而本机→上游大包当前 **>90s 不可用** ⇒ 两个变体都慢/超时；但它们要的是**同一份上游数据**。
//   做法：`/teams/<id>/matches` 只回源**一次**（刻意**丢掉客户端的 recent/vs 查询串** ——
//   OpenDota 本就不支持这两个参数，原样转发只会造成"一变体一份上游请求"），
//   把全量原文缓存 `RAW_TEAM_MATCHES_TTL_MS`；recent / vs / 全量三种变体都从这份原文裁剪。
//   ⇒ 首次之后：近端命中（不再回源）、且三种变体共享一次下载。
//   ⚠️ 内存：原文约 600KB/队 ⇒ LRU 上限 8 队（≈5MB/isolate，模块内存随 isolate 回收）。
//   ⚠️ 陈旧兜底沿用 STALE_TIMEOUT_MS：有原文但已过 TTL ⇒ 单次尝试 + 4s，失败回原文（`X-Proxy-Cache: STALE`）。
const RAW_TEAM_MATCHES_TTL_MS = 10 * 60e3;
const RAW_TEAM_MATCHES_MAX = 8;
const _rawTeamMatches = new Map();   // 'teams/<id>/matches' -> { at, body }

// 从「原始全量」构造某个变体（recent / vs / 全量）；解析失败返回 null（调用方原样透传）
function teamMatchesBody(rawText, effTrim, vs) {
  let data = null;
  try { data = JSON.parse(rawText); } catch (e) { data = null; }
  if (!Array.isArray(data)) return null;
  let kept = data;
  let receipt = '';
  let label = '';
  if (vs) {
    kept = data.filter((x) => x && String(x.opposing_team_id) === vs);
    receipt = 'vs:' + kept.length;
  } else if (effTrim > 0) {
    kept = data.slice(0, effTrim);
    receipt = 'recent:' + kept.length;
  } else {
    // ★ 未裁剪 ⇒ **不回写回执头**（与改造前一致，仅日志标注 full）
    label = 'full:' + kept.length;
  }
  return { body: JSON.stringify(kept), receipt: receipt, label: label || receipt };
}

/**
 * 战队比赛专用：**先原始全量缓存，再按变体裁剪**（详见上方常量注释）。
 * 必须保持的行为：`X-Proxy-Trim` 回执、变体级 TTL 缓存、stale-if-error、非数组原样透传。
 */
async function serveTeamMatches(rest, label, effTrim, vs, ck, ttl, bodyMs) {
  const rawHit = _rawTeamMatches.get(rest) || null;
  const rawFresh = !!(rawHit && (Date.now() - rawHit.at) < RAW_TEAM_MATCHES_TTL_MS);
  let txt = null;
  let status = 200;
  let ct = 'application/json';
  let state = 'MISS';

  if (rawFresh) {
    txt = rawHit.body;
    state = 'RAW';
    console.log('[proxy] OD ' + rest + ' → 原始全量缓存命中（' +
      Math.round(byteLen(txt) / 1024) + 'KB，age ' +
      Math.round((Date.now() - rawHit.at) / 1000) + 's）');
  } else {
    let r;
    try {
      r = await fetchUpstream('https://api.opendota.com/api/' + rest,
        { method: 'GET', headers: { 'Accept-Encoding': 'gzip' } }, label,
        rawHit ? { attempts: 1, timeoutMs: STALE_TIMEOUT_MS } : undefined);
    } catch (e) {
      if (!rawHit) throw e;
      txt = rawHit.body;
      state = 'STALE';
    }
    if (txt === null) {
      if (rawHit && r.status >= 500) {
        try { r.body && r.body.cancel && await r.body.cancel(); } catch (e) { /* ignore */ }
        txt = rawHit.body;
        state = 'STALE';
      } else {
        try {
          txt = await readText(r, bodyMs);
        } catch (e) {
          if (!rawHit) throw e;
          txt = rawHit.body;
          state = 'STALE';
        }
        status = r.status;
        ct = r.headers.get('content-type') || 'application/json';
        if (r.ok) {
          _rawTeamMatches.set(rest, { at: Date.now(), body: txt });
          // LRU 上限：Map 按插入顺序迭代 ⇒ 删最老的一条
          if (_rawTeamMatches.size > RAW_TEAM_MATCHES_MAX) {
            const oldest = _rawTeamMatches.keys().next().value;
            if (oldest && oldest !== rest) _rawTeamMatches.delete(oldest);
          }
        }
      }
    }
  }

  const v = teamMatchesBody(txt, effTrim, vs);
  const staleAge = (state === 'STALE' && rawHit)
    ? String(Math.max(0, Math.round((Date.now() - rawHit.at) / 1000))) : null;
  if (v) {
    if (status >= 200 && status < 300) {
      _cache.set(ck, { at: Date.now(), exp: Date.now() + ttl, body: v.body, status: 200, ct: 'application/json', cr: null });
    }
    console.log('[proxy] OD ' + rest + ' → ' + v.label + '（原始 ' +
      Math.round(byteLen(txt) / 1024) + 'KB，' + state + '）');
    const extra = v.receipt ? { 'X-Proxy-Trim': v.receipt } : {};
    if (staleAge) extra['X-Proxy-Cache-Age'] = staleAge;
    return textResponse(v.body, 200, 'application/json', null, state === 'STALE' ? 'STALE' : 'MISS', extra);
  }
  return textResponse(txt, status, ct, null, state === 'STALE' ? 'STALE' : 'MISS',
    staleAge ? { 'X-Proxy-Cache-Age': staleAge } : undefined);
}

// ★★ 2026-10-29（B1）：`/matches/{id}` 响应裁剪 + 分状态 TTL
//   实测单场 `/matches/{id}` ~286KB，其中 players 里的 `purchase_log` / `kills_log` /
//   `ability_upgrades_arr` / `obs_log` 等**客户端一个字段都不读**，却要在弱网首帧传输一遍。
//   做法：**白名单字段重建**（形状不变：仍是 match 对象 + players 数组），默认裁剪；
//   `?full=1` 显式要全量（后台排查 / 未来新消费方）。
const MATCH_TRIM_MAX_BYTES = 15 * 1024;
const MATCH_TOP_FIELDS = [
  'match_id', 'radiant_win', 'duration', 'start_time', 'radiant_score', 'dire_score',
  'radiant_team_id', 'dire_team_id', 'radiant_name', 'dire_name',
  'radiant_team_name', 'dire_team_name', 'radiant_logo', 'dire_logo', 'league',
  'radiant_gold_adv', 'radiant_xp_adv',
  'radiant_gold_advantage_timeline', 'radiant_xp_advantage_timeline'
];
// 与 subpackages/detail/match-detail/match-detail.js 的 `_buildPlayers` / `buildItems` 一一对应
const MATCH_PLAYER_FIELDS = [
  'account_id', 'player_slot', 'isRadiant', 'hero_id', 'personaname', 'name',
  'kills', 'deaths', 'assists', 'gold_per_min', 'xp_per_min',
  'last_hits', 'denies', 'hero_damage', 'tower_damage',
  'item_0', 'item_1', 'item_2', 'item_3', 'item_4', 'item_5', 'item_neutral'
];
// `buildEvents` 只读 time / type / key / subtype
const MATCH_OBJECTIVE_FIELDS = ['time', 'type', 'key', 'subtype'];
// 直播中：= 客户端轮询间隔（每条客户端轮询必然过期，不会看到超过 30s 的旧比分；
// 同时让同一场比赛的多个观众共享这一份缓存）；已完赛：数据不可变（客户端硬 TTL 30min）
const MATCH_TTL_LIVE_MS = 30e3;
const MATCH_TTL_DONE_MS = 30 * 60e3;

function byteLen(s) {
  try { return new TextEncoder().encode(s).length; } catch (e) { return s.length; }
}

function pickFields(src, fields) {
  const out = {};
  for (let i = 0; i < fields.length; i++) {
    const k = fields[i];
    if (src[k] !== undefined) out[k] = src[k];
  }
  return out;
}

/**
 * 裁剪单场比赛详情，返回已序列化的 `{ body, players, bytes }`。
 * 两级兜底保证 ≤15KB：
 *   ① objectives 只留客户端实际消费的事件（`ROSHAN` / `building_kill`）；
 *   ② 仍超限 ⇒ 丢弃 objectives（图表事件标记降级为空，比分/选手/曲线不受影响）。
 */
function trimMatch(data) {
  const out = pickFields(data, MATCH_TOP_FIELDS);
  if (Array.isArray(data.players)) {
    out.players = data.players.map(function (p) {
      return (p && typeof p === 'object') ? pickFields(p, MATCH_PLAYER_FIELDS) : p;
    });
  }
  if (Array.isArray(data.objectives)) {
    out.objectives = data.objectives.map(function (o) {
      return (o && typeof o === 'object') ? pickFields(o, MATCH_OBJECTIVE_FIELDS) : o;
    });
  }
  let body = JSON.stringify(out);
  if (byteLen(body) > MATCH_TRIM_MAX_BYTES && Array.isArray(out.objectives)) {
    out.objectives = out.objectives.filter(function (o) {
      return o && (/ROSHAN/.test(o.type || '') || o.type === 'building_kill');
    });
    body = JSON.stringify(out);
  }
  if (byteLen(body) > MATCH_TRIM_MAX_BYTES && out.objectives) {
    delete out.objectives;
    body = JSON.stringify(out);
  }
  return { body: body, players: (out.players || []).length, bytes: byteLen(body) };
}

/**
 * 带超时 + 1 次重试的上游请求（仅 5xx/网络异常重试）。
 * @param {{attempts?:number,timeoutMs?:number}} [opts] 陈旧兜底场景传 `{attempts:1,timeoutMs:STALE_TIMEOUT_MS}`
 */
async function fetchUpstream(url, init, label, opts) {
  const attempts = (opts && opts.attempts) || 2;
  const timeoutMs = (opts && opts.timeoutMs) || UPSTREAM_TIMEOUT_MS;
  let lastErr = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const t0 = Date.now();
    try {
      const r = await fetch(url, Object.assign({}, init, { signal: ac.signal }));
      clearTimeout(timer);
      const ms = Date.now() - t0;
      if (attempt === 0 && attempts > 1 && RETRY_ON(r.status)) {
        console.log('[proxy] ' + label + ' → ' + r.status + ' ' + ms + 'ms（5xx，重试一次）');
        try { r.body && r.body.cancel && await r.body.cancel(); } catch (e) { /* ignore */ }
        continue;
      }
      console.log('[proxy] ' + label + ' → ' + r.status + ' ' + ms + 'ms' + (attempt ? '（重试后）' : ''));
      return r;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      const why = (e && e.name === 'AbortError') ? 'TIMEOUT' : ((e && e.message) || String(e));
      console.log('[proxy] ' + label + ' → 异常 ' + why + (attempt ? '（重试后仍失败）' : '（将重试）'));
    }
  }
  throw lastErr || new Error('upstream failed');
}

/** 透传上游响应（保留状态码 + 关键头；叠加 CORS） */
function forward(r) {
  const headers = new Headers(CORS);
  const ct = r.headers.get('content-type');
  if (ct) headers.set('Content-Type', ct);
  const cr = r.headers.get('content-range');
  if (cr) headers.set('Content-Range', cr);
  return new Response(r.body, { status: r.status, headers: headers });
}

function textResponse(body, status, ct, cr, cacheState, extra) {
  const h = Object.assign({}, CORS, { 'Content-Type': ct || 'application/json' });
  if (cr) h['Content-Range'] = cr;
  if (cacheState) h['X-Proxy-Cache'] = cacheState;
  if (extra) Object.assign(h, extra);   // ★ P0-1：裁剪/过滤回执头（X-Proxy-Trim）
  return new Response(body, { status: status, headers: new Headers(h) });
}

/**
 * 读响应体并**带超时**（★ 2026-10-24）。
 * 为什么需要：`AbortController` 的超时只在 `fetch()` 返回**响应头**时被 clearTimeout 掉，
 *   而实测的故障形态正是「头很快、**body 传输停滞**」⇒ 原先的 12s 超时管不到这一段，
 *   一次卡住的 body 读取可以把首页拖到客户端超时。这里给 body 读也设上限。
 */
function readText(r, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('body timeout')), ms);
    r.text().then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

/** 陈旧兜底响应：把上一次成功的响应体原样返回，并显式标记 STALE + 年龄 */
function staleResponse(hit, label) {
  const age = Math.max(0, Math.round((Date.now() - (hit.at || Date.now())) / 1000));
  console.log('[proxy] ' + (label || '') + ' → 返回陈旧缓存（age ' + age + 's）');
  return textResponse(hit.body, 200, hit.ct || 'application/json', hit.cr || null, 'STALE',
    { 'X-Proxy-Cache-Age': String(age) });
}

// ★ 2026-10-13（方案 B）：原 `handle` 改名 `_handle`；对外仍导出 `handle`（= `_handle` + 按需 gzip 包装）。
async function _handle(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  // ★ 方法闸门必须在所有路由之前（否则 `DELETE /healthz` 会被健康检查放行 —— 本地测试抓到过）
  if (method !== 'GET' && method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const ref = (env && env.SUPABASE_REF) || DEFAULT_SUPABASE_REF;
  const sbKey = (env && env.SB_ANON_KEY) || SB_ANON_KEY_FALLBACK;
  const sbHeaders = sbKey ? { Authorization: 'Bearer ' + sbKey, apikey: sbKey } : {};

  // ── 健康检查 ──────────────────────────────────────────────────────────────
  if (path === '/healthz') {
    // ★ P1-12：探活回显「限流键来源 + 打码 IP」—— 供「IP 头是否注入」的验证（见 DEPLOY.md）
    const _ci = clientIp(request, ctx);
    // ★ P1-12：回显**限流阈值 + 来源** ⇒ 一眼判定平台是否真的注入了 env（本项目为此"靠猜"多轮，
    //   今后不必再猜：`rlSrc==='env'` = 平台注入生效；`'fallback'` = 走代码常量兜底；`'off'` = 关闭）。
    const _rlEnv = (env && env.PROXY_RATE_LIMIT_MAX) || '';
    const _rlMax = parseInt(_rlEnv || PROXY_RATE_LIMIT_MAX_FALLBACK || '0', 10) || 0;
    const base = {
      ok: true, ts: new Date().toISOString(),
      hasKey: !!sbKey, ref: ref,
      routes: ['/sb/functions/v1/*', '/sb/rest/v1/*', '/od/api/*'],
      ipSource: _ci.source, ipMasked: maskIp(_ci.ip),
      rlMax: _rlMax, rlSrc: _rlEnv ? 'env' : (PROXY_RATE_LIMIT_MAX_FALLBACK ? 'fallback' : 'off'),
      // ★ B6：`registered:false` 说明当前运行时没有 `Deno.cron`（本地 / Netlify）⇒ keep-warm 未生效
      keepWarm: { registered: KEEP_WARM_REGISTERED, efs: KEEP_WARM_EFS.length, cron: KEEP_WARM_CRON }
    };
    if (url.searchParams.get('deep') !== '1') return json(base);

    const out = Object.assign({}, base, { deep: {} });
    // ① 中转 → Supabase（EF 可达性：401/404 也算"网络通"）
    try {
      const r = await fetchUpstream('https://' + ref + '.supabase.co/functions/v1/opendota-proxy',
        { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, sbHeaders), body: '{"action":"getProMatches","params":{}}' },
        'deep/supabase');
      out.deep.supabase = { reachable: true, status: r.status };
    } catch (e) { out.deep.supabase = { reachable: false, error: String((e && e.message) || e) }; }
    // ② 中转 → OpenDota
    try {
      const r = await fetchUpstream('https://api.opendota.com/api/proMatches', { method: 'GET' }, 'deep/opendota');
      out.deep.opendota = { reachable: true, status: r.status };
    } catch (e) { out.deep.opendota = { reachable: false, error: String((e && e.message) || e) }; }
    out.ok = !!(out.deep.supabase.reachable || out.deep.opendota.reachable);
    return json(out);
  }

  try {
    // ★ P1-12：速率限制（默认关闭，见 rateLimited 注释；/healthz 已在上方 return ⇒ 天然豁免）
    if (rateLimited(request, env, ctx, Date.now())) return json({ error: 'rate limited' }, 429);

    // ─────────────── ① Supabase Edge Function：/sb/functions/v1/<name> ───────────────
    let m = /^\/sb\/functions\/v1\/([A-Za-z0-9_-]+)\/?$/.exec(path);
    if (m) {
      if (!EF_ALLOW.has(m[1])) return json({ error: 'ef not allowed', name: m[1] }, 404);
      const rawBody = method === 'POST' ? await request.text() : '{}';
      // ★ 2026-10-16（方案 ③）：**转发 `x-admin-token`** —— 否则 admin 经中转写时，EF 收到空令牌 ⇒ 恒 401。
      //   只转发这一个自定义头（不转发客户端 apikey/Authorization：那两者由 `sbHeaders` 覆盖为中转自己的 key）。
      const adminFwd = passHeaders(request.headers, ['x-admin-token']);
      // ★★ 2026-10-29（B3）：白名单式 EF 缓存（EF_CACHE）。`force` 跳过读缓存；其余走
      //   HIT → STALE(后台刷新) → 回源 三态。未登记的 (EF, action) 行为与改造前一致（不缓、流式透传）。
      let efPayload = {};
      try { efPayload = JSON.parse(rawBody || '{}') || {}; } catch (e) { efPayload = {}; }
      const efAction = efPayload.action || '';
      const efLabel = 'EF ' + m[1] + (efAction ? '/' + efAction : '');
      const policy = EF_CACHE[m[1] + '|' + efAction];
      const force = efPayload.force === true;
      let efKey = null;
      let hit = null;
      if (policy) {
        let efParams = '';
        try { efParams = JSON.stringify(efPayload.params || {}); } catch (e) { efParams = ''; }
        efKey = 'ef|' + m[1] + '|' + efAction + '|' + efParams;
        if (!force) {
          hit = _cache.get(efKey) || null;
          const now = Date.now();
          if (hit && hit.exp > now) {
            console.log('[proxy] ' + efLabel + ' → 缓存命中');
            return textResponse(hit.body, hit.status, 'application/json', null, 'HIT');
          }
          // stale-while-revalidate：过期但在 stale 窗口内 ⇒ 立即回旧值 + 后台单次刷新
          if (hit && hit.body && (now - (hit.at || 0)) <= (policy.fresh + policy.stale)) {
            refreshEfCache(efKey, 'https://' + ref + '.supabase.co/functions/v1/' + m[1],
              { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, sbHeaders, adminFwd), body: rawBody },
              efLabel, policy);
            return staleResponse(hit, efLabel);
          }
        }
      }
      const efUrl = 'https://' + ref + '.supabase.co/functions/v1/' + m[1];
      const efInit = {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, sbHeaders, adminFwd),
        body: rawBody
      };
      // 未登记 ⇒ 原行为：流式透传（不缓冲、不缓存）
      if (!policy) return forward(await fetchUpstream(efUrl, efInit, efLabel));

      // 登记但无命中（或 force）：首次最多 12s × 2；有旧值但已超出 stale 窗口 ⇒ 单次 4s + 旧值兜底
      let r;
      try {
        r = await fetchUpstream(efUrl, efInit, efLabel,
          hit ? { attempts: 1, timeoutMs: STALE_TIMEOUT_MS } : undefined);
      } catch (e) {
        if (hit && hit.body) return staleResponse(hit, efLabel);
        throw e;
      }
      if (hit && hit.body && r.status >= 500) {
        try { r.body && r.body.cancel && await r.body.cancel(); } catch (e) { /* ignore */ }
        return staleResponse(hit, efLabel);
      }
      if (!r.ok) return forward(r);
      let body = '';
      try { body = await readText(r, hit ? STALE_TIMEOUT_MS : UPSTREAM_TIMEOUT_MS); }
      catch (e) { if (hit && hit.body) return staleResponse(hit, efLabel); throw e; }
      efCacheSet(efKey, body, r.status, policy);
      return textResponse(body, r.status, 'application/json', null, 'MISS');
    }

    // ─────────────── ② Supabase PostgREST 只读：/sb/rest/v1/<table> ───────────────
    m = /^\/sb\/rest\/v1\/([A-Za-z0-9_]+)\/?$/.exec(path);
    if (m) {
      if (method !== 'GET') return json({ error: 'rest is read-only here' }, 405);
      const ck = 'rest|' + path + (url.search || '');
      const hit = _cache.get(ck);
      if (hit && hit.exp > Date.now()) {
        console.log('[proxy] REST ' + m[1] + ' → 缓存命中');
        return textResponse(hit.body, hit.status, hit.ct, hit.cr, 'HIT');
      }
      const headers = passHeaders(request.headers, ['Range', 'Prefer']);   // ★ Range 必须保留（客户端分页依赖）
      Object.assign(headers, sbHeaders);
      // ★ 2026-10-24：陈旧兜底（见 STALE_TIMEOUT_MS 注释）
      const stale = (hit && hit.body) ? hit : null;
      const label = 'REST ' + m[1];
      let r;
      try {
        r = await fetchUpstream('https://' + ref + '.supabase.co/rest/v1/' + m[1] + (url.search || ''),
          { method: 'GET', headers: headers }, label,
          stale ? { attempts: 1, timeoutMs: STALE_TIMEOUT_MS } : undefined);
      } catch (e) {
        if (stale) return staleResponse(stale, label);
        throw e;
      }
      if (stale && r.status >= 500) {
        try { r.body && r.body.cancel && await r.body.cancel(); } catch (e) { /* ignore */ }
        return staleResponse(stale, label);
      }
      let body = '';
      try {
        body = await readText(r, stale ? STALE_TIMEOUT_MS : UPSTREAM_TIMEOUT_MS);
      } catch (e) {
        if (stale) return staleResponse(stale, label);
        throw e;
      }
      const ct = r.headers.get('content-type') || 'application/json';
      const cr = r.headers.get('content-range');
      if (r.ok) _cache.set(ck, { at: Date.now(), exp: Date.now() + TTL['default'], body: body, status: r.status, ct: ct, cr: cr });
      return textResponse(body, r.status, ct, cr, 'MISS');
    }

    // ─────────────── ③ OpenDota：/od/api/<path> ───────────────
    if (path.indexOf('/od/api/') === 0) {
      const rest = path.slice('/od/api/'.length);
      if (!/^[A-Za-z0-9_\/.-]+$/.test(rest)) return json({ error: 'bad path' }, 400);

      // ★ P0-1 C：**先算「有效裁剪量」再入缓存键** —— 否则「默认裁 300」与「显式不裁」会共用同一 `t0` 键 ⇒ 缓存污染。
      const ti = trimInfo(request, url);
      const vs = (url.searchParams.get('vs') || '').trim();   // ★ P0-1 B′：双方交锋过滤
      const isTeamMatches = /^teams\/[^\/]+\/matches$/.test(rest);
      // ★ B1：单场比赛详情（`/matches/<id>`）默认裁剪；`?full=1` 显式要全量
      const isMatch = /^matches\/\d+$/.test(rest);
      const wantFull = url.searchParams.get('full') === '1';
      const effTrim = ti.n > 0 ? ti.n
        : (isTeamMatches && !ti.declared && !vs ? DEFAULT_TEAM_TRIM : 0);
      const ck = 'od|' + rest + (url.search || '') + '|t' + effTrim;
      let ttl = TTL[rest] || TTL['default'];
      const hit = _cache.get(ck);
      if (hit && hit.exp > Date.now()) {
        console.log('[proxy] OD ' + rest + ' → 缓存命中');
        return textResponse(hit.body, hit.status, 'application/json', null, 'HIT');
      }
      // ★ 2026-10-24：陈旧兜底（见 STALE_TIMEOUT_MS 注释）—— 有旧缓存 ⇒ 单次尝试 + 4s 超时
      const stale = (hit && hit.body) ? hit : null;
      const label = 'OD ' + rest;
      const bodyMs = stale ? STALE_TIMEOUT_MS : UPSTREAM_TIMEOUT_MS;
      // ★ 2026-10-30：战队比赛走「原始全量二级缓存」（recent/vs/全量共享一次上游下载）。
      //   注意：这里**必须提前 return**，不再落到下方通用回源（否则 recent 与全量各自再拉一次）。
      if (isTeamMatches) return await serveTeamMatches(rest, label, effTrim, vs, ck, ttl, bodyMs);
      let r;
      try {
        r = await fetchUpstream('https://api.opendota.com/api/' + rest + (url.search || ''),
          { method: 'GET', headers: { 'Accept-Encoding': 'gzip' } }, label,
          stale ? { attempts: 1, timeoutMs: STALE_TIMEOUT_MS } : undefined);
      } catch (e) {
        if (stale) return staleResponse(stale, label);
        throw e;
      }
      if (stale && r.status >= 500) {
        try { r.body && r.body.cancel && await r.body.cancel(); } catch (e) { /* ignore */ }
        return staleResponse(stale, label);
      }

      // `/leagues` 轻量裁剪：丢 tier=excluded（形状不变）
      if (rest === 'leagues' && r.ok) {
        let txt = '';
        try { txt = await readText(r, bodyMs); } catch (e) { if (stale) return staleResponse(stale, label); throw e; }
        let data = null;
        try { data = JSON.parse(txt); } catch (e) { data = null; }
        if (Array.isArray(data)) {
          const kept = data.filter((x) => !x || x.tier !== 'excluded');
          const body = JSON.stringify({ kept: kept.length, dropped: data.length - kept.length, data: kept });
          _cache.set(ck, { at: Date.now(), exp: Date.now() + ttl, body: body, status: 200, ct: 'application/json', cr: null });
          return textResponse(body, 200, 'application/json', null, 'MISS');
        }
        // 非数组（异常响应）⇒ 原样透传，别自作主张
        return textResponse(txt, r.status, r.headers.get('content-type') || 'application/json', null, 'MISS');
      }

      // ★★ 2026-10-10（问题A 修法①·按需裁剪）／2026-10-12（P0-1 B′ + C）
      //   背景：实测 `/teams/<id>/matches` **480KB**，远超上游 12s 口径 ⇒ 全量易超时。
      //   ★ P0-1 B′：`?vs=<id>` ⇒ 端点级「双方交锋」过滤（全历史 A∩B，语义精确、payload 极小）。
      //   ★ P0-1 C：未声明（无 `recent`/`X-Trim`）且非 `vs` ⇒ **默认裁 DEFAULT_TEAM_TRIM(300)** 兜底；
      //     需要全量的调用（team-detail 后台补全量）用 `X-Trim: 0` **显式豁免**（`trimInfo.declared`）。
      //   ★★ 2026-10-30：以上语义**已迁入 `serveTeamMatches()`**（上方提前 return），
      //      三者现在共享同一份「原始全量」缓存，不再各回源一次。

      let body = '';
      try { body = await readText(r, bodyMs); } catch (e) { if (stale) return staleResponse(stale, label); throw e; }
      const ct = r.headers.get('content-type') || 'application/json';
      // ★★ 2026-10-29（B1）：单场比赛详情 —— 白名单裁剪 + 分状态 TTL（详见 trimMatch 注释）
      let trimReceipt = null;
      if (isMatch && r.ok) {
        let parsed = null;
        try { parsed = JSON.parse(body); } catch (e) { parsed = null; }
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          ttl = (parsed.radiant_win != null) ? MATCH_TTL_DONE_MS : MATCH_TTL_LIVE_MS;
          if (!wantFull) {
            const origBytes = byteLen(body);
            const t = trimMatch(parsed);
            body = t.body;
            trimReceipt = 'match:' + t.players + 'p/' + Math.round(t.bytes / 1024) + 'K';
            console.log('[proxy] OD ' + rest + ' → 裁剪 ' + Math.round(origBytes / 1024) + 'KB → ' +
              Math.round(t.bytes / 1024) + 'KB（players ' + t.players + '）');
          }
        }
      }
      if (r.ok) _cache.set(ck, { at: Date.now(), exp: Date.now() + ttl, body: body, status: r.status, ct: ct, cr: null });
      return textResponse(body, r.status, ct, null, 'MISS',
        trimReceipt ? { 'X-Proxy-Trim': trimReceipt } : undefined);
    }

    // ─────────────── ④ Liquipedia：**刻意不代理**（2026-10-10）
    //   理由两条：
    //   ① 实测 `liquipedia.net` 在国内**直连可达** ⇒ 客户端无需绕中转；
    //   ② 本项目有「**标识性 UA 必须单点化**」的守卫（`scripts/test/test-sources.js`）——
    //      UA 的单一来源是 `utils/lp-ua.js`。在这里再写一份 UA 字面量会形成**第二定义**，
    //      将来必然漂移 ⇒ **不给自己挖坑，直接不提供 /lp 路由**。

    return json({ error: 'not found', path: path }, 404);
  } catch (e) {
    // 上游失败：把原因回给调用方（便于真机排查），但**不泄露任何凭据**
    return json({ error: 'upstream failed', detail: String((e && e.message) || e) }, 502);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ★★ 2026-10-13（方案 B · 省出网）：**按需 gzip**（实测 JSON 体可压到 1/5~1/8）
//
// ## 为什么用「客户端显式声明」而不是看 `Accept-Encoding`
//   真机对照实验证实：**微信 HTTP 栈会自动发 `Accept-Encoding: gzip`**（我们没设 header 也拿到了
//   `Content-Encoding: gzip`）。⇒ 若按 `Accept-Encoding` 判断，**一部署就对所有客户端生效**
//   （含已发布老版本），一旦解码不兼容就是**全站白屏**。故改为显式门控：
//     · 新版本客户端请求头带 **`X-Gzip-Ok: 1`** ⇒ 回 gzip；
//     · 老版本不带 ⇒ 照旧明文 ⇒ **零回归**（老客户端行为逐字节不变）。
//   `env.PROXY_GZIP === '1'` 可强制开启（自测 / 应急）。
//
// ## 实现选型（三个避坑点）
//   ① **只回 gzip，绝不回 br/zstd**（小程序对这两类无透明解压）⇒ 因此**不能**直接透传上游的
//      `Content-Encoding`；本函数是在「已拿到解压后的明文 Response」之上**自己再压**。
//   ② **fail-open**：压缩环节任何异常都还原成明文，绝不因压缩失败破坏响应。
//   ③ 只压 `application/json`；已带 `Content-Encoding` 的不重复压；**小于 1KB 的不压**
//      （省不下多少，反而增加解码开销）。
function wantGzip(request, env) {
  try {
    if (env && String(env.PROXY_GZIP || '') === '1') return true;
    var h = request && request.headers;
    return !!(h && h.get && h.get('X-Gzip-Ok') === '1');
  } catch (e) { return false; }
}

async function maybeGzip(request, env, res) {
  if (!wantGzip(request, env)) return res;
  var ct = res.headers.get('Content-Type') || '';
  if (ct.indexOf('application/json') < 0) return res;
  if (res.headers.get('Content-Encoding')) return res;
  var buf = null;
  try { buf = await res.arrayBuffer(); } catch (e) { return res; }   // 读不出 ⇒ 原样（可能已被消费）
  // ⚠️ 读到 buf 后**原 res 的 body 已被消费**，任何"原样返回"都必须用 buf 重建
  var plain = function () { return new Response(buf, { status: res.status, headers: res.headers }); };
  if (buf.byteLength < 1024) return plain();
  try {
    var stream = new Response(buf).body.pipeThrough(new CompressionStream('gzip'));
    var h = new Headers(res.headers);
    h.set('Content-Encoding', 'gzip');
    h.set('Vary', 'X-Gzip-Ok');
    h.set('X-Proxy-Gzip', '1');     // 回执：便于验证「本条确实被压了」
    h.delete('Content-Length');     // 长度由运行时重算（分块传输）
    return new Response(stream, { status: res.status, headers: h });
  } catch (e) { return plain(); }
}

// 唯一出口：所有 adapter（Deno 默认导出 / Netlify Edge / node-server）都经此
// ⇒ gzip 是**单一 choke point**，天然覆盖 `/sb/*`、`/od/api/*`、`/healthz` 全部响应路径。
async function handle(request, env, ctx) {
  return await maybeGzip(request, env, await _handle(request, env, ctx));
}

// ─────────────────────────────────────────────────────────────────────────────
// ★★ 2026-10-29（B6）：**EF keep-warm**
//   实测：EF 空 action 冷启动首调 **33.18s**，热后 **1.5–3.8s**（Supabase 免费层 ~10min 无流量即缩容）。
//   做法：Deno Deploy 原生 `Deno.cron` **每 4 分钟**给 6 个只读 EF 各发一次空 `{}`（EF 在参数校验前
//   就已冷启动，所以"请求失败"也照样起到预热作用）。
//   ⚠️ 只在有 `Deno.cron` 的运行时注册（Deno Deploy）；本地 Node / Netlify Edge 自动跳过。
//   ⚠️ 单次给 45s：冷启动 33s 不能被 12s 超时打断（打断不影响服务端预热，但拿不到真实耗时）。
const KEEP_WARM_EFS = [
  'opendota-proxy', 'bundle-aggregator', 'steam-proxy',
  'stratz-proxy', 'haglund-proxy', 'liquipedia-proxy'
];
const KEEP_WARM_CRON = '*/4 * * * *';
const KEEP_WARM_TIMEOUT_MS = 45000;

function denoEnv() {
  var env = {};
  try {
    if (typeof Deno !== 'undefined' && Deno.env && Deno.env.get) {
      env = {
        SB_ANON_KEY: Deno.env.get('SB_ANON_KEY') || '',
        SUPABASE_REF: Deno.env.get('SUPABASE_REF') || undefined,
        PROXY_RATE_LIMIT_MAX: Deno.env.get('PROXY_RATE_LIMIT_MAX') || ''
      };
    }
  } catch (e) { /* 无 Deno ⇒ 空对象 */ }
  return env;
}

/** 逐个 ping 6 个只读 EF（单次、45s 上限）；返回每项 `{ef,status|error,ms}`。 */
async function keepWarmOnce(env) {
  const src = Object.assign({}, denoEnv(), env || {});
  const ref = src.SUPABASE_REF || DEFAULT_SUPABASE_REF;
  const key = src.SB_ANON_KEY || SB_ANON_KEY_FALLBACK;
  const headers = { 'Content-Type': 'application/json' };
  if (key) { headers.apikey = key; headers.Authorization = 'Bearer ' + key; }
  const results = await Promise.all(KEEP_WARM_EFS.map(async function (name) {
    const t0 = Date.now();
    try {
      const r = await fetchUpstream('https://' + ref + '.supabase.co/functions/v1/' + name,
        { method: 'POST', headers: headers, body: '{}' },
        'keep-warm/' + name, { attempts: 1, timeoutMs: KEEP_WARM_TIMEOUT_MS });
      try { if (r.body && r.body.cancel) await r.body.cancel(); } catch (e) { /* 不读响应体 */ }
      return { ef: name, status: r.status, ms: Date.now() - t0 };
    } catch (e) {
      return { ef: name, error: String((e && e.message) || e), ms: Date.now() - t0 };
    }
  }));
  const ok = results.filter(function (x) { return !x.error; }).length;
  const maxMs = results.reduce(function (a, x) { return Math.max(a, x.ms || 0); }, 0);
  console.log('[proxy] keep-warm ' + results.length + ' EFs → ' + ok + ' 通 / ' +
    (results.length - ok) + ' 异常，max ' + maxMs + 'ms');
  return results;
}

let KEEP_WARM_REGISTERED = false;
try {
  if (typeof Deno !== 'undefined' && typeof Deno.cron === 'function') {
    Deno.cron('ef-keep-warm', KEEP_WARM_CRON, function () { return keepWarmOnce(); });
    KEEP_WARM_REGISTERED = true;
  }
} catch (e) { KEEP_WARM_REGISTERED = false; }

export default {
  // ★★ 2026-10-13（P1-12 复核的连带修正）：**Deno Deploy 的第二个参数是 `connInfo`，不是 `env`**
  //   —— 这正是此前 `env.PROXY_RATE_LIMIT_MAX` 恒为 undefined、限流**想开也开不了**的原因；
  //   同时也解释了「Deno 那两台从未配过环境变量、`/healthz` 却一直 `hasKey:true`」：
  //   key 其实取自本文件顶部的 `SB_ANON_KEY_FALLBACK` 常量（`env.SB_ANON_KEY` 一直是 undefined）。
  //   ⇒ env 必须走 `Deno.env.get()`；客户端 IP 走 `connInfo.remoteAddr.hostname`。
  fetch(request, connInfo) {
    var env = denoEnv();
    var ip = '';
    try { ip = (connInfo && connInfo.remoteAddr && connInfo.remoteAddr.hostname) || ''; } catch (e) { ip = ''; }
    return handle(request, env, { ip: ip });
  }
};

// 供 Pages Functions / 本地测试复用
export { handle, EF_ALLOW, EF_CACHE, TTL, _cache, trimMatch, keepWarmOnce, KEEP_WARM_EFS };
