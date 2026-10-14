// utils/monitor.js
// G8 — 运行时监控打点（兜底发现未被测试覆盖的残余实例）。
//
// 设计原则：
//  - 安全优先：所有上报均 try/catch 包裹，wx 不可用时静默降级（不阻塞业务、不破坏单测）。
//  - 仅生产环境：开发者工具（devtools）下不打点，避免本地调试污染数据。
//  - 低噪声：leagueNameUncovered 按原始名去重（同会话每个名字最多上报一次），
//    只上报「无 curation 覆盖却展示给用户」的名字——用于发现「应补进 curation 的赛事」。
//
// 上报通道：微信原生 wx.reportAnalytics（无需额外配置；在 MP 后台「自定义分析」查看）。
// 若后续接入第三方监控，只需改 report() 一处。

const _seen = new Set();
const MAX_SEEN = 300;

function inDevtools() {
  try {
    // 2026-07-28：platform 字段归 wx.getDeviceInfo / wx.getAppBaseInfo（两者均含 platform）。
    // ★ 2026-09-10（隐私指引审核整改）：**移除 wx.getSystemInfoSync 兜底** ——
    //   该旧接口官方说明「会获取系统权限，可能触发授权弹窗」，是审核驳回
    //   「设备信息接口说明不符合使用场景」的疑似诱因之一。
    //   本函数仅用于「是否开发者工具」判断（内部埋点开关），拿不到就返回 false（走保守分支），
    //   故去掉兜底无功能影响 —— 换取代码中零引用该废弃接口。
    let platform = '';
    if (wx.getDeviceInfo) {
      platform = wx.getDeviceInfo().platform || '';
    } else if (wx.getAppBaseInfo) {
      platform = wx.getAppBaseInfo().platform || '';
    }
    return platform === 'devtools';
  } catch (e) {
    return false;
  }
}

function canReport() {
  return typeof wx !== 'undefined' && typeof wx.reportAnalytics === 'function' && !inDevtools();
}

function report(event, data) {
  if (!canReport()) return;
  try {
    wx.reportAnalytics(event, Object.assign({ _t: Date.now() }, data || {}));
  } catch (e) {
    // 监控失败绝不影响主流程
  }
}

// 「展示名未被 curation 覆盖」：raw 非空、经 leagueDisplayName 后仍是原样（无规范名），
// 说明该联赛名到达了用户视野但不在权威库内。上报有助于发现「应补进 curation 的赛事」，
// 从源头缩小 P3 数据层缺口。同一 raw 同会话只上报一次。
function leagueNameUncovered(raw) {
  const name = (raw || '').trim();
  if (!name) return;
  if (_seen.has(name)) return;
  if (_seen.size >= MAX_SEEN) return;
  _seen.add(name);
  report('league_name_uncovered', { name: name.slice(0, 60) });
}

// 「列表 vs 详情 状态不一致」：同一 leagueid 在列表与详情判定出的状态相左时上报，
// 便于发现 isOngoing / statusOf / curation 硬覆盖的残余不一致（P1 兜底）。
function statusConflict(leagueid, listStatus, detailStatus) {
  if (!leagueid) return;
  report('league_status_conflict', {
    leagueid: String(leagueid),
    list: String(listStatus || ''),
    detail: String(detailStatus || '')
  });
}

// G7.4 监控补充（2026-07-29）：logo/api/多源 三类可观测性埋点。
//   - logoLoadFailed：OpenDota + STRATZ 均未拿到 logo（enrichTeamLogo 返回 null）。按 team_id 去重。
//   - apiCallError：API 请求重试耗尽仍失败（api.js request catch 兜底）。按 path 去重，防海量噪声。
//   - sourceCacheMiss：多源聚合时某源失败（sources.js crossTeamMembers/getLeagueMetadata 等）。
//     按 source+op 去重，用于发现某数据源不稳定/限流。
// 所有埋点复用 _seen 去重集合，同会话同 key 最多上报一次，避免重复打点污染数据。

// 队标加载失败：team_id 非 0 时按 id 去重；id 缺失时按 name 去重。
function logoLoadFailed(teamId, name, reason) {
  const key = 'logo:' + (teamId || ('name:' + (name || '')));
  if (_seen.has(key)) return;
  if (_seen.size >= MAX_SEEN) return;
  _seen.add(key);
  report('logo_load_failed', {
    team_id: String(teamId || ''),
    name: String(name || '').slice(0, 40),
    reason: String(reason || '').slice(0, 30)
  });
}

// API 调用最终失败：重试耗尽。按 path 去重，避免同端点反复失败刷屏。
function apiCallError(path, statusCode, message) {
  const key = 'api:' + path;
  if (_seen.has(key)) return;
  if (_seen.size >= MAX_SEEN) return;
  _seen.add(key);
  report('api_call_error', {
    path: String(path || '').slice(0, 80),
    status_code: String(statusCode || ''),
    message: String(message || '').slice(0, 60)
  });
}

// 多源聚合某源失败：source 为数据源名（opendota/stratz/steam/liquipedia），
// op 为操作名（teamLogo/teamMembers/leagueMeta 等）。按 source+op 去重。
function sourceCacheMiss(source, op, reason) {
  const key = 'src:' + source + ':' + op;
  if (_seen.has(key)) return;
  if (_seen.size >= MAX_SEEN) return;
  _seen.add(key);
  report('source_cache_miss', {
    source: String(source || ''),
    op: String(op || ''),
    reason: String(reason || '').slice(0, 40)
  });
}

// ===== P2-23（2026-10-14）：可观测性补强 —— EF / 中转 / 卡片质量 失败上报 =====
// 背景（方案 §P2-23）：`app.js` 已有 js_error / unhandled_rejection / memory_warning；
//   `api.js` 已有 apiCallError（**直连**失败）；`sources.js` 已有 sourceCacheMiss / logoLoadFailed。
//   **缺口 = EF（Supabase Edge Function）与中转出口切换失败无上报通道** ⇒ 线上 EF 停摆 /
//   出口劣化只能靠用户截图发现。本段补齐该通道（复用同一 report() + _seen 同会话去重，防刷屏）。
// ⚠️ 边界（v1.2.1 ★）：本段聚焦**错误/失败上报**；**性能分段**归 P1-21 的 `[perf]`，此处不重复。

// EF 调用失败（supabaseClient 传输层 / 非 2xx / 熔断计数点）：按 ef|action 去重。
//   efName 如 'opendota-proxy'；action 如 'getLeagues'（无 action 时为 ''）。
function efFailure(efName, action, reason) {
  const key = 'ef:' + (efName || '') + '|' + (action || '');
  if (_seen.has(key)) return;
  if (_seen.size >= MAX_SEEN) return;
  _seen.add(key);
  report('ef_failure', {
    ef: String(efName || '').slice(0, 40),
    action: String(action || '').slice(0, 40),
    reason: String(reason || '').slice(0, 40)
  });
}

// 中转出口切换（P1-2 双出口）：传输层失败触发的主→备切换。按来源宿主去重（同宿主同会话 1 次）。
function relayFailover(host, reason) {
  const key = 'relay:' + (host || 'unknown');
  if (_seen.has(key)) return;
  if (_seen.size >= MAX_SEEN) return;
  _seen.add(key);
  report('relay_failover', {
    host: String(host || '').slice(0, 60),
    reason: String(reason || '').slice(0, 40)
  });
}

// 首页卡片数据质量**未达标**上报（入参 = diagnostics.computeCardMetrics 的输出）。
//   **采样口径**：仅在「存在硬指标违例」的轮次上报（达标轮次**不上报**，避免常态噪声）；
//   并**按违例类别集合去重**（同会话每类组合 1 次）。硬指标 = 严格重复卡>0 / 状态误判>0 / 已结束无比分率超 SLO。
//   ⚠️ 空页（total=0）不上报（无卡可评，且 dupRateStrict=null 会被 pass 误判为 false）。
function cardQuality(m) {
  if (!m || !(m.total > 0)) return;
  const p = m.pass || {};
  const kinds = [];
  if (p.dupCardRateStrict === false) kinds.push('dup_strict');
  if (p.statusMismatch === false) kinds.push('status_mismatch');
  if (p.endedNoScore === false) kinds.push('ended_no_score');
  if (!kinds.length) return;
  const key = 'cq:' + kinds.join(',');
  if (_seen.has(key)) return;
  if (_seen.size >= MAX_SEEN) return;
  _seen.add(key);
  report('card_quality_violation', {
    kinds: kinds.join(','),
    total: String(m.total || 0),
    dupStrict: String(m.dupGroupsStrict || 0),
    statusMismatch: String(m.statusMismatch || 0),
    endedNoScore: String(m.endedNoScore || 0)
  });
}

module.exports = {
  report,
  leagueNameUncovered,
  statusConflict,
  logoLoadFailed,
  apiCallError,
  sourceCacheMiss,
  efFailure,
  relayFailover,
  cardQuality
};
