// scripts/test-liquipedia-league-tier.js
// §9 Liquipedia 赛事等级（Tier）解析单元测试（2026-07-30）
//
// 验证 parseLeagueTier 对各种 wikitext 格式的解析正确性：
//   1. 标准 liquipediatier=1/2/3/4
//   2. 无 liquipediatier 字段 → null
//   3. 无 {{Infobox league}} 模板 → null
//   4. 空 wikitext → null
//   5. 超出范围（0 / 5）→ null
//   6. 非数字（abc）→ null
//   7. 兼容 tier= 字段名
//   8. wikitext 标记 / 空格清理
//   9. 与 parseLeagueMetadata 共存
//
// 运行：node scripts/test-liquipedia-league-tier.js

'use strict';

const path = require('path');
const LiquiParse = require(path.resolve(__dirname, '..', '..', 'utils', 'liquipedia-parse.js'));

let passed = 0;
let failed = 0;
const TOTAL = 14;

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
function eq(actual, expected, msg) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error((msg || '') + ' 期望 ' + JSON.stringify(expected) + ' 实际 ' + JSON.stringify(actual));
  }
}

// ===== 1. 标准 liquipediatier=1 =====
check('标准 liquipediatier=1', () => {
  const wt = [
    '{{Infobox league',
    '|name=The International 2024',
    '|liquipediatier=1',
    '|sdate=2024-09-11',
    '|edate=2024-10-13',
    '}}'
  ].join('\n');
  const r = LiquiParse.parseLeagueTier(wt);
  eq(r, { tier: 1 });
});

// ===== 2. liquipediatier=2 =====
check('liquipediatier=2', () => {
  const wt = [
    '{{Infobox league',
    '|name=DreamLeague Season 27',
    '|liquipediatier=2',
    '}}'
  ].join('\n');
  const r = LiquiParse.parseLeagueTier(wt);
  eq(r, { tier: 2 });
});

// ===== 3. liquipediatier=3 =====
check('liquipediatier=3', () => {
  const wt = [
    '{{Infobox league',
    '|name=ESL One Birmingham 2024',
    '|liquipediatier=3',
    '}}'
  ].join('\n');
  const r = LiquiParse.parseLeagueTier(wt);
  eq(r, { tier: 3 });
});

// ===== 4. liquipediatier=4 =====
check('liquipediatier=4', () => {
  const wt = [
    '{{Infobox league',
    '|name=Open Qualifier',
    '|liquipediatier=4',
    '}}'
  ].join('\n');
  const r = LiquiParse.parseLeagueTier(wt);
  eq(r, { tier: 4 });
});

// ===== 5. 无 liquipediatier 字段 → null =====
check('无 liquipediatier 字段返回 null', () => {
  const wt = [
    '{{Infobox league',
    '|name=Unknown Tier League',
    '|sdate=2024-01-01',
    '|edate=2024-01-10',
    '}}'
  ].join('\n');
  const r = LiquiParse.parseLeagueTier(wt);
  assert(r === null, '无 liquipediatier 应返回 null，实际: ' + JSON.stringify(r));
});

// ===== 6. 无 {{Infobox league}} 模板 → null =====
check('无 Infobox league 模板返回 null', () => {
  const wt = '这是一段没有模板的普通文本。{{SomeOtherTemplate|foo=bar}}';
  const r = LiquiParse.parseLeagueTier(wt);
  assert(r === null, '无模板应返回 null');
});

// ===== 7. 空 wikitext → null =====
check('空 wikitext 返回 null', () => {
  assert(LiquiParse.parseLeagueTier('') === null, '空字符串应返回 null');
  assert(LiquiParse.parseLeagueTier(null) === null, 'null 应返回 null');
  assert(LiquiParse.parseLeagueTier(undefined) === null, 'undefined 应返回 null');
});

// ===== 8. liquipediatier=0（超出范围）→ null =====
check('liquipediatier=0 超出范围返回 null', () => {
  const wt = [
    '{{Infobox league',
    '|name=Zero Tier',
    '|liquipediatier=0',
    '}}'
  ].join('\n');
  const r = LiquiParse.parseLeagueTier(wt);
  assert(r === null, 'liquipediatier=0 应返回 null，实际: ' + JSON.stringify(r));
});

// ===== 9. liquipediatier=5（超出范围）→ null =====
check('liquipediatier=5 超出范围返回 null', () => {
  const wt = [
    '{{Infobox league',
    '|name=Five Tier',
    '|liquipediatier=5',
    '}}'
  ].join('\n');
  const r = LiquiParse.parseLeagueTier(wt);
  assert(r === null, 'liquipediatier=5 应返回 null，实际: ' + JSON.stringify(r));
});

// ===== 10. liquipediatier=abc（非数字）→ null =====
check('liquipediatier=abc 非数字返回 null', () => {
  const wt = [
    '{{Infobox league',
    '|name=Bad Tier',
    '|liquipediatier=abc',
    '}}'
  ].join('\n');
  const r = LiquiParse.parseLeagueTier(wt);
  assert(r === null, 'liquipediatier=abc 应返回 null，实际: ' + JSON.stringify(r));
});

// ===== 11. 兼容 tier= 字段名 =====
check('兼容 tier= 字段名（部分页面用 tier 而非 liquipediatier）', () => {
  const wt = [
    '{{Infobox league',
    '|name=Legacy Tier Page',
    '|tier=2',
    '}}'
  ].join('\n');
  const r = LiquiParse.parseLeagueTier(wt);
  eq(r, { tier: 2 });
});

// ===== 12. 带 wikitext 标记（如 [[1]]）→ { tier: 1 } =====
check('带 wikitext 标记 [[1]] 仍解析为 { tier: 1 }', () => {
  const wt = [
    '{{Infobox league',
    '|name=Wikilink Tier',
    '|liquipediatier=[[1]]',
    '}}'
  ].join('\n');
  const r = LiquiParse.parseLeagueTier(wt);
  eq(r, { tier: 1 });
});

// ===== 13. 带空格（如 " 1 "）→ { tier: 1 } =====
check('带空格 " 1 " 仍解析为 { tier: 1 }', () => {
  const wt = [
    '{{Infobox league',
    '|name=Spaced Tier',
    '|liquipediatier= 1 ',
    '}}'
  ].join('\n');
  const r = LiquiParse.parseLeagueTier(wt);
  eq(r, { tier: 1 });
});

// ===== 14. 与 parseLeagueMetadata 共存 =====
check('与 parseLeagueMetadata 共存：同一 wikitext 两者均正确', () => {
  const wt = [
    '{{Infobox league',
    '|name=Coexist League',
    '|sdate=2024-03-01',
    '|edate=2024-03-10',
    '|prizepool=1000000',
    '|liquipediatier=2',
    '}}'
  ].join('\n');
  const tier = LiquiParse.parseLeagueTier(wt);
  const meta = LiquiParse.parseLeagueMetadata(wt);
  eq(tier, { tier: 2 }, 'tier 解析应正确');
  assert(meta !== null, 'metadata 不应为 null');
  eq(meta.canonical, 'Coexist League', 'canonical 应保留');
  eq(meta.startDate, '2024-03-01', 'startDate 应保留');
  eq(meta.endDate, '2024-03-10', 'endDate 应保留');
  eq(meta.prizePool, '1000000', 'prizePool 应保留');
});

// ===== 运行结果 =====
console.log('\n=== 结果 ===');
console.log('通过: ' + passed + '  失败: ' + failed);
if (failed === 0) {
  console.log('[test-liquipedia-league-tier] 全部通过（' + passed + '/' + TOTAL + '）');
} else {
  console.log('[test-liquipedia-league-tier] 存在失败（' + passed + '/' + TOTAL + '）');
}
process.exit(failed === 0 ? 0 : 1);
