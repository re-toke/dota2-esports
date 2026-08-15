/* 语法 / JSON / 静态引用 校验脚本（仅本地检查，不依赖微信开发者工具） */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const NPM = path.join(ROOT, 'miniprogram_npm', 'tdesign-miniprogram');

const JS_FILES = [
  'pages/teams/teams.js',
  'pages/follow/follow.js',
  'pages/leagues/leagues.js',
  'subpackages/detail/league-detail/league-detail.js',
  'subpackages/detail/team-detail/team-detail.js',
  'utils/sources.js',
  'utils/stratz.js',
  'utils/steam.js',
  'utils/consensus.js',
  'utils/curation.js',
  'utils/config.js'
];

const JSON_FILES = [
  'pages/teams/teams.json',
  'pages/follow/follow.json',
  'subpackages/detail/league-detail/league-detail.json',
  'subpackages/detail/team-detail/team-detail.json'
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
  ['pages/teams/teams', ['loadingMore', 'hasMore', 'page', 'pageSize']],
  ['pages/follow/follow', ['loadingMore', 'hasMore', 'page', 'pageSize']],
  ['subpackages/detail/league-detail/league-detail', ['liqTier', 'sourceLabel']]
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

// 5) 全量 TDesign 组件 vendor 检查（防止按需清理后误删仍在使用的组件）
console.log('\n=== 全量 TDesign 组件 vendor 检查 ===');
function walkJson(dir, missing) {
  const es = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of es) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'miniprogram_npm' || e.name === 'node_modules' || e.name === '.git') continue;
      walkJson(full, missing);
    } else if (e.name.endsWith('.json')) {
      try {
        const j = JSON.parse(fs.readFileSync(full, 'utf8'));
        const uc = j.usingComponents || {};
        for (const k of Object.keys(uc)) {
          const v = uc[k] || '';
          const m = v.match(/tdesign-miniprogram\/([^\/]+)\//);
          if (m) {
            const compDir = path.join(NPM, m[1]);
            if (!fs.existsSync(compDir) || !fs.existsSync(path.join(compDir, m[1] + '.json'))) {
              missing.push({ file: path.relative(ROOT, full), comp: m[1] });
            }
          }
        }
      } catch (e) {}
    }
  }
}
const tdesignMissing = [];
walkJson(ROOT, tdesignMissing);
if (tdesignMissing.length) {
  console.error('FAIL 以下 TDesign 组件被引用但未 vendor:');
  tdesignMissing.forEach(function (m) {
    console.error('  ' + m.file + ' → ' + m.comp);
    errors++;
  });
  console.error('请重新执行 npm install 后用开发者工具「构建 npm」，或恢复对应组件目录。');
} else {
  console.log('OK   所有引用的 TDesign 组件均已 vendor');
}

console.log('\n=== 结果 ===');
console.log(errors === 0 ? '全部通过 ✅' : (errors + ' 处问题 ❌'));
process.exit(errors === 0 ? 0 : 1);
