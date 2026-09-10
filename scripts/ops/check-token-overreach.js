// 颜色 token 化「越界替换」检测 / 修复工具
//
// 背景（2026-09-10）：颜色 token 化脚本把颜色关键字（如 `white`）做全局字符串
//   替换时，未排除「关键字作为其他标识符前缀」的情况 —— `white-space` 属性名被
//   替换成 `var(--td-bg-color-container)-space` → WXSS 编译报
//   `unexpected '('`，全项目 52 处、18 个文件受阻。
//
// 本工具检测此类「token 后面直接跟连字符+字母」的异常形态（正常 CSS 不会出现），
// 默认只报告（退出码 1，可接入检查流程）；传 --fix 才就地修复已知形态。
//
// 用法：
//   node scripts/ops/check-token-overreach.js          # 检测（只读）
//   node scripts/ops/check-token-overreach.js --fix    # 检测并修复
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const SKIP = new Set(['node_modules', 'miniprogram_npm', '.git', 'rollback', 'deliverables']);
const EXTS = /\.(wxss|wxml|js|json|wxs)$/i;

// 异常形态：var(--任意token) 后紧跟 -字母（正常用法后应跟 : ; ) , 空格 或 }）
// 用拼接构造匹配串，避免工具自身源码被自匹配（踩过一次）
const OVERREACH_RE = new RegExp('var\\(--[a-zA-Z0-9-]+\\)-[a-zA-Z]');

// 已知误伤 → 正确写法的修复映射
const FIXES = [
  ['var(--td-bg-color-container)' + '-space', 'white-space']
];

const DO_FIX = process.argv.indexOf('--fix') !== -1;
let hitFiles = 0;
let hitCount = 0;

// 剥离注释后再判定：注释里作为说明文字引用的污染串（如「原写成 var(--x)-space」）
// 不影响编译，不应计入命中——否则文档化本 BUG 的脚本自身会永久误报。
function stripComment(ln) {
  // JSDoc / 块注释续行（以 * 开头）整行视为注释（CSS 通配选择器 `* {` 不含本检测模式）
  if (/^\s*\*/.test(ln)) return '';
  let s = ln;
  const b = s.indexOf('/*');
  if (b >= 0) {
    const e = s.indexOf('*/', b);
    s = e >= 0 ? (s.slice(0, b) + s.slice(e + 2)) : s.slice(0, b);
  }
  const h = s.indexOf('<!--');
  if (h >= 0) s = s.slice(0, h);
  const l = s.indexOf('//');
  if (l >= 0) s = s.slice(0, l);
  return s;
}

function scan(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return; }
  for (const name of names) {
    if (SKIP.has(name)) continue;
    const p = path.join(dir, name);
    let st;
    try { st = fs.statSync(p); } catch (e) { continue; }
    if (st.isDirectory()) { scan(p); continue; }
    if (!EXTS.test(name)) continue;
    // 跳过本工具自身，防止自匹配
    if (name === 'check-token-overreach.js') continue;
    let src;
    try { src = fs.readFileSync(p, 'utf8'); } catch (e) { continue; }
    if (!OVERREACH_RE.test(src)) continue;
    const lines = src.split('\n');
    const bad = [];
    lines.forEach((ln, i) => {
      const code = stripComment(ln);
      if (OVERREACH_RE.test(code)) bad.push((i + 1) + ': ' + ln.trim().slice(0, 100));
    });
    if (!bad.length) continue;
    hitFiles++;
    hitCount += bad.length;
    const rel = p.replace(ROOT + path.sep, '').replace(/\\/g, '/');
    console.log('[越界替换] ' + rel);
    bad.forEach((b) => console.log('    ' + b));
    if (DO_FIX) {
      let next = src;
      FIXES.forEach((f) => { next = next.split(f[0]).join(f[1]); });
      if (next !== src) {
        fs.writeFileSync(p, next, 'utf8');
        console.log('    -> 已修复');
      }
    }
  }
}

scan(ROOT);
console.log('=== 命中文件 ' + hitFiles + ' 个，异常行 ' + hitCount + ' 处' + (DO_FIX ? '（已修复）' : '（只读检测，加 --fix 修复）') + ' ===');
if (hitCount > 0 && !DO_FIX) process.exit(1);
