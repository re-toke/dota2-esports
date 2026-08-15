# 回滚说明 — pre-p3-2026-08-15

> **回滚点名称**：`rollback-pre-p3-2026-08-15`
> **创建时间**：2026-08-15 14:10
> **基线提交**：`c5fbc00`（master，v3 优化 P0/P1/P2 全落地：O-1~O-18 + O-26/O-27，6 提交链）
> **回滚点内容**：P3 架构专项（O-19~O-25：三大文件拆分/页面收敛/组件抽取）实施前的完整项目状态

---

## 回滚点内容

| 项目 | 说明 |
|------|------|
| Git tag | `rollback-pre-p3-2026-08-15`（annotated，连字符防斜杠失效） |
| Zip 备份 | `rollback/pre-p3-2026-08-15.zip`（4.1MB，git archive 不含 node_modules / miniprogram_npm） |
| 基线 commit | `c5fbc00` — O-27 全局错误兜底（v3 P0/P1/P2 终态） |
| 分支 | `master`（纯本地，无 remote） |

## 回滚方式

### 方式 A：git 分支回滚（推荐，保留 git 历史）

```bash
# 1. 确保工作区干净或已 stash
# 2. 回到基线提交（保留后续提交为可恢复状态）
git checkout c5fbc00

# 3. 如要彻底放弃 P3 实施，可硬重置分支（慎用，会丢未推送提交）
git reset --hard c5fbc00
```

### 方式 B：git tag 恢复

```bash
git checkout rollback-pre-p3-2026-08-15
```

### 方式 C：zip 解包恢复（node_modules 需重新构建）

```bash
# 1. 备份当前损坏/不满意的目录
# 2. 解包 zip（不含 node_modules / miniprogram_npm）
unzip rollback/pre-p3-2026-08-15.zip -d <项目目录>

# 3. 重建 npm 依赖（如缺失）
#    - npm install（若报"up to date"用 npm ci 严格重建）
#    - 复制 tdesign：cp -r node_modules/tdesign-miniprogram/miniprogram_dist/. miniprogram_npm/tdesign-miniprogram/
#    - 微信开发者工具「构建 npm」
```

### 方式 D：单文件恢复

只想回滚某个文件的修改时：
```bash
git checkout c5fbc00 -- <文件路径>
```

---

## ⚠️ 注意事项

1. **zip 不含** `node_modules/` 和 `miniprogram_npm/`（git archive 默认排除）——解包后需按记忆中的步骤重建（npm ci + cp tdesign + 构建 npm）
2. **CRLF/LF**：若 husky 拦提交，检查是否因换行符不一致导致；sync 产物须 `cp` 字节拷贝
3. **中文长路径**：git 操作一律 `git -C "<绝对路径>"`，禁用 `git rm`/`npm run`
4. **紧急绕行**：husky pre-commit 失败可 `--no-verify`（不推荐）
5. 回滚成功后建议删除/重命名当前失败的 P3 提交，避免混淆
6. **P3 专项特殊提醒**：O-19/O-20/O-21 是三大文件拆分，若单文件拆分出错，优先用方式 D 精准回滚该文件，不必整体回滚

---

## 回滚点历史

| 日期 | 回滚点 | 说明 |
|------|--------|------|
| 2026-08-15 | `rollback-pre-p3-2026-08-15` | P3 架构专项实施前（当前，c5fbc00） |
| 2026-08-15 | `rollback-post-release-fixes-2026-08-15`（tag 保留，zip 已删） | 8-13/14 上线后修复汇总后 |
| 2026-08-09 | `rollback/pre-spotlight-ui-2026-08-09`（zip 保留） | 聚光灯 UI 实施前 |
