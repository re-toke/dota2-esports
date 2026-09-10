#!/usr/bin/env node
/**
 * scripts/ops/tokenize-wxss-colors.js
 *
 * 把 wxss 中的硬编码颜色替换为 var(--token)，为暗色模式 v1.2 专项打底。
 *
 * ## 安全保证（核心设计）
 * 脚本**只允许**把字面量映射到「值完全相等」的 token —— 每次替换前断言
 * `tokenValue === literalValue`（十六进制展开后逐字符比较）。值不等则**拒绝替换并报告**，
 * 因此本脚本**不可能引入视觉变化**（对亮色主题而言像素级等价）。
 *
 * ## 属性语义优先（而非「随便挑个同值 token」）
 * 同一色值常对应多个 token（如 #E5E7EB 同时是 --td-border-level-1-color 与
 * --td-bg-color-component-active）。暗色模式下它们会**分叉**，所以必须按 CSS 属性选：
 *   border* / outline*  → 边框语义 token
 *   background*         → 背景语义 token
 *   color               → 文字语义 token
 *   box-shadow          → 阴影语义 token
 *   fallback            → 该值的「主 token」
 *
 * ## 用法
 *   node scripts/ops/tokenize-wxss-colors.js              # 干跑：只报告，不改文件
 *   node scripts/ops/tokenize-wxss-colors.js --apply      # 实际写入
 *   node scripts/ops/tokenize-wxss-colors.js --file pages/leagues/leagues.wxss --apply
 *   node scripts/ops/tokenize-wxss-colors.js --verbose    # 逐条列出替换
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const SKIP = /(^|[\\/])(node_modules|miniprogram_npm|admin|deliverables|\.git|dist)([\\/]|$)/;
const APP_WXSS = 'app.wxss';   // token 定义处：不替换（只在其下方追加新 token）

// ===== 颜色值规范化（#fff → #ffffff；white → #ffffff）=====
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

/**
 * 映射表：#值 → { border, bg, text, shadow, fallback }
 * 只列**已有精确同值 token** 的值；未列出的值不动（留给 Phase 2 新增 token）。
 * 每个 token 的实际值由 app.wxss 读出并断言相等。
 */
const MAP = {
  '#e5e7eb': { border: '--td-border-level-1-color', bg: '--td-bg-color-component-active', fallback: '--td-border-level-1-color' },
  '#f1f3f5': { bg: '--td-bg-color-component', border: '--td-bg-color-component', fallback: '--td-bg-color-component' },
  '#ffffff': { bg: '--td-bg-color-container', text: '--td-bg-color-container', border: '--td-bg-color-container', shadow: '--td-bg-color-container', fallback: '--td-bg-color-container' },
  '#f8f9fa': { bg: '--td-bg-color-page', border: '--td-bg-color-page', fallback: '--td-bg-color-page' },
  '#c8a951': { bg: '--dota-gold', text: '--dota-gold', border: '--dota-gold', shadow: '--dota-gold', fallback: '--dota-gold' },
  '#fdf6e3': { bg: '--dota-gold-soft', fallback: '--dota-gold-soft' },
  '#1f2937': { text: '--text-1', bg: '--text-1', fallback: '--text-1' },
  '#4b5563': { text: '--text-2', fallback: '--text-2' },
  '#6b7280': { text: '--text-3', fallback: '--text-3' },
  '#9ca3af': { text: '--text-4', fallback: '--text-4' },
  '#d1d5db': { border: '--td-component-border', bg: '--td-component-border', fallback: '--td-component-border' },
  '#5fd35f': { bg: '--radiant', text: '--radiant', border: '--radiant', fallback: '--radiant' },
  '#e8443b': { text: '--dire', bg: '--dire', border: '--dire', fallback: '--dire' },
  '#ef4444': { text: '--status-live', bg: '--status-live', border: '--status-live', fallback: '--status-live' },
  '#f0aa28': { text: '--status-upcoming', bg: '--status-upcoming', fallback: '--status-upcoming' },
  '#2dd4a7': { text: '--h2h-a', bg: '--h2h-a', fallback: '--h2h-a' },
  '#f25c54': { text: '--h2h-b', bg: '--h2h-b', fallback: '--h2h-b' },
  '#3b82f6': { bg: '--tier-b', text: '--tier-b', fallback: '--tier-b' },
  '#5fd3a8': { text: '--status-verified', bg: '--status-verified', fallback: '--status-verified' },
  '#eef0fb': { bg: '--tier-a-soft', fallback: '--tier-a-soft' },
  '#ebf4fe': { bg: '--tier-b-soft', fallback: '--tier-b-soft' },
  '#f1f5f9': { bg: '--tier-c-soft', fallback: '--tier-c-soft' },
  // 以下 4 项为干跑后发现「已有同值 token 但未收录」补入的
  // ⚠️ 注意 #ffcf5c 与 #9bb0c9 **故意不收录**：
  //   · #ffcf5c 虽等于 --source-liquipedia，但实际被用作**通用琥珀**（match-flow 即将到来
  //     分隔条 / league-detail quality-medium 圆点 / series-recent 左边框）→ 映射过去语义错位。
  //   · #9bb0c9 虽等于 --source-curation，但主要用作**弱化次要文字色**（date-range /
  //     focus-date / h2h 文案）→ 同样错位。
  //   两者留到 Phase 2 新增语义正确的 token（如 --amber-bright / --text-muted）。
  'rgba(95,211,95,0.12)': { bg: '--radiant-soft', fallback: '--radiant-soft' },
  'rgba(45,212,167,0.14)': { bg: '--h2h-a-soft', fallback: '--h2h-a-soft' },
  'rgba(242,92,84,0.14)': { bg: '--h2h-b-soft', fallback: '--h2h-b-soft' },
  'rgba(232,68,59,0.18)': { bg: '--td-error-color-light-active', fallback: '--td-error-color-light-active' },
  // ── Phase 2（2026-09-10）：新增语义 token 后补入 ──
  // ① 黑 tint → overlay 档位（暗色主题需翻转为白色微透）
  'rgba(0,0,0,0.02)': { bg: '--overlay-02', fallback: '--overlay-02' },
  'rgba(0,0,0,0.03)': { bg: '--overlay-03', fallback: '--overlay-03' },
  'rgba(0,0,0,0.04)': { bg: '--overlay-04', fallback: '--overlay-04' },
  'rgba(0,0,0,0.05)': { bg: '--overlay-05', fallback: '--overlay-05' },
  'rgba(0,0,0,0.06)': { bg: '--overlay-06', fallback: '--overlay-06' },
  'rgba(0,0,0,0.08)': { bg: '--overlay-08', fallback: '--overlay-08' },
  'rgba(0,0,0,0.12)': { bg: '--overlay-12', fallback: '--overlay-12' },
  'rgba(0,0,0,0.40)': { bg: '--scrim-40', fallback: '--scrim-40' },
  'rgba(0,0,0,0.4)': { bg: '--scrim-40', fallback: '--scrim-40' },
  // ② 不透明语义色（≥2 处复用）
  '#ffcf5c': { text: '--amber-bright', bg: '--amber-bright', border: '--amber-bright', fallback: '--amber-bright' },
  '#9bb0c9': { text: '--text-muted', fallback: '--text-muted' },
  '#5b9bff': { text: '--link', fallback: '--link' },
  '#3a4250': { text: '--slate-deep', border: '--slate-deep', fallback: '--slate-deep' },
  '#4a525d': { text: '--slate-text', fallback: '--slate-text' },
  '#5a6068': { bg: '--slate-bar', fallback: '--slate-bar' },
  '#c0c4cc': { text: '--text-faint', fallback: '--text-faint' },
  '#b9b9b9': { text: '--text-faint-2', fallback: '--text-faint-2' },
  '#e0533d': { text: '--status-worst', bg: '--status-worst', fallback: '--status-worst' },
  '#e74c3c': { text: '--status-negative', bg: '--status-negative', fallback: '--status-negative' },
  '#7a6520': { text: '--tier-s-text', fallback: '--tier-s-text' },
  '#3730a3': { text: '--tier-a-text', fallback: '--tier-a-text' },
  '#1e40af': { text: '--tier-b-text', fallback: '--tier-b-text' },
  '#374151': { text: '--tier-c-text', fallback: '--tier-c-text' }
};

// ===== 读 token 值表 =====
function readTokens() {
  const app = fs.readFileSync(path.join(ROOT, APP_WXSS), 'utf8');
  const map = {};
  const re = /^\s*(--[\w-]+)\s*:\s*([^;]+);/gm;
  let m;
  while ((m = re.exec(app)) !== null) map[m[1]] = m[2].trim();
  return map;
}

/** 从行文本推断属性语义通道（决定同值多 token 时选哪个） */
function channelOf(lineText, matchIndex) {
  const before = lineText.slice(0, matchIndex);
  const prop = (before.match(/([a-z-]+)\s*:\s*[^:;]*$/) || [])[1] || '';
  if (/^(border|outline|column-rule)(-|$)/.test(prop)) return 'border';
  if (/^background/.test(prop)) return 'bg';
  if (prop === 'color' || /^text-decoration/.test(prop)) return 'text';
  if (/^(box-shadow|text-shadow)$/.test(prop)) return 'shadow';
  return 'fallback';
}

// ★★ 2026-09-10 根因修复：具名色 `white`/`black` 必须做**标识符边界**判断。
//   原用 `\b(?:white|black)\b` —— 但 `-` 是词边界字符，于是 `white-space` 里的 `white`
//   也被匹配 → 替换成 `var(--td-bg-color-container)-space` → 全项目 52 处 / 18 个文件
//   WXSS 编译报 `unexpected '('`（app.wxss 阻断编译）。教训：**CSS 属性名里可能包含
//   颜色关键字**，`\b` 挡不住「关键字 + 连字符」的组合；
//   同理 `.is-white` 的 white 前面是 `-`，`\b` 也成立 → 类名会被破坏。
//   双层防护：
//     ① 正则层（本行）：前后用 `(?<![\w-])` / `(?![\w-])` 排除紧邻连字符/单词字符的情况
//        —— CSS 中颜色关键字作为独立值使用时，前后必为空白 / 逗号 / 分号 / 括号边界；
//     ② 代码层：`isBareNamedColor()` 在替换前二次拦截（见下方调用点）。
const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|\brgba?\([^)]*\)|(?<![\w-])(?:white|black)(?![\w-])/g;
const IDENT_CHAR = /[A-Za-z0-9_-]/;

/** 具名色守卫：排除 `white-space` / `black-list` 这类「关键字作为标识符前缀/后缀」 */
function isBareNamedColor(line, idx, lit) {
  if (lit !== 'white' && lit !== 'black') return true;   // 仅具名色需要判断
  const before = idx > 0 ? line[idx - 1] : '';
  const after = line[idx + lit.length] || '';
  if (before && IDENT_CHAR.test(before)) return false;
  if (after && IDENT_CHAR.test(after)) return false;
  return true;
}

/** 判断某下标是否落在 var(...) 内部（避免把 fallback 替换成嵌套 var） */
function insideVarSpan(line, idx) {
  let depth = 0;
  for (let i = 0; i < idx; i++) {
    if (line.startsWith('var(', i)) { depth++; i += 3; }
    else if (line[i] === '(' && depth > 0) depth++;
    else if (line[i] === ')' && depth > 0) depth--;
  }
  return depth > 0;
}

/** 选出该色值在给定属性通道下应使用的 token 名（值必须相等，否则返回 null） */
function pickToken(lit, line, idx, tokens) {
  const key = norm(lit);
  const entry = MAP[key];
  if (!entry) return { tokenName: null, reason: '映射表未收录' };
  const ch = channelOf(line, idx);
  const tokenName = entry[ch] || entry.fallback;
  const tokenVal = tokens[tokenName];
  if (!tokenVal) return { tokenName: null, reason: 'token 未定义' };
  // ★★ 安全断言：值必须完全相等，否则拒绝
  if (norm(tokenVal) !== key) return { tokenName: null, reason: '值不等 ' + norm(tokenVal) + ' ≠ ' + key };
  return { tokenName: tokenName, reason: null };
}

function processFile(file, tokens, apply, verbose) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  // app.wxss 也处理 —— 它除 token 定义外还有真实组件样式（.tag-* / .title 等）。
  // token 定义行（`--xxx: #fff;`）在下方逐行守卫中跳过，不会自毁 token 表。

  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split('\n');
  const skipped = [];
  const refused = [];
  let changed = 0;

  const outLines = lines.map((line) => {
    const t = line.trim();
    if (t.startsWith('/*') || t.startsWith('*') || t.startsWith('//')) return line;
    if (/^\s*--[\w-]+\s*:/.test(line)) return line;   // token 定义行

    // ── 步骤 A：处理 `var(--未定义, #色)` 构造 ──
    // 外层名未定义时该构造恒等于 fallback，故整体替换为语义 token（比留嵌套 var 干净）。
    // 外层名已定义则不动（否则会改变优先级行为）。
    let cur = line.replace(/var\(\s*(--[\w-]+)\s*,\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|(?:white|black)(?![\w-]))\s*\)/g,
      (full, outer, fb) => {
        if (tokens[outer]) return full;                  // 外层已定义 → 保留原样
        const at = line.indexOf(full);
        if (!isBareNamedColor(line, at, fb)) return full;   // ★ 具名色守卫
        const pick = pickToken(fb, line, at, tokens);
        if (!pick.tokenName) {
          refused.push({ lit: fb, tokenName: outer, reason: '构造内 fallback 不可映射(' + pick.reason + ')' });
          return full;
        }
        changed++;
        if (verbose) console.log('    ' + rel + '  var(' + outer + ', ' + fb + ') → var(' + pick.tokenName + ')');
        return 'var(' + pick.tokenName + ')';
      });

    // ── 步骤 B：替换其余独立色值（跳过 var() 内部）──
    let result = '';
    let last = 0;
    COLOR_RE.lastIndex = 0;
    let m;
    while ((m = COLOR_RE.exec(cur)) !== null) {
      if (insideVarSpan(cur, m.index)) continue;         // var() 内部的 fallback 不动
      if (!isBareNamedColor(cur, m.index, m[0])) continue;  // ★ 具名色守卫（防 `white-space`）
      const pick = pickToken(m[0], cur, m.index, tokens);
      if (!pick.tokenName) {
        (pick.reason === '映射表未收录' ? skipped : refused).push({ lit: m[0], tokenName: null, reason: pick.reason });
        continue;
      }
      result += cur.slice(last, m.index) + 'var(' + pick.tokenName + ')';
      last = m.index + m[0].length;
      changed++;
      if (verbose) console.log('    ' + rel + '  ' + m[0] + ' → var(' + pick.tokenName + ')');
    }
    if (!result) return cur;
    return result + cur.slice(last);
  });

  if (apply && changed) fs.writeFileSync(file, outLines.join('\n'), 'utf8');
  return { rel, changed, skipped, refused };
}

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

function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const verbose = argv.includes('--verbose');
  const only = argv.includes('--file') ? argv[argv.indexOf('--file') + 1] : null;

  const tokens = readTokens();
  const files = [];
  walk(ROOT, files);
  const targets = only ? files.filter((f) => f.replace(/\\/g, '/').includes(only)) : files;

  console.log('=== wxss 字面量 → token 替换' + (apply ? '（写入模式）' : '（干跑，不改文件）') + ' ===\n');
  let total = 0;
  const refusedAll = [];
  const skippedAll = [];
  const rows = [];
  for (const f of targets) {
    const r = processFile(f, tokens, apply, verbose);
    if (r.changed) rows.push(r);
    total += r.changed;
    r.refused.forEach((x) => refusedAll.push(Object.assign({ file: r.rel }, x)));
    r.skipped.forEach((x) => skippedAll.push(Object.assign({ file: r.rel }, x)));
  }
  rows.sort((a, b) => b.changed - a.changed).forEach((r) => console.log('  ' + r.rel.padEnd(52) + r.changed + ' 处'));

  console.log('\n替换合计: ' + total + ' 处');
  if (refusedAll.length) {
    console.log('\n⚠️ 被拒绝（值不等，未替换）: ' + refusedAll.length + ' 处');
    const uniq = {};
    refusedAll.forEach((x) => { const k = x.lit + ' → ' + x.tokenName + ' (' + x.reason + ')'; uniq[k] = (uniq[k] || 0) + 1; });
    Object.entries(uniq).slice(0, 10).forEach(([k, n]) => console.log('   ' + k + '  ×' + n));
  }
  if (skippedAll.length) {
    console.log('\n映射表未收录（保持原样，Phase 2 处理）: ' + skippedAll.length + ' 处');
    const uniq = {};
    skippedAll.forEach((x) => { uniq[x.lit.toLowerCase()] = (uniq[x.lit.toLowerCase()] || 0) + 1; });
    Object.entries(uniq).sort((a, b) => b[1] - a[1]).slice(0, 12).forEach(([k, n]) => console.log('   ' + k.padEnd(26) + n + ' 处'));
  }
  if (!apply) console.log('\n（干跑结束。确认无误后加 --apply 写入）');
}

main();
