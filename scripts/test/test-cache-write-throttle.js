#!/usr/bin/env node
/**
 * scripts/test/test-cache-write-throttle.js
 * 本地缓存写入路径节流单测（★ 2026-11-15）
 *
 * 背景：cache.set() 原实现每次写入都调 prune()（至少一次 getStorageInfoSync 同步桥调用）。
 *   现改为：小值每 10 次写检查一次；大值（≥128KB 字符）立即检查；写入异常时必定检查。
 * 本用例用 mock wx 统计 getStorageInfoSync 的调用次数，锁定节流行为。
 *
 * 运行：node scripts/test/test-cache-write-throttle.js
 */
'use strict';

let storage = {};
let infoCalls = 0;
let failNextSet = false;

global.wx = {
  getStorageSync: function (k) { return storage[k] == null ? '' : storage[k]; },
  setStorageSync: function (k, v) {
    if (failNextSet) { failNextSet = false; throw new Error('quota exceeded'); }
    storage[k] = v;
  },
  removeStorageSync: function (k) { delete storage[k]; },
  getStorageInfoSync: function () {
    infoCalls++;
    return { keys: Object.keys(storage), currentSize: 1 };
  }
};

const cache = require('../../utils/cache.js');

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + '  ->  ' + (detail || '')); }
}

// ① 前 9 次小写入不触发容量检查
infoCalls = 0;
for (let i = 0; i < 9; i++) cache.set('small' + i, { v: i }, 60);
assert('① 前 9 次小写入不调用 getStorageInfoSync（节流生效）', infoCalls === 0, 'infoCalls=' + infoCalls);

// ② 第 10 次小写入触发一次检查
cache.set('small9', { v: 9 }, 60);
assert('② 第 10 次小写入触发 1 次容量检查', infoCalls === 1, 'infoCalls=' + infoCalls);

// ③ 大值立即触发检查（130KB 字符）
const big = 'x'.repeat(130 * 1024);
cache.set('big', big, 60);
assert('③ 大值（≥128KB）写入立即触发检查', infoCalls === 2, 'infoCalls=' + infoCalls);

// ④ 写入抛错时必定检查（兜底腾空间）
infoCalls = 0;
failNextSet = true;
cache.set('willFail', 'v', 60);
assert('④ 写入抛错时仍触发 1 次容量检查', infoCalls === 1, 'infoCalls=' + infoCalls);

// ⑤ 正常读写不受影响
const got = cache.get('small0', 60);
assert('⑤ 读回正常（缓存值未被节流破坏）', got && got.v === 0, JSON.stringify(got));

console.log('\n===== test-cache-write-throttle: ' + pass + ' passed, ' + fail + ' failed =====');
if (fail > 0) process.exit(1);
