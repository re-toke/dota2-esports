// scripts/test/test-upcoming-snapshot.js
// ★★ 2026-10-14（P2-24）：`utils/upcomingSnapshot.js`（从 sources.js 抽出的「即将到来」本地快照装载器）单测。
//   验证：① 装载成功且形状正确（generatedAt + events 数组）；② 装载结果带模块级缓存（同一引用，二次调用不重复 IO）。
//   纯离线：无 wx / 网络依赖，不依赖 sources.js（正是抽出该模块的目的）。
//
// 运行：node scripts/test/test-upcoming-snapshot.js

'use strict';

const path = require('path');
const S = require(path.join(__dirname, '..', '..', 'utils', 'upcomingSnapshot.js'));

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + '  ->  ' + (detail || '')); }
}

console.log('--- upcomingSnapshot ---');

assert('导出 getUpcomingLocalSnapshot / loadUpcomingLocalSnapshot 均为函数',
  typeof S.getUpcomingLocalSnapshot === 'function' && typeof S.loadUpcomingLocalSnapshot === 'function');

const snap = S.getUpcomingLocalSnapshot();
assert('getUpcomingLocalSnapshot：装载成功（非 null）', !!(snap && typeof snap === 'object'), 'snap=' + snap);
assert('getUpcomingLocalSnapshot：形状正确（events 为数组且非空）',
  Array.isArray(snap.events) && snap.events.length > 0, 'len=' + (snap && snap.events ? snap.events.length : 'n/a'));
assert('getUpcomingLocalSnapshot：generatedAt 为数值',
  typeof snap.generatedAt === 'number');

// 缓存：二次调用返回同一引用（模块级 _upcomingLocalSnapshot 生效）
assert('★缓存生效：getUpcomingLocalSnapshot 二次调用返回同一引用',
  S.getUpcomingLocalSnapshot() === snap);
assert('★缓存生效：loadUpcomingLocalSnapshot 亦返回同一引用',
  S.loadUpcomingLocalSnapshot() === snap);

console.log('\n=== 结果 ===');
console.log('PASS: ' + pass + ', FAIL: ' + fail);
process.exit(fail ? 1 : 0);
