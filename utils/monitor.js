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
    const info = wx.getSystemInfoSync && wx.getSystemInfoSync();
    return !!(info && info.platform === 'devtools');
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

module.exports = { report, leagueNameUncovered, statusConflict };
