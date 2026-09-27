#!/usr/bin/env node
/**
 * scripts/test/test-snapshot-layers.js
 * 「快照 / 首屏三层 + 数据健康口径」防护测试（2026-09-27 · R9 落地）
 *
 * 覆盖四组：
 *  ① ★★ **O-4 writeThrough 写穿 key 修复的回归守卫**（最高价值）
 *     旧实现把「响应体」当参数拼进 key ⇒ 写穿条目**永远读不到**（O-4 静默失效 + 存储膨胀）。
 *     本组断言：云路径写穿后，`peekLeagues()`（第①层）**必须命中**。
 *  ② `peekLeagues` 三态：命中 / 空 / **与 getLeagues 同口径**（过 filterCollectableLeagues）
 *  ③ 两个快照阈值的关系（语义不同但必须有序）：可用性阈值 > 提示阈值
 *  ④ 数据健康口径（R2/R3）：24h 判定**只在云端心跳行**，**不得**再挂在「内置快照」行
 *
 * 运行：node scripts/test/test-snapshot-layers.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + '  ->  ' + (detail || '')); }
}
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ===== mock wx（storage 必须有：cache.js 全走 wx.getStorageSync/setStorageSync）=====
const storage = {};
global.wx = {
  getStorageSync: function (k) { return storage[k] === undefined ? '' : storage[k]; },
  setStorageSync: function (k, v) { storage[k] = v; },
  removeStorageSync: function (k) { delete storage[k]; },
  getStorageInfoSync: function () { return { keys: Object.keys(storage) }; },
  request: function (opts) { if (opts && opts.fail) opts.fail({ errMsg: 'mock: no network' }); },
  connectSocket: function () { throw new Error('mock: no socket'); },
};

const api = require(path.join(ROOT, 'utils', 'api.js'));
const cache = require(path.join(ROOT, 'utils', 'cache.js'));
const curationShared = require(path.join(ROOT, 'utils', 'curation-shared.js'));

const LEAGUES = [
  { leagueid: 20279, name: 'PGL Wallachia Season 9', tier: 'premium' },
  { leagueid: 19719, name: 'The International 2026', tier: 'excluded' },   // 靠名字白名单保留
  { leagueid: 90001, name: '肛宝联赛-老婆杯', tier: 'professional' },        // 应被闸门剔除（真实案例）
];

console.log('\n--- ① ★★ O-4 写穿 key 修复回归守卫（旧实现使写穿条目永远读不到）---');
assert('api 已导出 writeThrough / peekLeagues（供测试与诊断复用）',
  typeof api.writeThrough === 'function' && typeof api.peekLeagues === 'function',
  'writeThrough=' + typeof api.writeThrough + ' peekLeagues=' + typeof api.peekLeagues);

// 模拟**云（EF）成功路径**写穿：旧实现 writeThrough(path, raw, ttl) ⇒ key 含整个响应 ⇒ 读不到
api.writeThrough('/leagues', undefined, LEAGUES, 3600);
const keys = Object.keys(storage);
console.log('    storage keys = ' + JSON.stringify(keys));
assert('★ 写穿只用 1 个 key（旧实现每次响应都会产生新 key ⇒ 存储膨胀）',
  keys.length === 1, '实际 ' + keys.length + ' 个：' + keys.join(' , '));
assert('★ 写穿 key **不得**包含响应内容（旧 bug 的指纹：key 里含 leagueid）',
  keys.length === 1 && keys[0].indexOf('leagueid') < 0, keys[0] || '');
// ⚠️ key 会经 cache.js 加 `dota2_cache_` PREFIX ⇒ 用 endsWith 判"口径一致"，不要用 ===
assert('写穿 key 与读侧口径一致（cache PREFIX + _v() + path + "|{}"）',
  keys.length === 1 && keys[0].endsWith((curationShared.dataVersion + ':') + '/leagues|{}'),
  keys[0] || '');

const peeked = api.peekLeagues();
assert('★★ peekLeagues() 能命中云路径写穿的数据（O-4 真正生效）', !!peeked && !!peeked.leagues,
  JSON.stringify(peeked && peeked.leagues && peeked.leagues.length));
assert('peekLeagues() 带回真实 fetchedAt（供「更新于 X 前」展示）',
  !!peeked && typeof peeked.fetchedAt === 'number' && peeked.fetchedAt > 0,
  peeked && String(peeked.fetchedAt));

console.log('\n--- ② peekLeagues 三态与口径一致性 ---');
assert('★ 口径一致：peekLeagues 必须过 filterCollectableLeagues（否则首屏/网络集合不一致）',
  !!peeked && peeked.leagues.length === 2, '实际 ' + (peeked && peeked.leagues.length));
assert('闸门生效：junk 联赛（肛宝联赛-老婆杯）被剔除',
  !!peeked && peeked.leagues.every((l) => l.name !== '肛宝联赛-老婆杯'));
assert('闸门保留：excluded 但名字白名单命中的 The International 仍保留',
  !!peeked && peeked.leagues.some((l) => l.leagueid === 19719));

// 空缓存 → null（不抛错）
const saved = storage[Object.keys(storage)[0]];
delete storage[Object.keys(storage)[0]];
assert('空缓存 ⇒ 返回 null（不抛错，首屏继续走下一层）', api.peekLeagues() === null);
storage[(curationShared.dataVersion + ':') + '/leagues|{}'] = saved;

console.log('\n--- ③ 两个快照阈值的关系（语义不同，但必须有序）---');
const ls = read('pages/leagues/leagues.js');
const num = (name) => {
  const m = ls.match(new RegExp('const\\s+' + name + '\\s*=\\s*([0-9*\\s]+);'));
  if (!m) return null;
  const e = m[1].replace(/\s/g, '');
  return /^[0-9*]+$/.test(e) ? e.split('*').reduce((a, b) => a * Number(b), 1) : null;
};
const STALE = num('SNAPSHOT_MAX_AGE_SEC');
const UNUSABLE = num('SNAPSHOT_UNUSABLE_AGE_SEC');
console.log('    SNAPSHOT_MAX_AGE_SEC=' + STALE + '（' + (STALE / 86400) + ' 天）, SNAPSHOT_UNUSABLE_AGE_SEC=' +
  UNUSABLE + '（' + (UNUSABLE / 86400) + ' 天）');
assert('★ 可用性阈值必须**严于**提示阈值（否则"不可用"永不触发 / 语义自相矛盾）',
  UNUSABLE != null && STALE != null && UNUSABLE > STALE, 'unusable=' + UNUSABLE + ' stale=' + STALE);
assert('页面提供 _snapshotIsTooOld（硬门限），且与 _snapshotIsStale 并存（两个量分开）',
  ls.indexOf('_snapshotIsTooOld(') >= 0 && ls.indexOf('_snapshotIsStale(') >= 0);

console.log('\n--- ④ 数据健康口径：24h 判定只在云端心跳行（R2/R3）---');
const wxml = read('pages/follow/follow.wxml');
assert('★ 「内置快照」行**不得**再出现 overTarget 告警（它会永久红灯 ⇒ 告警疲劳）',
  wxml.indexOf('health.overTarget') < 0, '仍存在 health.overTarget 引用');
assert('★ 「内置快照」行须明确标注更新方式（随版本发布更新）',
  wxml.indexOf('内置快照更新于') >= 0 && wxml.indexOf('随版本发布更新') >= 0);
assert('云端心跳行仍渲染纯函数文案 health.remote.text',
  wxml.indexOf('health.remote.text') >= 0);
const fj = read('pages/follow/follow.js');
assert('★ follow.js 不再向 health 暴露 overTarget/targetHours（防后人把告警加回来）',
  fj.indexOf('overTarget: _fresh.overTarget') < 0 && fj.indexOf('targetHours:') < 0);
const diag = read('utils/diagnostics.js');
assert('★ 24h 目标改由云端心跳文案承载（buildRemoteHealth 显式写出「24h 目标」）',
  diag.indexOf('已超 24h 目标') >= 0);

console.log('\n--- ⑤ 守卫可证伪性（对源码做变异，判据必须由 true 变 false）---');
{
  // 变异 1：把 wxml 的 overTarget 加回去 → 「不得出现 overTarget」必须变 false
  const mut1 = wxml.replace('内置快照更新于', '{{health.overTarget}}内置快照更新于');
  assert('变异1 确实改到了 wxml', mut1 !== wxml);
  assert('变异1：「不得出现 overTarget」应判 false', mut1.indexOf('health.overTarget') >= 0);
  // 变异 2：把「随版本发布更新」删掉 → 标注判据应变 false
  const mut2 = wxml.replace('随版本发布更新', '');
  assert('变异2 确实改到了 wxml', mut2 !== wxml);
  assert('变异2：「须标注更新方式」应判 false',
    !(mut2.indexOf('内置快照更新于') >= 0 && mut2.indexOf('随版本发布更新') >= 0));
  // 变异 3：把两个阈值改到相等 → 关系断言应变 false
  const mut3 = ls.replace('const SNAPSHOT_UNUSABLE_AGE_SEC = 30 * 86400;',
    'const SNAPSHOT_UNUSABLE_AGE_SEC = 7 * 86400;');
  assert('变异3 确实改到了源码', mut3 !== ls);
  const m3 = mut3.match(/const\s+SNAPSHOT_UNUSABLE_AGE_SEC\s*=\s*([0-9*\s]+);/);
  const u3 = m3[1].replace(/\s/g, '').split('*').reduce((a, b) => a * Number(b), 1);
  assert('变异3：「可用性>提示」应判 false', !(u3 > STALE), 'u3=' + u3);
}

console.log('\n=== 结果 ===');
console.log('通过: ' + pass + '  失败: ' + fail);
if (fail) { console.log('存在失败 ❌'); process.exit(1); }
console.log('全部通过 ✅');
