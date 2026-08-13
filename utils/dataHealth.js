// utils/dataHealth.js
// 数据源健康检查（2026-08-11 长期架构改进落地）
//
// 用途：客户端在「数据为空」时区分「数据源暂不可用」与「赛事确实无数据」，
//       避免 Liquipedia / OpenDota 链路异常时静默降级让用户误以为没数据。
// 实现：调云函数 health action（云端轻量探测 Liquipedia / OpenDota 可达性），
//       本地 TTL 缓存结果（5min）控制调用频率；云函数不可用/失败时静默返回
//       unknown（不阻断业务），由调用方决定是否展示提示。
//
// 对外 API：
//   - getStatus()           → 同步读缓存状态（{ ts, sources, ok } 或 null）
//   - check()               → 异步探测并刷新缓存（Promise<status|null>）
//   - sourceStatus(name)    → 同步读某源状态：'up' | 'down' | 'unknown'
//   - isDown(name)          → 某源是否明确 down（仅 'down' 为 true，其余 false）

const cache = require('./cache.js');
const cloudProxy = require('./cloudProxy.js');

const TTL = 5 * 60;              // 5min 缓存，控制 health 探测频率
const KEY = 'data_health_status';

// 同步读缓存状态；无缓存/未启用云 → null
function getStatus() {
  try {
    return cache.get(KEY, TTL) || null;
  } catch (e) {
    return null;
  }
}

// 异步探测（云函数 health action），成功后写缓存；失败静默返回 null
function check() {
  if (!cloudProxy.isAvailable()) return Promise.resolve(null);
  return cloudProxy.health()
    .then(function (data) {
      if (data && data.sources) cache.set(KEY, data, TTL);
      return data || null;
    })
    .catch(function () {
      // 云函数不可用 → 回退缓存（若有），否则 null；不阻断业务
      return getStatus();
    });
}

// 同步读某源状态：'up' | 'down' | 'unknown'
function sourceStatus(name) {
  const st = getStatus();
  if (!st || !st.sources || !st.sources[name]) return 'unknown';
  return st.sources[name].status === 'up' ? 'up' : 'down';
}

// 某源是否明确 down（仅 status==='down' 返回 true；unknown/up 均 false）
function isDown(name) {
  return sourceStatus(name) === 'down';
}

module.exports = {
  TTL: TTL,
  KEY: KEY,
  getStatus: getStatus,
  check: check,
  sourceStatus: sourceStatus,
  isDown: isDown
};
