// scripts/test-remote-curation.js
// 远程 curation 覆盖层单测（mock wx.request + wx.Storage）。不联网。

'use strict';

const storage = {};
let requestHandler = null;

global.wx = {
  getStorageSync: function (k) { return storage[k] || null; },
  setStorageSync: function (k, v) { storage[k] = v; },
  removeStorageSync: function (k) { delete storage[k]; },
  getStorageInfoSync: function () { return { keys: Object.keys(storage) }; },
  request: function (opts) { requestHandler = opts; }
};

function fireRequest(statusCode, data) {
  if (!requestHandler) throw new Error('no pending request');
  const h = requestHandler;
  requestHandler = null;
  if (statusCode >= 200 && statusCode < 300) {
    h.success({ statusCode: statusCode, data: data });
  } else {
    h.fail({ errMsg: 'mock fail' });
  }
}

const config = require('../utils/config.js');
const remoteCuration = require('../utils/remoteCuration.js');

let passed = 0;
let failed = 0;
function check(label, fn) {
  try { fn(); passed++; console.log('PASS  ' + label); }
  catch (e) { failed++; console.log('FAIL  ' + label + '  ->  ' + e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

function main() {
  // ===== 1. url 为空时仅用本地 =====
  check('本地兜底: curatedEventFor 返回本地 TI', function () {
    assert(config.remoteCuration.url === '', '测试用空 url');
    const ev = remoteCuration.curatedEventFor('The International 2024');
    assert(ev && ev.tier && ev.tier.grade === 'SSS', '应命中本地 TI');
  });

  check('本地兜底: curatedTeamFor 按 id 命中本地战队', function () {
    const t = remoteCuration.curatedTeamFor(15);
    assert(t && t.name === 'LGD Gaming', 'name=' + (t && t.name));
  });

  check('本地兜底: curatedTeamFor 按名命中', function () {
    const t = remoteCuration.curatedTeamFor('Team Spirit');
    assert(t && t.name === 'Team Spirit');
  });

  // ===== 2. buildEffective 验证合并逻辑 =====
  check('buildEffective: 空远程 = 本地不变', function () {
    const eff = remoteCuration.buildEffective({ events: [], teams: {} });
    assert(eff.events.length > 10, 'events 应保留本地全部: ' + eff.events.length);
    assert(eff.teams[15] && eff.teams[15].name === 'LGD Gaming', 'teams 应保留本地');
  });

  check('buildEffective: 远程覆盖同键事件', function () {
    const eff = remoteCuration.buildEffective({
      events: [{ canonical: 'The International 2024', tier: { grade: 'S', rank: 3, label: '测试覆盖' }, aliases: ['ti2024'] }],
      teams: {}
    });
    const ev = eff.events.find(function (e) { return e.canonical === 'The International 2024'; });
    assert(ev && ev.tier.grade === 'S', '应被远程覆盖: grade=' + (ev ? ev.tier.grade : 'undefined'));
  });

  check('buildEffective: 远程追加新事件', function () {
    const eff = remoteCuration.buildEffective({
      events: [{ canonical: 'New Tournament 2026', tier: { grade: 'SSS', rank: 4, label: '新增' }, aliases: ['new2026'] }],
      teams: {}
    });
    const ev = eff.events.find(function (e) { return e.canonical === 'New Tournament 2026'; });
    assert(ev && ev.tier.grade === 'SSS', '应追加新事件');
  });

  check('buildEffective: 远程追加新战队', function () {
    const eff = remoteCuration.buildEffective({
      events: [], teams: { 99999: { name: 'New Team', tag: 'NT', country: 'XX', aliases: ['newteam'] } }
    });
    assert(eff.teams[99999] && eff.teams[99999].name === 'New Team', '应追加新战队');
  });

  // ===== 3. 模拟远程拉取（异步）=====
  console.log('\n--- async ---');
  return runAsync(function () {
    // 3a. 成功拉取
    Object.keys(storage).forEach(function (k) { delete storage[k]; });
    config.remoteCuration.url = 'https://example.com/curation.json';
    var p = remoteCuration.load(false);
    assert(requestHandler, '应触发了 wx.request');
    fireRequest(200, {
      events: [{ canonical: 'Remote Event', tier: { grade: 'A', rank: 2, label: '远程' }, aliases: ['remote'] }],
      teams: { 99999: { name: 'Remote Team', tag: 'RT', country: 'XX', aliases: ['remoteteam'] } }
    });
    return p.then(function (changed) {
      assert(changed === true, '成功应返回 true');
      var ev = remoteCuration.curatedEventFor('Remote Event');
      assert(ev && ev.tier.grade === 'A', '远程事件命中');
      var t = remoteCuration.curatedTeamFor(99999);
      assert(t && t.name === 'Remote Team', '远程战队命中');
      console.log('PASS  load: 远程拉取成功覆盖');
      return true;
    }).catch(function (e) { throw e; });
  }).then(function () {
    return runAsync(function () {
      // 3b. 网络失败回退
      Object.keys(storage).forEach(function (k) { delete storage[k]; });
      config.remoteCuration.url = 'https://example.com/curation.json';
      var p = remoteCuration.load(true);
      assert(requestHandler, '应触发了 wx.request');
      fireRequest(500, null);
      return p.then(function (changed) {
        assert(changed === false, '失败应返回 false');
        var ev = remoteCuration.curatedEventFor('The International 2024');
        assert(ev && ev.tier.grade === 'SSS', '回退到本地 TI');
        console.log('PASS  load: 网络失败回退本地');
        return true;
      }).catch(function (e) { throw e; });
    });
  }).then(function () {
    config.remoteCuration.url = '';
    console.log('\n' + passed + ' passed, ' + failed + ' failed');
    process.exit(failed ? 1 : 0);
  }).catch(function (e) {
    failed++; console.log('FAIL  async  ->  ' + e.message);
    console.log('\n' + passed + ' passed, ' + failed + ' failed');
    process.exit(1);
  });
}

function runAsync(fn) {
  return Promise.resolve().then(function () {
    var result = fn();
    if (result && typeof result.then === 'function') return result;
    return Promise.resolve();
  }).then(function () {
    passed++;
    return true;
  });
}

main();
