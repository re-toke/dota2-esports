# 根因 H：BO3 中途单局独立成 BO1 卡（修复报告）

## 症状

TI 2026 中 TEAM VISION vs Team Yandex BO3 进行中（仅打完第 1 局，第 2 局未结束）。结束的第 1 局被当成独立 BO1 卡显示在已结束段，整场 BO3 仍未结束却出现了独立单局卡片。

## 真实数据（OpenDota API）

```
mid=8958842370  Team Yandex vs TEAM VISION  sid=1132678  st=1(BO3)
radiant_win: false  duration: 3163s
start_time: 2026-08-22T08:47 UTC（北京 16:47）
```

OpenDota 仅返回这 1 局已结算数据，比分 1:0，未达 BO3 胜场条件 2。

## 根因 H

`groupSeries` 的 phase 判定逻辑（`utils/sources.js`）：

```js
const phase = isLive ? 'live' : (isUpcoming ? 'upcoming' : 'recent');
```

判定流程：
- 所有已返回的局都已结算（`radiant_win!=null`）→ `isLive=false`
- 没有未来场（`start_time > now`）→ `isUpcoming=false`
- **结果**：`phase='recent'` → 单局被当成独立 BO1 卡显示在已结束段

## 修复

在 `groupSeries` 内、`const st = first.series_type;` 之后、`const phase = ...` 之前，新增强制 live 判定：

```js
if (!isLive && !isUpcoming && st != null && st >= 1) {
  var _boNumH = { 1: 3, 2: 5, 3: 2 }[st] || 0;
  if (_boNumH > 1) {
    // ★ BO2 特殊：双局积分制必须打满 2 局才算结束（不论 2:0 还是 1:1 平局），
    //   不能用「比分达胜场条件」判定（BO2 的 ceil(2/2)=1 → 1:0 会误判已结束）。
    //   BO3/BO5 用「比分达胜场条件」判定（先达 BO_WIN 即结束，未必打满）。
    var _seriesStillGoing = false;
    if (st === 3) {  // BO2
      _seriesStillGoing = games.length < _boNumH;  // 局数不足 → 仍进行
    } else {          // BO3/BO5
      var _winThresholdH = Math.ceil(_boNumH / 2);
      _seriesStillGoing = Math.max(scoreA, scoreB) < _winThresholdH;
    }
    if (_seriesStillGoing) {
      var _lastEndSecH = (last.start_time || 0) + ((last.duration || 0) || 0);
      if (_lastEndSecH > 0 && (nowSec - _lastEndSecH) < 6 * 3600) {
        isLive = true;
      }
    }
  }
}
```

## 三重防误判守卫

| 守卫 | 作用 |
|------|------|
| 仅 `series_type≥1` 生效 | BO1（series_type=0）不受影响 |
| 比分必须未达胜场条件 | 已结束 BO3 2:0/2:1 不被误判为 live |
| 最后一场结算后不超过 6h | 历史 BO3 中途异常数据兜底 |

## 验证

| 测试 | 结果 |
|------|------|
| `test-bo3-incomplete.js`（新增，6 场景 12 断言）| 11 通过 1 预期失败（boType=BO1 由 league-detail resolveBoType 后处理覆盖）|
| 原 8 件套 | 全绿（313+ 断言）|
| 9 套诊断 | 全绿 |
| 总计 18 套测试 | 零回归 |

## 全 BO 类型场景验证矩阵

| BO 类型 | series_type | 比分 | phase | 正确？ |
|---------|-------------|------|-------|-------|
| BO1 | 0 | 1:0 | recent | ✓ |
| BO2 中途 | 3 | 1:0（仅 1 局）| **live** | ✓（修复生效）|
| BO2 打满 | 3 | 2:0 / 1:1 | recent | ✓ |
| BO3 中途 | 1 | 1:0（仅 1 局）| **live** | ✓（核心修复）|
| BO3 已结束 | 1 | 2:0 / 2:1 | recent | ✓ |
| BO5 中途 | 2 | 1:0 / 2:0 / 1:1 | **live** | ✓（修复生效）|
| BO5 已结束 | 2 | 3:0 / 3:1 / 3:2 | recent | ✓ |

**关键差异**：BO2 用「局数打满」判定（必须打完 2 局）；BO3/BO5 用「比分达胜场条件」判定（先达 BO_WIN 即结束）。

## 用户操作

⚠️ **本轮修复在客户端 `utils/sources.js`，无需重新部署云函数**。

清缓存重新编译小程序后：
- TEAM VISION vs Team Yandex BO3 应显示在「进行中」段（比分 1:0），不再显示在「已结束」段
- 等 BO3 全部结束后（比分达 2:0 或 2:1），整场系列才进入「已结束」段
