#!/usr/bin/env node
/**
 * scripts/ops/audit-wxss-colors.js
 *
 * 审计 wxss 中的**硬编码颜色**，为「token 化」提供清单与进度基线。
 *
 * 背景：暗色模式 v1.2 专项的前置是「所有颜色走 var() token」。
 *   手工 grep 无法区分「token 定义处的字面量」（正常，必须保留）与
 *   「组件里的硬编码色」（要替换），也无法按风险分级。
 *
 * 用法：
 *   node scripts/ops/audit-wxss-colors.js              # 汇总 + 按文件排行
 *   node scripts/ops/audit-wxss-colors.js --list       # 逐条列出（file:line 色值）
 *   node scripts/ops/audit-wxss-colors.js --file <f>   # 只看某文件
 *   node scripts/ops/audit-wxss-colors.js --json       # 机器可读
 *
 * 分级（对齐「主题翻转八大陷阱」）：
 *   P0 浅文字色/近白 —— 亮底上不可读，暗色模式下同样会糊（如 #e6ebf2 / #fff 当文字）
 *   P1 近黑 hex / 高 alpha 黑 rgba —— 暗色模式下会变成黑底黑字
 *   P2 其他硬编码语义色（灰阶、品牌色、状态色）
 *   P3 结构性（阴影/遮罩 alpha 黑、transparent）—— 多数可保留
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const SKIP = /(^|[\\/])(node_modules|miniprogram_npm|admin|deliverables|\.git|dist)([\\/]|$)/;
const APP_WXSS = 'app.wxss';   // token 定义处：其中的字面量属「定义」不算「硬编码使用」

function walk(dir, out) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (SKIP.test(p)) continue;
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.wxss')) out.push(p);
  }
}

// 颜色匹配：hex / rgb() / rgba() / 常见具名色
// ★ 2026-09-10：具名色匹配加标识符边界断言（`white-space` 的 white 不得计入色值，
//   同理 `.is-white` 等类名）。与 tokenize/verify 两处 COLOR_RE 保持同款口径。
const RE = /#[0-9a-fA-F]{3,8}\b|\brgba?\([^)]*\)|(?<![\w-])(?:white|black|red|blue|green|gray|grey|silver|orange|yellow|purple|pink|brown|cyan|magenta|lime|navy|teal|olive|maroon|aqua|fuchsia)(?![\w-])/g;

/**
 * 判断下标是否落在 var(...) 内部。
 * ★ 必须排除：`var(--defined, #fallback)` 里的 fallback **不参与渲染**
 *   （外层 token 已定义时以 token 为准），不算「待 token 化」。
 *   只有外层 token **未定义** 时 fallback 才生效 —— 那种情况由 tokenize 脚本整体替换。
 */
function insideVarSpan(line, idx) {
  let depth = 0;
  for (let i = 0; i < idx; i++) {
    if (line.startsWith('var(', i)) { depth++; i += 3; }
    else if (line[i] === '(' && depth > 0) depth++;
    else if (line[i] === ')' && depth > 0) depth--;
  }
  return depth > 0;
}

function classify(value, lineText) {
  const v = value.toLowerCase();
  // P0：浅色（近白/浅灰）—— 若用于文字或近白背景
  const hex = v.startsWith('#') ? v.slice(1) : null;
  let r = null, g = null, b = null, a = 1;
  if (hex) {
    let h = hex;
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    if (h.length >= 6) {
      r = parseInt(h.slice(0, 2), 16); g = parseInt(h.slice(2, 4), 16); b = parseInt(h.slice(4, 6), 16);
      if (h.length === 8) a = parseInt(h.slice(6, 8), 16) / 255;
    }
  } else {
    const m = v.match(/rgba?\(([^)]*)\)/);
    if (m) {
      const parts = m[1].split(',').map((s) => parseFloat(s.trim()));
      r = parts[0]; g = parts[1]; b = parts[2];
      if (parts.length > 3) a = parts[3];
    } else if (/^(white|silver)$/.test(v)) { r = g = b = 255; }
    else if (/^black$/.test(v)) { r = g = b = 0; }
  }

  const lum = (r != null) ? (0.299 * r + 0.587 * g + 0.114 * b) : null;
  const isTextProp = /(^|[;{\s])(color|background|background-color)\s*:/.test(lineText);
  const textOnly = /(^|[;{\s])color\s*:/.test(lineText) && !/background/.test(lineText);

  // P0：浅色当文字色（亮底不可读 / 暗底也可能糊），或近白背景
  if (lum != null && lum > 200) {
    if (textOnly) return 'P0';       // 浅色文字 —— 八大陷阱 #8
    return 'P0';                      // 近白背景/边框也归 P0（暗色模式必改）
  }
  // P1：近黑（<50 亮度）非透明 —— 暗色模式黑底黑字
  if (lum != null && lum < 50 && a >= 0.5) return 'P1';
  // P3：低 alpha 黑/白（阴影、遮罩）—— 多数可保留
  if (a < 0.3) return 'P3';
  // P2：其余语义色
  return isTextProp ? 'P2' : 'P2';
}

function scan() {
  const files = [];
  walk(ROOT, files);
  const results = [];
  for (const f of files) {
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    const isApp = rel === APP_WXSS;
    const src = fs.readFileSync(f, 'utf8');
    const lines = src.split('\n');
    // app.wxss 的 :root/token 块内定义为「定义」，其余为「使用」
    let inTokenBlock = false;
    let inComment = false;   // ★ 跨行块注释跟踪（原实现只跳过行首 /* *，块内普通行会被误计）
    lines.forEach((line, i) => {
      const t = line.trim();
      if (inComment) {
        if (t.includes('*/')) inComment = false;
        return;
      }
      if (t.startsWith('/*')) {
        if (!t.includes('*/')) inComment = true;
        return;
      }
      if (t.startsWith('*') || t.startsWith('//')) return;
      if (isApp && /^(:root|\s*--|\s*page\s*\{)/.test(t)) inTokenBlock = true;
      if (isApp && /^\}/.test(t) && inTokenBlock) inTokenBlock = false;
      // 跳过 token 定义行（--xxx: #fff;）
      const isTokenDef = /^\s*--[\w-]+\s*:/.test(line);
      const matches = line.match(RE);
      if (!matches) return;
      // 逐个定位以判断是否落在 var() 内
      const re2 = new RegExp(RE.source, 'g');
      let mm;
      while ((mm = re2.exec(line)) !== null) {
        if (insideVarSpan(line, mm.index)) continue;   // var() 内的 fallback：不参与渲染
        if (isTokenDef) continue;                       // token 定义处
        if (isApp && inTokenBlock) continue;            // app.wxss 的 token 块
        results.push({
          file: rel, line: i + 1, value: mm[0],
          level: classify(mm[0], t),
          text: t.slice(0, 110)
        });
      }
    });
  }
  return results;
}

function main() {
  const argv = process.argv.slice(2);
  const rows = scan();

  if (argv.includes('--json')) {
    process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
    return;
  }

  const fileFilter = argv.includes('--file') ? argv[argv.indexOf('--file') + 1] : null;
  const shown = fileFilter ? rows.filter((r) => r.file.includes(fileFilter)) : rows;

  if (argv.includes('--list')) {
    for (const r of shown) console.log(r.level + '  ' + r.file + ':' + r.line + '  ' + r.value + '   | ' + r.text);
    console.log('\n合计 ' + shown.length + ' 处');
    return;
  }

  // 按文件汇总
  const byFile = {};
  shown.forEach((r) => {
    if (!byFile[r.file]) byFile[r.file] = { P0: 0, P1: 0, P2: 0, P3: 0, total: 0 };
    byFile[r.file][r.level]++;
    byFile[r.file].total++;
  });

  console.log('=== wxss 硬编码颜色审计（已排除 token 定义处的字面量）===\n');
  const order = Object.keys(byFile).sort((a, b) => byFile[b].total - byFile[a].total);
  console.log('文件'.padEnd(52) + 'P0   P1   P2   P3   合计');
  console.log('-'.repeat(80));
  for (const f of order) {
    const v = byFile[f];
    console.log(f.padEnd(52) + String(v.P0).padEnd(5) + String(v.P1).padEnd(5) + String(v.P2).padEnd(5) + String(v.P3).padEnd(5) + v.total);
  }

  const tot = shown.reduce((a, r) => { a[r.level]++; a.all++; return a; }, { P0: 0, P1: 0, P2: 0, P3: 0, all: 0 });
  console.log('-'.repeat(80));
  console.log(('合计（' + order.length + ' 文件）').padEnd(52) + String(tot.P0).padEnd(5) + String(tot.P1).padEnd(5) + String(tot.P2).padEnd(5) + String(tot.P3).padEnd(5) + tot.all);
  console.log('\nP0 = 浅文字色/近白（亮底不可读，暗色也糊）—— 优先处理');
  console.log('P1 = 近黑 hex / 高 alpha 黑 rgba（暗色模式黑底黑字）');
  console.log('P2 = 其他硬编码语义色（灰阶/品牌/状态）');
  console.log('P3 = 低 alpha 阴影/遮罩（多数可保留）');

  // 高频色值 TOP
  const freq = {};
  shown.forEach((r) => { const k = r.value.toLowerCase(); freq[k] = (freq[k] || 0) + 1; });
  const top = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 15);
  console.log('\n=== 高频色值 TOP15（替换优先做这些覆盖面最大）===');
  top.forEach(([v, n]) => console.log('  ' + v.padEnd(26) + n + ' 处'));
}

main();
