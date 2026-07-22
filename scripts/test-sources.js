// scripts/test-sources.js
// 多数据源回退链 mock 测试（不联网，模拟 wx 环境已验证降级逻辑正确）。
// 直接 stubs wx/cache，然后 require 源码模块并运行测试。
//
// 测试运行器说明：check() 收集测试到队列，runAll() 顺序执行（支持 async），
// 确保 async 断言被真正校验后再计数，并在全部完成后输出汇总与退出码。

'use strict';

let passed = 0;
let failed = 0;
const tests = [];

// section: 登记一个分段标题（按登记顺序输出）。
function section(title) { tests.push({ kind: 'section', title: title }); }
// check: 登记一个测试（fn 可为 async，runAll 会 await）。
function check(label, fn) { tests.push({ kind: 'test', label: label, fn: fn }); }
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

// ===== 1. 设置 mock 环境 =====
const storage = {};
// 可替换的 wx.request 处理器：默认模拟网络不可达（始终失败）。
// 单个测试可临时覆盖 requestHandler 注入可控响应，结束后恢复 defaultRequestHandler。
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

// ===== 2. 清除 module cache =====
const purge = ['cache.js', 'config.js', 'tiers.js', 'api.js', 'util.js', 'stratz.js', 'steam.js', 'consensus.js', 'curation.js', 'sources.js'];
for (const k of Object.keys(require.cache)) {
  for (const name of purge) { if (k.indexOf(name) >= 0) delete require.cache[k]; }
}

// ===== 3. require 各模块 =====
const path = require('path');
const SRC = path.resolve(__dirname, '..', 'utils');
const cache = require(path.join(SRC, 'cache.js'));
const config = require(path.join(SRC, 'config.js'));
const tiers = require(path.join(SRC, 'tiers.js'));
const util = require(path.join(SRC, 'util.js'));
const api = require(path.join(SRC, 'api.js'));
const stratz = require(path.join(SRC, 'stratz.js'));
const steam = require(path.join(SRC, 'steam.js'));
const consensus = require(path.join(SRC, 'consensus.js'));
const curation = require(path.join(SRC, 'curation.js'));
const sources = require(path.join(SRC, 'sources.js'));

// ===== 4. 导出结构检查 =====
section('\n--- 模块导出结构 ---');
check('stratz.ENABLED (目前开启)', () => assert(stratz.ENABLED === true));
check('stratz.getLeagues exists', () => assert(typeof stratz.getLeagues === 'function'));
check('stratz.getLeagueTier exists', () => assert(typeof stratz.getLeagueTier === 'function'));
check('stratz.getTeamLogo exists', () => assert(typeof stratz.getTeamLogo === 'function'));
check('stratz.getPlayerAvatar exists', () => assert(typeof stratz.getPlayerAvatar === 'function'));
check('steam.ENABLED (目前关闭)', () => assert(steam.ENABLED === false));
check('steam.getLiveLeagueGames exists', () => assert(typeof steam.getLiveLeagueGames === 'function'));
check('sources.getLeagueTier exists', () => assert(typeof sources.getLeagueTier === 'function'));
check('sources.getLeagueWindow exists', () => assert(typeof sources.getLeagueWindow === 'function'));
check('sources.enrichTeamLogo exists', () => assert(typeof sources.enrichTeamLogo === 'function'));
check('sources.enrichPlayerAvatar exists', () => assert(typeof sources.enrichPlayerAvatar === 'function'));
check('sources.enrichTeamInfo exists', () => assert(typeof sources.enrichTeamInfo === 'function'));
check('sources.enrichLiveGames exists', () => assert(typeof sources.enrichLiveGames === 'function'));

// ===== 5. 分级回退链测试 =====
section('\n--- 分级回退链（sources.getLeagueTier）---');

check('TI 多源交叉验证命中 SSS 级', async () => {
  const r = await sources.getLeagueTier({ name: 'The International 2025', tier: 'professional' });
  assert(r !== null, '返回不应为 null');
  assert(r.source === 'consensus', '应为 consensus 源，实际: ' + r.source);
  assert(r.grade === 'SSS', '应为 SSS 级，实际: ' + r.grade);
  assert(r.label === 'TI 顶级', 'label 应为 TI 顶级');
  assert(r.sources.indexOf('community') >= 0 || r.sources.indexOf('curation') >= 0, '本地权威源应参与');
  assert(r.sources.indexOf('opendota') >= 0, 'opendota 应参与');
});

check('Major 多源交叉验证命中 S 级', async () => {
  const r = await sources.getLeagueTier({ name: 'Berlin Major 2025', tier: 'professional' });
  assert(r.source === 'consensus', '应为 consensus 源');
  assert(r.grade === 'S', '应为 S 级，实际: ' + r.grade);
  assert(r.label === 'S级', 'label 应为 S级');
});

check('未知赛事降级到 OpenDota', async () => {
  const r = await sources.getLeagueTier({ name: 'Random Unknown Cup', tier: 'professional' });
  assert(r !== null, '返回不应为 null');
  assert(r.sources.indexOf('opendota') >= 0, '应为 opendota 源，实际 sources: ' + JSON.stringify(r.sources));
  assert(r.grade === 'S', 'professional 应返回 S');
});

check('amateur 赛事降级到 OpenDota', async () => {
  const r = await sources.getLeagueTier({ name: 'Weekly Cup', tier: 'amateur' });
  assert(r.sources.indexOf('opendota') >= 0, '应为 opendota');
  assert(r.grade === 'B', 'amateur 应返回 B');
});

check('空名称兜底', async () => {
  const r = await sources.getLeagueTier({ name: '', tier: 'excluded' });
  assert(r !== null, '应有兜底');
  assert(r.grade === 'C', 'excluded 应返回 C');
});

// ===== 6. 赛程窗口回退链（无可用源时返回 null）=====
section('\n--- 赛程窗口回退链 ---');
check('无可用窗口源 -> 返回 null', async () => {
  const r = await sources.getLeagueWindow({ name: 'The International 2025' });
  assert(r === null, '无源时应为 null');
});

// ===== 7. STRATZ / Steam 禁用时返回空 =====
section('\n--- STRATZ / Steam 禁用时行为 ---');
check('stratz.ENABLED === true', () => assert(stratz.ENABLED === true));
check('stratz.getLeagueTier 禁用时返回 null', async () => {
  const r = await stratz.getLeagueTier('Any');
  assert(r === null, '禁用时应返回 null');
});
check('stratz.getLeagues 禁用时返回空数组', async () => {
  const r = await stratz.getLeagues();
  assert(Array.isArray(r) && r.length === 0, '应返回空数组');
});
check('stratz.getTeamLogo disabled -> null', async () => {
  const r = await stratz.getTeamLogo(15);
  assert(r === null, 'disabled should return null');
});
check('steam.ENABLED === false', () => assert(!steam.ENABLED));
check('steam.getLiveLeagueGames disabled -> []', async () => {
  const r = await steam.getLiveLeagueGames();
  assert(Array.isArray(r) && r.length === 0, '应返回空数组');
});

// ===== 8. 战队 logo / 队员头像多源增强 =====
section('\n--- 战队 logo / 队员头像多源增强 ---');
check('enrichTeamLogo no logo + STRATZ disabled -> null', async () => {
  const r = await sources.enrichTeamLogo({ name: 'Unknown Team', id: 999999 });
  assert(r === null, 'should return null');
});
check('enrichTeamLogo existing logo -> return directly', async () => {
  const r = await sources.enrichTeamLogo({ name: 'LGD', id: 15, logo: 'https://existing.example/logo.png' });
  assert(r !== null && r.logo === 'https://existing.example/logo.png', 'should return existing');
  assert(r.source === 'opendota', 'source should be opendota');
});
check('enrichPlayerAvatar no avatar + STRATZ disabled -> null', async () => {
  const r = await sources.enrichPlayerAvatar({ accountId: '123456' });
  assert(r === null, 'should return null');
});
check('enrichPlayerAvatar existing avatar -> return directly', async () => {
  const r = await sources.enrichPlayerAvatar({ accountId: '123', avatar: 'https://existing.example/av.jpg' });
  assert(r !== null && r.avatar === 'https://existing.example/av.jpg', 'should return existing');
  assert(r.source === 'opendota', 'source should be opendota');
});

// ===== 9. 战队扩展信息 / 直播聚合 =====
section('\n--- 战队扩展信息 / 直播聚合 ---');
check('enrichTeamInfo 无可用源 -> null', async () => {
  const r = await sources.enrichTeamInfo({ name: 'Test Team' });
  assert(r === null, '应返回 null');
});
check('enrichLiveGames 全部禁用 -> 空数组', async () => {
  const r = await sources.enrichLiveGames();
  assert(Array.isArray(r) && r.length === 0, '应返回空数组');
});

// ===== 10. 响应校验（api.cached 拒绝畸形 body 并回退）=====
section('\n--- 响应校验（api.cached 拒绝畸形 body 并回退）---');

// cached() 收到 200 + null（畸形 body）时不应写入缓存，应回退到陈旧缓存值。
// 注意：cache.get() 对过期条目会主动删除，导致 peek() 读不到陈旧值。
// 这里临时阻止删除该测试 key，以验证 cached()「回退 stale」逻辑分支。
check('cached() 拒绝畸形 body(null) 并回退陈旧缓存', async () => {
  const cacheKey = '/leagues|{}';
  const storeKey = 'dota2_cache_' + cacheKey;
  // 预置一份「已过期但合法」的陈旧缓存
  storage[storeKey] = JSON.stringify({
    value: [{ leagueid: 1, name: 'Stale League' }],
    expire: Date.now() - 10000,
    fetchedAt: Date.now() - 20000
  });
  const origRemove = global.wx.removeStorageSync;
  global.wx.removeStorageSync = function (key) {
    if (key === storeKey) return; // 保留陈旧条目供 peek() 读取
    return origRemove(key);
  };
  requestHandler = function (opts) { opts.success({ statusCode: 200, data: null }); };
  try {
    const r = await api.cached('/leagues', null, 60);
    assert(r !== null && r !== undefined, '应回退到陈旧缓存，不应返回 null');
    assert(Array.isArray(r) && r.length === 1, '应为陈旧数组');
    assert(r[0].name === 'Stale League', '应为陈旧值内容');
    // 缓存不应被 null 覆盖
    const peek = cache.peek(cacheKey);
    assert(peek && peek.value != null, '缓存不应被 null 覆盖');
  } finally {
    global.wx.removeStorageSync = origRemove;
    requestHandler = defaultRequestHandler;
    delete storage[storeKey];
  }
});

// 空数组 [] 是合法响应（OpenDota 合理地返回空列表），应被缓存。
check('cached() 接受空数组 []（合法响应）', async () => {
  const cacheKey = '/leagues|{}';
  cache.remove(cacheKey);
  requestHandler = function (opts) { opts.success({ statusCode: 200, data: [] }); };
  try {
    const r = await api.cached('/leagues', null, 60);
    assert(Array.isArray(r) && r.length === 0, '应返回空数组');
    const peek = cache.peek(cacheKey);
    assert(peek && Array.isArray(peek.value) && peek.value.length === 0, '空数组应被缓存');
  } finally {
    requestHandler = defaultRequestHandler;
    cache.remove(cacheKey);
  }
});

// 列表端点返回非数组（错误对象）应被拒绝，不应缓存，且无陈旧值时抛错。
check('cached() 拒绝列表端点返回非数组（错误对象）', async () => {
  const cacheKey = '/leagues|{}';
  cache.remove(cacheKey);
  requestHandler = function (opts) { opts.success({ statusCode: 200, data: { error: 'oops' } }); };
  try {
    let threw = false;
    try {
      await api.cached('/leagues', null, 60);
    } catch (e) {
      threw = true;
    }
    assert(threw, '应抛错（无陈旧缓存可回退）');
    const peek = cache.peek(cacheKey);
    assert(peek === null || peek.value == null, '错误对象不应被缓存');
  } finally {
    requestHandler = defaultRequestHandler;
    cache.remove(cacheKey);
  }
});

// ===== 11. 直播聚合去重（enrichLiveGames 复合键）=====
section('\n--- 直播聚合去重（enrichLiveGames 复合键）---');

// 通过临时 monkeypatch steam.getLiveLeagueGames / stratz.getLiveMatches 注入数据，
// 验证 enrichLiveGames 的跨源去重逻辑。所有 patch 在 finally 中恢复原值。
check('enrichLiveGames 跨源去重（同一局合并）', async () => {
  const origSteam = steam.getLiveLeagueGames;
  const origStratz = stratz.getLiveMatches;
  steam.getLiveLeagueGames = function () {
    return Promise.resolve([{ lobbyId: 1, radiantTeamId: 10, direTeamId: 20, leagueId: 5, radiantName: 'A', direName: 'B' }]);
  };
  stratz.getLiveMatches = function () {
    return Promise.resolve([{ matchId: 99, radiantTeamId: 10, direTeamId: 20, leagueId: 5, radiantName: 'A', direName: 'B' }]);
  };
  try {
    const r = await sources.enrichLiveGames();
    assert(Array.isArray(r), '应返回数组');
    assert(r.length === 1, '同一局跨源应去重为 1，实际: ' + r.length);
  } finally {
    steam.getLiveLeagueGames = origSteam;
    stratz.getLiveMatches = origStratz;
  }
});

check('enrichLiveGames 保留不同比赛', async () => {
  const origSteam = steam.getLiveLeagueGames;
  const origStratz = stratz.getLiveMatches;
  steam.getLiveLeagueGames = function () {
    return Promise.resolve([{ radiantTeamId: 10, direTeamId: 20, leagueId: 5 }]);
  };
  stratz.getLiveMatches = function () {
    return Promise.resolve([{ radiantTeamId: 30, direTeamId: 40, leagueId: 5 }]);
  };
  try {
    const r = await sources.enrichLiveGames();
    assert(r.length === 2, '不同比赛应保留为 2，实际: ' + r.length);
  } finally {
    steam.getLiveLeagueGames = origSteam;
    stratz.getLiveMatches = origStratz;
  }
});

check('enrichLiveGames 归一队伍槽位顺序', async () => {
  const origSteam = steam.getLiveLeagueGames;
  const origStratz = stratz.getLiveMatches;
  steam.getLiveLeagueGames = function () {
    return Promise.resolve([{ radiantTeamId: 20, direTeamId: 10, leagueId: 5 }]);
  };
  stratz.getLiveMatches = function () {
    return Promise.resolve([{ radiantTeamId: 10, direTeamId: 20, leagueId: 5 }]);
  };
  try {
    const r = await sources.enrichLiveGames();
    assert(r.length === 1, '槽位顺序不同但同一局应合并为 1，实际: ' + r.length);
  } finally {
    steam.getLiveLeagueGames = origSteam;
    stratz.getLiveMatches = origStratz;
  }
});

check('enrichLiveGames 全 0 id 时回退源私有 id', async () => {
  const origSteam = steam.getLiveLeagueGames;
  const origStratz = stratz.getLiveMatches;
  steam.getLiveLeagueGames = function () {
    return Promise.resolve([{ lobbyId: 1, radiantTeamId: 0, direTeamId: 0, leagueId: 0 }]);
  };
  stratz.getLiveMatches = function () {
    return Promise.resolve([{ matchId: 2, radiantTeamId: 0, direTeamId: 0, leagueId: 0 }]);
  };
  try {
    const r = await sources.enrichLiveGames();
    assert(r.length === 2, '不同源私有 id 不应合并，应为 2，实际: ' + r.length);
  } finally {
    steam.getLiveLeagueGames = origSteam;
    stratz.getLiveMatches = origStratz;
  }
});

// ===== 12. STRATZ 精确名匹配（findLeagueByName 经 getLeagueTier）=====
// findLeagueByName 未导出，但可通过 stratz.getLeagueTier(name) + mock wx.request 间接验证：
// 返回包含两个名称相近的联赛，查询精确名应命中对应联赛（证明归一等值匹配优于子串匹配）。
section('\n--- STRATZ 精确名匹配（精确归一 > 子串）---');
check('stratz.getLeagueTier 精确名命中 DPC_MAJOR→SSS（非子串误命中）', async () => {
  // 清除 stratz 联赛缓存，强制走 mock wx.request
  cache.remove('stratz_leagues');
  requestHandler = function (opts) {
    opts.success({
      statusCode: 200,
      data: {
        data: {
          leagues: [
            { id: 1, name: 'ESL One Birmingham 2024', tier: 'DPC_MAJOR', displayName: 'ESL One Birmingham 2024' },
            { id: 2, name: 'ESL One Kuala Lumpur 2024', tier: 'PROFESSIONAL', displayName: 'ESL One Kuala Lumpur 2024' }
          ]
        }
      }
    });
  };
  try {
    const r = await stratz.getLeagueTier('ESL One Birmingham 2024');
    assert(r !== null, '应命中 Birmingham 联赛');
    assert(r.grade === 'SSS', 'DPC_MAJOR 应映射为 SSS，实际: ' + (r && r.grade));
    assert(r.label === 'TI 顶级', 'label 应为 TI 顶级');
  } finally {
    requestHandler = defaultRequestHandler;
    cache.remove('stratz_leagues');
  }
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
