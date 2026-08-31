# 回滚说明 — rollback-v8.1-stratz-haglund-2026-08-31

> **回滚点名称**：`rollback-v8.1-stratz-haglund-2026-08-31`
> **创建时间**：2026-08-31 11:29
> **基线提交**：`52b65ed`（master，v8.0 UI 全面改版 + v8.1 STRATZ 启用 + haglund 容灾强化）
> **测试基线**：全套 329/0 全绿（8 件套 313 + haglund 熔断器 16）

---

## 回滚点内容

| 项目 | 说明 |
|------|------|
| Git tag | `rollback-v8.1-stratz-haglund-2026-08-31`（annotated，连字符防斜杠失效） |
| Zip 备份 | `rollback/rollback-v8.1-stratz-haglund-2026-08-31.zip`（8.5MB，git archive 不含 node_modules / miniprogram_npm） |
| 基线 commit | `52b65ed` — v8.0 UI 全面改版（HEAD） |
| Tag object | `54bd089`（tag → commit `52b65ed`） |
| 分支 | `master`（纯本地，无 remote） |

## 回滚方式

### 方式 A：git 分支回滚（推荐，保留 git 历史）

```bash
# 1. 确保工作区干净或已 stash
# 2. 回到基线提交（保留后续提交为可恢复状态）
git checkout 52b65ed

# 3. 如要彻底放弃后续提交，可硬重置分支（慎用，会丢未推送提交）
git reset --hard 52b65ed
```

### 方式 B：git tag 恢复

```bash
git checkout rollback-v8.1-stratz-haglund-2026-08-31
```

### 方式 C：zip 解包恢复（node_modules 需重新构建）

```bash
# 1. 备份当前损坏/不满意的目录
# 2. 解包 zip（不含 node_modules / miniprogram_npm）
unzip rollback/rollback-v8.1-stratz-haglund-2026-08-31.zip -d <项目目录>

# 3. 重建 npm 依赖（如缺失）
#    - npm install（若报"up to date"用 npm ci 严格重建）
#    - 复制 tdesign：cp -r node_modules/tdesign-miniprogram/miniprogram_dist/. miniprogram_npm/tdesign-miniprogram/
#    - 微信开发者工具「构建 npm」
```

### 方式 D：单文件恢复

只想回滚某个文件的修改时：
```bash
git checkout 52b65ed -- <文件路径>
```

---

## ⚠️ 注意事项

1. **zip 不含** `node_modules/` 和 `miniprogram_npm/`（git archive 默认排除）——解包后需按记忆中的步骤重建（npm ci + cp tdesign + 构建 npm）
2. **CRLF/LF**：若 husky 拦提交，检查是否因换行符不一致导致；sync 产物须 `cp` 字节拷贝
3. **中文长路径**：git 操作一律 `git -C "<绝对路径>"`，禁用 `git rm`/`npm run`
4. **紧急绕行**：husky pre-commit 失败可 `--no-verify`（不推荐）

---

## 回滚点历史

| 日期 | 回滚点 | 说明 |
|------|--------|------|
| 2026-08-31 | `rollback-v8.1-stratz-haglund-2026-08-31` | **当前**：v8.1 STRATZ 启用 + haglund 容灾 + v8.0 UI 改版（52b65ed） |
| 2026-08-15 | `rollback/pre-p3-2026-08-15.zip`（zip 保留，tag 已删） | P3 架构专项实施前（c5fbc00） |
| 2026-08-09 | `rollback/pre-spotlight-ui-2026-08-09.zip`（zip 保留） | 聚光灯 UI 实施前 |

---

## 历史回滚记录

### 2026-08-20 · PRD v1.6 编辑部改版失败 → 恢复 UI 更新前

> **回滚动作**：`git reset --hard 9588fa5`（UI 改版前最后稳定版）
> **回滚原因**：PRD v1.6《赛事日历·编辑部》改版失败，需恢复上个版本保证功能可用
> **失败状态保护**：`rollback-failed-v16-2026-08-20`（annotated tag → c8a359f，含全部 v1.6 提交链，可随时找回）

找回 v1.6 状态：
```bash
git checkout rollback-failed-v16-2026-08-20
```
