# Iron Wing vs Spirit BO3 拆分根因 G 诊断与修复报告

> 2026-08-22 下午 · 第七轮根治 · 基于真实 OpenDota API 数据

## 一、前六轮失败的根本原因

| 轮次 | 假设的根因 | 实际验证 |
|------|-----------|---------|
| 1-6 | series_id=0、跨 UTC 日兜底键、云函数 query 缺字段、Steam LIVE 残留、跨源 keyOf 分桶、patchNullSeriesId early return | 所有诊断脚本都用**假设数据**，未抓真实 API |

**核心教训**：前六轮一直在猜数据源返回了什么，从未实际抓数据验证假设。

## 二、真实数据（2026-08-22 实测）

### OpenDota API 调用
- 端点：`https://api.opendota.com/api/leagues/19719/matches`
- TI 2026 主赛事 league_id = **19719**
- 返回 **136 场**，但 **`radiant_team_name` 和 `dire_team_name` 全部为 null**！

### Iron Wing vs Spirit 真实对局（仅 2 条）

| 字段 | 局 1 | 局 2 |
|------|------|------|
| match_id | 8955197224 | 8955247801 |
| **series_id** | **null** | **1132142** |
| **series_type** | **null** | **1 (BO3)** |
| radiant_team_id | 7119388 (Spirit) | 10150413 (Iron Wing) |
| dire_team_id | 10150413 (Iron Wing) | 7119388 (Spirit) |
| radiant_win | true (Spirit 赢) | false (Spirit 赢) |
| start_time (UTC) | 02:36 | 04:12 |

### 队 ID → 队名映射（实测）

| team_id | name |
|---------|------|
| 10150413 | **Iron Wing** |
| 7119388 | **Team Spirit** |
| 2163 | Team Liquid |
| 8255888 | BoomBoys |
| 10136357 | Nigma Galaxy |
| ... | （共 16 支队伍） |

## 三、真正的根因 G

**OpenDota 对同一 BO3 的两局分配不一致**：
- 局 1：`series_id=null, series_type=null`
- 局 2：`series_id=1132142, series_type=1`

**原 `patchNullSeriesId` 两道约束在此场景全部失败**：

1. **约束②（邻居 count≥2）失败**：局 2（有效 sid）的 count=1（仅此一条记录属于 sid=1132142）→ 被旧约束排除出 `qualified` 邻居清单 → 局 1 借不到邻居
2. **约束③（前后 30min 窗）失败**：即使放宽 count≥1，局 1（02:36）在邻居（04:12）**之前 1.6h** → 超出旧前侧 30min 容差 → 时间窗校验失败

→ 两局各自独立成卡 → 用户看到两张 BO1。

## 四、修复（utils/sources.js `patchNullSeriesId`）

### 改动 1：放宽合格邻居约束
```js
// 原：series_type≥1 + count≥2
if (s.seriesType != null && s.seriesType >= 1 && s.count >= 2 && ...)

// 新：series_type≥1 + count≥1
if (s.seriesType != null && s.seriesType >= 1 && s.count >= 1 && ...)
```

**理由**：`series_type>=1` 已足够区分 BO1（独立）与 BO3/BO5（需合并）；OpenDota 数据延迟或异常可能让邻居暂时只有 1 局。

### 改动 2：双向对称 6h 时间窗
```js
// 原：前 30min、后 30min
const TOL_SEC = 30 * 60;
if (nStart < q.first - TOL_SEC || nStart > q.last + TOL_SEC) continue;

// 新：双向对称 6h
const WINDOW_SEC = 6 * 3600;
if (nStart < q.first - WINDOW_SEC || nStart > q.last + WINDOW_SEC) continue;
```

**理由**：BO3 两局间隔通常 1-2h，但 OpenDota 的 null 局可能排在前面或后面，且数据延迟可达数小时。6h 上限足以覆盖 BO3 局间最长 5h + 数据延迟，同时排除「跨日独立场次」（间隔 >6h）。

### 防误并保护
- ✅ 必须同队ID 对（不计顺序，BO3 会换边）
- ✅ 必须有 `series_type≥1`（BO3/BO5）；BO1（series_type=0）邻居永不借
- ✅ 时间窗 6h 上限排除跨日场次

## 五、验证结果

### 新增诊断脚本（基于真实数据）
`scripts/test/test-iron-wing-real-data.js`：
- ✅ Iron Wing vs Spirit BO3 合并为 1 张卡（Spirit 2:0 Iron Wing）
- ✅ 回归 A：间隔 >6h 的两场独立 BO1 不误并
- ✅ 回归 B：无关 BO1（series_type=null）不被并入其他 BO3 系列

### 全套 17 套测试零回归
| 测试套件 | 结果 |
|---------|------|
| test-sources | 46/46 ✅ |
| test-consensus | 18/18 ✅ |
| test-canonical | 58/58 ✅ |
| test-bo | 120/120 ✅（含更新的 T40④ 与新增 T40④b）|
| test-formatters | 37/37 ✅ |
| test-incremental | 15/15 ✅ |
| test-remote-curation | 11/11 ✅ |
| test-search-history | 8/8 ✅ |
| test-iron-wing-real-data | 全通过 ✅ |
| test-iron-wing-buildseries | 全通过 ✅ |
| test-iron-wing-diagnosis | 全通过 ✅ |
| test-bo3-split-fix | 14/14 ✅ |
| test-patch-null-diagnosis | 全通过 ✅ |
| test-v3-series-id | 6/6 ✅ |
| test-phase-inference | 6/6 ✅ |
| test-steam-live-phase | 8/8 ✅ |
| test-logo-persist | 5/5 ✅ |
| **合计** | **313+ 条断言零失败** |

## 六、改动文件清单

| 文件 | 改动 |
|------|------|
| `utils/sources.js` | `patchNullSeriesId`：count≥2 → count≥1，前后容差 → 双向 6h |
| `scripts/test/test-bo.js` | 更新 T40④（旧约束已失效）+ 新增 T40④b（BO1 单局邻居不并） |
| `scripts/test/test-iron-wing-real-data.js` | 新增：基于真实数据验证根因 G |

## 七、用户操作

⚠️ **本轮修复在客户端 `utils/sources.js`，无需重新部署云函数**。

1. 清缓存重新编译小程序
2. 进入 TI 2026 详情页验证 Iron Wing vs Spirit 已合并为单张 BO3 卡（比分 Spirit 2:0 Iron Wing）

## 八、新增工程铁律

> **BO 类拆分 bug 必须先抓真实 API 数据再下结论，禁止用假设数据写诊断脚本。**

前六轮的失败教训：诊断脚本里用「假设两局都 series_id=0」「假设两局时间相邻」等假数据，无论怎么修代码都通不过真实场景。第七轮直接 `https.get` 真实 API 才发现：
1. 队名全 null（之前以为有队名）
2. 两局 sid 一 null 一有效（之前以为同 sid）
3. null 局在有效局之前 1.6h（之前以为时间相邻或在后）
