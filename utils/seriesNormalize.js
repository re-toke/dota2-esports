// utils/seriesNormalize.js
// ============================================================
// P1（2026-10-25）：系列赛归一化的**纯函数层**（不依赖 wx / this / setData），
// 供客户端与 Node 测试共用。目标：
//   1) 统一「比分形状」——赛事页同时存在 scoreA/scoreB（归一后）与 score1/score2（LP 原始）；
//   2) 统一「比分终局 → phase/isLive 归一」的写法（原先散落在页面两处，且 LP 路径读错字段）；
//   3) 为 series 打**来源标记**（provenance），供对阵卡来源 chip 使用；
//   4) 提供不变量校验（仅测试/诊断用，不参与线上渲染）。
// ⚠️ 合并编排（800+ 行）仍在页面内，P1b 再逐段搬迁；本模块只收敛可安全抽出的纯逻辑。
'use strict';

const seriesStatus = require('./seriesStatus.js');
const names = require('./names.js');
const sourcesPure = require('./sourcesPure.js');   // 零依赖纯函数层（LP live 归一）

// TBD / 待定 队名识别（与详情页原模块级实现逐字一致）
const TBD_TEAM_RE = /^(tbd|待定|待公布|unknown|tba|to\s+be\s+(determined|announced))$/i;

/** 空串或 TBD/待定 → true */
function isTbd(name) {
  const s = String(name == null ? '' : name).trim();
  if (!s) return true;
  return TBD_TEAM_RE.test(s);
}

/** 队名去重归一：小写 + 去常见后缀（含 CJK 族），单一实现见 names.js */
function normalizeTeamNameForDedup(name) {
  return names.normTeamNameCjk(name);
}

/** 对阵去重键（顺序无关）；任一方 TBD → null（不参与合并） */
function dedupeKey(n1, n2) {
  if (isTbd(n1) || isTbd(n2)) return null;
  return normalizeTeamNameForDedup(n1) + '__' + normalizeTeamNameForDedup(n2);
}

/** 队名模糊匹配：归一后全等，或长度 ≥3 的双向包含 */
function fuzzyMatchName(a, b) {
  const na = normalizeTeamNameForDedup(a);
  const nb = normalizeTeamNameForDedup(b);
  if (!na || !nb || na.length < 3 || nb.length < 3) return false;
  if (na === nb) return true;
  return na.indexOf(nb) >= 0 || nb.indexOf(na) >= 0;
}

/**
 * 「含 TBD 的占位卡是否已被双方已定的实际比赛覆盖」（原详情页闭包，P1b 抽出）。
 * 仅当：① 恰有一方未定；② 已定方与某键严格相等；③ 开赛差 <2h → 判为已覆盖。
 * @param {object} m LP 排期条目（team1Name/team2Name/startTime）
 * @param {Map<string, number>} keysMap 已定对阵键 → 首场时间
 * @param {Map<string, number[]>} timeMap 键 → 多场时间数组
 */
function placeholderCoveredByReal(m, keysMap, timeMap) {
  if (!m || !keysMap || typeof keysMap.forEach !== 'function') return false;
  const tbd1 = isTbd(m.team1Name);
  const tbd2 = isTbd(m.team2Name);
  if (!tbd1 && !tbd2) return false;
  if (tbd1 && tbd2) return false;
  const known = normalizeTeamNameForDedup(tbd1 ? m.team2Name : m.team1Name);
  const mStart = m.startTime || 0;
  if (!known || known.length < 3 || !mStart) return false;
  let covered = false;
  keysMap.forEach((t0, k) => {
    if (covered) return;
    const parts = String(k).split('__');
    if (parts.length !== 2) return;
    if (parts[0] !== known && parts[1] !== known) return;
    const arr = (timeMap && typeof timeMap.get === 'function') ? timeMap.get(k) : null;
    const times = (arr && arr.length) ? arr : (t0 ? [t0] : []);
    for (let i = 0; i < times.length; i++) {
      if (times[i] && Math.abs(mStart - times[i]) < 2 * 3600) { covered = true; break; }
    }
  });
  return covered;
}

/**
 * 「实际开赛证据」判定（原详情页 live filter 内联块，P1b 抽出）：
 * 满足任一即放行 —— E1 比分非 0:0；E2 真实 matchId；E3 games 有已开赛局；E4 规划时间已过 15min。
 */
function hasKickoffProof(s, nowSec) {
  if (!s) return false;
  const s1 = typeof s.score1 === 'number' ? s.score1 : 0;
  const s2 = typeof s.score2 === 'number' ? s.score2 : 0;
  const a = typeof s.scoreA === 'number' ? s.scoreA : 0;
  const b = typeof s.scoreB === 'number' ? s.scoreB : 0;
  if ((s1 + s2) > 0 || (a + b) > 0) return true;
  if (Array.isArray(s.matchIds) && s.matchIds.length > 0) {
    const first = s.matchIds[0];
    if (typeof first === 'number' && first > 0) return true;
  }
  if (Array.isArray(s.games) && s.games.length > 0) {
    for (let i = 0; i < s.games.length; i++) {
      const g = s.games[i];
      if (g && (g.radiant_win != null || (g.start_time && g.start_time <= nowSec + 60))) return true;
    }
  }
  const start = s.lastTime || 0;
  return !!start && (nowSec - start) >= 15 * 60;
}

/**
 * 「系列比分已达 BO 上限」（原详情页 live filter 内联块，P1b 抽出）。
 * 注意：与 `seriesStatus.isDecidedByScore` 语义不同（BO2 必须打满 2 局；依赖 BO 推导）。
 */
function isSeriesEndedByBoLimit(s) {
  if (!s) return false;
  const sc = scoresOf(s);
  if (sc.a + sc.b <= 0) return false;
  let boNum = 0;
  const boMatch = s.boType ? String(s.boType).match(/^BO\s*([1-9])$/i) : null;
  if (boMatch) {
    boNum = parseInt(boMatch[1], 10);
  } else if (s.seriesType != null && s.seriesType >= 0) {
    boNum = [1, 3, 5, 2, 7][s.seriesType] || 0;
  }
  if (boNum <= 0) return false;
  if (boNum === 2) return (sc.a + sc.b) >= 2;
  return Math.max(sc.a, sc.b) >= Math.ceil(boNum / 2);
}


// 合并优先级表（写入代码常量，避免只存在于文档；当前 P1 仅审计用途）
const MERGE_PRIORITY = {
  name: ['curation', 'consensus', 'opendota'],
  period: ['curation', 'liquipedia', 'opendota'],
  prize: ['liquipedia', 'curation'],
  participants: ['liquipedia', 'curation', 'derived'],
  status: ['derived'],
};

/** 读取系列比分：兼容 scoreA/scoreB（归一后）与 score1/score2（LP 原始） */
function scoresOf(series) {
  if (!series) return { a: 0, b: 0 };
  if (series.scoreA != null || series.scoreB != null) {
    return { a: Number(series.scoreA) || 0, b: Number(series.scoreB) || 0 };
  }
  return { a: Number(series.score1) || 0, b: Number(series.score2) || 0 };
}

/** 是否由比分判定终局（与来源 phase / BO 推导无关；规则见 seriesStatus） */
function isDecided(series, boType) {
  const sc = scoresOf(series);
  const bo = boType || (series && series.boType);
  return seriesStatus.isDecidedByScore(sc.a, sc.b, bo);
}

/**
 * 终局归一：来源仍报 live、但比分已达终局时，同步改 phase 与 isLive。
 * 返回是否发生归一（供调用方决定是否打日志）。
 */
function normalizeTerminal(series) {
  if (!series || series.phase !== 'live' || !isDecided(series)) return false;
  series.phase = 'recent';
  series.isLive = false;
  return true;
}

/** 给系列追加来源标记（去重、稳定顺序） */
function addSource(series, key) {
  if (!series || !key) return series;
  const list = Array.isArray(series.sources) ? series.sources.slice() : [];
  if (list.indexOf(key) < 0) list.push(key);
  series.sources = list;
  return series;
}

/** 合并多个系列的来源标记（用于吸收/去重/拆裂合并后的新对象） */
function unionSources(seriesList) {
  const out = [];
  (seriesList || []).forEach((s) => {
    (Array.isArray(s && s.sources) ? s.sources : []).forEach((k) => {
      if (out.indexOf(k) < 0) out.push(k);
    });
  });
  return out;
}

function _boNumber(bo) {
  const n = parseInt(String(bo == null ? '' : bo).replace(/[^0-9]/g, ''), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function _nameOf(series, side) {
  if (!series) return '';
  if (side === 'a') return String(series.radiantName || series.team1Name || '');
  return String(series.direName || series.team2Name || '');
}

/**
 * Liquipedia 卡的时间窗过滤（原详情页 1198-1276 行整段抽出，P1b）：
 *   · LIVE：必须有开赛时间、开赛 6h 内、且有「实际开赛证据」、比分未达 BO 上限；
 *   · UPCOMING：北京时间「今天起 3 天内」；
 *   · RECENT：全部保留。
 * @param {Array} cards 已映射的 LP 系列
 * @param {number} nowSec 当前秒
 * @param {number} bjOffsetSec 北京时间偏移秒（默认 8h）
 */
function filterLiquipediaCardsByWindow(cards, nowSec, bjOffsetSec) {
  const offset = bjOffsetSec == null ? 8 * 3600 : bjOffsetSec;
  const bjNow = nowSec + offset;
  const todayStart = Math.floor(bjNow / 86400) * 86400 - offset;
  const threeDaysEnd = todayStart + 3 * 86400;
  return (cards || []).filter((s) => {
    const st = s.lastTime || 0;
    if (s.phase === 'live') {
      if (!st) return false;
      const elapsed = nowSec - st;
      if (!(elapsed >= -60 && elapsed < 6 * 3600)) return false;
      if (!hasKickoffProof(s, nowSec)) return false;
      if (isSeriesEndedByBoLimit(s)) return false;
      return true;
    }
    if (s.phase === 'upcoming') return st >= todayStart && st < threeDaysEnd;
    return true;
  });
}

/** 来源 chip 文案（P2）：od / lp / od+lp */
function sourceTagOf(series) {
  const arr = Array.isArray(series && series.sources) ? series.sources : [];
  const hasOd = arr.indexOf('od') >= 0;
  const hasLp = arr.indexOf('lp') >= 0;
  if (hasOd && hasLp) return { label: 'OD+LP', cls: 'odlp' };
  if (hasLp) return { label: 'LP', cls: 'lp' };
  if (hasOd) return { label: 'OD', cls: 'od' };
  return { label: '', cls: '' };
}

/**
 * OD 侧归一（原详情页 buildSeriesFromSources 开头块，P1b-2）：
 * groupSeries → 逐局 fmt（注入）→ upcoming 展示字段。
 * @param {Array} raw OpenDota 比赛
 * @param {{groupSeries:Function, fmt:Function, nowSec:number}} opts
 */
function normalizeOpenDotaSeries(raw, opts) {
  const o = opts || {};
  const group = typeof o.groupSeries === 'function' ? o.groupSeries : null;
  const fmt = typeof o.fmt === 'function' ? o.fmt : (m) => m;
  const nowSec = Number(o.nowSec) || Math.floor(Date.now() / 1000);
  if (!group) return [];
  const anchor = { teamAId: 0, teamBId: 0 };
  return (group(raw) || []).map((s) => {
    anchor.teamAId = s.radiantTeamId;
    anchor.teamBId = s.direTeamId;
    s.games = (s.games || []).map((m) => fmt(m, anchor));
    if (s.isUpcoming) {
      const st = s.lastTime;
      const d = new Date(st * 1000);
      const md = (d.getMonth() + 1) + '/' + d.getDate();
      const hh = ('0' + d.getHours()).slice(-2);
      const mm = ('0' + d.getMinutes()).slice(-2);
      s.scheduledTimeText = md + ' ' + hh + ':' + mm;
      const diffSec = st - nowSec;
      if (diffSec <= 300) s.countdownText = '即将开始';
      else if (diffSec < 3600) s.countdownText = Math.floor(diffSec / 60) + '分钟后';
      else if (diffSec < 86400) s.countdownText = Math.floor(diffSec / 3600) + '小时后';
      else s.countdownText = Math.floor(diffSec / 86400) + '天后';
    }
    return s;
  });
}

/**
 * LP 排期 → 展示用 series（原详情页 `.map()` 块，P1b-2）。
 * 内含：终局归一、TBD 不判 live、比分/风格、upcoming 展示字段、稳定 key、provenance。
 * @param {Array} liqGrouped groupLiquipediaMatches 输出
 * @param {{nowSec:number, log?:Function}} opts
 */
function mapLiquipediaCards(liqGrouped, opts) {
  const o = opts || {};
  const nowSec = Number(o.nowSec) || Math.floor(Date.now() / 1000);
  const log = typeof o.log === 'function' ? o.log : function () {};
  return (liqGrouped || []).map((m) => {
    // 为 upcoming series 补全展示字段
    let scheduledTimeText = '', countdownText = '';
    if (m.startTime) {
      const d = new Date(m.startTime * 1000);
      const md = (d.getMonth() + 1) + '/' + d.getDate();
      const hh = ('0' + d.getHours()).slice(-2);
      const mm = ('0' + d.getMinutes()).slice(-2);
      scheduledTimeText = md + ' ' + hh + ':' + mm;
      const diffSec = m.startTime - nowSec;
      if (diffSec <= 300) countdownText = '即将开始';
      else if (diffSec < 3600) countdownText = Math.floor(diffSec / 60) + '分钟后';
      else if (diffSec < 86400) countdownText = Math.floor(diffSec / 3600) + '小时后';
      else countdownText = Math.floor(diffSec / 86400) + '天后';
    }
    // 比分终局 → phase 归一（LP phase 常滞后）
    if (normalizeTerminal(m)) log('[league-detail] 比分达终局（LP）→ phase 归一为 recent');
    // 对阵未定（TBD）不得视为 live
    if (m.phase === 'live') {
      const np = sourcesPure.normalizeLpLivePhase(m.phase, m.team1Name, m.team2Name);
      if (np !== m.phase) {
        m.phase = np;
        log('[league-detail] 对阵未定（TBD）→ phase 归一为 ' + np);
      }
    }
    // 从 Liquipedia 提取比分（TeamOpponent|score=N）
    const liqScoreA = m.score1 || 0;
    const liqScoreB = m.score2 || 0;
    const bForfeit = m.walkover > 0;
    const forfeitSide = m.walkover === 1 ? 'A' : (m.walkover === 2 ? 'B' : '');
    // isRecent：startTime + 4h 窗口估算（LP 无 duration）
    let liqIsRecent = false;
    if (m.phase === 'recent' && m.startTime > 0) {
      const elapsedSec = nowSec - m.startTime;
      liqIsRecent = elapsedSec > 0 && elapsedSec < 4 * 3600;
    }
    // LIVE elapsedSec 估算
    const liqElapsedSec = m.phase === 'live' ? Math.max(0, nowSec - m.startTime) : 0;
    const confirmed = !isTbd(m.team1Name) && !isTbd(m.team2Name);
    const stageLabel = m.section || '';
    const liqIsDraw = liqScoreA === liqScoreB && m.phase === 'recent';
    const liqScoreACls = liqIsDraw ? 'draw' : (liqScoreA > liqScoreB ? 'win' : (m.phase === 'recent' ? 'lose' : ''));
    const liqScoreBCls = liqIsDraw ? 'draw' : (liqScoreB > liqScoreA ? 'win' : (m.phase === 'recent' ? 'lose' : ''));
    const liqTeamACls = liqIsDraw ? 'draw' : (liqScoreA > liqScoreB ? 'win' : '');
    const liqTeamBCls = liqIsDraw ? 'draw' : (liqScoreB > liqScoreA ? 'win' : '');
    return {
      // startTime 分钟桶：同一对局在 ±60s 内的差异归一为同一 key（防 logo 回填失配）
      key: 'liq-' + normalizeTeamNameForDedup(m.team1Name) + '__' + normalizeTeamNameForDedup(m.team2Name) + '-' + Math.floor((m.startTime || 0) / 60),
      games: [],               // Liquipedia 赛程无小场数据
      scoreA: liqScoreA,
      scoreB: liqScoreB,
      boType: m.boType,
      boLabel: m.boType === 'BO1' ? '单局制' : (m.boType === 'BO2' ? '双局积分' : (m.boType === 'BO3' ? '三局两胜' : '五局三胜')),
      boTagCls: m.boType === 'BO2' ? 'bo-bo2' : (m.boType === 'BO3' ? 'bo-bo3' : (m.boType === 'BO5' ? 'bo-bo5' : '')),
      declaredBo: m.boDeclared ? m.boType : null,   // S1 信号：仅显式 bestof
      seriesType: (m.series_type != null ? m.series_type : null),   // S3 信号
      mapSlots: m.mapSlots || 0,                   // S4.5 信号
      isDraw: liqIsDraw,
      isLive: (m.phase === 'live') && !isDecided(m, m.boType),
      isRecent: liqIsRecent,
      identitySource: m.identitySource || null,
      isUpcoming: m.phase === 'upcoming',
      phase: m.phase,
      sources: ['lp'],                            // provenance
      isMulti: m.boType !== 'BO1',
      matchIds: m.matchIds || [],
      series_id: m.series_id != null ? m.series_id : null,
      team1Name: m.team1Name,
      team2Name: m.team2Name,
      radiantName: m.team1Name,
      direName: m.team2Name,
      radiantTeamId: 0,        // Liquipedia 赛程无 team_id
      direTeamId: 0,
      radiantWin: !liqIsDraw && liqScoreA > liqScoreB,
      direWin: !liqIsDraw && liqScoreB > liqScoreA,
      scoreACls: liqScoreACls,
      scoreBCls: liqScoreBCls,
      teamACls: liqTeamACls,
      teamBCls: liqTeamBCls,
      teamALogoCls: !liqIsDraw && liqScoreA > liqScoreB ? 'team-win' : '',
      teamBLogoCls: !liqIsDraw && liqScoreB > liqScoreA ? 'team-win' : '',
      radiantLogo: '',
      direLogo: '',
      radiantLogoSource: '',
      direLogoSource: '',
      scheduledTimeText: scheduledTimeText,
      countdownText: countdownText,
      liveProgress: '',     // Liquipedia 无小场数据
      elapsedSec: liqElapsedSec,
      elapsedText: '',
      confirmed: confirmed,
      stageLabel: stageLabel,
      bForfeit: bForfeit,
      forfeitSide: forfeitSide,
      section: m.section || '',
      lastTime: m.startTime
    };
  });
}

/**
 * 系列不变量校验（测试 / 诊断用）。
 * 规则：① 比分总和不得超 BO；② 单方胜局不得超「拿下该 BO 所需胜局」；
 *      ③ 含 TBD/占位的系列不得为 live；④ 不得同时标记双方获胜。
 * @returns {Array<{key:string, rule:string, detail:string}>}
 */
function validateSeries(seriesList) {
  const out = [];
  (seriesList || []).forEach((s, i) => {
    const key = (s && s.key) || ('#' + i);
    const sc = scoresOf(s);
    const boNum = _boNumber(s && s.boType);
    if (boNum > 0) {
      if (sc.a + sc.b > boNum) {
        out.push({ key, rule: 'score-sum-exceeds-bo', detail: sc.a + ':' + sc.b + ' ' + s.boType });
      }
      const maxWins = boNum <= 2 ? 1 : Math.ceil(boNum / 2);
      if (sc.a > maxWins) out.push({ key, rule: 'wins-exceed-max', detail: 'A=' + sc.a + ' ' + s.boType });
      if (sc.b > maxWins) out.push({ key, rule: 'wins-exceed-max', detail: 'B=' + sc.b + ' ' + s.boType });
    }
    const tbdA = isTbd(_nameOf(s, 'a')) || /^(天辉|夜魇)$/.test(_nameOf(s, 'a'));
    const tbdB = isTbd(_nameOf(s, 'b')) || /^(天辉|夜魇)$/.test(_nameOf(s, 'b'));
    if ((tbdA || tbdB) && s && s.phase === 'live') {
      out.push({ key, rule: 'tbd-not-live', detail: _nameOf(s, 'a') + ' vs ' + _nameOf(s, 'b') });
    }
    if (s && s.radiantWin && s.direWin) {
      out.push({ key, rule: 'double-winner', detail: _nameOf(s, 'a') + ' vs ' + _nameOf(s, 'b') });
    }
  });
  return out;
}

module.exports = {
  MERGE_PRIORITY,
  isTbd,
  normalizeTeamNameForDedup,
  dedupeKey,
  fuzzyMatchName,
  placeholderCoveredByReal,
  hasKickoffProof,
  isSeriesEndedByBoLimit,
  filterLiquipediaCardsByWindow,
  normalizeOpenDotaSeries,
  mapLiquipediaCards,
  sourceTagOf,
  scoresOf,
  isDecided,
  normalizeTerminal,
  addSource,
  unionSources,
  validateSeries,
};
