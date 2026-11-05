'use strict';
/* global globalThis */
/**
 * 运行期范围解析的集成自测（离线 mock Supabase + LP，不发真实网络请求）。
 * 覆盖：版本探针 → 远端推导 → 快照 → 待补抓队列 → 冷启动复用 → full 口径隔离。
 * 用法：node scripts/test/test-lp-sync-scope.js
 */
const MOCK_VER = 7;
const NOW = Math.floor(Date.now() / 1000);

const snapshotStore = {};
const counters = { meta: 0, events: 0, cacheGet: 0, cachePost: 0, lp: [] };

function jsonRes(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

globalThis.Deno = {
  env: { get: (k) => ({ SB_SERVICE_KEY: 'svc', SYNC_TOKEN: 'tok', SB_URL: 'https://sb.mock' }[k] || '') }
};

globalThis.fetch = async (url, init) => {
  await null;   // 保持返回 Promise 的契约（被 mock 的调用方按异步接口使用）
  const u = String(url);
  const method = (init && init.method) || 'GET';

  if (u.includes('/rest/v1/curation_meta')) {
    counters.meta += 1;
    return jsonRes([{ value: { v: MOCK_VER } }]);
  }
  if (u.includes('/rest/v1/curation_events')) {
    counters.events += 1;
    // 一个「只存在于远端」的新赛事（admin 新增的等价场景）
    return jsonRes([{
      canonical_key: 'Mock Cup 2026', league_id: 9001,
      ls: 'Mock Cup/2026', sms: null, ss: null, bs: null,
      st: String(NOW + 86400), en: String(NOW + 3 * 86400)
    }]);
  }
  if (u.includes('/rest/v1/aggregation_cache')) {
    if (method === 'POST') {
      counters.cachePost += 1;
      const rows = JSON.parse(init.body);
      rows.forEach((r) => { snapshotStore[r.key] = r.payload; });
      return jsonRes({});
    }
    counters.cacheGet += 1;
    const key = decodeURIComponent((u.match(/key=eq\.([^&]+)/) || [])[1] || '');
    return jsonRes(snapshotStore[key] ? [{ payload: snapshotStore[key] }] : []);
  }
  if (u.includes('api.php')) {
    if (u.includes('list=recentchanges')) return jsonRes({ query: { recentchanges: [] } });
    const raw = decodeURIComponent((u.match(/titles=([^&]*)/) || [])[1] || '');
    const titles = raw.split('|').filter(Boolean);
    counters.lp.push(titles);
    const pages = {};
    titles.forEach((t, i) => {
      pages[i] = { title: t.replace(/_/g, ' '), revisions: [{ '*': 'body:' + t }] };
    });
    return jsonRes({ query: { pages } });
  }
  throw new Error('unexpected fetch: ' + u);
};

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) passed += 1;
  else { failed += 1; console.error('  ✗ ' + msg); }
}
function eq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), msg + ' (got ' + JSON.stringify(a) + ')'); }

const call = (mod, qs) => mod.default.fetch(
  new Request('https://w/sync?token=tok' + (qs ? '&' + qs : ''))
).then((r) => r.json());

(async () => {
  const mod = await import('../../infra/proxy/lp-sync.mjs');

  // ① 干跑：从远端推导，不碰 LP
  const d1 = await call(mod, 'scope=1');
  eq(d1.scope.source, 'remote', '首次解析来源 = remote');
  ok(d1.scope.rc > d1.scope.full, 'rc 口径包含远端新 slug，full 不含');
  eq(d1.scope.pending, 1, '新增 slug 进入待补抓队列');
  eq(d1.scope.version, String(MOCK_VER), '版本号回显');
  eq(counters.lp.length, 0, '干跑不发 LP 请求');

  // ② 正常增量：版本未变 → 用快照，但要把队列排空
  const r2 = await call(mod, '');
  eq(r2.scope.source, 'snapshot', '版本未变走快照短路');
  eq(r2.mode, 'incremental', '模式仍为增量');
  eq(r2.scope.pending, 0, '队列已排空');
  eq(counters.lp.length, 1, '补抓只发 1 个批次');
  eq(counters.lp[0], ['Mock_Cup/2026'], '补抓的正是新增 slug');
  eq(snapshotStore['lp:w:Mock_Cup/2026'], 'body:Mock_Cup/2026', '补抓页面正文已落库');
  ok(!!snapshotStore['lp:scope:snapshot'], '快照已持久化');
  const snapSaved = snapshotStore['lp:scope:snapshot'];
  eq([snapSaved.lastBoot.tried, snapSaved.lastBoot.fetched, snapSaved.lastBoot.written], [1, 1, 1], 'lastBoot 持久化补抓实证');

  // ③ 再次请求：无新增 → 不再发 LP
  const d3 = await call(mod, 'scope=1');
  eq(d3.scope.pending, 0, '没有遗留队列');
  eq(counters.lp.length, 1, '无新增时不发额外 LP 请求');

  // ④ 冷启动（新模块实例）：直接复用快照，不重拉 curation_events
  const before = counters.events;
  const mod2 = await import('../../infra/proxy/lp-sync.mjs?cold=1');
  const d4 = await call(mod2, 'scope=1');
  eq(d4.scope.source, 'snapshot', '冷启动命中快照');
  eq(counters.events, before, '冷启动未重拉 curation_events');
  eq(d4.scope.rc, d1.scope.rc, '范围与上一轮一致');

  // ⑤ full 口径隔离：只抓烘焙页面，不含远端新增
  const f5 = await call(mod2, 'full=1');
  const allTitles = counters.lp.slice(1).flat();
  eq(f5.slugs, d1.scope.full, 'full 抓取页面数 = fullPages');
  ok(!allTitles.includes('Mock_Cup/2026'), 'full 不含远端新增页面');
  ok(allTitles.length > 0, 'full 确实发起了抓取');

  console.log('\nlp-sync scope: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
