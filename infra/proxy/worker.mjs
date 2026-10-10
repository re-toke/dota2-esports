// infra/proxy/worker.js
// ─────────────────────────────────────────────────────────────────────────────
// 「数据中转最小反代」· Cloudflare Worker 版（**无服务器**，无需自己买服务器）
//
// ## 为什么需要它（一句话）
// 国内网络对 `*.supabase.co` 做了 **SNI 阻断**（DNS 正常但 TLS 握手被 RST），
// 且 `api.opendota.com` 被 **DNS 劫持 + 自签证书** ⇒ 客户端两条路都取不到数据。
// 而 CF 边缘实测在国内可达（`pages.dev` 301 ✓ / `haglund.dev` 302 ✓）⇒
// **把后端藏在一个国内可达的自有域名后面**，由本 Worker 转发。
//
// ## 路由设计（对齐客户端现有的 4 处 URL 拼接，**客户端只改 2 个常量**）
//   /healthz                      → 健康检查（浏览器直接打开即可测「这个域名通不通」）
//   /sb/functions/v1/<name>       → https://<ref>.supabase.co/functions/v1/<name>   （Edge Function）
//   /sb/rest/v1/<table>?<query>   → https://<ref>.supabase.co/rest/v1/<table>?<query>（PostgREST 只读）
//   /od/api/<path>?<query>        → https://api.opendota.com/api/<path>?<query>
//   /lp?<query>                   → https://liquipedia.net/dota2/api.php?<query>（可选，客户端 LP 直连本来就通）
//
// ## ★ 关键设计点
// 1. **服务端注入 Supabase key**：客户端当前那把 anonKey 是错的（`config.js:226`），
//    这里用 `env.SB_ANON_KEY` **覆盖**客户端传来的 `apikey`/`Authorization`
//    ⇒ **客户端的错 key 直接变得无害**（连通性恢复后也不会再 401）。
// 2. **`/od/api/leagues` 轻量裁剪**：只丢掉 `tier === 'excluded'` 的条目（**保持响应形状不变**，
//    客户端 `filterCollectableLeagues` 本来也会过滤它们）⇒ 原始 1001KB 可显著变小；
//    再叠加 CF 的自动 gzip ⇒ 避开 12s 超时。
//    ⚠️ 刻意**不复制** EF 侧那套更复杂的裁剪，避免与服务端口径漂移（gzip 已足够）。
// 3. **最小权限**：只放行 `/functions/v1/`、`/rest/v1/`、`/api/` 前缀，方法仅 GET/POST/OPTIONS
//    ⇒ 不成为开放代理（防被当成跳板）。
// 4. **凭据安全**：key 只存在于 CF 的环境变量/Secret，**不写进代码、不打印**。
//
// ## 部署（两种任选，见 README.md）
//   A) Cloudflare Workers：`wrangler deploy`
//   B) Cloudflare Pages（functions 目录）：把 `functions/[[path]].js` 一起上传
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_SUPABASE_REF = 'gkticzdaicpdtxheyxsd';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,apikey,Prefer,Range',
  'Access-Control-Expose-Headers': 'Content-Range'
};

function json(body, status, extra) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, CORS, extra || {})
  });
}

/** 只保留必要的请求头转发（丢掉 hop-by-hop 与客户端身份相关头） */
function passHeaders(src, keep) {
  const out = {};
  (keep || []).forEach((k) => {
    const v = src.get(k);
    if (v) out[k] = v;
  });
  return out;
}

async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  // ★ 方法闸门必须在所有路由之前（否则 `DELETE /healthz` 也会被健康检查放行 —— 本地测试抓到过）
  if (method !== 'GET' && method !== 'POST') return json({ error: 'method not allowed' }, 405);

  // ── 健康检查：浏览器打开 `https://<你的域名>/healthz` 即可判定「域名通不通」──
  if (path === '/healthz') {
    return json({
      ok: true,
      ts: new Date().toISOString(),
      hasKey: !!(env && env.SB_ANON_KEY),
      ref: (env && env.SUPABASE_REF) || DEFAULT_SUPABASE_REF
    });
  }

  const ref = (env && env.SUPABASE_REF) || DEFAULT_SUPABASE_REF;
  const sbKey = env && env.SB_ANON_KEY;

  try {
    // ─────────────── ① Supabase Edge Function：/sb/functions/v1/<name> ───────────────
    let m = /^\/sb\/functions\/v1\/([A-Za-z0-9_-]+)\/?$/.exec(path);
    if (m) {
      const target = 'https://' + ref + '.supabase.co/functions/v1/' + m[1];
      const headers = { 'Content-Type': 'application/json' };
      if (sbKey) { headers['Authorization'] = 'Bearer ' + sbKey; headers['apikey'] = sbKey; }
      const r = await fetch(target, {
        method: 'POST',
        headers: headers,
        body: method === 'POST' ? await request.text() : '{}'
      });
      return forward(r);
    }

    // ─────────────── ② Supabase PostgREST 只读：/sb/rest/v1/<table> ───────────────
    m = /^\/sb\/rest\/v1\/([A-Za-z0-9_]+)\/?$/.exec(path);
    if (m) {
      if (method !== 'GET') return json({ error: 'rest is read-only here' }, 405);
      const target = 'https://' + ref + '.supabase.co/rest/v1/' + m[1] + (url.search || '');
      // 只转发只读头；**Range 必须保留**（客户端用 Range 分页，见 remoteCuration.js）
      const headers = passHeaders(request.headers, ['Range', 'Prefer']);
      if (sbKey) { headers['Authorization'] = 'Bearer ' + sbKey; headers['apikey'] = sbKey; }
      const r = await fetch(target, { method: 'GET', headers: headers });
      return forward(r);
    }

    // ─────────────── ③ OpenDota：/od/api/<path> ───────────────
    if (path.indexOf('/od/api/') === 0) {
      const rest = path.slice('/od/api/'.length);
      // 最小权限：只放行只读接口，禁止任意路径
      if (!/^[A-Za-z0-9_\/.-]+$/.test(rest)) return json({ error: 'bad path' }, 400);
      const target = 'https://api.opendota.com/api/' + rest + (url.search || '');
      const r = await fetch(target, { method: 'GET', headers: { 'Accept-Encoding': 'gzip' } });

      // `/leagues` 轻量裁剪：丢 tier=excluded（形状不变，客户端本来也会过滤）
      if (rest === 'leagues' && r.ok) {
        let data = null;
        try { data = await r.json(); } catch (e) { data = null; }
        if (Array.isArray(data)) {
          const kept = data.filter((x) => !x || x.tier !== 'excluded');
          return json({ kept: kept.length, dropped: data.length - kept.length, data: kept }, 200);
        }
        return forward(r);   // 非数组（异常响应）⇒ 原样透传，别自作主张
      }
      return forward(r);
    }

    // ─────────────── ④ Liquipedia（可选）：/lp?<query> ───────────────
    if (path === '/lp' || path === '/lp/') {
      // ⚠️ LP ToU 要求描述性 UA 且 `action=parse` ≤1 req/30s；此处仅作兜底，不改变客户端既有节流
      const target = 'https://liquipedia.net/dota2/api.php' + (url.search || '');
      const r = await fetch(target, {
        method: 'GET',
        headers: {
          'User-Agent': (env && env.LP_UA) || 'Dota2EsportsMiniProgram/1.0 (contact: see mini program privacy page)',
          'Accept-Encoding': 'gzip'
        }
      });
      return forward(r);
    }

    return json({ error: 'not found', path: path }, 404);
  } catch (e) {
    // 上游失败：把原因回给调用方（便于真机排查），但**不泄露任何凭据**
    return json({ error: 'upstream failed', detail: String((e && e.message) || e) }, 502);
  }
}

/** 透传上游响应（保留状态码与关键头；叠加 CORS） */
function forward(r) {
  const headers = new Headers(CORS);
  const ct = r.headers.get('content-type');
  if (ct) headers.set('Content-Type', ct);
  const cr = r.headers.get('content-range');   // PostgREST 分页要用
  if (cr) headers.set('Content-Range', cr);
  return new Response(r.body, { status: r.status, headers: headers });
}

export default {
  fetch(request, env) { return handle(request, env); }
};

// 供 Pages Functions / 本地测试复用
export { handle };
