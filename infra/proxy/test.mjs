// infra/proxy/test.mjs —— 本地验证中转路由（不需要部署、不需要网络）
//   做法：mock 全局 fetch（拦截上游请求），把 worker 的 handle() 当成纯函数调用，
//   逐条断言：① 路由命中 ② **服务端确实覆盖了客户端的错 key** ③ /leagues 裁剪 ④ 最小权限/健康检查
// 运行：node infra/proxy/test.mjs
import { handle, EF_ALLOW, TTL, _cache } from './worker.mjs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

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

// ── ②b 方案③（2026-10-16）：admin 写入口经中转（EF 放行 + 转发 x-admin-token + CORS 允许该头） ──
{
  calls.length = 0;
  const r = await handle(req('/sb/functions/v1/admin-write', {
    method: 'POST', body: '{"operation":"upsertTeam","params":{}}',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': 'tok-abc123' }
  }), ENV);
  const c = calls[0];
  ok('★ 方案③：admin-write 已放行（不再 404 ef not allowed）', r.status === 200, String(r.status));
  ok('★ 方案③：x-admin-token 被转发给 EF（否则写恒 401）',
    c && c.headers['x-admin-token'] === 'tok-abc123', c && JSON.stringify(c.headers));
  ok('★ 方案③：客户端错 key 仍被服务端真 key 覆盖（不透传）',
    c && c.headers['apikey'] === REAL_KEY, c && c.headers['apikey']);
}
{
  // CORS 预检：浏览器发写请求会带 x-admin-token ⇒ Allow-Headers 必须允许它，否则预检被拒、写无从发起
  const r = await handle(req('/sb/functions/v1/admin-write', { method: 'OPTIONS' }), ENV);
  const ah = r.headers.get('Access-Control-Allow-Headers') || '';
  ok('★ 方案③：CORS Allow-Headers 含 X-Admin-Token（预检放行）', r.status === 204 && /x-admin-token/i.test(ah), r.status + ' | ' + ah);
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

// ── ⑦c 陈旧兜底（2026-10-24）：上游失败/停滞时回上一次成功响应，而不是让首屏空窗 ──
{
  const saved = globalThis.fetch;
  const u = '/od/api/staleProbe?case=stale';
  const key = 'od|staleProbe?case=stale|t0';

  // ① 先成功一次 ⇒ 写入缓存
  globalThis.fetch = async () => new Response('[{"a":1}]', { status: 200, headers: { 'Content-Type': 'application/json' } });
  const first = await handle(req(u), ENV);
  const firstBody = await textOf(first);
  ok('陈旧兜底：首次请求为 MISS（并写入缓存）', first.headers.get('X-Proxy-Cache') === 'MISS',
    String(first.headers.get('X-Proxy-Cache')));

  // ② 把该条缓存置为「已过期」（TTL 默认 120s，测试不能真等）
  const ent = _cache.get(key);
  ok('陈旧兜底：缓存键格式与实现一致（测试可定位该条）', !!ent, key);
  if (ent) ent.exp = Date.now() - 1;

  // ③ 上游网络异常 ⇒ 应回 200 + STALE，且**只尝试 1 次**（避免 12s×2 叠加）
  let n = 0;
  globalThis.fetch = async () => { n++; throw new Error('ECONNRESET'); };
  const r2 = await handle(req(u), ENV);
  const b2 = await textOf(r2);
  ok('★ 陈旧兜底：上游异常 ⇒ 返回陈旧缓存（200 + STALE）',
    r2.status === 200 && r2.headers.get('X-Proxy-Cache') === 'STALE',
    r2.status + ' / ' + r2.headers.get('X-Proxy-Cache'));
  ok('★ 陈旧兜底：只尝试 1 次（不再 12s×2）', n === 1, String(n));
  ok('陈旧兜底：响应体与上次成功一致', b2 === firstBody, b2 + ' vs ' + firstBody);
  ok('陈旧兜底：带 X-Proxy-Cache-Age 便于排查', r2.headers.get('X-Proxy-Cache-Age') !== null,
    String(r2.headers.get('X-Proxy-Cache-Age')));

  // ④ 上游 5xx ⇒ 同样回陈旧（不再把 5xx 暴露给客户端）
  globalThis.fetch = async () => new Response('boom', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  const r3 = await handle(req(u), ENV);
  ok('★ 陈旧兜底：上游 5xx ⇒ 也回陈旧缓存', r3.status === 200 && r3.headers.get('X-Proxy-Cache') === 'STALE',
    r3.status + ' / ' + r3.headers.get('X-Proxy-Cache'));

  // ⑤ 无旧缓存时必须保持原行为（502），不能被"降级"掩盖真实故障
  globalThis.fetch = async () => { throw new Error('ECONNRESET'); };
  const r4 = await handle(req('/od/api/staleProbe?case=nocache'), ENV);
  ok('陈旧兜底：无旧缓存时仍按原行为报 502', r4.status === 502, String(r4.status));

  globalThis.fetch = saved;
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
  // ★ 方案③（2026-10-16）：admin 后台写入口也必须放行（否则 admin 经中转写恒 404）
  ok('★ 不变量：EF 白名单含 admin 写入口 admin-write（方案③）', EF_ALLOW.has('admin-write'), '缺 admin-write');
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
  // ① 不带标记且 120<300 ⇒ 默认白名单未触发，原样返回
  const r0 = await handle(req('/od/api/teams/123/matches'), ENV);
  const b0 = JSON.parse(await textOf(r0));
  ok('★ v3/C 未声明且 120<300 ⇒ 原样返回（默认白名单未触发）', Array.isArray(b0) && b0.length === 120, 'len=' + (b0 && b0.length));
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

// ── ⑩ v4 新增：EF **白名单式**短缓存（只缓 bundle 的 getLeagueDetailBundle；其它一律不缓）──
{
  const b1 = JSON.stringify({ action: 'getLeagueDetailBundle', params: { leagueId: 19102, name: 'X' } });
  const H = { 'Content-Type': 'application/json' };
  calls.length = 0;
  const r1 = await handle(req('/sb/functions/v1/bundle-aggregator', { method: 'POST', body: b1, headers: H }), ENV);
  const n1 = calls.length;
  const r2 = await handle(req('/sb/functions/v1/bundle-aggregator', { method: 'POST', body: b1, headers: H }), ENV);
  ok('★ v4 白名单 EF：首次 MISS', r1.headers.get('X-Proxy-Cache') === 'MISS', String(r1.headers.get('X-Proxy-Cache')));
  ok('★ v4 白名单 EF：二次 HIT 且不再打上游',
    r2.headers.get('X-Proxy-Cache') === 'HIT' && calls.length === n1, r2.headers.get('X-Proxy-Cache') + ' / calls=' + calls.length + '（首次 ' + n1 + '）');
  // ★ 反向断言：**未登记**的 (EF, action) 一律不缓存（防"误缓写类/鉴权类 EF"）
  const b2 = JSON.stringify({ action: 'getProMatches', params: {} });
  calls.length = 0;
  await handle(req('/sb/functions/v1/opendota-proxy', { method: 'POST', body: b2, headers: H }), ENV);
  const m1 = calls.length;
  await handle(req('/sb/functions/v1/opendota-proxy', { method: 'POST', body: b2, headers: H }), ENV);
  ok('★ v4 反向：未登记 action **不得**被缓存（两次都打上游）',
    m1 === 1 && calls.length === 2, '首次 ' + m1 + ' / 两次后 ' + calls.length);
  // ★ 反向断言：不同 params 不得互相命中（缓存键含 params）
  const b3 = JSON.stringify({ action: 'getLeagueDetailBundle', params: { leagueId: 20208, name: 'Y' } });
  calls.length = 0;
  const r3 = await handle(req('/sb/functions/v1/bundle-aggregator', { method: 'POST', body: b3, headers: H }), ENV);
  ok('★ v4 不同参数不互相命中（键含 params）', r3.headers.get('X-Proxy-Cache') === 'MISS' && calls.length === 1, String(r3.headers.get('X-Proxy-Cache')));
}

// ── ⑪ P0-1 B′ 新增：`?vs=<teamId>` 端点级「双方交锋」过滤 + X-Proxy-Trim 回执 ──────
{
  const saved = globalThis.fetch;
  const mixed = [
    { match_id: 5, opposing_team_id: 777, leagueid: 1 },
    { match_id: 4, opposing_team_id: 888, leagueid: 2 },
    { match_id: 3, opposing_team_id: 777, leagueid: 3 },
    { match_id: 2, opposing_team_id: '777', leagueid: 4 },   // 字符串型 id 亦须匹配
    { match_id: 1, opposing_team_id: 999, leagueid: 5 }
  ];
  let upstream = 0;
  globalThis.fetch = async (t) => {
    upstream++;
    if (String(t).indexOf('/teams/321/matches') >= 0) {
      return new Response(JSON.stringify(mixed), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const r = await handle(req('/od/api/teams/321/matches?vs=777'), ENV);
  const b = JSON.parse(await textOf(r));
  ok('★ P0-1 ?vs=777 ⇒ 只回 A∩B 对局（3 条，含字符串型 id）',
    Array.isArray(b) && b.length === 3 && b.every((m) => String(m.opposing_team_id) === '777'),
    JSON.stringify(b.map((m) => m.match_id)));
  ok('★ P0-1 ?vs= 回执头 X-Proxy-Trim=vs:3', r.headers.get('X-Proxy-Trim') === 'vs:3', String(r.headers.get('X-Proxy-Trim')));
  ok('★ P0-1 ?vs= 只减不增（不放大 payload）', b.length <= mixed.length);
  const r2 = await handle(req('/od/api/teams/321/matches?recent=2'), ENV);
  ok('★ P0-1 ?recent= 回执头 X-Proxy-Trim=recent:2', r2.headers.get('X-Proxy-Trim') === 'recent:2', String(r2.headers.get('X-Proxy-Trim')));
  const before = upstream;
  await handle(req('/od/api/teams/321/matches?vs=777'), ENV);
  ok('★ P0-1 ?vs= 缓存键隔离（二次命中自身缓存，不再打上游）', upstream === before, 'upstream=' + upstream);
  globalThis.fetch = saved;
}

// ── ⑫ P0-1 C 新增：`/teams/*/matches` **默认裁剪白名单(300)** + 显式豁免 ───────────
{
  const saved = globalThis.fetch;
  const big = [];
  for (let i = 0; i < 500; i++) big.push({ match_id: 800000 + i, opposing_team_id: 999 });
  globalThis.fetch = async (t) => String(t).indexOf('/teams/555/matches') >= 0
    ? new Response(JSON.stringify(big), { status: 200, headers: { 'Content-Type': 'application/json' } })
    : new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
  const lenOf = async (r) => { const b = JSON.parse(await textOf(r)); return Array.isArray(b) ? b.length : -1; };
  const r1 = await handle(req('/od/api/teams/555/matches'), ENV);
  ok('★ C 未声明 ⇒ 默认裁到 300（白名单兜底）', (await lenOf(r1)) === 300, 'len=' + (await lenOf(r1)));
  ok('★ C 默认裁剪带回执头 recent:300', r1.headers.get('X-Proxy-Trim') === 'recent:300', String(r1.headers.get('X-Proxy-Trim')));
  const r2 = await handle(req('/od/api/teams/555/matches', { headers: { 'X-Trim': '0' } }), ENV);
  ok('★ C 显式 `X-Trim: 0` ⇒ 豁免默认裁剪（返回全量 500）', (await lenOf(r2)) === 500, 'len=' + (await lenOf(r2)));
  ok('★ C 豁免路径**不回写裁剪回执**（未裁剪）', !r2.headers.get('X-Proxy-Trim'), String(r2.headers.get('X-Proxy-Trim')));
  const r3 = await handle(req('/od/api/teams/555/matches?recent=0'), ENV);
  ok('★ C 显式 `?recent=0` ⇒ 同样豁免（返回全量 500）', (await lenOf(r3)) === 500, 'len=' + (await lenOf(r3)));
  const r4 = await handle(req('/od/api/teams/555/matches'), ENV);
  ok('★ C 缓存键按「有效裁剪量」隔离（豁免不污染默认 300 键）', (await lenOf(r4)) === 300, 'len=' + (await lenOf(r4)));
  globalThis.fetch = saved;
}

// ── ⑬ P1-2 新增①：出口「单一事实来源」三向一致（config ↔ endpoints ↔ api） ──────
{
  const cfg = require('../../utils/config.js');
  const ep = require('../../utils/endpoints.js');
  const api = require('../../utils/api.js');
  const primary = cfg.endpoints.proxy[0];
  ok('★ P1-2 config：supabase.url 由 PROXY_HOSTS[0] 派生（无重复字面量）',
    cfg.supabase.url === primary + '/sb', cfg.supabase.url);
  ok('★ P1-2 api：BASE 导出 = 主出口 + /od/api',
    api.BASE === primary + '/od/api', api.BASE);
  ok('★ P1-2 endpoints：odBase()/sbUrl() 与 api.BASE / supabase.url 同宿主',
    ep.odBase() === api.BASE && ep.sbUrl() === cfg.supabase.url, ep.odBase() + ' / ' + ep.sbUrl());
}

// ── ⑭ P1-2 新增②：主→备失败切换 + 会话粘滞 + 开机通道体检（utils/endpoints.js） ──
{
  const ep = require('../../utils/endpoints.js');
  const A = 'https://a.example.com', B = 'https://b.example.com';

  // ① 单出口（当前真实状态）：切不动、体检 no-op
  ep.setHosts([A]);
  ok('★ P1-2 单出口：failover 原地不动（行为与改造前等价）',
    ep.failover() === A && ep.count() === 1 && ep.current() === A, ep.current());
  ok('★ P1-2 单出口：probe 为 no-op（不发起任何探测）',
    (await ep.probe(() => { throw new Error('probe 不应被调用'); })) === A);

  // ② 双出口：空槽被过滤、主失败切备、会话粘滞、循环不越界
  ep.setHosts([A, B, '']);
  ok('★ P1-2 候选去重/去空槽', ep.count() === 2 && ep.current() === A, JSON.stringify(ep.hosts()));
  ok('★ P1-2 主失败 → 切备', ep.failover() === B && ep.current() === B);
  ok('★ P1-2 会话粘滞：后续请求保持备出口', ep.current() === B);
  ok('★ P1-2 再失败 → 回主（有限集合内循环）', ep.failover() === A && ep.current() === A);

  // ③ 开机体检：主不可达 → 选备；主可达 → 主优先；全不可达 → 维持现状
  ep.setHosts([A, B]);
  const p1 = await ep.probe((h) => Promise.resolve(h === B));
  ok('★ P1-2 体检：主不可达 → 选中备出口（异步写回粘滞）', p1 === B && ep.current() === B, p1);
  ep.reset();
  const p2 = await ep.probe(() => Promise.resolve(true));
  ok('★ P1-2 体检：主优先（可达即选主）', p2 === A && ep.current() === A, p2);
  ep.setHosts([A, B]);
  const p3 = await ep.probe(() => Promise.resolve(false));
  ok('★ P1-2 体检：全不可达 → 维持现状且不抛错', p3 === A && ep.current() === A, p3);

  // ④ 三台候选（2026-10-12 用户择定 C：Deno 现网 + Deno 新项目 + Render）
  //    —— 证明机制支持 >2 台，无需改代码（failover 是模运算循环、probe 遍历全部候选）
  const C3 = 'https://c.example.com';
  ep.setHosts([A, B, C3]);
  ok('★ P1-2 三台候选：count=3（支持 N 台，非"仅两台"硬编码）', ep.count() === 3, ep.count());
  ok('★ P1-2 三台：failover 循环 A→B', ep.failover() === B);
  ok('★ P1-2 三台：failover 循环 B→C', ep.failover() === C3);
  ok('★ P1-2 三台：failover 循环 C→A（回到主）', ep.failover() === A && ep.current() === A);
  ep.setHosts([A, B, C3]);
  const q1 = await ep.probe((h) => Promise.resolve(h === C3));
  ok('★ P1-2 三台体检：仅第 3 台可达 ⇒ 选中第 3 台（不只看前两台）', q1 === C3 && ep.current() === C3, q1);
  ep.setHosts([A, B, C3]);
  const q2 = await ep.probe((h) => Promise.resolve(h !== A));
  ok('★ P1-2 三台体检：主不可达 ⇒ 取**顺序最前**的可达者（B，而非 C）', q2 === B && ep.current() === B, q2);

  // ⑤ 2026-10-13 真机演练修「切换过冲」：failover(fromHost) 只认「**失败的那台**」
  //    真机复现：启动瞬间一批并发请求同时打到坏出口、各自失败各自盲转 ⇒ 3 台被转了一圈（8 次轮转，
  //    正确只需 1 次）。修法：迟到失败（fromHost ≠ 当前出口）⇒ 原地不动。
  ep.setHosts([A, B, C3]);
  ok('★ 过冲：fromHost = 当前出口 ⇒ 正常切一格（A→B）',
    ep.failover(A) === B && ep.current() === B, ep.current());
  ok('★ 过冲：**同一个坏宿主的迟到失败**（fromHost=A，已切到 B）⇒ 原地不动，不推到 C',
    ep.failover(A) === B && ep.current() === B, ep.current());
  ok('★ 过冲：连发 3 个迟到失败 ⇒ 仍停在 B（不绕回 A / 不越到 C）',
    ep.failover(A) === B && ep.failover(A) === B && ep.failover(A) === B && ep.current() === B, ep.current());
  ok('★ 过冲：新出口 B 真的失败 ⇒ 才继续切到 C',
    ep.failover(B) === C3 && ep.current() === C3, ep.current());
  ep.setHosts([A]);
  ok('★ 过冲：单出口时传 fromHost 亦原地不动',
    ep.failover(A) === A && ep.current() === A, ep.current());

  ep.setHosts(require('../../utils/config.js').endpoints.proxy);   // 复位为真实候选
  ep.reset();
}

// ── ⑮ P1-12 新增：轻量速率限制（默认关闭；开启后按 IP 计数，/healthz 豁免） ─────────
{
  const IP = { 'CF-Connecting-IP': '203.0.113.7' };
  // ① **显式 0 ⇒ 关闭**。⚠️ 不能再拿"未配 env"表达关闭：未配时会走**常量兜底 120**（见 ⑨⑩）。
  //   显式 0 同时保证该 IP **不计数**，不污染下面 ② 的阈值断言（`_rl` 按 IP 计数、不分 env）。
  const ENV0 = Object.assign({}, ENV, { PROXY_RATE_LIMIT_MAX: '0' });
  const d1 = await handle(req('/od/api/proMatches?rl=off1', { headers: IP }), ENV0);
  ok('★ P1-12 显式 0 ⇒ 关闭（且不计数，不污染后续断言）', d1.status !== 429, String(d1.status));

  // ② 开启（max=3/分钟）：阈值内放行、超阈值 429
  const ENV2 = Object.assign({}, ENV, { PROXY_RATE_LIMIT_MAX: '3' });
  const codes = [];
  for (let i = 0; i < 5; i++) {
    codes.push((await handle(req('/od/api/proMatches?rl=on' + i, { headers: IP }), ENV2)).status);
  }
  ok('★ P1-12 开启后：前 3 次放行、第 4 次起 429',
    codes.slice(0, 3).every((c) => c !== 429) && codes.slice(3).every((c) => c === 429),
    JSON.stringify(codes));

  // ③ /healthz 豁免（同 IP 已超阈值，但探活仍须 200 —— 否则开机体检会把自己限死）
  const h = await handle(req('/healthz', { headers: IP }), ENV2);
  ok('★ P1-12 /healthz 豁免限流（探活/体检不被限死）', h.status === 200, String(h.status));

  // ④ 不同 IP 独立计数（不误伤他人）
  const o = await handle(req('/od/api/proMatches?rl=other', { headers: { 'CF-Connecting-IP': '203.0.113.8' } }), ENV2);
  ok('★ P1-12 不同 IP 独立计数', o.status !== 429, String(o.status));

  // ── 2026-10-13（P1-12 复核）新增：IP 来源优先级 / fail-open / 探活回显 ──────────────
  //   背景：核实后确认 **CF-Connecting-IP 在 Deno Deploy 与 Netlify 上都不存在** ⇒ 改为
  //   「平台注入的 ctx.ip 优先 + 头兜底 + 取不到则 fail-open」。以下断言用 `/nope`（直奔 404，
  //   不打上游）以免引入真实网络调用。
  // ⑤ ctx.ip 优先于请求头（平台注入值可信；头可伪造）
  const c1 = await handle(req('/nope?rl=ctx'), ENV2, { ip: '198.51.100.9' });
  ok('★ P1-12 ctx.ip 优先于头（不并入已被限的 203.0.113.7 桶）', c1.status === 404, String(c1.status));

  // ⑥ **fail-open**：开了限流但**取不到任何 IP 来源** ⇒ 不限流。
  //   旧实现把取不到的客户端都塞进 'unknown' 同一个桶 ⇒ 一开限流就**全站 429**（本项目最该防的误伤）。
  const ENV3 = Object.assign({}, ENV, { PROXY_RATE_LIMIT_MAX: '1' });
  const n1 = await handle(req('/nope?rl=none1'), ENV3);
  const n2 = await handle(req('/nope?rl=none2'), ENV3);
  ok('★ P1-12 取不到 IP ⇒ fail-open（连续多次都不 429，绝不共用 unknown 桶）',
    n1.status === 404 && n2.status === 404, n1.status + '/' + n2.status);

  // ⑦ /healthz 回显 IP 来源 + 打码 IP（供 DEPLOY.md「IP 头是否注入」的验证步骤）
  const b2 = await (await handle(req('/healthz', { headers: IP }), ENV)).json();
  ok('★ P1-12 /healthz 回显 ipSource=cf，且 IP 打码为 203.0.113.x',
    b2.ipSource === 'cf' && b2.ipMasked === '203.0.113.x', b2.ipSource + ' / ' + b2.ipMasked);
  const b3 = await (await handle(req('/healthz'), ENV, { ip: '2001:db8:1234:5678::1' })).json();
  ok('★ P1-12 /healthz：ctx.ip ⇒ ipSource=ctx，IPv6 打码留前 3 组',
    b3.ipSource === 'ctx' && b3.ipMasked === '2001:db8:1234::x', b3.ipSource + ' / ' + b3.ipMasked);
  const b4 = await (await handle(req('/healthz'), ENV)).json();
  ok('★ P1-12 /healthz：完全取不到 ⇒ ipSource=none（据此可判定平台未注入）',
    b4.ipSource === 'none' && b4.ipMasked === '', b4.ipSource);

  // ⑧ **IPv4-mapped IPv6**（Deno Deploy 对 IPv4 客户端返回 `::ffff:1.2.3.4`）⇒ 必须剥前缀后
  //   按 IPv4 打码。不剥会塌成 `::ffff::x`、各客户端看起来一样（2026-10-13 修复）。
  const b5 = await (await handle(req('/healthz'), ENV, { ip: '::ffff:203.0.113.9' })).json();
  ok('★ P1-12 /healthz：IPv4-mapped IPv6 按 IPv4 打码（不塌成 ::ffff::x）',
    b5.ipSource === 'ctx' && b5.ipMasked === '203.0.113.x', b5.ipSource + ' / ' + b5.ipMasked);

  // ⑨ 未配 env ⇒ 走**常量兜底** 120（Deno Playground 不注入 env ⇒ 这是 Deno 两台能开限流的唯一路径）
  const b6 = await (await handle(req('/healthz'), ENV)).json();
  ok('★ P1-12 /healthz：未配 env ⇒ 走常量兜底（rlMax=120 / rlSrc=fallback）',
    b6.rlMax === 120 && b6.rlSrc === 'fallback', b6.rlMax + ' / ' + b6.rlSrc);
  // ⑩ env 有值 ⇒ **env 优先**（Netlify 侧即走此路；实测已生效）
  const b7 = await (await handle(req('/healthz'), ENV2)).json();
  ok('★ P1-12 /healthz：env 有值 ⇒ env 优先（rlSrc=env，阈值取 env 值）',
    b7.rlMax === 3 && b7.rlSrc === 'env', b7.rlMax + ' / ' + b7.rlSrc);
}

// ── ⑯ 方案 B（2026-10-13）：按需 gzip —— `X-Gzip-Ok` 显式门控（老客户端零回归） ─────────
{
  const savedFetch = globalThis.fetch;
  // 造一个 >1KB 的 JSON 上游响应（200 条 ≈ 8KB）
  const bigBody = JSON.stringify({ data: Array.from({ length: 200 }, (_, i) => ({ id: i, name: 'team-' + i })) });
  const mkRes = (body) => new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
  const GZ = { headers: { 'X-Gzip-Ok': '1' } };

  // ① 老客户端（已发布版本，不带 X-Gzip-Ok）⇒ **必须**明文且逐字节不变 ⇒ 零回归
  globalThis.fetch = async () => mkRes(bigBody);
  const plain = await handle(req('/od/api/proMatches?gz=p1'), ENV);
  ok('★ 方案B 老客户端不带 X-Gzip-Ok ⇒ 不压缩（零回归）',
    !plain.headers.get('Content-Encoding') && (await plain.text()) === bigBody,
    'ce=' + plain.headers.get('Content-Encoding'));

  // ② 新客户端（带 X-Gzip-Ok: 1）⇒ gzip + 回执头，且**解压后与明文一致**
  globalThis.fetch = async () => mkRes(bigBody);
  const gz = await handle(req('/od/api/proMatches?gz=p2', GZ), ENV);
  const gzBuf = await gz.arrayBuffer();
  const backText = Buffer.from(await new Response(
    new Blob([gzBuf]).stream().pipeThrough(new DecompressionStream('gzip'))
  ).arrayBuffer()).toString('utf8');
  ok('★ 方案B 新客户端 ⇒ gzip + 解压后与明文逐字节一致',
    gz.headers.get('Content-Encoding') === 'gzip' && gz.headers.get('X-Proxy-Gzip') === '1' && backText === bigBody,
    'ce=' + gz.headers.get('Content-Encoding') + ' bytes=' + gzBuf.byteLength + '/' + bigBody.length);
  ok('★ 方案B 压缩确实更小', gzBuf.byteLength < bigBody.length, gzBuf.byteLength + ' vs ' + bigBody.length);

  // ③ 小响应（<1KB）即使声明了也**不压**（省不下多少、徒增解码开销）
  globalThis.fetch = async () => mkRes('{"error":"tiny"}');
  const tiny = await handle(req('/od/api/proMatches?gz=p3', GZ), ENV);
  ok('★ 方案B <1KB 不压', !tiny.headers.get('Content-Encoding'), 'ce=' + tiny.headers.get('Content-Encoding'));

  // ④ env.PROXY_GZIP=1 可强制开启（不依赖客户端头；自测/应急用）
  globalThis.fetch = async () => mkRes(bigBody);
  const forced = await handle(req('/od/api/proMatches?gz=p4'), Object.assign({}, ENV, { PROXY_GZIP: '1' }));
  ok('★ 方案B env.PROXY_GZIP=1 强制压缩', forced.headers.get('Content-Encoding') === 'gzip',
    'ce=' + forced.headers.get('Content-Encoding'));

  globalThis.fetch = savedFetch;
}

console.log('\n=== 结果 ===');
console.log('通过: ' + pass + '  失败: ' + fail);
if (fail) { console.log('存在失败 ❌'); process.exit(1); }
console.log('全部通过 ✅');
