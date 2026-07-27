// scripts/test-canonical.js
// 赛事展示名 / 赛期 / 状态一致性 防护测试（对应分析报告 G1/G2，覆盖 P3 展示名 + P1 状态源）。
// 不联网，mock wx 环境，复用 test-sources 的 check/assert/runAll 运行器范式。
//
// 校验目标：
//  ① canonicalLeagueName：未匹配 curation 的联赛名原样返回（避免误覆盖）。
//     ⚠️ 2026-07-27 修复：EPL 别名已收敛，'EPL Masters 2026' / 'EPL 2026' 不再被误冠为
//     "EPL Masters I"（此前过宽别名把 OpenDota 低级别联赛误映射，导致列表重复卡 + 队伍错位）。
//  ② 无匹配名原样返回（避免误覆盖）
//  ③ leagueDisplayName 形状无关单一出口（{name}/{league_name}/{league.name}/字符串 均返回规范名）
//     —— 这是 G1 的结构性防护：新增展示位只需传 league 对象，无需记忆字段名。
//  ④ curation 完整赛期：start=7/20、end=8/12（UTC），且 ≠ 比赛窗口（7/27 结束）
//     —— 修复 P3「赛期用比赛窗口而非权威完整赛期」的回归闸门。
//  ⑤ curation 快照：EPL canonical/status 正确；且过宽别名(epl2026/eplmasters2026)已移除（回归防护）
//     （P3 数据层 + P1 列表/详情状态硬覆盖的信任源）
//
// 任何一条失败即代表 P3（展示名/赛期）或 P1（状态源）回归 —— 首次复现即红。

'use strict';

let passed = 0;
let failed = 0;
const tests = [];

function section(title) { tests.push({ kind: 'section', title: title }); }
function check(label, fn) { tests.push({ kind: 'test', label: label, fn: fn }); }
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

// ===== 1. mock wx 环境（默认网络不可达）=====
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

// ===== 2. 清除 module cache（保证每次 require 拿到干净实例）=====
const purge = ['cache.js', 'config.js', 'tiers.js', 'api.js', 'util.js', 'stratz.js', 'steam.js', 'consensus.js', 'curation.js', 'remoteCuration.js', 'liquipedia.js', 'sources.js'];
for (const k of Object.keys(require.cache)) {
  for (const name of purge) { if (k.indexOf(name) >= 0) delete require.cache[k]; }
}

// ===== 3. require 模块 =====
const path = require('path');
const SRC = path.resolve(__dirname, '..', 'utils');
const util = require(path.join(SRC, 'util.js'));
const sources = require(path.join(SRC, 'sources.js'));
const remoteCuration = require(path.join(SRC, 'remoteCuration.js'));
const curationRaw = require(path.join(SRC, 'curation.js'));
const monitor = require(path.join(SRC, 'monitor.js'));

// ===== 4. 断言 =====
section('\n--- 赛事展示名映射（P3 展示名）---');
check('canonicalLeagueName("EPL Masters 2026") 不再误冠 "EPL Masters I"（2026-07-27 修复）', () => {
  const r = sources.canonicalLeagueName('EPL Masters 2026');
  assert(r === 'EPL Masters 2026', '过宽别名已移除，应原样返回，实际: ' + r);
  assert(r !== 'EPL Masters I', '回归：EPL 别名不应再把低级别联赛误映射为 EPL Masters I');
});
check('canonicalLeagueName("EPL 2026") 不再误冠 "EPL Masters I"', () => {
  const r = sources.canonicalLeagueName('EPL 2026');
  assert(r === 'EPL 2026', '过宽别名 epl2026 已移除，应原样返回，实际: ' + r);
});
check('canonicalLeagueName(未知名) 原样返回', () => {
  const raw = 'A Totally Unknown League 2099';
  assert(sources.canonicalLeagueName(raw) === raw, '无匹配应原样返回，实际: ' + sources.canonicalLeagueName(raw));
});

section('\n--- leagueDisplayName 形状无关单一出口（G1 结构防护）---');
check('leagueDisplayName({name})', () => assert(sources.leagueDisplayName({ name: 'EPL Masters 2026' }) === 'EPL Masters 2026'));
check('leagueDisplayName({league_name})', () => assert(sources.leagueDisplayName({ league_name: 'EPL Masters 2026' }) === 'EPL Masters 2026'));
check('leagueDisplayName({league:{name}})', () => assert(sources.leagueDisplayName({ league: { name: 'EPL Masters 2026' } }) === 'EPL Masters 2026'));
check('leagueDisplayName(字符串)', () => assert(sources.leagueDisplayName('EPL Masters 2026') === 'EPL Masters 2026'));
check('leagueDisplayName("") 不为 undefined', () => assert(sources.leagueDisplayName('') === '', '空串应返回空串，实际: ' + sources.leagueDisplayName('')));
check('leagueDisplayName(未知名 对象) 原样返回', () => {
  const raw = { name: 'Whatever League X' };
  assert(sources.leagueDisplayName(raw) === 'Whatever League X', '无匹配应原样返回，实际: ' + sources.leagueDisplayName(raw));
});

section('\n--- curation 完整赛期（P3 赛期窗口）---');
const cur = remoteCuration.curatedEventFor('EPL Masters I');
check('curation 命中 EPL 条目（按 canonical 字面名）', () => assert(cur && cur.canonical === 'EPL Masters I', '应命中 EPL Masters I 条目'));
check('curation 完整赛期：start=7/20、end=8/12（UTC）', () => {
  const s = new Date(cur.start * 1000);
  const e = new Date(cur.end * 1000);
  assert(s.getUTCMonth() === 6 && s.getUTCDate() === 20, 'start 应为 7/20，实际 UTC ' + (s.getUTCMonth() + 1) + '/' + s.getUTCDate());
  assert(e.getUTCMonth() === 7 && e.getUTCDate() === 12, 'end 应为 8/12，实际 UTC ' + (e.getUTCMonth() + 1) + '/' + e.getUTCDate());
});
check('赛期不等于比赛窗口（7/27 结束）', () => {
  const windowEnd = Math.floor(Date.UTC(2026, 6, 27) / 1000); // 7/27
  const full = util.formatDateRange(cur.start, cur.end);
  const win = util.formatDateRange(cur.start, windowEnd);
  assert(full !== win, '完整赛期不应等于比赛窗口: full=' + full + ' win=' + win);
  // 用 UTC 日差证明完整赛期跨度 > 比赛窗口（多 ~16 天），从结构上排除「赛期=窗口」回归
  // 注意：curation 的 start/end 为 Unix 秒，日差按 86400 秒计（非毫秒）。
  const daySec = 86400;
  const fullDays = Math.round((cur.end - cur.start) / daySec);
  const winDays = Math.round((windowEnd - cur.start) / daySec);
  assert(fullDays > winDays, '完整赛期天数(' + fullDays + ')应大于窗口(' + winDays + ')');
});

section('\n--- curation 快照（P3 数据层 + P1 状态硬覆盖信任源）---');
check('EPL canonical === "EPL Masters I"', () => assert(cur.canonical === 'EPL Masters I'));
check('EPL status === "进行中"', () => assert(cur.status === '进行中', 'EPL 2026 状态应为 进行中，实际: ' + cur.status));
check('EPL 不再含过宽别名 epl2026 / eplmasters2026（2026-07-27 修复回归防护）', () => {
  const al = cur.aliases || [];
  assert(al.indexOf('epl2026') < 0, '不应再含过宽别名 epl2026（曾导致 19080 误冠）');
  assert(al.indexOf('eplmasters2026') < 0, '不应再含过宽别名 eplmasters2026（曾导致 19944 误冠）');
});

// ===== G4：云函数与小程序共用同一份规范映射（消除双源漂移）=====
section('\n--- G4 单一数据源：小程序 / 云函数规范映射一致 ---');
const fs = require('fs');
const miniCanon = require(path.join(SRC, 'league-canon-map.js'));
let cloudCanon = null;
try { cloudCanon = require(path.resolve(__dirname, '..', 'cloudfunctions', 'aggregation', 'league-canon-map.js')); }
catch (e) { cloudCanon = null; }

check('G4: 小程序 league-canon-map 已加载；canonical 字面 "EPL Masters I" 仍可解析', () => {
  assert(miniCanon && miniCanon.resolveCanonical('EPL Masters I') === 'EPL Masters I', 'mini 应解析字面 canonical');
});
check('G4: 修复回归 — "EPL Masters 2026" 不应再映射到 EPL Masters I', () => {
  assert(!miniCanon || miniCanon.resolveCanonical('EPL Masters 2026') !== 'EPL Masters I', 'EPL 过宽别名回归');
});
check('G4: 云函数 league-canon-map 已加载', () => {
  assert(cloudCanon, '云函数 league-canon-map 未找到，请运行 npm run sync:canon 并部署');
});
if (cloudCanon) {
  const eplCanonKey = 'eplmastersi';
  const eplOverBroad = ['epl2026', 'eplmasters2026'];
  check('G4: 小程序与云函数对 EPL canonical 自映射一致', () => {
    const m = miniCanon.resolveCanonical(eplCanonKey);
    const c = cloudCanon.resolveCanonical(eplCanonKey);
    assert(m === 'EPL Masters I' && c === 'EPL Masters I', 'EPL canonical 不一致: mini=' + m + ' cloud=' + c);
  });
  check('G4: 小程序与云函数对 EPL 过宽别名一致地「不映射」', () => {
    eplOverBroad.forEach((a) => {
      const m = miniCanon.resolveCanonical(a);
      const c = cloudCanon.resolveCanonical(a);
      assert(m !== 'EPL Masters I' && c !== 'EPL Masters I', 'EPL 过宽别名回归: ' + a + ' mini=' + m + ' cloud=' + c);
    });
  });
  check('G4: 两侧 curation-shared.js 模块等价（无双源漂移）', () => {
    const a = require(path.join(SRC, 'curation-shared.js'));
    const b = require(path.resolve(__dirname, '..', 'cloudfunctions', 'aggregation', 'curation-shared.js'));
    assert(JSON.stringify(a) === JSON.stringify(b), '两侧 curation-shared.js 模块不相等，请运行 npm run sync:canon');
  });
}

// ===== G6：curation 数据变更快照断言（拦截 P3 数据层回归）=====
section('\n--- G6 curation 数据变更快照断言 ---');
const ALL_EVENTS = (curationRaw && curationRaw.CURATED_EVENTS) || [];
const ALLOWED_STATUS = ['即将到来', '进行中', '已结束', '已取消'];

check('G6: CURATED_EVENTS 非空', () => assert(ALL_EVENTS.length > 0, 'curation 事件数为 0'));

check('G6: 每条赛事条目结构完整（canonical/aliases/year）', () => {
  ALL_EVENTS.forEach((ev, i) => {
    assert(ev && typeof ev.canonical === 'string' && ev.canonical.trim(), '第' + i + '条缺 canonical');
    assert(Array.isArray(ev.aliases) && ev.aliases.length > 0, '第' + i + '条(' + ev.canonical + ')缺 aliases');
    assert(typeof ev.year === 'number', '第' + i + '条(' + ev.canonical + ')缺 year');
  });
});

check('G6: 有赛期的条目 start/end 合法（end>=start）', () => {
  ALL_EVENTS.forEach((ev) => {
    if (ev.start == null || ev.end == null) return; // 提示性字段允许缺
    assert(ev.end >= ev.start, ev.canonical + ' 的 end < start');
    assert(ev.start > 0 && ev.end > 0, ev.canonical + ' 时间非法');
  });
});

check('G6: status（若有）取值合法', () => {
  ALL_EVENTS.forEach((ev) => {
    if (ev.status == null) return;
    assert(ALLOWED_STATUS.indexOf(ev.status) >= 0, ev.canonical + ' 的 status 非法: ' + ev.status);
  });
});

// 跨游戏隔离：DOTA2 curation 绝不可混入 CS2 同名「EPL Masters 2026」
// （P3 根因：OpenDota 显示 "EPL Masters 2026"，但权威 DOTA2 赛事实为 Liquipedia "EPL Masters I"；
//  而 OpenDota 中同名 "EPL Masters 2026 / EPL 2026" 实为低级别联赛，过宽别名会误冠。2026-07-27 修复：
//  收敛别名，使这些联赛回退原始名，不再被错误冠名。）
check('G6: 跨游戏隔离 — DOTA2 curation 不含 CS2 同名 canonical "EPL Masters 2026"', () => {
  const clash = ALL_EVENTS.filter((ev) => ev.canonical === 'EPL Masters 2026');
  assert(clash.length === 0, 'DOTA2 curation 误含 CS2 同名赛事');
});

check('G6: 修复回归 — 展示层 "EPL Masters 2026" 不再误解析为 "EPL Masters I"', () => {
  const r = sources.canonicalLeagueName('EPL Masters 2026');
  assert(r !== 'EPL Masters I', 'EPL 过宽别名回归，实际: ' + r);
  const dn = sources.leagueDisplayName('EPL Masters 2026');
  assert(dn !== 'EPL Masters I', 'leagueDisplayName EPL 过宽别名回归，实际: ' + dn);
});

// ===== G8：运行时监控安全降级（无 wx / 无 reportAnalytics 时不得影响主流程）=====
section('\n--- G8 运行时监控安全降级 ---');
check('G8: leagueDisplayName 无 curation 覆盖时不抛错（监控安全降级）', () => {
  const r = sources.leagueDisplayName('Some Random Unknown League 2099');
  assert(r === 'Some Random Unknown League 2099', '未覆盖应原样返回，实际: ' + r);
});
check('G8: monitor 在 mock 环境（无 reportAnalytics）为 no-op 不抛错', () => {
  monitor.leagueNameUncovered('Test League X');
  monitor.statusConflict('123', 'ongoing', 'ended');
  monitor.report('probe_event', { a: 1 });
});

// ===== 5. 运行全部测试（与 test-sources 同范式：顺序执行，支持 async，末尾输出汇总与退出码）=====
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
