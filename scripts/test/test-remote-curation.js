// scripts/test-remote-curation.js
// 远程 curation 覆盖层单测（mock wx.request + wx.Storage）。不联网。

'use strict';

const storage = {};
let requestHandler = null;
// ★ 2026-08-11：remoteCuration 阶段1-③ 已改为云函数模式（wx.cloud.callFunction），
//   旧测试 mock 的 wx.request 已不适用，补 wx.cloud mock。
let cloudCallHandler = null;

global.wx = {
  getStorageSync: function (k) { return storage[k] || null; },
  setStorageSync: function (k, v) { storage[k] = v; },
  removeStorageSync: function (k) { delete storage[k]; },
  getStorageInfoSync: function () { return { keys: Object.keys(storage) }; },
  request: function (opts) { requestHandler = opts; },
  cloud: {
    // ★ 2026-08-11：remoteCuration 用 Promise 链（callFunction().then()），
    //   mock 返回可手动 resolve/reject 的 Promise，fireCloud/fireCloudFail 触发
    callFunction: function (opts) {
      cloudCallHandler = { opts: opts, resolve: null, reject: null };
      return new Promise(function (resolve, reject) {
        cloudCallHandler.resolve = resolve;
        cloudCallHandler.reject = reject;
      });
    }
  }
};

function fireCloud(result) {
  if (!cloudCallHandler || !cloudCallHandler.resolve) throw new Error('no pending cloud call');
  const h = cloudCallHandler;
  cloudCallHandler = null;
  h.resolve({ result: result });
}

function fireCloudFail(err) {
  if (!cloudCallHandler || !cloudCallHandler.reject) throw new Error('no pending cloud call');
  const h = cloudCallHandler;
  cloudCallHandler = null;
  h.reject(err || new Error('cloud call failed'));
}

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

const config = require('../../utils/config.js');
const curation = require('../../utils/curation.js');
const remoteCuration = require('../../utils/remoteCuration.js');

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
    assert(ev && ev.tier && ev.tier.grade === 'S', 'TI 系列 2026-07-30 起降为 S（原 SSS 断言过时）');
  });

  check('本地兜底: curatedTeamFor 按 id 命中本地战队', function () {
    const t = remoteCuration.curatedTeamFor(10150538);
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
    assert(eff.teams[10150538] && eff.teams[10150538].name === 'LGD Gaming', 'teams 应保留本地');
  });

  check('buildEffective: 远程覆盖同键事件', function () {
    const eff = remoteCuration.buildEffective({
      events: [{ canonical: 'The International 2024', tier: { grade: 'S', rank: 3, label: '测试覆盖' }, aliases: ['ti2024'] }],
      teams: {}
    });
    const ev = eff.events.find(function (e) { return e.canonical === 'The International 2024'; });
    assert(ev && ev.tier.grade === 'S', '应被远程覆盖: grade=' + (ev ? ev.tier.grade : 'undefined'));
  });

  // ★ 2026-08-11 回归：云端旧数据（缺 leagueId、participants 为数字）不得整条覆盖本地新字段。
  //   复现 TI 2026 参赛队伍全待定 BUG 的场景。
  check('buildEffective: 云端旧数据不覆盖本地新字段（TI 2026 回归）', function () {
    const localTi = curation.CURATED_EVENTS.find(function (e) { return e.canonical === 'The International 2026'; });
    assert(localTi && localTi.leagueId === 19719, '本地应有 leagueId=19719');
    assert(Array.isArray(localTi.participants) && localTi.participants.length === 16, '本地 participants 应为数组(16)');
    // 模拟云端旧数据：无 leagueId/legacyFakeId，participants 退化为数字 16
    const oldTi = {
      canonical: 'The International 2026',
      tier: localTi.tier,
      aliases: localTi.aliases,
      participants: 16,
      start: localTi.start,
      end: localTi.end
    };
    const eff = remoteCuration.buildEffective({ events: [oldTi], teams: {}, tiContestantIds: [] });
    const ev = eff.events.find(function (e) { return e.canonical === 'The International 2026'; });
    assert(ev && ev.leagueId === 19719, '字段级合并应保留本地 leagueId: ' + (ev && ev.leagueId));
    assert(ev && ev.legacyFakeId === -1653808, '字段级合并应保留本地 legacyFakeId: ' + (ev && ev.legacyFakeId));
    assert(Array.isArray(ev.participants) && ev.participants.length === 16, '本地 participants 数组应保留（防数字退化覆盖）: ' + typeof ev.participants);
  });

  check('buildEffective: 云端新数据可正常覆盖 participants 数组（热更可用）', function () {
    const eff = remoteCuration.buildEffective({
      events: [{
        canonical: 'The International 2026',
        participants: [{ name: 'Team A', region: 'EU' }, { name: 'Team B', region: 'CN' }]
      }],
      teams: {}
    });
    const ev = eff.events.find(function (e) { return e.canonical === 'The International 2026'; });
    assert(ev && Array.isArray(ev.participants) && ev.participants.length === 2, '云端数组应覆盖本地数组（热更）');
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

  // ===== 3. 模拟远程拉取（异步，云函数模式）=====
  console.log('\n--- async ---');
  return runAsync(function () {
    // ★ 2026-09-17 修复陈旧断言（原「应触发 wx.cloud.callFunction」自 2026-09-14
    //   Supabase 迁移后一直失败）：迁移后 remoteCuration.load() 默认走 PostgREST 直读，
    //   云函数已退化为「回落路径」。本用例专门验证**云函数链路**（= 当前的回滚路径，
    //   云开发下线前必须可用），故显式关闭 Supabase 以强制走云函数分支。
    //   ⚠️ 该断言失败会让 test:all 的 && 链在此中断 —— 其后的 check-token-overreach /
    //      check-card-contract 等门禁全部不会执行，是"接线了却跑不到"的典型。
    if (config.supabase) config.supabase.enabled = false;
    // 3a. 成功拉取（云函数 getCuration）
    Object.keys(storage).forEach(function (k) { delete storage[k]; });
    var p = remoteCuration.load(true);
    assert(cloudCallHandler, '应触发 wx.cloud.callFunction（已强制关闭 Supabase 直读）');
    fireCloud({
      data: {
        events: [{ canonical: 'Remote Event', tier: { grade: 'A', rank: 2, label: '远程' }, aliases: ['remote'] }],
        teams: { 99999: { name: 'Remote Team', tag: 'RT', country: 'XX', aliases: ['remoteteam'] } }
      },
      version: 'v-test'
    });
    return p.then(function (changed) {
      assert(changed === true, '成功应返回 true');
      var ev = remoteCuration.curatedEventFor('Remote Event');
      assert(ev && ev.tier.grade === 'A', '远程事件命中');
      var t = remoteCuration.curatedTeamFor(99999);
      assert(t && t.name === 'Remote Team', '远程战队命中');
      console.log('PASS  load: 云函数拉取成功覆盖');
      return true;
    }).catch(function (e) { throw e; });
  }).then(function () {
    return runAsync(function () {
      // 3b. 云函数调用失败回退
      Object.keys(storage).forEach(function (k) { delete storage[k]; });
      var p = remoteCuration.load(true);
      assert(cloudCallHandler, '应触发 wx.cloud.callFunction');
      fireCloudFail(new Error('cloud call failed'));
      return p.then(function (changed) {
        assert(changed === false, '失败应返回 false');
        var ev = remoteCuration.curatedEventFor('The International 2024');
        assert(ev && ev.tier.grade === 'S', '回退到本地 TI');
        console.log('PASS  load: 云函数失败回退本地');
        return true;
      }).catch(function (e) { throw e; });
    });
  }).then(function () {
    if (config.supabase) config.supabase.enabled = true;   // 恢复默认（config.js 默认启用）
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
