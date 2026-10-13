// scripts/ops/check-ef-contract.js
// P1-20 子项 3：**EF 最小契约守卫**（静态）—— 防「EF 与客户端字段/路由漂移」。
//
// ## 为什么需要（以及为什么是"静态"）
//   EF（supabase/functions/*/index.ts）已是客户端**唯一后端**（云开发已退役），但本地**无 deno**
//   ⇒ 门禁里无法真跑 handler。「文件存在 ≠ 被正确接线」这类假绿在本项目已造成多次误判
//   （BUG-A / BUG-G：客户端把 action **路由给一个不处理它的 EF**）。故用静态契约把三类漂移
//   拦在提交前 —— 与 `check-edge-actions.js`（客户端侧三向断言）互补：本守卫查**服务端侧**。
//
//   C1 **路由文件存在**：`EDGE_ACTIONS` 每个 action → 其 efName 对应的
//      `supabase/functions/<ef>/index.ts` 必须存在（防路由到被改名/删除的 EF）。
//   C2 **入口存在**：该 EF 源须含 `Deno.serve`（否则部署入口缺失）。
//   C3 **action 覆盖**：若该 EF 源**按 action 分派**（含 `body.action`），则 `EDGE_ACTIONS` 登记的
//      每个 action 字面量必须在其源中**出现**（否则「路由到 EF、EF 不认该 action」⇒ 恒 400）。
//      对**裸载荷/专用** EF（`stratz-proxy` / `bundle-aggregator` / `haglund-proxy`：源中无
//      `body.action`）C3 自动跳过（其 action 只是客户端标签，EF 直接消费裸载荷）。
//   C4 **输出信封契约**：客户端 `cloudProxy._efCall` 读 `r.data` / `r.error` —— 这是 client↔EF
//      的字段锚点（EF 统一返回 `{ data } | { error }`）。断言该读取仍在，防单侧改动而不自知。
//
// ## 实现方式：静态解析（不 require 运行时模块；与 check-token-overreach / check-card-contract 同风格）
//   ⚠️ 若某映射改成**动态构造**（非字面量），本守卫会因"未找到声明"而报错 —— 那时请改回字面量或在此显式登记例外。
//
// 用法：node scripts/ops/check-ef-contract.js   （已接入 npm run test:all）

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const CLOUDPROXY_JS = path.join(ROOT, 'utils', 'cloudProxy.js');
const EF_DIR = path.join(ROOT, 'supabase', 'functions');

let failed = 0;
function ok(cond, msg) {
  if (cond) { console.log('PASS  ' + msg); return true; }
  failed++;
  console.log('FAIL  ' + msg);
  return false;
}

/** 取「2 空格缩进的顶层 `key: 'value'`」字面量映射（EDGE_ACTIONS 形态） */
function extractMap(src, declName, fileLabel) {
  const i = src.indexOf(declName);
  if (i < 0) throw new Error(fileLabel + '：未找到声明 `' + declName + '`（被改成动态构造了？）');
  const start = src.indexOf('{', i);
  const end = src.indexOf('\n};', start);
  if (start < 0 || end < 0) throw new Error(fileLabel + '：`' + declName + '` 对象体解析失败');
  const body = src.slice(start + 1, end);
  const out = Object.create(null);
  const re = /^ {2}([A-Za-z0-9_$]+)\s*:\s*'([^']+)'/gm;
  let m;
  while ((m = re.exec(body)) !== null) out[m[1]] = m[2];
  return out;
}

/** 取「单行字面量对象」的键（RAW_PAYLOAD_ACTIONS 形态：`{ a: 1, b: 1 }`） */
function extractInlineKeys(src, declName) {
  const i = src.indexOf(declName);
  if (i < 0) return [];
  const start = src.indexOf('{', i);
  const end = src.indexOf('}', start);
  if (start < 0 || end < 0) return [];
  const body = src.slice(start + 1, end);
  const out = [];
  const re = /([A-Za-z0-9_$]+)\s*:/g;
  let m;
  while ((m = re.exec(body)) !== null) out.push(m[1]);
  return out;
}

/** 检测逻辑单点：src 中缺失字面量（双/单引号任一形态）的 action —— 供主流程与自检共用 */
function actionsMissingFromSource(src, actions) {
  return actions.filter(function (a) {
    return src.indexOf('"' + a + '"') < 0 && src.indexOf("'" + a + "'") < 0;
  });
}

(function main() {
  console.log('=== P1-20 子项 3 守卫：EF 静态契约（路由文件 / 入口 / action 覆盖 / 输出信封）===\n');

  const cpSrc = fs.readFileSync(CLOUDPROXY_JS, 'utf8');

  let edge, raw;
  try {
    edge = extractMap(cpSrc, 'EDGE_ACTIONS = {', 'utils/cloudProxy.js');
    raw = extractInlineKeys(cpSrc, 'RAW_PAYLOAD_ACTIONS =');
  } catch (e) {
    failed++;
    console.log('FAIL  解析失败：' + (e && e.message));
    console.log('\n=== 结果 ===\n通过: 0  失败: ' + failed);
    process.exitCode = 1;
    return;
  }

  const actions = Object.keys(edge);
  console.log('EDGE_ACTIONS（' + actions.length + '）：');
  actions.forEach(function (a) { console.log('  ' + a + '  →  ' + edge[a]); });
  console.log('RAW_PAYLOAD_ACTIONS（裸载荷）：' + (raw.length ? raw.join(', ') : '(无)'));
  console.log('');

  // ── 守卫自检（★ 先证明"它真能发现缺口"，否则绿也说明不了问题）────────────────────
  ok(actionsMissingFromSource('if (action === "a") {}', ['a', 'b']).join(',') === 'b',
    '★ 自检：人造缺口（源含 a、缺 b）能报出 b');
  ok(actionsMissingFromSource('"a" "b"', ['a', 'b']).length === 0, '★ 自检：无缺口时不误报');
  ok(actions.length > 0, '解析到 EDGE_ACTIONS 键（非空）');
  ok(raw.length > 0, '解析到 RAW_PAYLOAD_ACTIONS 键（非空）');

  // 按 EF 汇总（一个 EF 可能承接多个 action）
  const byEf = Object.create(null);
  actions.forEach(function (a) { (byEf[edge[a]] = byEf[edge[a]] || []).push(a); });

  Object.keys(byEf).forEach(function (efName) {
    const rel = 'supabase/functions/' + efName + '/index.ts';
    const file = path.join(EF_DIR, efName, 'index.ts');
    const exists = fs.existsSync(file);
    ok(exists, 'C1 路由文件存在：' + rel);
    if (!exists) return;
    const src = fs.readFileSync(file, 'utf8');
    ok(src.indexOf('Deno.serve') >= 0, 'C2 入口存在：' + rel + ' 含 Deno.serve');
    if (src.indexOf('body.action') >= 0) {
      const miss = actionsMissingFromSource(src, byEf[efName]);
      ok(miss.length === 0,
        'C3 action 覆盖：' + efName + ' 处理 [' + byEf[efName].join(', ') + ']' +
        (miss.length ? '（缺：' + miss.join(', ') + '）' : ''));
    } else {
      console.log('  · ' + efName + '：非 action 分派（裸载荷/专用）⇒ C3 跳过');
    }
  });

  // C4：客户端输出信封读取契约（EF 统一返回 { data } | { error }）
  ok(cpSrc.indexOf('r.data') >= 0 && cpSrc.indexOf('r.error') >= 0,
    'C4 输出契约：cloudProxy._efCall 仍读 r.data / r.error');

  console.log('\n=== 结果 ===');
  if (failed) {
    console.log('存在失败 ❌');
    process.exitCode = 1;
  } else {
    console.log('全部通过 ✅');
  }
})();
