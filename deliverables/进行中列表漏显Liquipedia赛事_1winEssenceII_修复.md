# 赛事列表「进行中」tab 漏显 Liquipedia 进行中赛事 — 修复报告

> 现象：赛事列表「进行中」tab 中未显示 `1win Essence II`，但 Liquipedia 上该赛事正在进行（2026-07-30 – 2026-08-05）。

## 一、排查三个假设

| 假设 | 结论 | 证据 |
|---|---|---|
| ① 状态字段未正确映射为"进行中" | ✅ **是根因** | 见下「根因」 |
| ② Liquipedia 页面结构/格式变化导致解析失败 | ❌ 非根因 | 事件已正确入库：`utils/upcoming-local.json` 与云缓存 `upcoming_schedule` 均含 `1win Essence II`（start/end 完整、A 级）。说明 Portal 解析正常，问题在下游管道。 |
| ③ 比赛名称匹配规则未覆盖 `1win Essence II` | ❌ 非根因 | `utils/tiers.js:38` 正则 `/1win\s+(series|essence|duel|standoff|motion)/i` 已覆盖；快照与云缓存均带正确名与 A 级。 |

## 二、根因（两层）

### 架构缺口
赛事列表有三个 tab：**全部 / 进行中 / 即将到来**。
- 「进行中」tab 的数据**只来自 `allLeagues`**（OpenDota `/leagues` + explorer 时间窗口）。
- Liquipedia 赛程（`upcoming-local.json` + 云缓存 `upcoming_schedule`）**只喂「即将到来」tab**（变量 `upcomingList`）。

→ Liquipedia 独有、OpenDota 尚无比赛记录的进行中赛事，天然无法进入「进行中」tab。

### 管道缺陷（让事件从两侧同时消失）
1. `tryCloudUpcoming` / `tryLocalUpcoming` 的过滤条件为 `start > now`：要求"开赛时间必须在未来"。
   `1win Essence II` 今天（2026-07-30 00:00 UTC）已开赛，`now` 已越过该值 → **被剔除出 `upcomingList`**，于是「即将到来」tab 也没有它。
2. `buildUpcomingCard` 把卡片 `status` 硬编码为 `'upcoming'`，即便事件被保留，也永远无法带"进行中"徽标；且「进行中」tab 从不读取 `upcomingList`。

结果：`1win Essence II` 既不在「进行中」也不在「即将到来」，连「全部」都看不到。

### 次级隐患（假设②的变体）
云函数 `fetchLiquipediaUpcoming` **只读 Liquipedia Portal 的 `Upcoming` 段**。赛事开赛后 Liquipedia 会把它从 `Upcoming` 移到 `Ongoing` 段 → 云缓存（6h TTL 刷新后）会丢失进行中赛事。本地快照 `upcoming-local.json` 仍含它，所以回退路径可兜底，但云路径本身不健壮。

## 三、修复

### `pages/leagues/leagues.js`（纯客户端，无需重部署）
- 新增 `upcomingCardStatus(entry, now)`：按日期窗口判定 `ongoing`（窗口内 + 1 天宽限，与 `util.isOngoing` 路径②口径一致）/ `upcoming`。
- `buildUpcomingCard` / `mergeCurationUpcoming`：用真实状态设置 `status / statusText / statusColor / countdownText`（进行中显示"进行中"）。
- `tryCloudUpcoming` / `tryLocalUpcoming`：过滤改为 `start <= horizon && (!end || end >= now)`——保留"未结束"的赛事（含已开赛的进行中），只丢弃已结束。
- `applyAndSlice`：
  - **「进行中」tab**：在 `allLeagues` 的进行中赛事基础上，合并 `upcomingList` 中 `status==='ongoing'` 且不在 `allLeagues` 的条目（按 leagueid 去重 + `dedupeByDisplayName`）。
  - **「即将到来」tab**：仅显示 `status==='upcoming'`，避免进行中赛事重复出现。
- 新增 `mergeLocalSnapshot(results, now)`：云路径下回退读取 `upcoming-local.json`，兜底保证进行中赛事进入赛程列表（部署新云函数前尤其关键）。

### `cloudfunctions/aggregation/index.js`（需重部署云函数）
- `fetchLiquipediaUpcoming` 现**同时抓取 `Upcoming` 与 `Ongoing` 两个 Portal 段落**，合并去重。进行中赛事不再因"移段"而从云缓存消失。

## 四、验证
以当前时间（2026-07-30 10:16 UTC）跑快照数据：
```
KEEP ongoing  2026-07-26 ~ 2026-08-12  EPL Masters I
KEEP ongoing  2026-07-30 ~ 2026-08-05  1win Essence II   ✅ 现归入「进行中」
KEEP upcoming 2026-07-31 ~ 2026-08-05  Games of the Future 2026
DROP upcoming 2026-07-20 ~ 2026-07-25  EPL Masters I: Play-In  （已结束，正确剔除）
```
`node --check` 通过 `leagues.js` 与 `aggregation/index.js`。

## 五、你需要知道
- **客户端修复已生效**，开发者工具重新编译即可验证：切到「进行中」tab 应能看到 `1win Essence II`（带"进行中"绿色徽标）。
- **云函数改动需重部署**（`wx cloud deploy` / 控制台上传）后，云缓存路径才会包含进行中赛事；在此之前本地快照兜底已保证显示。
- 本次同时让 `EPL Masters I` 等"已开赛但 OpenDota 窗口未判定"的赛事更稳地出现在「进行中」。
