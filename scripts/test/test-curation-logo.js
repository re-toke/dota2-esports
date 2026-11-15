// scripts/test/test-curation-logo.js
// 人工覆盖队标（curation）单测（★ 2026-11-15）
//
// 契约：人工覆盖 > OpenDota/Steam > STRATZ > Liquipedia 兜底。
// 本文件锁住「覆盖查询」这一层：
//   1) 本地 CURATED_TEAMS.logo 按 id / 队名 / 别名命中（LP 赛程无 team_id 只能按名）
//   2) 无覆盖 / 非法协议 → 空串（调用方必须能继续走原多源链路）
//   3) remoteCuration 查的是「本地为底 + 云端 curation_teams.data.logo 字段级覆盖」的生效集合
//
// 运行：node scripts/test/test-curation-logo.js

'use strict';

const storage = {};
global.wx = {
  getStorageSync: function (k) { return storage[k] || null; },
  setStorageSync: function (k, v) { storage[k] = v; },
  removeStorageSync: function (k) { delete storage[k]; },
  getStorageInfoSync: function () { return { keys: Object.keys(storage) }; }
};

const path = require('path');
const SRC = path.resolve(__dirname, '..', '..', 'utils');
const curation = require(path.join(SRC, 'curation.js'));
const remoteCuration = require(path.join(SRC, 'remoteCuration.js'));

let passed = 0;
let failed = 0;

function check(label, fn) {
  try {
    fn();
    passed++;
    console.log('PASS  ' + label);
  } catch (e) {
    failed++;
    console.log('FAIL  ' + label + '  ->  ' + (e && e.message || e));
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function isLp(u) { return /^https:\/\/liquipedia\.net\/commons\/images\//.test(u); }

// ===== 1. 本地覆盖：按 id / 队名 / 别名 =====
check('按 team_id 命中人工覆盖（Team Spirit）', () => {
  const u = curation.curatedTeamLogo(7119388);
  assert(isLp(u), '应返回 LP 队标: ' + u);
});
check('按队名命中同一覆盖（Team Spirit）', () => {
  const u = curation.curatedTeamLogo(null, 'Team Spirit');
  assert(u === curation.curatedTeamLogo(7119388), '按名与按 id 应一致: ' + u);
});
check('按别名命中同一覆盖（spirit）', () => {
  const u = curation.curatedTeamLogo(0, 'spirit');
  assert(u === curation.curatedTeamLogo(7119388), '别名应命中: ' + u);
});
check('PARIVISION 覆盖按现 id(9824702) 命中', () => {
  const u = curation.curatedTeamLogo(9824702, 'PARIVISION');
  assert(isLp(u), '应返回 LP 队标: ' + u);
});

// ===== 2. 无覆盖 / 非法协议 → 空串 =====
check('无覆盖队伍返回空串（调用方继续原链路）', () => {
  assert(curation.curatedTeamLogo(999999, 'No Such Team') === '', '应为空串');
});
check('非法协议不当作覆盖（ftp://）', () => {
  curation.CURATED_TEAMS[999998] = { name: 'Bad Logo Team', logo: 'ftp://example.com/x.png' };
  try {
    assert(curation.curatedTeamLogo(999998) === '', '非 http(s) 必须拒绝');
  } finally {
    delete curation.CURATED_TEAMS[999998];
  }
});

// ===== 3. remoteCuration：本地兜底 + 远程字段覆盖 =====
check('remoteCuration 无云端缓存时回退本地覆盖', () => {
  const u = remoteCuration.curatedTeamLogo(2163, 'Team Liquid');
  assert(isLp(u), '应返回本地 LP 队标: ' + u);
});
check('云端 data.logo 覆盖本地 logo（热更契约）', () => {
  const eff = remoteCuration.buildEffective({
    events: [],
    teams: { 7119388: { logo: 'https://example.com/remote-override.png' } }
  });
  assert(eff.teams[7119388].logo === 'https://example.com/remote-override.png',
    '远程 logo 应覆盖本地: ' + eff.teams[7119388].logo);
});
check('远程 logo 缺失(null)时保留本地覆盖（防旧数据抹掉新值）', () => {
  const eff = remoteCuration.buildEffective({ events: [], teams: { 7119388: { logo: null } } });
  assert(isLp(eff.teams[7119388].logo), '本地覆盖应保留: ' + eff.teams[7119388].logo);
});

console.log('\n=== curation logo: PASS ' + passed + ' / FAIL ' + failed + ' ===');
if (failed) process.exitCode = 1;
