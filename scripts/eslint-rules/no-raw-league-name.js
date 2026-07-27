// scripts/eslint-rules/no-raw-league-name.js
// 自定义 ESLint 规则（G3 防护，对应分析报告 P3 展示名回归）。
//
// 目的：禁止把「原始联赛名字段」直接赋给「展示字段」，必须经过
// sources.leagueDisplayName(对象) / sources.canonicalLeagueName(...) 包裹，
// 否则新增展示位时可能再次出现 P3「直接用 OpenDota 原始名」的回归。
//
// 原始联赛名字段（明确属于联赛，不会与战队/选手/物品名混淆，避免误报）：
//   - <obj>.league_name        （OpenDota match / league 顶层字段）
//   - <obj>.league.name        （OpenDota match.league.name）
// 展示字段：name / leagueName / league / displayName / title
//
// 例外：右侧若整体是 leagueDisplayName(...) / canonicalLeagueName(...) 调用
// （含 sources.* 形式），视为已正确包裹，放行。
//
// 说明：leagues 列表里的 `l.name`（OpenDota 联赛名）属于 `obj.name` 形态，
// 因与战队/选手 `name` 无法静态区分，本规则不覆盖；该场景由 G1 的
// leagueDisplayName(l) 改造 + CODE_WIKI 约定 + 评审清单兜底。

'use strict';

const DISPLAY_FIELDS = new Set(['name', 'leagueName', 'league', 'displayName', 'title']);
const WRAP_CALLEES = new Set(['leagueDisplayName', 'canonicalLeagueName']);

function isRawLeagueRead(node) {
  // <obj>.league_name
  if (
    node && node.type === 'MemberExpression' &&
    node.property && node.property.type === 'Identifier' && node.property.name === 'league_name'
  ) {
    return true;
  }
  // <obj>.league.name
  if (
    node && node.type === 'MemberExpression' &&
    node.object && node.object.type === 'MemberExpression' &&
    node.object.property && node.object.property.type === 'Identifier' && node.object.property.name === 'league' &&
    node.property && node.property.type === 'Identifier' && node.property.name === 'name'
  ) {
    return true;
  }
  return false;
}

function isWrapped(node) {
  // 允许：leagueDisplayName(x) / canonicalLeagueName(x) / sources.leagueDisplayName(x)
  if (node && node.type === 'CallExpression' && node.callee) {
    const c = node.callee;
    if (c.type === 'Identifier' && WRAP_CALLEES.has(c.name)) return true;
    if (c.type === 'MemberExpression' && c.property && c.property.type === 'Identifier' && WRAP_CALLEES.has(c.property.name)) return true;
  }
  return false;
}

function fieldNameOf(node) {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MemberExpression' && node.property && node.property.type === 'Identifier') return node.property.name;
  return null;
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: '禁止把原始联赛名字段直接赋给展示字段（须用 leagueDisplayName/canonicalLeagueName 包裹）'
    },
    schema: []
  },
  create(context) {
    function checkRhs(fieldName, rhs) {
      if (!fieldName || !DISPLAY_FIELDS.has(fieldName)) return;
      if (isWrapped(rhs)) return;
      if (isRawLeagueRead(rhs)) {
        context.report({
          node: rhs,
          message: '展示字段「' + fieldName + '」不可直接引用原始联赛名字段（league_name / league.name），须用 sources.leagueDisplayName(对象) 或 sources.canonicalLeagueName(...) 包裹，避免 P3 展示名回归。'
        });
      }
    }
    return {
      AssignmentExpression(node) {
        checkRhs(fieldNameOf(node.left), node.right);
      },
      Property(node) {
        if (node.key && node.key.type === 'Identifier') {
          checkRhs(node.key.name, node.value);
        }
      }
    };
  }
};
