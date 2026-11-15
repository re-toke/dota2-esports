#!/usr/bin/env node
/**
 * scripts/test/test-league-meta-view.js
 * 赛事详情页 metadata 视图模型纯函数单测（★ 2026-11-15 第三批 · 第一刀）
 *
 * 覆盖 utils/leagueMetaView.js：
 *   worstConfidence / buildSourceBadges / buildMetadataSkeleton /
 *   buildCurationFallback / mergeMetadataWithFallback
 *
 * 运行：node scripts/test/test-league-meta-view.js
 */
'use strict';

const metaView = require('../../utils/leagueMetaView.js');

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + '  ->  ' + (detail || '')); }
}

// ===== worstConfidence =====
assert('worstConfidence: high+high → high', metaView.worstConfidence('high', 'high') === 'high');
assert('worstConfidence: low+high → low（取最保守）', metaView.worstConfidence('low', 'high') === 'low');
assert('worstConfidence: medium+high → medium', metaView.worstConfidence('medium', 'high') === 'medium');
assert('worstConfidence: 缺省+缺省 → low', metaView.worstConfidence(null, undefined) === 'low');
assert('worstConfidence: 单侧 medium + 缺省 → low（缺省按最保守处理）',
  metaView.worstConfidence('medium', null) === 'low');

// ===== buildSourceBadges =====
assert('buildSourceBadges: 空输入 → []', metaView.buildSourceBadges(null).length === 0);
(function () {
  const b = metaView.buildSourceBadges(['OpenDota', 'openDota', 'foo']);
  assert('buildSourceBadges: 大小写去重 + 未知来源回退原名',
    b.length === 2 && b[0].key === 'opendota' && b[0].label === 'OpenDota' &&
    b[1].key === 'foo' && b[1].label === 'foo',
    JSON.stringify(b));
})();

// ===== buildMetadataSkeleton =====
(function () {
  const s = metaView.buildMetadataSkeleton();
  assert('buildMetadataSkeleton: participants 与 participantsCount 均为 null',
    s.participants === null && s.participantsCount === null);
  assert('buildMetadataSkeleton: 必需 key 齐全（canonical/prizeDisplay/sources）',
    s.canonical === null && s.prizeDisplay === '' && Array.isArray(s.sources) && s.sources.length === 0);
})();

// ===== buildCurationFallback =====
assert('buildCurationFallback: null → null', metaView.buildCurationFallback(null) === null);
(function () {
  const fb = metaView.buildCurationFallback({
    canonical: 'TI 2024',
    prizePool: 500000,
    prizePoolCurrency: 'USD',
    region: 'CN',
    format: 'BO3',
    organizer: 'Valve',
    start: 1704067200,
    participants: [{ name: 'A' }, { name: 'B' }, { name: 'C' }],
    status: 'upcoming'
  });
  assert('buildCurationFallback: 数组只进 participants，count=长度',
    Array.isArray(fb.participants) && fb.participants.length === 3 && fb.participantsCount === 3);
  assert('buildCurationFallback: region→location / prizePool 转字符串',
    fb.location === 'CN' && fb.prizePool === '500000');
  assert('buildCurationFallback: unix 秒 → YYYY-MM-DD',
    fb.startDate === '2024-01-01', String(fb.startDate));
})();
(function () {
  const fb = metaView.buildCurationFallback({ participants: 8 });
  assert('buildCurationFallback: 数字 participants → participantsCount=8，participants=null',
    fb.participants === null && fb.participantsCount === 8,
    JSON.stringify({ p: fb.participants, c: fb.participantsCount }));
})();

// ===== mergeMetadataWithFallback =====
(function () {
  // 无 curation 命中 → 骨架；空串/null 不得覆盖兜底值
  const merged = metaView.mergeMetadataWithFallback(
    { organizer: '', location: null, format: 'BO5' },
    '__UNIT_TEST_UNKNOWN_LEAGUE__',
    0
  );
  assert('mergeMetadataWithFallback: 空串/null 不覆盖兜底，非空值正常覆盖',
    merged.organizer === null && merged.location === null && merged.format === 'BO5',
    JSON.stringify({ org: merged.organizer, loc: merged.location, fmt: merged.format }));
})();
(function () {
  const merged = metaView.mergeMetadataWithFallback(
    { participants: [{ name: 'A' }, { name: 'B' }] },
    '__UNIT_TEST_UNKNOWN_LEAGUE__',
    0
  );
  assert('mergeMetadataWithFallback: 数组 participants 保留，count 取数组长度',
    Array.isArray(merged.participants) && merged.participants.length === 2 && merged.participantsCount === 2,
    JSON.stringify({ p: merged.participants, c: merged.participantsCount }));
})();
(function () {
  const merged = metaView.mergeMetadataWithFallback(
    { participants: 5, participantsCount: 'bad' },
    '__UNIT_TEST_UNKNOWN_LEAGUE__',
    0
  );
  assert('mergeMetadataWithFallback: 数字 participants 迁移到 count 并把 participants 置空',
    merged.participants === null && merged.participantsCount === 5,
    JSON.stringify({ p: merged.participants, c: merged.participantsCount }));
})();

// ===== 收尾 =====
console.log('\n===== test-league-meta-view: ' + pass + ' passed, ' + fail + ' failed =====');
if (fail > 0) process.exit(1);
