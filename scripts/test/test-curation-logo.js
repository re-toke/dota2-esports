// scripts/test/test-curation-logo.js
// 人工覆盖队标（curation）单测（★ 2026-11-15）
//
// 契约：人工覆盖 > OpenDota/Steam > STRATZ > Liquipedia 兜底。
// 本文件锁住「覆盖查询」这一层：
//   0) LOCAL_TEAM_LOGOS 的本地打包文件必须存在（重点队伍随包分发，零网络）
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
// ★ 2026-11-16：重点队伍改为「随包分发的本地队标」（零网络，规避 LP 中转 1–18s 与偶发 502）。
function isLocalAsset(u) {
  return typeof u === 'string' && /^\/assets\/team-logos\/[a-z0-9-]+\.png$/.test(u);
}

// ===== 0. 本地打包文件自检（防路径/文件名漂移）=====
check('LOCAL_TEAM_LOGOS 指向的文件都存在', () => {
  const fs = require('fs');
  const ROOT = path.resolve(__dirname, '..', '..');
  Object.keys(curation.LOCAL_TEAM_LOGOS).forEach((id) => {
    const p = curation.LOCAL_TEAM_LOGOS[id];
    assert(isLocalAsset(p), '路径格式异常: ' + id + ' -> ' + p);
    assert(fs.existsSync(path.join(ROOT, p)), '文件缺失: ' + p);
  });
});

// ===== 1. 本地覆盖：按 id / 队名 / 别名 =====
check('按 team_id 命中人工覆盖（Team Spirit）', () => {
  const u = curation.curatedTeamLogo(7119388);
  assert(isLocalAsset(u), '应返回本地打包队标: ' + u);
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
  assert(isLocalAsset(u), '应返回本地打包队标: ' + u);
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
  assert(isLocalAsset(u), '应返回本地打包队标: ' + u);
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
  // 注意：buildEffective 返回的是**数据层原值**（未做展示改写）；中转改写只发生在 curatedTeamLogo 出口。
  assert(/^https:\/\/liquipedia\.net\/commons\/images\//.test(eff.teams[7119388].logo),
    '本地覆盖应保留: ' + eff.teams[7119388].logo);
});

console.log('\n=== curation logo: PASS ' + passed + ' / FAIL ' + failed + ' ===');
if (failed) process.exitCode = 1;
