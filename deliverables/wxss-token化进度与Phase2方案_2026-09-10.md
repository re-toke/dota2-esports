# P3 wxss 字面量 token 化 · 进度与方案（2026-09-10）

> 目标：为暗色模式 v1.2 专项打底 —— 所有颜色走 `var()` token
> 工具：`npm run audit:colors` / `tokenize:colors` / `verify:tokenize`

---

## 一、进度

| 阶段 | 硬编码处数 | 受影响文件 | 说明 |
|---|---|---|---|
| 初始 | 583 | 24 | 口径修正后（原报 774 含 var fallback 与块注释误计） |
| **Phase 1** ✅ | **280** | 21 | 替换 312 处 |
| **Phase 2** ✅ | **207** | **18** | 新增 22 个语义 token，替换 74 处 |
| 有意保留 | 207 | 18 | 见第四节（半透明装饰色 + 单次使用色） |

**累计：583 → 207（-64.5%）**

**两阶段均通过等价性验证**（色值多重集完全一致）→ 像素级等价，零视觉变化。

---

## 二、Phase 2 已完成内容

### 范围划分原则（按「是否主题相关」，而非按处数）

| 类别 | 值数 / 处数 | 处理 | 理由 |
|---|---|---|---|
| **A. 黑 tint** | 8 / 25 | ✅ 新增 `--overlay-02..12` + `--scrim-40` | **暗色模式必需**：极淡黑用于 hover/微底纹，暗色下「黑叠黑」完全不可见 → 交互反馈消失 |
| **B. 不透明语义色（≥2 处）** | 13 / 47 | ✅ 新增 14 个 token | 复用色，且不透明 → 主题相关 |
| C. 单次使用装饰色 | 21 / 21 | ⏸ 保留 | 只出现一次，token 化只增间接层 |
| D. 半透明装饰色 | 106 / 187 | ⏸ 保留 | **叠在亮/暗底上表现一致 → 主题无关** |

### 新增 token 清单（22 个）

```css
/* 叠加层黑 tint（暗色主题需翻转为白色微透） */
--overlay-02 / 03 / 04 / 05 / 06 / 08 / 12
--scrim-40                                  /* 模态/抽屉遮罩 */

/* 语义色 */
--amber-bright: #ffcf5c;      /* 通用琥珀（≠ --source-liquipedia，语义不同） */
--text-muted:   #9bb0c9;      /* 弱化次要文字（≠ --source-curation，语义不同） */
--link:         #5b9bff;
--slate-deep:   #3a4250;
--slate-text:   #4a525d;
--slate-bar:    #5a6068;
--text-faint:   #c0c4cc;
--text-faint-2: #b9b9b9;
--status-worst:    #e0533d;
--status-negative: #e74c3c;

/* Tier 软底上的深色文字（背景侧 --tier-*-soft 早已存在，此处补齐文字侧） */
--tier-s-text: #7a6520;
--tier-a-text: #3730a3;
--tier-b-text: #1e40af;
--tier-c-text: #374151;
```

---

## 三、✅ 已修：`--fs-title` 未定义引用

`subpackages/detail/league-detail/league-detail.wxss` 的 `.lp-section-title`
原为 `var(--fs-title, 30rpx)` —— `--fs-title` **从未定义**，一直靠 fallback 隐式生效。

已改为 `var(--fs-emphasis)`（值同为 `30rpx`，且其注释即「分区强调标题」，
与 `.lp-section-title` 语义吻合）→ 值不变，消除未定义引用。

**复查结果**：排除注释后，全仓**零未定义 token 引用**。

---

## 四、有意保留的 207 处（说明）

### D. 半透明装饰色（187 处 / 106 值）

主要是**金色 alpha 档位**（`rgba(200,169,81, 0.10~0.6)` 共 15 档）与琥珀 alpha。

**不 token 化的理由**：半透明色与背景**混合**，叠在白色卡上或深色卡上都会得到
「若隐若现的品牌金」——**在亮暗两种主题下语义都成立**，不需要翻转。

> ⚠️ 但这里有个**真正的技术债**：15 档 alpha 明显过多，且**书写不统一**
> （`rgba(200,169,81,0.4)` 与 `rgba(200, 169, 81, 0.4)` 并存）。
> **收敛档位属视觉变更**，需设计确认，不属机械 token 化范围 → 建议列入 v1.2 设计评审。

### C. 单次使用装饰色（21 处 / 21 值）

如 `#66c0f4`（Steam 蓝）、`#d97757`（警告橙）、`#7ee787`（GitHub 绿）等。
只出现一次 → token 化只增加一层间接，收益为负。**若某色后续被复用，届时再提取。**

---

## 五、给暗色模式 v1.2 专项的建议

```
① 定义暗色主题的 token 覆盖（重点：--overlay-* 需翻转为白色微透）
② 逐页回归，重点检查三类语义 token 是否分叉：
   · 背景类：--td-bg-color-page / -container / -component / --card-bg-inset
   · 边框类：--td-border-level-1-color / --td-component-border
   · 文字类：--text-1..4 / --text-muted / --text-faint
③ 处理 --tier-*-text 与 --tier-*-soft 的配对（软底翻转 → 文字色必须同时翻转）
④ box-shadow 策略统一（Phase 3，未逐个 token 化）
```

> ★ 关键提醒：Phase 1/2 后，**同一色值已绑定到不同语义 token**（如 #E5E7EB →
> 边框用 `--td-border-level-1-color`、背景用 `--td-bg-color-component-active`）。
> 暗色主题里这两个**必须分别定义**，否则会「边框和背景同色」导致层次消失 ——
> 这正是当初按 CSS 属性选 token 的原因。

