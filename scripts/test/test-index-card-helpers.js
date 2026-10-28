// scripts/test/test-index-card-helpers.js
// ★★ 2026-10-13（P1-20 子项 2）：`utils/indexCardHelpers.js`（从首页 `pages/index/index.js` 抽出的纯函数层）单测。
//   覆盖：① 队名/缩写整形（v4.2「TEAM 塌陷」修复的回归守卫）；② Steam LIVE 局 → groupSeries 输入契约。
//   纯离线：无 wx / 网络依赖。
//
// 运行：node scripts/test/test-index-card-helpers.js

'use strict';

const path = require('path');
const H = require(path.join(__dirname, '..', '..', 'utils', 'indexCardHelpers.js'));

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + '  ->  ' + (detail || '')); }
}

console.log('--- indexCardHelpers ---');

// ===== ① teamFullName =====
assert('teamFullName：null/undefined → 兜底「待定」', H.teamFullName(null) === '待定' && H.teamFullName(undefined) === '待定');
assert('teamFullName：空串/纯空白 → 兜底', H.teamFullName('') === '待定' && H.teamFullName('   ') === '待定');
assert('teamFullName：去首尾空白、保留原样（不截断/不大写）', H.teamFullName('  Team Spirit ') === 'Team Spirit');
assert('teamFullName：非字符串入参安全（数字）', H.teamFullName(123) === '123');

// ===== ② teamShortTag（v4.2：不得再塌成 "TEAM"）=====
assert('teamShortTag：去空格 + 大写 + 截断 5', H.teamShortTag('Team Spirit') === 'TEAMS', 'got=' + H.teamShortTag('Team Spirit'));
assert('teamShortTag：Liquid/Falcons 不再同为 "TEAM"（回归守卫）',
  H.teamShortTag('Team Liquid') !== H.teamShortTag('Team Falcons'),
  'L=' + H.teamShortTag('Team Liquid') + ' F=' + H.teamShortTag('Team Falcons'));
assert('teamShortTag：含空格队名去空格', H.teamShortTag('Xtreme Gaming') === 'XTREM', 'got=' + H.teamShortTag('Xtreme Gaming'));
assert('teamShortTag：空/空值 → "?"', H.teamShortTag('') === '?' && H.teamShortTag(null) === '?');

// ===== ③ normalizeLiveMatch（Steam LIVE 局 → groupSeries 输入契约）=====
const now = 1000000;
const m = {
  match_id: 42, activate_time: 900, start_time: 800, duration: 600,
  league_id: 7, league_name: 'EPL', team_id_radiant: 1, team_id_dire: 2,
  team_name_radiant: 'A', team_name_dire: 'B', series_id: 555, series_type: 1,
  radiant_score: 10, dire_score: 12, spectators: 3
};
const n = H.normalizeLiveMatch(m, now);
assert('normalizeLiveMatch：match_id 透传', n.match_id === 42);
assert('normalizeLiveMatch：start_time 优先 activate_time', n.start_time === 900);
assert('normalizeLiveMatch：radiant_win 恒为 null（LIVE 未结算，不计系列胜场）', n.radiant_win === null);
assert('normalizeLiveMatch：系列字段透传（series_id/series_type）', n.series_id === 555 && n.series_type === 1);
assert('normalizeLiveMatch：队 id/名映射正确',
  n.radiant_team_id === 1 && n.dire_team_id === 2 && n.radiant_name === 'A' && n.dire_name === 'B');
assert('normalizeLiveMatch：击杀/观赛/duration 透传',
  n.radiant_score === 10 && n.dire_score === 12 && n.spectators === 3 && n.duration === 600);
assert('normalizeLiveMatch：_isLiveSource 恒为 true', n._isLiveSource === true);

// start_time 回退链（activate_time → start_time → now - duration）
assert('normalizeLiveMatch：无 activate_time → 回退 start_time',
  H.normalizeLiveMatch({ match_id: 1, start_time: 800, duration: 600 }, now).start_time === 800);
assert('normalizeLiveMatch：无 start_time → now - duration',
  H.normalizeLiveMatch({ match_id: 1, duration: 600 }, now).start_time === now - 600);
assert('normalizeLiveMatch：series_id=0 → null（0 不当作有效系列）',
  H.normalizeLiveMatch({ series_id: 0 }, now).series_id === null);
assert('normalizeLiveMatch：无 league_name → 空串', H.normalizeLiveMatch({}, now).league_name === '');

// ===== ⑥ 2026-10-28（首页冷启动）：源码守卫 =====
const fs = require('fs');
const indexJs = fs.readFileSync(path.join(__dirname, '..', '..', 'pages', 'index', 'index.js'), 'utf8');
const appJs = fs.readFileSync(path.join(__dirname, '..', '..', 'app.js'), 'utf8');
assert('冷启动：app.onLaunch 预取 pro/live（先于页面 onLoad）',
  /onLaunch\(\)[\s\S]{0,1200}?api\.getProMatches\(\)/.test(appJs) &&
  /onLaunch\(\)[\s\S]{0,1200}?api\.getLiveMatches\(\)/.test(appJs));
assert('冷启动：pro 先渲染（proP.then → _applyMatchSources(pro, null)）',
  /proP\.then\([\s\S]{0,360}?_applyMatchSources\(pro, null/.test(indexJs));
assert('冷启动：首屏快照键/6h TTL',
  /HOME_PRO_SNAP_KEY = 'home:proSnap:v1'/.test(indexJs) &&
  /HOME_PRO_SNAP_TTL = 6 \* 3600/.test(indexJs));
assert('冷启动：快照仅在 _lastPro 为空时使用',
  /if \(!this\._lastPro\)[\s\S]{0,240}?cache\.peek\(HOME_PRO_SNAP_KEY\)/.test(indexJs));
assert('冷启动：settle 后写快照（pro 非空）',
  /cache\.set\(HOME_PRO_SNAP_KEY, pro, HOME_PRO_SNAP_TTL\)/.test(indexJs));
// 2026-10-28（第 3 步）：homeBundle 一次 RTT + 单路回退
assert('冷启动：homeBundle 优先，pro/live 各自回退单路',
  /const bundleP[\s\S]{0,400}?api\.getProMatches\(\)[\s\S]{0,200}?api\.getLiveMatches\(\)/.test(indexJs));
const apiSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'utils', 'api.js'), 'utf8');
assert('api：导出 getHomeBundle', /getHomeBundle: getHomeBundle/.test(apiSrc));
const cpSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'utils', 'cloudProxy.js'), 'utf8');
assert('cloudProxy：getHomeBundle → opendota-proxy', /getHomeBundle: 'opendota-proxy'/.test(cpSrc));
const efSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'supabase', 'functions', 'opendota-proxy', 'index.ts'), 'utf8');
assert('EF：getHomeBundle 分派 + trimLive 裁剪',
  /action === "getHomeBundle"/.test(efSrc) && /function trimLive/.test(efSrc) &&
  /action === "getLiveMatches"\) data = trimLive\(data\)/.test(efSrc));

console.log('\n=== 结果 ===');
console.log('PASS: ' + pass + ', FAIL: ' + fail);
process.exit(fail ? 1 : 0);
