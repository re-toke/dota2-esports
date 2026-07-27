// utils/reminderStrategy.js
// #20 智能提醒策略引擎（客户端侧）。
// 解决 2.2 闭环「无差别推送所有关注战队比赛」的噪声问题：让用户自定义
//   - 提前量（leadSec）：赛前多久推送（15min / 30min / 1h / 1d / 2d）
//   - 分级过滤（tiers）：只对 SSS/S/A 等高级别赛事推送，社区赛静默
// 策略持久化在本地 Storage，赛前提醒触发（index.checkPreMatchReminders）与
// 服务端策略引擎（云函数 saveFollowProfile / sendSmartReminders）共用同一份规则。
//
// 设计：避免与 sources 循环依赖时，evaluate 直接 require sources 计算分级
// （sources 不依赖本模块，单向依赖安全）。

const sources = require('./sources.js');

const KEY = 'dota2_reminder_strategy';

// 提前量可选项（秒）
const LEAD_OPTIONS = [
  { sec: 900, label: '15 分钟前' },
  { sec: 1800, label: '30 分钟前' },
  { sec: 3600, label: '1 小时前' },
  { sec: 86400, label: '1 天前' },
  { sec: 172800, label: '2 天前' }
];

// 分级可选项（与 tiers.js 五档对齐）
const TIER_OPTIONS = [
  { grade: 'SSS', label: 'TI 顶级' },
  { grade: 'S', label: 'S 级' },
  { grade: 'A', label: 'A 级' },
  { grade: 'B', label: 'B 级' },
  { grade: 'C', label: '社区赛' }
];

function defaultStrategy() {
  // 默认：赛前 30 分钟 + 仅 SSS/S/A 高级别
  return { leadSec: 1800, tiers: ['SSS', 'S', 'A'] };
}

function getStrategy() {
  try {
    const d = wx.getStorageSync(KEY);
    if (d && typeof d === 'object') {
      return {
        leadSec: d.leadSec || 1800,
        tiers: (Array.isArray(d.tiers) && d.tiers.length) ? d.tiers : ['SSS', 'S', 'A']
      };
    }
  } catch (e) {}
  return defaultStrategy();
}

function setStrategy(s) {
  const safe = {
    leadSec: (s && s.leadSec) || 1800,
    tiers: (s && Array.isArray(s.tiers)) ? s.tiers : ['SSS', 'S', 'A']
  };
  try { wx.setStorageSync(KEY, safe); } catch (e) {}
  return safe;
}

function leadLabel(sec) {
  const o = LEAD_OPTIONS.find((x) => x.sec === sec);
  return o ? o.label : Math.round(sec / 60) + ' 分钟前';
}

// 评估某场比赛是否应触发提醒。
// match: { start_time, league_name, ... }
// 返回 { should:Boolean, reason:'window'|'tier_filtered'|'past'|'too_early'|'no_start' }
function evaluate(match, strategy, now) {
  strategy = strategy || defaultStrategy();
  now = now || Math.floor(Date.now() / 1000);
  const start = match && match.start_time;
  if (!start) return { should: false, reason: 'no_start' };
  if (start <= now) return { should: false, reason: 'past' };
  // 分级过滤
  const tier = sources.getMatchTier((match.league_name) || '');
  const grade = (tier && tier.grade) || 'C';
  if (Array.isArray(strategy.tiers) && strategy.tiers.length && strategy.tiers.indexOf(grade) < 0) {
    return { should: false, reason: 'tier_filtered', grade: grade };
  }
  const diff = start - now;
  if (diff > (strategy.leadSec || 1800)) return { should: false, reason: 'too_early' };
  return { should: true, reason: 'window', grade: grade };
}

module.exports = {
  LEAD_OPTIONS: LEAD_OPTIONS,
  TIER_OPTIONS: TIER_OPTIONS,
  defaultStrategy: defaultStrategy,
  getStrategy: getStrategy,
  setStrategy: setStrategy,
  leadLabel: leadLabel,
  evaluate: evaluate
};
