// scripts/test-sources.js
// 多数据源回退链 mock 测试（不联网，模拟 wx 环境已验证降级逻辑正确）。
// 直接 stubs wx/cache，然后 require 源码模块并运行测试。

'use strict';

let passed = 0;
let failed = 0;
function check(label, fn) {
  try {
    fn();
    passed++;
    console.log('PASS  ' + label);
  } catch (e) {
    failed++;
    console.log('FAIL  ' + label + '  ->  ' + e.message);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

// ===== 1. 设置 mock 环境 =====
const storage = {};
global.wx = {
  request: function(opts) {
    // 模拟网络不可达：始终失败
    if (opts.fail) opts.fail({ errMsg: 'request:fail (mock network down)' });
    else if (opts.success) opts.success({ statusCode: 403, data: null });
  },
  getStorageSync: function(key) { return storage[key] || null; },
  setStorageSync: function(key, val) { storage[key] = val; },
  removeStorageSync: function(key) { delete storage[key]; },
  getStorageInfoSync: function() { return { keys: Object.keys(storage) }; }
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
const stratz = require(path.join(SRC, 'stratz.js'));
const steam = require(path.join(SRC, 'steam.js'));
const consensus = require(path.join(SRC, 'consensus.js'));
const curation = require(path.join(SRC, 'curation.js'));
const sources = require(path.join(SRC, 'sources.js'));

// ===== 4. 导出结构检查 =====
console.log('\n--- 模块导出结构 ---');
check('stratz.ENABLED (目前关闭)', () => assert(stratz.ENABLED === false));
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
console.log('\n--- 分级回退链（sources.getLeagueTier）---');

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
console.log('\n--- 赛程窗口回退链 ---');
check('无可用窗口源 -> 返回 null', async () => {
  const r = await sources.getLeagueWindow({ name: 'The International 2025' });
  assert(r === null, '无源时应为 null');
});

// ===== 7. STRATZ / Steam 禁用时返回空 =====
console.log('\n--- STRATZ / Steam 禁用时行为 ---');
check('stratz.ENABLED === false', () => assert(!stratz.ENABLED));
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
console.log('\n--- 战队 logo / 队员头像多源增强 ---');
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
console.log('\n--- 战队扩展信息 / 直播聚合 ---');
check('enrichTeamInfo 无可用源 -> null', async () => {
  const r = await sources.enrichTeamInfo({ name: 'Test Team' });
  assert(r === null, '应返回 null');
});
check('enrichLiveGames 全部禁用 -> 空数组', async () => {
  const r = await sources.enrichLiveGames();
  assert(Array.isArray(r) && r.length === 0, '应返回空数组');
});

// ===== 汇总 =====
console.log('\n=== 结果 ===');
console.log('通过: ' + passed + '  失败: ' + failed);
console.log(failed === 0 ? '全部通过 ✅' : '存在失败 ❌');
process.exit(failed === 0 ? 0 : 1);
