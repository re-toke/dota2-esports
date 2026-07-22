// scripts/test-consensus.js
// 交叉验证引擎（consensus.js）+ 常驻权威库（curation.js）+ sources.js 集成测试。
// 不联网；stratz/steam 默认关闭，curation/community/opendota 为本地源，可直接验证投票逻辑。

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

// ===== 1. mock wx（网络层：team/players 返回样例，其余 404）=====
const storage = {};
global.wx = {
  request: function (opts) {
    const url = opts.url || '';
    if (url.indexOf('/teams/') >= 0 && url.indexOf('/players') >= 0) {
      opts.success({
        statusCode: 200,
        data: [
          { account_id: 111, name: 'Player A', is_current_team_member: true, games_played: 10, wins: 5 },
          { account_id: 222, name: 'Player B', is_current_team_member: true, games_played: 8, wins: 3 }
        ]
      });
    } else if (url.indexOf('/teams/') >= 0) {
      opts.success({ statusCode: 200, data: { team_id: 15, name: 'LGD Gaming', tag: 'LGD', rating: 1800, wins: 100, losses: 40, country_code: 'CN' } });
    } else {
      opts.success({ statusCode: 404, data: null });
    }
  },
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

// ===== 3. require =====
const path = require('path');
const SRC = path.resolve(__dirname, '..', 'utils');
const config = require(path.join(SRC, 'config.js'));
config.rateLimit.minGapMs = 0; // 加速测试，去掉限流间隔
const consensus = require(path.join(SRC, 'consensus.js'));
const curation = require(path.join(SRC, 'curation.js'));
const sources = require(path.join(SRC, 'sources.js'));

// ===== 4. consensus 基础归一化 =====
console.log('\n--- 归一化 ---');
check('normName 去掉分隔符', () => assert(consensus.normName('The International 2025') === 'theinternational2025'));
check('normName 中文保留', () => assert(consensus.normName('战队 LGD') === '战队lgd'));
check('normNum 非法返回 null', () => assert(consensus.normNum('abc') === null));

// ===== 5. voteName 投票 =====
console.log('\n--- 赛事名投票 ---');
check('两个归一一致的源 -> high + agreement 2', () => {
  const r = consensus.voteName([
    { value: 'The International 2025', source: 'opendota' },
    { value: 'the international 2025', source: 'curation' }
  ]);
  assert(r.value === 'The International 2025', '取最长原文');
  assert(r.agreement === 2, 'agreement=2 实际 ' + r.agreement);
  assert(r.confidence === 'high', 'confidence=high 实际 ' + r.confidence);
  assert(r.sources.indexOf('opendota') >= 0 && r.sources.indexOf('curation') >= 0, '两源都在');
});
check('单源 -> low', () => {
  const r = consensus.voteName([{ value: 'Some Cup', source: 'opendota' }]);
  assert(r.agreement === 1 && r.confidence === 'low', '单源 low');
});
check('两个不同源同归一 -> 仍一致', () => {
  const r = consensus.voteName([
    { value: 'TI 2025', source: 'opendota' },
    { value: 'The International 2025', source: 'curation' }
  ]);
  // 归一不同（ti2025 vs theinternational2025）-> agreement 1
  assert(r.agreement === 1, '归一不同 agreement=1');
});

// ===== 6. voteTime 投票 =====
console.log('\n--- 时间投票 ---');
check('两个接近时间 -> high', () => {
  const r = consensus.voteTime([
    { value: 1000, source: 'opendota' },
    { value: 1000 + 86400, source: 'curation' } // 差 1 天 < 3 天容差
  ]);
  assert(r.agreement === 2 && r.confidence === 'high', 'high');
  assert(r.value >= 1000 && r.value <= 1000 + 86400, '中位数在区间');
});
check('两个远超容差 -> low', () => {
  const r = consensus.voteTime([
    { value: 1000, source: 'opendota' },
    { value: 1000 + 86400 * 30, source: 'steam' } // 差 30 天
  ]);
  assert(r.agreement === 1 && r.confidence === 'low', 'low');
});

// ===== 7. consensusTier 分级计票 =====
console.log('\n--- 分级计票 ---');
check('community+curation 都 SSS -> SSS, agreement 2', () => {
  const r = consensus.consensusTier([
    { grade: 'SSS', rank: 4, label: 'TI 顶级', source: 'community' },
    { grade: 'SSS', rank: 4, label: 'TI 顶级', source: 'curation' },
    { grade: 'S', rank: 3, label: 'S级', source: 'opendota' }
  ]);
  assert(r.grade === 'SSS', 'grade SSS 实际 ' + r.grade);
  assert(r.agreement === 2, 'agreement 2 实际 ' + r.agreement);
  assert(r.label === 'TI 顶级', 'label TI 顶级');
});

// ===== 8. crossMembers 成员交叉比对 =====
console.log('\n--- 成员交叉比对 ---');
check('两源重叠 -> verified 标记 + verifiedCount', () => {
  const r = consensus.crossMembers([
    { source: 'opendota', members: [{ account_id: 1, name: 'Yatoro' }, { account_id: 2, name: 'Torontotokyo' }] },
    { source: 'stratz', members: [{ account_id: 1, name: 'Yatoro' }, { account_id: 3, name: 'Mira' }] }
  ]);
  const y = r.members.find((m) => m.account_id === 1);
  assert(y && y.verified === true, 'account 1 双源 verified');
  assert(y.crossSources === 2, 'crossSources 2');
  const onlyO = r.members.find((m) => m.account_id === 2);
  assert(onlyO && onlyO.verified === false, 'account 2 单源 未核实');
  assert(r.verifiedCount === 1, 'verifiedCount 1 实际 ' + r.verifiedCount);
  assert(r.total === 3, 'total 3');
});
check('名字归一冲突 -> 取最长原文', () => {
  const r = consensus.crossMembers([
    { source: 'opendota', members: [{ account_id: 1, name: 'Ame' }] },
    { source: 'stratz', members: [{ account_id: 1, name: 'Wang Chunyu' }] }
  ]);
  const m = r.members.find((x) => x.account_id === 1);
  assert(m.name === 'Wang Chunyu', '取更长名字 实际 ' + m.name);
});

// ===== 9. validatePlayerId =====
console.log('\n--- 选手ID校验 ---');
check('合法正整数', () => assert(consensus.validatePlayerId(12345).valid === true));
check('非法（负数/非整数/字符串）', () => {
  assert(consensus.validatePlayerId(-1).valid === false);
  assert(consensus.validatePlayerId('abc').valid === false);
  assert(consensus.validatePlayerId(1.5).valid === false);
});

// ===== 10. curation 常驻库 =====
console.log('\n--- 常驻权威库 ---');
check('curatedEventFor 规范名命中', () => {
  const e = curation.curatedEventFor('The International 2025');
  assert(e && e.canonical === 'The International 2025', 'canonical 命中');
});
check('curatedEventFor 别名命中', () => {
  const e = curation.curatedEventFor('TI2025');
  assert(e && e.canonical === 'The International 2025', '别名命中');
});
check('curatedTeamFor id 命中', () => {
  const t = curation.curatedTeamFor(15);
  assert(t && t.name === 'LGD Gaming', 'LGD Gaming');
});
check('curatedTeamFor 名命中', () => {
  const t = curation.curatedTeamFor('lgd');
  assert(t && t.name === 'LGD Gaming', '名命中');
});
check('curatedEventFor 新赛事命中 (RIYADH)', () => {
  const e = curation.curatedEventFor('Riyadh Masters 2024');
  assert(e && e.tier.grade === 'A', 'Riyadh 2024 A级');
  assert(e.start > 0 && e.end > 0, 'Riyadh 2024 有日期');
});
check('curatedEventFor 新赛事命中 (Elite League)', () => {
  const e = curation.curatedEventFor('Elite League');
  assert(e && e.tier.grade === 'A', 'Elite League A级');
});
check('curatedEventFor 新赛事命中 (BLAST Slam II)', () => {
  const e = curation.curatedEventFor('BLAST Slam II');
  assert(e && e.tier.grade === 'S', 'BLAST Slam II S级');
});
check('curatedTeamFor 新战队命中 (Falcons)', () => {
  const t = curation.curatedTeamFor('falcons');
  assert(t && t.name === 'Team Falcons', 'Team Falcons');
});
check('curatedTeamFor 新战队命中 (Xtreme Gaming)', () => {
  const t = curation.curatedTeamFor('xg');
  assert(t && t.name === 'Xtreme Gaming', 'Xtreme Gaming');
});

// ===== 11. sources 集成（本地源，无需 key）=====
console.log('\n--- sources 集成 ---');
check('getLeagueName TI -> 规范名 + 多源', async () => {
  const r = await sources.getLeagueName({ name: 'The International 2025' });
  assert(r.value === 'The International 2025', 'value');
  assert(r.sources.indexOf('opendota') >= 0 && r.sources.indexOf('curation') >= 0, '多源');
  assert(r.confidence === 'high', 'high');
});
check('getLeagueTier TI -> SSS + 多源', async () => {
  const r = await sources.getLeagueTier({ name: 'The International 2025' });
  assert(r.grade === 'SSS', 'grade SSS 实际 ' + r.grade);
  assert(r.sources.indexOf('community') >= 0 || r.sources.indexOf('curation') >= 0, '本地源参与');
  assert(r.sources.indexOf('opendota') >= 0, 'opendota 参与');
});
check('getLeagueTier 未知赛事 -> opendota 兜底 C', async () => {
  const r = await sources.getLeagueTier({ name: 'Random Unknown Cup' });
  assert(r.grade === 'C', 'grade C 实际 ' + r.grade);
  assert(r.sources.indexOf('opendota') >= 0, 'opendota');
});
check('getLeagueWindow 无日期赛事 -> null', async () => {
  const r = await sources.getLeagueWindow({ name: 'The International 2025' });
  assert(r === null, 'TI2025 无日期应 null');
});
check('getLeagueWindow 含日期赛事 -> 非 null', async () => {
  const r = await sources.getLeagueWindow({ name: 'The International 2024' });
  assert(r && r.startDate > 0, 'TI2024 startDate 有值');
});
check('getLeagueWindow Riyadh 2024 含日期', async () => {
  const r = await sources.getLeagueWindow({ name: 'Riyadh Masters 2024' });
  assert(r && r.startDate > 0 && r.endDate > 0, 'Riyadh 2024 完整日期');
  assert(r.confidence === 'low', '单源 low');
});
check('getLeagueWindow ESL Birmingham 含日期', async () => {
  const r = await sources.getLeagueWindow({ name: 'ESL One Birmingham 2024' });
  assert(r && r.startDate > 0, 'ESL Birmingham 有日期');
});

// ===== 12. crossTeamMembers（OpenDota 单源，mock 网络）=====
console.log('\n--- crossTeamMembers ---');
check('OpenDota 单源 -> 返回成员但 verifiedCount=0', async () => {
  const r = await sources.crossTeamMembers(15);
  assert(r && r.members && r.members.length === 2, '成员数 2 实际 ' + (r && r.members && r.members.length));
  assert(r.verifiedCount === 0, '单源无核实');
  assert(r.confidence === 'low', 'low');
  assert(r.members[0].account_id === 111, 'account_id 保留');
});

// ===== 汇总 =====
console.log('\n=== 结果 ===');
console.log('通过: ' + passed + '  失败: ' + failed);
console.log(failed === 0 ? '全部通过 ✅' : '存在失败 ❌');
process.exit(failed === 0 ? 0 : 1);
