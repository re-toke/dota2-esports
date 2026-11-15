// scripts/eslint-rules/no-console-log.js
// ★ 2026-11-15（复核整改 · console 规范）：生产代码禁裸 `console.log`。
//
// ## 为什么需要
//   项目约定写在 `utils/config.js` 顶部：**summary 日志每轮 1 行可保留；逐项 / 热路径日志
//   必须走 `config.debug.verboseLog`**。但 `.eslintrc` 的 `no-console` 为 `off`，
//   既有自定义规则（`no-console-warn-in-production`）只管 `console.warn`
//   ⇒ `console.log` 在「每次渲染 / 每个条目」的热路径上持续刷屏（实测首页每次重渲染都打 1 行）。
//
// ## 规则
//   · 命中 `console.log(...)` 即报告；
//   · `scripts/**`（运维/工具脚本）放行；
//   · 确属「每轮 1 行」的摘要日志：加 `// eslint-disable-next-line no-console-log` 并注明理由。
//
// ## 级别
//   warn —— 存量摘要日志较多，先给信号、不阻断提交；**新增代码请勿再加裸 console.log**。
//
// ## 放行条件（2026-11-15 补）
//   若该 `console.log` 位于 `if (...verboseLog...)` 守卫内 ⇒ **合规**（这正是项目约定），
//   不再报告；只报「无 verbose 守卫的裸 log」。
'use strict';

const WHITELIST = [
  /[/\\]scripts[/\\]/
];

function isWhitelisted(filename) {
  return WHITELIST.some(function (re) { return re.test(filename); });
}

module.exports = {
  meta: {
    type: 'suggestion',
    docs: {
      description: '生产代码禁裸 console.log：摘要日志用 console.info，逐项/热路径日志走 config.debug.verboseLog'
    },
    schema: []
  },
  create(context) {
    const filename = context.getFilename();
    if (isWhitelisted(filename)) return {};

    // 该调用是否位于 `if (...verboseLog...)` 守卫内（含嵌套块）—— 合规写法，放行。
    function inVerboseGuard(node) {
      let p = node.parent;
      while (p) {
        if (p.type === 'IfStatement' && p.test) {
          try {
            if (/verboseLog/.test(context.getSourceCode().getText(p.test))) return true;
          } catch (e) { /* 取源码失败 ⇒ 不放行，保守报告 */ }
        }
        p = p.parent;
      }
      return false;
    }

    return {
      CallExpression(node) {
        if (
          node.callee &&
          node.callee.type === 'MemberExpression' &&
          node.callee.object &&
          node.callee.object.type === 'Identifier' &&
          node.callee.object.name === 'console' &&
          node.callee.property &&
          node.callee.property.type === 'Identifier' &&
          node.callee.property.name === 'log'
        ) {
          if (inVerboseGuard(node)) return;
          context.report({
            node: node,
            message: '避免裸 console.log：摘要日志用 console.info，逐项/热路径日志请走 config.debug.verboseLog。' +
              '确需保留请加 // eslint-disable-next-line no-console-log 并注明理由。'
          });
        }
      }
    };
  }
};
