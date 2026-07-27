# 战队搜索「S 级及以上战队漏检」根因分析报告

> 现象：部分曾参加过 S 级及以上级别赛事的战队（如历史 TI 队、老 Major 冠军队），在搜索框输入队名/缩写时**检索不到**。
> 排查方式：从数据源 → 索引/同步 → 搜索接口 → 过滤条件，自下而上逐层追踪。

---

## 一、搜索链路的真实结构

战队搜索有**两条数据源**，但接入方式不一致：

| 数据源 | 实现位置 | 覆盖范围 |
|---|---|---|
| **① OpenDota `/search`**（主源） | `api.searchTeams` → 云代理 `searchTeams` → OpenDota `/search?q=` | OpenDota 服务端索引（**按活跃度**构建，**历史/非活跃队不全**） |
| **② 本地 curation 兜底**（仅战队页用） | `matchLocalTeams(kw)` ← `buildLocalTeamIndex()` ← `curation.CURATED_TEAMS` | 仅 ~35 支**手维护 allowlist** |

**致命不一致**：
- `pages/teams/teams.js` 的 `runSearch`（L344-390）：`main.concat(local)` —— OpenDota 结果 + 本地 curation 兜底，按 `team_id` 去重。
- `pages/search/search.js` 的 `doSearch`（L77-89）：**只用 `api.searchTeams(kw)`**，`catch(()=>[])`，**完全没接本地兜底**，也不 import `curation`/`teams.js`。

→ 全局搜索页的战队覆盖**严格弱于**战队页。这是最直接的、可立即修的缺陷。

---

## 二、逐层排查

### Layer 1 — 数据源 / 索引配置（"数据库查询逻辑 + 索引"）
- 战队搜索唯一的"数据库"是 OpenDota `/search` 这个**外部 REST 端点**，不是本地库。其服务端索引是**基于近期活跃度**构建的——只可靠覆盖当前/近期有 pro 比赛的战队。
- 历史/已解散的 S 级战队（Wings Gaming、EHOME、iG、老 Na`Vi、CDEC、LFY、LGD.FY 等）**根本不在该索引里**，或仅在精确全名匹配时偶然出现。
- 唯一的"本地索引" `curation.CURATED_TEAMS`（L300-344）是**静态硬编码 allowlist**（~35 支），**不是全量、也不按"是否参加过 S 级"自动生成**。它虽已用 `tier: {grade:'SSS'|'S'}` 标注优先级（L291-292、L460），但覆盖的是"当前活跃 + 零星历史队"，历史 S 级队大量缺失。

### Layer 2 — 数据同步机制
- **联赛**有完整的同步闭环：云函数 `buildSearchIndex()` 每 6h timer 重建、落库 `leagues` 索引；客户端 `cloudCache.getSearchIndex()` 读取（`aggregation/index.js` L278 注释明确："战队/选手为开放集合，仍走 OpenDota /search"）。
- **战队没有对等机制**：无 `buildTeamsIndex`、无 `teams_search` 落库 action。
- `getTeamsHot` 只预热 10 支热门队；`getTeamNames`（6h 缓存）仅按 **ID** 批量反查队名，不可按名搜索。
- 结论：没有任何环节把"所有 S 级参赛队"聚合成可检索语料。

### Layer 3 — 搜索接口实现
- `api.searchTeams`（`api.js` L366-374）：`cached('/search',{q},5min)` + 云代理；无 tier 感知，直接透传 OpenDota 的不完整结果。
- `transformSearchTeams`（`api.js` L359-364）：`.filter(item=>item.team_id).slice(0,30)` —— 无 tier 过滤（正确），但 `slice(0,30)` 是硬编码上限，个别长尾查询会截断。
- 云代理 `searchTeams` 路由（`aggregation/index.js` L360）：`/search?q=` 透传到 OpenDota，返回数组 → 形状正确，无 bug。
- **关键缺口**：全局搜索页 `search.js` 未接本地兜底（见上文 Layer 1 表），导致 curated 的 S 级队在全局搜索中不可见。

### Layer 4 — 过滤条件构建
- `transformSearchTeams`：`item.team_id` 过滤（丢无 id 项）+ `slice(0,30)` 硬截断。
- `matchLocalTeams`（teams.js L96-108）：子串匹配 `name+tag+aliases`，覆盖 curated 队，但 curated 集本身不全。
- `search.js` 的 league 用 `indexOf` 子串、team 却没做本地匹配 → 不一致。

---

## 三、根本原因（结论）

**主因：战队搜索缺少"完整、按 tier 感知的索引语料"。**

它依赖 OpenDota `/search` 这个**对历史/非活跃 S 级队不完整的服务端索引**，又没有联赛那样的云端 `buildSearchIndex` 对等物；且全局搜索页连战队页已有的本地 curation 兜底都没接入。

因此一支"参加过 S 级赛事"的队，若同时满足：
- (a) 不在 OpenDota `/search` 活跃索引（历史/已解散队高概率命中），**且**
- (b) 不在 `CURATED_TEAMS` 这个 ~35 支静态白名单

→ 在全局搜索中**彻底不可见**。

**为什么偏偏是"S 级及以上"**：S 级历史参赛队（TI 冠军、老 Major 队）多数已解散或长期不活跃 → 掉出 OpenDota 活跃索引（满足 a）；而 curation 白名单以当前活跃队为主，历史 S 级队覆盖不全（满足 b）。这正是"曾参加 S 级赛事的队搜不到"现象的来源。

`curation.isHighPriorityTeam`（`curation.js` L453-462）已能判定 S/SSS 队，但**只用于 H2H/资料优先级覆盖，从未用于搜索语料**——这是能力已有、却没接进搜索的浪费点。

---

## 四、受影响代码模块清单

| 模块 | 文件:行 | 角色 / 问题 |
|---|---|---|
| 搜索索引（联赛有、战队无） | `cloudfunctions/aggregation/index.js` L278、L279-300 | `buildSearchIndex` 只含 `leagues`；注释明确战队"仍走 /search"；无 `teams_search` action |
| 本地战队白名单 | `utils/curation.js` L300-344（`CURATED_TEAMS`） | 静态 allowlist，~35 队，历史 S 级队覆盖不全；含 `tier.grade` 但未用于搜索 |
| 优先级判定（可用未用） | `utils/curation.js` L453-462 `isHighPriorityTeam` | 已能识别 S/SSS 队，仅用于资料优先级，未接搜索 |
| 搜索接口 | `utils/api.js` L366-374 `searchTeams`、L359-364 `transformSearchTeams` | 透传 OpenDota 不完整结果；`slice(0,30)` 硬截断 |
| 战队页搜索（有兜底） | `pages/teams/teams.js` L84-108 `buildLocalTeamIndex`/`matchLocalTeams`、L344-390 `runSearch` | 含本地兜底（正确范例） |
| **全局搜索页（无兜底）** | `pages/search/search.js` L77-89 `doSearch` | **只用 `api.searchTeams`，不接本地兜底** —— 与 teams.js 不一致，最直接缺陷 |
| 云端缓存封装 | `utils/cloudCache.js` L5、L44-93 | 仅 `getSearchIndex`（leagues），无 teams 索引封装 |

---

## 五、具体修复建议

### 修复 A（核心，对齐联赛范式）—— 建"战队搜索索引"
1. `cloudfunctions/aggregation/index.js` 新增 `buildTeamsIndex()`：遍历 `curation.CURATED_TEAMS`，产出 `{id,name,tag,aliases,tier}` 数组（保留 S/SSS 标记），落库 `teams_search`（TTL 6h）；`handleTimer()` 接入；`exports.main` 增 `getTeamsIndex` / `buildTeamsIndex` action。
2. `utils/cloudCache.js` 新增 `getTeamsIndex()`（云端优先 + 本地兜底），与 `getSearchIndex` 同构。
3. `pages/teams/teams.js` 与 `pages/search/search.js` 的搜索均优先读 `getTeamsIndex` 本地索引做子串匹配，miss 时回退 OpenDota `/search`。
4. **扩展语料**（关键）：把历史 S 级队（Wings/EHOME/iG/老 Na`Vi/CDEC/LFY/LGD.FY 等）补进 `CURATED_TEAMS`（带 `tier.grade`），或新增一个由 league/TI 参赛名单派生参赛队全集的生成脚本，减少手动维护漂移。

### 修复 B（低风险、立竿见影）—— 全局搜索页接本地兜底
`pages/search/search.js` 引入 `matchLocalTeams`（或新的 `getTeamsIndex`），在 `doSearch` 里：
```js
const teams = (await api.searchTeams(kw).catch(()=>[]))
  .concat(matchLocalTeams(kw, 20))
  .filter(dedupByTeamId);   // 按 team_id 去重
```
对齐 `teams.js` 的 `runSearch` 逻辑，立刻让所有 curated S 级队在全局搜索可见。

### 修复 C（过滤健壮性）
- 保留 `slice(0,30)`，但确保本地兜底结果**始终并入后再截断**，避免被 OpenDota 上限漏掉。
- 跨 OpenDota + 本地合并时以 `team_id` 为去重键（teams.js 已做，search.js 需补齐）。

### 修复 D（长期）—— 战队语料自动同步
- 定期从 `curation` 的赛事/TI 名单派生"参赛队全集"，写入 `teams_search` 索引，替代纯手动 allowlist，降低漂移与漏检。

---

## 六、验证方式
1. 选 3 支历史 S 级队（如 Wings Gaming / EHOME / iG），在**全局搜索页**与**战队页**分别搜全名 + 缩写，确认均出现。
2. 监控 OpenDota `/search` 命中率 vs 本地索引命中率，确认漏检率下降。
3. `node --check` 改动文件；真机对照 OpenDota 官网 `/search` 结果，确认无"在 A 源可见、在 B 源消失"。

> ⚠️ 部署前置：修复 A 涉及云函数 action + timer，需重新上传部署 `aggregation` 并手动触发一次 `buildTeamsIndex` 暖库。

---

## 七、落地状态（2026-07-26 · 已落地 B+A）

**修复 B（全局搜索页接本地兜底）— 已落地 ✅**
- 新增 `utils/teamSearch.js`，把 `matchLocalTeams`/`buildLocalTeamIndex` 抽为共享模块；语料 = `curation.CURATED_TEAMS`（当前 S/SSS）+ `HISTORICAL_S_TEAMS`（历史 S 级）。
- `pages/teams/teams.js` 改用 `teamSearch`，删除内联定义；`runSearch`/`openTeam` 补 `navigable` 守卫。
- `pages/search/search.js` 的 `doSearch` 合并 ① OpenDota `api.searchTeams` + ② `teamSearch.matchLocalTeams` + ③ `cloudCache.getTeamsIndex()`，三源按 `id` 去重；`openResult` 加 `navigable` 守卫。
- WXML：`search.wxml` 战队卡片 `wx:key`→`id`、`data-id`→`item.id`、加 `data-navigable`；`teams.wxml` 卡片加 `data-navigable`。

**修复 A（云函数战队搜索索引）— 已落地 ✅**
- `cloudfunctions/aggregation/index.js`：新增 `TEAMS_SEARCH_HISTORICAL` 语料常量、`buildTeamsIndex()`（落库 `teams_search`，TTL 6h）、`getTeamsIndex()`；`handleTimer` 接入；`exports.main` 增 `getTeamsIndex`/`buildTeamsIndex` action。
- `utils/cloudCache.js`：新增 `getTeamsIndex()`（云端优先 + 本地兜底，与 `getSearchIndex` 同构）并导出。

**历史 S 级队 id 核验（避免复用旧 id 指向错误队）**
- OpenDota `/search` 只返选手、不返历史队（确认漏检主因）。
- `/teams` 全量列表核验当前真实 id：Wings Gaming=1836806、EHOME=4、Invictus Gaming=5、LGD.Forever Young(LFY)=3331948 → 可安全跳转详情。
- CDEC / LGD.FY 当前窗口未核验到正确 id → 标 `navigable:false`、占位负数 id，仅搜索可见、点击不跳转（待 Fix D 补全正确 id）。

**验证**：5 个改动 JS 文件均 `node --check` 通过；grep 确认无残留旧函数引用、search.wxml 无 `team_id`。

**待办（用户未要求 commit / 部署）**
1. 重新上传部署 `aggregation` 云函数。
2. 部署后手动触发一次 `buildTeamsIndex` 暖库（之后由 6h timer 维护）。
3. （可选）Fix C/D：把 `slice(0,30)` 改为合并本地兜底后再截断；长期由赛事/TI 名单派生参赛队全集自动同步，补全 CDEC/LGD.FY 等正确 id。

