#!/usr/bin/env node
// ============================================================
// P6（2026-10-29）：golden 布局薄快照
//
// 目的：在「下次改布局之前」把 2 个真实 fixture（PGL Wallachia S9 / TI 2026，
//   均为 Bracket/8U4L2DSL1D：upper/lower/final 三区 14 卡）的**坐标**钉住，
//   防止后续改动把卡片位置、分区高度或降级线悄悄挪动。
//
// 快照内容（刻意只存坐标，不存队名/时间/轮次文案，避免噪音）：
//   { width, cardH,
//     sections: [{ side, height, cards: [{ key, x, y }] }],
//     crossLines: [{ left, top, width, height }] }
//
// 用法：
//   node scripts/test/test-bracket-golden.js                 # 比对
//   UPDATE_GOLDEN=1 node scripts/test/test-bracket-golden.js # 重生成
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');
const bl = require('../../utils/bracketLayout.js');
const LP = require('../../utils/liquipedia-parse.js');

const GOLDEN_DIR = path.join(__dirname, 'fixtures', 'golden');
const UPDATE = process.env.UPDATE_GOLDEN === '1';

const CASES = [
  { name: 'pgl-wallachia-s9', file: 'pgl-wallachia9-wikitext.txt' },
  { name: 'ti2026-main-event', file: 'ti2026-main-event-wikitext.txt' }
];

function loadBracket(file) {
  const txt = fs.readFileSync(path.join(__dirname, file), 'utf8');
  const brackets = LP.parseBrackets(txt) || [];
  if (!brackets.length) throw new Error('fixture 无 bracket: ' + file);
  // 取主 bracket：Playoffs 优先，其次槽位最多者（与 CI sync 的选取口径一致）
  const primary = brackets.filter((b) => /playoff|淘汰/i.test(String(b.section || '')))[0] ||
    brackets.slice().sort((a, b) => (b.slots || []).length - (a.slots || []).length)[0];
  return primary;
}

function snapshot(bracket) {
  const view = bl.layoutBracket(bracket, { formatTime: () => '' });
  return {
    width: view.width,
    cardH: view.cardH,
    sections: (view.sections || []).map((s) => ({
      side: s.side,
      height: s.height,
      cards: (s.cards || []).map((c) => ({ key: c.key, x: c.x, y: c.y }))
    })),
    crossLines: (view.crossLines || []).map((l) => ({
      left: l.left, top: l.top, width: l.width, height: l.height
    }))
  };
}

function diff(a, b, p, out) {
  if (out.length >= 8) return;
  if (a === b) return;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') {
    if (a !== b) out.push(p + ': golden=' + JSON.stringify(a) + ' actual=' + JSON.stringify(b));
    return;
  }
  const keys = Object.keys(a).concat(Object.keys(b).filter((k) => Object.prototype.hasOwnProperty.call(a, k) === false));
  keys.forEach((k) => diff(a[k], b[k], p + '.' + k, out));
}

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log('PASS  ' + label); }
  else { fail++; console.log('FAIL  ' + label + (detail ? '  ->  ' + detail : '')); }
}

if (!fs.existsSync(GOLDEN_DIR)) fs.mkdirSync(GOLDEN_DIR, { recursive: true });

CASES.forEach((c) => {
  let actual;
  try {
    actual = snapshot(loadBracket(c.file));
  } catch (e) {
    check(c.name + '：fixture 可解析', false, e.message);
    return;
  }
  const goldenFile = path.join(GOLDEN_DIR, c.name + '.json');
  const cardsN = actual.sections.reduce((n, s) => n + s.cards.length, 0);

  if (UPDATE || !fs.existsSync(goldenFile)) {
    fs.writeFileSync(goldenFile, JSON.stringify(actual, null, 2) + '\n', 'utf8');
    check(c.name + '：golden 已写入（' + cardsN + ' 卡 / ' + actual.crossLines.length + ' 降级线）', true);
    return;
  }

  const golden = JSON.parse(fs.readFileSync(goldenFile, 'utf8'));
  const diffs = [];
  diff(golden, actual, '$', diffs);
  check(c.name + '：布局坐标与 golden 一致（' + cardsN + ' 卡 / ' + actual.crossLines.length + ' 降级线）',
    diffs.length === 0, diffs.join(' | '));

  // 结构守卫：golden 快照本身必须覆盖 3 区 14 卡（防 fixture 误换/解析退化后静默通过）
  check(c.name + '：快照覆盖 upper/lower/final 三区 14 卡',
    golden.sections.length === 3 && cardsN === 14,
    'sections=' + golden.sections.length + ' cards=' + cardsN);
  check(c.name + '：降级线数量非空', golden.crossLines.length > 0, 'crossLines=' + golden.crossLines.length);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
