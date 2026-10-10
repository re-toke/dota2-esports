// infra/proxy/node-server.mjs
// ─────────────────────────────────────────────────────────────────────────────
// 「数据中转」· **普通服务器（Node 18+）版** —— 给"香港/境外轻量服务器"这条路用。
//   与 `worker.mjs` **共用同一套路由逻辑**（`handle()`），不重复实现。
//
// ## 用法
//   cd infra/proxy
//   SB_ANON_KEY='<真实 anon key>' PORT=8787 node node-server.mjs
//   # 生产建议用 systemd 常驻（见 DEPLOY.md），前面挂 Caddy 自动 HTTPS
//
// ## 为什么需要这个壳
//   `worker.mjs` 用的是 Web 标准（Request/Response/fetch）——CF Workers 原生支持；
//   Node 18+ 也有这些全局对象，但需要一个「Node 的 http 请求 ⇄ Web Request」的适配层。
//
// ## 安全
//   · 只监听你想要的地址（默认 127.0.0.1，由 Caddy/Nginx 反代对外）；
//   · key 只从环境变量读，**不打印**；
//   · 不设 CORS 白名单（只读代理，见 worker.mjs 的 CORS）。
// ─────────────────────────────────────────────────────────────────────────────

import http from 'node:http';
import { handle } from './worker.mjs';

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';          // ★ 默认只听本机，由反代对外
const ENV = {
  SB_ANON_KEY: process.env.SB_ANON_KEY || '',
  SUPABASE_REF: process.env.SUPABASE_REF || undefined,
  LP_UA: process.env.LP_UA || undefined
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const t0 = Date.now();
  try {
    const host = req.headers.host || ('127.0.0.1:' + PORT);
    const isBodyless = (req.method === 'GET' || req.method === 'HEAD');
    const body = isBodyless ? undefined : await readBody(req);
    // 转成 Web Request（Node 18+ 的 undici 提供 Request/Response）
    const request = new Request('http://' + host + req.url, {
      method: req.method,
      headers: req.headers,
      body: (body && body.length) ? body : undefined,
      duplex: 'half'
    });
    const response = await handle(request, ENV);
    const headers = {};
    response.headers.forEach((v, k) => { headers[k] = v; });
    res.writeHead(response.status, headers);
    const buf = Buffer.from(await response.arrayBuffer());
    res.end(buf);
    console.log('[node-proxy] ' + req.method + ' ' + req.url + ' → ' + response.status + ' ' + (Date.now() - t0) + 'ms');
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'proxy crashed', detail: String((e && e.message) || e) }));
    console.error('[node-proxy] 异常: ' + ((e && e.stack) || e));
  }
});

server.listen(PORT, HOST, () => {
  console.log('[node-proxy] 监听 http://' + HOST + ':' + PORT);
  console.log('[node-proxy] SB_ANON_KEY ' + (ENV.SB_ANON_KEY ? '已配置 ✓' : '【未配置】—— /healthz 的 hasKey 会是 false'));
  console.log('[node-proxy] 自检：curl http://' + HOST + ':' + PORT + '/healthz');
});
