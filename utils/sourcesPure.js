// utils/sourcesPure.js
// ★★ 2026-10-14（P2-24）：从 `utils/sources.js` **逐字搬出**的「无交叉引用纯函数」集合。
//
// 动机（方案 §P2-24）：sources.js 是「重灾区」（~2900 行、require 图庞大），其中**承载正确性**的
//   纯计算（日期解析 / 赛期合并 / 自由文本 BO 提取 / 阶段归类 / 已结算·未结算局数 / LP live 归一）
//   此前只能通过整块 sources.js 才能触达 ⇒ 单测必须承担其全部依赖（config / tiers / curation /
//   stratz / steam / liquipedia …）。本模块把它们**独立成零依赖的纯函数层**，使其可被轻量单测。
//
// 设计约束（勿违背）：
//   · 本模块**零外部依赖** —— 只用内建 Date / Number / Math / String / 正则；不 require 任何 utils 模块。
//   · **逐字未改逻辑**（零行为变化）：搬运时仅移动位置，不改一行实现。
//   · 与 O-19 的关系：O-19 指出「整文件拆三模块会循环依赖」⇒ **禁止整文件拆分**；
//     本模块只搬「无交叉引用的纯函数」，**BO 引擎等强耦合部分仍保留在 sources.js 单体中**。
//   · sources.js 以解构 require 原样复用这些标识符，并在 module.exports 中**再导出**，
//     保持既有调用方（pages / subpackages / scripts）不变。
'use strict';

// 将 Liquipedia 返回的日期文本（如 '2025-08-15' / 'August 15, 2025'）归一为 Unix 秒。
// consensus.voteTime 只接受数值候选（normNum > 0），故 Liquipedia 的字符串日期必须先转换。
// 解析失败返回 null（该候选被跳过，不影响其它源）。
function liquipediaDateToUnix(text) {
  if (!text) return null;
  const s = String(text).trim();
  // 优先匹配 yyyy-MM-dd / yyyy/M/d（Liquipedia infobox 最常见的纯数字日期）
  const m = s.match(/(\d{4})[-/](\d{1,2})(?:[-/](\d{1,2}))?/);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = m[3] ? Number(m[3]) : 1;
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      return Math.floor(Date.UTC(y, mo - 1, d) / 1000);
    }
  }
  // 回退：英文日期 'August 15, 2025'（2026-08-03 加固：原 Date.parse 按本地时区
  // 解析无时间字符串，+8 时区会把日期偏移到前一天 16:00 UTC → 赛期 startDate 偏一天。
  // 改为手工解析 + Date.UTC 固定，消除本地时区依赖）
  const em = s.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (em) {
    const MONTHS2 = {
      'january': 0, 'february': 1, 'march': 2, 'april': 3, 'may': 4, 'june': 5,
      'july': 6, 'august': 7, 'september': 8, 'october': 9, 'november': 10, 'december': 11,
      'jan': 0, 'feb': 1, 'mar': 2, 'apr': 3, 'jun': 5, 'jul': 6,
      'aug': 7, 'sep': 8, 'oct': 9, 'nov': 10, 'dec': 11
    };
    const mIdx = MONTHS2[em[1].toLowerCase()];
    const d = Number(em[2]);
    const y = Number(em[3]);
    if (mIdx != null && d >= 1 && d <= 31 && y >= 2000) {
      return Math.floor(Date.UTC(y, mIdx, d) / 1000);
    }
  }
  // 最后兜底：原生 Date.parse（含时分秒的复杂格式）
  const t = Date.parse(s);
  return isFinite(t) ? Math.floor(t / 1000) : null;
}

// 剥离 4 位年份 token（如「PGL Wallachia **2026** Season 9」→「PGL Wallachia Season 9」）。
// 单一出口：展示名（canonicalLeagueName）与去重键（leagueBaseName）共用同一口径，
// **勿各自内联一份正则**（本项目「同一件事两套归一化」已反复成为 bug 温床）。
function stripYearTokens(rawName) {
  return String(rawName || '').replace(/\b(19|20)\d{2}\b/g, ' ').replace(/\s+/g, ' ').trim();
}

// ===== ⑤ 跨源赛期合并（2026-09-19 落地，口径经用户确认）=====
//
// 口径：**官方赛期源优先（Liquipedia 系：curation / upcoming-local 快照），缺口按字段回退** ——
//   · 首个「起止都完整」的源           → 全取
//   · 某源只有 start（LP endDate 不完整的常态）→ start 取该源，end 依次向下回退
//   · 某源无数据                       → 整体继续向下回退（**字段级**，绝不因不完整而整条丢弃）
//
// 本项目的典型顺序：curation > LP 快照 > OpenDota 真实比赛窗口。
// （haglund 赛程推得的窗口若可用，可插在 LP 快照与 OpenDota 之间 —— 接口形态相同。）
//
// ★ 修复的 bug 形态：原两处调用点（详情页 eventWindow / 列表页 dateRange）对快照回退都是
//   `if (entry.start && entry.end)` 的 **all-or-nothing** —— LP「endDate 不完整」（只给 start）时
//   整条官方赛期被丢弃，start 也被 OpenDota 比赛窗口覆盖（而 OpenDota 窗口常截断为已打场次），
//   表现为赛期显示错误甚至为空。
//
// @param {Array<{name:string, start:number, end:number}>} list 按**权威性降序**排列
// @returns {?{start:number, end:number, startFrom:string, endFrom:string}}
//          start/end 为秒级 unix（0 = 该端缺失，调用方决定是否渲染）；三源全空返回 null。
function mergeEventPeriod(list) {
  const arr = Array.isArray(list) ? list : [];
  const num = (v) => { const n = Number(v); return (isFinite(n) && n > 0) ? n : 0; };
  const out = { start: 0, end: 0, startFrom: '', endFrom: '' };
  for (let i = 0; i < arr.length; i++) {
    const s = arr[i] || {};
    const name = s.name || ('src' + i);
    if (!out.start && num(s.start)) { out.start = num(s.start); out.startFrom = name; }
    if (!out.end && num(s.end)) { out.end = num(s.end); out.endFrom = name; }
  }
  if (!out.start && !out.end) return null;
  // 守卫：end 早于 start = 跨源拼出的脏区间（如 LP start 在未来、OpenDota 窗口是历史数据）
  // → 丢弃 end（宁可只显示开始日，也不显示倒挂区间）
  if (out.end && out.start && out.end < out.start) { out.end = 0; out.endFrom = ''; }
  return out;
}

// 阶段文本 → 阶段键（LP section / 赛制文本）
function classifyStage(text) {
  if (!text) return '';
  const t = String(text).toLowerCase();
  if (/grand\s*final|决赛/.test(t)) return 'grandFinal';
  if (/group|round\s*[- ]?robin|小组|循环/.test(t)) return 'group';
  if (/playoff|淘汰|quarter\s*final|semi|round\s*of|upper\s*bracket|lower\s*bracket/.test(t)) return 'playoff';
  return '';
}

// 已结算局数（OpenDota 有 games；Liquipedia 无小场时用比分和估算）
// ★ 兼容两种字段：groupSeries 原始字段 radiant_win，以及 league-detail fmt() 变换后的 radiantWin（驼峰）
function settledCountOf(s) {
  if (s && s.games && s.games.length) {
    let n = 0;
    for (let i = 0; i < s.games.length; i++) {
      const g = s.games[i];
      if (g.radiant_win != null || g.radiantWin != null) n++;
    }
    return n;
  }
  if (s && s.phase === 'recent' && (s.scoreA || s.scoreB)) {
    return (s.scoreA || 0) + (s.scoreB || 0);
  }
  return 0;
}

// 未结算局数（LIVE「第 3 局 pending」判定用）
function pendingCountOf(s) {
  if (!s || !s.games || !s.games.length) return 0;
  let n = 0;
  for (let i = 0; i < s.games.length; i++) {
    const g = s.games[i];
    if (g.radiant_win == null && g.radiantWin == null) n++;
  }
  return n;
}

// S2a：从自由文本提取 BO 关键词（infobox format / 赛制描述，如 "Round robin (Bo2)"）
function boFromFreeText(text) {
  if (!text) return null;
  const m = String(text).match(/(?:Abbr\/)?Bo\s*(\d)|best\s*of\s*(\d)/i);
  return m ? ('BO' + (m[1] || m[2])) : null;
}

// ★★ 2026-09-27（用户实测修复）：LP 排期条目的 phase 归一 —— 「**对阵未定**」不得视为 live。
//
// ## 背景（实测现象）
// 赛事详情页出现一张「进行中」卡：`Team Yandex vs TBD`、比分 0:0、**无任何小场数据**，
// 却显示 `● LIVE · 已进行 2h 19m`（`elapsedText` 由"计划开赛时间"估算：见 league-detail 的 `liqElapsedSec`）。
//
// ## 根因
// LP 排期条目自带 `phase='live'`（计划时间已过），而详情页在构造 `liq-` 系列时**直接透传** `m.phase`
// （`phase: m.phase` / `isLive: (m.phase === 'live') && ...`）；
// 该页**唯一的"归一"闸门只处理「比分已达终局」**（`_decidedByScore`）⇒ **对 0:0 完全不生效** ⇒ 漏网。
//
// ## 判据（**刻意只取"绝对安全"的一条**）
// **对阵任一方未定（TBD / TBA / 待定 / 待公布 / unknown / 空）⇒ 该场不可能正在打** ⇒ 归一为 `upcoming`。
//   ★ **为什么不用更宽的判据**（如"零小场 / 零比分"）：OpenDota 对**刚开始**的比赛**收录滞后**
//     （`games` 可能暂空）⇒ 用"零数据"会**误伤真-live**（页面会显示"即将开始"而比赛正在打）。
//   ★ **为什么 TBD 这一条安全**：真在进行的比赛**双方队名必然已定** ⇒ 不会误伤。
//   ⇒ 本函数**只做 TBD 这一条**：宁可漏归一，不可误伤。
//
// ## 效果（一处修好两个可见错误）
// 归一为 `upcoming` 后：① 详情页 WXML 走 `upcoming` 分支 ⇒ **不再渲染 `● LIVE`**；
// ② `league-detail` 的 `liqElapsedSec = m.phase === 'live' ? ... : 0` ⇒ 自动归 0 ⇒ **不再显示「已进行 X」**。
//
// ⚠️ 口径：TBD 正则与 `subpackages/detail/league-detail/league-detail.js` 的 `TBD_RE` **同口径**，
//    如需修改请**两处同改**（本项目已有 3 处 TBD 正则，属已知的历史分散点）。
//
// @param {string} phase 原始 phase（'live' | 'upcoming' | 'recent'）
// @param {string} team1Name A 方队名
// @param {string} team2Name B 方队名
// @returns {string} 归一后的 phase（非 live 一律原样返回）
function normalizeLpLivePhase(phase, team1Name, team2Name) {
  if (phase !== 'live') return phase;
  const TBD_RE = /^(tbd|tba|待定|待公布|unknown|to\s+be\s+(determined|announced))$/i;
  const isTbd = function (n) { const s = String(n || '').trim(); return !s || TBD_RE.test(s); };
  if (isTbd(team1Name) || isTbd(team2Name)) return 'upcoming';
  return phase;
}

module.exports = {
  liquipediaDateToUnix: liquipediaDateToUnix,
  stripYearTokens: stripYearTokens,
  mergeEventPeriod: mergeEventPeriod,
  classifyStage: classifyStage,
  settledCountOf: settledCountOf,
  pendingCountOf: pendingCountOf,
  boFromFreeText: boFromFreeText,
  normalizeLpLivePhase: normalizeLpLivePhase
};
