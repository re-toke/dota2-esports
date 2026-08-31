/**
 * test-logo-persist.js — 2026-08-22 验证进行中比赛 LOGO 在轮询间不丢失
 *
 * 根因：refreshSchedule 重建 series（logo 全空），diff 替换时 oldByKey 回填依赖 key 稳定性。
 *   但 key 含秒级 startTime，进行中比赛数据源切换（Steam LIVE Date.now() vs LPDB 真实时间）
 *   导致 key 变化 → 回填失败 → logo 消失。
 *
 * 修复：① key 时间桶改分钟级 ② 增加按归一化队名对兜底回填
 *
 * 本测试模拟 league-detail.js 的 refreshSchedule 关键片段：
 *   首次 load：enrichTeamLogos 查到 logo 写入 allSeries
 *   第二次 refresh：key 可能变化（Steam LIVE startTime 抖动），验证 logo 是否被保留
 */
var assert = require('assert');

console.log('--- 测试 LOGO 轮询持久性 ---');

// 模拟 normalizeTeamNameForDedup（与 league-detail.js 同口径）
function normalizeTeamNameForDedup(s) {
  if (!s) return '';
  var n = String(s).toLowerCase().trim();
  n = n.replace(/\s*(esports|e-sports|gaming|team|club)\s*$/g, '');
  n = n.replace(/[^a-z0-9一-鿿а-яё]/g, '');
  return n;
}

// T1: key 分钟级时间桶 —— 秒级 startTime 差异归一为同一 key
(function () {
  var startTime = 1770000000;  // 固定基准
  var key1 = 'liq-' + normalizeTeamNameForDedup('Team Spirit') + '__' + normalizeTeamNameForDedup('Iron Wing') + '-' + Math.floor(startTime / 60);
  var key2 = 'liq-' + normalizeTeamNameForDedup('Team Spirit') + '__' + normalizeTeamNameForDedup('Iron Wing') + '-' + Math.floor((startTime + 45) / 60);  // +45s 同一分钟桶
  assert.strictEqual(key1, key2, 'T1: 秒级差异应归一为同一 key');
  console.log('  T1 ✓ 分钟级时间桶归一秒级差异');
})();

// T2: 不同分钟应产生不同 key（防过度归一）
(function () {
  var startTime = 1770000000;
  var key1 = 'liq-' + normalizeTeamNameForDedup('Team Spirit') + '__' + normalizeTeamNameForDedup('Iron Wing') + '-' + Math.floor(startTime / 60);
  var key2 = 'liq-' + normalizeTeamNameForDedup('Team Spirit') + '__' + normalizeTeamNameForDedup('Iron Wing') + '-' + Math.floor((startTime + 120) / 60);  // +2min 不同分钟桶
  assert.notStrictEqual(key1, key2, 'T2: 跨分钟应产生不同 key');
  console.log('  T2 ✓ 跨分钟保持不同 key');
})();

// T3: 模拟 refreshSchedule 的 oldByKey + oldByTeamPair 双保险回填
//   场景：首次 load logo 已 enrich，第二次 refresh key 变了（Steam LIVE Date.now() 抖动）
(function () {
  // 首次 load 的 allSeries（已 enrich logo）
  var oldAllSeries = [{
    key: 'liq-teampirit__ironwing-' + Math.floor(1770000000 / 60),
    radiantName: 'Team Spirit',
    direName: 'Iron Wing',
    radiantLogo: 'https://cdn.opendota.com/logo1.png',
    direLogo: 'https://cdn.opendota.com/logo2.png',
    radiantLogoSource: 'opendota',
    direLogoSource: 'opendota'
  }];

  // 第二次 refresh 重建的 series（logo 全空，且 key 因 startTime 抖动而不同）
  var newSeries = [{
    key: 'liq-teampirit__ironwing-' + Math.floor((1770000045) / 60),  // +45s 不同秒但同一分钟桶
    radiantName: 'Team Spirit',
    direName: 'Iron Wing',
    radiantLogo: '',
    direLogo: '',
    radiantLogoSource: '',
    direLogoSource: ''
  }];

  // 模拟 league-detail.js L1287-1310 的回填逻辑
  var oldByKey = {};
  var oldByTeamPair = {};
  oldAllSeries.forEach(function (o) {
    if (o.key) oldByKey[o.key] = o;
    if (o.radiantName && o.direName) {
      var na = normalizeTeamNameForDedup(o.radiantName);
      var nb = normalizeTeamNameForDedup(o.direName);
      if (na && nb) oldByTeamPair[na + '|' + nb] = o;
    }
  });
  newSeries.forEach(function (s) {
    var old = oldByKey[s.key];
    if (!old && s.radiantName && s.direName) {
      var na = normalizeTeamNameForDedup(s.radiantName);
      var nb = normalizeTeamNameForDedup(s.direName);
      if (na && nb) old = oldByTeamPair[na + '|' + nb];
    }
    if (!old) return;
    if (!s.radiantLogo && old.radiantLogo) s.radiantLogo = old.radiantLogo;
    if (!s.direLogo && old.direLogo) s.direLogo = old.direLogo;
  });

  // T3a: 分钟级 key 相同 → oldByKey 命中
  assert.strictEqual(newSeries[0].radiantLogo, 'https://cdn.opendota.com/logo1.png',
    'T3a: 分钟级 key 匹配时 logo 应回填');
  console.log('  T3a ✓ 分钟级 key 匹配时 logo 回填成功');
})();

// T4: key 完全变化（跨分钟桶），队名兜底匹配
(function () {
  var oldAllSeries = [{
    key: 'liq-teampirit__ironwing-' + Math.floor(1770000000 / 60),
    radiantName: 'Team Spirit',
    direName: 'Iron Wing',
    radiantLogo: 'https://cdn.opendota.com/logo1.png',
    direLogo: 'https://cdn.opendota.com/logo2.png'
  }];
  var newSeries = [{
    key: 'liq-teampirit__ironwing-' + Math.floor(1770000120 / 60),  // +2min 不同桶
    radiantName: 'Team Spirit',
    direName: 'Iron Wing',
    radiantLogo: '',
    direLogo: ''
  }];

  var oldByKey = {};
  var oldByTeamPair = {};
  oldAllSeries.forEach(function (o) {
    if (o.key) oldByKey[o.key] = o;
    if (o.radiantName && o.direName) {
      var na = normalizeTeamNameForDedup(o.radiantName);
      var nb = normalizeTeamNameForDedup(o.direName);
      if (na && nb) oldByTeamPair[na + '|' + nb] = o;
    }
  });
  newSeries.forEach(function (s) {
    var old = oldByKey[s.key];
    if (!old && s.radiantName && s.direName) {
      var na = normalizeTeamNameForDedup(s.radiantName);
      var nb = normalizeTeamNameForDedup(s.direName);
      if (na && nb) old = oldByTeamPair[na + '|' + nb];
    }
    if (!old) return;
    if (!s.radiantLogo && old.radiantLogo) s.radiantLogo = old.radiantLogo;
    if (!s.direLogo && old.direLogo) s.direLogo = old.direLogo;
  });

  // T4: key 不匹配但队名匹配 → oldByTeamPair 命中
  assert.strictEqual(newSeries[0].radiantLogo, 'https://cdn.opendota.com/logo1.png',
    'T4: key 变化但队名匹配时 logo 应兜底回填');
  console.log('  T4 ✓ 队名兜底匹配时 logo 回填成功');
})();

// T5: 不同对局不应误回填 logo
(function () {
  var oldAllSeries = [{
    key: 'liq-teampirit__ironwing-' + Math.floor(1770000000 / 60),
    radiantName: 'Team Spirit',
    direName: 'Iron Wing',
    radiantLogo: 'https://cdn.opendota.com/logo1.png',
    direLogo: ''
  }];
  var newSeries = [{
    key: 'liq-nigmagalaxy__betboomteam-' + Math.floor(1770000000 / 60),
    radiantName: 'Nigma Galaxy',
    direName: 'BetBoom Team',
    radiantLogo: '',
    direLogo: ''
  }];

  var oldByKey = {};
  var oldByTeamPair = {};
  oldAllSeries.forEach(function (o) {
    if (o.key) oldByKey[o.key] = o;
    if (o.radiantName && o.direName) {
      var na = normalizeTeamNameForDedup(o.radiantName);
      var nb = normalizeTeamNameForDedup(o.direName);
      if (na && nb) oldByTeamPair[na + '|' + nb] = o;
    }
  });
  newSeries.forEach(function (s) {
    var old = oldByKey[s.key];
    if (!old && s.radiantName && s.direName) {
      var na = normalizeTeamNameForDedup(s.radiantName);
      var nb = normalizeTeamNameForDedup(s.direName);
      if (na && nb) old = oldByTeamPair[na + '|' + nb];
    }
    if (!old) return;
    if (!s.radiantLogo && old.radiantLogo) s.radiantLogo = old.radiantLogo;
    if (!s.direLogo && old.direLogo) s.direLogo = old.direLogo;
  });

  assert.strictEqual(newSeries[0].radiantLogo, '', 'T5: 不同对局不应误回填 logo');
  console.log('  T5 ✓ 不同对局不误回填 logo');
})();

console.log('--- 全部 5 条断言通过 ---');
