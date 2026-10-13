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
  'wechat-auth', 'subscribe-send', 'follow-profile'
]);

// GET 短路缓存时长（ms）
// ★ 约束：**必须 ≤ 客户端对该接口的轮询间隔**，否则会把"实时"数据缓存成过期数据
//   —— 客户端对 `/live` 是 **30s 轮询**（直播态）⇒ 这里给 20s（宁可多打一次上游，也不让用户看到旧比分）
const TTL = { proMatches: 60e3, live: 20e3, leagues: 30 * 60e3, 'default': 120e3 };

// ★★ 2026-10-10（详情页"慢"的修法）：**EF 路径的白名单式短缓存**（只缓只读、低频变化的 action）
//   背景（实测）：`bundle-aggregator/getLeagueDetailBundle` 单次 **3.8s**（云端含 OD 现抓 + explorer），
//   而真机详情页 `od+lp 并行段 4645ms`、首次可见 ~2.8s / 全量 ~4.7s。
//   ⇒ 对白名单内的 (EF, action) 缓存 60s ⇒ **同一赛事的重复访问 / 多用户共享**都能直接命中。
//   ⚠️ **只对白名单生效（默认不缓）** ⇒ 不会误缓写类/鉴权类 EF（如 `wechat-auth`/`subscribe-send`）。
//   ⚠️ TTL 取 60s 的依据：bundle 是"赛事详情里变化很慢的部分"（对阵/参赛队/排名），
//      比分另有 `/live` 与 `getLeagueMatches` 路径 ⇒ 60s 陈旧度安全。
const EF_CACHE_MS = {
  'bundle-aggregator|getLeagueDetailBundle': 60e3
};

const UPSTREAM_TIMEOUT_MS = 12000;
const RETRY_ON = (status) => status >= 500;

const CORS = {
  'Access-Control-Allow-Origin': '*',            // 只读代理、不带凭据 ⇒ 放开便于浏览器自测
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,apikey,Prefer,Range,X-Trim',
  'Access-Control-Expose-Headers': 'Content-Range, X-Proxy-Cache, X-Proxy-Trim'
};

// 模块级短路缓存（isolate 内有效）
const _cache = new Map();          // key -> { exp, body, status, ct, cr }

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
  if (s.indexOf(':') >= 0) return s.split(':').slice(0, 3).join(':') + '::x';
  var p = s.split('.');
  return p.length === 4 ? p[0] + '.' + p[1] + '.' + p[2] + '.x' : s;
}

function rateLimited(request, env, ctx, now) {
  const max = parseInt((env && env.PROXY_RATE_LIMIT_MAX) || '0', 10) || 0;
  if (max <= 0) return false;                       // 未启用（默认）
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

/** 带超时 + 1 次重试的上游请求（仅 5xx/网络异常重试） */
async function fetchUpstream(url, init, label) {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT_MS);
    const t0 = Date.now();
    try {
      const r = await fetch(url, Object.assign({}, init, { signal: ac.signal }));
      clearTimeout(timer);
      const ms = Date.now() - t0;
      if (attempt === 0 && RETRY_ON(r.status)) {
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
    const base = {
      ok: true, ts: new Date().toISOString(),
      hasKey: !!sbKey, ref: ref,
      routes: ['/sb/functions/v1/*', '/sb/rest/v1/*', '/od/api/*'],
      ipSource: _ci.source, ipMasked: maskIp(_ci.ip)
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
      // ★★（详情页"慢"的修法）白名单式 EF 短缓存：只对 EF_CACHE_MS 里登记的 (EF, action) 生效
      let efAction = '';
      try { efAction = (JSON.parse(rawBody || '{}') || {}).action || ''; } catch (e) { efAction = ''; }
      const efTtl = EF_CACHE_MS[m[1] + '|' + efAction];
      let efKey = null;
      if (efTtl) {
        let efParams = '';
        try { efParams = JSON.stringify((JSON.parse(rawBody || '{}') || {}).params || {}); } catch (e) { efParams = ''; }
        efKey = 'ef|' + m[1] + '|' + efAction + '|' + efParams;
        const hit = _cache.get(efKey);
        if (hit && hit.exp > Date.now()) {
          console.log('[proxy] EF ' + m[1] + '/' + efAction + ' → 缓存命中');
          return textResponse(hit.body, hit.status, 'application/json', null, 'HIT');
        }
      }
      const r = await fetchUpstream('https://' + ref + '.supabase.co/functions/v1/' + m[1], {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, sbHeaders),
        body: rawBody
      }, 'EF ' + m[1] + (efAction ? '/' + efAction : ''));
      if (efKey && r.ok) {
        // 只缓存成功响应；读一次 body 再回放（避免把 Response 消费掉）
        const body = await r.text();
        _cache.set(efKey, { exp: Date.now() + efTtl, body: body, status: r.status, ct: 'application/json', cr: null });
        return textResponse(body, r.status, 'application/json', null, 'MISS');
      }
      return forward(r);
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
      const r = await fetchUpstream('https://' + ref + '.supabase.co/rest/v1/' + m[1] + (url.search || ''),
        { method: 'GET', headers: headers }, 'REST ' + m[1]);
      const body = await r.text();
      const ct = r.headers.get('content-type') || 'application/json';
      const cr = r.headers.get('content-range');
      if (r.ok) _cache.set(ck, { exp: Date.now() + TTL['default'], body: body, status: r.status, ct: ct, cr: cr });
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
      const effTrim = ti.n > 0 ? ti.n
        : (isTeamMatches && !ti.declared && !vs ? DEFAULT_TEAM_TRIM : 0);
      const ck = 'od|' + rest + (url.search || '') + '|t' + effTrim;
      const ttl = TTL[rest] || TTL['default'];
      const hit = _cache.get(ck);
      if (hit && hit.exp > Date.now()) {
        console.log('[proxy] OD ' + rest + ' → 缓存命中');
        return textResponse(hit.body, hit.status, 'application/json', null, 'HIT');
      }
      const r = await fetchUpstream('https://api.opendota.com/api/' + rest + (url.search || ''),
        { method: 'GET', headers: { 'Accept-Encoding': 'gzip' } }, 'OD ' + rest);

      // `/leagues` 轻量裁剪：丢 tier=excluded（形状不变）
      if (rest === 'leagues' && r.ok) {
        let data = null;
        try { data = await r.json(); } catch (e) { data = null; }
        if (Array.isArray(data)) {
          const kept = data.filter((x) => !x || x.tier !== 'excluded');
          const body = JSON.stringify({ kept: kept.length, dropped: data.length - kept.length, data: kept });
          _cache.set(ck, { exp: Date.now() + ttl, body: body, status: 200, ct: 'application/json', cr: null });
          return textResponse(body, 200, 'application/json', null, 'MISS');
        }
        return forward(r);   // 非数组（异常响应）⇒ 原样透传，别自作主张
      }

      // ★★ 2026-10-10（问题A 修法①·按需裁剪）／2026-10-12（P0-1 B′ + C）
      //   背景：实测 `/teams/<id>/matches` **480KB**，远超上游 12s 口径 ⇒ 全量易超时。
      //   ★ P0-1 B′：`?vs=<id>` ⇒ 端点级「双方交锋」过滤（全历史 A∩B，语义精确、payload 极小）。
      //   ★ P0-1 C：未声明（无 `recent`/`X-Trim`）且非 `vs` ⇒ **默认裁 DEFAULT_TEAM_TRIM(300)** 兜底；
      //     需要全量的调用（team-detail 后台补全量）用 `X-Trim: 0` **显式豁免**（`trimInfo.declared`）。
      if (isTeamMatches && r.ok && (effTrim > 0 || vs)) {
        let data = null;
        try { data = await r.json(); } catch (e) { data = null; }
        if (Array.isArray(data)) {
          let kept = data;
          let receipt = '';
          if (vs) {
            // ★ P0-1 B′（2026-10-12）：只回 `opposing_team_id === vs` 的对局 = **全历史 A∩B**（语义精确，
            //   不受客户端 recent 窗口限制）。客户端仍保留同条件过滤 ⇒ **中转未部署新版（忽略 vs）也零回归**。
            kept = data.filter((x) => x && String(x.opposing_team_id) === vs);
            receipt = 'vs:' + kept.length;
          } else {
            // OpenDota 该端点按时间倒序 ⇒ 取**前 N 条 = 最近 N 场**（不改字段、不改形状）
            kept = data.slice(0, effTrim);
            receipt = 'recent:' + kept.length;
          }
          const body = JSON.stringify(kept);
          _cache.set(ck, { exp: Date.now() + ttl, body: body, status: 200, ct: 'application/json', cr: null });
          console.log('[proxy] OD ' + rest + ' → ' + receipt + '（原 ' +
            Math.round(JSON.stringify(data).length / 1024) + 'KB）');
          return textResponse(body, 200, 'application/json', null, 'MISS', { 'X-Proxy-Trim': receipt });
        }
        return forward(r);
      }

      const body = await r.text();
      const ct = r.headers.get('content-type') || 'application/json';
      if (r.ok) _cache.set(ck, { exp: Date.now() + ttl, body: body, status: r.status, ct: ct, cr: null });
      return textResponse(body, r.status, ct, null, 'MISS');
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

export default {
  // ★★ 2026-10-13（P1-12 复核的连带修正）：**Deno Deploy 的第二个参数是 `connInfo`，不是 `env`**
  //   —— 这正是此前 `env.PROXY_RATE_LIMIT_MAX` 恒为 undefined、限流**想开也开不了**的原因；
  //   同时也解释了「Deno 那两台从未配过环境变量、`/healthz` 却一直 `hasKey:true`」：
  //   key 其实取自本文件顶部的 `SB_ANON_KEY_FALLBACK` 常量（`env.SB_ANON_KEY` 一直是 undefined）。
  //   ⇒ env 必须走 `Deno.env.get()`；客户端 IP 走 `connInfo.remoteAddr.hostname`。
  fetch(request, connInfo) {
    var env = {};
    try {
      if (typeof Deno !== 'undefined' && Deno.env && Deno.env.get) {
        env = {
          SB_ANON_KEY: Deno.env.get('SB_ANON_KEY') || '',
          SUPABASE_REF: Deno.env.get('SUPABASE_REF') || undefined,
          PROXY_RATE_LIMIT_MAX: Deno.env.get('PROXY_RATE_LIMIT_MAX') || ''
        };
      }
    } catch (e) { /* 无 Deno 环境 ⇒ 走下面的常量回落 */ }
    var ip = '';
    try { ip = (connInfo && connInfo.remoteAddr && connInfo.remoteAddr.hostname) || ''; } catch (e) { ip = ''; }
    return handle(request, env, { ip: ip });
  }
};

// 供 Pages Functions / 本地测试复用
export { handle, EF_ALLOW, TTL };
