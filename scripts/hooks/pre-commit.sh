#!/bin/sh
# scripts/hooks/pre-commit.sh
# G9 — pre-commit 守卫：提交前对「已暂存的 .js」跑 ESLint（含自定义领域规则），
# 并跑离线可靠测试 npm test（G2/G4/G6/G8 快照）。任一失败即阻断提交，
# 把 G2/G3 前移到个人提交阶段，减少 CI 噪音。
#
# 由 .husky/pre-commit（husky 便携化）与本仓库 .git/hooks/pre-commit（原生，立即可用）共同调用。

set -e
cd "$(git rev-parse --show-toplevel)"

# 仅对已暂存（Added/Copied/Modified）的 .js 跑 lint，排除依赖与构建产物
STAGED_JS=$(git diff --cached --name-only --diff-filter=ACM \
  | grep -E '\.js$' \
  | grep -vE 'node_modules/|miniprogram_npm/|cloudfunctions/aggregation/curation-shared\.js' \
  || true)

if [ -n "$STAGED_JS" ]; then
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

echo "✅ pre-commit 检查通过"
