// utils/bracketLayout.js
// P3.1（2026-10-26）：对战表布局纯函数（不含 wx / DOM），输出 rpx 坐标与连线。
// 输入：bracket（parseBrackets / CI payload：{ type, slots, rounds }）
// 输出：{ width, height, sections: [...], crossLines: [...] }
// 连线：① section 内相邻轮（lines）；② P4 Upper→Lower 降级线（crossLines，按 bracket type 映射表）。
//   ⚠️ wikitext 不写「败者来自哪场」（无 Loser of… 文本）⇒ 降级拓扑只能按 type 码查表；
//   未知 type 一律不画（不臆测），保持结构完整。
'use strict';

const CARD_W = 280;
const COL_GAP = 64;
// 2026-10-28（第 4 步 · 卡片三行压两行）：卡片内只剩「队1」「队2」两行 ——
// BO / LIVE 改为右上角徽标（绝对定位，不占行高），赛程时间在卡外汇总在卡片下方。
// ⚠️ 改本常量必须同步 `league-detail.wxss` 的 `.brk-card` 高度（页面用 `bracketView.cardH` 内联覆盖）
const H = 104;
// ★ 2026-10-31（P0-3）：G 24 → 32 —— 卡下沿要放「MM-DD HH:mm」两行时间（6+22=28rpx），
//   24 会让时间贴到下一张卡上沿。改本常量须同步 `test-bracket-layout` 的 CARD_GAP 守卫。
const G = 32;
// ★ 2026-10-31（真机反馈「视觉偏上/局促」）：分区之间加大呼吸，画布四边留白。
//   原来 24 让败者组紧贴胜者组、卡片贴左右边框，整张图显得顶在上沿。
const SECTION_GAP = 40;
const HEADER_H = 56;   // 分区标题 24 + 轮次表头 24 + 间距（视觉验证修正：原 44 导致标题重叠）
const PAD_X = 12;      // 画布左右留白（卡片不贴边框）
const PAD_TOP = 12;    // 分区标题距画布上沿
const PAD_BOTTOM = 16; // 底部留白（原来画布高度正好切在最后一张卡的下沿）

// ===== P4：Upper→Lower 降级线映射（match 级：from 场败者 → to 场）=====
// 8U4L2DSL1D（8 队标准双败，PGL Wallachia S9 / TI 2026 Main Event 同构）：
//   Upper QF(4) 败者 → Lower R1(2)；Upper SF(2) 败者 → Lower QF(2)；
//   Upper Final 败者 → Lower Final。槽位号取自 wikitext 的 R#M##（R1M1-4 / R1M5-6 / R2M3-4 / R4M2）。
const _PGL_DROPS = [
  { from: { side: 'upper', roundNo: 1, slotNo: 1 }, to: { side: 'lower', roundNo: 1, slotNo: 5 } },
  { from: { side: 'upper', roundNo: 1, slotNo: 2 }, to: { side: 'lower', roundNo: 1, slotNo: 5 } },
  { from: { side: 'upper', roundNo: 1, slotNo: 3 }, to: { side: 'lower', roundNo: 1, slotNo: 6 } },
  { from: { side: 'upper', roundNo: 1, slotNo: 4 }, to: { side: 'lower', roundNo: 1, slotNo: 6 } },
  { from: { side: 'upper', roundNo: 2, slotNo: 1 }, to: { side: 'lower', roundNo: 2, slotNo: 3 } },
  { from: { side: 'upper', roundNo: 2, slotNo: 2 }, to: { side: 'lower', roundNo: 2, slotNo: 4 } },
  { from: { side: 'upper', roundNo: 4, slotNo: 1 }, to: { side: 'lower', roundNo: 4, slotNo: 2 } }
];

const DROP_MAP = {
  'Bracket/8U4L2DSL1D': _PGL_DROPS,
  // EWC Playoffs Bracket/8、Survival Bracket/8L4D-4Q 均为单败/短赛制 ⇒ 无降级线
  'Bracket/8': [],
  'Bracket/8L4D-4Q': []
};

function _normType(t) {
  const s = String(t || '');
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
}

function _dropsOf(type) {
  const kinds = Object.keys(DROP_MAP);
  const key = _normType(type);
  for (let i = 0; i < kinds.length; i++) {
    if (_normType(kinds[i]) === key) return DROP_MAP[kinds[i]];
  }
  return [];
}

const SIDE_ORDER = { upper: 0, main: 1, lower: 2, final: 3, third: 4, qualifier: 5 };
const SIDE_LABEL = {
  upper: '胜者组',
  lower: '败者组',
  main: '淘汰赛',
  final: '总决赛',
  third: '季军赛',
  qualifier: '突围赛'
};

// 2026-10-28（方案 §12 缺口 10）：常见 LP 轮名 → 中文。
// 只映射能确定语义的固定写法，未知/自定义轮名原样保留（不硬猜）。
function _sideCn(s) {
  return /^u/i.test(s) ? '胜者组' : '败者组';
}
const ROUND_LABEL_RULES = [
  [/^(upper|lower)(?: bracket)? quarter-?finals$/i, (m) => _sideCn(m[1]) + '¼决赛'],
  [/^(upper|lower)(?: bracket)? semi-?finals?$/i, (m) => _sideCn(m[1]) + '半决赛'],
  [/^(upper|lower)(?: bracket)? round (\d+)$/i, (m) => _sideCn(m[1]) + '第' + m[2] + '轮'],
  [/^(upper|lower)(?: bracket)? finals?$/i, (m) => _sideCn(m[1]) + '决赛'],
  [/^grand finals?$/i, '总决赛'],
  [/^third place( match)?$/i, '季军赛'],
  [/^round (\d+)$/i, (m) => '第' + m[1] + '轮'],
  [/^quarter-?finals$/i, '¼决赛'],
  [/^semi-?finals?$/i, '半决赛'],
  [/^finals?$/i, '决赛']
];
function localizeRoundLabel(label) {
  const s = String(label == null ? '' : label).trim();
  if (!s) return s;
  for (let i = 0; i < ROUND_LABEL_RULES.length; i++) {
    const m = s.match(ROUND_LABEL_RULES[i][0]);
    if (m) {
      const out = ROUND_LABEL_RULES[i][1];
      return typeof out === 'function' ? out(m) : out;
    }
  }
  return s;   // 未知轮名保留原文
}

function _sideOfRound(r) {
  if (r && r.side) return r.side;
  return 'main';
}

// 2026-10-28（真机截图复盘）：画布上的「分区标题 + 轮次标题」重复（胜者组 / 胜者组¼决赛）。
// 分区标题已表明 upper/lower ⇒ 轮次标题去掉分区前缀；与分区同名（如总决赛）则留空整行隐藏。
// ⚠️ 导航 chip 仍用全名 label（跨分区需要区分），此处只产出画布用的 short。
function _shortRoundLabel(label, secLabel) {
  if (label === secLabel) return '';
  if (secLabel && label.indexOf(secLabel) === 0) {
    return label.slice(secLabel.length).trim();
  }
  return label;
}

/** 首轮按序排；后续轮按「上一轮 2j / 2j+1」中心平均；上一轮不够配对时紧接其后（不再指数放大） */
function _placeRound(cards, prevCards, roundIndex) {
  const baseGap = H + G;
  return cards.map((m, j) => {
    let y;
    if (roundIndex === 0) {
      y = j * baseGap;
    } else if (prevCards && prevCards.length) {
      if (prevCards.length === cards.length) {
        // ★ 2026-10-31（其他赛制）：上下轮数量相同 ⇒ 一定是 1:1 晋级（Survival 的
        //   「R1 winner → R2」、败者组 R1→R2 同数轮），同排对齐。
        //   原按 2j/2j+1 中心平均会把第 1 张卡塞到两卡之间、第 2 张卡甩到下方，形成阶梯错位。
        y = prevCards[j].y;
      } else {
        const c1 = prevCards[j * 2];
        const c2 = prevCards[j * 2 + 1];
        if (c1 && c2) y = ((c1.y + H / 2) + (c2.y + H / 2)) / 2 - H / 2;
        else if (c1) y = c1.y;
        else {
          // ★ 2026-10-28（真机 UI 复盘）：原实现 `j * baseGap * 2^roundIndex` 在败者组这类
          //   「卡片数 > 上一轮 × 2」的分区会制造巨大空白（实测一屏只放得下 2 轮）。
          //   改为紧接上一轮最后一张卡下方一个卡位，画布高度随卡片数线性增长。
          const last = prevCards[prevCards.length - 1];
          y = last.y + baseGap * (j - Math.floor(prevCards.length / 2) + 1);
        }
      }
    } else {
      y = j * baseGap;   // 上一轮为空：按普通顺序排（不再指数放大）
    }
    return Object.assign({}, m, { x: roundIndex * (CARD_W + COL_GAP), y: y });
  });
}

/** P4 降级线：源卡右中 → 竖向通道 → 目标卡左中（三段折线；坐标已含 section/列偏移） */
function _crossLines(drops, sections) {
  if (!drops || !drops.length) return [];
  const idx = {};
  sections.forEach((sec) => {
    (sec.cards || []).forEach((c) => {
      idx[(c.side || 'main') + '|' + c.roundNo + '|' + c.slotNo] = c;
    });
  });
  const out = [];
  drops.forEach((e) => {
    const a = idx[e.from.side + '|' + e.from.roundNo + '|' + e.from.slotNo];
    const b = idx[e.to.side + '|' + e.to.roundNo + '|' + e.to.slotNo];
    if (!a || !b) return;   // 结构不完整（缺槽/未渲染）⇒ 不画，避免悬空线
    const ax = a.x + CARD_W;
    const ay = a.y + H / 2;
    const bx = b.x;
    const by = b.y + H / 2;
    const laneX = ax + COL_GAP / 2;
    out.push({ left: ax, top: ay - 1, width: Math.max(1, laneX - ax), height: 2 });
    out.push({ left: laneX - 1, top: Math.min(ay, by), width: 2, height: Math.max(1, Math.abs(by - ay)) });
    out.push({ left: Math.min(laneX, bx), top: by - 1, width: Math.max(1, Math.abs(bx - laneX)), height: 2 });
  });
  return out;
}

/** 连线：子卡右中 → 父卡左中，两段折线（水平 + 垂直） */
function _linesFor(prev, cur) {
  const lines = [];
  const oneToOne = prev.length === cur.length;   // ★ 2026-10-31：同数轮 1:1（见 _placeRound）
  cur.forEach((p, j) => {
    const midX = p.x - COL_GAP / 2;
    const py = p.y + H / 2;
    const kids = (oneToOne ? [prev[j]] : [prev[j * 2], prev[j * 2 + 1]]).filter(Boolean);
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

function _cardFromSlot(s, opts) {
  const o = opts || {};
  const nowSec = Number(o.nowSec) || Math.floor(Date.now() / 1000);
  const empty = !!s.empty;
  const t1 = s.team1Name || 'TBD';
  const t2 = s.team2Name || 'TBD';
  const tbd1 = /^(tbd|tba|待定|待公布|unknown)$/i.test(t1);
  const tbd2 = /^(tbd|tba|待定|待公布|unknown)$/i.test(t2);
  const finished = !!s.finished;
  const winner = finished && s.score1 !== s.score2 ? (s.score1 > s.score2 ? 'A' : 'B') : '';
  const startTime = Number(s.startTime) || 0;
  // ★ 2026-10-31（P0-3）：时间显示到「时:分」（优先 formatDateTime，兼容旧 formatTime）
  const fmtTime = o.formatDateTime || o.formatTime;
  const live = s.phase === 'live' && !finished;
  // 时间文字配色：进行中（实时高亮）/ 已开赛或已结束（弱化）/ 未开赛（提示色）
  let timeCls = '';
  if (startTime) timeCls = live ? 'is-live' : (startTime <= nowSec ? 'is-past' : 'is-next');
  return {
    key: s.key || ('R' + s.roundNo + 'M' + s.slotNo),
    side: s.side || 'main',
    roundNo: s.roundNo,
    slotNo: s.slotNo,
    empty: empty,
    team1: tbd1 ? '待定' : t1,
    team2: tbd2 ? '待定' : t2,
    tbd1: tbd1, tbd2: tbd2,
    score1: empty ? '' : s.score1,
    score2: empty ? '' : s.score2,
    // 2026-10-28：已结束但两源都取不到终局比分 → 卡面显式「无数据」（不再留白像 bug）
    noScore: !empty && finished &&
      (s.score1 === '' || s.score1 == null) && (s.score2 === '' || s.score2 == null),
    winner: winner,
    finished: finished,
    boType: s.boType || '',
    startTime: startTime,
    timeLabel: startTime && fmtTime ? fmtTime(startTime) : '',
    timeCls: timeCls,
    matchId: (s.matchIds && s.matchIds.length) ? s.matchIds[0] : 0,
    live: live
  };
}

/**
 * 缓存 payload 同时含 `rounds[].matches`（wikitext 结构，槽位基本为空）与 `slots`
 * （Match 页合并后的真实内容）⇒ 必须按槽位回填，否则填充态永远渲染成「待定」。
 */
function _slotIndex(slots) {
  const map = {};
  (slots || []).forEach((s) => {
    if (!s) return;
    map[_slotKey(s)] = s;
    // 同时登记「侧+轮+槽」复合键：rounds.matches 可能不带 key，只有结构字段
    map[(s.side || 'main') + '|' + s.roundNo + '|' + s.slotNo] = s;
  });
  return map;
}

function _slotKey(s) {
  return s.key || ((s.side || 'main') + '|' + s.roundNo + '|' + s.slotNo);
}

function _resolveSlot(m, index) {
  if (!m) return m;
  return index[_slotKey(m)] || index[(m.side || 'main') + '|' + m.roundNo + '|' + m.slotNo] || m;
}

/**
 * @param {object} bracket { slots: [...], rounds: [{no,side,label,matches}] }
 * @param {object} [opts] { formatTime: fn }
 */
function layoutBracket(bracket, opts) {
  const o = opts || {};
  const slots = (bracket && bracket.slots) || [];
  const rounds = (bracket && bracket.rounds) || [];
  if (!slots.length && !rounds.length) return { width: 0, height: 0, sections: [], crossLines: [] };

  // 有降级线时，lower/final 分区整体右移一列 —— 腾出 source 右侧的竖向走线通道，
  // 否则降级竖线会直接穿过 upper 同列的其他卡片。
  const drops = _dropsOf(bracket && bracket.type);
  const shiftX = drops.length ? (CARD_W + COL_GAP) : 0;

  // 以 rounds 为准分组（含 side），slots 兜底；matches 一律用 slots 回填（填充态）
  const slotIndex = _slotIndex(slots);
  let groups = rounds.map((r) => ({
    side: _sideOfRound(r), no: r.no, label: r.label,
    matches: (r.matches || []).map((m) => _resolveSlot(m, slotIndex))
  }));
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

  // ★ 2026-10-31（真机反馈）：总决赛不再单独占一段（原来被推到最下方，视觉上整张图偏上、
  //   底部悬空）。把总决赛卡接在「最后一轮」右侧的同一行，用小折线把冠军路径接进卡内：
  //   省一整段空白，冠军路径也一眼可见。
  //   ★ 2026-10-31（其他赛制）：不再只对双败（有 drops 映射）生效 —— 单败（main+final，
  //   如 EWC Playoffs Bracket/8）、未知 type 的双败（BLAST Bracket/4L2DS）同样内联；
  //   只有「既无 upper 也无 main」的孤立总决赛才退回常规分段。
  const anchorSide = sides.indexOf('upper') >= 0 ? 'upper' : (sides.indexOf('main') >= 0 ? 'main' : null);
  const inlineFinal = !!(anchorSide && sides.indexOf('final') >= 0);

  let yOffset = 0;
  let maxWidth = 0;
  const sections = [];
  sides.forEach((side) => {
    if (side === 'final' && inlineFinal) return;   // 交给下方 inline 布局
    const rs = groups.filter((g) => g.side === side).sort((a, b) => a.no - b.no);
    const xOff = (shiftX && side !== 'upper') ? shiftX : 0;
    const placedRounds = [];
    let prev = [];
    let sectionHeight = 0;
    const lines = [];
    const roundHeaders = [];
    rs.forEach((r, idx) => {
      const list = (r.matches || []).slice().sort((a, b) => (a.slotNo || 0) - (b.slotNo || 0));
      const cards = _placeRound(list.map((s) => _cardFromSlot(s, o)), prev, idx);
      if (prev.length) lines.push.apply(lines, _linesFor(prev, cards));
      placedRounds.push(cards);
      const _secLabel = SIDE_LABEL[side] || side;
      const _fullLabel = localizeRoundLabel(r.label) || ('R' + r.no);
      roundHeaders.push({
        label: _fullLabel,                                   // 导航 chip 用（跨分区可区分）
        short: _shortRoundLabel(_fullLabel, _secLabel),       // 画布用（去掉与分区标题重复的前缀）
        roundNo: r.no,                                       // ★ 2026-10-31：轮号可能跳号（R1/R2/R4），不能再用索引
        x: xOff + idx * (CARD_W + COL_GAP)
      });
      cards.forEach((c) => { sectionHeight = Math.max(sectionHeight, c.y + H); });
      prev = cards;
    });
    const width = xOff + Math.max(0, (rs.length - 1) * (CARD_W + COL_GAP) + CARD_W);
    const sectionY = yOffset + HEADER_H;
    const cards = [];
    placedRounds.forEach((list, idx) => {
      list.forEach((c) => {
        cards.push(Object.assign({}, c, { x: c.x + xOff, y: c.y + sectionY }));
      });
    });
    // 连线坐标同样平移（x 因分区右移，y 因 section 头）
    const shiftedLines = lines.map((l) => Object.assign({}, l, { left: l.left + xOff, top: l.top + sectionY }));
    sections.push({
      side: side,
      label: SIDE_LABEL[side] || side,
      y: yOffset,
      height: HEADER_H + sectionHeight + 8,
      width: width,
      rounds: roundHeaders,
      cards: cards,
      lines: shiftedLines
    });
    maxWidth = Math.max(maxWidth, width);
    yOffset += HEADER_H + sectionHeight + SECTION_GAP;
  });

  // ★ 2026-10-31（inline final）：总决赛卡 = 「最后一轮」同行的下一列。
  //   上游：anchor 最后一轮（1 张 ⇒ 左侧实线直连；2 张 ⇒ 居中并画两条汇入线）
  //   + 败者组决赛（画布最右通道折线右入），冠军路径一眼可见。
  if (inlineFinal) {
    const anchorSec = sections.filter((s) => s.side === anchorSide)[0] || null;
    const lowerSec = sections.filter((s) => s.side === 'lower')[0] || null;
    const finGroups = groups.filter((g) => g.side === 'final').sort((a, b) => a.no - b.no);
    const gfX = (anchorSec ? anchorSec.width : 0) + COL_GAP;
    // anchor 最后一轮的全部卡片（按 y 排序）；单败半决赛是 2 张，双败胜者组决赛是 1 张
    let lastCards = [];
    if (anchorSec) {
      const lastRn = (anchorSec.cards || []).reduce((m, c) => Math.max(m, c.roundNo || 0), 0);
      lastCards = (anchorSec.cards || [])
        .filter((c) => (c.roundNo || 0) === lastRn)
        .sort((a, b) => a.y - b.y);
    }
    // 1 张 ⇒ 与「决赛」同一行；多张 ⇒ 取中心平均（单败半决赛的两位胜者汇入）
    const gfY = lastCards.length
      ? ((lastCards.reduce((sum, c) => sum + c.y + H / 2, 0) / lastCards.length) - H / 2)
      : ((anchorSec ? anchorSec.y + HEADER_H : 0));
    const finCards = [];
    const finRounds = [];
    finGroups.forEach((r) => {
      const list = (r.matches || []).slice().sort((a, b) => (a.slotNo || 0) - (b.slotNo || 0));
      const cards = list.map((s, i) => Object.assign(_cardFromSlot(s, o), { x: gfX, y: gfY + i * (H + G) }));
      const _fullLabel = localizeRoundLabel(r.label) || ('R' + r.no);
      finRounds.push({ label: _fullLabel, short: _fullLabel, roundNo: r.no, x: gfX });
      finCards.push.apply(finCards, cards);
    });
    const finSec = {
      side: 'final', label: '', y: (anchorSec ? anchorSec.y : 0), height: 0,
      width: gfX + CARD_W, rounds: finRounds, cards: finCards, lines: []
    };
    if (lastCards.length === 1 && finCards.length) {
      const last = lastCards[0];
      anchorSec.lines.push({
        left: last.x + CARD_W, top: last.y + H / 2 - 1,
        width: Math.max(1, gfX - (last.x + CARD_W)), height: 2
      });
    } else if (lastCards.length > 1 && finCards.length) {
      // 2 张（单败半决赛）→ 两张卡各一条线汇入总决赛左中
      anchorSec.lines.push.apply(anchorSec.lines, _linesFor(lastCards, [finCards[0]]));
    }
    const lastLower = lowerSec
      ? lowerSec.cards.slice().sort((a, b) => ((b.roundNo || 0) - (a.roundNo || 0)) || (a.y - b.y))[0]
      : null;
    if (lastLower && finCards.length) {
      const laneX = Math.max(maxWidth, gfX + CARD_W) + COL_GAP / 2;
      const aMid = lastLower.y + H / 2;
      const bMid = finCards[0].y + H / 2;
      const aRight = lastLower.x + CARD_W;
      finSec.lines.push({ left: aRight, top: aMid - 1, width: Math.max(1, laneX - aRight), height: 2 });
      finSec.lines.push({ left: laneX - 1, top: Math.min(aMid, bMid), width: 2, height: Math.max(1, Math.abs(aMid - bMid)) });
      finSec.lines.push({ left: gfX + CARD_W, top: bMid - 1, width: Math.max(1, laneX - (gfX + CARD_W)), height: 2 });
      maxWidth = Math.max(maxWidth, laneX + 8);
    }
    sections.push(finSec);
    maxWidth = Math.max(maxWidth, finSec.width);
  }

  // ★ 2026-10-31：画布四边留白 —— 原图卡片贴边、底部正好切在最后一张卡的下沿（视觉偏上/局促）
  sections.forEach((sec) => {
    sec.y += PAD_TOP;
    (sec.cards || []).forEach((c) => { c.x += PAD_X; c.y += PAD_TOP; });
    (sec.rounds || []).forEach((r) => { r.x += PAD_X; });
    (sec.lines || []).forEach((l) => { l.left += PAD_X; l.top += PAD_TOP; });
  });

  return {
    width: maxWidth + PAD_X * 2,
    height: yOffset + PAD_TOP + PAD_BOTTOM,
    sections: sections,
    crossLines: _crossLines(drops, sections),
    cardW: CARD_W,
    cardH: H
  };
}

/**
 * P4（2026-10-27）：定位「当前轮」——LIVE 优先；否则取「进度最靠前的未完成分区」里
 * 第一个尚未开打的轮（maxFinishedRound + 1），避免 R1 残留未完赛卡把焦点拉回第 1 轮；
 * 全部完赛则取最后一个分区（通常为决赛）。返回 { side, roundNo, x, left } 或 null。
 * `left` 可直接作 scroll-view 的 scroll-left（左侧留 24rpx 呼吸位）。
 */
function _maxFinishedRound(sec) {
  let m = 0;
  (sec.cards || []).forEach((c) => {
    if (!c.empty && c.finished && (c.roundNo || 0) > m) m = c.roundNo || 0;
  });
  return m;
}

function findCurrentRound(view, nowSec) {
  const sections = (view && view.sections) || [];
  if (!sections.length) return null;
  const now = Number(nowSec) || Math.floor(Date.now() / 1000);
  const played = (s) => (s.cards || []).filter((c) => !c.empty);
  let sec = null;
  let target = null;

  // 1) LIVE 优先（任意分区）
  for (let i = 0; i < sections.length && !target; i++) {
    target = played(sections[i]).filter((c) => c.live)[0] || null;
    if (target) sec = sections[i];
  }
  // 2) ★ 2026-10-31（P0-3）：次优先「下一场」—— 未完成卡里 startTime 最早且晚于现在。
  //    原逻辑按「进度最靠前的分区」选轮，会把焦点停在败者组（R4 比胜者组决赛 R2 编号更大），
  //    实测 10-31 应聚焦胜者组决赛（21:00 北京）而不是当天的败者组决赛。
  if (!target) {
    let best = null;
    sections.forEach((s) => {
      played(s).forEach((c) => {
        if (c.finished || !c.startTime || c.startTime <= now) return;
        if (!best || c.startTime < best.card.startTime) best = { sec: s, card: c };
      });
    });
    if (best) { sec = best.sec; target = best.card; }
  }
  // 3) 进度最靠前的未完成分区：取 maxFinishedRound 之后第一个有队伍的轮
  if (!target) {
    const pending = sections.filter((s) => {
      const cs = played(s);
      return cs.length && cs.some((c) => !c.finished);
    });
    if (pending.length) {
      pending.sort((a, b) => _maxFinishedRound(b) - _maxFinishedRound(a));
      sec = pending[0];
      const cs = played(sec);
      const next = cs.filter((c) => !c.finished && (c.roundNo || 1) > _maxFinishedRound(sec));
      // 没有「下一轮」时（最后一轮进行中），取轮次最大的未完赛卡，忽略早期残留
      const rest = cs.filter((c) => !c.finished).sort((a, b) => (b.roundNo || 1) - (a.roundNo || 1));
      target = next[0] || rest[0] || null;
    }
  }
  // 4) 全部完赛：取最后一个分区（决赛/季军所在分区）
  if (!target) {
    sec = sections[sections.length - 1];
    const cs = played(sec);
    target = cs.length ? cs[cs.length - 1] : null;
  }
  if (!sec || !target) return null;
  const rounds = sec.rounds || [];
  if (!rounds.length) return null;
  // ★ 2026-10-31：轮号会跳号（如胜者组 R1/R2/R4，没有 R3）⇒ 按真实 roundNo 找列，
  //   原来用「roundNo - 1」当下标会让导航 chip 与卡片高亮全部错位。
  const rn = target.roundNo || 1;
  const hit = rounds.findIndex((r) => (r.roundNo || 0) === rn);
  const idx = hit >= 0 ? hit : 0;
  return { side: sec.side, roundNo: rounds[idx].roundNo || rn, x: rounds[idx].x, left: Math.max(0, rounds[idx].x - 24) };
}

module.exports = {
  layoutBracket: layoutBracket,
  findCurrentRound: findCurrentRound,
  localizeRoundLabel: localizeRoundLabel,   // 2026-10-28：轮名中文化（未知保留原文）
  CARD_W: CARD_W,
  CARD_H: H,
  CARD_GAP: G,     // ★ 2026-10-31：卡间距（测试守卫；时间行高 28rpx 需 32）
  COL_GAP: COL_GAP
};
