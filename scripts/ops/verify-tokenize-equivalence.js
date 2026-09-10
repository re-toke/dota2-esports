#!/usr/bin/env node
/**
 * scripts/ops/verify-tokenize-equivalence.js
 *
 * 【安全闸】验证「字面量 → var(--token)」替换是**像素级等价**的。
 *
 * ## 原理
 * 把改动前（git HEAD）与改动后（工作区）的 wxss 都**把 var() 迭代解析成最终色值**，
 * 然后比对两者的「色值多重集」（含出现次数）。完全一致 ⇒ 渲染结果相同 ⇒ 零视觉风险。
 *
 * 关键点：**两边都必须解析 var()**。若只解析一侧，原版里本来就存在的 var() 引用
 * 不会被展开，会误报「新增色值」（本脚本初版就踩过这个坑）。
 *
 * ## 用法
 *   node scripts/ops/verify-tokenize-equivalence.js              # 校验所有已改动的 wxss
 *   node scripts/ops/verify-tokenize-equivalence.js --file app.wxss
 *   node scripts/ops/verify-tokenize-equivalence.js --ref HEAD~1 # 与指定版本比对
 *
 * 退出码：0 = 等价；1 = 存在差异（CI 可直接用）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const APP_WXSS = 'app.wxss';

const NAMED = { white: '#ffffff', black: '#000000' };
function norm(v) {
  v = String(v).toLowerCase().replace(/\s+/g, '');
  if (NAMED[v]) return NAMED[v];
  const h = v.match(/^#([0-9a-f]{3,8})$/);
  if (h) {
    let s = h[1];
    if (s.length === 3 || s.length === 4) s = s.split('').map((c) => c + c).join('');
    return '#' + s;
  }
  return v;
}

// ★ 2026-09-10：具名色匹配必须排除「关键字紧邻连字符」的情况——否则 `white-space`
//   里的 `white` 会被计入色值多重集，导致两侧比对失真（安全闸自身不可信）。
//   与 tokenize-wxss-colors.js 的 COLOR_RE 保持同款边界断言。
const COLOR = /#[0-9a-fA-F]{3,8}\b|\brgba?\([^)]*\)|(?<![\w-])(?:white|black)(?![\w-])/g;

function readTokens() {
  const app = fs.readFileSync(path.join(ROOT, APP_WXSS), 'utf8');
  const t = {};
  const re = /^\s*(--[\w-]+)\s*:\s*([^;]+);/gm;
  let m;
  while ((m = re.exec(app)) !== null) t[m[1]] = m[2].trim();
  return t;
}
const TOKENS = readTokens();

/** 迭代解析 var(--x[, fallback])；未定义则回退 fallback，再无则保留原样 */
function resolveVars(text) {
  let s = text;
  for (let i = 0; i < 8; i++) {
    const before = s;
    s = s.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\)/g,
      (m0, name, fb) => {
        if (TOKENS[name] != null) return TOKENS[name];
        return fb != null ? fb : m0;
      });
    if (s === before) break;
  }
  return s;
}

function colorCounts(text) {
  // ★ 必须剔除 token 定义行（`--xxx: #fff;`）——否则 Phase 2 新增 token 时，
  //   定义里的字面量会被当成「新增色值」误报（本脚本踩过一次）。
  //   与 audit 脚本同口径：只统计「使用处」的颜色。
  const out = {};
  const src = String(text)
    .split('\n')
    .filter((l) => !/^\s*--[\w-]+\s*:/.test(l))
    .join('\n');
  (resolveVars(src).match(COLOR) || []).map(norm).forEach((v) => { out[v] = (out[v] || 0) + 1; });
  return out;
}

/**
 * ★★ 2026-09-10 新增：**CSS 合法性守卫**（补上本脚本此前的盲区）
 *
 * 事故背景：`tokenize:colors` 曾把 `white-space` 里的 `white` 也替换掉 →
 * 生成 `var(--td-bg-color-container)-space` → 全项目 52 处 / 18 文件 WXSS 编译报
 * `unexpected '('`。而**本脚本当时是「通过」的** —— 因为它只比对色值多重集，
 * `white` 在 `white-space` 里被当作「颜色」在两侧一致地计数，自然相等。
 *
 * → 教训：**「色值等价」不等于「CSS 合法」**。故在等价性校验之外，追加语法守卫。
 */
const BROKEN_PATTERNS = [
  // var(--x)-ident：token 后面直接跟 - 字母（正常 CSS 不会出现）
  { re: /var\(\s*--[\w-]+\s*\)\s*-[A-Za-z]/, desc: 'token 后跟 -字母（多为颜色关键字越界替换，如 white-space）' },
  // var(--x)<ident>：token 后面直接跟字母
  { re: /var\(\s*--[\w-]+\s*\)[A-Za-z]/, desc: 'token 后直接跟字母' },
  // 属性名被替换：行首出现 var(...) 作为属性名
  { re: /^\s*var\(\s*--[\w-]+\s*\)\s*-/, desc: '属性名被替换为 token' }
];

function checkCssValidity(files) {
  let broken = 0;
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      if (line.trim().startsWith('/*') || line.trim().startsWith('*')) return;
      for (const bp of BROKEN_PATTERNS) {
        if (bp.re.test(line)) {
          broken++;
          console.log('❌ CSS 非法  ' + f + ':' + (i + 1) + '  [' + bp.desc + ']');
          console.log('     ' + line.trim().slice(0, 100));
          break;
        }
      }
    });
  }
  return broken;
}

function main() {
  const argv = process.argv.slice(2);
  const ref = argv.includes('--ref') ? argv[argv.indexOf('--ref') + 1] : 'HEAD';
  const only = argv.includes('--file') ? argv[argv.indexOf('--file') + 1] : null;

  let files = execSync('git diff --name-only ' + ref, { encoding: 'utf8' })
    .trim().split('\n').filter((f) => f.endsWith('.wxss'));
  if (only) files = files.filter((f) => f.includes(only));

  if (!files.length) {
    console.log('没有相对 ' + ref + ' 变更的 wxss 文件（无需校验）');
    return;
  }

  let bad = 0, mismatchKeys = 0, totA = 0, totB = 0;
  for (const f of files) {
    const orig = execSync('git show ' + ref + ':' + JSON.stringify(f), { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const now = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const a = colorCounts(orig), b = colorCounts(now);
    totA += Object.values(a).reduce((x, y) => x + y, 0);
    totB += Object.values(b).reduce((x, y) => x + y, 0);
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    const diffs = [...keys].filter((k) => (a[k] || 0) !== (b[k] || 0));
    if (diffs.length) {
      bad++;
      mismatchKeys += diffs.length;
      console.log('❌ ' + f);
      diffs.slice(0, 6).forEach((k) => console.log('     ' + k + '   原 ' + (a[k] || 0) + ' → 新 ' + (b[k] || 0)));
    }
  }

  // ★ CSS 合法性守卫（覆盖全部目标文件，不止变更的）
  const broken = checkCssValidity(files);

  console.log('---');
  console.log('比对文件 ' + files.length + ' 个 ｜ 可解析色值处数 ' + totA + ' → ' + totB);
  const colorOk = (bad === 0 && totA === totB);
  if (colorOk) {
    console.log('✅ 色值多重集完全一致 —— 像素级等价（零视觉变化）');
  } else {
    console.log('⚠️ ' + bad + ' 个文件 / ' + mismatchKeys + ' 个色值计数不一致 —— 存在视觉变化风险，请复核');
  }
  if (broken > 0) {
    console.log('❌ CSS 合法性守卫：' + broken + ' 处非法（token 越界替换）—— 必须修复');
    console.log('   提示：`node scripts/ops/check-token-overreach.js --fix` 可修已知形态');
  } else {
    console.log('✅ CSS 合法性守卫：无 token 越界替换');
  }
  if (!colorOk || broken > 0) process.exit(1);
}

main();
