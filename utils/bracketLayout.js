// utils/bracketLayout.js
// P3.1（2026-10-26）：对战表布局纯函数（不含 wx / DOM），输出 rpx 坐标与连线。
// 输入：bracket（parseBrackets / CI payload：{ slots, rounds }）
// 输出：{ width, height, sections: [{ side, label, y, height, rounds:[{label,x}], cards, lines }] }
// 约束：MVP 只画「同 section 内相邻轮」的连线；Upper→Lower 降级线留 P4。
'use strict';

const CARD_W = 280;
const COL_GAP = 64;
const H = 132;
const G = 24;
const SECTION_GAP = 24;
const HEADER_H = 56;   // 分区标题 24 + 轮次表头 24 + 间距（视觉验证修正：原 44 导致标题重叠）

const SIDE_ORDER = { upper: 0, main: 1, lower: 2, final: 3, third: 4, qualifier: 5 };
const SIDE_LABEL = {
  upper: 'Upper Bracket',
  lower: 'Lower Bracket',
  main: '淘汰赛',
  final: 'Grand Final',
  third: '季军赛',
  qualifier: '突围赛'
};

function _sideOfRound(r) {
  if (r && r.side) return r.side;
  return 'main';
}

/** 首轮按序排；后续轮按「上一轮 2j / 2j+1」中心平均，缺子节点时按指数间距兜底 */
function _placeRound(cards, prevCards, roundIndex) {
  const baseGap = H + G;
  return cards.map((m, j) => {
    let y;
    if (roundIndex === 0) {
      y = j * baseGap;
    } else if (prevCards && prevCards.length) {
      const c1 = prevCards[j * 2];
      const c2 = prevCards[j * 2 + 1];
      if (c1 && c2) y = ((c1.y + H / 2) + (c2.y + H / 2)) / 2 - H / 2;
      else if (c1) y = c1.y;
      else y = j * baseGap * Math.pow(2, roundIndex);
    } else {
      y = j * baseGap * Math.pow(2, roundIndex);
    }
    return Object.assign({}, m, { x: roundIndex * (CARD_W + COL_GAP), y: y });
  });
}

/** 连线：子卡右中 → 父卡左中，两段折线（水平 + 垂直） */
function _linesFor(prev, cur) {
  const lines = [];
  cur.forEach((p, j) => {
    const midX = p.x - COL_GAP / 2;
    const py = p.y + H / 2;
    const kids = [prev[j * 2], prev[j * 2 + 1]].filter(Boolean);
    kids.forEach((c) => {
      const cy = c.y + H / 2;
      const cx = c.x + CARD_W;
      lines.push({ left: cx, top: cy - 1, width: Math.max(1, midX - cx), height: 2 });
      if (Math.abs(py - cy) > 1) {
        lines.push({ left: midX - 1, top: Math.min(py, cy), width: 2, height: Math.abs(py - cy) });
      }
    });
    if (kids.length) lines.push({ left: midX, top: py - 1, width: COL_GAP / 2, height: 2 });
  });
  return lines;
}

function _cardFromSlot(s, formatTime) {
  const empty = !!s.empty;
  const t1 = s.team1Name || 'TBD';
  const t2 = s.team2Name || 'TBD';
  const tbd1 = /^(tbd|tba|待定|待公布|unknown)$/i.test(t1);
  const tbd2 = /^(tbd|tba|待定|待公布|unknown)$/i.test(t2);
  const finished = !!s.finished;
  const winner = finished && s.score1 !== s.score2 ? (s.score1 > s.score2 ? 'A' : 'B') : '';
  return {
    key: s.key || ('R' + s.roundNo + 'M' + s.slotNo),
    empty: empty,
    team1: tbd1 ? '待定' : t1,
    team2: tbd2 ? '待定' : t2,
    tbd1: tbd1, tbd2: tbd2,
    score1: empty ? '' : s.score1,
    score2: empty ? '' : s.score2,
    winner: winner,
    finished: finished,
    boType: s.boType || '',
    timeLabel: s.startTime ? (formatTime ? formatTime(s.startTime) : '') : '',
    matchId: (s.matchIds && s.matchIds.length) ? s.matchIds[0] : 0,
    live: s.phase === 'live' && !finished
  };
}

/**
 * @param {object} bracket { slots: [...], rounds: [{no,side,label,matches}] }
 * @param {object} [opts] { formatTime: fn }
 */
function layoutBracket(bracket, opts) {
  const o = opts || {};
  const slots = (bracket && bracket.slots) || [];
  const rounds = (bracket && bracket.rounds) || [];
  if (!slots.length && !rounds.length) return { width: 0, height: 0, sections: [] };

  // 以 rounds 为准分组（含 side），slots 兜底
  let groups = rounds.map((r) => ({ side: _sideOfRound(r), no: r.no, label: r.label, matches: r.matches || [] }));
  if (!groups.length) {
    const byKey = {};
    slots.forEach((s) => {
      const side = s.side || 'main';
      const k = side + '|' + s.roundNo;
      if (!byKey[k]) byKey[k] = { side, no: s.roundNo, label: '', matches: [] };
      byKey[k].matches.push(s);
    });
    groups = Object.keys(byKey).map((k) => byKey[k]);
  }

  // section 顺序：upper → main → lower → final → third → qualifier
  const sideSet = {};
  groups.forEach((g) => { sideSet[g.side] = 1; });
  const sides = Object.keys(sideSet).sort((a, b) => (SIDE_ORDER[a] == null ? 9 : SIDE_ORDER[a]) - (SIDE_ORDER[b] == null ? 9 : SIDE_ORDER[b]));

  let yOffset = 0;
  let maxWidth = 0;
  const sections = [];
  sides.forEach((side) => {
    const rs = groups.filter((g) => g.side === side).sort((a, b) => a.no - b.no);
    const placedRounds = [];
    let prev = [];
    let sectionHeight = 0;
    const lines = [];
    const roundHeaders = [];
    rs.forEach((r, idx) => {
      const list = (r.matches || []).slice().sort((a, b) => (a.slotNo || 0) - (b.slotNo || 0));
      const cards = _placeRound(list.map((s) => _cardFromSlot(s, o.formatTime)), prev, idx);
      if (prev.length) lines.push.apply(lines, _linesFor(prev, cards));
      placedRounds.push(cards);
      roundHeaders.push({ label: r.label || ('R' + r.no), x: idx * (CARD_W + COL_GAP) });
      cards.forEach((c) => { sectionHeight = Math.max(sectionHeight, c.y + H); });
      prev = cards;
    });
    const width = Math.max(0, (rs.length - 1) * (CARD_W + COL_GAP) + CARD_W);
    const sectionY = yOffset + HEADER_H;
    const cards = [];
    placedRounds.forEach((list, idx) => {
      list.forEach((c) => {
        cards.push(Object.assign({}, c, { y: c.y + sectionY }));
      });
    });
    // 连线坐标同样平移到 sectionY
    const shiftedLines = lines.map((l) => Object.assign({}, l, { top: l.top + sectionY }));
    sections.push({
      side: side,
      label: SIDE_LABEL[side] || side,
      y: yOffset,
      height: HEADER_H + sectionHeight + 8,
      rounds: roundHeaders,
      cards: cards,
      lines: shiftedLines
    });
    maxWidth = Math.max(maxWidth, width);
    yOffset += HEADER_H + sectionHeight + SECTION_GAP;
  });

  return { width: maxWidth, height: yOffset, sections: sections, cardW: CARD_W, cardH: H };
}

module.exports = {
  layoutBracket: layoutBracket,
  CARD_W: CARD_W,
  CARD_H: H,
  COL_GAP: COL_GAP
};
