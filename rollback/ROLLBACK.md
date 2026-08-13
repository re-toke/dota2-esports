# 回滚说明 — pre-spotlight-ui-2026-08-09

> **回滚点名称**：`rollback/pre-spotlight-ui-2026-08-09`
> **创建时间**：2026-08-09 14:40
> **基线提交**：`fdeb85c`（feat/bo-opt 分支，chore(ui): 暖灰方案 B+D 落地 + 设计规范 v11）
> **回滚点内容**：UI「黑暗赛场聚光灯」迭代实施前的完整项目状态（暖灰方案 B+D 已落地 + 设计规范文档 v11 + 背景素材）

---

## 回滚点内容

| 项目 | 说明 |
|------|------|
| Git tag | `rollback/pre-spotlight-ui-2026-08-09`（annotated） |
| Zip 备份 | `rollback/pre-spotlight-ui-2026-08-09.zip`（1.98MB，git archive 不含 node_modules / miniprogram_npm） |
| 基线 commit | `fdeb85c` — 暖灰方案全量 wxss + 设计规范 v11 + assets 背景图 |
| 分支 | `feat/bo-opt`（纯本地，无 remote） |

## 回滚方式

### 方式 A：git 分支回滚（推荐，保留 git 历史）

```bash
# 1. 确保工作区干净或已 stash
# 2. 回到基线提交（保留后续提交为可恢复状态）
git checkout fdeb85c

# 3. 如要彻底放弃聚光灯实施，可硬重置分支（慎用，会丢未推送提交）
git reset --hard fdeb85c
```

### 方式 B：git tag 恢复

```bash
git checkout rollback/pre-spotlight-ui-2026-08-09
```

### 方式 C：zip 解包恢复（node_modules 需重新构建）

```bash
# 1. 备份当前损坏/不满意的目录
# 2. 解包 zip（不含 node_modules / miniprogram_npm）
unzip rollback/pre-spotlight-ui-2026-08-09.zip -d <项目目录>

# 3. 重建 npm 依赖（如缺失）
#    - npm install（若报"up to date"用 npm ci 严格重建）
#    - 复制 tdesign：cp -r node_modules/tdesign-miniprogram/miniprogram_dist/. miniprogram_npm/tdesign-miniprogram/
#    - 微信开发者工具「构建 npm」
```

### 方式 D：单文件恢复

只想回滚某个文件的修改时：
```bash
git checkout fdeb85c -- <文件路径>
```

---

## ⚠️ 注意事项

1. **zip 不含** `node_modules/` 和 `miniprogram_npm/`（git archive 默认排除）——解包后需按记忆中的步骤重建（npm ci + cp tdesign + 构建 npm）
2. **CRLF/LF**：若 husky 拦提交，检查是否因换行符不一致导致；sync 产物须 `cp` 字节拷贝
3. **中文长路径**：git 操作一律 `git -C "<绝对路径>"`，禁用 `git rm`/`npm run`
4. **紧急绕行**：husky pre-commit 失败可 `--no-verify`（不推荐）
5. 回滚成功后建议删除/重命名当前失败的聚光灯提交，避免混淆

---

## 回滚点历史

| 日期 | 回滚点 | 说明 |
|------|--------|------|
| 2026-08-05 | `rollback/bo-opt-complete-2026-08-05`（已删除） | BO 判定引擎 v2.1 完成 |
| 2026-08-09 | `rollback/pre-spotlight-ui-2026-08-09` | 聚光灯 UI 实施前（当前） |
