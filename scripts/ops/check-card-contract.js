#!/usr/bin/env node
/**
 * scripts/ops/check-card-contract.js
 *
 * 校验「卡片工厂产出的字段」是否覆盖「消费侧读取的字段」。
 * 作用：防止卡片字段名/形态不一致导致过滤或渲染**静默失效**（无报错、无日志、界面空白）。
 *
 * 背景（2026-09-17 审计 P0-1）：
 *   v8.87 在 pages/index/index.js 加入 `passGrade = (c) => !!(c.tier && HOME_GRADES[c.tier.grade])`，
 *   但三个卡片工厂（_cardFromSeries / _cardFromCuration / buildFollowCard）
 *   都只输出 tierLabel / tierClass，**从未输出 tier** →
 *   passGrade 恒 false → 首页三段全部为空。
 *
 *   该缺陷 ESLint 无规则可捕获、node --check 只能验语法、纯函数测试也覆盖不到
 *   （现有 11 套件全部只 require utils/*.js，不加载 pages/*.js），只能靠契约检查兜住。
 *
 * 用法：
 *   node scripts/ops/check-card-contract.js
 *
 * 退出码：0 = 契约一致；1 = 存在「消费侧读取但生产侧未产出」的字段
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const TARGET = path.join(ROOT, 'pages', 'index', 'index.js');

// 卡片工厂（产出侧）—— 它们的 return 对象键构成卡片字段全集
const FACTORIES = ['_cardFromSeries', '_cardFromCuration', 'buildFollowCard'];

// 消费侧函数（读取卡片字段）—— 这些函数体内对 `c.xxx` 的读取必须能在工厂产出中找到
const CONSUMERS = ['_renderMatchFlow', '_buildWeekCalendar'];

// 白名单：消费侧读取但不由工厂产出的字段
// （wxml 层/组件层注入，或由页面在 push 前补充的字段）
const ALLOW_MISSING = new Set([
  'kind',          // 由模板分支消费，_cardFromCuration 已产出，保留以防未来新增分支
]);

/** 去掉注释，避免注释里的示例代码干扰解析 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** 从 src 中定位 fnName 的**方法定义**体（避免误命中调用点） */
function functionBody(src, fnName) {
  // 方法定义特征：行首缩进 + 函数名(参数) { ，而调用点形如 this._fn(...) / _fn(...);
  const safe = fnName.replace(/[$]/g, '\\$');
  const re = new RegExp('(?:^|[\\n\\r])[ \\t]*' + safe + '\\s*\\([^)]*\\)\\s*\\{', 'm');
  const m = re.exec(src);
  if (!m) return null;
  const braceStart = m.index + m[0].length - 1;
  let depth = 0;
  for (let j = braceStart; j < src.length; j++) {
    const ch = src[j];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(braceStart, j + 1);
    }
  }
  return null;
}

/** 提取对象字面量的**顶层**键名 */
function topLevelKeys(objSrc) {
  const keys = new Set();
  let depth = 0;
  let token = '';
  for (let i = 0; i < objSrc.length; i++) {
    const ch = objSrc[i];
    if (ch === '{' || ch === '[' || ch === '(') { depth++; token = ''; continue; }
    if (ch === '}' || ch === ']' || ch === ')') { depth--; token = ''; continue; }
    if (depth !== 0) continue;
    if (ch === ':' && token) { keys.add(token); token = ''; continue; }
    if (/[A-Za-z0-9_$]/.test(ch)) { token += ch; continue; }
    token = '';
  }
  return keys;
}

/** 提取某函数内所有 `return { ... }` 对象的顶层键（合并） */
function factoryKeys(src, fnName) {
  const body = functionBody(src, fnName);
  if (body === null) return null;
  const keys = new Set();
  const re = /return\s*\{/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const braceStart = m.index + m[0].length - 1;
    let depth = 0;
    for (let j = braceStart; j < body.length; j++) {
      const ch = body[j];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          topLevelKeys(body.slice(braceStart + 1, j)).forEach((k) => keys.add(k));
          break;
        }
      }
    }
  }
  return keys;
}

/** 提取某函数体内所有 `c.xxx` 形式的属性读取（**排除该函数自己写入的字段**） */
function consumedKeys(src, fnName) {
  const body = functionBody(src, fnName);
  if (body === null) return null;
  const read = new Set();
  const written = new Set();
  let m;
  // 读取：c.xxx
  const readRe = /\bc\.([A-Za-z_$][\w$]*)/g;
  while ((m = readRe.exec(body)) !== null) read.add(m[1]);
  // 写入（视为页面自产，如 `c.dots = []` / `c.dots.push(...)`）：
  //   c.xxx = （排除 == / ===，故要求 = 后不是 =）
  //   c.xxx.anyCall(
  const writeRe = /\bc\.([A-Za-z_$][\w$]*)\s*(?:=[^=]|\.\w+\s*\()/g;
  while ((m = writeRe.exec(body)) !== null) written.add(m[1]);
  const out = new Set();
  read.forEach((k) => { if (!written.has(k)) out.add(k); });
  return out;
}

function main() {
  if (!fs.existsSync(TARGET)) {
    console.error('[card-contract] 目标文件不存在: ' + TARGET);
    process.exit(1);
  }

  const raw = fs.readFileSync(TARGET, 'utf8');
  const src = stripComments(raw);

  // ① 汇总生产侧字段
  const produced = new Set();
  const missingFactories = [];
  for (const fn of FACTORIES) {
    const keys = factoryKeys(src, fn);
    if (!keys) { missingFactories.push(fn); continue; }
    keys.forEach((k) => produced.add(k));
  }

  if (missingFactories.length) {
    console.log('[card-contract] 提示：未找到工厂函数 ' + missingFactories.join(' / ') + '（可能已重命名，请同步本脚本）');
  }

  // ② 汇总消费侧字段并比对
  let violations = 0;
  for (const fn of CONSUMERS) {
    const used = consumedKeys(src, fn);
    if (!used) continue;
    const missing = [...used].filter((k) => !produced.has(k) && !ALLOW_MISSING.has(k));
    if (missing.length) {
      violations += missing.length;
      console.log('[card-contract] ✗ ' + fn + '() 读取了卡片未产出的字段: ' + missing.join(', '));
      for (const k of missing) {
        console.log('                 → 需在 ' + FACTORIES.join(' / ') + ' 的 return 对象中补 `' + k + ':`，');
        console.log('                   或确认该读取应改用其它已产出字段（详见 2026-09-17 审计报告 P0-1）');
      }
    }
  }

  if (violations) {
    console.log('\n[card-contract] ❌ 发现 ' + violations + ' 处字段契约不一致（生产侧 ' + produced.size + ' 个字段）');
    console.log('[card-contract]    此类缺陷不会报错、不会打日志，只会让界面静默空白。');
    process.exit(1);
  }

  console.log('[card-contract] ✅ 卡片字段契约一致（生产侧 ' + produced.size + ' 个字段，消费侧 ' +
    CONSUMERS.join('/') + ' 读取全部可满足）');
  process.exit(0);
}

main();
