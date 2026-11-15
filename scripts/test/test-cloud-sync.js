#!/usr/bin/env node
/**
 * scripts/test/test-cloud-sync.js
 * 云同步状态机单元测试（2026-11-15）
 *
 * ## 为什么有这组测试
 * 修的是「我的 → 云同步点关闭没反应 / 关不掉」：根因在状态机而非 UI ——
 *   ① disable() 失败时置 enabled=false + status='failed'，而页面 onSyncRetry 是
 *      `enabled ? syncProfile() : _enableSync()` ⇒ 用户点「重试删除」实际**重新开启了同步**；
 *   ② 整条 enable/disable 链无超时，promise 一旦不落地，status 永久卡 syncing，之后点击全被拦；
 *   ③ 关闭失败后「云端仍有数据」这件事**没有任何本地标记**，无从重试。
 * 这些都必须可测（真机复现成本极高），故用内存 wx + require.cache 注入桩，纯离线跑。
 *
 * 运行：node scripts/test/test-cloud-sync.js
 */
'use strict';

const path = require('path');
const fs = require('fs');

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + '  ->  ' + (detail || '')); }
}

// ===== ① 小程序环境 mock（storage 用内存 Map）=====
const store = new Map();
global.wx = {
  getStorageSync: function (k) { return store.has(k) ? store.get(k) : ''; },
  setStorageSync: function (k, v) { store.set(k, v); },
  removeStorageSync: function (k) { store.delete(k); }
};

// ===== ② 依赖桩（require.cache 注入，cloudSync 内部是惰性 require）=====
const UTILS = path.join(__dirname, '..', '..', 'utils');

const authStub = {
  jwt: 'jwt-abc',
  loginResult: 'openid-1234567',
  ensureLoginCalls: 0,
  ensureLogin: function () {
    authStub.ensureLoginCalls++;
    return Promise.resolve(authStub.loginResult);
  },
  getJwtSync: function () { return authStub.jwt; }
};

const sbStub = {
  calls: [],
  handler: function () { return Promise.resolve({ ok: true }); },
  edge: function (name, data, opts) {
    sbStub.calls.push({ name: name, data: data, opts: opts });
    return sbStub.handler(name, data, opts);
  }
};

const configStub = { supabase: { functions: { followProfile: 'follow-profile' } } };

function injectStub(file, exports) {
  const id = path.join(UTILS, file);
  require.cache[id] = { id: id, filename: id, loaded: true, exports: exports, children: [], paths: [] };
}
injectStub('auth.js', authStub);
injectStub('supabaseClient.js', sbStub);
injectStub('config.js', configStub);

const CS_PATH = path.join(UTILS, 'cloudSync.js');

/** 每个用例都要干净的模块实例 + 干净 storage + 干净桩行为 */
function freshCloudSync() {
  delete require.cache[CS_PATH];
  store.clear();
  sbStub.calls = [];
  sbStub.handler = function () { return Promise.resolve({ ok: true }); };
  authStub.jwt = 'jwt-abc';
  authStub.loginResult = 'openid-1234567';
  authStub.ensureLoginCalls = 0;
  return require(CS_PATH);
}

function deleteCalls() {
  return sbStub.calls.filter(function (c) { return c.data && c.data.op === 'delete'; });
}

// ===== ③ 用例 =====
async function main() {
  console.log('\n--- ① enable 成功 ---');
  {
    const cs = freshCloudSync();
    const r = await cs.enable();
    const s = cs.getState();
    assert('enable 成功 → ok:true', r.ok === true, JSON.stringify(r));
    assert('enable 成功 → enabled=true / status=synced', s.enabled === true && s.status === 'synced',
      JSON.stringify(s));
    assert('enable 成功 → pendingDelete=false', s.pendingDelete === false, JSON.stringify(s));
    assert('getState 暴露 pendingDelete 字段', typeof s.pendingDelete === 'boolean', JSON.stringify(s));
  }

  console.log('\n--- ② disable 成功 ---');
  {
    const cs = freshCloudSync();
    await cs.enable();
    const r = await cs.disable();
    const s = cs.getState();
    assert('disable 成功 → ok:true', r.ok === true, JSON.stringify(r));
    assert('disable 成功 → enabled=false / status=off', s.enabled === false && s.status === 'off',
      JSON.stringify(s));
    assert('disable 成功 → pendingDelete=false（云端已干净）', s.pendingDelete === false, JSON.stringify(s));
    assert('disable 只发一次 delete 请求', deleteCalls().length === 1 && deleteCalls()[0].data.op === 'delete',
      JSON.stringify(sbStub.calls));
    assert('disable 请求带 JWT', deleteCalls()[0].opts && deleteCalls()[0].opts.jwt === 'jwt-abc',
      JSON.stringify(deleteCalls()[0] && deleteCalls()[0].opts));
  }

  console.log('\n--- ③ disable 时 EF 失败（本地先行：开关已关 + 待删标记）---');
  {
    const cs = freshCloudSync();
    await cs.enable();
    sbStub.handler = function () { return Promise.resolve({ ok: false, error: 'boom' }); };
    const p = cs.disable();
    // ★ 关键：await 之前（同步段已执行）开关就必须是关闭态 —— UI 不再看网络脸色
    const mid = cs.getState();
    assert('★ 本地先行：await 前 enabled 已为 false', mid.enabled === false, JSON.stringify(mid));
    assert('★ 本地先行：await 前 pendingDelete 已为 true', mid.pendingDelete === true, JSON.stringify(mid));
    const r = await p;
    const s = cs.getState();
    assert('disable 失败 → ok:false', r.ok === false, JSON.stringify(r));
    assert('★ disable 失败 → 开关仍是关闭态（不是半开）', s.enabled === false, JSON.stringify(s));
    assert('★ disable 失败 → pendingDelete=true（可继续重试删除）', s.pendingDelete === true, JSON.stringify(s));
    assert('disable 失败 → status=failed', s.status === 'failed', JSON.stringify(s));
  }

  console.log('\n--- ④ 无 JWT 且登录失败 ---');
  {
    const cs = freshCloudSync();
    await cs.enable();
    authStub.jwt = '';
    authStub.loginResult = null;
    const r = await cs.disable();
    const s = cs.getState();
    assert('无凭证 → ok:false', r.ok === false, JSON.stringify(r));
    assert('无凭证 → reason=no_credential', r.reason === 'no_credential', JSON.stringify(r));
    assert('无凭证 → enabled=false / status=failed / pendingDelete=true',
      s.enabled === false && s.status === 'failed' && s.pendingDelete === true, JSON.stringify(s));
    assert('无凭证 → 确实没有发出 delete 请求（不报假成功）', deleteCalls().length === 0,
      JSON.stringify(sbStub.calls));
  }

  console.log('\n--- ⑤ EF 永不 resolve → 超时收口（状态不卡 syncing）---');
  {
    const cs = freshCloudSync();
    await cs.enable();
    cs.setTimeoutMs(10);                       // 注入 10ms 超时（生产默认 15s）
    sbStub.handler = function () { return new Promise(function () { /* 永不落地 */ }); };
    const t0 = Date.now();
    const r = await cs.disable();
    const cost = Date.now() - t0;
    const s = cs.getState();
    assert('超时 → ok:false 且 reason=timeout', r.ok === false && r.reason === 'timeout', JSON.stringify(r));
    assert('超时 → promise 真的落地（' + cost + 'ms < 2000ms）', cost < 2000, 'cost=' + cost);
    assert('★ 超时 → status 不卡 syncing', s.status !== 'syncing', JSON.stringify(s));
    assert('★ 超时 → enabled=false / pendingDelete=true',
      s.enabled === false && s.pendingDelete === true, JSON.stringify(s));
    // 状态机未被卡死：还能继续发起操作（用 retryPendingDelete 验证）
    authStub.jwt = '';
    authStub.loginResult = null;
    const r2 = await cs.retryPendingDelete();
    assert('超时后状态机仍可继续操作（未被锁死）', r2.ok === false && cs.getState().status !== 'syncing',
      JSON.stringify(r2) + ' / ' + JSON.stringify(cs.getState()));
    cs.setTimeoutMs();                         // 复位默认超时
  }

  console.log('\n--- ⑥ retryPendingDelete（只删不发别的请求）---');
  {
    const cs = freshCloudSync();
    await cs.enable();
    sbStub.handler = function () { return Promise.resolve({ ok: false }); };
    await cs.disable();
    assert('重试前处于 pendingDelete', cs.hasPendingDelete() === true && cs.getState().pendingDelete === true);
    const before = sbStub.calls.length;
    sbStub.handler = function () { return Promise.resolve({ ok: true }); };
    const r = await cs.retryPendingDelete();
    const s = cs.getState();
    assert('retryPendingDelete 成功 → ok:true', r.ok === true, JSON.stringify(r));
    assert('★ retryPendingDelete 成功 → pendingDelete=false / status=off',
      s.pendingDelete === false && s.status === 'off', JSON.stringify(s));
    assert('★ retryPendingDelete 成功 → 开关保持关闭（不会偷偷重新开启）', s.enabled === false, JSON.stringify(s));
    assert('★ retryPendingDelete 只新增 1 次请求（不发上传等其它请求）',
      sbStub.calls.length === before + 1 &&
      sbStub.calls.slice(before).every(function (c) { return c.data && c.data.op === 'delete'; }),
      JSON.stringify(sbStub.calls.slice(before)));
    // 无待删标记时是 no-op
    const after = sbStub.calls.length;
    const r2 = await cs.retryPendingDelete();
    assert('无待删标记 → no-op（skipped 且零请求）',
      r2.ok === true && r2.skipped === true && sbStub.calls.length === after, JSON.stringify(r2));
  }

  console.log('\n--- ⑦ onSyncRetry 语义：pendingDelete 必须走删除，不得 enable ---');
  {
    const cs = freshCloudSync();
    assert('resolveRetryAction 已导出', typeof cs.resolveRetryAction === 'function');
    assert('★ pendingDelete（开关已关）→ delete', cs.resolveRetryAction({ enabled: false, pendingDelete: true }) === 'delete',
      cs.resolveRetryAction({ enabled: false, pendingDelete: true }));
    assert('★ 旧缺陷回归：pendingDelete 绝不能被判成 enable',
      cs.resolveRetryAction({ enabled: false, pendingDelete: true }) !== 'enable');
    assert('已开启 + 同步失败 → sync', cs.resolveRetryAction({ enabled: true, pendingDelete: false, status: 'failed' }) === 'sync');
    assert('未开启且无待删 → enable', cs.resolveRetryAction({ enabled: false, pendingDelete: false }) === 'enable');
    assert('空/非法入参不抛错（退化为 enable）', cs.resolveRetryAction(null) === 'enable' && cs.resolveRetryAction({}) === 'enable');

    // 源码级守卫：页面必须用纯函数决策，且不得再有「enabled ? syncProfile : _enableSync」旧写法
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'pages', 'follow', 'follow.js'), 'utf8');
    assert('★ follow.js 用 resolveRetryAction 决策', src.indexOf('resolveRetryAction') >= 0);
    assert('★ follow.js 的 pendingDelete 分支走 retryPendingDelete',
      src.indexOf("action === 'delete'") >= 0 && src.indexOf('_retryPendingDelete') >= 0);
    assert('★ 旧写法（enabled ? syncProfile() : _enableSync()）已不存在',
      src.indexOf('getState().enabled) this.syncProfile()') < 0);
    // 弹窗按钮文案 ≤ 4 字（wx.showModal 上限）
    assert('★ confirmText 不再是 5 字的「关闭并删除」', src.indexOf("confirmText: '关闭并删除'") < 0);
    assert('★ confirmText 改为 4 字内「关闭」', src.indexOf("confirmText: '关闭'") >= 0);
  }

  console.log('\n--- ⑧ 关闭过程中的 onChange 通知（页面订阅靠它刷新）---');
  {
    const cs = freshCloudSync();
    await cs.enable();
    const seen = [];
    const off = cs.onChange(function (s) { seen.push({ enabled: s.enabled, status: s.status, pendingDelete: s.pendingDelete }); });
    await cs.disable();
    off();
    const first = seen[0];
    assert('★ 首个通知就是「已关闭」（UI 立刻响应，不等网络）',
      first && first.enabled === false && first.pendingDelete === true, JSON.stringify(first));
    assert('最终通知为关闭且无待删（删除成功）',
      seen[seen.length - 1].enabled === false && seen[seen.length - 1].pendingDelete === false,
      JSON.stringify(seen[seen.length - 1]));
    const n = seen.length;
    await cs.disable();
    assert('退订生效（退订后不再收到通知）', seen.length === n, 'n=' + n + ' now=' + seen.length);
  }

  console.log('\n=== 结果 ===');
  console.log('通过: ' + pass + '  失败: ' + fail);
  if (fail > 0) { console.log('存在失败 ❌'); process.exit(1); }
  console.log('全部通过 ✅');
}

main().catch(function (e) {
  console.error('未捕获异常：', e);
  process.exit(1);
});
