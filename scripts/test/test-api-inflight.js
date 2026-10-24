// scripts/test/test-api-inflight.js
// P1-6（2026-10-12）：api.js **前台 fetch 去重**单测 —— 同 key 并发只发 1 次网络请求。
//
// 覆盖三条前台回源路径（原实现只有 cached() 有 inflight 去重）：
//   ① cached()                 —— `getTeamMatches(id,{recent:N})`（直连支路，不涉 EF）
//   ② cachedFresh()            —— `getTeamPlayers(id)` 的 direct 兜底
//   ③ cachedFreshIncremental() —— `getLeagueMatches(id)` / `getTeamMatches(id)` 的 direct 兜底
//
// ★ 2026-10-24：原 `scripts/test/test-snapshot-layers.js` 中的**非快照**用例（O-4 写穿 key +
//   `peekLeagues` 三态）已迁入本文件（该文件其余用例专测已下线的内置快照，故整体删除）。
//
// 不联网：mock wx.request 并统计调用次数（EF 通道显式关闭 ⇒ 直接走 direct 兜底）。

'use strict';

const path = require('path');
const SRC = path.resolve(__dirname, '..', '..', 'utils');

let passed = 0;
let failed = 0;
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

// ===== mock wx（网络由 handler 控制，默认不可达）=====
const storage = {};
let reqCount = 0;
let handler = null;
global.wx = {
  request: function (opts) {
    reqCount++;
    if (handler) return handler(opts);
    if (opts.fail) opts.fail({ errMsg: 'request:fail (mock)' });
    return {};
  },
  getStorageSync: function (k) { return storage[k] || null; },
  setStorageSync: function (k, v) { storage[k] = v; },
  removeStorageSync: function (k) { delete storage[k]; },
  getStorageInfoSync: function () { return { keys: Object.keys(storage) }; }
};

// ===== 清 module cache（保证干净实例）=====
const purge = ['cache.js', 'config.js', 'api.js', 'incremental.js', 'sqlFragments.js',
  'tiers.js', 'monitor.js', 'names.js', 'endpoints.js', 'cloudProxy.js', 'supabaseClient.js'];
for (const k of Object.keys(require.cache)) {
  for (const name of purge) { if (k.indexOf(name) >= 0) delete require.cache[k]; }
}

// 显式关闭 Supabase 通道 ⇒ tryCloudOrDirect 的 cloud 分支立即 reject ⇒ 走 direct（不产生额外网络）
const config = require(path.join(SRC, 'config.js'));
config.supabase.enabled = false;

const api = require(path.join(SRC, 'api.js'));

// 本测试用到的四个端点（/teams/<id>/matches、/teams/<id>/players、/leagues/<id>/matches）
// 在 validateResponse 中**均为数组型** ⇒ 统一回数组
const ARR = [{ match_id: 1, start_time: 100 }];
handler = function (opts) {
  setTimeout(function () { if (opts.success) opts.success({ statusCode: 200, data: ARR }); }, 15);
  return {};
};

function clearCache() { Object.keys(storage).forEach(function (k) { delete storage[k]; }); }

async function check(label, fn) {
  try { await fn(); passed++; console.log('PASS  ' + label); }
  catch (e) { failed++; console.log('FAIL  ' + label + '  ->  ' + (e && e.message)); }
}

async function main() {
  await check('cached(): getTeamMatches(recent=50) 并发 3 次只发 1 次网络', async () => {
    clearCache(); reqCount = 0;
    await Promise.all([
      api.getTeamMatches(1, { recent: 50 }),
      api.getTeamMatches(1, { recent: 50 }),
      api.getTeamMatches(1, { recent: 50 })
    ]);
    assert(reqCount === 1, '期望 1 次请求，实际 ' + reqCount);
  });

  await check('cachedFresh(): getTeamPlayers 并发 3 次只发 1 次网络', async () => {
    clearCache(); reqCount = 0;
    await Promise.all([
      api.getTeamPlayers(1), api.getTeamPlayers(1), api.getTeamPlayers(1)
    ]);
    assert(reqCount === 1, '期望 1 次请求，实际 ' + reqCount);
  });

  await check('cachedFreshIncremental(): getLeagueMatches 并发 3 次只发 1 次网络', async () => {
    clearCache(); reqCount = 0;
    await Promise.all([
      api.getLeagueMatches(1), api.getLeagueMatches(1), api.getLeagueMatches(1)
    ]);
    assert(reqCount === 1, '期望 1 次请求，实际 ' + reqCount);
  });

  await check('cachedFreshIncremental(): getTeamMatches 全量 并发 2 次只发 1 次网络', async () => {
    clearCache(); reqCount = 0;
    await Promise.all([api.getTeamMatches(1), api.getTeamMatches(1)]);
    assert(reqCount === 1, '期望 1 次请求，实际 ' + reqCount);
  });

  await check('去重不粘滞：请求完成后同 key 再次调用（缓存已过期口径）不复用旧 Promise', async () => {
    clearCache(); reqCount = 0;
    await api.getLeagueMatches(2);
    assert(reqCount === 1, '首次应 1 次，实际 ' + reqCount);
    // 清缓存 ⇒ 第二次必须重新回源（证明 inflight 表已清理，而非永久复用）
    clearCache();
    await api.getLeagueMatches(2);
    assert(reqCount === 2, '清缓存后应再发 1 次（共 2），实际 ' + reqCount);
  });

  await check('失败也清理 inflight（失败后重试可再次回源）', async () => {
    clearCache(); reqCount = 0;
    const okHandler = handler;
    handler = function (opts) { if (opts.fail) opts.fail({ errMsg: 'request:fail (mock down)' }); return {}; };
    await api.getLeagueMatches(3).catch(function () { /* 预期失败 */ });
    const afterFail = reqCount;
    assert(afterFail >= 1, '失败路径应至少发出 1 次请求，实际 ' + afterFail);
    handler = okHandler;
    clearCache();
    await api.getLeagueMatches(3);
    assert(reqCount > afterFail, '恢复后应能再次回源（inflight 未泄漏）');
  });

  // ── 方案 A（2026-10-13）：**EF 前台并发去重**（`cloudProxy.call`） ──────────────────
  //   背景（实测）：冷启动时 `app.js` 预取 + `leagues.js` onLoad + `search.js` onLoad 会同 tick
  //   并发 `getLeagues`，单次 **321KB** ⇒ 原实现各发一次 ⇒ 重复 2~3 份出网。
  //   实现：`cloudProxy.call` 按「action + 载荷」复用同一个 Promise（与 `api.js` 的三条前台路径互补）。
  //   桩法：`_sbEfAvailable()` 与 `_efCall()` 都在**调用时**才 `require('./supabaseClient.js')`
  //   ⇒ 直接改其 exports 即可；`{force:true}` 用于跳过热缓存，确保每次都落到 edge 计数上。
  const sb = require(path.join(SRC, 'supabaseClient.js'));
  const cloudProxy = require(path.join(SRC, 'cloudProxy.js'));
  let edgeCalls = 0;
  sb.efAvailable = function () { return true; };
  sb.edge = function () {
    edgeCalls++;
    return new Promise(function (r) { setTimeout(function () { r({ data: [{ ok: 1 }] }); }, 20); });
  };
  config.supabase.enabled = true;   // `_sbEfAvailable()` 要求 enabled/url/anonKey 三者齐备

  await check('EF 前台并发去重：同 action+同载荷并发 3 次只打 1 次 EF', async () => {
    edgeCalls = 0;
    const rs = await Promise.all([
      cloudProxy.call('getLeagues', [], { force: true }),
      cloudProxy.call('getLeagues', [], { force: true }),
      cloudProxy.call('getLeagues', [], { force: true })
    ]);
    assert(edgeCalls === 1, '期望 1 次 EF 调用，实际 ' + edgeCalls);
    assert(rs.every(function (x) { return Array.isArray(x) && x.length === 1; }), '三个调用方都应拿到同一份结果');
  });

  await check('EF 去重按载荷区分：不同参数**不**合并（避免误伤）', async () => {
    edgeCalls = 0;
    await Promise.all([
      cloudProxy.call('getLeagues', { leagueId: 1 }, { force: true }),
      cloudProxy.call('getLeagues', { leagueId: 2 }, { force: true })
    ]);
    assert(edgeCalls === 2, '不同载荷应各发 1 次（共 2），实际 ' + edgeCalls);
  });

  await check('EF 去重不粘滞：请求完成后同 key 再次调用不复用旧 Promise', async () => {
    edgeCalls = 0;
    await cloudProxy.call('getLeagues', [], { force: true });
    assert(edgeCalls === 1, '首次应 1 次，实际 ' + edgeCalls);
    await cloudProxy.call('getLeagues', [], { force: true });
    assert(edgeCalls === 2, '完成后应能再次回源（inflight 已清理），实际 ' + edgeCalls);
  });

  // ── 迁移自 test-snapshot-layers.js（2026-10-24）：O-4 写穿 key 回归守卫 + peekLeagues 三态 ──
  //   旧实现把「响应体」当参数拼进 key ⇒ 写穿条目**永远读不到**（静默失效 + 存储膨胀）。
  const curationShared = require(path.join(SRC, 'curation-shared.js'));
  const LEAGUES = [
    { leagueid: 20279, name: 'PGL Wallachia Season 9', tier: 'premium' },
    { leagueid: 19719, name: 'The International 2026', tier: 'excluded' },   // 靠名字白名单保留
    { leagueid: 90001, name: '肛宝联赛-老婆杯', tier: 'professional' }        // 应被闸门剔除（真实案例）
  ];

  await check('O-4 写穿 key 回归：writeThrough 后 peekLeagues 必须命中（旧实现 key 含响应体 ⇒ 读不到）', function () {
    clearCache();
    api.writeThrough('/leagues', undefined, LEAGUES, 3600);
    const keys = Object.keys(storage);
    assert(keys.length === 1, '写穿只应产生 1 个 key，实际 ' + keys.length + '：' + keys.join(' , '));
    assert(keys[0].indexOf('leagueid') < 0, 'key 不得包含响应内容（旧 bug 指纹）：' + keys[0]);
    assert(keys[0].endsWith((curationShared.dataVersion + ':') + '/leagues|{}'),
      'key 口径应与读侧一致（PREFIX + _v() + path + "|{}"），实际 ' + keys[0]);
    const peeked = api.peekLeagues();
    assert(!!peeked && !!peeked.leagues, 'peekLeagues 应命中写穿数据');
    assert(typeof peeked.fetchedAt === 'number' && peeked.fetchedAt > 0,
      'peekLeagues 应带回真实 fetchedAt，实际 ' + peeked.fetchedAt);
  });

  await check('peekLeagues 三态：过 filterCollectableLeagues / junk 剔除 / 白名单保留 / 空缓存返回 null', function () {
    const peeked = api.peekLeagues();
    assert(peeked && peeked.leagues.length === 2, '应与 getLeagues 同口径（2 条），实际 ' + (peeked && peeked.leagues.length));
    assert(peeked.leagues.every(function (l) { return l.name !== '肛宝联赛-老婆杯'; }), 'junk 联赛应被剔除');
    assert(peeked.leagues.some(function (l) { return l.leagueid === 19719; }), 'excluded 但白名单命中的 TI 应保留');
    clearCache();
    assert(api.peekLeagues() === null, '空缓存应返回 null（不抛错）');
  });

  console.log('\n=== 结果 ===');
  console.log('通过: ' + passed + '  失败: ' + failed);
  if (failed) { console.log('存在失败 ❌'); process.exit(1); }
  console.log('全部通过 ✅');
}

main();
