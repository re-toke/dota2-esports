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

# 2026-10-28（CI G4 连续三轮失败复盘）：改 utils/curation.js 必须同步 curation-shared.js。
#   CI 的 "Verify curation map is up to date" 会现场 `npm run sync:canon` 并比对 git diff；
#   漏同步 → 每次 push 都红（37054fc / a91bbfd / 169edc2 三次）。
#   这里在提交阶段自动重生成并加入本次提交，从源头消除该漏步。
if git diff --cached --name-only --diff-filter=ACM | grep -qx 'utils/curation.js'; then
  echo "[pre-commit] 检测到 utils/curation.js → 自动同步 curation-shared.js..."
  if ! npm run sync:canon >/dev/null 2>&1; then
    echo "❌ sync:canon 失败（G4）。请先修复 utils/curation.js 后重试。"
    exit 1
  fi
  if ! git diff --quiet -- utils/curation-shared.js; then
    git add utils/curation-shared.js
    echo "  已自动暂存 utils/curation-shared.js（CI G4 将无需再生成 diff）"
  fi
fi

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
# ★★ 2026-09-28 扩展（**实测驱动的修正**）：原正则只列了 **4 个 utils 文件**，且**漏掉整个 `subpackages/`**。
#   用原正则逐条实测：`utils/names.js`·`tiers.js`·`cache.js`·`homeDedupe.js` ❌、
#   `subpackages/detail/league-detail/league-detail.js` ❌ ⇒ 改这些文件**不触发任何强门禁**；
#   而 CI 当时也只跑 `npm test`（2 个脚本）⇒ 近乎无护栏
#   （09-27 改 league-detail 时，是靠同一提交里的 `utils/sources.js` **侥幸触发**的）。
#
#   ★★ 判定原则（**触发面 = 守卫的扫描面**，而不是"感觉属于页面层"）：
#     `test-sources` 里那两个**全库扫描型守卫**（"禁内联归一化" L1036、"LP UA 合规" L1469）
#     构造的是**目录列表**（裸 token），逐条核出的 `.js` 视角并集 =
#     **`utils` | `pages` | `subpackages` | `scripts` | `components`**
#     （`supabase/` 下 0 个 `.js`、`cloudfunctions/` 已不存在 ⇒ 均无需纳入）。
#     ⇒ 改动**其中任一个**都可能**新增**这两个守卫要拦的违规，故都应触发 `test:all`。
#     ⚠️ 反例（**刻意不纳入**）：仓库根 `app.js`、`custom-tab-bar/`、`.github/` 均**不在**任何守卫的扫描面内
#     ⇒ 纳入 = 白跑 37s。`.github/` 的守卫在 `test-lp-fetch-guard` 里，而它已进 `npm test`（每次必跑）。
#     ★ 教训：先前我用 `grep -rn "scripts/"` 判定"scripts 无守卫" ⇒ **匹配不到裸 token `'scripts'`**
#       ⇒ 得出错误结论。**目录列表型判据必须看列表本身，不能用路径字面量去猜。**
#   ⚠️ 副作用（已知并接受）：触发面变宽后，本地提交会多花 `test:all` 的 ≈37s。
DATA_LAYER_TOUCHED=$(echo "$STAGED_JS" | grep -E '(^|/)(utils|pages|subpackages|scripts|components)/.*\.js$' || true)
if [ -n "$DATA_LAYER_TOUCHED" ]; then
  echo "[pre-commit] 检测到 data layer / 页面层变更，运行完整测试套件（test:all）..."
  npm run test:all || {
    echo "❌ test:all 未通过，提交被阻断。data layer / 页面层变更需通过全部门禁（含 check-card-contract）。"
    exit 1
  }
fi

echo "✅ pre-commit 检查通过"
