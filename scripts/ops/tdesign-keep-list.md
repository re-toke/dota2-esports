# TDesign 组件保留清单（主包瘦身配置依据）

> 最后更新：2026-08-23
> 配套文件：`project.config.json` 的 `packOptions.ignore`

## 背景

主包体积超限（2359KB > 2048KB）根因是 `miniprogram_npm/tdesign-miniprogram/` 打进了全量 103 个组件，但实际只使用 9 个。通过 `packOptions.ignore` 排除未引用组件实现瘦身。

## 保留清单（15 个目录，禁止加入 ignore）

### 直接使用（9 个）
扫描 `pages/`、`subpackages/`、`components/`、`app.json` 的 `usingComponents` 得出。

| 组件 | 使用方 |
|---|---|
| `avatar` | teams、team-detail |
| `button` | leagues、teams、follow、league-detail、match-detail、team-detail、empty-state |
| `collapse` | h2h |
| `collapse-panel` | h2h |
| `empty` | leagues、follow、search、league-detail、match-detail、team-detail |
| `icon` | 全部主包页面 + 多数分包页面 + empty-state |
| `search` | index、leagues、teams、search、hero、item |
| `skeleton` | leagues、teams、index、league-detail、match-detail、team-detail、hero、hero-detail、item、item-detail |
| `tag` | leagues |

### 传递依赖（4 个）
通过递归读取组件内部的 `usingComponents` 得出——删除任何一个都会导致「Component is not found」。

| 组件 | 被谁依赖 |
|---|---|
| `badge` | avatar |
| `image` | avatar、empty、cell |
| `loading` | button、image |
| `cell` | collapse-panel、search |

### 共享基础（3 个）
| 目录 | 作用 |
|---|---|
| `common` | 多个组件代码引用的共享模块 |
| `mixins` | 组件 mixin，保守保留 |
| `miniprogram_npm` | **★ 关键：tdesign 组件运行所需的第三方依赖**（tslib、dayjs、marked、tinycolor2），共 ~121KB。组件 `require('tslib')` 即从此处解析。**禁止排除！** |

## 未保留但存在磁盘上的目录（80 个已加入 ignore）

action-sheet, attachments, avatar-group, back-top, calendar, cascader, cell-group, chat-actionbar, chat-content, chat-list, chat-loading, chat-markdown, chat-message, chat-sender, chat-thinking, checkbox, checkbox-group, check-tag, col, color-picker, config-provider, count-down, date-time-picker, dialog, divider, drawer, dropdown-item, dropdown-menu, fab, footer, form, form-item, grid, grid-item, guide, image-viewer, indexes, indexes-anchor, input, link, locale, message, message-item, navbar, notice-bar, overlay, paragraph, picker, picker-item, popover, popup, progress, pull-down-refresh, qrcode, radio, radio-group, rate, result, row, scroll-view, segmented, side-bar, side-bar-item, slider, step-item, stepper, steps, sticky, swipe-cell, swiper, swiper-nav, switch, tab-bar, tab-bar-item, table, tab-panel, tabs, text, textarea

## 新增组件自查清单（重要）

**当你给某个页面新增 tdesign 组件时，必须执行以下步骤：**

1. 在该页面的 `.json` 文件 `usingComponents` 里声明组件
2. 打开 `project.config.json`，在 `packOptions.ignore` 数组里**删除**对应组件的条目
3. 检查新组件是否有传递依赖（查看 `miniprogram_npm/tdesign-miniprogram/<组件名>/<组件名>.json` 的 `usingComponents`），把传递依赖也从 ignore 里移除
4. 在本文件的「直接使用」或「传递依赖」表格里补充记录

**否则**：本地预览正常（磁盘文件完整），但上传后真机运行会报「Component is not found」。

## 如何重新生成 ignore 清单

如果 tdesign 升级后目录结构变化，可以用以下命令重新生成清单：

```bash
# 1. 扫描实际使用的组件（直接引用）
grep -rh "tdesign-miniprogram/" --include="*.json" pages/ subpackages/ components/ app.json \
  | grep -oE "tdesign-miniprogram/[^/\" ]+" | sed 's#tdesign-miniprogram/##' | sort -u

# 2. 递归解析传递依赖（需手动查每个组件的 usingComponents）

# 3. 生成排除清单（保留 - 实际全部）
KEEP="avatar badge button cell collapse collapse-panel common empty icon image loading mixins search skeleton tag <新增>"
all=$(ls -d miniprogram_npm/tdesign-miniprogram/*/ | sed 's#miniprogram_npm/tdesign-miniprogram/##;s#/##')
for d in $all; do
  if ! echo " $KEEP " | grep -q " $d "; then echo "$d"; fi
done
```
