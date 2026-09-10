# P3 wxss 字面量 token 化 · 进度与 Phase 2 方案（2026-09-10）

> 目标：为暗色模式 v1.2 专项打底 —— 所有颜色走 `var()` token
> 工具：`npm run audit:colors` / `tokenize:colors` / `verify:tokenize`

---

## 一、进度

| 阶段 | 硬编码处数 | 说明 |
|---|---|---|
| 初始 | 583 | 24 个文件（口径修正后；原报 774 含 var fallback 与块注释误计） |
| **Phase 1 已完成** | **280** | 24 → 21 文件（3 个清零），替换 312 处 |
| Phase 2 目标 | ~50 | 新增 token 后替换 |
| Phase 3 | 剩余 | 结构性阴影/遮罩，多数可保留 |

**Phase 1 等价性已验证**：22 文件 / 1314 处色值多重集完全一致 → 像素级等价，零视觉变化。

---

## 二、剩余 280 处的构成（161 个不同色值）

### A. 金色/琥珀 alpha 变体（约 30 处）—— 最高优先

```
rgba(200, 169, 81, 0.10 / 0.12 / 0.16 / 0.35 / 0.4 / 0.5 / 0.55 / 0.6)   ← 品牌金 alpha
rgba(255, 207, 92, 0.12 / 0.3)                                            ← 琥珀 alpha
```

**问题**：8 个不同 alpha 值散落各处，且书写不统一（`rgba(200,169,81,0.4)` 与
`rgba(200, 169, 81, 0.4)` 同值不同写法）。

**Phase 2 方案**：新增一组精确 token（**保持值不变 → 零视觉变化**）

```css
--gold-a10: rgba(200, 169, 81, 0.10);
--gold-a12: rgba(200, 169, 81, 0.12);
/* … 每个实际用到的 alpha 一个 token */
```

> 更进一步可**收敛 alpha 档位**（8 档 → 4 档），但那是**视觉变更**，需设计确认，
> 不属机械 token 化范围。

### B. 近黑 tint（19 处）—— 暗色模式的真实问题

```
rgba(0, 0, 0, 0.02)   11 处
rgba(0, 0, 0, 0.04)    8 处
```

**为什么必须处理**：这是「hover / 微底纹」用的极淡黑。亮色下是隐约的灰，
**暗色下黑叠黑 ≈ 完全不可见** → 交互反馈消失。

**Phase 2 方案**：语义化 token（暗色主题里翻转为白色微透）

```css
--overlay-hover: rgba(0, 0, 0, 0.02);    /* 暗色主题覆盖为 rgba(255,255,255,0.04) */
--overlay-sunken: rgba(0, 0, 0, 0.04);
```

### C. tier 软底深字（约 20 处）—— 已识别语义

```css
.tag-sss / .tag-s { background: #FDF6E3; color: #7A6520; }   ← 浅金底 + 深金字
.tag-a           { background: #EEF0FB; color: #3730A3; }   ← 浅靛底 + 深靛字
.tag-b           { background: #EBF4FE; color: #1E40AF; }   ← 浅蓝底 + 深蓝字
.tag-c           { background: #F1F5F9; color: #374151; }   ← 浅灰底 + 深灰字
```

背景色**已有 token**（Phase 1 已替换），只剩**文字色**没有：

```css
--tier-s-text: #7A6520;
--tier-a-text: #3730A3;
--tier-b-text: #1E40AF;
--tier-c-text: #374151;
```

### D. 其他高频

| 色值 | 处数 | 语义 | 建议 token |
|---|---|---|---|
| `#ffcf5c` | 7 | 通用琥珀（分隔条/质量点/边框） | `--amber-bright` |
| `#9bb0c9` | 4 | 弱化次要文字 | `--text-muted` |
| `#3a4250` | 4 | 深灰蓝文字 | 待定（先看用法） |
| `#5b9bff` | 4 | 亮蓝链接 | `--link` |
| `#c0c4cc` | 3 | 浅灰分隔 | 待定 |

---

## 三、Phase 2 执行方式（与 Phase 1 同款，零风险）

1. 在 `app.wxss` 的 token 区**新增**上述 token（原值原样，不改动已有 token）
2. 把它们加入 `tokenize-wxss-colors.js` 的 `MAP`
3. `npm run tokenize:colors`（干跑）→ 检查无「被拒绝」项
4. `npm run tokenize:colors:apply`
5. **`npm run verify:tokenize`** ← 必须通过（色值多重集一致）
6. 提交

> 因为新增 token 的值 = 被替换字面量的值，**依然是像素级等价**。

---

## 四、⚠️ 已知遗留（不在 token 化范围，但建议单独处理）

| # | 问题 | 影响 |
|---|---|---|
| 1 | **`--border` 未定义**（`pages/search`、`h2h` 各 1 处 `var(--border, #E5E7EB)`） | Phase 1 已把这两处整体替换为 `var(--td-border-level-1-color)`，**已消除** |
| 2 | **`--fs-title` 被引用但未定义**（1 处） | 该处 `font-size` 不生效，回退继承 → 字号可能不符预期，**建议定位修正** |
| 3 | `--bg-2` 曾是未定义 token | 已于 v8.31 修为 `--td-bg-color-component` |

---

## 五、Phase 3（结构性，可保留）

低 alpha 的阴影/遮罩（`rgba(0,0,0,0.06~0.2)` 用于 `box-shadow`）：
- 亮色下是投影，暗色下投影本就该更重或不需要
- **建议**：不逐个 token 化，而在暗色专项里统一处理 `box-shadow` 策略

---

## 六、给暗色模式专项的建议顺序

```
① Phase 2（新增 token + 替换）           ← 本文档
② 处理 --fs-title 未定义（遗留 #2）
③ 建立暗色 token 覆盖（theme.json 或媒体查询）
④ 逐页回归（重点：卡片/文字/边框三类语义 token 是否分叉）
```

> 关键提醒：Phase 1/2 后，**同一色值已绑定到不同语义 token**（如 #E5E7EB →
> 边框用 `--td-border-level-1-color`、背景用 `--td-bg-color-component-active`）。
> 暗色主题里这两个必须分别定义，否则会「边框和背景同色」导致层次消失。
