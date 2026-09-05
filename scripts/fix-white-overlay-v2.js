/* eslint-disable */
// 雾峰雪 v2.0 · 暗色系遗留高透明白色叠层清理
// 暗色主题下用 rgba(255,255,255,0.0X) 作分割线/边框/悬浮态，亮色白底上完全不可见。
// 替换策略：
//   background rgba(255,255,255,0.02~0.08) → rgba(0,0,0,0.02~0.04)（轻微暗化叠层）
//   border rgba(255,255,255,0.04~0.10) → #E5E7EB 或 rgba(0,0,0,0.06)
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', 'miniprogram_npm', '.git', 'scripts', 'cloudfunctions', 'utils']);

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
  let hits = 0;
  let out = src;

  // background: rgba(255,255,255,0.02~0.08) → rgba(0,0,0,对应值减半)
  out = out.replace(
    /background:\s*rgba\(255,\s*255,\s*255,\s*0\.0([2-9])\)/g,
    (m, alpha) => {
      hits++;
      const newAlpha = Math.max(2, Math.floor(parseInt(alpha) / 2));
      return `background: rgba(0, 0, 0, 0.0${newAlpha})`;
    }
  );

  // border: ... rgba(255,255,255,0.04~0.10) → #E5E7EB
  out = out.replace(
    /rgba\(255,\s*255,\s*255,\s*0\.0[4-9]\)|rgba\(255,\s*255,\s*255,\s*0\.10\)/g,
    (m) => {
      hits++;
      return '#E5E7EB';
    }
  );
  // 还剩 rgba(255,255,255,0.02~0.03)（非 background 场景的 border）
  out = out.replace(
    /rgba\(255,\s*255,\s*255,\s*0\.0[1-3]\)/g,
    (m) => {
      hits++;
      return 'rgba(0, 0, 0, 0.05)';
    }
  );

  if (hits > 0) {
    fs.writeFileSync(f, out);
    totalEdits += hits;
    report.push({ file: rel, hits });
  }
}

console.log('=== 高透明白色叠层清理报告 ===');
console.log('扫描 wxss 数:', files.length);
console.log('命中文件数:', report.length);
console.log('总替换次数:', totalEdits);
report.sort((a, b) => b.hits - a.hits);
for (const r of report) console.log(`  ${r.hits.toString().padStart(3)}  ${r.file}`);
