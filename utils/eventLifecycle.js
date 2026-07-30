// utils/eventLifecycle.js
// 赛事生命周期状态机
//
// 替代分散在 leagues.js / league-detail.js 中的临时状态判定逻辑（statusBadgeOf /
// util.statusOf / util.isOngoing 等），为赛事定义统一的生命周期状态机。
//
// 状态定义（5 态 + 1 终态）：
//   ANNOUNCED  → 已公布（有赛事名但无确切日期）
//   SCHEDULED  → 已排期（有确切日期但未开赛）
//   ONGOING    → 进行中（当前时间在 start~end 之间，含 ongoingBufferSec 缓冲）
//   COMPLETED  → 已结束（超过 end + ongoingBufferSec，但未满归档期限）
//   CANCELLED  → 已取消（终态，curation 显式标记或 detectCancelledEvents 检测到）
//   ARCHIVED   → 已归档（COMPLETED 超过 30 天）
//
// 状态迁移规则：
//   ANNOUNCED → SCHEDULED：获得确切日期（Liquipedia/curation 补全）
//   SCHEDULED → ONGOING：当前时间 >= start
//   ONGOING → COMPLETED：当前时间 > end + ongoingBufferSec
//   COMPLETED → ARCHIVED：当前时间 > end + 30 天
//   任意 → CANCELLED：curation 显式标记 status='已取消' 或 detectCancelledEvents 检测到
//   CANCELLED 是终态，不再迁移
//
// 兼容性说明：
//   - ONGOING / SCHEDULED / COMPLETED 的颜色与 leagues.js statusBadgeOf 对齐
//     （#1ec896 / #ffcf5c / #6b7280）
//   - ongoingBufferSec 优先取 config.js 的 leagueWindow.ongoingBufferSec（与 util.isOngoing
//     同源），读不到时回退默认 2*3600（2 小时）
//   - curation status 字段仅 '已取消' / 'cancelled' 触发终态；其余状态由时间窗口计算
//   - 模块无 wx 依赖（纯 JS 函数），可在 Node 端与小程序端共用

// 尝试读取 config.js 的 ongoingBufferSec，读不到则用默认 2*3600（2 小时）。
// 与 util.isOngoing 共用同一配置源，保证缓冲口径一致。
let ongoingBufferSec = 2 * 3600;
try {
  const cfg = require('./config.js');
  if (cfg && cfg.leagueWindow && cfg.leagueWindow.ongoingBufferSec) {
    ongoingBufferSec = cfg.leagueWindow.ongoingBufferSec;
  }
} catch (e) {
  // config.js 不可用时用默认值，保证模块独立可用
}

// 归档阈值：已结束后 30 天归档（与 curation.detectCancelledEvents 的 overdueDays 无关，
// 此处仅控制 COMPLETED → ARCHIVED 迁移）
const ARCHIVE_SEC = 30 * 86400;

const STATES = {
  ANNOUNCED: 'announced',
  SCHEDULED: 'scheduled',
  ONGOING: 'ongoing',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  ARCHIVED: 'archived'
};

// 根据赛事数据计算当前状态（纯函数，无副作用）
// 输入：{ start, end, status?(curation 显式标记), now? }
//   - start / end：Unix 秒（UTC），与 curation.start / curation.end 同口径
//   - status：curation 显式标记（'已取消' / 'cancelled' 触发终态）
//   - now：可选，当前 Unix 秒；缺省取 Date.now()
// 输出：{ state, label, color, isTerminal }
function computeState(event, now) {
  now = now || Math.floor(Date.now() / 1000);
  // 1. curation 显式标记优先（终态）
  if (event.status === '已取消' || event.status === 'cancelled') {
    return { state: STATES.CANCELLED, label: '已取消', color: '#6b7280', isTerminal: true };
  }
  // 2. 无日期 → ANNOUNCED
  if (!event.start) {
    return { state: STATES.ANNOUNCED, label: '已公布', color: '#8b5cf6', isTerminal: false };
  }
  // 3. 有日期但未开赛 → SCHEDULED
  if (now < event.start) {
    return { state: STATES.SCHEDULED, label: '即将到来', color: '#ffcf5c', isTerminal: false };
  }
  // 4. 进行中（start <= now <= end + buffer）
  if (event.end && now <= event.end + ongoingBufferSec) {
    return { state: STATES.ONGOING, label: '进行中', color: '#1ec896', isTerminal: false };
  }
  // 5. 已结束但未归档（end + buffer < now < end + 30天）
  //    无 end 时无法计算归档时间，恒为 COMPLETED
  if (!event.end || now < event.end + ARCHIVE_SEC) {
    return { state: STATES.COMPLETED, label: '已结束', color: '#6b7280', isTerminal: false };
  }
  // 6. 已归档
  return { state: STATES.ARCHIVED, label: '已归档', color: '#9ca3af', isTerminal: false };
}

// 状态迁移：检查是否应该迁移到新状态
// 输入：当前状态字符串 + 赛事数据 + 可选 now
// 输出：{ shouldTransition, newState, label?, color? }
function transitionTo(currentState, event, now) {
  const target = computeState(event, now);
  // CANCELLED 是终态，不再迁移
  if (currentState === STATES.CANCELLED) {
    return { shouldTransition: false, newState: currentState };
  }
  if (target.state !== currentState) {
    return { shouldTransition: true, newState: target.state, label: target.label, color: target.color };
  }
  return { shouldTransition: false, newState: currentState };
}

module.exports = {
  STATES: STATES,
  computeState: computeState,
  transitionTo: transitionTo
};
