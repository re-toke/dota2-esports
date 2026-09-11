#!/bin/sh
# scripts/ops/run-lp-sync.sh
# ============================================================
# Liquipedia 缓存灌表 —— 一键封装（2026-09-11）
#
# 为什么需要它：直接手敲命令有三个易错点（都踩过）：
#   ① SUPABASE_URL 要手抄 20+ 位项目 ref，极易打错一位；
#   ② SUPABASE_SERVICE_KEY=<占位符> 里的 `<>` 在 bash 中是**输入重定向**，
#      未替换时会报 `bash: xxx: No such file or directory`；
#   ③ 必须在项目根目录执行，否则找不到脚本。
#
# 本脚本：URL 自动从 utils/config.js 读取（零手抄）；key 若未设则**隐藏输入**
#   （不进 shell 历史）；自动 cd 到仓库根目录。
#
# 用法：
#   sh scripts/ops/run-lp-sync.sh            # 灌表（约 8 分钟）
#   sh scripts/ops/run-lp-sync.sh --list     # 只看抓取范围（不发请求、无需 key）
# ============================================================
set -e

# 自动定位仓库根目录（不依赖当前所在目录）
ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
cd "$ROOT"

# URL 从配置读取，避免手抄出错
URL=$(node -e "process.stdout.write(require('./utils/config.js').supabase.url)")
if [ -z "$URL" ]; then
  echo "❌ 无法从 utils/config.js 读取 supabase.url" >&2
  exit 1
fi
export SUPABASE_URL="$URL"

# --list 不需要凭证
case " $* " in
  *" --list "*)
    echo "抓取范围核对模式（URL: $URL｜无需凭证）"
    node scripts/sync-liquipedia-cache.js --list
    exit 0
    ;;
esac

# 取 service_role key：优先环境变量，否则隐藏输入
if [ -z "$SUPABASE_SERVICE_KEY" ]; then
  printf '请粘贴 service_role key（输入不回显，粘贴后直接回车）:\n> '
  # ★ 必须 `|| true`：`set -e` 下 read 遇 EOF（用户直接回车/无输入）会返回非零，
  #   导致脚本**静默中断**，下面的明确报错永远打不出来。
  read -s SUPABASE_SERVICE_KEY || true
  echo
fi

if [ -z "$SUPABASE_SERVICE_KEY" ]; then
  echo "❌ 未提供 SUPABASE_SERVICE_KEY" >&2
  exit 1
fi
export SUPABASE_SERVICE_KEY

echo "项目 URL : $URL"
echo "仓库根   : $ROOT"
echo "开始灌表（209 条 × 2.2s 限流，约 8 分钟）..."
echo

node scripts/sync-liquipedia-cache.js
