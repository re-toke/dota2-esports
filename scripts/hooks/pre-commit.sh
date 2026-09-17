#!/bin/sh
# scripts/hooks/pre-commit.sh
# G9 + G7.1 — pre-commit 守卫：提交前对「已暂存的 .js」依次跑：
#   ① node --check 语法校验（G7.1，捕获 require 路径错误 + ES 语法不兼容）
#   ② ESLint（含自定义领域规则）
#   ③ npm test 离线可靠测试（G2/G4/G6/G8 快照）
# 任一失败即阻断提交，把 G2/G3/G7 前移到个人提交阶段，减少 CI 噪音。
#
# 由 .husky/pre-commit（husky 便携化）与本仓库 .git/hooks/pre-commit（原生，立即可用）共同调用。

set -e
cd "$(git rev-parse --show-toplevel)"

# 仅对已暂存（Added/Copied/Modified）的 .js 跑检查，排除依赖与构建产物
STAGED_JS=$(git diff --cached --name-only --diff-filter=ACM \
  | grep -E '\.js$' \
  | grep -vE 'node_modules/|miniprogram_npm/|cloudfunctions/aggregation/curation-shared\.js' \
  || true)

if [ -n "$STAGED_JS" ]; then
  # G7.1：node --check 语法校验（最快，秒级）
  # 捕获：合并冲突残留、ES 语法不兼容、require 路径拼写错误等低级错误
  echo "[pre-commit] 语法校验（node --check）..."
  SYNTAX_FAIL=0
  for f in $STAGED_JS; do
    if ! node --check "$f" 2>/dev/null; then
      echo "  ❌ 语法错误: $f"
      node --check "$f" 2>&1 | head -3 | sed 's/^/     /'
      SYNTAX_FAIL=1
    fi
  done
  if [ "$SYNTAX_FAIL" -ne 0 ]; then
    echo "❌ 语法校验未通过，提交被阻断（G7.1）。请修复后重新 git add 相关文件。"
    exit 1
  fi
  echo "  语法全部通过 ✅"

  # ESLint：领域规则 + 代码质量
  echo "[pre-commit] ESLint 检查受影响文件..."
  # shellcheck disable=SC2086
  npx eslint --rulesdir scripts/eslint-rules $STAGED_JS || {
    echo "❌ ESLint 未通过，提交被阻断（G9）。请修复后重新 git add 相关文件。"
    exit 1
  }
fi

# 离线可靠测试必须全绿（不联网，约 27 项断言）
echo "[pre-commit] 运行 npm test（离线快照）..."
npm test || {
  echo "❌ npm test 未通过，提交被阻断（G9）。请修复后重新提交。"
  exit 1
}

# §7.1 增强（2026-07-29）：当修改涉及 data layer（utils/sources|consensus|curation|api.js）
# 时，运行完整 test:all 作为更强门禁。
# ★ 2026-09-17 扩展：`pages/` 下的 .js 一并纳入触发范围。
#   原因（审计 P0-1）：页面层改动此前不触发 test:all，而 test:all 又是唯一会跑
#   页面契约守卫（check-card-contract）的入口 → 首页字段契约错误（c.tier 读不到）
#   一路无阻进入生产。页面层与数据层同样需要强门禁。
DATA_LAYER_TOUCHED=$(echo "$STAGED_JS" | grep -E '(utils/(sources|consensus|curation|api)\.js|^pages/.*\.js|/pages/.*\.js)$' || true)
if [ -n "$DATA_LAYER_TOUCHED" ]; then
  echo "[pre-commit] 检测到 data layer / 页面层变更，运行完整测试套件（test:all）..."
  npm run test:all || {
    echo "❌ test:all 未通过，提交被阻断。data layer / 页面层变更需通过全部门禁（含 check-card-contract）。"
    exit 1
  }
fi

echo "✅ pre-commit 检查通过"
