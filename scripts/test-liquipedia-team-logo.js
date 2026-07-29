// scripts/test-liquipedia-team-logo.js
// §8.3 Liquipedia 战队 Logo 解析单元测试（2026-07-29）
//
// 验证 parseTeamLogo 对各种 wikitext 格式的解析正确性：
//   1. 标准 {{Infobox team}} image 字段
//   2. image_dark / logo / logo_dark 兜底字段
//   3. 带 [[File:xxx|200px]] 链接格式的 image
//   4. 无 image 字段 → null
//   5. 无模板 → null
//   6. 空 wikitext → null
//   7. 队名含下划线（Liquipedia 常见格式）
//
// 运行：node scripts/test-liquipedia-team-logo.js

'use strict';

const path = require('path');
const LiquiParse = require(path.resolve(__dirname, '..', 'utils', 'liquipedia-parse.js'));

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

// ===== 1. 标准 image 字段 =====
check('标准 {{Infobox team}} image 字段', () => {
  const wt = [
    '{{Infobox team',
    '|name=Team Spirit',
    '|image=Team_Spirit_logo.png',
    '|imagecaption=',
    '|region=CIS',
    '}}'
  ].join('\n');
  const r = LiquiParse.parseTeamLogo(wt);
  assert(r !== null, '应返回对象');
  eq(r, { image: 'Team_Spirit_logo.png' });
});

// ===== 2. image_dark 兜底 =====
check('image_dark 字段兜底', () => {
  const wt = [
    '{{Infobox team',
    '|name=Team Alpha',
    '|image_dark=Alpha_logo_dark.png',
    '}}'
  ].join('\n');
  const r = LiquiParse.parseTeamLogo(wt);
  eq(r, { image: 'Alpha_logo_dark.png' });
});

// ===== 3. logo 字段兜底 =====
check('logo 字段兜底', () => {
  const wt = [
    '{{Infobox team',
    '|name=Team Beta',
    '|logo=Beta_logo.png',
    '}}'
  ].join('\n');
  const r = LiquiParse.parseTeamLogo(wt);
  eq(r, { image: 'Beta_logo.png' });
});

// ===== 4. logo_dark 字段兜底 =====
check('logo_dark 字段兜底', () => {
  const wt = [
    '{{Infobox team',
    '|name=Team Gamma',
    '|logo_dark=Gamma_logo_dark.png',
    '}}'
  ].join('\n');
  const r = LiquiParse.parseTeamLogo(wt);
  eq(r, { image: 'Gamma_logo_dark.png' });
});

// ===== 5. image 优先于 image_dark =====
check('image 优先于 image_dark', () => {
  const wt = [
    '{{Infobox team',
    '|name=Team Delta',
    '|image=Delta_light.png',
    '|image_dark=Delta_dark.png',
    '}}'
  ].join('\n');
  const r = LiquiParse.parseTeamLogo(wt);
  eq(r, { image: 'Delta_light.png' });
});

// ===== 6. image 优先于 logo =====
check('image 优先于 logo', () => {
  const wt = [
    '{{Infobox team',
    '|name=Team Epsilon',
    '|image=Epsilon_main.png',
    '|logo=Epsilon_alt.png',
    '}}'
  ].join('\n');
  const r = LiquiParse.parseTeamLogo(wt);
  eq(r, { image: 'Epsilon_main.png' });
});

// ===== 7. 无 image 字段 → null =====
check('无 image 字段返回 null', () => {
  const wt = [
    '{{Infobox team',
    '|name=No Logo Team',
    '|region=EU',
    '}}'
  ].join('\n');
  const r = LiquiParse.parseTeamLogo(wt);
  assert(r === null, '无 image 应返回 null，实际: ' + JSON.stringify(r));
});

// ===== 8. 无模板 → null =====
check('无 Infobox team 模板返回 null', () => {
  const wt = '这是一段没有模板的普通文本。{{SomeOtherTemplate|foo=bar}}';
  const r = LiquiParse.parseTeamLogo(wt);
  assert(r === null, '无模板应返回 null');
});

// ===== 9. 空 wikitext → null =====
check('空 wikitext 返回 null', () => {
  assert(LiquiParse.parseTeamLogo('') === null, '空字符串应返回 null');
  assert(LiquiParse.parseTeamLogo(null) === null, 'null 应返回 null');
  assert(LiquiParse.parseTeamLogo(undefined) === null, 'undefined 应返回 null');
});

// ===== 10. 模板名大小写不敏感 =====
check('模板名大小写不敏感（infobox team）', () => {
  const wt = [
    '{{infobox team',
    '|name=Lower Team',
    '|image=lower_logo.png',
    '}}'
  ].join('\n');
  const r = LiquiParse.parseTeamLogo(wt);
  eq(r, { image: 'lower_logo.png' });
});

// ===== 11. 文件名含空格（Liquipedia 部分页面用空格）=====
check('文件名保留空格', () => {
  const wt = [
    '{{Infobox team',
    '|name=Team With Space',
    '|image=Team With Space Logo.png',
    '}}'
  ].join('\n');
  const r = LiquiParse.parseTeamLogo(wt);
  eq(r, { image: 'Team With Space Logo.png' });
});

// ===== 运行结果 =====
console.log('\n=== 结果 ===');
console.log('通过: ' + passed + '  失败: ' + failed);
console.log(failed === 0 ? '全部通过' : '存在失败');
process.exit(failed === 0 ? 0 : 1);
