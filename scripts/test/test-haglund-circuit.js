// scripts/test/test-haglund-circuit.js
// haglund 熔断器 + SWR 容灾单元测试（2026-08-24 方案 A）
// 纯函数不联网：mock wx + cache，验证状态转移、stale 兜底、header 安全性。
//
// 运行：node scripts/test/test-haglund-circuit.js

'use strict';

let passed = 0;
let failed = 0;
const tests = [];
function section(title) { tests.push({ kind: 'section', title: title }); }
function check(label, fn) { tests.push({ kind: 'test', label: label, fn: fn }); }
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

// ===== mock 环境 =====
const storage = {};
// requestHandler 可被单测临时覆盖
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
  getStorageInfoSync: function () { return { keys: Object.keys(storage), currentSize: 0, limitSize: 10240 }; }
};

// ===== 加载被测模块 =====
const path = require('path');
const haglund = require(path.resolve(__dirname, '../../utils/haglund.js'));

// ===== 辅助：每次测试前清空存储 + 复位 request handler =====
function resetEnv() {
  Object.keys(storage).forEach(function (k) { delete storage[k]; });
  requestHandler = defaultRequestHandler;
}

// ===== 测试用样本数据 =====
const SAMPLE_MATCH = {
  id: 'TI2026Main:R05-M001',
  matchType: 'Bo5',
  startsAt: '2026-08-23T06:15:00Z',
  leagueName: 'TI 2026 - Main Event',
  leagueUrl: 'https://liquipedia.net/dota2/The_International/2026/Main_Event',
  streamUrl: 'https://liquipedia.net/dota2/Special:Stream/twitch/The_International',
  teams: [
    { name: 'TEAM VISION', url: 'https://liquipedia.net/dota2/TEAM_VISION' },
    { name: 'Team Spirit', url: 'https://liquipedia.net/dota2/Team_Spirit' }
  ]
};

function makeSuccessHandler(matches) {
  return function (opts) {
    if (opts.success) opts.success({ statusCode: 200, data: matches });
  };
}
function makeFailHandler() {
  return function (opts) {
    if (opts.fail) opts.fail({ errMsg: 'network error' });
  };
}
function make403Handler() {
  return function (opts) {
    if (opts.success) opts.success({ statusCode: 403, data: null });
  };
}

// ===== 测试用例 =====

section('\n--- 1. 熔断器初始状态 ---');
check('初始 cbStatus 应为 closed', function () {
  resetEnv();
  assert(haglund._cbStatus(1000000) === 'closed', '初始应为 closed');
});

section('\n--- 2. 连续失败触发熔断（CLOSED → OPEN）---');
check('连续 2 次失败仍为 closed', function () {
  resetEnv();
  haglund._cbOnFail();
  haglund._cbOnFail();
  assert(haglund._cbStatus(1000000) === 'closed', '2 次失败阈值未到');
});
check('连续 3 次失败转 open', function () {
  resetEnv();
  haglund._cbOnFail();
  haglund._cbOnFail();
  haglund._cbOnFail();
  // 在同一时间窗内查（用未来时间避开冷却），模拟在 openedAt 后立即查
  var s = haglund._cbLoad();
  assert(s.status === 'open', '第 3 次失败应转 open，实际=' + s.status);
  assert((s.failCount || 0) >= 3, '失败计数应 >= 3');
});

section('\n--- 3. 冷却期判定（OPEN → HALF_OPEN）---');
check('冷却未到仍为 open', function () {
  resetEnv();
  // 制造一次 open（连续失败 3 次）
  haglund._cbOnFail(); haglund._cbOnFail(); haglund._cbOnFail();
  var s = haglund._cbLoad();
  var openedAt = s.openedAt;
  // 冷却 10 分钟 = 600 秒，查 openedAt + 300s 时应仍 open
  var status = haglund._cbStatus(openedAt + 300);
  assert(status === 'open', '冷却未到应为 open，实际=' + status);
});
check('冷却结束转 half_open', function () {
  resetEnv();
  haglund._cbOnFail(); haglund._cbOnFail(); haglund._cbOnFail();
  var s = haglund._cbLoad();
  var openedAt = s.openedAt;
  // openedAt + 601s 应转 half_open
  var status = haglund._cbStatus(openedAt + 601);
  assert(status === 'half_open', '冷却结束应转 half_open，实际=' + status);
});

section('\n--- 4. 探测成功/失败（HALF_OPEN 转移）---');
check('half_open 探测成功 → closed', function () {
  resetEnv();
  haglund._cbOnFail(); haglund._cbOnFail(); haglund._cbOnFail();
  var s = haglund._cbLoad();
  haglund._cbStatus(s.openedAt + 601);  // 触发转 half_open
  haglund._cbOnSuccess();
  var after = haglund._cbLoad();
  assert(after.status === 'closed', '探测成功应回 closed');
  assert((after.failCount || 0) === 0, 'failCount 应清零');
});
check('half_open 探测失败 → 立即回 open', function () {
  resetEnv();
  haglund._cbOnFail(); haglund._cbOnFail(); haglund._cbOnFail();
  var s1 = haglund._cbLoad();
  haglund._cbStatus(s1.openedAt + 601);  // 转 half_open
  var tBefore = Math.floor(Date.now() / 1000);
  haglund._cbOnFail();  // 探测失败
  var after = haglund._cbLoad();
  assert(after.status === 'open', '探测失败应立即回 open，实际=' + after.status);
  assert((after.openedAt || 0) >= tBefore - 5, 'openedAt 应被刷新为当前时间');
});

section('\n--- 5. 熔断 OPEN 时 fetchUpcoming 不发请求，返回 stale 兜底 ---');
check('熔断 open 时即使 force=false 也不发请求，返回缓存或空', function () {
  resetEnv();
  // 制造 open 状态
  haglund._cbOnFail(); haglund._cbOnFail(); haglund._cbOnFail();
  var requestCalled = false;
  requestHandler = function (opts) { requestCalled = true; };
  // 此时不调用 force，应被熔断短路
  var promise = haglund.fetchUpcoming({ now: 1000000 });
  return promise.then(function (res) {
    assert(requestCalled === false, '熔断期间不应实际发请求');
    assert(res && res._source === 'none', '无缓存时应返回 _source=none，实际=' + (res && res._source));
  });
});

section('\n--- 6. 正常请求成功后写入缓存 + 复位熔断 ---');
check('成功请求返回 live 并写入缓存', function () {
  resetEnv();
  requestHandler = makeSuccessHandler([SAMPLE_MATCH]);
  return haglund.fetchUpcoming({ force: true, now: 1750000000 }).then(function (res) {
    assert(res._source === 'live', '应标记 _source=live，实际=' + res._source);
    assert(res.matches.length === 1, '应解析出 1 场对阵');
    assert(res.matches[0].team1Name === 'TEAM VISION', 'team1Name 应被归一化');
    assert(res.matches[0].boType === 'BO5', 'matchType Bo5 → BO5');
    // 熔断器复位
    var s = haglund._cbLoad();
    assert(s.status === 'closed', '成功后熔断应复位 closed');
  });
});

section('\n--- 7. 请求失败时计入熔断 + 返回 stale 兜底 ---');
check('首次失败：failCount=1，仍可返回空', function () {
  resetEnv();
  requestHandler = makeFailHandler();
  return haglund.fetchUpcoming({ force: true, now: 1750000000 }).then(function (res) {
    var s = haglund._cbLoad();
    assert((s.failCount || 0) === 1, '应 failCount=1，实际=' + s.failCount);
    assert(res._source === 'none', '无缓存时应 _source=none');
  });
});

section('\n--- 8. stale 回退（缓存硬过期但在 STALE_MAX_AGE 内仍可用）---');
check('缓存硬过期且请求失败时，返回 stale 兜底', function () {
  resetEnv();
  // 先成功一次写缓存
  requestHandler = makeSuccessHandler([SAMPLE_MATCH]);
  return haglund.fetchUpcoming({ force: true, now: 1750000000 }).then(function () {
    // 模拟缓存过期：直接改 storage 里的 expire + fetchedAt
    // fetchedAt 设为 90 分钟前（超过 CACHE_TTL=60min，但小于 STALE_MAX_AGE_SEC=4h）
    var cacheKey = 'dota2_cache_haglund_upcoming_v1';
    var raw = storage[cacheKey];
    if (typeof raw === 'string') {
      var obj = JSON.parse(raw);
      obj.expire = Date.now() - 1000;  // 已硬过期
      obj.fetchedAt = Date.now() - 90 * 60 * 1000;  // 90 分钟前采集
      storage[cacheKey] = JSON.stringify(obj);
    }
    // 请求失败
    requestHandler = makeFailHandler();
    return haglund.fetchUpcoming({ now: 1750100000 }).then(function (res) {
      assert(res._source === 'stale', '应返回 stale，实际=' + res._source);
      assert(res.matches.length === 1, 'stale 数据应仍可用');
    });
  });
});

section('\n--- 9. stale 窗口外不返回过时数据 ---');
check('缓存采集超过 4 小时视为彻底失效，不返回', function () {
  resetEnv();
  requestHandler = makeSuccessHandler([SAMPLE_MATCH]);
  return haglund.fetchUpcoming({ force: true, now: 1750000000 }).then(function () {
    var cacheKey = 'dota2_cache_haglund_upcoming_v1';
    var raw = storage[cacheKey];
    if (typeof raw === 'string') {
      var obj = JSON.parse(raw);
      obj.expire = Date.now() - 1000;
      obj.fetchedAt = Date.now() - 6 * 3600 * 1000;  // 6 小时前（超出 STALE_MAX_AGE_SEC=4h）
      storage[cacheKey] = JSON.stringify(obj);
    }
    requestHandler = makeFailHandler();
    return haglund.fetchUpcoming({ now: 1750100000 }).then(function (res) {
      assert(res._source === 'none', '超出 stale 窗口应返回 none，实际=' + res._source);
      assert(res.matches.length === 0, '应返回空数组');
    });
  });
});

section('\n--- 10. resetCircuit 手动复位 ---');
check('resetCircuit 把状态清零', function () {
  resetEnv();
  haglund._cbOnFail(); haglund._cbOnFail(); haglund._cbOnFail();
  var s1 = haglund._cbLoad();
  assert(s1.status === 'open', '先确认已熔断');
  haglund.resetCircuit();
  var s2 = haglund._cbLoad();
  assert(s2.status === 'closed', '复位后应为 closed');
  assert((s2.failCount || 0) === 0, 'failCount 应清零');
});

section('\n--- 11. 请求头安全性（不含 User-Agent）---');
check('请求头应不含 User-Agent（微信规范禁止）', function () {
  resetEnv();
  var capturedHeader = null;
  requestHandler = function (opts) {
    capturedHeader = opts.header || {};
    if (opts.success) opts.success({ statusCode: 200, data: [SAMPLE_MATCH] });
  };
  return haglund.fetchUpcoming({ force: true, now: 1750000000 }).then(function () {
    assert(capturedHeader !== null, '应已捕获 header');
    var keys = Object.keys(capturedHeader || {});
    var hasUA = keys.some(function (k) { return k.toLowerCase() === 'user-agent'; });
    assert(hasUA === false, 'header 不应含 User-Agent');
    assert((capturedHeader || {}).Referer === 'https://liquipedia.net/', '应有 Referer');
  });
});

section('\n--- 12. getStatus 调试 API ---');
check('getStatus 返回结构合法', function () {
  resetEnv();
  requestHandler = makeSuccessHandler([SAMPLE_MATCH]);
  return haglund.fetchUpcoming({ force: true, now: 1750000000 }).then(function () {
    var st = haglund.getStatus();
    assert(st.circuit && typeof st.circuit.status === 'string', 'circuit.status 应为字符串');
    assert(st.cache && typeof st.cache.hasData === 'boolean', 'cache.hasData 应为 boolean');
    assert(st.cache.isFresh === true, '刚写入应 isFresh=true');
  });
});

section('\n--- 13. LEAGUE_ALIASES 顺序优先级（TI China 应优先于 TI）---');
check('The International China 匹配 ti china 而非 ti', function () {
  resetEnv();
  // 用 TI China 赛事名过滤
  var matches = [{ _leagueName: 'TI China 2026 - Group Stage' }];
  var filtered = haglund._filterByLeague(matches, 'The International China 2026');
  assert(filtered.length === 1, '应命中 TI China');
});

section('\n--- 14. 赛程名匹配：赛季号缩写（"Season 9" ↔ "S9"）---');
// ★ 2026-09-19 新增（真机诊断 · 详情页赛程为空）：
//   详情页经 liquipedia.getScheduledMatches → tryHaglundFallback(name) 传的是
//   **curation 规范名**「PGL Wallachia Season 9」，而 haglund 侧数据用**缩写**
//   「PGL Wallachia S9 - Round 1」→ 修复前子串比对必然失败（且 extractYear 只认
//   4 位年份，年份分支也进不去）→ 返回 0 场。
//   而列表页 mergeHaglundUpcoming **不传 leagueName**（走全量）→ 故「同一份数据，
//   列表页 47 场正常、详情页 0 场」。修复方式：追加赛季号归一化比对。
check('规范名 Season 9 应命中缩写名 S9（Round / Playoffs）', function () {
  resetEnv();
  var matches = [
    { _leagueName: 'PGL Wallachia S9 - Round 1' },
    { _leagueName: 'PGL Wallachia S9 - Round 5' },
    { _leagueName: 'PGL Wallachia S9 - Playoffs' }
  ];
  var filtered = haglund._filterByLeague(matches, 'PGL Wallachia Season 9');
  assert(filtered.length === 3, '应命中全部 3 场，实际 ' + filtered.length);
});
check('精度守卫：不误匹配相邻届（S8 / Season 10）', function () {
  resetEnv();
  var matches = [
    { _leagueName: 'PGL Wallachia S8 - Round 1' },
    { _leagueName: 'PGL Wallachia Season 10 - Round 1' }
  ];
  var filtered = haglund._filterByLeague(matches, 'PGL Wallachia Season 9');
  assert(filtered.length === 0, '不应命中任何一场，实际 ' + filtered.length);
});
check('回归守卫：既有精确名匹配未被破坏（TI 2026）', function () {
  resetEnv();
  var matches = [
    { _leagueName: 'TI 2026 - Main Event' },
    { _leagueName: 'ESL One Birmingham 2026' }
  ];
  var filtered = haglund._filterByLeague(matches, 'TI 2026');
  assert(filtered.length === 1, '应只命中 TI 2026，实际 ' + filtered.length);
});
check('不传 leagueName 时返回全量（列表页语义）', function () {
  resetEnv();
  var matches = [{ _leagueName: 'A' }, { _leagueName: 'B' }];
  assert(haglund._filterByLeague(matches, null).length === 2, '不传名应返回全量');
});

// ===== 运行 =====
async function runAll() {
  for (const t of tests) {
    if (t.kind === 'section') {
      console.log(t.title);
      continue;
    }
    try {
      await t.fn();
      passed++;
      console.log('  ✓ ' + t.label);
    } catch (e) {
      failed++;
      console.log('  ✗ ' + t.label);
      console.log('      ' + (e && e.message || e));
    }
  }
  console.log('\n========== haglund 熔断器测试 ==========');
  console.log('通过: ' + passed + '  失败: ' + failed);
  process.exit(failed === 0 ? 0 : 1);
}

runAll();
