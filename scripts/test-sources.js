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
const liquipedia = require(path.join(SRC, 'liquipedia.js'));

// 与 api.js 内部 _v() 保持一致：缓存 key 前缀 = (dataVersion || '0') + ':'。
// test 3/4 注入与读取陈旧缓存必须使用同一前缀，否则 cached() 的 peek 命中不到。
let cshared = null;
try { cshared = require(path.join(SRC, 'curation-shared.js')); } catch (e) { cshared = null; }
const V = ((cshared && cshared.dataVersion) || '0') + ':';

// ===== 4. 导出结构检查 =====
section('\n--- 模块导出结构 ---');
check('stratz.ENABLED (2026-07-30 起因 Cloudflare 拦截关闭)', () => assert(stratz.ENABLED === false));
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
check('stratz.ENABLED === false (2026-07-30 起关闭)', () => assert(stratz.ENABLED === false));
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
// ★ 2026-07-30：STRATZ 因 Cloudflare 拦截已关闭（config.stratz.enabled=false），
//   本测试需临时启用 STRATZ 才能验证其内部模块逻辑（与生产环境配置无关）。
section('\n--- STRATZ 精确名匹配（精确归一 > 子串）---');
check('stratz.getLeagueTier 精确名命中 DPC_MAJOR→S（非子串误命中）', async () => {
  // 临时启用 STRATZ 模块以测试其内部逻辑（不受生产 config.stratz.enabled=false 影响）
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
  assert(tiers.EXCLUSION_RULES.length === 4, '应含 4 条规则，实际: ' + tiers.EXCLUSION_RULES.length);
});

check('排除①预选赛/资格赛关键词', () => {
  assert(tiers.shouldExclude('Open Qualifier'), 'Open Qualifier 应排除');
  assert(tiers.shouldExclude('Closed Qualifier'), 'Closed Qualifier 应排除');
  assert(tiers.shouldExclude('Regional Qualifier'), 'Regional Qualifier 应排除');
  assert(tiers.shouldExclude('ESL One Birmingham Qualifiers'), 'Qualifiers 应排除');
  assert(tiers.shouldExclude('Play-In Tournament'), 'Play-In 应排除');
  assert(tiers.shouldExclude('PlayIn Cup'), 'PlayIn 应排除');
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
