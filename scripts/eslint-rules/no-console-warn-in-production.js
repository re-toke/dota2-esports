// scripts/eslint-rules/no-console-warn-in-production.js
// G7.3 自定义 ESLint 规则（2026-07-29）：限制 console.warn 的滥用。
//
// 目的：项目中有大量 console.warn 用于「预期内的降级场景」（如缓存未命中、
// 占位兜底），导致开发工具 Console 被海量 warn 污染，真正的警告被淹没。
// 本规则要求 console.warn 仅用于「非预期问题」（如数据不一致、API 失败），
// 预期内的降级场景应使用 console.info。
//
// 例外白名单：以下模块的 console.warn 放行（历史代码，重构成本高）：
//   - utils/liquipedia.js（Liquipedia 重试日志，属于网络问题）
//   - cloudfunctions/aggregation/index.js（云函数错误日志）
//   - scripts/**（脚本工具，调试用）
//
// 后续新增的 console.warn 需在代码评审时说明「为何是警告而非信息」。

'use strict';

const WHITELIST = [
  /[/\\]utils[/\\]liquipedia\.js$/,
  /[/\\]cloudfunctions[/\\]aggregation[/\\]index\.js$/,
  /[/\\]scripts[/\\]/
];

function isWhitelisted(filename) {
  return WHITELIST.some(function (re) { return re.test(filename); });
}

module.exports = {
  meta: {
    type: 'suggestion',
    docs: {
      description: '限制 console.warn 滥用：预期降级场景应用 console.info，warn 仅用于非预期问题'
    },
    schema: []
  },
  create(context) {
    var filename = context.getFilename();
    if (isWhitelisted(filename)) return {};
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
          node.callee.property.name === 'warn'
        ) {
          context.report({
            node: node,
            message: '避免使用 console.warn（预期降级场景应用 console.info）。如确为非预期问题，请添加 // eslint-disable-next-line no-console-warn-in-production 注释。'
          });
        }
      }
    };
  }
};
