/**
 * 赛事赛段分层（stage）：把一个 leagueid 下的对局切分为 main（正赛）/ playin（预选赛）
 * 2026-11-15 新建。
 *
 * ## 为什么需要
 * OpenDota 会把「同一赛事的多个赛段」合并进同一个 leagueid（实证：1win Essence III
 * leagueid=20486 —— Play-In 11-07~11-11（10 队）+ 正赛 11-12~11-18（12 队）同 id）。
 * 若不区分赛段，详情页会：
 *   ① 赛期从预选赛首日算起（11-07 而非 11-12）；
 *   ② 参赛队把预选赛弱队算进来（18 支而非 12 支）；
 *   ③ 小组赛战绩里预选赛队伍排榜首（LEGION/Froglings/CyberHero）。
 * EPL Masters II 曾发生同类事故，当时是人工补 `participants` 修数据，机制没根治。
 *
 * ## 口径
 * 统计口径**只用 main**；playin 不删除，只单独标注（isPlayin）供页面分组/加标签。
 * 切分优先用「人工/citation 的正赛窗口」，无窗口时做**保守**启发式（宁可全归 main，
 * 不可误切正常赛事）。
 *
 * @module utils/stages
 */

// 单位常量（秒）
const HOUR_SEC = 3600;
// playin 判定容差：**0**（严格按正赛起点切）。
// ★ 2026-11-15 真实数据回归修正：原设 6h 容差，导致 1win Essence III（20486）把 11-11
//   晚间的 Play-In 对局划进正赛 —— main 出现 15 支队（应为 12）、赛期提前到 11-11。
//   口径取「宁可少算正赛边界场次，不可把预选赛混进正赛统计」：curation start 是**日期**
//   （当日 00:00 UTC），正赛对局按当地时区开赛不会早于它；容差只会单向放进预选赛。
const PLAYIN_LEAD_SEC = 0;
// 赛后容差：正赛结束 72h 之后的对局视为「赛后加赛/补录」→ 归 playin（防污染正赛统计）
const POST_MAIN_GRACE_SEC = 72 * HOUR_SEC;
// 启发式：两段之间至少要空出 72h 才可能是两个赛段
const MIN_GAP_SEC = 72 * HOUR_SEC;
// 启发式：每段至少要 3 个 series（不足则几乎不可能是独立赛段，多为赛程空档）
const MIN_SERIES_PER_STAGE = 3;
// 启发式：两段队伍集合交集占比上限（< 50% 才是「换了一批队」的两个赛段）
const MAX_TEAM_OVERLAP = 0.5;
// 合法 unix 秒下限（> 2001 年）。小于此值视为「无窗口/未提供」。
const MIN_VALID_TS = 1e9;

/**
 * 秒级时间戳归一（容错毫秒 + 非法值）
 * @param {*} v 原始时间
 * @returns {number} unix 秒；非法返回 0
 */
function toSec(v) {
  let t = Number(v);
  if (!isFinite(t) || t <= 0) return 0;
  if (t > 1e12) t = Math.floor(t / 1000);   // 毫秒 → 秒容错
  return Math.floor(t);
}

/**
 * 取对局开赛时间（start_time 优先，startTime 兜底）
 * @param {Object} m 比赛
 * @returns {number} unix 秒；无则 0
 */
function startOf(m) {
  if (!m || typeof m !== 'object') return 0;
  return toSec(m.start_time) || toSec(m.startTime);
}

/**
 * 对局的分组键（series_id 优先，无则 match_id）
 * 与 sources.getSeriesKey 的语义对齐（此处只做计数，不涉软关联 _patchedSeriesKey）
 * @param {Object} m 比赛
 * @returns {string|null} 分组键
 */
function seriesKeyOf(m) {
  if (!m || typeof m !== 'object') return null;
  const sid = m.series_id;
  if (sid != null && sid !== 0) return 's' + sid;
  if (m.match_id != null && m.match_id !== 0) return 'm' + m.match_id;
  return null;
}

/**
 * 按 series_id 去重计数（无 series_id 时按 match_id 计）
 * 2026-11-15：供详情页「N 组对阵」口径使用（预选赛/正赛各自独立计数）。
 * @param {Array} list 比赛数组
 * @returns {number} 组数
 */
function countSeries(list) {
  const arr = Array.isArray(list) ? list : [];
  const seen = {};
  let n = 0;
  arr.forEach(function (m) {
    const k = seriesKeyOf(m);
    if (!k) { n++; return; }          // 无任何 id 的对局：各自独立计一组
    if (seen[k]) return;
    seen[k] = true;
    n++;
  });
  return n;
}

/**
 * 收集一段对局的队伍 id 集合
 * @param {Array} list 比赛数组
 * @returns {Object} id → true
 */
function teamSetOf(list) {
  const set = {};
  (list || []).forEach(function (m) {
    if (!m) return;
    const a = Number(m.radiant_team_id);
    const b = Number(m.dire_team_id);
    if (a > 0) set[a] = true;
    if (b > 0) set[b] = true;
  });
  return set;
}

/**
 * 赛段切分
 *
 * 规则：
 *  a) 传入有效 mainStart（> 1e9）→ 按窗口切：start_time < mainStart-6h 的归 playin；
 *     mainEnd 有效时 start_time > mainEnd+72h 的也归 playin（防赛后加赛污染）。basis='window'
 *  b) 无窗口 → 保守启发式：按开赛时间排序找最大间隔，要求
 *     「间隔 ≥ 72h + 左段 ≥3 个 series + 右段 ≥3 个 series + 两段队伍集合交集占比 < 50%」
 *     才切分（早的一段为 playin），basis='gap'；否则全部 main，basis='none'
 *  c) 输入为空/非法 → { main: [], playin: [], basis: 'none' }
 *
 * @param {Array} matches OpenDota 比赛数组
 * @param {{mainStart?:number, mainEnd?:number}} [opts] 正赛窗口（unix 秒，可缺省）
 * @returns {{main:Array, playin:Array, basis:string, mainStart:number, mainEnd:number}}
 */
function splitStages(matches, opts) {
  const empty = { main: [], playin: [], basis: 'none', mainStart: 0, mainEnd: 0 };
  const list = (Array.isArray(matches) ? matches : []).filter(function (m) {
    return m && typeof m === 'object';
  });
  if (!list.length) return empty;

  const o = opts || {};
  const mainStart = toSec(o.mainStart);
  const mainEnd = toSec(o.mainEnd);

  // ===== a) 有正赛窗口：按窗口切 =====
  if (mainStart > MIN_VALID_TS) {
    const main = [], playin = [];
    list.forEach(function (m) {
      const t = startOf(m);
      // 无时间的对局无法判窗 → 保守归 main（不因缺字段丢数据）
      if (t > 0 && t < mainStart - PLAYIN_LEAD_SEC) { playin.push(m); return; }
      if (mainEnd > MIN_VALID_TS && t > mainEnd + POST_MAIN_GRACE_SEC) { playin.push(m); return; }
      main.push(m);
    });
    return {
      main: main,
      playin: playin,
      basis: 'window',
      mainStart: mainStart,
      mainEnd: mainEnd > MIN_VALID_TS ? mainEnd : 0
    };
  }

  // ===== b) 无窗口：保守启发式（按时间找最大间隔）=====
  const untimed = [];      // 无开赛时间 → 恒归 main
  const timed = [];
  list.forEach(function (m) {
    if (startOf(m) > 0) timed.push(m);
    else untimed.push(m);
  });
  if (timed.length < MIN_SERIES_PER_STAGE * 2) {
    // 对局太少，不可能是两段（防误切）
    return { main: list.slice(), playin: [], basis: 'none', mainStart: 0, mainEnd: 0 };
  }
  timed.sort(function (x, y) { return startOf(x) - startOf(y); });
  let bestGap = 0, bestIdx = -1;
  for (let i = 1; i < timed.length; i++) {
    const gap = startOf(timed[i]) - startOf(timed[i - 1]);
    if (gap > bestGap) { bestGap = gap; bestIdx = i; }
  }
  if (bestGap >= MIN_GAP_SEC && bestIdx > 0) {
    const left = timed.slice(0, bestIdx);
    const right = timed.slice(bestIdx);
    if (countSeries(left) >= MIN_SERIES_PER_STAGE && countSeries(right) >= MIN_SERIES_PER_STAGE) {
      // 队伍集合交集占比：以「较小集合」为分母（最保守 —— 只有几乎换了一批队才切）
      const lSet = teamSetOf(left);
      const rSet = teamSetOf(right);
      const lIds = Object.keys(lSet);
      const rIds = Object.keys(rSet);
      let inter = 0;
      lIds.forEach(function (id) { if (rSet[id]) inter++; });
      const denom = Math.min(lIds.length, rIds.length);
      const overlap = denom > 0 ? inter / denom : 1;   // 无法判定队伍 → 视为重叠（不切）
      if (overlap < MAX_TEAM_OVERLAP) {
        const main = right.concat(untimed);
        return {
          main: main,
          playin: left,
          basis: 'gap',
          mainStart: startOf(right[0]) || 0,
          mainEnd: startOf(right[right.length - 1]) || 0
        };
      }
    }
  }
  // 未达切分门槛 → 全部 main（宁可漏切，不可误切）
  return { main: list.slice(), playin: [], basis: 'none', mainStart: 0, mainEnd: 0 };
}

/**
 * 判定单个 series 是否属于 playin
 * 2026-11-15：供页面标注（卡片「预选赛」小标签）。series 自带 start_time/startTime
 * 时按 split 的窗口判定；无时间字段 → false（不标注，避免误标）。
 * 判定结果同时写回 series.isPlayin（页面 wxml 直接读该字段）。
 *
 * @param {Object} series series 对象（groupSeries 输出或页面聚合对象）
 * @param {{mainStart?:number, mainEnd?:number}} split splitStages 的返回值
 * @returns {boolean} 是否 playin
 */
function seriesStageOf(series, split) {
  if (!series || typeof series !== 'object') return false;
  const s = split || {};
  const mainStart = toSec(s.mainStart);
  if (!(mainStart > MIN_VALID_TS)) {
    series.isPlayin = false;
    return false;
  }
  const t = startOf(series);
  if (!t) {
    series.isPlayin = false;
    return false;
  }
  const mainEnd = toSec(s.mainEnd);
  const isPlayin = (t < mainStart - PLAYIN_LEAD_SEC) ||
    (mainEnd > MIN_VALID_TS && t > mainEnd + POST_MAIN_GRACE_SEC);
  series.isPlayin = isPlayin;
  return isPlayin;
}

module.exports = {
  splitStages: splitStages,
  seriesStageOf: seriesStageOf,
  countSeries: countSeries
};
