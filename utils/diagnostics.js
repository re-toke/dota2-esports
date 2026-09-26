// utils/diagnostics.js
// ★★ 2026-09-26（P0-B）：**数据质量指标（SLO）与采集点** —— 先有尺子，再谈优化。
//
// 为什么要有它：
//   复核《项目复核与优化方案 v2》时发现：全篇"优化后会怎么样"**都是定性描述**，
//   因此"效果能否达到预期"在该框架内**不可判定**。而且项目刚经历过
//   「首页同一对局 1:1（残留）→ 正确 1:2」「详情页 1:2 却挂 LIVE」这类事故 ——
//   没有指标就只能靠用户截图发现。
//
// 设计约定：
//   ① **纯计算**（不碰 wx / this / setData）⇒ 客户端与 CI(Node) 共用同一实现，口径不会两处漂移；
//   ② **汇总常开 / 逐项走开关**（对齐项目既有约定 `config.debug.verboseLog`）；
//   ③ SLO 常量与**代码阈值对齐**，并由单测做**漂移守卫**（读源码断言，改代码不改 SLO 会 FAIL）。
//   ④ ⚠️ **写入方是 CI 而非客户端**：`curation_meta` 的 RLS 是 `anon_read_meta`（**只读**），
//      客户端无写权限；CI 持有 `SUPABASE_SERVICE_KEY` ⇒ 指标由 CI 计算并入库，
//      客户端只负责**读**（"我的"页展示）与**打日志**。
'use strict';

var seriesStatus = require('./seriesStatus.js');
var homeDedupe = require('./homeDedupe.js');

// ===== SLO（2026-09-26 修订口径）=====
// ★ 与 v2 方案 §9.2 的差异（均为复核后修正，理由写在 note 里）：
//   · 收敛延迟**拆两条**：硬判据路径 ≤5min（可达） / 降级路径 ≤3h（受 sources.js 阈值限制，物理上不可能 5min）
//   · 快照年龄**拆两量**：目标 24h（目标值） / 7d（leagues.js 的降权阈值）—— 同名不同义曾致误判
//   · 重复卡率目标 0 **原理不可达**（同日同队两场在"队名+时间窗"信号下不可区分）⇒ 改为「≤基线 + 例外可解释」
var SLO = {
  // —— 准确性 ——
  dupCardRateStrict: {
    target: 0,
    note: '严格键去重后仍重复 = 必为缺陷 ⇒ 目标 0；'
      + '⚠️ 但"同日同队两场"这类**原理不可分**的情形不在严格键覆盖内，故另设 dupCardRateLoose 观测量'
  },
  dupCardRateLoose: {
    target: null,
    note: '宽松键（含队名碎片）重复数 —— 含"原理不可分"的合法情形 ⇒ 只建基线，不设阈值'
  },
  statusMismatch: {
    target: 0,
    note: '「比分达 BO 上限」却 status=live 的系列数 ⇒ 硬判据路径，可达 0'
  },
  endedNoScoreRate: {
    target: 0.01,
    note: '已结束但 0:0 的占比（2026-09-25 首页事故的量化口径）⇒ ≤1%'
  },
  heuristicRate: {
    target: null,
    note: '启发式降级率（identitySource=heuristic）—— 需 P0-A 引入该字段后才有值，先建基线'
  },
  // —— 及时性 ——
  liveScoreLagSec: { target: 90, note: '最新比分时间 → 当前时间（现有 30s 轮询 + 5min 重拉）' },
  statusConvergeHardSec: { target: 5 * 60, note: '真实终局 → status=ended，走「比分达 BO 上限」硬判据路径' },
  statusConvergeDegradedSec: {
    target: 3 * 3600,
    note: '降级路径（超时推断）—— 必须与 utils/sources.js 的 STALE_LIVE_MAX_SEC 对齐，故不可能 ≤5min'
  },
  snapshotAgeSec: {
    target: 24 * 3600,
    note: '快照"目标新鲜度"；另有**降权阈值** 7d（pages/leagues/leagues.js 的 SNAPSHOT_MAX_AGE_SEC），两者语义不同'
  }
};

function _rate(n, d) {
  return d > 0 ? (n / d) : null;
}

/** 比率 → 一位小数百分比（`null` 显示 n/a）；供日志与展示共用，避免两处格式化漂移。 */
function formatPct(r) {
  return (r === null || r === undefined) ? 'n/a' : (Math.round(r * 1000) / 10) + '%';
}

/**
 * 统计一组**卡片**（首页 `_allMatches` 那种形状）的数据质量指标。
 * @param {Array} cards 卡片数组：{ status, scoreA, scoreB, bo, identitySource?, teamA?, teamB?, key? }
 * @param {Object} [opts] { baseline: { dupCardRateStrict?: number } }
 * @returns {Object} 指标 + 逐项达标判定
 */
function computeCardMetrics(cards, opts) {
  var list = Array.isArray(cards) ? cards : [];
  var o = opts || {};
  var m = {
    total: 0,
    ended: 0,
    live: 0,
    upcoming: 0,
    // 重复卡（严格 / 宽松）
    dupGroupsStrict: 0,
    dupGroupsLoose: 0,
    dupRateStrict: null,
    dupRateLoose: null,
    // 状态误判
    statusMismatch: 0,
    // 比分缺失
    endedNoScore: 0,
    endedNoScoreRate: null,
    // 身份来源（P0-A 起有值）：'series_id' 权威 / 'heuristic' 软关联推断 / 'standalone' 单局
    heuristic: 0,
    standalone: 0,
    heuristicKnown: 0,
    heuristicRate: null,
    // 达标判定
    pass: {}
  };

  var strictIndex = {};
  var looseIndex = {};
  var strictDupGroups = {};
  var looseDupGroups = {};

  list.forEach(function (c) {
    if (!c) return;
    m.total++;

    if (c.status === 'ended') m.ended++;
    else if (c.status === 'live') m.live++;
    else if (c.status === 'upcoming') m.upcoming++;

    // ① 状态误判：比分已达终局却仍是 live
    if (seriesStatus.isStaleLiveByScore(c.status, c.scoreA, c.scoreB, c.bo)) m.statusMismatch++;

    // ② 比分缺失：已结束却 0:0（2026-09-25 首页事故的量化口径）
    if (c.status === 'ended') {
      var sum = (Number(c.scoreA) || 0) + (Number(c.scoreB) || 0);
      if (sum === 0) m.endedNoScore++;
    }

    // ③ 身份来源（P0-A 起有值）—— 分母只含**已打标**的卡片，未打标（旧数据/未接线）不计入 ⇒ 不虚报为 0%
    if (c.identitySource === 'heuristic') { m.heuristic++; m.heuristicKnown++; }
    else if (c.identitySource === 'series_id' || c.identitySource === 'standalone') { m.heuristicKnown++; }
    if (c.identitySource === 'standalone') m.standalone++;

    // ④ 重复卡：用与真实去重**同一套键函数**（严格 / 宽松分别统计）
    var keys;
    try { keys = homeDedupe.pairKeysOfCard(c) || []; } catch (e) { keys = []; }
    keys.forEach(function (k, i) {
      var isLoose = (i > 0);   // pairKeysOfCard 约定：第 0 个为严格键，其余为宽松键
      var idx = isLoose ? looseIndex : strictIndex;
      var grp = isLoose ? looseDupGroups : strictDupGroups;
      if (k && idx[k] != null) grp[k] = true; else if (k) idx[k] = true;
    });
  });

  m.dupGroupsStrict = Object.keys(strictDupGroups).length;
  m.dupGroupsLoose = Object.keys(looseDupGroups).length;
  m.dupRateStrict = _rate(m.dupGroupsStrict, m.total);
  m.dupRateLoose = _rate(m.dupGroupsLoose, m.total);
  m.endedNoScoreRate = _rate(m.endedNoScore, m.ended);
  m.heuristicRate = _rate(m.heuristic, m.heuristicKnown);

  // —— 逐项达标判定 ——
  m.pass.dupCardRateStrict = (m.dupRateStrict === 0);
  m.pass.statusMismatch = (m.statusMismatch === 0);
  m.pass.endedNoScore = (m.endedNoScoreRate === null) || (m.endedNoScoreRate <= SLO.endedNoScoreRate.target);
  m.pass.heuristic = (m.heuristicRate === null) ? null : null;   // 未设阈值 ⇒ 恒"待建基线"
  m.baseline = o.baseline || null;
  return m;
}

/**
 * 一行汇总（**常开**：符合"汇总常开 / 逐项走开关"的既有约定）。
 * @returns {string}
 */
function formatSummary(m) {
  if (!m) return '[diag][cards] (无数据)';
  var pct = formatPct;
  return '[diag][cards] 总' + m.total +
    ' (结束' + m.ended + '/进行' + m.live + '/待赛' + m.upcoming + ')' +
    ' | 重复卡 严格' + m.dupGroupsStrict + '(' + pct(m.dupRateStrict) + ')' +
    ' 宽松' + m.dupGroupsLoose + '(' + pct(m.dupRateLoose) + ')' +
    ' | ★状态误判 ' + m.statusMismatch + (m.pass.statusMismatch ? '' : ' ❌') +
    ' | 已结束无比分 ' + m.endedNoScore + '(' + pct(m.endedNoScoreRate) + ')' + (m.pass.endedNoScore ? '' : ' ❌') +
    ' | 身份 权威' + (m.heuristicKnown ? (m.heuristicKnown - m.heuristic - m.standalone) : 0) +
    '/推断' + m.heuristic + '/单局' + m.standalone +
    (m.heuristicKnown ? (' 降级率' + pct(m.heuristicRate)) : ' 未采集');
}

/**
 * 逐项明细（**走 `config.debug.verboseLog` 开关**：热路径只打汇总，明细按需）。
 * @returns {string[]}
 */
function formatDetails(m) {
  if (!m) return [];
  var out = [];
  out.push('[diag][cards][detail] 重复卡 严格组=' + m.dupGroupsStrict + ' 宽松组=' + m.dupGroupsLoose);
  out.push('[diag][cards][detail] 状态误判（比分达终局却 live）=' + m.statusMismatch + ' ⇒ SLO 目标 ' + SLO.statusMismatch.target);
  out.push('[diag][cards][detail] 已结束无比分=' + m.endedNoScore + '/' + m.ended + ' ⇒ SLO 目标 ≤' + (SLO.endedNoScoreRate.target * 100) + '%');
  out.push('[diag][cards][detail] 身份来源 权威=' + (m.heuristicKnown - m.heuristic - m.standalone) +
    ' 推断=' + m.heuristic + ' 单局=' + m.standalone + ' 已打标=' + m.heuristicKnown +
    (m.heuristicKnown ? '' : '（未采集：卡片未带 identitySource）'));
  return out;
}

// ===== 最近一次指标（**唯一的可变状态**，供消费方读取；不参与任何计算）=====
// 为什么放这里：首页完成融合后写入，"我的"页读取展示 —— 避免两页各算一遍（口径与开销都省）。
// ⚠️ 仅**内存**快照（不落盘）：小程序重启后为空，展示层须容忍"暂无数据"。
var _last = null;
function recordLast(metrics, ctx) {
  if (!metrics) return;
  _last = {
    at: Math.floor(Date.now() / 1000),
    metrics: metrics,
    ctx: ctx || null
  };
}
function getLast() { return _last; }

function _fmtAge(sec) {
  if (sec == null) return '未知';
  if (sec < 3600) return Math.max(1, Math.round(sec / 60)) + ' 分钟';
  if (sec < 86400) return Math.round(sec / 3600) + ' 小时';
  return Math.round(sec / 86400) + ' 天';
}

/**
 * **管道指标**（纯函数：输入快照元数据，输出年龄/超限判定）。
 * 为什么纯：CI（Node）与客户端**共用同一实现** ⇒ 两边算出的口径不会漂移。
 * @param {Array<{name:string, ts:number, count?:number}>} snaps 快照元数据
 * @param {number} [nowSec]
 * @returns {{at:number, items:Array, oldest:Object|null, ageSec:number|null, ageText:string, overTarget:boolean, targetSec:number, totalCount:number}}
 */
function computePipelineMetrics(snaps, nowSec) {
  var now = nowSec || Math.floor(Date.now() / 1000);
  var items = (Array.isArray(snaps) ? snaps : []).map(function (s) {
    var ts = Number(s && s.ts) || 0;
    var ageSec = ts > 0 ? (now - ts) : null;
    return {
      name: (s && s.name) || '',
      ts: ts,
      count: (s && s.count != null) ? Number(s.count) : null,
      ageSec: ageSec,
      ageText: _fmtAge(ageSec),
      overTarget: (ageSec != null) && (ageSec > SLO.snapshotAgeSec.target)
    };
  });
  var valid = items.filter(function (x) { return x.ts > 0; });
  var oldest = valid.length ? valid.reduce(function (a, b) { return (a.ts < b.ts) ? a : b; }) : null;
  var ageSec = oldest ? (now - oldest.ts) : null;
  var totalCount = 0;
  items.forEach(function (x) { if (x.count) totalCount += x.count; });
  return {
    at: now,
    items: items,
    oldest: oldest,
    ageSec: ageSec,
    ageText: _fmtAge(ageSec),
    overTarget: (ageSec != null) && (ageSec > SLO.snapshotAgeSec.target),
    targetSec: SLO.snapshotAgeSec.target,
    totalCount: totalCount
  };
}

/**
 * 数据新鲜度（读本地快照的 generatedAt）。
 * ★ 取**最旧**的那个作为"数据更新时间" —— 保守口径：用户看到的是**最差**新鲜度，
 *   而不是被最新那个掩盖（两个快照的刷新周期不同，实测差可达十余天）。
 * ★ 实现委托给纯函数 `computePipelineMetrics`（同一口径，CI 侧也用它）。
 * @returns {{items:Array, oldest:Object|null, ageSec:number|null, ageText:string, overTarget:boolean, targetSec:number}}
 */
function describeFreshness(nowSec) {
  var snaps = [];
  function push(name, loader, pickCount) {
    try {
      var v = loader();
      if (v && v.generatedAt) {
        snaps.push({ name: name, ts: Number(v.generatedAt) || 0, count: pickCount(v) });
      }
    } catch (e) { /* 快照缺失不影响展示 */ }
  }
  push('赛程快照', function () { return require('./upcoming-local.json'); },
    function (v) { return (v.events || []).length; });
  push('联赛快照', function () { return require('./leagues-local.json'); },
    function (v) { return (v.leagues || []).length; });
  return computePipelineMetrics(snaps, nowSec);
}

module.exports = {
  SLO: SLO,
  computeCardMetrics: computeCardMetrics,
  formatSummary: formatSummary,
  formatDetails: formatDetails,
  formatPct: formatPct,
  formatAge: _fmtAge,          // 年龄格式化单一实现（客户端展示心跳/快照年龄时复用，避免各自造）
  recordLast: recordLast,
  getLast: getLast,
  computePipelineMetrics: computePipelineMetrics,
  describeFreshness: describeFreshness
};
