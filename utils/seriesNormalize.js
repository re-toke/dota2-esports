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

// 合并优先级表（写入代码常量，避免只存在于文档；当前 P1 仅审计用途）
const MERGE_PRIORITY = {
  name: ['curation', 'consensus', 'opendota'],
  period: ['curation', 'liquipedia', 'opendota'],
  prize: ['liquipedia', 'curation'],
  participants: ['liquipedia', 'curation', 'derived'],
  status: ['derived'],
};

const TBD_RE = /^(tbd|tba|待定|待公布|unknown|天辉|夜魇)$/i;

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
    const tbdA = TBD_RE.test(_nameOf(s, 'a'));
    const tbdB = TBD_RE.test(_nameOf(s, 'b'));
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
  scoresOf,
  isDecided,
  normalizeTerminal,
  addSource,
  unionSources,
  validateSeries,
};
