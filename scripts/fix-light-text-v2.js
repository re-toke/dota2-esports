/* eslint-disable */
// 雾峰雪 v2.0 浅文字色统一替换脚本
// 仅处理 dota2-esports/ 下 page/component/subpackage wxss，跳过 npm/rollback/deliverables
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set([
  'node_modules', 'miniprogram_npm', '.git',
  'scripts', 'cloudfunctions', 'utils',
]);
// deliverables 在仓库外，本脚本天然不会扫描到

// 替换映射表：原始色 -> 语义 token / 安全字面色
// 分类：
//  A. 浅灰文字（暗色系遗留） -> --text-2/-3（次级/三级正文）
//  B. 极浅近白文字 -> --text-1（主标题级）
//  C. 亮金 #ffcf5c/#ffd15c/#e6c97a -> --dota-gold-strong（对比度过 WCAG-AA）
//  D. 浅红 #ff7b7b/#f87171/#ff8a82/#ff7b72 -> --dire（夜魇红，强调负向语义）
//  E. 银牌浅灰 #c9d1d9/#c9d2dd/#d4dce6 -> --text-3（三等奖/次要文本）
//  F. 冷雾灰 #d6dbe2 -> --text-3
const MAP = {
  // —— 浅近白文字（亮主题几乎不可见）——
  '#e6ebf2': 'var(--text-1)',
  '#e8eef6': 'var(--text-1)',
  '#f0f0f0': 'var(--text-1)',
  '#e8e8e8': 'var(--text-1)',
  '#ffffff': 'var(--text-1)',
  // —— 浅灰正文 ——
  '#c3ccd9': 'var(--text-2)',
  '#c9d1d9': 'var(--text-3)',
  '#c9d2dd': 'var(--text-3)',
  '#d4dce6': 'var(--text-3)',
  '#d6dbe2': 'var(--text-3)',
  '#d1d5db': 'var(--text-3)', // follow 页占位文字
  // —— 亮金 → 深金（可读） ——
  '#ffcf5c': 'var(--dota-gold-strong)',
  '#ffd15c': 'var(--dota-gold-strong)',
  '#e6c97a': 'var(--dota-gold-strong)',
  // —— 浅红 → 夜魇红 ——
  '#ff7b7b': 'var(--dire)',
  '#f87171': 'var(--dire)',
  '#ff8a82': 'var(--dire)',
  '#ff7b72': 'var(--dire)',
};

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      walk(p, out);
    } else if (name.endsWith('.wxss')) {
      out.push(p);
    }
  }
}

const files = [];
walk(ROOT, files);

let totalEdits = 0;
const report = [];
for (const f of files) {
  const rel = path.relative(ROOT, f);
  let src = fs.readFileSync(f, 'utf8');
  let fileHits = 0;
  let fileOut = src;
  // 仅替换 color: xxx 形态，避免误伤 background/border
  for (const [from, to] of Object.entries(MAP)) {
    const fromLower = from.toLowerCase();
    // 大小写不敏感匹配 color:<空格?>#xxx
    const re = new RegExp(
      '(color:\\s*)' + fromLower.replace('#', '#'),
      'gi'
    );
    fileOut = fileOut.replace(re, (m, p1) => {
      fileHits++;
      return p1 + to;
    });
  }
  if (fileHits > 0) {
    fs.writeFileSync(f, fileOut);
    totalEdits += fileHits;
    report.push({ file: rel, hits: fileHits });
  }
}

console.log('=== 浅文字色替换报告 ===');
console.log('扫描 wxss 文件数:', files.length);
console.log('命中文件数:', report.length);
console.log('总替换次数:', totalEdits);
console.log('---');
report.sort((a, b) => b.hits - a.hits);
for (const r of report) console.log(`  ${r.hits.toString().padStart(3)}  ${r.file}`);
