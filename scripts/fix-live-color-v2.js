/* eslint-disable */
// 雾峰雪 v2.0 · LIVE 旧红色统一替换为 --status-live #EF4444
// 替换：rgba(255,91,82)→rgba(239,68,68) / rgba(255,123,114)→rgba(239,68,68)
//       #FF5B52/#ff5b52→保留（fallback 字符串，不替换 token fallback 字符串中的 --status-live 后值）
//       #ff4d4f→同上
// 注意：只替换 rgba 和硬编码 hex；保留 var(--status-live, ...) 的 fallback 值不改（fallback 在 token 失效时才用）
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', 'miniprogram_npm', '.git', 'scripts', 'cloudfunctions', 'utils']);

const REPLACEMENTS = [
  // rgba 旧红 → 雾峰雪红
  [/rgba\(\s*255,\s*91,\s*82\s*,/g, 'rgba(239, 68, 68,'],
  [/rgba\(\s*255,\s*123,\s*114\s*,/g, 'rgba(239, 68, 68,'],
  // 硬编码 hex 旧红 → 雾峰雪红（仅独立使用，不替换 var fallback 内的值）
  [/#ff5b52\b/gi, '#EF4444'],
  [/#ff4d4f\b/gi, '#EF4444'],
];

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      walk(p, out);
    } else if (name.endsWith('.wxss') || name.endsWith('.wxml') || name.endsWith('.js')) {
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
  let hits = 0;
  let out = src;
  for (const [re, to] of REPLACEMENTS) {
    out = out.replace(re, () => { hits++; return to; });
  }
  if (hits > 0) {
    fs.writeFileSync(f, out);
    totalEdits += hits;
    report.push({ file: rel, hits });
  }
}

console.log('=== LIVE 旧红色统一替换报告 ===');
console.log('扫描文件数:', files.length);
console.log('命中文件数:', report.length);
console.log('总替换次数:', totalEdits);
report.sort((a, b) => b.hits - a.hits);
for (const r of report) console.log(`  ${r.hits.toString().padStart(3)}  ${r.file}`);
