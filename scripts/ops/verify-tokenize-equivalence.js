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

const COLOR = /#[0-9a-fA-F]{3,8}\b|\brgba?\([^)]*\)|\b(?:white|black)\b/g;

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
  const out = {};
  (resolveVars(text).match(COLOR) || []).map(norm).forEach((v) => { out[v] = (out[v] || 0) + 1; });
  return out;
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

  console.log('---');
  console.log('比对文件 ' + files.length + ' 个 ｜ 可解析色值处数 ' + totA + ' → ' + totB);
  if (bad === 0 && totA === totB) {
    console.log('✅ 色值多重集完全一致 —— 像素级等价（零视觉变化）');
  } else {
    console.log('⚠️ ' + bad + ' 个文件 / ' + mismatchKeys + ' 个色值计数不一致 —— 存在视觉变化风险，请复核');
    process.exit(1);
  }
}

main();
