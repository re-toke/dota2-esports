// scripts/test-consensus.js
// §9 P0-B1 / P1-B2 consensus.js 单元测试（2026-07-30）
//
// 验证 utils/consensus.js 的关键导出：
//   - eventFingerprint / extractYear（赛事身份指纹，P0-B1）
//   - voteName / consensusTier / weightOf（加权投票，P1-B2）
//
// 运行：node scripts/test-consensus.js

'use strict';

const path = require('path');
const C = require(path.resolve(__dirname, '..', '..', 'utils', 'consensus.js'));

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

function eq(actual, expected, msg) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error((msg || '') + ' 期望 ' + JSON.stringify(expected) + ' 实际 ' + JSON.stringify(actual));
  }
}

// ===== P0-B1 eventFingerprint 测试 =====

// 1. 标准 event（{canonical, year, organizer, start}）→ 正确生成指纹 "namekey|year|org|weekbucket"
check('eventFingerprint 标准 event 生成正确指纹', () => {
  const ev = {
    canonical: 'ESL One Birmingham',
    year: 2024,
    organizer: 'ESL Gaming',
    start: 1717372800
  };
  // nameKey=eslonebirmingham, year=2024, org=esl(gaming 后缀去除), weekBucket=floor(1717372800/604800)=2839
  eq(C.eventFingerprint(ev), 'eslonebirmingham|2024|esl|2839');
});

// 2. 同名不同年份 → 指纹不同（年份字段不同）
check('eventFingerprint 同名不同年份 指纹不同', () => {
  const a = { canonical: 'ESL One', year: 2024, organizer: 'ESL', start: 1717372800 };
  const b = { canonical: 'ESL One', year: 2025, organizer: 'ESL', start: 1717372800 };
  assert(C.eventFingerprint(a) !== C.eventFingerprint(b), '年份不同指纹应不同');
});

// 3. 同名同年份不同主办方 → 指纹不同（org 字段不同）
check('eventFingerprint 同名同年份不同主办方 指纹不同', () => {
  const a = { canonical: 'ESL One', year: 2024, organizer: 'ESL', start: 1717372800 };
  const b = { canonical: 'ESL One', year: 2024, organizer: 'PGL', start: 1717372800 };
  assert(C.eventFingerprint(a) !== C.eventFingerprint(b), '主办方不同指纹应不同');
});

// 4. 同名同年份同主办方不同时间 → 指纹不同（weekbucket 不同，±7天跨桶）
check('eventFingerprint 同名同年份同主办方不同时间 指纹不同（跨周桶）', () => {
  const a = { canonical: 'ESL One', year: 2024, organizer: 'ESL', start: 1717372800 };
  // +8 天，跨到下一个 7 天桶（2839 -> 2840）
  const b = { canonical: 'ESL One', year: 2024, organizer: 'ESL', start: 1717372800 + 86400 * 8 };
  const fa = C.eventFingerprint(a);
  const fb = C.eventFingerprint(b);
  assert(fa !== fb, '时间跨桶指纹应不同，实际 a=' + fa + ' b=' + fb);
});

// 5. 缺失 organizer 字段 → 指纹仍有效（org 为空串）
check('eventFingerprint 缺失 organizer 指纹仍有效（org 为空串）', () => {
  const ev = { canonical: 'ESL One', year: 2024, start: 1717372800 };
  const fp = C.eventFingerprint(ev);
  assert(fp !== '', '指纹应非空');
  eq(fp, 'eslone|2024||2839');
});

// 6. 缺失 year 但 name 含年份 → 从 name 提取年份
check('eventFingerprint 缺失 year 从 name 提取年份', () => {
  const ev = { canonical: 'ESL One 2024', organizer: 'ESL', start: 1717372800 };
  const fp = C.eventFingerprint(ev);
  assert(fp !== '', '指纹应非空');
  // year 从 canonical 提取 "2024"
  assert(fp.indexOf('|2024|') >= 0, '指纹应包含从 name 提取的年份 2024，实际 ' + fp);
});

// 7. 空 event → 返回 ''
check('eventFingerprint 空 event 返回空串', () => {
  eq(C.eventFingerprint(null), '');
  eq(C.eventFingerprint(undefined), '');
  eq(C.eventFingerprint({}), '');
});

// 8. extractYear 匹配 20XX 模式（不匹配两位数缩写）
check('extractYear 匹配 20XX 四位数年份（不匹配两位数缩写）', () => {
  // 正则 /(20\d{2})/ 只匹配 20XX 四位数年份
  eq(C.extractYear('DreamLeague Season 2027'), '2027');
  // 两位数 "27" 不匹配 20XX 模式，返回空串
  eq(C.extractYear('DreamLeague Season 27'), '');
});

// 9. extractYear 无年份返回空串
check('extractYear 无年份返回空串', () => {
  eq(C.extractYear('No Year Here'), '');
  eq(C.extractYear(''), '');
  eq(C.extractYear(null), '');
});

// ===== P1-B2 加权投票测试 =====

// 10. voteName 加权：curation(3)+opendota(1)=4 vs community(1)+stratz(1.5)=2.5 → 第一组胜出
check('voteName 加权计票 curation+opendota(4) 胜过 community+stratz(2.5)', () => {
  const candidates = [
    { value: 'ESL One Birmingham', source: 'curation' },
    { value: 'ESL One Birmingham', source: 'opendota' },
    { value: 'ESL One Birmingham 2024', source: 'community' },
    { value: 'ESL One Birmingham 2024', source: 'stratz' }
  ];
  const r = C.voteName(candidates);
  eq(r.value, 'ESL One Birmingham');
});

// 11. voteName 同权重多源（opendota+community 都是 1）→ 按原文最长优先
check('voteName 同权重按原文最长优先', () => {
  const candidates = [
    { value: 'ESL One', source: 'opendota' },
    { value: 'ESL One Birmingham', source: 'community' }
  ];
  const r = C.voteName(candidates);
  // 两组权重均为 1，平票取原文最长 → "ESL One Birmingham"
  eq(r.value, 'ESL One Birmingham');
});

// 12. consensusTier：curation(S, rank=3, 权重 3) vs opendota(B, rank=1, 权重 1) + community(B, rank=1, 权重 1) → curation 胜出
check('consensusTier curation 权重 3 胜过 opendota+community 权重 2', () => {
  const candidates = [
    { grade: 'S', rank: 3, source: 'curation' },
    { grade: 'B', rank: 1, source: 'opendota' },
    { grade: 'B', rank: 1, source: 'community' }
  ];
  const r = C.consensusTier(candidates);
  eq(r.grade, 'S');
  eq(r.rank, 3);
});

// 13. consensusTier：curation(S, 权重 3) + liquipedia(S, 权重 4) vs opendota(A, 权重 1) → S 级胜出（权重和 7 > 1）
check('consensusTier S 级权重和 7 胜过 A 级权重 1', () => {
  const candidates = [
    { grade: 'S', rank: 3, source: 'curation' },
    { grade: 'S', rank: 3, source: 'liquipedia' },
    { grade: 'A', rank: 2, source: 'opendota' }
  ];
  const r = C.consensusTier(candidates);
  eq(r.grade, 'S');
  eq(r.rank, 3);
});

// 14. consensusTier：opendota(S, 权重 1) vs liquipedia(A, 权重 4) → A 级胜出（权重 4 > 1）
check('consensusTier liquipedia 权重 4 胜过 opendota 权重 1（即使 rank 更低）', () => {
  const candidates = [
    { grade: 'S', rank: 3, source: 'opendota' },
    { grade: 'A', rank: 2, source: 'liquipedia' }
  ];
  const r = C.consensusTier(candidates);
  // liquipedia 人工策展权重 4 > opendota 自动源权重 1，体现人工策展更可信（对齐 Liquipedia 等级体系）
  eq(r.grade, 'A');
  eq(r.rank, 2);
});

// 15. weightOf('curation') === 3
check('weightOf curation === 3', () => {
  eq(C.weightOf('curation'), 3);
});

// 15b. consensusTier：curation(A, 权重 3) vs liquipedia(S, 权重 4) → S 级胜出（4 > 3）
// 这是 2026-07-30「仅提高LP权重」的核心效果：Liquipedia 现可逆转 curation 的钉制。
check('consensusTier liquipedia 权重 4 胜过 curation 权重 3', () => {
  const candidates = [
    { grade: 'A', rank: 2, source: 'curation' },
    { grade: 'S', rank: 3, source: 'liquipedia' }
  ];
  const r = C.consensusTier(candidates);
  eq(r.grade, 'S');
  eq(r.rank, 3);
});

// 16. weightOf('liquipedia') === 4（2026-07-30 起提至最高，对齐 Liquipedia 等级体系）
check('weightOf liquipedia === 4', () => {
  eq(C.weightOf('liquipedia'), 4);
});

// 17. weightOf unknown source 默认 1
check('weightOf 未知来源默认 1', () => {
  eq(C.weightOf('unknown_source'), 1);
});

// ===== 运行结果 =====
const total = passed + failed;
console.log('\n=== 结果 ===');
console.log('通过: ' + passed + '  失败: ' + failed);
if (failed === 0) {
  console.log('[test-consensus] 全部通过（' + passed + '/' + total + '）');
  process.exit(0);
} else {
  console.log('[test-consensus] 存在失败（' + passed + '/' + total + '）');
  process.exit(1);
}
