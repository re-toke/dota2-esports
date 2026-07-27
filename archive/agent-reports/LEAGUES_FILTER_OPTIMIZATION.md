# 赛事筛选「显示不全」优化方案（leagues 页）

**范围**：`pages/leagues` 的 6 个筛选项 —— 全部 / 正在进行 / 即将到来 / 已结束（4 个 Tab）+ 智能 / 时间（2 个排序 chip）。
**目标**：确保每个筛选条件下，所有符合条件的赛事都能完整展示，无漏显、无"在 A Tab 看到、切 B Tab 消失"的异常。

> 说明：本方案基于实际代码（`pages/leagues/leagues.js` + `utils/util.js` + `utils/config.js` + `utils/api.js`）定位根因，**非泛泛而谈**。下文的行号以当前 `leagues.js` 为准。

---

## 一、问题定位方法（先量化，再修）

1. **真机/模拟器对照法**：在开发者工具真机预览里，分别点 全部/正在进行/即将到来/已结束 4 个 Tab，对照 OpenDota 实际赛事数，记录"应该显示但没显示"的赛事名。
2. **漏斗埋点法**：在 `applyAndSlice`（leagues.js L747）各分支加一行日志，量化每个 Tab 的输入/输出：
   ```js
   console.log('[filter]', f, 'grade=', gf,
     'all=', (this.allLeagues||[]).length,
     'upcoming=', (this.upcomingList||[]).length,
     'out=', arr.length);
   ```
   重点看三个线索：
   - 切到「全部」后，「即将到来」里看到的赛事是否消失 → 验证 RC1；
   - 近 1–7 天内结束的赛事，在「已结束」Tab 是否缺失 → 验证 RC2；
   - 某 Tab 结果 >30 条时，滚动到底 `page` 是否递增 → 验证 RC4。
3. **纯函数单测法**：把筛选/合并逻辑抽成纯函数（见第四节），用 fixture 断言各 Tab 数量与去重正确，CI 可回归。

---

## 二、根因与修复策略（按优先级）

### P0-1｜RC1：「全部」Tab 不含「即将到来」赛事（数据源割裂）—— 最可能造成"显示不全"的体感 ✅ 已修复（2026-07-26）

- **现象**：在「即将到来」看到的未来赛事（OpenDota 暂无比赛记录，靠 curation/外部源补充），切到「全部」后不见了。
- **根因**：`leagues.js` 有**两个互斥的数据集**：
  - `this.allLeagues`（L173/L260）：来自 `api.getLeagues()`（OpenDota `/leagues` + 近 1 年时间窗口），只含**已开赛/有比赛记录**的 S/A/B 级联赛；
  - `this.upcomingList`（L175/L513 等）：来自 `loadUpcoming()`，含**未来 180 天内开赛、OpenDota 暂无比赛**的赛事 + curation 补充。
  - `applyAndSlice` 的 `all` 分支（L765-767）**只用了 `allLeagues`**，与 `upcomingList` 完全独立 → 「全部」永远看不到未来赛事。
- **修复**：「全部」= 已开赛赛事 ∪ 即将到来赛事（按 `leagueid` 去重，未来赛事优先，避免纯未来联赛被 `allLeagues` 误判成 `ended`）：
  ```js
  } else {
    // 全部 = 已开赛赛事 ∪ 即将到来赛事；未来赛事优先（其开赛日期更准确）
    const seen = {};
    const merged = [];
    (this.upcomingList || []).forEach((u) => { seen[u.leagueid] = true; merged.push(u); });
    (this.allLeagues || []).forEach((x) => { if (!seen[x.leagueid]) merged.push(x); });
    arr = merged.filter(gradeMatch);
  }
  ```
  > 注：`upcomingList` 含 curation 的负数 `fakeId`，与真实 `leagueid` 不会冲突，去重安全。

### P0-2｜RC2/RC3：「已结束」Tab 双条件冲突，漏掉近 7 天结束的赛事 ✅ 已修复（2026-07-26）

- **现象**：最近 1–7 天内打完的赛事，在「已结束」Tab 看不到（只在「全部」能看到）。
- **根因**：`applyAndSlice` 的 `ended` 分支（L761-764）：
  ```js
  const cutoff = Date.now() / 1000 - 7 * 86400;
  arr = (this.allLeagues || []).filter((x) => x.status === 'ended' && (x.latest || 0) < cutoff && gradeMatch(x));
  ```
  它**同时**要求 `status==='ended'` 与 `latest < now-7d`。而 `status` 由 `util.statusOf`（util.js L117）计算，`isOngoing`（L92）已用 `lastEnd`（真实结束时间）+ 2h buffer 把"已结束"判好。于是：
  - 一个 3 天前打完的赛事：`status==='ended'` 成立，但 `latest`（最后一场**开赛**时间）≈ `now-3d`，**不小于** `now-7d` → 被 `latest < cutoff` 拦掉 → **既不在「正在进行」也不在「已结束」，直接从这两个 Tab 消失**。
  - 另外口径打架：`statusOf` 用 `lastEnd` 判进行中，ended 分支却用 `latest` 判已结束，二者不是同一时间基准。
- **修复**：去掉冗余 cutoff，直接信任 `status`（LEAGUE_WINDOWS_SQL 已限定近 1 年窗口，`allLeagues` 本身即 1 年内，无需再 cutoff）：
  ```js
  } else if (f === 'ended') {
    arr = (this.allLeagues || []).filter((x) => x.status === 'ended' && gradeMatch(x));
  }
  ```
  > 若想保留"只显示近期结束"的边界，应改用 `lastEnd`（与 `statusOf` 一致），而非 `latest`。

### P1｜RC4：分页触底不灵敏，后续页不加载 ✅ 已修复（2026-07-26）

- **现象**：某 Tab 结果 >30 条（`pageSize=30`，config.js L54），但只显示第一页，滚动到底不触发 `appendPage`。
- **根因**：`hasMore`（L805）完全依赖页面级 `onReachBottom`（L195）。若列表被包在自定义滚动容器、或导航栏/吸顶条遮挡了页面触底判定，`onReachBottom` 可能不触发 → 用户永远看不到第 31 条之后的赛事。
- **修复**：
  1. 确认 leagues 页使用**页面级滚动**（非 `scroll-view` 嵌套），否则 `onReachBottom` 不生效；
  2. 增加**「加载更多」按钮兜底**：`data.hasMore` 为 true 时，列表底部渲染按钮 `bindtap="appendPage"`，不依赖触底回调；
  3. 真机验证：iOS/Android 各点一次到底（或点按钮），确认 `page` 递增、列表追加。

### P1｜RC6：即将到来串行查询被 `upcomingQueryLimit=60` 截断 ✅ 已修复（2026-07-26）

- **现象**：需外部源补充、且数量 >60 的未来赛事，第 61+ 个不进「即将到来」。
- **根因**：`loadUpcomingSerial`（L609-610）对 `needQuery` 取 `.slice(0, config.leagueWindow.upcomingQueryLimit)`（=60）。该层是"补充"层（主数据来自 explorer+curation），但上限偏低时会漏。
- **修复**（可选增强）：提升到 120，或改为并行分批（`cloudProxy` 已做 OpenDota 60/min 限流，可直接提高上限）。

### P2｜RC5：即将到来空态（STRATZ 未启用 + curation 无日期） ✅ 已修复（2026-07-26）

- **现象**：「即将到来」空白。
- **说明**：数据源限制（非逻辑 bug）。`loadUpcomingSerial` 第一步取 `allLeagues` 中 `earliest>now` 的；若无、且 curation 库无日期，则 `upcomingList` 为空。
- **建议**：空态文案明确引导「启用 STRATZ 获取更多赛程」，并优先保证 curation 库覆盖重点赛事（如 TI2026）。

### （附带健壮性）RC7：等级筛选大小写一致性 ✅ 已修复（2026-07-26）

- `gradeMatch`（L752）用 `(x.grade||'').toLowerCase() === gf`。确认 `normalize` 产出的 `grade` 恒为大写（SSS/S/A/B），否则会静默漏筛。当前 `updateGradeCounts`（L282）已用 `.toLowerCase()` 比对已知档，风险低；建议在 `normalize` 末尾加 `grade = (grade||'S').toUpperCase()` 兜底。

---

## 三、预期验证方式

1. **纯函数单测（推荐，可回归）**：把 `applyAndSlice` 的筛选/合并抽成可测纯函数 `filterLeagues({filter, gradeFilter, allLeagues, upcomingList, sortMode, teamLeagueIds, keyword})`，构造 fixture：
   - 1 个 `upcoming` 未来赛事（无 matches）；
   - 1 个 3 天前结束的赛事（`lastEnd` 近、但 `latest` 在 7 天内）；
   - 100 个 `ended` 历史赛事（验证分页 `hasMore`）；
   - 断言：「全部」数量 = `allLeagues` ∪ `upcomingList` 去重；「已结束」含那个 3 天前结束的；「即将到来」含未来赛事。
2. **真机对照**：分别点 4 个 Tab + 智能/时间，对照 OpenDota，确认**无"在 A Tab 看到、切 B Tab 消失"**；滚动/点「加载更多」验证分页。
3. **监控埋点**：在 `applyAndSlice` 上报各 Tab 输入/输出条数，灰度观察「全部」稳定 ≥ 其他 Tab 之和（defunct 归档除外）。

---

## 四、改动清单（落地时）

| 优先级 | 文件 | 位置 | 改动 | 状态 |
|--------|------|------|------|------|
| P0 | `pages/leagues/leagues.js` | `applyAndSlice` `all` 分支 L789 | 合并 `mergeAllWithUpcoming(this.allLeagues, this.upcomingList)`（按 `leagueid` 去重，allLeagues 优先，未来赛事补充） | ✅ |
| P0 | `pages/leagues/leagues.js` | 模块级新增 `mergeAllWithUpcoming` | 双源去重合并辅助函数（allLeagues 优先保留真实 `latest`/`status`） | ✅ |
| P0 | `pages/leagues/leagues.js` | `applyAndSlice` `ended` 分支 L785 | 去掉 `latest < cutoff`，直接 `status==='ended'` | ✅ |
| P1 | `pages/leagues/leagues.js` | 新增 `onLoadMore` 处理器 | 带 `loading`/`upcomingLoading` 守卫，调 `appendPage` | ✅ |
| P1 | `pages/leagues/leagues.wxml` | 列表底部「加载更多」L192 | 按钮已存在，由 `bindtap="appendPage"` 改绑 `bindtap="onLoadMore"`（加固防重复点击） | ✅ |
| P1 | `utils/config.js` | `upcomingQueryLimit` L52 | 60 → 120（串行补充层上限放宽，仍受 OpenDota 60/min 限流保护） | ✅ |
| P2 | `pages/leagues/leagues.wxml` | 即将到来空态 L134 | 标题改为明确 CTA「启用 STRATZ 即可获取更多即将到来的赛程」 | ✅ |
| 健壮 | `pages/leagues/leagues.js` | `normalize` `grade` L318 | `grade = (grade||'S').toUpperCase()` 兜底（curTier.grade/ut.grade 强制大写，与 gradeMatch 比对一致） | ✅ |

> 全部 RC（RC1–RC7）均 landed。`leagues.js`/`config.js` 已过 `node --check`；P0/P1 为纯筛选/分页逻辑修正，RC5/RC6/RC7 为可选增强（空态文案 + 补充层上限 + 分级大小写兜底），均不影响数据结构、风险低。RC4 的兜底按钮原本已存在于 wxml，本次将其改为经守卫处理器触发，避免刷新/加载中重复点击导致页码跳变。`mergeAllWithUpcoming` 单测通过（去重保留真实版本、未来赛事与 curation 负 id 均正确补入）。
