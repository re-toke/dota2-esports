// scripts/test/test-api-inflight.js
// P1-6（2026-10-12）：api.js **前台 fetch 去重**单测 —— 同 key 并发只发 1 次网络请求。
//
// 覆盖三条前台回源路径（原实现只有 cached() 有 inflight 去重）：
//   ① cached()                 —— `getTeamMatches(id,{recent:N})`（直连支路，不涉 EF）
//   ② cachedFresh()            —— `getTeamPlayers(id)` 的 direct 兜底
//   ③ cachedFreshIncremental() —— `getLeagueMatches(id)` / `getTeamMatches(id)` 的 direct 兜底
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

  console.log('\n=== 结果 ===');
  console.log('通过: ' + passed + '  失败: ' + failed);
  if (failed) { console.log('存在失败 ❌'); process.exit(1); }
  console.log('全部通过 ✅');
}

main();
