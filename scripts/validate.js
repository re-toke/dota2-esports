/* 语法 / JSON / 静态引用 校验脚本（仅本地检查，不依赖微信开发者工具） */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const NPM = path.join(ROOT, 'miniprogram_npm', 'tdesign-miniprogram');

const JS_FILES = [
  'pages/player-detail/player-detail.js',
  'pages/teams/teams.js',
  'pages/follow/follow.js',
  'pages/leagues/leagues.js',
  'pages/league-detail/league-detail.js',
  'pages/team-detail/team-detail.js',
  'utils/sources.js',
  'utils/stratz.js',
  'utils/steam.js',
  'utils/consensus.js',
  'utils/curation.js',
  'utils/config.js'
];

const JSON_FILES = [
  'pages/player-detail/player-detail.json',
  'pages/teams/teams.json',
  'pages/follow/follow.json',
  'pages/league-detail/league-detail.json',
  'pages/team-detail/team-detail.json'
];

let errors = 0;

// 1) JS 语法检查
console.log('=== JS 语法检查 (node --check) ===');
for (const f of JS_FILES) {
  const p = path.join(ROOT, f);
  const vm = require('vm');
  try {
    const code = fs.readFileSync(p, 'utf8');
    new vm.Script(code, { filename: f });
    console.log('OK   ' + f);
  } catch (e) {
    errors++;
    console.log('FAIL ' + f + ' -> ' + e.message);
  }
}

// 2) JSON 合法性检查
console.log('\n=== JSON 合法性检查 ===');
for (const f of JSON_FILES) {
  const p = path.join(ROOT, f);
  try {
    JSON.parse(fs.readFileSync(p, 'utf8'));
    console.log('OK   ' + f);
  } catch (e) {
    errors++;
    console.log('FAIL ' + f + ' -> ' + e.message);
  }
}

// 3) TDesign 组件路径静态引用检查
console.log('\n=== TDesign 组件路径引用检查 ===');
const compRe = /"tdesign-miniprogram\/([a-z-]+)\/[a-z-]+"/g;
const seen = new Set();
for (const f of JSON_FILES) {
  const p = path.join(ROOT, f);
  const text = fs.readFileSync(p, 'utf8');
  let m;
  while ((m = compRe.exec(text)) !== null) {
    const comp = m[1];
    if (seen.has(comp)) continue;
    seen.add(comp);
    const dir = path.join(NPM, comp);
    if (fs.existsSync(dir) && fs.existsSync(path.join(dir, comp + '.json'))) {
      console.log('OK   tdesign-miniprogram/' + comp + '/' + comp);
    } else {
      errors++;
      console.log('FAIL tdesign-miniprogram/' + comp + ' -> 目录或入口文件缺失');
    }
  }
}

// 4) WXML 中引用的关键 data 字段是否在 JS data 中声明（轻量正则校验）
console.log('\n=== WXML 关键字段引用检查 ===');
const pairs = [
  ['pages/player-detail/player-detail', ['loadingMore', 'hasMore', 'page', 'pageSize']],
  ['pages/teams/teams', ['loadingMore', 'hasMore', 'page', 'pageSize']],
  ['pages/follow/follow', ['loadingMore', 'hasMore', 'page', 'pageSize']],
  ['pages/league-detail/league-detail', ['liqTier', 'sourceLabel']]
];
for (const [page, fields] of pairs) {
  const js = fs.readFileSync(path.join(ROOT, page + '.js'), 'utf8');
  const wxml = fs.readFileSync(path.join(ROOT, page + '.wxml'), 'utf8');
  for (const field of fields) {
    const inWxml = new RegExp('\\{\\{[^}]*\\b' + field + '\\b').test(wxml);
    const inJs = new RegExp('\\b' + field + ':').test(js);
    if (inWxml && !inJs) {
      errors++;
      console.log('FAIL ' + page + ' -> wxml 使用 ' + field + ' 但 JS data 未声明');
    } else if (inWxml) {
      console.log('OK   ' + page + ' -> ' + field);
    }
  }
}

console.log('\n=== 结果 ===');
console.log(errors === 0 ? '全部通过 ✅' : (errors + ' 处问题 ❌'));
process.exit(errors === 0 ? 0 : 1);
