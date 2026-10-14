// utils/upcomingSnapshot.js
// ★★ 2026-10-14（P2-24）：从 `utils/sources.js` **逐字搬出**的「即将到来」本地快照装载器。
//
// 动机（方案 §P2-24）：快照装载此前内联在 sources.js 顶部、带模块级缓存变量，属 sources.js
//   「重灾区」的一部分；搬出后**装载路径（JS 包装模块优先 → JSON 兜底 → null）可被独立单测**，
//   且不再让调用方（含分包）通过 sources.js 的庞大 require 图间接获取。
//
// ⚠️ 逐字未改逻辑（零行为变化）：仅移动位置 + 携带其模块级缓存变量 `_upcomingLocalSnapshot`。
//   sources.js 以解构 require 复用 `getUpcomingLocalSnapshot`，并在 module.exports 中再导出，
//   保持 `sources.getUpcomingLocalSnapshot()` 调用方（如 league-detail 分包）不变。
'use strict';

// upcoming-local.json 快照（在主包中 require，避免分包直接 require JSON 的兼容性问题）
// 分包（如 league-detail）通过 sources.getUpcomingLocalSnapshot() 间接获取，不直接 require JSON
// ★ 2026-07-30 修复：微信小程序对 JSON 的 require 行为不稳定，
//   改用 JS 包装模块（upcoming-local-data.js），JS 模块在主包/分包中 require 均稳定可靠
var _upcomingLocalSnapshot = null;
function loadUpcomingLocalSnapshot() {
  if (_upcomingLocalSnapshot) return _upcomingLocalSnapshot;
  // 优先用 JS 包装模块（稳定可靠），回退到 JSON（Node.js 环境兼容）
  try {
    _upcomingLocalSnapshot = require('./upcoming-local-data.js');
    console.log('[sources] upcoming-local-data.js 加载成功, events:',
      _upcomingLocalSnapshot && _upcomingLocalSnapshot.events ? _upcomingLocalSnapshot.events.length : 0);
  } catch (e) {
    console.error('[sources] upcoming-local-data.js require 失败:', e && e.message);
    try {
      _upcomingLocalSnapshot = require('./upcoming-local.json');
      console.log('[sources] upcoming-local.json 兜底加载成功, events:',
        _upcomingLocalSnapshot && _upcomingLocalSnapshot.events ? _upcomingLocalSnapshot.events.length : 0);
    } catch (e2) {
      console.error('[sources] upcoming-local.json require 也失败:', e2 && e2.message);
      _upcomingLocalSnapshot = null;
    }
  }
  return _upcomingLocalSnapshot;
}
function getUpcomingLocalSnapshot() { return loadUpcomingLocalSnapshot(); }

module.exports = {
  loadUpcomingLocalSnapshot: loadUpcomingLocalSnapshot,
  getUpcomingLocalSnapshot: getUpcomingLocalSnapshot
};
