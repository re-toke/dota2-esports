// scripts/ops/check-edge-actions.js
// P1-20 子项 5（原 BUG-F，v1.2.1 按 D8 扩展为**三向断言**）：
//
//   断言：  ACTION_MAP（utils/api.js）键集  ∪  PARAM_MAP（utils/cloudProxy.js）键集
//           ⊆  EDGE_ACTIONS（utils/cloudProxy.js）键集
//
// ## 为什么需要（三条真实事故的共同根因）
//   「登记了参数映射（或方法映射）却没在 EDGE_ACTIONS 里接 EF」⇒ 调用时 `call()` 在
//   "action not mapped to any Edge Function" 处 reject：
//     · BUG-A（P1，**功能失效**）：`health` 未登记 ⇒ 详情页「数据源暂不可用」告警**全程失效**；
//     · BUG-D（P2）：`cloudCache` 通用 KV 回退路径的 action 全未映射；
//     · BUG-G（P2，**性能退化**）：`getMatch` 在 `ACTION_MAP`/`PARAM_MAP` 有、`EDGE_ACTIONS` 无
//       ⇒ 对局详情页**恒回落直连**（原实现还会先发一趟必然失败的 EF 往返再回落 = 负优化）。
//   ⇒ 本守卫把这类缺口**在提交前静态拦下**（当前 `scripts/` 里没有任何 `EDGE_ACTIONS` 断言）。
//
//   【2026-10-13 补 · 子项 5 前半】原实现只做了「三向 SUBset（`ACTION_MAP ∪ PARAM_MAP ⊆ EDGE_ACTIONS`）」，
//   遗漏了方案要求的另一半：静态扫描 `cloudProxy.call('<action>')` **字面量** ⊆ `EDGE_ACTIONS`。
//   两者互补 —— 三向覆盖「**经映射表间接调用**」（`cloudProxy.proxy.*` / api 封装）；本扫描覆盖「**直接 call 字面量**」。
//   ★ 缺口实例 = **BUG-D**：`utils/cloudCache.js` 的 `getCached` / `setCached` / `getSearchIndex` /
//     `buildSearchIndex` / `getTeamsHot` / `getTeamsIndex` 六个 action 均不在 EDGE_ACTIONS
//     ⇒ `call()` 恒 reject ⇒ **死回退分支**。本扫描即为拦住这类缺口的门禁。
//
// ## 实现方式：**静态解析**（不 require 运行时模块）
//   理由：① 不受 `require` 副作用影响（两个模块都 require 了 config/cache 等）；
//         ② 三个定义点都是**同构的字面量对象**，正则提取"2 空格缩进的顶层键"足够稳；
//         ③ 与 `check-token-overreach.js` / `check-card-contract.js` 的静态守卫风格一致。
//   ⚠️ 若将来某个映射改成**动态构造**（非字面量），本守卫会提取不到键 ⇒ 会报"未找到声明"，
//      那时请把该映射改回字面量，或在此显式登记例外（须写明理由）。
//
// ## 语义约定（2026-10-13 起）
//   **未登记 = 有意不经 EF**（如 `getMatch`，因 EF 侧 `buildPath()` 未实现它）。
//   这类调用由 `api.js` 的 `tryCloudOrDirect` 的「未登记 ⇒ 直接 direct()」守卫承接
//   ⇒ 因此本断言**不应有例外清单**：要么登记（走 EF），要么移除（有意走直连）。
//
// 用法：node scripts/ops/check-edge-actions.js   （已接入 npm run test:all）

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const API_JS = path.join(ROOT, 'utils', 'api.js');
const CLOUDPROXY_JS = path.join(ROOT, 'utils', 'cloudProxy.js');

let failed = 0;
function ok(cond, msg) {
  if (cond) { console.log('PASS  ' + msg); return true; }
  failed++;
  console.log('FAIL  ' + msg);
  return false;
}

/** 从源码里提取「字面量对象」的顶层键（仅匹配 2 空格缩进的 `key:` 行） */
function extractKeys(src, declName, fileLabel) {
  const i = src.indexOf(declName);
  if (i < 0) throw new Error(fileLabel + '：未找到声明 `' + declName + '`（映射被改成动态构造了？）');
  const start = src.indexOf('{', i);
  if (start < 0) throw new Error(fileLabel + '：`' + declName + '` 后未见 `{`');
  const end = src.indexOf('\n};', start);
  if (end < 0) throw new Error(fileLabel + '：`' + declName + '` 对象体未以 `\\n};` 结束');
  const body = src.slice(start + 1, end);
  const keys = [];
  const re = /^ {2}([A-Za-z0-9_$]+)\s*:/gm;
  let m;
  while ((m = re.exec(body)) !== null) keys.push(m[1]);
  return keys;
}

function uniq(arr) { return Array.from(new Set(arr)); }

/** 递归收集目录下所有 .js 文件（跳过 node_modules / .git） */
function walkJs(dir, out) {
  const arr = out || [];
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return arr; }
  ents.forEach(function (ent) {
    if (ent.name === 'node_modules' || ent.name === '.git') return;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkJs(p, arr);
    else if (/\.js$/.test(ent.name)) arr.push(p);
  });
  return arr;
}

/** 抽 `cloudProxy.call('<action>')` 的**字面量** action（按行处理并剔行注释；非字面量入参跳过） */
function literalCallActions(src) {
  const out = [];
  String(src).split(/\r?\n/).forEach(function (line) {
    const code = line.split('//')[0];
    const re = /cloudProxy\.call\(\s*['"]([A-Za-z0-9_$]+)['"]/g;
    let m;
    while ((m = re.exec(code)) !== null) out.push(m[1]);
  });
  return out;
}

/** 求差集：subKeys 里「不在 edgeKeys」的项（检测逻辑单点，供主流程与自检共用） */
function missing(edgeKeys, subKeys) {
  const s = Object.create(null);
  edgeKeys.forEach((k) => { s[k] = 1; });
  return subKeys.filter((k) => !s[k]);
}

(function main() {
  console.log('=== P1-20 三向守卫：ACTION_MAP ∪ PARAM_MAP ⊆ EDGE_ACTIONS ===\n');

  const apiSrc = fs.readFileSync(API_JS, 'utf8');
  const cpSrc = fs.readFileSync(CLOUDPROXY_JS, 'utf8');

  let edgeActions, paramMap, actionMap;
  try {
    edgeActions = uniq(extractKeys(cpSrc, 'EDGE_ACTIONS = {', 'utils/cloudProxy.js'));
    paramMap = uniq(extractKeys(cpSrc, 'PARAM_MAP = {', 'utils/cloudProxy.js'));
    actionMap = uniq(extractKeys(apiSrc, 'ACTION_MAP = {', 'utils/api.js'));
  } catch (e) {
    failed++;
    console.log('FAIL  解析失败：' + (e && e.message));
    console.log('\n=== 结果 ===\n通过: 0  失败: ' + failed);
    process.exitCode = 1;
    return;
  }

  console.log('EDGE_ACTIONS（' + edgeActions.length + '）：' + edgeActions.join(', '));
  console.log('ACTION_MAP  （' + actionMap.length + '）：' + actionMap.join(', '));
  console.log('PARAM_MAP   （' + paramMap.length + '）：' + paramMap.join(', '));
  console.log('');

  // ── 守卫自检（★ 先证明"它真能发现缺口"，否则绿也说明不了问题）────────────────────
  //  用**人造**集合验证检测逻辑：{a,b} ⊆ {a} 必须报出缺 b；⊆ {a,b} 必须不报。
  //  （本项目纪律：不接受"只凭绿就采信" —— 与切出口演练「复验不采信」同精神。）
  ok(missing(['a'], ['a', 'b']).join(',') === 'b', '★ 自检：人造缺口 {a,b}⊆{a} 能报出 b');
  ok(missing(['a', 'b'], ['a', 'b']).length === 0, '★ 自检：无缺口时不误报');

  // 守卫自检：三个集合都必须非空，否则说明解析没抓到东西（假绿风险）
  ok(edgeActions.length > 0, '解析到 EDGE_ACTIONS 键（非空）');
  ok(actionMap.length > 0, '解析到 ACTION_MAP 键（非空）');
  ok(paramMap.length > 0, '解析到 PARAM_MAP 键（非空）');

  const missAction = missing(edgeActions, actionMap);
  const missParam = missing(edgeActions, paramMap);

  ok(missAction.length === 0,
    'ACTION_MAP ⊆ EDGE_ACTIONS' + (missAction.length ? '（缺：' + missAction.join(', ') + '）' : ''));
  ok(missParam.length === 0,
    'PARAM_MAP ⊆ EDGE_ACTIONS' + (missParam.length ? '（缺：' + missParam.join(', ') + '）' : ''));

  // ★ 显式回归：BUG-G 的 `getMatch` 必须**两侧都已移除**（一侧残留即报错）。
  //   为什么单列：它是本守卫的"已知历史缺口"，若有人把它加回来而不接 EF，必须立刻红。
  ok(!actionMap.includes('getMatch'), '★ BUG-G 回归防护：ACTION_MAP 不含 getMatch（有意不经 EF）');
  ok(!paramMap.includes('getMatch'), '★ BUG-G 回归防护：PARAM_MAP 不含 getMatch（有意不经 EF）');

  // ── 子项 5 前半（2026-10-13 补）：`cloudProxy.call('<action>')` **字面量** ⊆ EDGE_ACTIONS ─────────
  //  覆盖「**直接 call**」路径；上方三向覆盖「经映射表间接调用」（`cloudProxy.proxy.*` / api 封装）。BUG-D 即此类缺口。
  const _c = 'cloudProxy' + '.' + 'call';   // 动态拼出，避免本文件自身（自检用的字符串）被下方扫描误命中
  ok(literalCallActions(_c + "('a')").join(',') === 'a', '★ 自检：字面量抽取（单引号）');
  ok(literalCallActions(_c + '("b")').join(',') === 'b', '★ 自检：字面量抽取（双引号）');
  ok(literalCallActions('x = ' + _c + '(action)').length === 0, '★ 自检：非字面量入参不误报');
  ok(literalCallActions('// ' + _c + "('a')").length === 0, '★ 自检：行注释内出现不误报');

  const callSites = [];
  ['utils', 'pages', 'subpackages', 'scripts'].forEach(function (d) {
    walkJs(path.join(ROOT, d)).forEach(function (f) {
      literalCallActions(fs.readFileSync(f, 'utf8')).forEach(function (a) {
        callSites.push({ file: path.relative(ROOT, f), action: a });
      });
    });
  });
  const callActions = uniq(callSites.map(function (c) { return c.action; }));
  console.log('cloudProxy.call 字面量（' + callSites.length + ' 处 / ' + callActions.length + ' 个 action）：' +
    (callActions.join(', ') || '(无)'));
  ok(callSites.length > 0, '解析到 cloudProxy.call 字面量（非空）');

  const missCall = missing(edgeActions, callActions);
  ok(missCall.length === 0,
    'cloudProxy.call 字面量 ⊆ EDGE_ACTIONS' +
    (missCall.length
      ? '（缺：' + missCall.join(', ') + ' ← ' +
        uniq(callSites.filter(function (c) { return missCall.indexOf(c.action) >= 0; })
          .map(function (c) { return c.file; })).join(', ') + '）'
      : ''));

  console.log('\n=== 结果 ===');
  console.log('（缺口 ' + (missAction.length + missParam.length + missCall.length) + ' 项）');
  if (failed) {
    console.log('存在失败 ❌');
    process.exitCode = 1;
  } else {
    console.log('全部通过 ✅');
  }
})();
