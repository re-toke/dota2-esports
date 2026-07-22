// scripts/test-liquiped.js
// Liquipedia 数据源单元测试（不联网，模拟 wx.request 返回 MediaWiki parse JSON，
// 验证 liquipedia.js 的 HTML 正则解析、缓存、网络降级逻辑）。
//
// 复用 test-sources.js 的 mock + runner 基础设施：
//   - section()/check() + runAll() 顺序执行 async 测试
//   - global.wx.request 可替换 requestHandler 注入可控响应
//   - global.wx.*StorageSync 内存缓存
// 额外：覆盖 global.setTimeout 使重试退避/限流间隔立即触发，避免测试等待 5.5s+。
//   liquipedia.js 的 sleep()/重试均通过全局 setTimeout 调度，运行时查表 global.setTimeout，
//   覆盖后回调同步执行，Promise 仍按 microtask 推进，await 行为不变。

'use strict';

let passed = 0;
let failed = 0;
const tests = [];

function section(title) { tests.push({ kind: 'section', title: title }); }
function check(label, fn) { tests.push({ kind: 'test', label: label, fn: fn }); }
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

// ===== 1. mock wx 环境（与 test-sources.js 一致）=====
const storage = {};
const defaultRequestHandler = function (opts) {
  if (opts.fail) opts.fail({ errMsg: 'request:fail (mock network down)' });
  else if (opts.success) opts.success({ statusCode: 403, data: null });
};
let requestHandler = defaultRequestHandler;
global.wx = {
  request: function (opts) { return requestHandler(opts); },
  getStorageSync: function (key) { return storage[key] || null; },
  setStorageSync: function (key, val) { storage[key] = val; },
  removeStorageSync: function (key) { delete storage[key]; },
  getStorageInfoSync: function () { return { keys: Object.keys(storage) }; }
};

// 加速测试：让 setTimeout 回调立即同步执行（消除 1500ms 限流间隔 + 1500/4000ms 重试退避）。
// 仅在回调为函数时调用；返回 0 模拟 Node 原生 setTimeout 的返回值（liquipedia 不使用返回值）。
global.setTimeout = function (fn) { if (typeof fn === 'function') fn(); return 0; };

// ===== 2. 清除 module cache =====
const purge = ['cache.js', 'config.js', 'consensus.js', 'liquipedia.js'];
for (const k of Object.keys(require.cache)) {
  for (const name of purge) { if (k.indexOf(name) >= 0) delete require.cache[k]; }
}

// ===== 3. require 模块 =====
const path = require('path');
const SRC = path.resolve(__dirname, '..', 'utils');
const cache = require(path.join(SRC, 'cache.js'));
const consensus = require(path.join(SRC, 'consensus.js'));
const liquipedia = require(path.join(SRC, 'liquipedia.js'));

// ===== 4. 测试 =====

section('\n--- Liquipedia 单元测试 ---');

// 测试 1：解析赛事页 infobox —— 验证 MediaWiki action=parse 响应解析
// 响应形状：{ parse: { title, pageid, text: { '*': '<html>' } } }
// HTML 含 <th>Label</th><td>Value</td> 行，由 extractRow 正则提取。
check('getLeagueMetadata 解析赛事页 infobox', async () => {
  const cacheKey = 'liquipedia_league_' + consensus.normName('The International 2024');
  cache.remove(cacheKey);
  requestHandler = function (opts) {
    opts.success({
      statusCode: 200,
      data: {
        parse: {
          title: 'The International 2024',
          pageid: 123,
          text: {
            '*': '<div class="infobox-tournament"><table>' +
              '<tr><th>Start Date</th><td>2024-07-10</td></tr>' +
              '<tr><th>End Date</th><td>2024-07-14</td></tr>' +
              '<tr><th>Prize Pool</th><td>$1,500,000 USD</td></tr>' +
              '<tr><th>Location</th><td>Seattle</td></tr>' +
              '<tr><th>Format</th><td>Double-elimination</td></tr>' +
              '<tr><th>Organizer</th><td>Valve</td></tr>' +
              '</table></div>'
          }
        }
      }
    });
  };
  try {
    const r = await liquipedia.getLeagueMetadata('The International 2024');
    assert(r !== null, '返回不应为 null');
    assert(r.canonical && r.canonical.indexOf('International') >= 0,
      'canonical 应含 International，实际: ' + r.canonical);
    // parsePrizePool 把 "$1,500,000 USD" 解析为 amount:'1500000' (字符串), currency:'USD'
    assert(r.prizePool === '1500000',
      'prizePool 应为 "1500000"，实际: ' + r.prizePool);
    assert(r.location && r.location.indexOf('Seattle') >= 0,
      'location 应含 Seattle，实际: ' + r.location);
  } finally {
    requestHandler = defaultRequestHandler;
    cache.remove(cacheKey);
  }
});

// 测试 2：网络失败降级 null —— requestHandler 调 opts.fail，重试耗尽后应 resolve null（不抛错）
check('getLeagueMetadata 网络失败降级 null', async () => {
  const cacheKey = 'liquipedia_league_' + consensus.normName('Network Fail Cup');
  cache.remove(cacheKey);
  requestHandler = function (opts) { opts.fail({ errMsg: 'request:fail' }); };
  try {
    const r = await liquipedia.getLeagueMetadata('Network Fail Cup');
    assert(r === null, '网络失败应降级返回 null，不应抛错');
  } finally {
    requestHandler = defaultRequestHandler;
    cache.remove(cacheKey);
  }
});

// 测试 3：解析战队名册 —— getTeamRoster 从 <tr><td>... 中提取队员
// account_id 在 Liquipedia HTML 中不可靠，统一为 null（consensus 用 name 回退匹配）。
check('getTeamRoster 解析战队名册', async () => {
  const cacheKey = 'liquipedia_team_' + consensus.normName('OG');
  cache.remove(cacheKey);
  requestHandler = function (opts) {
    opts.success({
      statusCode: 200,
      data: {
        parse: {
          title: 'OG',
          pageid: 456,
          text: {
            '*': '<table class="wikitable roster-table">' +
              '<tr><th>Nick</th><th>Position</th><th>Join Date</th></tr>' +
              '<tr><td>N0tail</td><td>5</td><td>2023-01-01</td></tr>' +
              '<tr><td>Ceb</td><td>4</td><td>2023-02-01</td></tr>' +
              '</table>'
          }
        }
      }
    });
  };
  try {
    const r = await liquipedia.getTeamRoster('OG');
    assert(Array.isArray(r), '应返回数组');
    assert(r.length === 2, '应有 2 名队员，实际: ' + r.length);
    const names = r.map(function (m) { return m.name; }).join(',');
    assert(names.indexOf('N0tail') >= 0, '应含 N0tail，实际: ' + names);
    assert(names.indexOf('Ceb') >= 0, '应含 Ceb，实际: ' + names);
    assert(r[0].account_id === null, 'account_id 应为 null（Liquipedia HTML 不可靠）');
  } finally {
    requestHandler = defaultRequestHandler;
    cache.remove(cacheKey);
  }
});

// 测试 4：缓存命中不重复请求 —— 同一参数第二次调用应命中缓存，requestHandler 仅触发一次
check('getLeagueMetadata 缓存命中不重复请求', async () => {
  const cacheKey = 'liquipedia_league_' + consensus.normName('Cache Hit Cup');
  cache.remove(cacheKey);
  let callCount = 0;
  requestHandler = function (opts) {
    callCount++;
    opts.success({
      statusCode: 200,
      data: {
        parse: {
          title: 'Cache Hit Cup',
          pageid: 789,
          text: { '*': '<table><tr><th>Prize Pool</th><td>$500,000 USD</td></tr></table>' }
        }
      }
    });
  };
  try {
    await liquipedia.getLeagueMetadata('Cache Hit Cup');
    await liquipedia.getLeagueMetadata('Cache Hit Cup');
    assert(callCount === 1, '第二次应命中缓存不重复请求，实际请求次数: ' + callCount);
  } finally {
    requestHandler = defaultRequestHandler;
    cache.remove(cacheKey);
  }
});

// 测试 5：ENABLED 反映 config.liquipedia.enabled
check('ENABLED 反映 config.liquipedia.enabled', () => {
  assert(liquipedia.ENABLED === true,
    'liquipedia.ENABLED 应为 true（config.liquipedia.enabled=true）');
});

// ===== 运行全部测试（顺序执行，支持 async）=====
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
