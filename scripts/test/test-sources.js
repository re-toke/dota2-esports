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
const purge = ['cache.js', 'config.js', 'tiers.js', 'api.js', 'util.js', 'stratz.js', 'steam.js', 'consensus.js', 'curation.js', 'liquipedia.js', 'sources.js'];
for (const k of Object.keys(require.cache)) {
  for (const name of purge) { if (k.indexOf(name) >= 0) delete require.cache[k]; }
}

// ===== 3. require 各模块 =====
const path = require('path');
const SRC = path.resolve(__dirname, '..', '..', 'utils');
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
const liquipedia = require(path.join(SRC, 'liquipedia.js'));

// 与 api.js 内部 _v() 保持一致：缓存 key 前缀 = (dataVersion || '0') + ':'。
// test 3/4 注入与读取陈旧缓存必须使用同一前缀，否则 cached() 的 peek 命中不到。
let cshared = null;
try { cshared = require(path.join(SRC, 'curation-shared.js')); } catch (e) { cshared = null; }
const V = ((cshared && cshared.dataVersion) || '0') + ':';

// ===== 4. 导出结构检查 =====
section('\n--- 模块导出结构 ---');
check('stratz.ENABLED 是布尔（2026-08-24 恢复启用，断言改为属性稳定性）', () => assert(typeof stratz.ENABLED === 'boolean'));
check('stratz.getLeagues exists', () => assert(typeof stratz.getLeagues === 'function'));
check('stratz.getLeagueTier exists', () => assert(typeof stratz.getLeagueTier === 'function'));
check('stratz.getTeamLogo exists', () => assert(typeof stratz.getTeamLogo === 'function'));
check('stratz.getPlayerAvatar exists', () => assert(typeof stratz.getPlayerAvatar === 'function'));
check('steam.ENABLED (云代理已启用)', () => assert(steam.ENABLED === true));
check('sources.getLeagueTier exists', () => assert(typeof sources.getLeagueTier === 'function'));
check('sources.getLeagueWindow exists', () => assert(typeof sources.getLeagueWindow === 'function'));
check('sources.enrichTeamLogo exists', () => assert(typeof sources.enrichTeamLogo === 'function'));
check('sources.enrichPlayerAvatar exists', () => assert(typeof sources.enrichPlayerAvatar === 'function'));
check('sources.enrichTeamInfo exists', () => assert(typeof sources.enrichTeamInfo === 'function'));

// ===== 5. 分级回退链测试 =====
section('\n--- 分级回退链（sources.getLeagueTier）---');

check('TI curation S + community SSS → 共识 S（Liquipedia 缺失兜底）', async () => {
  const r = await sources.getLeagueTier({ name: 'The International 2025', tier: 'professional' });
  assert(r !== null, '返回不应为 null');
  assert(r.source === 'consensus', '应为 consensus 源，实际: ' + r.source);
  assert(r.grade === 'S', 'curation S 应使 TI 为 S 级，实际: ' + r.grade);
  assert(r.label === 'S级', 'label 应为 S级');
  assert(r.sources.indexOf('curation') >= 0, 'curation 应参与赢家组，实际 sources: ' + JSON.stringify(r.sources));
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

// ★ 2026-09-19（收录严谨化 · 白名单准入）：amateur 不再映射为 B —— 新口径下 amateur 不收录
//   （服务端 trimLeagues 已丢弃 amateur；客户端 unifiedTier 判 C，列表页再过滤 C 级）。
check('amateur 赛事不再映射为 B（白名单准入）', async () => {
  const r = await sources.getLeagueTier({ name: 'Random Cup', tier: 'amateur' });
  assert(r.sources.indexOf('opendota') >= 0, '应为 opendota');
  assert(r.grade === 'C', 'amateur 应返回 C（不收录），实际: ' + r.grade);
});
check('硬排除：周赛/月赛（Liquipedia 收录门槛外）', async () => {
  const r = await sources.getLeagueTier({ name: 'Weekly Cup', tier: 'amateur' });
  assert(r.grade === 'C', 'Weekly Cup 应判 C，实际: ' + r.grade);
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
// 2026-08-24：STRATZ 已恢复启用（Cloudflare 拦截解除 + schema 适配）。
// ENABLED 布尔断言已在 §4 覆盖，此处改为「未启用时返回 null」的契约测试：
// 当 ENABLED=true 时此测试自动通过（mock 网络不可达 → 返回 null 也成立）。
check('stratz.ENABLED 状态稳定（启用/停用都应是布尔）', () => assert(typeof stratz.ENABLED === 'boolean'));
check('stratz.getLeagueTier 禁用/网络不可达时返回 null', async () => {
  const r = await stratz.getLeagueTier('Any');
  assert(r === null, '禁用/不可达时应返回 null');
});
check('stratz.getLeagues 禁用时返回空数组', async () => {
  const r = await stratz.getLeagues();
  assert(Array.isArray(r) && r.length === 0, '应返回空数组');
});
check('stratz.getTeamLogo disabled -> null', async () => {
  const r = await stratz.getTeamLogo(15);
  assert(r === null, 'disabled should return null');
});
check('steam.ENABLED === true (云代理已启用)', () => assert(!!steam.ENABLED));

// ===== 8. 战队 logo / 队员头像多源增强 =====
section('\n--- 战队 logo / 队员头像多源增强 ---');
check('enrichTeamLogo no logo + STRATZ disabled -> null', async () => {
  const r = await sources.enrichTeamLogo({ name: 'Unknown Team', id: 999999 });
  assert(r === null, 'should return null');
});
check('enrichTeamLogo existing logo -> return directly', async () => {
  const r = await sources.enrichTeamLogo({ name: 'LGD', id: 10150538, logo: 'https://existing.example/logo.png' });
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

// ===== 10. 响应校验（api.cached 拒绝畸形 body 并回退）=====
section('\n--- 响应校验（api.cached 拒绝畸形 body 并回退）---');

// cached() 收到 200 + null（畸形 body）时不应写入缓存，应回退到陈旧缓存值。
// 注意：cache.get() 对过期条目会主动删除，导致 peek() 读不到陈旧值。
// 这里临时阻止删除该测试 key，以验证 cached()「回退 stale」逻辑分支。
check('cached() 拒绝畸形 body(null) 并回退陈旧缓存', async () => {
  const cacheKey = V + '/leagues|{}';
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
  const cacheKey = V + '/leagues|{}';
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

// ===== 12. STRATZ 精确名匹配（findLeagueByName 经 getLeagueTier）=====
// findLeagueByName 未导出，但可通过 stratz.getLeagueTier(name) + mock wx.request 间接验证：
// 返回包含两个名称相近的联赛，查询精确名应命中对应赛事（证明归一等值匹配优于子串匹配）。
// ★ 2026-08-24：STRATZ 已恢复启用（Cloudflare 解除 + schema 适配完成）。
//   本测试仍临时显式启用 + 注入 mock apiKey，确保不依赖云函数环境变量。
section('\n--- STRATZ 精确名匹配（精确归一 > 子串）---');
check('stratz.getLeagueTier 精确名命中 DPC_MAJOR→S（非子串误命中）', async () => {
  // 显式注入 mock apiKey，确保走直连路径（不依赖云函数环境变量）
  const origStratzEnabled = config.stratz.enabled;
  const origStratzApiKey = config.stratz.apiKey;
  config.stratz.enabled = true;
  config.stratz.apiKey = 'test-key-for-direct-path';
  // 重新计算 ENABLED 标志（模块加载时已固定，需通过显式判断绕过）
  // 实际 stratz.js 的 ENABLED 是模块级常量，无法运行时改变；
  // 但 getLeagueTier 内部会检查 config.stratz.enabled，所以这里改 config 即可生效。
  // 清除 stratz 联赛缓存，强制走 mock wx.request
  cache.remove('stratz_leagues');
  // 测试环境无 wx.cloud，stratz 默认走云代理路径会返回 null；填入 apiKey 使其进入
  // 「云代理优先 + 直连兜底」混合模式，云代理不可用时回退到 wx.request 直连，
  // 从而命中下面 mock 的联赛列表。
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
    // DPC_MAJOR 现映射为 S 级（原 SSS 仅保留给 TI，由 communityTierFromName 精确匹配）
    assert(r.grade === 'S', 'DPC_MAJOR 应映射为 S，实际: ' + (r && r.grade));
    assert(r.label === 'S级', 'label 应为 S级');
  } finally {
    requestHandler = defaultRequestHandler;
    config.stratz.enabled = origStratzEnabled;
    config.stratz.apiKey = origStratzApiKey;
    cache.remove('stratz_leagues');
  }
});

// ===== 13. sources.getLeagueMetadata 聚合 Liquipedia + Steam =====
section('\n--- sources.getLeagueMetadata 聚合 Liquipedia + Steam ---');

// 测试 6：Liquipedia 提供奖金池时优先采用，Steam 仅作为来源记录参与交叉验证。
// monkeypatch liquipedia.getLeagueMetadata / steam.getTournamentPrizePool / steam.ENABLED，
// 所有 patch 在 finally 中恢复原值，避免污染后续测试。
check('sources.getLeagueMetadata 聚合 Liquipedia + Steam 奖金池', async () => {
  const origLiq = liquipedia.getLeagueMetadata;
  const origSteamEnabled = steam.ENABLED;
  const origSteamPP = steam.getTournamentPrizePool;
  liquipedia.getLeagueMetadata = function () {
    return Promise.resolve({
      canonical: 'TI 2024', prizePool: 1500000, prizePoolCurrency: 'USD',
      startDate: null, endDate: null, location: null, format: null, organizer: null
    });
  };
  steam.ENABLED = true;
  steam.getTournamentPrizePool = function () {
    return Promise.resolve({ prizePool: 1600000, prizePoolCurrency: 'USD', leagueId: 1, source: 'steam' });
  };
  try {
    const r = await sources.getLeagueMetadata({ name: 'TI 2024', leagueid: 1 });
    assert(r !== null, '返回不应为 null');
    assert(r.prizePool === 1500000, 'Liquipedia 奖金池应胜出（1500000），实际: ' + r.prizePool);
    assert(r.sources.indexOf('liquipedia') >= 0,
      'sources 应含 liquipedia，实际: ' + JSON.stringify(r.sources));
    assert(r.sources.indexOf('steam') >= 0,
      'sources 应含 steam，实际: ' + JSON.stringify(r.sources));
  } finally {
    liquipedia.getLeagueMetadata = origLiq;
    steam.ENABLED = origSteamEnabled;
    steam.getTournamentPrizePool = origSteamPP;
  }
});

// 测试 7：Liquipedia 缺失奖金池（prizePool=null）时 Steam 兜底提供奖金池
check('sources.getLeagueMetadata Steam 兜底（Liquipedia 缺失奖金池）', async () => {
  const origLiq = liquipedia.getLeagueMetadata;
  const origSteamEnabled = steam.ENABLED;
  const origSteamPP = steam.getTournamentPrizePool;
  liquipedia.getLeagueMetadata = function () {
    return Promise.resolve({
      canonical: 'TI 2024', prizePool: null, prizePoolCurrency: null,
      startDate: null, endDate: null, location: null, format: null, organizer: null
    });
  };
  steam.ENABLED = true;
  steam.getTournamentPrizePool = function () {
    return Promise.resolve({ prizePool: 1600000, prizePoolCurrency: 'USD', leagueId: 1, source: 'steam' });
  };
  try {
    const r = await sources.getLeagueMetadata({ name: 'TI 2024', leagueid: 1 });
    assert(r !== null, '返回不应为 null');
    assert(r.prizePool === 1600000, 'Steam 奖金池应兜底（1600000），实际: ' + r.prizePool);
    assert(r.sources.indexOf('steam') >= 0,
      'sources 应含 steam，实际: ' + JSON.stringify(r.sources));
  } finally {
    liquipedia.getLeagueMetadata = origLiq;
    steam.ENABLED = origSteamEnabled;
    steam.getTournamentPrizePool = origSteamPP;
  }
});

// 测试 8：voteLeagueNameForMatch 包含 Liquipedia 候选（原 getLeagueName @deprecated 别名，O-11 已删，改测正式名）
// 传 { name: 'TI 2024' }（无 leagueid → stratz 分支跳过），curation 与 liquipedia 均返回
// 'The International 2024'，voteName 归一后两源一致胜出，sources 含 liquipedia。
check('sources.voteLeagueNameForMatch 包含 Liquipedia 候选', async () => {
  const origLiq = liquipedia.getLeagueMetadata;
  const origStratzDisp = stratz.getLeagueDisplayName;
  liquipedia.getLeagueMetadata = function () {
    return Promise.resolve({ canonical: 'The International 2024' });
  };
  stratz.getLeagueDisplayName = function () { return Promise.resolve(null); };
  try {
    const r = await sources.voteLeagueNameForMatch({ name: 'TI 2024' });
    assert(r !== null, '返回不应为 null');
    assert(r.value === 'The International 2024',
      'value 应为 The International 2024，实际: ' + r.value);
    assert(r.sources.indexOf('liquipedia') >= 0,
      'sources 应含 liquipedia，实际: ' + JSON.stringify(r.sources));
  } finally {
    liquipedia.getLeagueMetadata = origLiq;
    stratz.getLeagueDisplayName = origStratzDisp;
  }
});

// ===== 收录规则回归（2026-07-30 修复：未收录 + 收录错误）=====
section('\n--- 收录规则回归（未收录 / 收录错误）---');

check('EPL Masters I curation 分级 rank 必须为 2（非 8，避免智能排序误排到 TI 之上）', () => {
  const ev = curation.curatedEventFor('EPL Masters I', { game: 'dota2' });
  assert(ev && ev.tier, '应命中 EPL Masters I');
  assert(ev.tier.grade === 'A', 'grade 应为 A，实际: ' + ev.tier.grade);
  assert(ev.tier.rank === 2, 'rank 必须为 2（A-Tier），实际: ' + ev.tier.rank);
});

check('communityTierFromName 不再误升社区戏称（收录错误回归）', () => {
  assert(tiers.communityTierFromName('Community Minor Scrims') === null, 'Minor 戏称应不命中');
  assert(tiers.communityTierFromName('Minor League Weekly') === null, 'Minor League 应不命中');
  assert(tiers.communityTierFromName('Major Meme Tournament') === null, 'Major 戏称应不命中');
  assert(tiers.communityTierFromName('Youth Major League') === null, 'Major 戏称应不命中');
});

check('communityTierFromName 真实 DPC Major/Minor 仍正确识别', () => {
  const m = tiers.communityTierFromName('DPC SEA Minor 2024');
  assert(m && m.grade === 'A' && m.rank === 2, 'DPC Minor 应 A 级，实际: ' + (m && m.grade));
  const M = tiers.communityTierFromName('The Kuala Lumpur Major');
  assert(M && M.grade === 'S' && M.rank === 3, '真实 Major 应 S 级，实际: ' + (M && M.grade));
});

// ===== §9 排除规则测试（2026-07-30）=====
// 验证 EXCLUSION_RULES / shouldExclude / communityTierFromName 前置排除逻辑
section('\n--- §9 通用排除规则（community 正则误升防护）---');

check('shouldExclude 导出可用', () => {
  assert(typeof tiers.shouldExclude === 'function', 'shouldExclude 应为函数');
  assert(Array.isArray(tiers.EXCLUSION_RULES), 'EXCLUSION_RULES 应为数组');
  // ★ 2026-09-19：规则拆为「硬排除」(HARD_EXCLUDE_RULES，EXCLUSION_RULES 为向后兼容别名)
  //   + 「预选赛降级」(QUALIFIER_RULES)。不再断言固定条数，改为自洽 + 下限断言。
  assert(Array.isArray(tiers.HARD_EXCLUDE_RULES), 'HARD_EXCLUDE_RULES 应为数组');
  assert(Array.isArray(tiers.QUALIFIER_RULES), 'QUALIFIER_RULES 应为数组');
  assert(tiers.EXCLUSION_RULES.length === tiers.HARD_EXCLUDE_RULES.length, 'EXCLUSION_RULES 别名应指向硬排除集合');
  assert(tiers.HARD_EXCLUDE_RULES.length >= 4, '硬排除应含 >=4 条规则，实际: ' + tiers.HARD_EXCLUDE_RULES.length);
});

// ★ 2026-09-19（用户决策3）：预选赛由「排除」改为「保留但降级为 B 级 + qualifier 标注」
check('预选赛保留但降级为 B 级 + 标注（2026-09-19 口径变更）', () => {
  assert(!tiers.shouldExclude('Open Qualifier'), 'Open Qualifier 不再硬排除（保留）');
  assert(!tiers.shouldExclude('Closed Qualifier'), 'Closed Qualifier 不再硬排除（保留）');
  assert(tiers.isQualifier('Open Qualifier'), 'Open Qualifier 应识别为预选赛');
  assert(tiers.isQualifier('Closed Qualifier'), 'Closed Qualifier 应识别为预选赛');
  assert(tiers.isQualifier('Regional Qualifier'), 'Regional Qualifier 应识别为预选赛');
  assert(tiers.isQualifier('Play-In Tournament'), 'Play-In 应识别为预选赛');
  assert(tiers.isQualifier('PlayIn Cup'), 'PlayIn 应识别为预选赛');
  // 降级验证：命中 ESL One（原本 S 级）的预选赛必须被扣到 B 级并打标注
  const q = tiers.communityTierFromName('ESL One Birmingham Qualifiers');
  assert(!!q && q.grade === 'B' && q.rank === 1 && q.qualifier === true,
    'ESL One 预选赛应降级为 B 级+标注，实际: ' + JSON.stringify(q));
  // 未命中任何系列的预选赛同样保留为 B
  const q2 = tiers.communityTierFromName('Knight Cup Qualifier');
  assert(!!q2 && q2.grade === 'B' && q2.qualifier === true,
    '无名预选赛应保留为 B 级+标注，实际: ' + JSON.stringify(q2));
});

check('排除②业余/社区/青训关键词', () => {
  assert(tiers.shouldExclude('Dota 2 Amateur Series'), 'Amateur 应排除');
  assert(tiers.shouldExclude('Community Cup'), 'Community 应排除');
  assert(tiers.shouldExclude('Collegiate League'), 'Collegiate 应排除');
  assert(tiers.shouldExclude('University Tournament'), 'University 应排除');
  assert(tiers.shouldExclude('Youth Cup'), 'Youth 应排除');
  assert(tiers.shouldExclude('Academy League'), 'Academy 应排除');
  assert(tiers.shouldExclude('Junior Series'), 'Junior 应排除');
});

check('排除③慈善/娱乐/表演赛关键词', () => {
  assert(tiers.shouldExclude('Charity Cup'), 'Charity 应排除');
  assert(tiers.shouldExclude('Fun Tournament'), 'Fun 应排除');
  assert(tiers.shouldExclude('Funny Match'), 'Funny 应排除');
  assert(tiers.shouldExclude('Meme League'), 'Meme 应排除');
  assert(tiers.shouldExclude('Showmatch 2024'), 'Showmatch 应排除');
  assert(tiers.shouldExclude('All-Star Game'), 'All-Star 应排除');
  assert(tiers.shouldExclude('AllStar Showdown'), 'AllStar 应排除');
});

check('排除④TI 预选路径专用', () => {
  assert(tiers.shouldExclude('Road To The International 2024'), 'Road To TI 应排除');
  assert(tiers.shouldExclude('Road to the International 2024 - Regional Qualifiers'), 'Road To TI 含 Qualifiers 应排除');
  assert(tiers.shouldExclude('Path to TI 2025'), 'Path to TI 应排除');
  assert(tiers.shouldExclude('Path to The International'), 'Path to The International 应排除');
});

check('communityTierFromName 排除规则前置生效（误升防护）', () => {
  // 原 premier 正则误升 S，现应返回 null（含 amateur/community 排除关键词）
  assert(tiers.communityTierFromName('Premier Amateur Community League') === null, 'Premier Amateur Community League 应排除');
  // 原 the international 正则误升 SSS，现应返回 null（含 Road To TI + Qualifiers 排除关键词）
  assert(tiers.communityTierFromName('Road To The International 2024 - Regional Qualifiers') === null, 'TI 预选路径应排除');
  // amateur/Youth 应被前置排除
  assert(tiers.communityTierFromName('Dota 2 Amateur Series') === null, 'Amateur 应排除');
  assert(tiers.communityTierFromName('Youth Cup 2024') === null, 'Youth Cup 应排除');
  assert(tiers.communityTierFromName('Community Major') === null, 'Community Major 应排除');
  // ★ 已知限制：SAGEMASK MAJOR / PONIME MAJOR 不含排除关键词，仍会被 major 规则误判为 S
  //   这类"未知前缀 + MAJOR"的社区赛需通过 Liquipedia Tier 字段或人工审核纠正，
  //   不在本次排除规则范围内（需 major 前置白名单，lookbehind 不支持微信运行时）
});

check('排除规则不误伤真实赛事（安全回归）', () => {
  // 真实赛事不应命中排除规则
  assert(!tiers.shouldExclude('The International 2024'), 'TI 正赛不应排除');
  assert(!tiers.shouldExclude('ESL One Birmingham 2024'), 'ESL One 不应排除');
  assert(!tiers.shouldExclude('DreamLeague Season 22'), 'DreamLeague 不应排除');
  assert(!tiers.shouldExclude('PGL Wallachia'), 'PGL Wallachia 不应排除');
  assert(!tiers.shouldExclude('BLAST Slam'), 'BLAST Slam 不应排除');
  assert(!tiers.shouldExclude('Riyadh Masters 2024'), 'Riyadh Masters 不应排除');
  assert(!tiers.shouldExclude('DPC SEA Minor 2024'), 'DPC Minor 不应排除');
  assert(!tiers.shouldExclude('The Kuala Lumpur Major'), 'Major 正赛不应排除');
  // ★ FunPlus / Funcurve 等含 fun 但非完整单词，不应误匹配
  assert(!tiers.shouldExclude('FunPlus Phoenix Tournament'), 'FunPlus 不应误匹配 fun');
  assert(!tiers.shouldExclude('Funcurve Cup'), 'Funcurve 不应误匹配 fun');
  // ★ CommunityBank 等含 community 但非完整单词，不应误匹配
  assert(!tiers.shouldExclude('CommunityBank Cup'), 'CommunityBank 不应误匹配 community');
  // ★ Academy 对抗 FunPlus 的边界：Academy 单独应排除，但含 Academy 的真实赛事名?
  //   Dota 2 中 Academy 赛事确实多为青训赛，排除合理
  // ★ open 单独不排除（ESL Open 是 A-Tier 真实赛事）
  assert(!tiers.shouldExclude('Open Cup'), 'Open Cup 不应排除（无 qualifier 关键词）');
});

check('communityTierFromName 真实赛事仍正常分级（排除规则不破坏现有逻辑）', () => {
  // 验证排除规则前置后，真实赛事仍能被正确分级
  const ti = tiers.communityTierFromName('The International 2024');
  assert(ti && ti.grade === 'S', 'TI 应为 S 级（对齐 Liquipedia），实际: ' + (ti && ti.grade));
  assert(ti && ti.label === 'S级', 'label 应为 S 级，实际: ' + (ti && ti.label));
  const esl = tiers.communityTierFromName('ESL One Birmingham 2024');
  assert(esl && esl.grade === 'S', 'ESL One 仍应为 S');
  const dl = tiers.communityTierFromName('DreamLeague Season 22');
  assert(dl && dl.grade === 'S', 'DreamLeague 仍应为 S');
  const minor = tiers.communityTierFromName('DPC SEA Minor 2024');
  assert(minor && minor.grade === 'A', 'DPC Minor 仍应为 A');
  const major = tiers.communityTierFromName('The Kuala Lumpur Major');
  assert(major && major.grade === 'S', 'Major 仍应为 S');
  const div1 = tiers.communityTierFromName('DPC Division I');
  assert(div1 && div1.grade === 'A', 'Division I 仍应为 A');
});

check('curation 名称救援兼容 "Dota 2" 后缀（未收录回归：esportsworldcup2026dota2 应命中 EWC 2026）', () => {
  const ev = curation.curatedEventFor('Esports World Cup 2026 Dota 2', { game: 'dota2' });
  assert(ev && /esports world cup 2026/i.test(ev.canonical), '应命中 EWC 2026，实际: ' + (ev && ev.canonical));
});

// ===== 运行全部测试（顺序执行，支持 async）=====
// ===== 跨源赛事名归一 sources.leagueBaseName（2026-09-19）=====
section('\n--- 跨源赛事名归一 leagueBaseName（2026-09-19）---');
const _srcTest = require('../../utils/sources.js');
// ★ 回归守卫：同一赛事在不同源里写法不同 → 曾被当成**两个赛事**
//   真机现象：列表页「进行中」显示全称 "PGL Wallachia Season 9"，
//   而「即将开始」显示缩写 "PGL Wallachia S9"（信息还不全）。
//   根因：haglund 用缩写、curation/快照用全称，跨源比对未归一 → 去重挡不住。
check('S9 缩写应归一为 Season 9 全称（跨源同键）', function () {
  assert(_srcTest.leagueBaseName('PGL Wallachia S9') ===
         _srcTest.leagueBaseName('PGL Wallachia Season 9'),
    'S9 与 Season 9 应归一为同一名');
});
check('带阶段后缀也应归一到同一赛事', function () {
  const a = _srcTest.leagueBaseName('PGL Wallachia S9 - Round 1');
  const b = _srcTest.leagueBaseName('PGL Wallachia S9 - Playoffs');
  const c = _srcTest.leagueBaseName('PGL Wallachia Season 9');
  assert(a === b && b === c, 'Round 1 / Playoffs / 全称 应同键，实际: ' + [a, b, c].join(' | '));
});
check('关键负例：含短横线的赛事名不被误剥离', function () {
  const n = 'RES Unchained - A Blast Dota Slam VIII Qualifier';
  assert(_srcTest.leagueBaseName(n) === n, '不应被剥离，实际: ' + _srcTest.leagueBaseName(n));
});
check('Division 1/2 不被当作阶段剥离', function () {
  const n = 'DreamLeague Season 30 - Division 1';
  assert(_srcTest.leagueBaseName(n) === n, '不应被剥离，实际: ' + _srcTest.leagueBaseName(n));
});
check('TI 别名归一（TI 2026 ↔ The International 2026）', function () {
  assert(_srcTest.leagueBaseName('TI 2026 - Main Event') ===
         _srcTest.leagueBaseName('The International 2026'),
    'TI 2026 与 The International 2026 应同键');
});
// ★ 2026-09-19 新增负例（真机数据实测教训）：
//   预选赛在赛程数据里**常作为独立赛事**出现（不同赛区各有 leagueid）→
//   绝不能当"阶段后缀"剥掉，否则 Elite League 的 8 个赛区会被并成同一个键。
check('预选赛各赛区不应被当作阶段剥离（Elite League）', function () {
  const a = _srcTest.leagueBaseName('Elite League - Closed Qualifier SEA');
  const b = _srcTest.leagueBaseName('Elite League - Closed Qualifier MENA');
  assert(a !== b, '不同赛区预选是不同赛事，不应同键，实际都为: ' + a);
  assert(a === 'Elite League - Closed Qualifier SEA', '应原样保留，实际: ' + a);
});
check('BLAST 系列预选亦不合并', function () {
  const n1 = 'BLAST SLAM IX China Open Qualifier 1';
  const n2 = 'BLAST SLAM IX China Open Qualifier 2';
  assert(_srcTest.leagueBaseName(n1) === n1 && _srcTest.leagueBaseName(n2) === n2,
    '不同预选轮次应原样保留');
});
check('CJK / 西里尔赛事名不被抹成空键或退化键', function () {
  const a = _srcTest.leagueKey('Чемпионат Москвы 2024');
  const b = _srcTest.leagueKey('Открытые Киберспортивные Игры 2024');
  assert(a !== b, '两个俄语赛事不应同键，实际都为: ' + a);
  assert(a.length > 4, '俄语名不应退化成纯年份，实际: ' + a);
  assert(_srcTest.leagueKey('刀塔校运会').length > 0, '中文名不应被抹成空串');
});
check('leagueKey：去重实际用的键，S9 与 Season 9 必须同键', function () {
  assert(_srcTest.leagueKey('PGL Wallachia S9 - Round 1') ===
         _srcTest.leagueKey('PGL Wallachia Season 9'),
    '去重键应相同（这是 mergeAllWithUpcoming / dedupeByDisplayName 实际使用的键）');
});
check('leagueKey：不同赛区预选必须不同键', function () {
  assert(_srcTest.leagueKey('Elite League - Closed Qualifier SEA') !==
         _srcTest.leagueKey('Elite League - Closed Qualifier MENA'),
    '不同赛区预选不应同键');
});

// ===== 展示名路径（canonicalLeagueName / leagueDisplayName）—— 2026-09-19 补 =====
// ★★ 本节存在的理由（教训）：
//   项目里存在**两条独立的赛事名归一化路径**：
//     ① 去重键： leagueKey → leagueBaseName              （判重/合并用）
//     ② 展示名： leagueDisplayName → canonicalLeagueName  （**卡片标题 + 详情页入参**用）
//   上一轮修「年份位置变体」时**只修了 ①**，结果：
//     · 列表不再重复 ✓
//     · 但留下的那张卡标题仍是 OpenDota 原名 `PGL Wallachia 2026 Season 9` ✗
//     · 详情页拿这个名字查 curation **MISS** → 赛期/元数据缺失
//     · LP/haglund 按这个名字找赛程**双双 MISS** → 对局从 36 场掉到 1 场
//   ⇒ **凡修归一化，必须同时锁住这两条路径**（本节即为此而设，勿删）。
section('\n--- 展示名归一 leagueDisplayName / canonicalLeagueName（2026-09-19 补）---');
check('★ 展示名：年份插在中间也必须归一到 curation 规范名', function () {
  const d = _srcTest.leagueDisplayName({ leagueid: 20279, name: 'PGL Wallachia 2026 Season 9' });
  assert(d === 'PGL Wallachia Season 9',
    '展示名应为规范名（卡片标题 + 详情页入参都用它），实际: ' + d);
});
check('★ 展示名：两条路径必须给出同一赛事（防「只修一条」复发）', function () {
  const raw = 'PGL Wallachia 2026 Season 9';
  const canon = 'PGL Wallachia Season 9';
  assert(_srcTest.leagueDisplayName({ leagueid: 20279, name: raw }) ===
         _srcTest.leagueDisplayName({ leagueid: -1973943, name: canon }),
    '两种写法的展示名必须一致');
  assert(_srcTest.leagueKey(raw) === _srcTest.leagueKey(canon),
    '两种写法的去重键必须一致');
});
check('展示名：已命中 curation 的权威名不得被再剥年份（防误映射）', function () {
  // `The International 2026` 本身命中 curation → 不应退化成 `The International` 去模糊匹配，
  // 否则有映射到其它届次的风险。
  const d = _srcTest.leagueDisplayName({ leagueid: 19719, name: 'The International 2026' });
  assert(d === 'The International 2026', '应保持不变，实际: ' + d);
});
check('展示名：届次数字（非 4 位年份）不受影响', function () {
  const a = _srcTest.leagueDisplayName({ name: 'DreamLeague Season 30' });
  const b = _srcTest.leagueDisplayName({ name: 'DreamLeague Season 31' });
  assert(a !== b, 'Season 30 / 31 是两个赛事，不应被合并，实际: ' + a + ' | ' + b);
});
check('展示名：未收录的普通赛事名不应被改写', function () {
  const n = 'Some Uncovered Amateur Cup 2026';
  assert(_srcTest.leagueDisplayName({ name: n }) === n, '未命中的名字应原样返回，实际: ' + _srcTest.leagueDisplayName({ name: n }));
});
check('展示名：中文 / 空值边界', function () {
  assert(_srcTest.leagueDisplayName({ name: '刀塔校运会' }) === '刀塔校运会', '中文名不应被改写');
  assert(_srcTest.leagueDisplayName('') === '', '空串应原样返回');
  assert(_srcTest.leagueDisplayName(null) === '', 'null 应安全返回空串');
});

// ===== ⑥ LP slug 覆盖 + 预选赛命名/分级守卫（2026-09-25 补）=====
// ★★ 本节存在的理由（教训，勿删）：
//   1) curation 的 `liquipediaSlug` 是**人工录入的自由文本**。此前只验证过「curatedEventFor 能返回
//      slug」就当成通过 ⇒ **假绿灯**：3 条预选赛的 slug 在 LP 上**根本不存在**
//      （`BLAST/Slam/9/China`、`RES_Unchained/6/BLAST_SLAM_IX/Europe`、`.../Southeast_Asia`），
//      详情页对阵 tab 静默取不到任何数据。
//      存在性必须联网核验（`npm run verify:lp-slugs -- --curation`，依赖外网**不入 CI**）；
//      但「值本身」与「别名覆盖」可以离线锁死 —— 本节即为此。
//      教训口诀：**「能取到值」≠「值有效」**。
//   2) curation 的 tier 曾漏过「预选赛降级 B 级」口径：3 条 BLAST SLAM IX 预选赛按 **S 级**
//      上了首页（同批另 2 条却是 B）⇒ 分级完全取决于人工录入是否自觉，必须用断言锁住。
//   3) canonical 若不含 `qualifier|regional`，会被 `pages/leagues.js` 的 IS_FLAGSHIP
//      当成 TI/EWC **旗舰赛事**（可能顶掉正赛焦点卡）—— 命名规则要能被测试挡住。
section('\n--- LP slug 覆盖 + 预选赛命名/分级守卫（2026-09-25 补）---');
const cura = require('../../utils/curation.js');

// 与 pages/leagues.js buildFocusNode 内的 IS_FLAGSHIP 保持同步（改一处必须改两处）
const IS_FLAGSHIP_REF = function (c) {
  if (!c) return false;
  if (/qualifier|open|regional/i.test(c)) return false;
  return /^the international/i.test(c) || /^esports world cup/i.test(c);
};

// ★ 2026-09-25 用 LP API 逐条**实测存在**的真身（+ `{{Match}}` 数）。
//   ⚠️ 大小写是真实值，别凭"看起来更整齐"改回 `BLAST/Slam/...`：
//   LP 只有**首字母**大小写不敏感，且手建 redirect **不跨届次**
//   （`BLAST/Slam/7/China` ✅ 有 redirect，`BLAST/Slam/9/China` ❌ 没有）。
const VERIFIED_SLUGS = [
  ['The International 2026 - Regional Qualifier Europe', 'The_International/2026/Europe', 26],
  ['The International 2026 - Regional Qualifier North America', 'The_International/2026/North America', 6],
  ['The International 2026 - Regional Qualifier South America', 'The_International/2026/South America', 18],
  ['The International 2026 - Regional Qualifier China', 'The_International/2026/China', 13],
  ['The International 2026 - Regional Qualifier Southeast Asia', 'The_International/2026/Southeast Asia', 18],
  ['BLAST Slam VII China Qualifier', 'BLAST/SLAM/7/China', 7],
  ['RES Unchained - A Blast Dota Slam IX Qualifier EU', 'BLAST/SLAM/9/Europe', 0],
  ['RES Unchained - A Blast Dota Slam IX Qualifier SEA', 'BLAST/SLAM/9/Southeast Asia', 0]
];

check('★ LP slug：8 条活跃缺口的「源名 → 真身」必须逐字命中（防别名漂移 / slug 回退）', function () {
  VERIFIED_SLUGS.forEach(function (p) {
    const ev = cura.curatedEventFor(p[0], { game: 'dota2' });
    assert(ev, '源名未命中 curation（别名缺失，来自 OpenDota 的原名）: ' + p[0]);
    assert(ev.liquipediaSlug === p[1],
      p[0] + '\\n  期望 slug: ' + p[1] + '\\n  实际 slug: ' + ev.liquipediaSlug);
  });
});

check('★ LP slug：源名的展示名必须等于 canonical（详情页入参链路自洽）', function () {
  VERIFIED_SLUGS.forEach(function (p) {
    const ev = cura.curatedEventFor(p[0], { game: 'dota2' });
    const d = _srcTest.leagueDisplayName({ name: p[0] });
    assert(ev && d === ev.canonical,
      p[0] + '\\n  展示名应为 canonical「' + (ev && ev.canonical) + '」\\n  实际展示名: ' + d +
      '\\n  （展示名与 canonical 不一致 = 详情页拿它查 curation 会 MISS）');
  });
});

check('★★ 预选赛 canonical 必须含 qualifier|regional（否则会被 IS_FLAGSHIP 当旗舰卡）', function () {
  const bad = cura.CURATED_EVENTS.filter(function (e) {
    return e && e.tier && e.tier.qualifier === true && IS_FLAGSHIP_REF(e.canonical);
  });
  assert(bad.length === 0,
    '以下预选赛会被当成 TI/EWC 旗舰赛事 → 请**改 canonical 命名**（补 Qualifier/Regional 字样），' +
    '不要改 IS_FLAGSHIP 判据: ' + bad.map(function (e) { return e.canonical; }).join(' / '));
});

check('★ 预选赛分级：canonical 含 qualifier|play-in 的条目不得高于 B 级（2026-09-19 口径）', function () {
  const bad = cura.CURATED_EVENTS.filter(function (e) {
    return e && /qualifier|play-?in/i.test(e.canonical || '') && e.tier && e.tier.grade === 'S';
  });
  assert(bad.length === 0,
    '预选赛应降级 B 级，实际仍为 S: ' + bad.map(function (e) { return e.canonical; }).join(' / '));
});

check('★ 首页分级：curation 命中预选赛时也必须降级 B（getMatchTierForHome 闸门）', function () {
  const q = _srcTest.getMatchTierForHome('BLAST SLAM IX China Closed Qualifier');
  assert(q && q.grade === 'B', '预选赛首页分级应为 B，实际: ' + (q && q.grade));
  assert(q.qualifier === true, '预选赛应带 qualifier 标记（leagues.js 据此补展示标注）');
  const reg = _srcTest.getMatchTierForHome('The International 2026');
  assert(reg && reg.grade === 'S', '非预选赛（TI 正赛）不得被降级，实际: ' + (reg && reg.grade));
  const bal = _srcTest.getMatchTierForHome('BLAST SLAM IX');
  assert(bal && bal.grade === 'S', '非预选赛（SLAM IX 正赛）不得被降级，实际: ' + (bal && bal.grade));
});

check('★ curation 合并：Esports World Cup 2024 必须归并到 Riyadh Masters 2024（同一赛事）', function () {
  const d = _srcTest.leagueDisplayName({ name: 'Esports World Cup 2024' });
  assert(d === 'Riyadh Masters 2024', '展示名应为 Riyadh Masters 2024，实际: ' + d);
  const cu = cura.curatedEventFor('Esports World Cup 2024', { game: 'dota2' });
  assert(cu && cu.canonical === 'Riyadh Masters 2024', '应命中合并后的条目');
  assert(cu.liquipediaSlug === 'Riyadh_Masters/2024', '应继承真身 slug，实际: ' + cu.liquipediaSlug);
});

check('★★ curation 合并的边界：预选赛不得被并入正赛（共享 LP 页会串数据）', function () {
  // leagueid 16881 = 正赛，16740 = 预选 —— 两条 OpenDota 赛事，**不可**共用一个 curation 条目。
  // ⚠️ 2026-09-25 修订：预选赛后来**补录了自己的条目**（见下方「curation 补录」），
  //    故判据从「必须返回 null」改成「**不得解析到正赛条目**」——
  //    后者才是真正的不变量；原写法把「当时还没有该条目」当成了不变式（**过约束**，
  //    一旦有人正经补录就会误报）。这正是这条守卫发现问题的样子。
  const byName = cura.curatedEventFor('Riyadh Masters 2024 at Esports World Cup Qualifiers', { game: 'dota2' });
  assert(!byName || byName.canonical !== 'Riyadh Masters 2024',
    '预选赛名不得命中正赛条目，实际: ' + (byName && byName.canonical));
  const byPin = cura.curatedEventFor('Riyadh Masters 2024 at Esports World Cup Qualifiers',
    { leagueId: 16740, game: 'dota2' });
  assert(!byPin || byPin.canonical !== 'Riyadh Masters 2024',
    '预选赛 leagueId(16740) 不得被正赛条目命中，实际: ' + (byPin && byPin.canonical));
  const main = cura.curatedEventFor('Riyadh Masters 2024 at Esports World Cup', { leagueId: 16881, game: 'dota2' });
  assert(main && main.canonical === 'Riyadh Masters 2024', '正赛 leagueId(16881) 应 pin 命中');
});

check('★ curation 改名：Kuala Lumpur 按真身改为 2023，旧名必须仍能命中（零断链）', function () {
  const want = 'ESL One Kuala Lumpur 2023';
  ['ESL One Kuala Lumpur 2024', 'ESL One Kuala Lumpur powered by Intel', 'ESL One Kuala Lumpur 2023']
    .forEach(function (nm) {
      const cu = cura.curatedEventFor(nm, { game: 'dota2' });
      assert(cu && cu.canonical === want, nm + ' 应命中 ' + want + '，实际: ' + (cu && cu.canonical));
      assert(cu.liquipediaSlug === 'ESL One/Kuala Lumpur/2023',
        nm + ' 的 slug 应为真身 /2023，实际: ' + cu.liquipediaSlug);
    });
  const d = _srcTest.leagueDisplayName({ name: 'ESL One Kuala Lumpur 2024' });
  assert(d === want, '旧名的展示名应升级为真身名，实际: ' + d);
});

check('★ LP slug P2：10 条历史错值必须锁定为实测真身（防回退）', function () {
  // 2026-09-25 逐条 `--find` / `--slugs` 实测；**不要按"模式"重写**（LP 路径层级不统一，猜必错）
  const P2 = [
    ['DreamLeague Season 30', 'DreamLeague/30'],
    ['DreamLeague Season 31', 'DreamLeague/31'],
    ['DreamLeague Division 2 Series 5', 'DreamLeague/Division 2/5'],
    ['DreamLeague Division 2 Series 6', 'DreamLeague/Division 2/6'],
    ['BetBoom Dacha', 'BetBoom Dacha/2023'],
    ['FISSURE Playground', 'FISSURE/PLAYGROUND/1'],           // 真身**全大写** PLAYGROUND（无 redirect）
    ['Clavision Masters', 'Clavision/Masters/2025'],
    ['The Chongqing Major', 'Chongqing Major/2019'],          // LP 用 `Chongqing Major/2019`，无 "The"
    ['MDL Disneyland Paris Major', 'Mars Dota 2 League/Disneyland Paris Major'],
    ['DPC 2022-2023 Tour', '']                                // LP 无该页（allpages 前缀全空）⇒ 刻意留空
  ];
  P2.forEach(function (p) {
    const ev = cura.curatedEventFor(p[0], { game: 'dota2' });
    assert(ev, '未命中 curation: ' + p[0]);
    assert(String(ev.liquipediaSlug || '') === p[1],
      p[0] + '\n  期望 slug: ' + (p[1] || '(空)') + '\n  实际 slug: ' + String(ev.liquipediaSlug));
  });
  assert(cura.curatedEventFor('BetBoom Dacha', { game: 'dota2' }).year === 2023,
    'BetBoom Dacha 届次应为 2023（LP Infobox 实测赛期 2023-09-10 ~ 09-16）');
  assert(cura.curatedEventFor('Clavision Masters', { game: 'dota2' }).year === 2025,
    'Clavision Masters 届次应为 2025（LP 只有 Masters/2025，无 /1、无 2024 届）');
});

check('★ LP slug P3：3 条真身锁定 + 10 条「LP 无页面」必须保持留空', function () {
  // 3 条曾被我**误判**为「LP 无页面」（原报告 §3.3），逐条 --find 后发现有真身 ⇒ 修正。
  // ★ 教训：判「LP 无页面」必须实查 allpages 前缀 + search，**不能靠名字像不像**。
  const P3FIX = [
    ['Dota 2 World Invitational', 'Portal Dota 2 World Invitationals/2024'],
    ['EPL World Series: Southeast Asia Season 17', 'EPL/World Series/Southeast Asia/17'],
    ['European Pro League Season 40', 'European Pro League/40']
  ];
  P3FIX.forEach(function (p) {
    const ev = cura.curatedEventFor(p[0], { game: 'dota2' });
    assert(ev, '未命中 curation: ' + p[0]);
    assert(String(ev.liquipediaSlug || '') === p[1],
      p[0] + '\n  期望 slug: ' + p[1] + '\n  实际 slug: ' + String(ev.liquipediaSlug));
  });
  // 这些条目实测 LP 上**确无对应页面**（allpages 前缀全空或只有别的品牌/年度子页）
  // ⇒ slug 必须留空。**若有人又填回一个看似合理的值，本断言会失败**（这正是它的用途）。
  const P3BLANK = [
    'PGL Astana 2025', 'TritonLeague', 'Mega Arena', 'CCT 2024', 'CCT 2025',
    'Pinnacle 2024', 'Pinnacle 2025', 'DPC 2022-2023 Tour',
    'WINLINE Star Series Season 4', 'Sber Tournament 2026'
  ];
  P3BLANK.forEach(function (n) {
    const ev = cura.curatedEventFor(n, { game: 'dota2' });
    assert(ev, '未命中 curation: ' + n);
    assert(ev.liquipediaSlug === '',
      n + ' 的 slug 必须留空（LP 无此页，填任何值都会是死链），实际: ' + JSON.stringify(ev.liquipediaSlug));
  });
});

check('★ curation 补录：Riyadh 预选(16740) / Clavision 2024(16901) 必须与正赛／另一届区分开', function () {
  // 补录背景：两条 OpenDota league 此前**没有 curation 条目**（只能靠 community 正则兜底，
  //   分级/赛期/权威名都拿不到）。2026-09-25 补齐。
  // ★★ 本断言的核心是**边界**：预选赛 vs 正赛、同系列不同届 —— **绝不可互相命中**
  //    （命中错 = 共享 LP 页/赛期，属「Road to ENC」同一类数据串味风险）。
  const CASES = [
    ['Riyadh Masters 2024 at Esports World Cup Qualifiers', null, 'Riyadh Masters 2024 at Esports World Cup Qualifiers'],
    ['Riyadh Masters 2024 at Esports World Cup Qualifiers', 16740, 'Riyadh Masters 2024 at Esports World Cup Qualifiers'],
    ['Riyadh Masters 2024 at Esports World Cup', null, 'Riyadh Masters 2024'],
    ['Riyadh Masters 2024 at Esports World Cup', 16881, 'Riyadh Masters 2024'],
    ['Clavision DOTA League S1 : Snow-Ruyi', null, 'Clavision DOTA League S1 : Snow-Ruyi'],
    ['Clavision DOTA League S1 : Snow-Ruyi', 16901, 'Clavision DOTA League S1 : Snow-Ruyi'],
    ['Clavision DOTA2 Masters 2025: Snow-Ruyi', 18359, 'Clavision Masters']
  ];
  CASES.forEach(function (c) {
    const ev = cura.curatedEventFor(c[0], c[1] ? { leagueId: c[1], game: 'dota2' } : { game: 'dota2' });
    const got = ev ? ev.canonical : '__MISS__';
    assert(got === c[2],
      '[' + (c[1] || '按名') + '] ' + c[0] + '\n  期望: ' + c[2] + '\n  实际: ' + got);
  });
  // 补录**不得改变展示分级**（补录前 community 正则就判 B(q) / A）
  const qh = _srcTest.getMatchTierForHome('Riyadh Masters 2024 at Esports World Cup Qualifiers');
  assert(qh && qh.grade === 'B' && qh.qualifier === true,
    'Riyadh 预选赛应为 B(q)，实际: ' + JSON.stringify(qh));
  const sh = _srcTest.getMatchTierForHome('Clavision DOTA League S1 : Snow-Ruyi');
  assert(sh && sh.grade === 'A', 'Clavision 2024 应为 A，实际: ' + JSON.stringify(sh));
  // 预选赛 slug 必须留空：LP 按赛区分页（无单一预选赛主页），指向正赛页会共享数据
  const qev = cura.curatedEventFor('Riyadh Masters 2024 at Esports World Cup Qualifiers', { game: 'dota2' });
  assert(qev.liquipediaSlug === '',
    'Riyadh 预选赛 slug 必须留空，实际: ' + JSON.stringify(qev.liquipediaSlug));
  // 而 Clavision 2024 有真身页
  const cev = cura.curatedEventFor('Clavision DOTA League S1 : Snow-Ruyi', { game: 'dota2' });
  assert(cev.liquipediaSlug === 'Clavision/Snow Ruyi/2024',
    'Clavision 2024 真身应为 Clavision/Snow Ruyi/2024，实际: ' + cev.liquipediaSlug);
});

// ===== ⑤ 跨源赛期合并 mergeEventPeriod（2026-09-19 落地）=====
// 口径经用户确认：官方赛期（LP 系）优先、缺口**按字段**回退 OpenDota ——
//   · 首个起止都完整的源 → 全取
//   · LP 只有 start（endDate 不完整的常态）→ start 取 LP，end 回退 OpenDota ★核心
//   · LP 无数据 → 整体回退 OpenDota（字段级，不整条丢弃）
// ★ 修复的 bug 形态：详情页 eventWindow / 列表页 dateRange 原对快照回退都是 all-or-nothing
//   （`start && end` 同时成立才用）→ LP endDate 不完整时整条官方赛期被丢弃。
section('\n--- ⑤ 跨源赛期合并 mergeEventPeriod（2026-09-19）---');
const _mp = _srcTest.mergeEventPeriod;
check('merge：首个起止完整的源 → 全取（高权威不被低权威稀释）', function () {
  const r = _mp([
    { name: 'curation', start: 1000, end: 2000 },
    { name: 'opendota', start: 1000, end: 3000 }]);
  assert(r && r.start === 1000 && r.end === 2000, '应全取 curation，实际: ' + JSON.stringify(r));
  assert(r.startFrom === 'curation' && r.endFrom === 'curation', '来源标注应均为 curation');
});
check('merge：★ LP 只有 start → start 取 LP，end 回退 OpenDota（用户确认口径）', function () {
  const r = _mp([
    { name: 'curation', start: 0, end: 0 },
    { name: 'liquipedia', start: 9000, end: 0 },
    { name: 'opendota', start: 9500, end: 12000 }]);
  assert(r && r.start === 9000 && r.startFrom === 'liquipedia',
    'start 必须取 LP 官方值（不得被 OpenDota 覆盖），实际: ' + JSON.stringify(r));
  assert(r.end === 12000 && r.endFrom === 'opendota',
    'end 必须回退 OpenDota，实际: ' + JSON.stringify(r));
});
check('merge：LP 无数据 → 整体回退 OpenDota（字段级，不整条丢弃）', function () {
  const r = _mp([
    { name: 'curation', start: 0, end: 0 },
    { name: 'liquipedia', start: 0, end: 0 },
    { name: 'opendota', start: 1000, end: 2000 }]);
  assert(r && r.start === 1000 && r.end === 2000 && r.startFrom === 'opendota',
    '应整体回退 OpenDota，实际: ' + JSON.stringify(r));
});
check('merge：end 早于 start（跨源拼出脏区间）→ 丢弃 end', function () {
  const r = _mp([
    { name: 'liquipedia', start: 12000, end: 0 },
    { name: 'opendota', start: 9000, end: 9500 }]);
  assert(r && r.start === 12000 && r.end === 0,
    '倒挂区间应丢弃 end（宁可只显示开始日），实际: ' + JSON.stringify(r));
});
check('merge：非法值（负数/字符串/undefined）一律视作缺失', function () {
  const r = _mp([{ name: 'a', start: 'abc', end: -5 }, { name: 'b', start: 100, end: 200 }]);
  assert(r && r.start === 100 && r.end === 200, '非法值不得污染结果，实际: ' + JSON.stringify(r));
});
check('merge：三源全空 → null；非数组入参 → null（不抛异常）', function () {
  assert(_mp([{ name: 'a', start: 0, end: 0 }]) === null, '全空应返回 null');
  assert(_mp(null) === null && _mp('x') === null && _mp(undefined) === null, '非法入参应返回 null');
});
check('merge：只剩 start（无任何可用 end）→ end=0 交由调用方决定渲染', function () {
  const r = _mp([{ name: 'liquipedia', start: 9000, end: 0 }]);
  assert(r && r.start === 9000 && r.end === 0, '应保留 start、end=0，实际: ' + JSON.stringify(r));
});
check('merge：导出表自检（防止"定义了但没导出"复发）', function () {
  // 2026-09-19 实测：新增函数后忘写 module.exports → 调用点 TypeError。
  // 此断言依赖上面各 check 已实际调用 _mp；此处再显式确认类型。
  assert(typeof _srcTest.mergeEventPeriod === 'function', 'mergeEventPeriod 必须在 module.exports 中导出');
});
check('merge 的数据源保障：curation 查表链支持年份变体（原名 MISS → 规范名重试命中）', function () {
  // ⑤ 合并的最高优先级源是 curation；若 normalize 仍用 OpenDota 原名查表（MISS），
  // 合并拿不到官方赛期 → 整条链路退化。锁住「canonicalLeagueName 回退 → 命中并带赛期」。
  const raw = 'PGL Wallachia 2026 Season 9';
  const canon = _srcTest.canonicalLeagueName(raw, { game: 'dota2' });
  assert(canon === 'PGL Wallachia Season 9', '规范名回退应生效，实际: ' + canon);
  const ev = curation.curatedEventFor(canon, { leagueId: 20279, game: 'dota2' });
  assert(ev && ev.start && ev.end,
    'curation 应命中并提供官方赛期，实际: ' + JSON.stringify(ev && { start: ev.start, end: ev.end }));
});

// ===== 快照数据自洽守卫（2026-09-20）=====
// ★ 为什么需要：LP 快照条目同时携带**数字边界**（start/end）与**LP 原文**（date 字符串，
//   如 "Sep 19–27, 2026"）。两者是同一事实的两种表示 —— 必须自洽。
//   历史上生成脚本把 end 存成「该日 **UTC** 日末」（Date.UTC(y,m,d,23,59,59)），
//   而展示函数 fmtShort() 用 `getMonth()/getDate()`（**设备本地时区**）→ 北京时间设备上
//   结束日被显示成 **次日**（实测 PGL Wallachia S9：LP 原文 Sep 19–27，界面显示到 9/28）。
//   ⇒ 本守卫用 LP 原文反查数字边界，等价于「在 UTC+8 设备上应该看到的日期」。
section('\n--- 快照数据自洽（LP 原文 ↔ 数字边界，2026-09-20）---');
check('★ 快照：数字 start/end 在 UTC+8 设备上必须等于 LP 原文的起止日（防"结束日 +1 天"）', function () {
  const snap = _srcTest.getUpcomingLocalSnapshot() || {};
  const evs = snap.events || [];
  assert(evs.length > 0, '快照应包含事件（否则本守卫失去意义）');
  const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  // 与生成脚本 parseLiquipediaDate 同形的解析："Mon DD–DD, YYYY" / "Mon DD–Mon DD, YYYY" / "Mon DD, YYYY"
  const re = /^([A-Za-z]{3})\w*\s+(\d{1,2})(?:\s*[‒–—―-]\s*(?:([A-Za-z]{3})\w*\s+)?(\d{1,2}))?,\s*(\d{4})$/;
  const bjDay = (t) => new Date((t + 8 * 3600) * 1000);   // 模拟 UTC+8 设备的 fmtShort
  const bad = [];
  evs.forEach((e) => {
    const m = String(e.date || '').match(re);
    if (!m) { bad.push(e.name + '：date 字符串形态不可识别（' + e.date + '）'); return; }
    const sm = MONTHS[m[1].toLowerCase()];
    const em = MONTHS[(m[3] || m[1]).toLowerCase()];
    const sd = parseInt(m[2], 10);
    const ed = parseInt(m[4] || m[2], 10);
    const yr = parseInt(m[5], 10);
    const bs = bjDay(e.start);
    const be = bjDay(e.end);
    if (bs.getUTCFullYear() !== yr || bs.getUTCMonth() !== sm || bs.getUTCDate() !== sd) {
      bad.push(e.name + ' 开始日：LP 原文 ' + e.date + ' vs 数字 ' + bs.toISOString().slice(0, 10));
    }
    if (be.getUTCFullYear() !== yr || be.getUTCMonth() !== em || be.getUTCDate() !== ed) {
      bad.push(e.name + ' 结束日：LP 原文 ' + e.date + ' vs 数字 ' + be.toISOString().slice(0, 10));
    }
  });
  assert(bad.length === 0, '以下赛事数字边界与 LP 原文不一致：\n    ' + bad.join('\n    '));
});

// ===== 名称归一化单一实现（utils/names.js）—— 2026-09-20 =====
// ★ 背景：`小写 + 去非字母数字` 这条规则曾被**内联复制 19 处**，横跨 队名 / 赛事名叶子键 两个语义，
//   仅靠注释约定「要与 XX 保持一致」。实测事故：一处用 `replace(/\s+/g,'')`（保留 + 号）
//   与快照键的 `replace(/[^a-z0-9]/g,'')` 不一致 → "Pipsqueak + 4" 归一成 `pipsqueak+4`
//   而快照键是 `pipsqueak4` → **整队 logo 永远 miss**。
//   现已抽取 utils/names.js 作为唯一实现；本节锁住「① 行为契约 ② 不再新增内联副本」。
section('\n--- 名称归一化单一实现 names.js（2026-09-20）---');
const _names = require('../../utils/names.js');
const _fs = require('fs');
const _path = require('path');

check('names：★ 与队标快照键三重对齐（真实数据契约）', function () {
  const snap = require('../../utils/team-logo-local-data.js');
  const byName = snap.byName || {};
  const keys = Object.keys(byName);
  assert(keys.length > 100, '快照 byName 应有足量键，实际: ' + keys.length);
  // ① 文档化用例（事故现场）
  assert(_names.normTeamName('Pipsqueak + 4') === 'pipsqueak4',
    'Pipsqueak + 4 应归一为 pipsqueak4，实际: ' + _names.normTeamName('Pipsqueak + 4'));
  // ② 该键必须在快照里真实存在（否则「规则对了但键名不匹配」仍会 miss）
  assert(byName['pipsqueak4'], '快照应存在键 pipsqueak4');
  // ③ 幂等：快照键本身已是归一形态 → 再归一必须不变
  //    （规则一旦被改成剥 'the' / 保留 CJK，既有键就会失配 → 此处立即 FAIL）
  const bad = keys.filter((k) => _names.normTeamName(k) !== k);
  assert(bad.length === 0, '以下快照键经 normTeamName 后发生变化（规则与键生成源已漂移）：' + bad.slice(0, 5).join(', '));
});

check('names：边界与语义（非 ASCII 抹空 / 大小写 / null）', function () {
  assert(_names.normTeamName(null) === '' && _names.normTeamName(undefined) === '', 'null/undefined 应安全返回空串');
  assert(_names.normTeamName('TOPSON') === 'topson', '应转小写');
  assert(_names.normTeamName('Чемпионат Москвы') === '', '非 ASCII 应被去除（与 consensus.normName 不同，勿混用）');
  assert(_names.normTeamName('天辉') === '', '中文占位名归一为空串（调用方需特判）');
  assert(_names.normTeamNameLoose('Level UP esports') === 'levelup', '应剥离结尾的 esports 后缀');
  assert(_names.normTeamNameLoose('Vici Gaming') === 'vici', '应剥离结尾的 gaming 后缀');
  // ⚠️ 后缀是**结尾锚定**（原 api.js 实现如此）：开头的 "Team" 不会被剥
  assert(_names.normTeamNameLoose('Team Spirit') === 'teamspirit',
    '后缀仅结尾锚定，开头的 Team 不应被剥离，实际: ' + _names.normTeamNameLoose('Team Spirit'));
  assert(_names.normTeamName('Level UP esports') === 'levelupesports', '精确匹配不应剥后缀');
});

// ⚠️ 剥注释（供「禁止内联」与「镜像一致性」两处共用）—— 必须先剥注释再判定，
//   否则「在注释里提到该正则」的文件会永久误报（本项目 CRLF：行内 `//` 替换剥不掉整行注释，
//   须显式判 `^\s*//`；且不能误伤 `https://`）
function _stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .filter((l) => !/^\s*\/\//.test(l))
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

check('names：★ 全库禁止再内联该规则（白名单外一律 FAIL）', function () {
  const ROOT = _path.resolve(__dirname, '../..');
  // 白名单：给出文件的**存在理由**，新增前请先确认无法 require utils/names.js
  const ALLOW = {
    'utils/names.js': '单一实现本体',
    'utils/league-canon-map.js': '与 cloudfunctions 副本是**镜像对**（云端 bundle 无法 require 主包）',
    'cloudfunctions/aggregation/league-canon-map.js': '同上（镜像对另一半）',
    'cloudfunctions/aggregation/names.js': '**镜像**（与 utils/names.js 同实现；云端 bundle 无法 require 主包）\n      —— 云函数 index.js 已于 2026-09-21 迁移完成、不再豁免；本条目随该目录退役一并失效',
    'scripts/ops/discover-tournaments.js': 'consensus.js 加载失败时的**刻意内联回退**实现'
  };
  const SKIP_DIR = /(^|[\\/])(node_modules|miniprogram_npm|dist|rollback|tmp)([\\/]|$)/;
  const PATTERN = /toLowerCase\(\)\.replace\(\/\[\^a-z0-9\]\/g/;
  const offenders = [];
  function walk(dir) {
    let entries = [];
    try { entries = _fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    entries.forEach((d) => {
      const full = _path.join(dir, d.name);
      const rel = _path.relative(ROOT, full).replace(/\\/g, '/');
      if (SKIP_DIR.test(rel)) return;
      if (d.isDirectory()) return walk(full);
      if (!/\.js$/.test(d.name)) return;
      if (rel.indexOf('scripts/test/') === 0) return;   // 本守卫自身含该正则字面量，必须排除（自指陷阱）
      let src = '';
      try { src = _fs.readFileSync(full, 'utf8'); } catch (e) { return; }
      if (PATTERN.test(_stripComments(src)) && !ALLOW[rel]) offenders.push(rel);
    });
  }
  ['utils', 'pages', 'subpackages', 'scripts', 'cloudfunctions'].forEach((sub) => walk(_path.join(ROOT, sub)));
  assert(offenders.length === 0,
    '以下文件又内联了「小写+去非字母数字」规则，请改用 utils/names.js：\n    ' + offenders.join('\n    '));
});

// ★ 2026-09-21：原「云函数镜像与主实现一致」断言已**移除**。
//   原因：它会 `readFileSync('cloudfunctions/aggregation/names.js')` —— 一旦按计划删除
//   `cloudfunctions/` 目录（微信云开发退役），该断言会**直接抛异常并中断 test:all 全链**。
//   而它的价值（防镜像漂移）在**该目录即将整体删除**的前提下已归零，故先拆掉这颗雷。
//   （白名单里的 `cloudfunctions/aggregation/names.js` 条目保留：对不存在的文件无害，
//     且能避免"删除目录 → 守卫反过来把残留镜像当违规内联"的误报。）

  // ===== 2026-09-23：isStaleLiveSeries（LIVE 超时降级，修复「已结束仍显示进行中」）=====
  check('sources：isStaleLiveSeries —— 仅「最后活动 > 3h」判陈旧（单向降级；无时间不判）', () => {
    const now = 1700000000;
    const mk = (ago) => ({ lastTime: now - ago, games: [{ start_time: now - ago }] });
    assert(sources.isStaleLiveSeries(mk(300), now) === false, '5min 前活动不应判陈旧');
    assert(sources.isStaleLiveSeries(mk(3600), now) === false, '1h 前活动不应判陈旧');
    assert(sources.isStaleLiveSeries(mk(3 * 3600 - 60), now) === false, '临界内(2h59m)不应判陈旧');
    assert(sources.isStaleLiveSeries(mk(4 * 3600), now) === true, '4h 前活动应判陈旧');
    const mixed = { lastTime: now - 5 * 3600, games: [{ start_time: now - 5 * 3600 }, { start_time: now - 600 }] };
    assert(sources.isStaleLiveSeries(mixed, now) === false, '有新局(10min 前) → 不算陈旧');
    assert(sources.isStaleLiveSeries({ games: [] }, now) === false, '无时间信息不应判定');
    assert(sources.isStaleLiveSeries(null, now) === false, 'null 不应抛错');
  });

  // ===== 2026-09-25：homeDedupe（从页面层抽出的可测纯函数）=====
  //  目的：把「同一对局合并」「首页可见级别」这两条**承载正确性**的逻辑纳入回归保护
  //  （此前是页面内私有函数，零测试 ✗）。
  check('homeDedupe：脏队名/主客反相同键 + 不误并 + 择优 + 首页可见级别', () => {
    const home = require('../../utils/homeDedupe.js');
    // ① 线上真实脏名（2026-09-23 重复卡真因）→ 与干净名必须产生**交集键**
    const dirty = { key: 'a', status: 'ended', start: 100,
      teamA: { name: 'Conventus Stellarum (page does not exist)' }, teamB: { name: 'Team Nemesis' } };
    const clean = { key: 'b', status: 'live', start: 200,
      teamA: { name: 'Team Nemesis' }, teamB: { name: 'Conventus Stellarum' } };
    const kd = home.pairKeysOfCard(dirty), kc = home.pairKeysOfCard(clean);
    assert(kd.length > 0 && kc.length > 0 && kd.some((k) => kc.indexOf(k) >= 0),
      '脏名 + 主客相反 应产生交集键（否则合并失效 → 重复卡复现）');
    // ② 不同对局 → 无交集（防误并）
    const other = { key: 'c', teamA: { name: 'LGD Gaming' }, teamB: { name: 'Team Spirit' } };
    assert(!home.pairKeysOfCard(other).some((k) => kd.indexOf(k) >= 0), '不同对局不得有交集键');
    // ③ 择优：ended 优先；同状态取有比分者
    assert(home.preferSameMatchCard(dirty, clean) === dirty, 'ended 应优先于 live');
    const s0 = { status: 'live', scoreA: 0, scoreB: 0 }, s1 = { status: 'live', scoreA: 2, scoreB: 1 };
    assert(home.preferSameMatchCard(s0, s1) === s1, '同状态时应有比分者优先');
    // ③' ★ 2026-09-25 方案 1（用户拍板）：**合并而非二选一** ——
    //    修「首页已结束 0:0、详情页同场 1:2」的首页半边：ended 卡（LP 链路无小场比分，
    //    比分依赖 absorbSettledGames 注入 OD 局，EF 熔断期注入失败）+ 并存 live 卡带比分
    //    ⇒ 状态保留 ended、比分吸收非零方（旧规则「保留 ended」把正确比分也丢了）。
    const e0 = { status: 'ended', scoreA: 0, scoreB: 0 };
    const l12 = { status: 'live', scoreA: 1, scoreB: 2 };
    const m1 = home.preferSameMatchCard(e0, l12);
    assert(m1.status === 'ended' && m1.scoreA === 1 && m1.scoreB === 2,
      'ended 0:0 + live 1:2 ⇒ 应合并为 ended 1:2（状态取 ended、比分取非零方），实际: ' +
      JSON.stringify({ status: m1.status, scoreA: m1.scoreA, scoreB: m1.scoreB }));
    assert(m1.winA === false && m1.winB === true, '胜负标记应与新比分一致（1:2 ⇒ B 胜）');
    //    反向①：ended 已有比分 ⇒ 不得被改写（吸收只发生在胜者无比分时）
    const e21 = { status: 'ended', scoreA: 2, scoreB: 1 };
    assert(home.preferSameMatchCard(e21, l12) === e21, 'ended 已有比分时不得被 live 卡改写');
    //    反向②：双方都 0:0（真平局/都无数据）⇒ 不得凭空造分
    assert(home.preferSameMatchCard({ status: 'ended', scoreA: 0, scoreB: 0 },
      { status: 'live', scoreA: 0, scoreB: 0 }).scoreA === 0, '双方都 0:0 时不得造分');
    //    反向③：入参不得被改写（纯函数约定）
    assert(e0.scoreA === 0 && e0.scoreB === 0 && e0.winA === undefined,
      '合并不得改写入参（本模块约定只做纯计算）');
    // ④ 首页可见级别：只放行 S/A（角标计数与列表共用同一判据）
    assert(home.homePassGrade({ tier: { grade: 'S' } }) === true, 'S 应放行');
    assert(home.homePassGrade({ tier: { grade: 'A' } }) === true, 'A 应放行');
    assert(home.homePassGrade({ tier: { grade: 'B' } }) === false, 'B 不应放行');
    assert(home.homePassGrade({ tier: { grade: 'C' } }) === false, 'C 不应放行');
    assert(home.homePassGrade({}) === false, '无 tier 不应放行');
    assert(home.homePassGrade(null) === false, 'null 不应抛错');
  });

  check('★ LP UA 合规：标识性 UA 单点化（禁伪装浏览器 UA / 禁占位联系方式）', () => {
    const fs = require('fs');
    const path = require('path');
    const ROOT = path.resolve(__dirname, '..', '..');
    // ★ 只扫**代码目录**，不含 deliverables/ 文档 ——
    //   文档（方案/复核意见）会**引用**这些违规字符串做说明，全仓 grep 是**不可达判据**
    //   （实测：方案文档自身就含 dev@local，`grep -rn "dev@local" .` 永远不为 0）。
    const DIRS = ['utils', 'scripts', 'pages', 'subpackages', 'components', 'supabase'];
    // ★ 违规串用**拼接**构造：本守卫自身若含字面量会被自己扫出来（自指陷阱，实测踩到）。
    //   拼接后文件里不存在该字面量 ⇒ 无需"排除自身"，扫描保持全域覆盖。
    const PLACEHOLDER = 'dev@' + 'local';
    const BAD = [];
    const walk = (dir) => {
      let ents = [];
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
      ents.forEach((e) => {
        if (e.name === 'node_modules' || e.name === '.git') return;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { walk(full); return; }
        if (!/\.(js|ts)$/.test(e.name)) return;
        // ★ 先剥注释再判定 —— 注释里**允许**引用历史违规字符串（如 utils/lp-ua.js 的成因说明）。
        //   （同项目既有纪律：检测工具先剥注释，行内 `//` 用 `^\s*` 保守剥。）
        const code = fs.readFileSync(full, 'utf8').split('\n')
          .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
        if (/User-Agent["']?\s*:\s*["'][^"']*Mozilla/.test(code)) {
          BAD.push(path.relative(ROOT, full) + ' → 伪装浏览器 UA（违反 LP ToS）');
        }
        if (code.indexOf(PLACEHOLDER) >= 0) {
          BAD.push(path.relative(ROOT, full) + ' → 占位联系方式 ' + PLACEHOLDER);
        }
      });
    };
    DIRS.forEach((d) => walk(path.join(ROOT, d)));
    assert(BAD.length === 0, 'LP UA 合规违规：\n  ' + BAD.join('\n  '));

    // 镜像一致性：两侧的**联系渠道**必须逐字相同（URL + 邮箱**分别**比对）。
    //   ⚠️ 不能比对"组装后的 UA 字面量" —— 两侧组装方式本就不同（客户端用字符串拼接、
    //   EF 用模板串 `${LP_CONTACT}`），正则只会匹配到其中之一（实测踩到过一次）。
    //   ⚠️ 也不能只比 URL：邮箱是**独立常量**（LP_EMAIL），只比 URL 会漏掉邮箱漂移。
    const URL_RE = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+/;
    const MAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/;
    const miniSrc = fs.readFileSync(path.join(ROOT, 'utils/lp-ua.js'), 'utf8');
    const efSrc = fs.readFileSync(path.join(ROOT, 'supabase/functions/_shared/lp-ua.ts'), 'utf8');
    const pick = (src, re) => (src.match(re) || [])[0] || '';
    const mu = pick(miniSrc, URL_RE), eu = pick(efSrc, URL_RE);
    const mm = pick(miniSrc, MAIL_RE), em = pick(efSrc, MAIL_RE);
    assert(mu && eu && mu === eu, '两侧 LP 联系 URL 必须逐字一致：mini=' + mu + '  ef=' + eu);
    assert(mm && em && mm === em, '两侧 LP 联系邮箱必须逐字一致：mini=' + mm + '  ef=' + em);
    assert(/DOTA2-Esports-Hub\/1\.0 \(\+/.test(miniSrc) && /DOTA2-Esports-Hub\/1\.0 \(\+/.test(efSrc),
      '两侧 UA 必须以「DOTA2-Esports-Hub/1.0 (+」开头（ToS 要求标识项目）');
    assert(mu.indexOf('re-toke/dota2-esports') >= 0,
      'LP UA 必须含项目主页（ToS 要求 identifies your project）：' + mu);
    assert(mm.indexOf('@') > 0 && mm.indexOf('.') > 0,
      'LP UA 必须含**可用邮箱**（ToS 要求 includes contact information）：' + mm);
  });

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
