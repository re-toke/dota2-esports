// scripts/test-search-history.js
// 本地搜索历史（utils/searchHistory.js）单测。mock wx.Storage，不联网。

'use strict';

const storage = {};
global.wx = {
  getStorageSync: function (k) { return storage[k] || null; },
  setStorageSync: function (k, v) { storage[k] = v; },
  removeStorageSync: function (k) { delete storage[k]; }
};

const sh = require('../../utils/searchHistory.js');

let passed = 0;
let failed = 0;
function check(label, fn) {
  try { fn(); passed++; console.log('PASS  ' + label); }
  catch (e) { failed++; console.log('FAIL  ' + label + '  ->  ' + e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

// 初始为空
check('get: 初始为空数组', () => assert(Array.isArray(sh.get('teams')) && sh.get('teams').length === 0));

// 新增并置顶
check('add: 新增并置顶', () => {
  const l = sh.add('teams', 'LGD');
  assert(l.length === 1 && l[0] === 'LGD', JSON.stringify(l));
});

// 去重：重复添加不增加长度，但置顶
check('add: 重复词去重并置顶', () => {
  sh.add('teams', 'Secret');
  sh.add('teams', 'LGD'); // 重复，应回到顶部
  const l = sh.get('teams');
  assert(l.length === 2, 'len=' + l.length);
  assert(l[0] === 'LGD' && l[1] === 'Secret', JSON.stringify(l));
});

// 空词不写入
check('add: 空词不写入', () => {
  const before = sh.get('teams').length;
  const l = sh.add('teams', '   ');
  assert(l.length === before, 'len=' + l.length);
});

// 容量上限 MAX=10
check('add: 超过上限只保留最近 10 条', () => {
  Object.keys(storage).forEach((k) => delete storage[k]); // 重置
  for (let i = 1; i <= 15; i++) sh.add('teams', 'k' + i);
  const l = sh.get('teams');
  assert(l.length === sh.MAX, 'len=' + l.length);
  assert(l[0] === 'k15', '最新应在头部: ' + l[0]);
});

// remove
check('remove: 删除单个', () => {
  sh.add('teams', 'temp');
  const l = sh.remove('teams', 'temp');
  assert(l.indexOf('temp') === -1, '应已移除');
});

// clear
check('clear: 清空', () => {
  sh.clear('teams');
  assert(sh.get('teams').length === 0, '应已清空');
});

// 类型隔离：不同 type 互不影响
check('隔离: 不同 type 独立存储', () => {
  sh.add('teams', 'A');
  sh.add('players', 'B');
  assert(sh.get('teams')[0] === 'A' && sh.get('players')[0] === 'B', 'type 应隔离');
  sh.clear('teams'); sh.clear('players');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
