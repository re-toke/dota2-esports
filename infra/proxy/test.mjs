// infra/proxy/test.mjs —— 本地验证中转路由（不需要部署、不需要网络）
//   做法：mock 全局 fetch（拦截上游请求），把 worker 的 handle() 当成纯函数调用，
//   逐条断言：① 路由命中 ② **服务端确实覆盖了客户端的错 key** ③ /leagues 裁剪 ④ 最小权限/健康检查
// 运行：node infra/proxy/test.mjs
import { handle, } from './worker.mjs';

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
  const r = await handle(req('/od/api/proMatches'), ENV);
  const b = JSON.parse(await textOf(r));
  ok('上游失败 → 502 且带 detail（真机可据此排查）', r.status === 502 && String(b.detail).indexOf('ECONNRESET') >= 0, JSON.stringify(b));
  ok('失败信息不含任何凭据', JSON.stringify(b).indexOf(REAL_KEY) < 0);
  globalThis.fetch = saved;
}

console.log('\n=== 结果 ===');
console.log('通过: ' + pass + '  失败: ' + fail);
if (fail) { console.log('存在失败 ❌'); process.exit(1); }
console.log('全部通过 ✅');
