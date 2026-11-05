#!/usr/bin/env node
// ============================================================
// infra/proxy/build-lp-sync.cjs
//
// 作用：把 curation / slugmap 里的「要同步哪些 LP 页面」烘进
//      `infra/proxy/lp-sync.mjs`（Deno Deploy 单文件部署，不能 import 仓库模块）。
//
// 为什么需要：worker 必须知道完整 slug 集合才能做增量差集，
//   而 curation 是 JS 模块，无法在部署后的边缘运行时里直接 require。
//   ⇒ 构建时生成数组，粘贴部署。
//
// ⚠️ 2026-11-05 起：本地烘焙只是**基线 + 兜底**。worker 每轮会从 Supabase
//   `curation_events` 派生增量范围（见 utils/lp-scope.js），所以
//   **admin 新增赛事 / 改 slug 不再需要重跑本脚本、也不需要重新部署**；
//  只有 slugmap 或推导逻辑（utils/lp-scope.js）变更时才需要重跑 + 重新粘贴。
//
// 用法：node infra/proxy/build-lp-sync.cjs
// 校验：node infra/proxy/build-lp-sync.cjs --check（只打印范围，不改文件）
// ============================================================
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const TARGET = path.join(__dirname, 'lp-sync.mjs');

const curation = require(path.join(ROOT, 'utils', 'curation.js'));
const slugmap = require(path.join(ROOT, 'utils', 'liquipedia-slugmap.json'));

// ① 全量范围：slugmap 主 slug ∪ curation 的四个页面字段（与 GitHub 同步脚本同口径）
const curated = [];
(curation.CURATED_EVENTS || []).forEach((ev) => {
  if (!ev) return;
  ['scheduledMatchesSlug', 'structureSlug', 'bracketSlug', 'liquipediaSlug'].forEach((f) => {
    if (typeof ev[f] === 'string' && ev[f]) curated.push(ev[f]);
  });
});
const all = Array.from(new Set(Object.values(slugmap.mappings || {}).concat(curated)))
  .filter((s) => typeof s === 'string' && s.trim());

// ② 热点赛事：进行中 / 2 天内开赛 / 结束 1 天内（与 sync-liquipedia-cache.js --active 一致）
const now = Math.floor(Date.now() / 1000);
const hot = [];
(curation.CURATED_EVENTS || []).forEach((ev) => {
  if (!ev || !ev.start || !ev.end) return;
  if (ev.start - 2 * 86400 > now || now > ev.end + 86400) return;
  const slugs = [];
  ['scheduledMatchesSlug', 'structureSlug', 'bracketSlug', 'liquipediaSlug'].forEach((f) => {
    if (typeof ev[f] === 'string' && ev[f]) slugs.push(ev[f]);
  });
  const mapped = (slugmap.mappings || {})[ev.canonical];
  if (mapped) slugs.push(mapped);
  const uniq = Array.from(new Set(slugs));
  if (uniq.length) hot.push({ n: String(ev.canonical || ''), s: ev.start, e: ev.end, slugs: uniq });
});

// ③ bracket 候选页：热点赛事才同步（与 sync-liquipedia-brackets.js 的候选顺序完全一致）
function bracketCandidates(ev) {
  const base = ev.liquipediaSlug || '';
  const arr = [];
  [ev.bracketSlug, ev.structureSlug, ev.scheduledMatchesSlug,
    base ? base + '/Main Event' : '', base ? base + '/Playoffs' : '', base].forEach((s) => {
    if (s && arr.indexOf(s) < 0) arr.push(s);
  });
  return arr;
}
const brEvents = [];
(curation.CURATED_EVENTS || []).forEach((ev) => {
  if (!ev || !ev.start || !ev.end) return;
  if (ev.start - 2 * 86400 > now || now > ev.end + 86400) return;
  if (!(ev.bracketSlug || ev.liquipediaSlug)) return;
  const cands = bracketCandidates(ev);
  if (!cands.length) return;
  brEvents.push({ n: String(ev.canonical || ''), id: ev.leagueId == null ? null : ev.leagueId, slugs: cands });
});

function fmtArray(name, items) {
  const lines = [];
  for (let i = 0; i < items.length; i += 3) {
    lines.push('  ' + items.slice(i, i + 3).map((x) => JSON.stringify(x)).join(', ') + ',');
  }
  return 'const ' + name + ' = [\n' + lines.join('\n') + '\n];';
}

function fmtHot(items) {
  const lines = items.map((ev) =>
    '  { n: ' + JSON.stringify(ev.n) + ', s: ' + ev.s + ', e: ' + ev.e +
    ', slugs: [' + ev.slugs.map((s) => JSON.stringify(s)).join(', ') + '] },');
  return 'const HOT = [\n' + lines.join('\n') + '\n];';
}

function fmtBrackets(items) {
  const lines = items.map((ev) =>
    '  { n: ' + JSON.stringify(ev.n) + ', id: ' + (ev.id == null ? 'null' : ev.id) +
    ', slugs: [' + ev.slugs.map((s) => JSON.stringify(s)).join(', ') + '] },');
  return 'const BRACKET_EVENTS = [\n' + lines.join('\n') + '\n];';
}

/** CJS 模块 → IIFE 常量（Deno 单文件部署无法 require 仓库模块） */
function wrapModule(src, name) {
  return 'const ' + name + ' = (function () {\n' +
    '  const module = { exports: {} };\n  const exports = module.exports;\n' +
    src + '\n  return module.exports;\n})();';
}

function inject(src, marker, body) {
  const re = new RegExp('// <BUILD:' + marker + '>[\\s\\S]*?// </BUILD:' + marker + '>');
  if (!re.test(src)) throw new Error('找不到标记 // <BUILD:' + marker + '>');
  // ⚠️ 必须用函数式替换：字符串替换里的 `$'`、`$&` 会被当成替换模式，
  //    而 liquipedia-parse.js 里正好有 `'$'` 字面量（币种符号表）——
  //    用字符串写法会静默截断并复制整段文件（2026-11-05 实测踩过）。
  const block = '// <BUILD:' + marker + '>\n' + body + '\n// </BUILD:' + marker + '>';
  return src.replace(re, () => block);
}

const checkOnly = process.argv.includes('--check');
console.log('全量 slug:', all.length, '| 热点赛事:', hot.length, '| bracket 赛事:', brEvents.length);
hot.forEach((e) => console.log('  ·', e.n, '→', e.slugs.join(' | ')));
brEvents.forEach((e) => console.log('  ·', e.n, '→', e.slugs.join(' | ')));
all.forEach((s, i) => { if (process.argv.includes('--verbose')) console.log(String(i + 1).padStart(4), s); });
if (checkOnly) process.exit(0);

let src = fs.readFileSync(TARGET, 'utf8');

// 解析器内联：names.js + liquipedia-parse.js（后者 require('./names.js') → NAMES）
const namesSrc = fs.readFileSync(path.join(ROOT, 'utils', 'names.js'), 'utf8');
let parseSrc = fs.readFileSync(path.join(ROOT, 'utils', 'liquipedia-parse.js'), 'utf8');
parseSrc = parseSrc.split("require('./names.js')").join('NAMES');
const parser = wrapModule(namesSrc, 'NAMES') + '\n\n' + wrapModule(parseSrc, 'LPParse');

src = inject(src, 'SLUGS', fmtArray('SLUGS', all));
src = inject(src, 'HOT', fmtHot(hot));
src = inject(src, 'BRACKETS', fmtBrackets(brEvents));
src = inject(src, 'PARSER', parser);

// 同步范围推导模块内联：worker 与本地脚本共用同一实现，避免双份口径漂移
const scopeSrc = fs.readFileSync(path.join(ROOT, 'utils', 'lp-scope.js'), 'utf8');
src = inject(src, 'SCOPE', wrapModule(scopeSrc, 'LP_SCOPE'));
fs.writeFileSync(TARGET, src, 'utf8');
console.log('✅ 已写入', TARGET, '(' + Math.round(src.length / 1024) + 'KB)');
console.log('⚠️ 部署后必须重新粘贴该文件到 Deno Playground 才会生效');
