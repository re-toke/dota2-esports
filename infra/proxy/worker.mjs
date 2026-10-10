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

const UPSTREAM_TIMEOUT_MS = 12000;
const RETRY_ON = (status) => status >= 500;

const CORS = {
  'Access-Control-Allow-Origin': '*',            // 只读代理、不带凭据 ⇒ 放开便于浏览器自测
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,apikey,Prefer,Range,X-Trim',
  'Access-Control-Expose-Headers': 'Content-Range'
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

/**
 * 「按需裁剪」条数：`?recent=N` 或请求头 `X-Trim: N`，两者取其一（**默认 0 = 不裁**）。
 * ★ 设计取舍：**默认不裁 ⇒ 零回归**。只有显式声明"只要近期"的调用才裁
 *   （由 `infra/proxy/DEPLOY.md` 与问题A复核意见记录：team-detail/h2h 需要全量，不能裁）。
 * 上限 500，避免被传巨大值当"绕过"。
 */
function trimOf(request, url) {
  let raw = url.searchParams.get('recent');
  if (!raw) { try { raw = request.headers.get('X-Trim'); } catch (e) { raw = null; } }
  const n = parseInt(raw, 10);
  if (!isFinite(n) || n <= 0) return 0;
  return Math.min(n, 500);
}

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

function textResponse(body, status, ct, cr, cacheState) {
  const h = Object.assign({}, CORS, { 'Content-Type': ct || 'application/json' });
  if (cr) h['Content-Range'] = cr;
  if (cacheState) h['X-Proxy-Cache'] = cacheState;
  return new Response(body, { status: status, headers: new Headers(h) });
}

async function handle(request, env) {
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
    const base = {
      ok: true, ts: new Date().toISOString(),
      hasKey: !!sbKey, ref: ref,
      routes: ['/sb/functions/v1/*', '/sb/rest/v1/*', '/od/api/*']
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
    // ─────────────── ① Supabase Edge Function：/sb/functions/v1/<name> ───────────────
    let m = /^\/sb\/functions\/v1\/([A-Za-z0-9_-]+)\/?$/.exec(path);
    if (m) {
      if (!EF_ALLOW.has(m[1])) return json({ error: 'ef not allowed', name: m[1] }, 404);
      const r = await fetchUpstream('https://' + ref + '.supabase.co/functions/v1/' + m[1], {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, sbHeaders),
        body: method === 'POST' ? await request.text() : '{}'
      }, 'EF ' + m[1]);
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

      const ck = 'od|' + rest + (url.search || '') + '|t' + trimOf(request, url);
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

      // ★★ 2026-10-10（问题A 修法①·按需裁剪，**默认不裁 ⇒ 零回归**）
      //   背景：实测 `/teams/<id>/matches` **480KB / 21~37s**，远超客户端 12s 口径 ⇒ 必超时。
      //   但**不能无差别裁**：`subpackages/detail/team-detail` 用它算 `totalMatches` + 分页翻页，
      //   `subpackages/detail/h2h` 用它按对手过滤算**历史交锋** ⇒ 裁了会漏数据。
      //   ⇒ 只对**显式声明"只要近期"**的调用裁剪：`?recent=N` 或请求头 `X-Trim: N`。
      //   （关注流/赛事页只需近期 ⇒ 可安全带此标记；team-detail/h2h 不带 ⇒ 拿全量 ✓）
      const trim = trimOf(request, url);
      const isTeamMatches = /^teams\/[^\/]+\/matches$/.test(rest);
      if (isTeamMatches && trim > 0 && r.ok) {
        let data = null;
        try { data = await r.json(); } catch (e) { data = null; }
        if (Array.isArray(data)) {
          // OpenDota 该端点按时间倒序 ⇒ 取**前 N 条 = 最近 N 场**（不改字段、不改形状）
          const kept = data.slice(0, trim);
          const body = JSON.stringify(kept);
          _cache.set(ck, { exp: Date.now() + ttl, body: body, status: 200, ct: 'application/json', cr: null });
          console.log('[proxy] OD ' + rest + ' → 裁剪 ' + data.length + '→' + kept.length + ' 场（原 ' +
            Math.round(JSON.stringify(data).length / 1024) + 'KB）');
          return textResponse(body, 200, 'application/json', null, 'MISS');
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

export default {
  fetch(request, env) { return handle(request, env); }
};

// 供 Pages Functions / 本地测试复用
export { handle, EF_ALLOW, TTL };
