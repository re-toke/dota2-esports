// scripts/test/test-observability.js
// ★★ 2026-10-14（P2-23）：可观测性补强 —— EF / 中转 / 卡片质量失败上报单测。
//   覆盖 utils/monitor.js 新增的三个发射器（efFailure / relayFailover / cardQuality）+ 同会话去重 + 无 wx 安全降级。
//   纯离线：stub wx.reportAnalytics 捕获事件，不联网、不依赖其它 utils（monitor 零依赖）。
//
// 运行：node scripts/test/test-observability.js

'use strict';

const path = require('path');

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + '  ->  ' + (detail || '')); }
}

// ===== stub wx：捕获 reportAnalytics + 非 devtools（canReport 条件成立）=====
const captured = [];
global.wx = {
  getDeviceInfo: function () { return { platform: 'ios' }; },
  reportAnalytics: function (ev, data) { captured.push({ ev: ev, data: data || {} }); }
};

// 清缓存 → 拿到全新 _seen（去重集合），保证断言从零开始
for (const k of Object.keys(require.cache)) {
  if (k.indexOf('monitor.js') >= 0) delete require.cache[k];
}
const monitor = require(path.join(__dirname, '..', '..', 'utils', 'monitor.js'));

function countOf(ev) { return captured.filter(function (x) { return x.ev === ev; }).length; }
function lastOf(ev) { const a = captured.filter(function (x) { return x.ev === ev; }); return a[a.length - 1]; }

console.log('--- observability (P2-23) ---');

// ===== ① efFailure =====
monitor.efFailure('opendota-proxy', 'getLeagues', 'count_fail');
assert('efFailure：上报 ef_failure 事件', countOf('ef_failure') === 1);
const e1 = lastOf('ef_failure');
assert('efFailure：载荷含 ef/action/reason',
  e1.data.ef === 'opendota-proxy' && e1.data.action === 'getLeagues' && e1.data.reason === 'count_fail',
  JSON.stringify(e1.data));
monitor.efFailure('opendota-proxy', 'getLeagues', 'count_fail');
assert('efFailure：同 ef|action 去重（第二次不上报）', countOf('ef_failure') === 1);
monitor.efFailure('opendota-proxy', 'getProMatches', 'count_fail');
assert('efFailure：不同 action 单独上报', countOf('ef_failure') === 2);
monitor.efFailure('bundle-aggregator', '', 'count_fail');
assert('efFailure：无 action（空串）亦上报（独立键）', countOf('ef_failure') === 3);

// ===== ② relayFailover =====
monitor.relayFailover('a.deno.net', 'edge_fail');
assert('relayFailover：上报 relay_failover 事件', countOf('relay_failover') === 1);
assert('relayFailover：载荷含 host/reason',
  lastOf('relay_failover').data.host === 'a.deno.net' && lastOf('relay_failover').data.reason === 'edge_fail');
monitor.relayFailover('a.deno.net', 'rest_fail');
assert('relayFailover：同宿主去重（第二次不上报）', countOf('relay_failover') === 1);
monitor.relayFailover('b.netlify.app', 'edge_fail');
assert('relayFailover：不同宿主单独上报', countOf('relay_failover') === 2);

// ===== ③ cardQuality =====
monitor.cardQuality({ total: 0, pass: { dupCardRateStrict: false, statusMismatch: true, endedNoScore: true } });
assert('cardQuality：空页（total=0）不上报', countOf('card_quality_violation') === 0);
monitor.cardQuality({ total: 8, pass: { dupCardRateStrict: true, statusMismatch: true, endedNoScore: true } });
assert('cardQuality：全达标轮次不上报', countOf('card_quality_violation') === 0);
const badM = {
  total: 8, dupGroupsStrict: 2, statusMismatch: 0, endedNoScore: 0,
  pass: { dupCardRateStrict: false, statusMismatch: true, endedNoScore: true }
};
monitor.cardQuality(badM);
assert('cardQuality：存在违例即上报', countOf('card_quality_violation') === 1);
const cq = lastOf('card_quality_violation');
assert('cardQuality：载荷含 kinds/total', cq.data.kinds === 'dup_strict' && cq.data.total === '8', JSON.stringify(cq.data));
monitor.cardQuality(badM);
assert('cardQuality：同类违例组合去重（第二次不上报）', countOf('card_quality_violation') === 1);
monitor.cardQuality({ total: 5, statusMismatch: 1, pass: { dupCardRateStrict: true, statusMismatch: false, endedNoScore: true } });
assert('cardQuality：不同违例组合单独上报', countOf('card_quality_violation') === 2);
monitor.cardQuality(null);
assert('cardQuality：null 入参不抛错亦不上报', countOf('card_quality_violation') === 2);

// ===== ④ 无 wx 时安全降级（no-op 不抛错）=====
const savedWx = global.wx;
global.wx = undefined;
let threw = false;
try {
  monitor.efFailure('x-proxy', 'y', 'z');
  monitor.relayFailover('h');
  monitor.cardQuality(badM);
} catch (e) { threw = true; }
assert('无 wx：三个新发射器均 no-op 不抛错', !threw);
global.wx = savedWx;

console.log('\n=== 结果 ===');
console.log('PASS: ' + pass + ', FAIL: ' + fail);
process.exit(fail ? 1 : 0);
