// infra/proxy/test.mjs —— 本地验证中转路由（不需要部署、不需要网络）
//   做法：mock 全局 fetch（拦截上游请求），把 worker 的 handle() 当成纯函数调用，
//   逐条断言：① 路由命中 ② **服务端确实覆盖了客户端的错 key** ③ /leagues 裁剪 ④ 最小权限/健康检查
// 运行：node infra/proxy/test.mjs
import { handle, EF_ALLOW, TTL } from './worker.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + '  -> ' + (detail || '')); }
};

const REAL_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.FAKE_REAL_KEY_FOR_TEST';
const BAD_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdrdGljemRhaWNwZHR4aGV5eHNkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg0OTI4NTIsImV4cCI6MjEwNDA2ODg1Mn0.ZzdBSKZskLI-GO-Tz3BsviNg_qNL8OhC1WV9jTJkAe8';          // 客户端里那把**错**key（现状）
const ENV = { SB_ANON_KEY: REAL_KEY, SUPABASE_REF: 'gkticzdaicpdtxheyxsd' };

const calls = [];
globalThis.fetch = async (target, init) => {
  const h = (init && init.headers) || {};
  calls.push({ url: String(target), method: (init && init.method) || 'GET', headers: h, body: init && init.body });
  // 按上游类型返回可辨识的响应
  if (String(target).indexOf('api.opendota.com/api/leagues') >= 0) {
    return new Response(JSON.stringify([
      { leagueid: 1, tier: 'premium' }, { leagueid: 2, tier: 'excluded' }, { leagueid: 3, tier: 'professional' }
    ]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (String(target).indexOf('/rest/v1/') >= 0) {
    return new Response('[{"canonical_key":"X"}]', { status: 200, headers: { 'Content-Type': 'application/json', 'Content-Range': '0-0/1' } });
  }
  if (String(target).indexOf('/functions/v1/') >= 0) {
    return new Response('{"data":{"ok":true},"source":"ef"}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
};

const req = (path, opts) => new Request('https://proxy.example.com' + path, opts || {});
const textOf = async (r) => { try { return await r.clone().text(); } catch (e) { return ''; } };

// ── ① 健康检查 ───────────────────────────────────────────────────────────────
{
  const r = await handle(req('/healthz'), ENV);
  const b = JSON.parse(await textOf(r));
  ok('健康检查返回 200 + ok:true', r.status === 200 && b.ok === true, JSON.stringify(b));
  ok('健康检查报出「key 已配置」', b.hasKey === true, JSON.stringify(b));
  ok('健康检查带 CORS（可在浏览器直接打开）', r.headers.get('Access-Control-Allow-Origin') === '*');
}
{
  const r = await handle(req('/healthz'), {});   // 未配 key 的环境
  const b = JSON.parse(await textOf(r));
  ok('未配置 key 时 hasKey=false（部署自检用）', b.hasKey === false, JSON.stringify(b));
}

// ── ② EF 路由 + ★ 服务端覆盖错 key ───────────────────────────────────────────
{
  calls.length = 0;
  const r = await handle(req('/sb/functions/v1/opendota-proxy', {
    method: 'POST', body: '{"action":"getProMatches","params":{}}',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + BAD_KEY, 'apikey': BAD_KEY }
  }), ENV);
  const c = calls[0];
  ok('EF 路由命中并转发到 <ref>.supabase.co/functions/v1/opendota-proxy',
    c && c.url === 'https://gkticzdaicpdtxheyxsd.supabase.co/functions/v1/opendota-proxy', c && c.url);
  ok('★ 服务端用真 key **覆盖**了客户端传来的错 key', c.headers['Authorization'] === 'Bearer ' + REAL_KEY, c.headers['Authorization']);
  ok('★ 错 key 没有被透传给上游（apikey 也是真 key）', c.headers['apikey'] === REAL_KEY, c.headers['apikey']);
  ok('请求体被原样转发', c.body === '{"action":"getProMatches","params":{}}', c.body);
  ok('EF 响应透传（含 EF 的 {data,source} 形状）', (await textOf(r)).indexOf('"source":"ef"') >= 0);
}

// ── ③ PostgREST 路由（只读 + 保留 Range + 覆盖 key） ──────────────────────────
{
  calls.length = 0;
  const r = await handle(req('/sb/rest/v1/curation_events?select=canonical_key,data', {
    headers: { 'Range': '0-399', 'apikey': BAD_KEY, 'Authorization': 'Bearer ' + BAD_KEY }
  }), ENV);
  const c = calls[0];
  ok('REST 路由命中并保留 query', c && c.url.indexOf('/rest/v1/curation_events?select=canonical_key,data') >= 0, c && c.url);
  ok('★ Range 头被保留（客户端分页依赖它）', c.headers['Range'] === '0-399', c.headers['Range']);
  ok('★ REST 也用真 key 覆盖', c.headers['apikey'] === REAL_KEY, c.headers['apikey']);
  ok('Content-Range 被透传（分页游标）', r.headers.get('Content-Range') === '0-0/1', r.headers.get('Content-Range'));
}
{
  const r = await handle(req('/sb/rest/v1/curation_events', { method: 'POST', body: '{}' }), ENV);
  ok('REST 拒绝写操作（最小权限，405）', r.status === 405, String(r.status));
}

// ── ④ OpenDota 路由 + /leagues 裁剪 ─────────────────────────────────────────
{
  calls.length = 0;
  const r = await handle(req('/od/api/proMatches'), ENV);
  ok('OpenDota 路由命中 /api/proMatches',
    calls[0] && calls[0].url === 'https://api.opendota.com/api/proMatches', calls[0] && calls[0].url);
}
{
  calls.length = 0;
  const r = await handle(req('/od/api/leagues'), ENV);
  const b = JSON.parse(await textOf(r));
  ok('★ /leagues 裁剪：丢掉 tier=excluded', b.data && b.data.length === 2 && b.dropped === 1, JSON.stringify(b));
  ok('★ 裁剪后**形状不变**（仍是数组元素结构，客户端可原样消费）', Array.isArray(b.data) && b.data[0].leagueid === 1);
}
{
  calls.length = 0;
  const r = await handle(req('/od/api/explorer?sql=select%201'), ENV);
  ok('OpenDota 带查询参数被保留',
    calls[0] && calls[0].url === 'https://api.opendota.com/api/explorer?sql=select%201', calls[0] && calls[0].url);
}

// ── ⑤ 最小权限 / 边界 ────────────────────────────────────────────────────────
{
  const r = await handle(req('/od/api/../../etc/passwd'), ENV);
  ok('非法路径被拒（400/404，不做开放代理）', r.status === 400 || r.status === 404, String(r.status));
}
{
  const r = await handle(req('/sb/functions/v1/../../x'), ENV);
  ok('EF 路径不允许穿越（404）', r.status === 404, String(r.status));
}
{
  const r = await handle(req('/unknown'), ENV);
  ok('未知路径 404', r.status === 404, String(r.status));
}
{
  const r = await handle(req('/healthz', { method: 'DELETE' }), ENV);
  ok('只允许 GET/POST（其余 405）', r.status === 405, String(r.status));
}

// ── ⑥ 上游失败时给出可排查信息 ────────────────────────────────────────────────
{
  const saved = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('ECONNRESET'); };
  // ⚠️ 必须用**未被前面测试缓存过的 URL**（v2 加了短路缓存 ⇒ 复用同一 URL 会命中缓存、绕过上游）
  const r = await handle(req('/od/api/proMatches?case=upstreamfail'), ENV);
  const b = JSON.parse(await textOf(r));
  ok('上游失败 → 502 且带 detail（真机可据此排查）', r.status === 502 && String(b.detail).indexOf('ECONNRESET') >= 0, JSON.stringify(b));
  ok('失败信息不含任何凭据', JSON.stringify(b).indexOf(REAL_KEY) < 0);
  globalThis.fetch = saved;
}

// ── ⑦ v2 优化项：EF 白名单 / 超时重试 / 短路缓存 / deep 自检 ──────────────────
{
  // EF 白名单：名单内放行
  calls.length = 0;
  await handle(req('/sb/functions/v1/opendota-proxy', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } }), ENV);
  ok('v2 EF 白名单：允许名单内的 opendota-proxy', calls.length === 1, String(calls.length));

  // EF 白名单：名单外拒绝，且**不打上游**
  calls.length = 0;
  const rDeny = await handle(req('/sb/functions/v1/evil-func', { method: 'POST', body: '{}' }), ENV);
  ok('★ v2 EF 白名单：拒绝未登记函数（404 且零上游请求）',
    rDeny.status === 404 && calls.length === 0, rDeny.status + ' / calls=' + calls.length);

  // 5xx ⇒ 重试一次（共 2 次上游调用），最终原样透传 503
  const saved = globalThis.fetch;
  let n5 = 0;
  globalThis.fetch = async () => { n5++; return new Response('boom', { status: 503, headers: { 'Content-Type': 'text/plain' } }); };
  const r5xx = await handle(req('/od/api/proMatches?case=5xx'), ENV);
  ok('★ v2 上游 5xx ⇒ 重试一次（上游被调用 2 次）', n5 === 2, String(n5));
  ok('v2 重试后仍 5xx ⇒ 原样透传 503', r5xx.status === 503, String(r5xx.status));

  // 网络异常 ⇒ 也重试一次，最终 502 + detail
  let nErr = 0;
  globalThis.fetch = async () => { nErr++; throw new Error('ECONNRESET'); };
  const rErr = await handle(req('/od/api/proMatches?case=neterr'), ENV);
  const bErr = JSON.parse(await textOf(rErr));
  ok('★ v2 网络异常也重试一次（共 2 次）', nErr === 2, String(nErr));
  ok('v2 两次都失败 ⇒ 502 且带 detail', rErr.status === 502 && String(bErr.detail).indexOf('ECONNRESET') >= 0, JSON.stringify(bErr));
  globalThis.fetch = saved;

  // 短路缓存：同一 URL 二次请求应为 HIT 且不再打上游
  calls.length = 0;
  const u = '/od/api/heroStats?case=cache';
  const a1 = await handle(req(u), ENV);
  const n1 = calls.length;
  const a2 = await handle(req(u), ENV);
  ok('★ v2 短路缓存：首次 MISS', a1.headers.get('X-Proxy-Cache') === 'MISS', String(a1.headers.get('X-Proxy-Cache')));
  ok('★ v2 短路缓存：二次 HIT 且不再打上游',
    a2.headers.get('X-Proxy-Cache') === 'HIT' && calls.length === n1,
    a2.headers.get('X-Proxy-Cache') + ' / calls=' + calls.length + '（首次 ' + n1 + '）');

  // /healthz?deep=1 逐段自检
  const rd = await handle(req('/healthz?deep=1'), ENV);
  const bd = JSON.parse(await textOf(rd));
  ok('★ v2 /healthz?deep=1 逐段报告 supabase 与 opendota',
    !!(bd.deep && bd.deep.supabase && bd.deep.opendota), JSON.stringify(bd.deep));
  ok('v2 deep：supabase 判为可达', bd.deep.supabase.reachable === true, JSON.stringify(bd.deep.supabase));
  ok('v2 deep：opendota 判为可达', bd.deep.opendota.reachable === true, JSON.stringify(bd.deep.opendota));
  ok('v2 deep 响应不含凭据', JSON.stringify(bd).indexOf(REAL_KEY) < 0);
}

// ── ⑧ 不变量守卫（把"设计约束"写成断言，防后人改坏） ─────────────────────────
{
  // ★ 约束：代理缓存时长必须 ≤ 客户端对该接口的轮询间隔，否则会把"实时"数据缓存成过期数据。
  //   客户端对 `/live` 是 30s 轮询（直播态）⇒ TTL 必须 < 30s。
  const CLIENT_LIVE_POLL_MS = 30000;
  ok('★ 不变量：/live 的代理缓存 TTL 必须 < 客户端 30s 轮询间隔',
    TTL.live < CLIENT_LIVE_POLL_MS, 'TTL.live=' + TTL.live + 'ms');
  ok('★ 不变量：所有 TTL 必须为正且有限',
    Object.keys(TTL).every((k) => Number.isFinite(TTL[k]) && TTL[k] > 0), JSON.stringify(TTL));
  // EF 白名单必须覆盖客户端真实会调的 9 个（名单漂移会让功能静默失效）
  const REQUIRED_EF = ['opendota-proxy', 'liquipedia-proxy', 'steam-proxy', 'stratz-proxy', 'haglund-proxy',
    'bundle-aggregator', 'wechat-auth', 'subscribe-send', 'follow-profile'];
  const missing = REQUIRED_EF.filter((n) => !EF_ALLOW.has(n));
  ok('★ 不变量：EF 白名单覆盖客户端会调的全部 9 个 EF', missing.length === 0, '缺: ' + missing.join(','));
}

// ── ⑨ v3 新增：`/od/api/teams/<id>/matches` 的**按需裁剪**（默认不裁） ──────
{
  const saved = globalThis.fetch;
  const many = [];
  for (let i = 0; i < 120; i++) many.push({ match_id: 900000 + i, leagueid: 19102, n: i });
  let upstream = 0;
  globalThis.fetch = async (t) => {
    upstream++;
    if (String(t).indexOf('/teams/123/matches') >= 0) {
      return new Response(JSON.stringify(many), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  // ① 不带标记 ⇒ 必须**不裁**（零回归：team-detail/h2h 需要全量）
  const r0 = await handle(req('/od/api/teams/123/matches'), ENV);
  const b0 = JSON.parse(await textOf(r0));
  ok('★ v3 默认**不裁**（全量返回，零回归）', Array.isArray(b0) && b0.length === 120, 'len=' + (b0 && b0.length));
  // ② ?recent=N ⇒ 裁到最近 N 条（且**保持原顺序/字段**）
  const r1 = await handle(req('/od/api/teams/123/matches?recent=30'), ENV);
  const b1 = JSON.parse(await textOf(r1));
  ok('★ v3 ?recent=30 ⇒ 裁到 30 条', Array.isArray(b1) && b1.length === 30, 'len=' + (b1 && b1.length));
  ok('★ v3 裁剪取的是**最近**（前 N 条，顺序与字段不变）',
    b1[0].match_id === 900000 && b1[0].leagueid === 19102, JSON.stringify(b1[0]));
  // ③ X-Trim 头同样生效
  const r2 = await handle(req('/od/api/teams/123/matches', { headers: { 'X-Trim': '5' } }), ENV);
  const b2 = JSON.parse(await textOf(r2));
  ok('★ v3 X-Trim:5 ⇒ 裁到 5 条', Array.isArray(b2) && b2.length === 5, 'len=' + (b2 && b2.length));
  // ④ 裁剪与不裁**缓存互不污染**（key 含 trim 维度）
  const before = upstream;
  await handle(req('/od/api/teams/123/matches?recent=30'), ENV);
  ok('★ v3 裁剪版命中自身缓存（不再打上游）', upstream === before, 'upstream=' + upstream);
  globalThis.fetch = saved;
}

console.log('\n=== 结果 ===');
console.log('通过: ' + pass + '  失败: ' + fail);
if (fail) { console.log('存在失败 ❌'); process.exit(1); }
console.log('全部通过 ✅');
