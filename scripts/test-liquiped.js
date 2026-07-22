// scripts/test-liquiped.js
// Liquipedia 数据源单元测试（不联网，模拟 wx.request 返回 MediaWiki revisions JSON，
// 验证 liquipedia.js 的 wikitext 模板解析、缓存、网络降级、反爬虫拦截处理逻辑）。
//
// 复用 test-sources.js 的 mock + runner 基础设施：
//   - section()/check() + runAll() 顺序执行 async 测试
//   - global.wx.request 可替换 requestHandler 注入可控响应
//   - global.wx.*StorageSync 内存缓存
// 额外：覆盖 global.setTimeout 使重试退避/限流间隔立即触发，避免测试等待 5.5s+。

'use strict';

let passed = 0;
let failed = 0;
const tests = [];

function section(title) { tests.push({ kind: 'section', title: title }); }
function check(label, fn) { tests.push({ kind: 'test', label: label, fn: fn }); }
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

// ===== 1. mock wx 环境 =====
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

// 加速测试：让 setTimeout 回调立即同步执行（消除 2200ms 限流间隔 + 2200/6000ms 重试退避）。
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

// ===== 真实的 wikitext mock 数据 =====
// 模拟 Liquipedia 赛事页的 wikitext 源码（含 {{Infobox league}} 模板）
const LEAGUE_WIKITEXT = [
  '{{Infobox league',
  '|name=The International 2024',
  '|ticker=TI 2024',
  '|image=TI2024.png',
  '|game=dota2',
  '|type=offline',
  '|country=Denmark',
  '|city=Copenhagen',
  '|venue=Royal Arena',
  '|organizer=Valve',
  '|prizepool=5000000',
  '|prizepoolusd=5000000',
  '|format=Double-elimination playoff',
  '|sdate=2024-09-11',
  '|edate=2024-10-13',
  '|participants=20',
  '|liquipediatier=S',
  '}}',
  '',
  '==Overview==',
  'The International 2024 is the premier Dota 2 tournament.',
  '',
  '==Format==',
  '* Group Stage: Round Robin',
  '* Main Event: Double-elimination'
].join('\n');

// 模拟战队页 wikitext（含 {| ... |} roster 表格）
const TEAM_WIKITEXT = [
  '{{Infobox team',
  '|name=OG',
  '|image=OGlogo.png',
  '|region=Europe',
  '|location=Europe',
  '}}',
  '',
  '==Roster==',
  '{| class="wikitable roster-table"',
  '! Nick !! Position !! Join Date',
  '|-',
  '| [[N0tail]] || 5 || 2023-01-01',
  '|-',
  '| [[Ceb]] || 4 || 2023-02-01',
  '|-',
  '| [[Topson]] || 2 || 2023-03-01',
  '|}'
].join('\n');

// 模拟选手页 wikitext（含 {{Infobox player}} 模板）
const PLAYER_WIKITEXT = [
  '{{Infobox player',
  '|name=N0tail',
  '|romanized=Johan Sundstein',
  '|country=Denmark',
  '|birth_date=1993-10-06',
  '|status=active',
  '|role=Support',
  '|team=OG',
  '}}',
  '',
  '==History==',
  '{| class="wikitable"',
  '! Team !! From !! To',
  '|-',
  '| [[OG]] || 2015-01-01 || 2018-08-01',
  '|-',
  '| [[OG]] || 2018-12-01 || Present',
  '|}'
].join('\n');

// 模拟 MediaWiki action=query&prop=revisions 响应（formatversion=2）
function makeRevisionsResponse(pageTitle, wikitext) {
  return {
    batchcomplete: true,
    query: {
      pages: [{
        pageid: 123,
        ns: 0,
        title: pageTitle,
        revisions: [{
          slots: {
            main: {
              contentmodel: 'wikitext',
              contentformat: 'text/x-wiki',
              content: wikitext
            }
          }
        }]
      }]
    }
  };
}

// ===== 4. 测试 =====

section('\n--- Liquipedia 单元测试（wikitext 模板解析）---');

// 测试 1：解析赛事页 {{Infobox league}} 模板
check('getLeagueMetadata 解析赛事页 infobox 模板', async () => {
  const cacheKey = 'liquipedia_league_' + consensus.normName('The International 2024');
  cache.remove(cacheKey);
  requestHandler = function (opts) {
    opts.success({
      statusCode: 200,
      data: makeRevisionsResponse('The International 2024', LEAGUE_WIKITEXT)
    });
  };
  try {
    const r = await liquipedia.getLeagueMetadata('The International 2024');
    assert(r !== null, '返回不应为 null');
    assert(r.canonical && r.canonical.indexOf('International') >= 0,
      'canonical 应含 International，实际: ' + r.canonical);
    assert(r.prizePool === '5000000',
      'prizePool 应为 "5000000"，实际: ' + r.prizePool);
    assert(r.prizePoolCurrency === 'USD',
      'prizePoolCurrency 应为 USD，实际: ' + r.prizePoolCurrency);
    assert(r.startDate === '2024-09-11',
      'startDate 应为 2024-09-11，实际: ' + r.startDate);
    assert(r.endDate === '2024-10-13',
      'endDate 应为 2024-10-13，实际: ' + r.endDate);
    assert(r.location && r.location.indexOf('Copenhagen') >= 0,
      'location 应含 Copenhagen，实际: ' + r.location);
    assert(r.organizer === 'Valve',
      'organizer 应为 Valve，实际: ' + r.organizer);
    assert(r.source === 'liquipedia',
      'source 应为 liquipedia');
  } finally {
    requestHandler = defaultRequestHandler;
    cache.remove(cacheKey);
  }
});

// 测试 2：网络失败降级 null —— requestHandler 调 opts.fail，重试耗尽后应 resolve null
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

// 测试 3：解析战队名册 —— 从 wikitext {| ... |} 表格中提取队员
check('getTeamRoster 解析战队名册（wikitext 表格）', async () => {
  const cacheKey = 'liquipedia_team_' + consensus.normName('OG');
  cache.remove(cacheKey);
  requestHandler = function (opts) {
    opts.success({
      statusCode: 200,
      data: makeRevisionsResponse('OG', TEAM_WIKITEXT)
    });
  };
  try {
    const r = await liquipedia.getTeamRoster('OG');
    assert(Array.isArray(r), '应返回数组');
    assert(r.length === 3, '应有 3 名队员，实际: ' + r.length);
    const names = r.map(function (m) { return m.name; }).join(',');
    assert(names.indexOf('N0tail') >= 0, '应含 N0tail，实际: ' + names);
    assert(names.indexOf('Ceb') >= 0, '应含 Ceb，实际: ' + names);
    assert(names.indexOf('Topson') >= 0, '应含 Topson，实际: ' + names);
    assert(r[0].account_id === null, 'account_id 应为 null（Liquipedia 不可靠）');
    // stripWikitextMarkup 应把 [[N0tail]] 解析为 N0tail（去掉链接）
    assert(r[0].name === 'N0tail' || r[0].name === 'N0tail',
      'N0tail 名字应去掉 [[ ]] 链接标记');
  } finally {
    requestHandler = defaultRequestHandler;
    cache.remove(cacheKey);
  }
});

// 测试 4：缓存命中不重复请求
check('getLeagueMetadata 缓存命中不重复请求', async () => {
  const cacheKey = 'liquipedia_league_' + consensus.normName('Cache Hit Cup');
  cache.remove(cacheKey);
  let callCount = 0;
  requestHandler = function (opts) {
    callCount++;
    opts.success({
      statusCode: 200,
      data: makeRevisionsResponse('Cache Hit Cup',
        '{{Infobox league\n|name=Cache Hit Cup\n|prizepool=500000\n|sdate=2024-01-01\n}}')
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

// 测试 6：反爬虫拦截页检测 —— 返回 HTML（含 "temporarily blocked"）应降级 null
check('反爬虫拦截页检测降级 null', async () => {
  const cacheKey = 'liquipedia_league_' + consensus.normName('Blocked Cup');
  cache.remove(cacheKey);
  requestHandler = function (opts) {
    opts.success({
      statusCode: 200,
      data: '<html><body>Your IP address has been temporarily blocked from accessing Liquipedia due to excessive or invalid requests.</body></html>'
    });
  };
  try {
    const r = await liquipedia.getLeagueMetadata('Blocked Cup');
    assert(r === null, '反爬虫拦截页应降级返回 null，不应缓存拦截 HTML');
  } finally {
    requestHandler = defaultRequestHandler;
    cache.remove(cacheKey);
  }
});

// 测试 7：页面不存在（missing 标记）降级 null
check('页面不存在降级 null', async () => {
  const cacheKey = 'liquipedia_league_' + consensus.normName('Nonexistent Tournament 9999');
  cache.remove(cacheKey);
  requestHandler = function (opts) {
    opts.success({
      statusCode: 200,
      data: {
        batchcomplete: true,
        query: {
          pages: [{
            pageid: 0,
            ns: 0,
            title: 'Nonexistent Tournament 9999',
            missing: true
          }]
        }
      }
    });
  };
  try {
    const r = await liquipedia.getLeagueMetadata('Nonexistent Tournament 9999');
    assert(r === null, '不存在的页面应降级返回 null');
  } finally {
    requestHandler = defaultRequestHandler;
    cache.remove(cacheKey);
  }
});

// 测试 8：选手资料解析 {{Infobox player}}
check('getPlayerProfile 解析选手页模板', async () => {
  const cacheKey = 'liquipedia_player_' + consensus.normName('N0tail');
  cache.remove(cacheKey);
  requestHandler = function (opts) {
    opts.success({
      statusCode: 200,
      data: makeRevisionsResponse('N0tail', PLAYER_WIKITEXT)
    });
  };
  try {
    const r = await liquipedia.getPlayerProfile('N0tail');
    assert(r !== null, '应返回非 null');
    assert(r.name === 'N0tail' || r.name === 'Johan Sundstein',
      'name 应为 N0tail 或 romanized，实际: ' + r.name);
    assert(r.country === 'Denmark', 'country 应为 Denmark，实际: ' + r.country);
    assert(r.role === 'Support', 'role 应为 Support，实际: ' + r.role);
    assert(r.team === 'OG', 'team 应为 OG，实际: ' + r.team);
  } finally {
    requestHandler = defaultRequestHandler;
    cache.remove(cacheKey);
  }
});

// 测试 9：请求头合规性验证 —— User-Agent + Accept-Encoding: gzip
check('请求头含 User-Agent + Accept-Encoding: gzip', async () => {
  const cacheKey = 'liquipedia_league_' + consensus.normName('Header Test Cup');
  cache.remove(cacheKey);
  let capturedHeaders = null;
  requestHandler = function (opts) {
    capturedHeaders = opts.header || {};
    opts.success({
      statusCode: 200,
      data: makeRevisionsResponse('Header Test Cup',
        '{{Infobox league\n|name=Header Test Cup\n}}')
    });
  };
  try {
    await liquipedia.getLeagueMetadata('Header Test Cup');
    assert(capturedHeaders && capturedHeaders['User-Agent'],
      '请求头应含 User-Agent');
    assert(capturedHeaders['Accept-Encoding'] === 'gzip',
      'Accept-Encoding 应为 gzip（官方强制要求），实际: ' + capturedHeaders['Accept-Encoding']);
  } finally {
    requestHandler = defaultRequestHandler;
    cache.remove(cacheKey);
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
