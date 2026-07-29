// scripts/test-subscribe-retry.js
// §8.3 云端推送重试单元测试（2026-07-29）
//
// 验证：
//   1. isRetryableError：可重试/不可重试错误码分类正确
//   2. backoffMs：指数退避计算正确，且封顶 RETRY_MAX_MS
//   3. sendSubscribeMessage：
//      - 成功时不重试（attempts=1）
//      - 不可重试错误立即返回（attempts=1）
//      - 可重试错误按指数退避重试，最终失败时 attempts=1+RETRY_MAX
//      - 中间某次成功则停止重试
//      - send 日志只记录一次（含 attempts/retried 字段）
//
// 运行：node scripts/test-subscribe-retry.js

'use strict';

let passed = 0;
let failed = 0;
const tests = [];

function section(title) { tests.push({ kind: 'section', title: title }); }
function check(label, fn) { tests.push({ kind: 'test', label: label, fn: fn }); }
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

// ===== 1. 设置 mock 环境 =====
const storage = {};
// callFunctionHandler：可被单个测试替换，模拟 wx.cloud.callFunction 的不同响应
let callFunctionHandler = function (opts) {
  // 默认：网络失败
  if (opts.fail) opts.fail({ errMsg: 'cloud:fail (mock network down)' });
};
// §8.3 测试加速：mock setTimeout 让退避重试瞬间完成（避免单测等待 2s/4s）
// 用 process.nextTick 保证 Promise 链正确执行，但不引入真实延迟。
const realSetTimeout = global.setTimeout;
global.setTimeout = function (fn) { process.nextTick(fn); };
global.wx = {
  getStorageSync: function (key) { return storage[key] || null; },
  setStorageSync: function (key, val) { storage[key] = val; },
  removeStorageSync: function (key) { delete storage[key]; },
  getStorageInfoSync: function () { return { keys: Object.keys(storage), currentSize: 0, limitSize: 10240 }; },
  cloud: {
    callFunction: function (opts) { callFunctionHandler(opts); }
  }
};

// ===== 2. 清除 module cache（确保加载最新 subscribe.js）=====
const path = require('path');
const SRC = path.resolve(__dirname, '..', 'utils');
const purge = ['subscribe.js', 'config.js', 'cloudCache.js', 'sources.js'];
for (const k of Object.keys(require.cache)) {
  for (const name of purge) { if (k.indexOf(name) >= 0) delete require.cache[k]; }
}

// ===== 3. require 模块 =====
const subscribe = require(path.join(SRC, 'subscribe.js'));

// ===== 4. 导出结构检查 =====
section('\n--- 模块导出结构 ---');
check('subscribe.isRetryableError exists', () => assert(typeof subscribe.isRetryableError === 'function'));
check('subscribe.backoffMs exists', () => assert(typeof subscribe.backoffMs === 'function'));
check('subscribe.sendSubscribeMessage exists', () => assert(typeof subscribe.sendSubscribeMessage === 'function'));

// ===== 5. isRetryableError 错误码分类 =====
section('\n--- isRetryableError 错误码分类 ---');

check('网络失败（errorType=network）可重试', () => {
  assert(subscribe.isRetryableError(null, 'network') === true, '网络失败应可重试');
});

check('系统繁忙（errcode=-1）可重试', () => {
  assert(subscribe.isRetryableError(-1, 'errcode') === true, '系统繁忙应可重试');
});

check('限频（errcode=45009）可重试', () => {
  assert(subscribe.isRetryableError(45009, 'errcode') === true, '限频应可重试');
});

check('用户拒绝订阅（errcode=43101）不可重试', () => {
  assert(subscribe.isRetryableError(43101, 'errcode') === false, '用户拒绝不可重试');
});

check('用户未订阅（errcode=43102）不可重试', () => {
  assert(subscribe.isRetryableError(43102, 'errcode') === false, '未订阅不可重试');
});

check('openid 无效（errcode=43004）不可重试', () => {
  assert(subscribe.isRetryableError(43004, 'errcode') === false, 'openid 无效不可重试');
});

check('template_id 无效（errcode=40037）不可重试', () => {
  assert(subscribe.isRetryableError(40037, 'errcode') === false, 'template_id 无效不可重试');
});

check('page 路径无效（errcode=41030）不可重试', () => {
  assert(subscribe.isRetryableError(41030, 'errcode') === false, 'page 无效不可重试');
});

check('模板参数错误（errcode=47003）不可重试', () => {
  assert(subscribe.isRetryableError(47003, 'errcode') === false, '模板参数错误不可重试');
});

check('成功状态（errcode=0）不可重试', () => {
  assert(subscribe.isRetryableError(0, 'ok') === false, '成功状态不应重试');
});

// ===== 6. backoffMs 指数退避计算 =====
section('\n--- backoffMs 指数退避 ---');

check('backoffMs(0) = 基数（2000ms）', () => {
  // config.subscribe.retryBaseMs 默认 2000
  assert(subscribe.backoffMs(0) === 2000, 'backoffMs(0) 应为 2000，实际: ' + subscribe.backoffMs(0));
});

check('backoffMs(1) = 2 * 基数（4000ms）', () => {
  assert(subscribe.backoffMs(1) === 4000, 'backoffMs(1) 应为 4000，实际: ' + subscribe.backoffMs(1));
});

check('backoffMs(2) = 4 * 基数（8000ms）', () => {
  assert(subscribe.backoffMs(2) === 8000, 'backoffMs(2) 应为 8000，实际: ' + subscribe.backoffMs(2));
});

check('backoffMs 封顶 RETRY_MAX_MS（30000ms）', () => {
  // 2^10 * 2000 = 2048000 > 30000，应封顶
  assert(subscribe.backoffMs(10) === 30000, 'backoffMs(10) 应封顶为 30000，实际: ' + subscribe.backoffMs(10));
});

// ===== 7. sendSubscribeMessage 端到端测试 =====
section('\n--- sendSubscribeMessage 重试行为 ---');

const defaultOpts = {
  toUser: 'openid_abcdef1234567890',
  data: { thing1: { value: '测试赛事' }, thing2: { value: '今天 18:00' }, thing6: { value: 'TeamA VS TeamB' }, thing5: { value: '即将开始' } },
  page: '/pages/index/index',
  matchId: 'test_match_1',
  leagueName: '测试联赛'
};

check('成功 → 不重试（attempts=1）', async () => {
  // 清空发送日志
  storage.dota2_sub_send_log = [];
  callFunctionHandler = function (opts) {
    opts.success({ result: { errcode: 0, errmsg: 'ok', msgid: 'msgid_123' } });
  };
  try {
    const r = await subscribe.sendSubscribeMessage(defaultOpts);
    assert(r.ok === true, '应成功');
    assert(r.attempts === 1, 'attempts 应为 1，实际: ' + r.attempts);
    assert(r.msgid === 'msgid_123', 'msgid 应为 msgid_123');
    // 日志应只记录一次
    const log = storage.dota2_sub_send_log;
    assert(Array.isArray(log) && log.length === 1, '日志应只有 1 条，实际: ' + log.length);
    assert(log[0].status === 'ok', '日志 status 应为 ok');
    assert(log[0].attempts === 1, '日志 attempts 应为 1');
    assert(log[0].retried === false, '日志 retried 应为 false');
  } finally {
    callFunctionHandler = function (opts) {
      if (opts.fail) opts.fail({ errMsg: 'cloud:fail (mock network down)' });
    };
  }
});

check('不可重试错误 → 立即返回（attempts=1）', async () => {
  storage.dota2_sub_send_log = [];
  callFunctionHandler = function (opts) {
    // 用户拒绝订阅，不可重试
    opts.success({ result: { errcode: 43101, errmsg: 'user refuse to accept' } });
  };
  try {
    const r = await subscribe.sendSubscribeMessage(defaultOpts);
    assert(r.ok === false, '应失败');
    assert(r.attempts === 1, 'attempts 应为 1（不重试），实际: ' + r.attempts);
    assert(r.errcode === 43101, 'errcode 应为 43101');
    assert(r.error === 'errcode_43101', 'error 应为 errcode_43101，实际: ' + r.error);
    // 日志只 1 条
    const log = storage.dota2_sub_send_log;
    assert(Array.isArray(log) && log.length === 1, '日志应只有 1 条');
    assert(log[0].status === 'error', '日志 status 应为 error');
    assert(log[0].retried === false, '不应标记为 retried');
  } finally {
    callFunctionHandler = function (opts) {
      if (opts.fail) opts.fail({ errMsg: 'cloud:fail (mock network down)' });
    };
  }
});

check('网络失败 → 重试 2 次后仍失败（attempts=3）', async () => {
  storage.dota2_sub_send_log = [];
  let callCount = 0;
  callFunctionHandler = function (opts) {
    callCount++;
    // 始终网络失败（可重试）
    if (opts.fail) opts.fail({ errMsg: 'cloud:fail (mock network down)' });
  };
  try {
    const r = await subscribe.sendSubscribeMessage(defaultOpts);
    assert(r.ok === false, '应失败');
    assert(r.attempts === 3, 'attempts 应为 3（1+2 次重试），实际: ' + r.attempts);
    assert(r.error === 'cloud_fail', 'error 应为 cloud_fail');
    assert(callCount === 3, '应调用 callFunction 3 次，实际: ' + callCount);
    // 日志只 1 条（最终结果）
    const log = storage.dota2_sub_send_log;
    assert(Array.isArray(log) && log.length === 1, '日志应只有 1 条');
    assert(log[0].status === 'cloud_fail', '日志 status 应为 cloud_fail');
    assert(log[0].attempts === 3, '日志 attempts 应为 3');
    assert(log[0].retried === true, '日志 retried 应为 true');
  } finally {
    callFunctionHandler = function (opts) {
      if (opts.fail) opts.fail({ errMsg: 'cloud:fail (mock network down)' });
    };
  }
});

check('限频（45009）→ 重试后成功（attempts=2）', async () => {
  storage.dota2_sub_send_log = [];
  let callCount = 0;
  callFunctionHandler = function (opts) {
    callCount++;
    if (callCount === 1) {
      // 第一次：限频（可重试）
      opts.success({ result: { errcode: 45009, errmsg: 'reach max api daily limit' } });
    } else {
      // 第二次：成功
      opts.success({ result: { errcode: 0, errmsg: 'ok', msgid: 'msgid_456' } });
    }
  };
  try {
    const r = await subscribe.sendSubscribeMessage(defaultOpts);
    assert(r.ok === true, '应最终成功');
    assert(r.attempts === 2, 'attempts 应为 2（1+1 次重试），实际: ' + r.attempts);
    assert(r.msgid === 'msgid_456', 'msgid 应为 msgid_456');
    assert(callCount === 2, '应调用 callFunction 2 次，实际: ' + callCount);
    // 日志只 1 条（最终成功）
    const log = storage.dota2_sub_send_log;
    assert(Array.isArray(log) && log.length === 1, '日志应只有 1 条');
    assert(log[0].status === 'ok', '日志 status 应为 ok');
    assert(log[0].attempts === 2, '日志 attempts 应为 2');
    assert(log[0].retried === true, '日志 retried 应为 true');
  } finally {
    callFunctionHandler = function (opts) {
      if (opts.fail) opts.fail({ errMsg: 'cloud:fail (mock network down)' });
    };
  }
});

check('系统繁忙（-1）→ 重试 2 次仍失败（attempts=3）', async () => {
  storage.dota2_sub_send_log = [];
  let callCount = 0;
  callFunctionHandler = function (opts) {
    callCount++;
    // 始终返回系统繁忙（可重试）
    opts.success({ result: { errcode: -1, errmsg: 'system busy' } });
  };
  try {
    const r = await subscribe.sendSubscribeMessage(defaultOpts);
    assert(r.ok === false, '应失败');
    assert(r.attempts === 3, 'attempts 应为 3，实际: ' + r.attempts);
    assert(r.errcode === -1, 'errcode 应为 -1');
    assert(callCount === 3, '应调用 callFunction 3 次，实际: ' + callCount);
  } finally {
    callFunctionHandler = function (opts) {
      if (opts.fail) opts.fail({ errMsg: 'cloud:fail (mock network down)' });
    };
  }
});

check('第一次网络失败 → 第二次成功（attempts=2）', async () => {
  storage.dota2_sub_send_log = [];
  let callCount = 0;
  callFunctionHandler = function (opts) {
    callCount++;
    if (callCount === 1) {
      if (opts.fail) opts.fail({ errMsg: 'cloud:fail (timeout)' });
    } else {
      opts.success({ result: { errcode: 0, errmsg: 'ok', msgid: 'msgid_789' } });
    }
  };
  try {
    const r = await subscribe.sendSubscribeMessage(defaultOpts);
    assert(r.ok === true, '应最终成功');
    assert(r.attempts === 2, 'attempts 应为 2，实际: ' + r.attempts);
    assert(r.msgid === 'msgid_789', 'msgid 应为 msgid_789');
  } finally {
    callFunctionHandler = function (opts) {
      if (opts.fail) opts.fail({ errMsg: 'cloud:fail (mock network down)' });
    };
  }
});

// ===== 运行全部测试 =====
async function runAll() {
  for (const t of tests) {
    if (t.kind === 'section') { console.log(t.title); continue; }
    try {
      await t.fn();
      passed++;
      console.log('PASS  ' + t.label);
    } catch (e) {
      failed++;
      console.log('FAIL  ' + t.label + '  ->  ' + (e && e.message || e));
    }
  }
  console.log('\n=== 结果 ===');
  console.log('通过: ' + passed + '  失败: ' + failed);
  console.log(failed === 0 ? '全部通过 ✅' : '存在失败 ❌');
  process.exit(failed === 0 ? 0 : 1);
}

runAll();
