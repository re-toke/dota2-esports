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
console.log('=== ① 越界替换：命中文件 ' + hitFiles + ' 个，异常行 ' + hitCount + ' 处' + (DO_FIX ? '（已修复）' : '（只读检测）') + ' ===');

// =====================================================================
// ② 文字对比度守卫（2026-09-20 新增）——「字体模糊看不清」防复发
//
// 背景：亮色主题下曾把**深色主题的浅色**当正文色用（`--text-muted #9bb0c9` = 2.22:1、
//   `--text-faint #c0c4cc` = 1.75:1、`--text-faint-2 #b9b9b9` = 1.96:1），共 9 处，
//   在首页/赛事页/详情页表现为「字体发虚、看不清」。
//
// 设计要点（**避免误报**，这三点缺一不可）：
//   · token 名**不携带"配什么背景"**的信息（如浅字配深底的 token），
//     故必须用**显式映射表**声明「token → 最低等级」；未列入者只提示、不判罚。
//   · 「占位/禁用」级 WCAG **豁免** → level:'disabled' 直接跳过。
//   · 大字（≥18pt 或 ≥14pt 粗体）只需 3:1 → level:'large'。
// 背景取值：项目文字实际落在两种底上（白卡 / 页面浅灰底），逐一校验。
// =====================================================================
const CONTRAST_BG = [
  { name: '白卡 #FFFFFF', hex: '#FFFFFF' },
  { name: '页底 #F8F9FA', hex: '#F8F9FA' }
];
// token → 最低等级：body 需 ≥4.5:1；large 需 ≥3:1；disabled 豁免（占位/禁用态）
const TEXT_TOKEN_RULES = [
  { token: '--text-1', level: 'body' },
  { token: '--text-2', level: 'body' },
  { token: '--text-3', level: 'body' },
  { token: '--text-4', level: 'disabled' },
  { token: '--text-muted', level: 'body' },
  { token: '--text-faint', level: 'body' },
  { token: '--text-faint-2', level: 'body' },
  { token: '--link', level: 'body' }
];
const LEVEL_MIN = { body: 4.5, large: 3, disabled: 0 };

function srgbLum(hex) {
  const c = String(hex).replace('#', '').trim();
  if (!/^[0-9a-fA-F]{6}$/.test(c)) return null;
  const ch = [0, 2, 4].map((i) => parseInt(c.substr(i, 2), 16) / 255)
    .map((x) => (x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)));
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
function contrastRatio(a, b) {
  const l1 = srgbLum(a), l2 = srgbLum(b);
  if (l1 == null || l2 == null) return null;
  const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

// 解析 app.wxss 的 token 表，并把 `var(--x)` 别名解析成最终色值（最多 5 跳）
function resolveTokens(css) {
  const raw = {};
  const re = /(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    const k = m[1];
    const v = m[2].trim();
    // 同一 token 若多处定义，以**最后**出现者为准（CSS 层叠语义），但不静默：
    if (raw[k] && raw[k] !== v) console.log('  ⚠ token 重复定义（后者生效）：' + k + '  ' + raw[k] + ' → ' + v);
    raw[k] = v;
  }
  const resolve = (name, depth) => {
    if (depth > 5) return null;
    const v = raw[name];
    if (!v) return null;
    const vm = v.match(/^var\(\s*(--[a-zA-Z0-9-]+)\s*\)$/);
    if (vm) return resolve(vm[1], depth + 1);
    return /^#[0-9a-fA-F]{6}$/.test(v) ? v : null;
  };
  return { raw, resolve };
}

let contrastChecked = 0;
let contrastFailed = 0;
const contrastProblems = [];
try {
  const appCss = fs.readFileSync(path.join(ROOT, 'app.wxss'), 'utf8');
  const { raw, resolve } = resolveTokens(appCss);
  console.log('=== ② 文字对比度（白卡 / 页底，WCAG AA）===');
  TEXT_TOKEN_RULES.forEach((rule) => {
    if (!raw[rule.token]) { console.log('  · 跳过（未定义）：' + rule.token); return; }
    const hex = resolve(rule.token);
    if (!hex) { console.log('  · 跳过（非纯色值）：' + rule.token + ' = ' + raw[rule.token]); return; }
    if (rule.level === 'disabled') { console.log('  · 豁免（占位/禁用）：' + rule.token + ' ' + hex); return; }
    const need = LEVEL_MIN[rule.level];
    contrastChecked++;
    const ratios = CONTRAST_BG.map((bg) => ({ bg: bg, r: contrastRatio(hex, bg.hex) }));
    const bad = ratios.filter((x) => x.r != null && x.r < need);
    console.log('  ' + (bad.length ? '✗' : '✓') + ' ' + rule.token + ' ' + hex + '  ' +
      ratios.map((x) => x.bg.name.replace('#', '') + ' ' + (x.r == null ? 'n/a' : x.r.toFixed(2) + ':1')).join('  ') +
      '  （最低 ' + need + ':1）');
    if (bad.length) {
      contrastFailed++;
      contrastProblems.push(rule.token + ' ' + hex + ' 在 ' + bad.map((x) => x.bg.name).join('/') +
        ' 仅 ' + Math.min.apply(null, bad.map((x) => x.r)).toFixed(2) + ':1，低于 ' + need + ':1');
    }
  });
  // 未列入映射表的 --text-* / --*-text 类 token → 提示（新 token 必须显式声明才能被守护）
  Object.keys(raw).filter((k) => /^--text(-[a-z0-9-]+)?$/.test(k) &&
    !TEXT_TOKEN_RULES.some((r) => r.token === k)).forEach((k) => {
    console.log('  ℹ 未纳入对比度守护（请按需加入 TEXT_TOKEN_RULES 的映射表）：' + k + ' = ' + raw[k]);
  });
} catch (e) {
  console.log('[对比度守卫] 跳过：' + e.message);
}
if (contrastProblems.length) {
  console.log('--- 对比度不合格明细 ---');
  contrastProblems.forEach((p) => console.log('    ' + p));
  console.log('    ⇒ 修法：改用 --text-3（#6B7280, 4.83:1）；亮色底上**没有**比它更浅且仍达标的正文色，');
  console.log('      需要更弱的层级请用字号/字重表达，不要调浅颜色。');
}

console.log('=== 汇总：越界替换 ' + hitCount + ' 处；对比度检查 ' + contrastChecked + ' 项，不合格 ' + contrastFailed + ' 项 ===');
if ((hitCount > 0 && !DO_FIX) || contrastFailed > 0) process.exit(1);
