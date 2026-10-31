#!/usr/bin/env node
// P5 守卫（2026-10-27）：赛事详情页「淘汰赛结构加载失败 → 重试」状态机。
// 做法：注入最小 wx 运行时 + require.cache 里替换 utils/liquipedia.js 为可编排 mock，
//   直接 require 页面配置后用最小实例驱动 loadStructure / retryStructure（零网络、零 UI）。
// 契约：首次失败 ⇒ loading=false / loaded=true（不阻塞 switchTab）/ error=true；
//   重试 ⇒ 先复位 loaded + 清空 bracketView，成功后回正常态；连续失败可无限重试。
'use strict';

const path = require('path');
const fs = require('fs');
const Module = require('module');

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('PASS ', msg); }
  else { fail++; console.log('FAIL ', msg); }
}

// ===== 1. 最小 wx 运行时（仅覆盖页面模块加载 + 本链路用到的方法） =====
global.wx = {
  getStorageSync: () => null,
  setStorageSync: () => {},
  removeStorageSync: () => {},
  getStorageInfoSync: () => ({ keys: [] }),
  request: () => {},
  showToast: () => {},
  showModal: () => {},
  navigateTo: () => {},
  getSystemInfoSync: () => ({ statusBarHeight: 20, platform: 'devtools' })
};
global.getApp = () => ({ globalData: {} });
global.getCurrentPages = () => [];

// ===== 2. liquipedia mock：调用序列可编排（默认首败 → 重试成功） =====
const liqPath = require.resolve(path.join(__dirname, '..', '..', 'utils', 'liquipedia.js'));
const calls = [];
const fakeLiq = {
  getLeagueStructure: function (name) {
    calls.push(name);
    if (calls.length === 1) return Promise.reject(new Error('LP 429'));
    return Promise.resolve({ groups: [], brackets: [] });
  },
  getLeagueMetadata: function () { return Promise.resolve(null); },
  getLeagueBracket: function () { return Promise.resolve(null); }
};
const fakeMod = new Module(liqPath, null);
fakeMod.filename = liqPath;
fakeMod.loaded = true;
fakeMod.exports = fakeLiq;
require.cache[liqPath] = fakeMod;

// ===== 3. 捕获 Page 配置 =====
let pageCfg = null;
global.Page = (cfg) => { pageCfg = cfg; };
global.Component = () => {};
global.Behavior = () => {};

const PAGE_DIR = path.join(__dirname, '..', '..', 'subpackages', 'detail', 'league-detail');
require(path.join(PAGE_DIR, 'league-detail.js'));

assert(!!pageCfg, '页面配置可加载（Page() 已捕获）');
assert(typeof pageCfg.loadStructure === 'function', 'loadStructure 存在');
assert(typeof pageCfg.retryStructure === 'function', 'retryStructure 存在');

// ===== 4. 最小页面实例（setData 仅合并顶层字段，本链路足够） =====
function makeInstance() {
  const inst = Object.create(pageCfg);
  inst.data = JSON.parse(JSON.stringify(pageCfg.data));
  inst.data.name = 'Esports World Cup 2026';
  inst.setData = function (patch, cb) {
    Object.keys(patch || {}).forEach((k) => { inst.data[k] = patch[k]; });
    if (typeof cb === 'function') cb();
  };
  return inst;
}
const tick = () => new Promise((r) => setTimeout(r, 20));

(async function run() {
  // ----- 场景 1：首次失败 → 重试成功 -----
  const inst = makeInstance();
  inst.loadStructure();
  assert(inst.data.lpStructureLoading === true, 'S1 开始拉取即 loading=true');
  assert(inst.data.lpStructureError === false, 'S1 开始拉取先复位 error=false');

  await tick();
  assert(calls.length === 1, `S1 首次只发起 1 次请求（实际 ${calls.length}）`);
  assert(inst.data.lpStructureLoading === false, 'S1 失败后 loading 复位');
  assert(inst.data.lpStructureLoaded === true, 'S1 失败后 loaded=true（不阻塞 switchTab 再次懒加载）');
  assert(inst.data.lpStructureError === true, 'S1 失败后 error=true → 淘汰赛 Tab 走「加载失败 + 重试」分支');
  assert(inst.data.bracketView == null, 'S1 失败时无对战表（不误渲染上一份数据）');

  inst.retryStructure();
  assert(inst.data.lpStructureLoaded === false, 'S1 重试前复位 loaded（否则 switchTab 不再拉取）');
  assert(inst.data.bracketView == null, 'S1 重试前清空 bracketView');
  assert(inst.data.lpStructureError === false, 'S1 重试开始即清 error（避免按钮闪失败态）');

  await tick();
  assert(calls.length === 2, `S1 重试后累计 2 次请求（实际 ${calls.length}）`);
  assert(inst.data.lpStructureError === false, 'S1 重试成功后 error 保持 false');
  assert(inst.data.lpStructureLoaded === true, 'S1 重试成功后 loaded=true');
  assert(inst.data.lpStructureLoading === false, 'S1 重试成功后 loading=false');

  // ----- 场景 2：连续失败 → 仍可继续重试（不锁死） -----
  const inst2 = makeInstance();
  calls.length = 0;
  fakeLiq.getLeagueStructure = function (name) {
    calls.push(name);
    return Promise.reject(new Error('LP 500'));
  };
  inst2.loadStructure();
  await tick();
  assert(inst2.data.lpStructureError === true, 'S2 再次失败仍置 error=true');
  inst2.retryStructure();
  await tick();
  assert(calls.length === 2, `S2 连续失败后仍发起第 2 次（实际 ${calls.length}）`);
  assert(inst2.data.lpStructureError === true, 'S2 连续失败可无限重试（不被 loaded 锁死）');

  // ----- 场景 3：参赛队伍搜索（P2 剩余项） -----
  const inst3 = makeInstance();
  inst3.data.participantsList = [
    { id: 1, name: 'Team Spirit', tag: 'TS' }, { id: 2, name: 'Xtreme Gaming' }, { id: 3, name: '待公布' }
  ];
  inst3.onTeamSearch({ detail: { value: 'spirit' } });
  assert(inst3.data.teamQuery === 'spirit', '搜索：关键词写入 teamQuery');
  assert(inst3.data.teamVisibleCount === 1, `搜索：忽略空格/大小写命中 1 队（实际 ${inst3.data.teamVisibleCount}）`);
  inst3.onTeamSearch({ detail: { value: 'teamspirit' } });
  assert(inst3.data.teamVisibleCount === 1, '搜索：无空格关键词同样命中');
  inst3.onTeamSearch({ detail: { value: 'ts' } });
  assert(inst3.data.teamVisibleCount === 1, '搜索：缩写 ts 命中 Team Spirit');
  inst3.onTeamSearch({ detail: { value: 'TS' } });
  assert(inst3.data.teamVisibleCount === 1, '搜索：缩写忽略大小写');
  inst3.onTeamSearch({ detail: { value: 'zzz' } });
  assert(inst3.data.teamVisibleCount === 0, '搜索：无命中返回 0');
  inst3.clearTeamSearch();
  assert(inst3.data.teamQuery === '' && inst3.data.teamVisibleCount === 3, '搜索：清空后恢复全部');

  // P4：对战表「显示赛程」开关（★ 2026-10-31：默认开启 —— 对阵卡需显示具体开赛时分）
  assert(inst3.data.showBracketSchedule === true, '赛程开关：默认开启（显示 MM-DD HH:mm）');
  inst3.toggleBracketSchedule();
  assert(inst3.data.showBracketSchedule === false, '赛程开关：点击 → 隐藏时间');
  inst3.toggleBracketSchedule();
  assert(inst3.data.showBracketSchedule === true, '赛程开关：再次点击 → 恢复显示');

  // P4：当前轮定位（渲染后写焦点 + 横滑偏移）
  inst3._renderBracket({
    type: 'Bracket/8',
    slots: [],
    rounds: [
      { no: 1, side: 'main', label: 'R1', matches: [{ key: 'R1M1', side: 'main', roundNo: 1, slotNo: 1, team1Name: 'A', team2Name: 'B', finished: true, score1: 2, score2: 1, boType: 'Bo3' }] },
      { no: 2, side: 'main', label: 'R2', matches: [{ key: 'R2M1', side: 'main', roundNo: 2, slotNo: 1, team1Name: 'A', team2Name: 'C', phase: 'live', boType: 'Bo3' }] }
    ]
  });
  assert(inst3.data.bracketFocus && inst3.data.bracketFocus.roundNo === 2, '当前轮：渲染后焦点落在 LIVE 轮');
  const curX = inst3.data.bracketView.sections[0].rounds[1].x;
  assert(inst3.data.bracketScrollLeft === Math.max(0, curX - 24), '当前轮：scroll-left 指向该轮表头');

  // BO 还原：LP 槽位未声明 bestof（BO1 占位）→ 用赛制文本还原（决赛取 Bo5）
  inst3.data.metadata = { format: '单败淘汰(Bo3/Bo5决赛)' };
  inst3._renderBracket({
    type: 'Bracket/8',
    slots: [
      { key: 'R1M1', side: 'main', roundNo: 1, slotNo: 1, team1Name: 'Nigma Galaxy', team2Name: 'BB Team', boType: 'BO1', boDeclared: false, phase: 'finished', finished: true, score1: 2, score2: 1 },
      { key: 'F1', side: 'final', roundNo: 1, slotNo: 1, team1Name: 'BB Team', team2Name: 'LGD Gaming', boType: 'BO1', boDeclared: false, phase: 'upcoming' }
    ],
    rounds: [
      { no: 1, side: 'main', label: 'Quarterfinals', matches: [{ key: 'R1M1', side: 'main', roundNo: 1, slotNo: 1 }] },
      { no: 1, side: 'final', label: 'Grand Final', matches: [{ key: 'F1', side: 'final', roundNo: 1, slotNo: 1 }] }
    ]
  });
  const boCards = inst3.data.bracketView.sections.reduce((a, s) => a.concat(s.cards), []);
  const qf = boCards.filter((c) => c.key === 'R1M1')[0];
  const gf = boCards.filter((c) => c.key === 'F1')[0];
  assert(!!qf && qf.boType === 'BO3', 'BO 还原：淘汰轮按赛制 BO3');
  assert(!!gf && gf.boType === 'BO5', 'BO 还原：决赛取 Bo5');

  // curation 赛制优先：TI 2026 本地 curation 已写 `(Bo3/Bo5决赛)`
  inst3.data.name = 'The International 2026';
  inst3.data.leagueId = 19719;
  inst3.data.metadata = {};
  inst3._renderBracket({
    type: 'Bracket/8',
    slots: [
      { key: 'R1M1', side: 'main', roundNo: 1, slotNo: 1, team1Name: 'Aurora Gaming', team2Name: 'BoomBoys', boType: 'BO1', boDeclared: false, phase: 'upcoming' },
      { key: 'F1', side: 'final', roundNo: 1, slotNo: 1, team1Name: 'Aurora Gaming', team2Name: 'Xtreme Gaming', boType: 'BO1', boDeclared: false, phase: 'upcoming' }
    ],
    rounds: [
      { no: 1, side: 'main', label: 'R1', matches: [{ key: 'R1M1', side: 'main', roundNo: 1, slotNo: 1 }] },
      { no: 1, side: 'final', label: 'Grand Final', matches: [{ key: 'F1', side: 'final', roundNo: 1, slotNo: 1 }] }
    ]
  });
  const tiCards = inst3.data.bracketView.sections.reduce((a, s) => a.concat(s.cards), []);
  assert((tiCards.filter((c) => c.key === 'R1M1')[0] || {}).boType === 'BO3', 'BO 还原：curation 赛制 → BO3');
  assert((tiCards.filter((c) => c.key === 'F1')[0] || {}).boType === 'BO5', 'BO 还原：curation 决赛 → BO5');

  // 无任何信号 → 清空 BO1 占位（不显示错误的 BO1）
  inst3.data.name = '';
  inst3.data.leagueId = 0;
  inst3.data.metadata = {};
  inst3._renderBracket({
    type: 'Bracket/8',
    slots: [{ key: 'R1M1', side: 'main', roundNo: 1, slotNo: 1, team1Name: 'A', team2Name: 'B', boType: 'BO1', boDeclared: false, phase: 'upcoming' }],
    rounds: [{ no: 1, side: 'main', label: 'R1', matches: [{ key: 'R1M1', side: 'main', roundNo: 1, slotNo: 1 }] }]
  });
  const noBoCards = inst3.data.bracketView.sections.reduce((a, s) => a.concat(s.cards), []);
  assert((noBoCards[0] || {}).boType === '', 'BO 未知：清空 BO1 占位（前端只显示时间）');

  // 赛制 BO 补录表：已核实赛事生效、已有 BO 的赛事不被覆盖
  const curation = require('../../utils/curation.js');
  const boFixEv = curation.curatedEventFor('BLAST SLAM VII', { game: 'dota2' }) || {};
  assert(/Bo3\/Bo5/i.test(String(boFixEv.format || '')), '补录：BLAST SLAM VII format 含 Bo3/Bo5');
  const ewcEv = curation.curatedEventFor('Esports World Cup 2026', { game: 'dota2' }) || {};
  assert(/循环小组赛\(Bo2\)/.test(String(ewcEv.format || '')), '补录：EWC 原有赛制不被覆盖');
  const blast6 = curation.curatedEventFor('BLAST Slam VI', { game: 'dota2' }) || {};
  assert(/\(Bo3\)/.test(String(blast6.format || '')), '人工覆盖：BLAST Slam VI 淘汰轮按 Bo3');

  // BO3 覆盖：渲染链路（LP 未声明 → curation 人工覆盖 Bo3 生效，决赛同样 Bo3、不臆造 Bo5）
  inst3.data.name = 'BLAST Slam VI';
  inst3.data.leagueId = 19099;
  inst3.data.metadata = {};
  inst3._renderBracket({
    type: 'Bracket/8',
    slots: [
      { key: 'R1M1', side: 'main', roundNo: 1, slotNo: 1, team1Name: 'A', team2Name: 'B', boType: 'BO1', boDeclared: false, phase: 'upcoming' },
      { key: 'F1', side: 'final', roundNo: 1, slotNo: 1, team1Name: 'A', team2Name: 'C', boType: 'BO1', boDeclared: false, phase: 'upcoming' }
    ],
    rounds: [
      { no: 1, side: 'main', label: 'R1', matches: [{ key: 'R1M1', side: 'main', roundNo: 1, slotNo: 1 }] },
      { no: 1, side: 'final', label: 'Final', matches: [{ key: 'F1', side: 'final', roundNo: 1, slotNo: 1 }] }
    ]
  });
  const b6Cards = inst3.data.bracketView.sections.reduce((a, s) => a.concat(s.cards), []);
  assert((b6Cards.filter((c) => c.key === 'R1M1')[0] || {}).boType === 'BO3', 'BO 覆盖：BLAST Slam VI 淘汰卡 → BO3');
  assert((b6Cards.filter((c) => c.key === 'F1')[0] || {}).boType === 'BO3', 'BO 覆盖：决赛同为 BO3（不臆造 Bo5）');

  // 补录表自检：条目均含 BO 数字；键都能命中 curation（防键名拼写漂移，如 SLAM/Slam 大小写）
  const boMap = require('../../utils/curationBoFormat.js');
  assert(Object.keys(boMap).every((k) => /Bo\s*\d/i.test(String(boMap[k]))), '补录表：每个条目都含 BO 数字');
  const orphan = Object.keys(boMap).filter((k) => {
    const ev = curation.curatedEventFor(k, { game: 'dota2' });
    return !ev || !/Bo\s*\d/i.test(String(ev.format || ''));
  });
  assert(orphan.length === 0, '补录表：所有键都能命中 curation（无孤儿键）' +
    (orphan.length ? '：' + orphan.join(',') : ''));

  // 新增策展条目：PARI UNIVERSE by FISSURE（此前无条目 → slug 猜错 → 淘汰赛「暂无」）
  const pari = curation.curatedEventFor('PARI UNIVERSE by FISSURE', { game: 'dota2' }) || {};
  assert(pari.liquipediaSlug === 'PARI_Universe/1', 'PARI：curation slug 已登记（LP 页 PARI_Universe/1）');
  assert(pari.leagueId === 20395, 'PARI：leagueId 精确 pin（20395 为实况赛事；20053 空壳）');
  assert(pari.status === '进行中' && pari.prizePool === '$250,000', 'PARI：进行中 + 奖金池兜底');
  assert(/Bo5决赛/.test(String(pari.format || '')), 'PARI：赛制含决赛 Bo5');
  const eplII = curation.curatedEventFor('EPL Masters II', { game: 'dota2' }) || {};
  assert(/Bo5决赛/.test(String(eplII.format || '')), 'EPL II：决赛 Bo5（与 GF 3:0 实况一致）');

  // 比分借位 + 未知置空 + 决赛 BO 以赛制/实况为准（EPL Masters II 实测：LP Match 页无比分、GF 3:0 属 Bo5）
  inst3.data.name = 'EPL Masters II';
  inst3.data.leagueId = 19944;
  inst3.data.metadata = {};
  inst3._allSeriesFull = [
    { radiantName: 'NAVI', direName: 'Klim Sani4', score1: 3, score2: 1, boType: 'BO5' },
    { radiantName: 'NAVI', direName: 'GamerLegion', score1: 2, score2: 0, boType: 'BO5' }
  ];
  inst3._renderBracket({
    type: 'Bracket/8U4L2DSL1D',
    slots: [
      { key: 'R5M1', side: 'final', roundNo: 5, slotNo: 1, team1Name: 'NAVI', team2Name: 'Klim Sani4', boType: 'BO1', boDeclared: false, finished: true, score1: 0, score2: 0 },
      { key: 'R4M1', side: 'upper', roundNo: 4, slotNo: 1, team1Name: 'NAVI', team2Name: 'GamerLegion', boType: 'BO1', boDeclared: false, finished: true, score1: 0, score2: 0 },
      { key: 'R3M1', side: 'lower', roundNo: 3, slotNo: 1, team1Name: 'MOUZ', team2Name: 'Klim Sani4', boType: 'BO1', boDeclared: false, finished: true, score1: 0, score2: 0 }
    ],
    rounds: [
      { no: 4, side: 'upper', label: 'UB R4', matches: [{ key: 'R4M1', side: 'upper', roundNo: 4, slotNo: 1 }] },
      { no: 3, side: 'lower', label: 'LB R3', matches: [{ key: 'R3M1', side: 'lower', roundNo: 3, slotNo: 1 }] },
      { no: 5, side: 'final', label: 'Grand Final', matches: [{ key: 'R5M1', side: 'final', roundNo: 5, slotNo: 1 }] }
    ]
  });
  const eplCards = inst3.data.bracketView.sections.reduce((a, s) => a.concat(s.cards), []);
  const eplFin = eplCards.filter((c) => c.key === 'R5M1')[0] || {};
  const eplUb = eplCards.filter((c) => c.key === 'R4M1')[0] || {};
  const eplNo = eplCards.filter((c) => c.key === 'R3M1')[0] || {};
  assert(eplFin.boType === 'BO5', '决赛 BO：赛制文本（Bo5决赛）与 3 胜实况一致');
  assert(eplUb.boType === 'BO3', '比赛轮 BO：pair 的 BO5 不得覆盖赛事赛制 Bo3');
  assert(eplFin.score1 === 3 && eplFin.score2 === 1, '比分：LP 缺失时按同对阵系列借位');
  assert(eplUb.score1 === 2 && eplUb.score2 === 0, '比分：同对阵已定赛程借位（2:0）');
  assert(eplNo.score1 === '' && eplNo.score2 === '', '比分：无来源时置空（不再显示 0:0）');

  // 缩写别名：LP「NAVI」↔ OpenDota「Natus Vincere」
  inst3._bracketAlias = { navi: 'natusvincere' };
  inst3._allSeriesFull = [{ radiantName: 'Natus Vincere', direName: 'Klim Sani4', score1: 2, score2: 0, boType: 'BO3' }];
  inst3._renderBracket({
    type: 'Bracket/8U4L2DSL1D',
    slots: [{ key: 'R4M1', side: 'upper', roundNo: 4, slotNo: 1, team1Name: 'NAVI', team2Name: 'Klim Sani4', boType: 'BO1', boDeclared: false, finished: true, score1: 0, score2: 0 }],
    rounds: [{ no: 4, side: 'upper', label: 'UB R4', matches: [{ key: 'R4M1', side: 'upper', roundNo: 4, slotNo: 1 }] }]
  });
  const aliasCard = (inst3.data.bracketView.sections[0].cards.filter((c) => c.key === 'R4M1')[0]) || {};
  assert(aliasCard.score1 === 2 && aliasCard.score2 === 0, '比分：缩写别名（NAVI→Natus Vincere）可借位');

  // 自证：借到 3 胜 ⇒ 标签必须升到 BO5（避免「BO3 + 3:0」矛盾）
  inst3._allSeriesFull = [{ radiantName: 'NAVI', direName: 'GamerLegion', score1: 3, score2: 0, boType: 'BO5' }];
  inst3._renderBracket({
    type: 'Bracket/8',
    slots: [{ key: 'R4M1', side: 'upper', roundNo: 4, slotNo: 1, team1Name: 'NAVI', team2Name: 'GamerLegion', boType: 'BO1', boDeclared: false, finished: true, score1: 0, score2: 0 }],
    rounds: [{ no: 4, side: 'upper', label: 'UB R4', matches: [{ key: 'R4M1', side: 'upper', roundNo: 4, slotNo: 1 }] }]
  });
  const bo5Card = (inst3.data.bracketView.sections[0].cards.filter((c) => c.key === 'R4M1')[0]) || {};
  assert(bo5Card.boType === 'BO5' && bo5Card.score1 === 3, 'BO 自证：3 胜比分把标签校正为 BO5');

  // 同一对阵交手两次（胜者组 + 决赛）：按槽位 startTime 就近取场次，且 OD 主客相反时交换比分
  inst3._bracketAlias = { navi: 'natusvincere' };
  inst3._allSeriesFull = [
    { radiantName: 'Klim Sani4', direName: 'Natus Vincere', score1: 1, score2: 2, boType: 'BO3', lastTime: 1788895240 },
    { radiantName: 'Natus Vincere', direName: 'Klim Sani4', score1: 3, score2: 0, boType: 'BO5', lastTime: 1789064832 }
  ];
  inst3._renderBracket({
    type: 'Bracket/8U4L2DSL1D',
    slots: [
      { key: 'R2M1', side: 'upper', roundNo: 2, slotNo: 1, team1Name: 'NAVI', team2Name: 'Klim Sani4', boType: 'BO1', boDeclared: false, finished: true, score1: 0, score2: 0, startTime: 1788885000 },
      { key: 'R5M1', side: 'final', roundNo: 5, slotNo: 1, team1Name: 'NAVI', team2Name: 'Klim Sani4', boType: 'BO1', boDeclared: false, finished: true, score1: 0, score2: 0, startTime: 1789056000 },
      { key: 'R6M1', side: 'upper', roundNo: 6, slotNo: 1, team1Name: 'NAVI', team2Name: 'Klim Sani4', boType: 'BO1', boDeclared: false, finished: false, score1: 0, score2: 0, startTime: 1789200000 }
    ],
    rounds: [
      { no: 2, side: 'upper', label: 'UB R2', matches: [{ key: 'R2M1', side: 'upper', roundNo: 2, slotNo: 1 }] },
      { no: 5, side: 'final', label: 'Grand Final', matches: [{ key: 'R5M1', side: 'final', roundNo: 5, slotNo: 1 }] },
      { no: 6, side: 'upper', label: 'UB R6', matches: [{ key: 'R6M1', side: 'upper', roundNo: 6, slotNo: 1 }] }
    ]
  });
  const dupCards = inst3.data.bracketView.sections.reduce((a, s) => a.concat(s.cards), []);
  const dupUb = dupCards.filter((c) => c.key === 'R2M1')[0] || {};
  const dupFin = dupCards.filter((c) => c.key === 'R5M1')[0] || {};
  const dupUnplayed = dupCards.filter((c) => c.key === 'R6M1')[0] || {};
  assert(dupUb.score1 === 2 && dupUb.score2 === 1 && dupUb.boType === 'BO3',
    '重复对阵：胜者组按 startTime 就近取 2:1（方向相反已交换）');
  assert(dupFin.score1 === 3 && dupFin.score2 === 0 && dupFin.boType === 'BO5',
    '重复对阵：决赛取 3:0 并校正 BO5');
  assert(dupUnplayed.score1 === '' && dupUnplayed.score2 === '',
    '未开赛槽位不借比分（避免显示小组赛旧比分）');

  // 借位自洽性：BO3 淘汰赛不可能 1:1 平局（同队小组赛 BO2 的比分不得串进来）
  inst3._allSeriesFull = [
    { radiantName: 'Team Synapse', direName: 'Pipsqueak + 4', score1: 1, score2: 1, boType: 'BO2', lastTime: 1788875456 }
  ];
  inst3._renderBracket({
    type: 'Bracket/8',
    slots: [{ key: 'R1M6', side: 'lower', roundNo: 1, slotNo: 6, team1Name: 'Team Synapse', team2Name: 'Pipsqueak + 4', boType: 'BO1', boDeclared: false, finished: true, score1: 0, score2: 0, startTime: 1788870600 }],
    rounds: [{ no: 1, side: 'lower', label: 'LB R1', matches: [{ key: 'R1M6', side: 'lower', roundNo: 1, slotNo: 6 }] }]
  });
  const drawCard = (inst3.data.bracketView.sections[0].cards.filter((c) => c.key === 'R1M6')[0]) || {};
  assert(drawCard.score1 === '' && drawCard.score2 === '', '借位自洽：BO3 槽位拒绝 1:1 平局比分');

  // ----- 场景 3b：PARI UNIVERSE by FISSURE 真实 payload（2026-10-31 P0-1/P0-2 回归） -----
  // fixture = LP bracket + 10 个 Match 页的真实合并快照（CI sync 抓取）：
  //   · LP 侧 series 比分全空（Match 页只写 map 结果，不写 series score），finished 标记不可靠；
  //   · 11/14 槽带 mapN={{ApiMap|matchid=}} ⇒ 客户端必须按 matchId 硬关联 OpenDota 补比分。
  const util = require('../../utils/util.js');
  const pariFix = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'pari-universe1-payload.json'), 'utf8'));
  assert(pariFix.type === 'Bracket/8U4L2DSL1D' && pariFix.slots.length === 14, 'PARI fixture：14 槽双败骨架');
  assert(pariFix.slots.filter((s) => (s.matchIds || []).length > 0).length === 11,
    `PARI fixture：11 槽带 ApiMap matchid（实际 ${pariFix.slots.filter((s) => (s.matchIds || []).length > 0).length}）`);
  assert(!pariFix.slots.some((s) => /substitutes|PlayerSubstitutions|\{\{/.test(String(s.team1Name) + String(s.team2Name))),
    'PARI fixture：队名已清洗（嵌套模板污染不残留）');
  const paiSlot = {};
  pariFix.slots.forEach((s) => { paiSlot['R' + s.roundNo + 'M' + s.slotNo] = s; });
  // 跨午夜 / 跨月：CET 晚间赛事的北京时间落在次日（这是旧实现「只有日期」的直接受害者）
  assert(util.formatDateTime(paiSlot.R1M1.startTime) === '10-28 17:00', 'PARI：R1M1 北京时间 10-28 17:00');
  assert(util.formatDateTime(paiSlot.R1M3.startTime) === '10-29 01:00', 'PARI：R1M3 跨午夜 → 10-29 01:00');
  assert(util.formatDateTime(paiSlot.R2M2.startTime) === '10-30 02:55', 'PARI：R2M2 北京时间 10-30 02:55');
  assert(util.formatDateTime(paiSlot.R4M1.startTime) === '10-31 21:00', 'PARI：R4M1 胜者组决赛 10-31 21:00');
  assert(util.formatDateTime(paiSlot.R4M2.startTime) === '11-01 01:00', 'PARI：R4M2 跨月 → 11-01 01:00');

  inst3.data.name = 'PARI UNIVERSE by FISSURE';
  inst3.data.leagueId = 20395;
  inst3.data.metadata = {};
  inst3._bracketAlias = {};
  const _gamesOf = (ids) => (ids || []).map((id) => ({ match_id: id }));
  const _series = (k, s1, s2) => ({
    radiantName: paiSlot[k].team1Name, direName: paiSlot[k].team2Name,
    score1: s1, score2: s2, boType: 'BO3', games: _gamesOf(paiSlot[k].matchIds),
    firstTime: paiSlot[k].startTime, lastTime: paiSlot[k].startTime + 2 * 3600
  });
  inst3._allSeriesFull = [
    _series('R1M1', 2, 1),   // LP 侧 0:0 且 finished=false
    _series('R1M4', 2, 0),   // LP 侧 0:0 但 finished=true
    _series('R2M2', 2, 1),
    _series('R3M1', 1, 2)
  ];
  inst3._renderBracket(pariFix);
  const pariCards = inst3.data.bracketView.sections.reduce((a, s) => a.concat(s.cards), []);
  const pcard = (k) => pariCards.filter((c) => c.key === k)[0] || {};
  assert(pcard('R1M1').score1 === 2 && pcard('R1M1').score2 === 1,
    `PARI：matchId 硬关联补比分（LP 0:0 → OD 2:1，实际 ${pcard('R1M1').score1}:${pcard('R1M1').score2}）`);
  assert(pcard('R1M1').finished === true, 'PARI：OD 终局派生覆盖 LP finished=false');
  assert(pcard('R1M4').score1 === 2 && pcard('R1M4').score2 === 0, 'PARI：已结束槽位按 matchId 补 2:0');
  assert(pcard('R3M1').score1 === 1 && pcard('R3M1').score2 === 2,
    'PARI：败者组 R3M1 按 matchId 补 1:2（LP finished=false 也判结束）');
  assert(pcard('R1M1').timeLabel === '10-28 17:00' && pcard('R4M1').timeLabel === '10-31 21:00',
    'PARI：卡片显示具体时分（10-28 17:00 / 10-31 21:00 北京时间）');
  assert(pcard('R4M1').score1 === '' && pcard('R4M1').score2 === '',
    'PARI：无 OD 系列可关联时比分置空（不显示 0:0）');

  // ----- 场景 4：源码守卫（WXML 分支与 handler 接线） -----
  const wxml = fs.readFileSync(path.join(PAGE_DIR, 'league-detail.wxml'), 'utf8');
  assert(/wx:elif="\{\{lpStructureError\}\}"/.test(wxml), 'WXML：error 分支在真无数据分支之前');
  assert(/bindtap="retryStructure"/.test(wxml), 'WXML：重试按钮绑定 retryStructure');

  // 缓存时序（2026-10-28）：重进淘汰赛 Tab 允许 force 绕过 30min 结构缓存；重试必须 force
  const js = fs.readFileSync(path.join(PAGE_DIR, 'league-detail.js'), 'utf8');
  assert(/getLeagueStructure\(this\.data\.name, \{ force: !!force \}\)/.test(js),
    '结构刷新：loadStructure(force) 透传到 getLeagueStructure');
  assert(/retryStructure\(\)[\s\S]{0,140}?loadStructure\(true\)/.test(js),
    '结构重试：retryStructure 必须 force 刷新');
  assert(/key === 'playoffs'[\s\S]{0,300}?loadStructure\(true\)/.test(js),
    '重进淘汰赛 Tab：60s 节流强制刷新');
  assert(/hadView[\s\S]{0,120}?bracketLoading: true/.test(js),
    '静默刷新：已有对战表时不闪加载态');
  // 下拉刷新（方案 §9 风险表 / §12 缺口 1）：结构 + 战绩必须一起失效，结构 force 刷新
  assert(/onPullDownRefresh\(\)[\s\S]{0,300}?lpStructureLoaded: false[\s\S]{0,120}?standingsLoaded: false/.test(js),
    '下拉刷新：复位 lpStructureLoaded / standingsLoaded');
  assert(/onPullDownRefresh\(\)[\s\S]{0,460}?loadStructure\(true\)/.test(js),
    '下拉刷新：淘汰赛结构 force 刷新');
  assert(/onPullDownRefresh\(\)[\s\S]{0,520}?loadStandings\(\)/.test(js),
    '下拉刷新：淘汰赛 Tab 同时刷新小组赛战绩');
  // 2026-10-28：轮次导航条 + 无比分「无数据」
  assert(/bracketNav: nav/.test(js), '轮次导航：渲染时生成 bracketNav');
  assert(/jumpToRound\(e\)[\s\S]{0,520}?bracketScrollLeft/.test(js), '轮次导航：点击后更新焦点并横滑');
  assert(/bindtap="jumpToRound"/.test(wxml), 'WXML：轮次导航绑定 jumpToRound');
  assert(/brk-no-data/.test(wxml), 'WXML：无比分卡显示「无数据」');
  // 2026-10-28（详情页冷启动第 2 步）：leagueId 一跳直读 + 本地 bracket 缓存
  assert(/getLeagueBracketByLeague\(id\)/.test(js), '直读：leagueId → 主 bracket（一跳）');
  assert(/key === 'playoffs'\)\s*this\._loadBracketByLeague\(\)/.test(js), '淘汰赛 Tab：触发一跳直读');
  const lpJs = fs.readFileSync(path.join(__dirname, '..', '..', 'utils', 'liquipedia.js'), 'utf8');
  assert(/getLeagueBracketByLeague: getLeagueBracketByLeague/.test(lpJs), 'liquipedia：导出 league 别名读取');
  assert(/cache\.getStale\(ck, BRACKET_FRESH_SEC, BRACKET_TTL_SEC\)/.test(lpJs), 'bracket：本地缓存 stale 秒回');
  const syncJs = fs.readFileSync(path.join(__dirname, '..', 'sync', 'sync-liquipedia-brackets.js'), 'utf8');
  assert(/upsertCache\('lp:brl:' \+ ev\.leagueId/.test(syncJs), 'CI：写 leagueId 别名 lp:brl:<leagueId>');

  // ===== 2026-10-28（第 5 步 · 2026 比分审计）：借位比分对「占位队名 / 跨源拼写」的鲁棒性 =====
  // 根因：OD `/leagues/{id}/matches` 的队名恒 null ⇒ groupSeries 兜底「天辉/夜魇」，
  //   旧实现按占位名建 pairMap ⇒ 整页借位落空（TI26 中国预选 10 张已结束卡全 0 比分）。
  const inst4 = makeInstance();
  inst4.data.leagueId = 19893;
  inst4.data.name = 'The International 2026 - Regional Qualifier China';
  inst4.data.metadata = {};
  // 运行时代名表（explorer 批量；load 阶段同步可得）
  inst4._teamIdNameMap = { 726228: 'Vici Gaming', 9351740: 'Yakult Brothers', 5017210: 'Team Resilience' };
  inst4._allSeriesFull = [
    // 系列队名仍是占位（异步 enrichTeamNames 未跑完）→ 必须靠 team_id 兜底
    { radiantName: '天辉', direName: '夜魇', radiantTeamId: 726228, direTeamId: 9351740,
      scoreA: 2, scoreB: 0, boType: 'Bo3', lastTime: 1781774100 + 3600 },
    // 跨源拼写差异：LP "yakutou brothers 2025" ↔ OD "Yakult Brothers"
    { radiantName: 'Yakult Brothers', direName: 'Team Resilience', radiantTeamId: 9351740, direTeamId: 5017210,
      scoreA: 0, scoreB: 2, boType: 'Bo3', lastTime: 1781863200 + 3600 },
    // 跨源拼写差异：LP "4 Anchors and Ilmeria" ↔ OD "4 Anchors + Ilmeria"
    { radiantName: '4 Anchors + Ilmeria', direName: 'Team Resilience', radiantTeamId: 10170769, direTeamId: 5017210,
      scoreA: 0, scoreB: 2, boType: 'Bo3', lastTime: 1781956800 + 3600 },
    // EWC 2026：LP 写缩写 PVISION / 队标 BB Team，OD 写 PARIVISION / BetBoom Team
    { radiantName: 'PARIVISION', direName: 'Rune Eaters', radiantTeamId: 9824702, direTeamId: 9895247,
      scoreA: 1, scoreB: 2, boType: 'Bo3', lastTime: 1782050400 + 3600 }
  ];
  // 别名表：curation 兜底（"yakutou brothers 2025" → "yakultbrothers"）
  inst4._bracketAlias = inst4._mergeCurationAlias({}, ['yakutou brothers 2025', 'Vici Gaming', 'Team Resilience']);
  assert(inst4._bracketAlias['yakutoubrothers2025'] === 'yakultbrothers',
    '别名：LP "yakutou brothers 2025" → OD "Yakult Brothers"（curation 兜底）');
  // 同一批别名表：LP "4 Anchors and Ilmeria" ↔ OD "4 Anchors + Ilmeria"（"+" 归一后不同）
  const _alias2 = inst4._mergeCurationAlias({}, ['4 Anchors and Ilmeria']);
  assert(_alias2['4anchorsandilmeria'] === '4anchorsilmeria',
    `别名：LP "4 Anchors and Ilmeria" → OD "4 Anchors + Ilmeria"（实际 ${_alias2['4anchorsandilmeria']}）`);
  // 别名表不可用（快路径渲染早于 _loadBracketAlias）时，_resolveBracketBo 仍要靠 curation 兜底
  inst4._bracketAlias = {};
  const _bkgNoAlias = inst4._resolveBracketBo({
    slots: [{ key: 'R1M1', side: 'main', roundNo: 1, slotNo: 1,
      team1Name: '4 Anchors and Ilmeria', team2Name: 'Team Resilience',
      score1: 0, score2: 0, finished: true, empty: false, startTime: 1781956800 }]
  });
  assert(Number(_bkgNoAlias.slots[0].score1) === 0 && Number(_bkgNoAlias.slots[0].score2) === 2,
    `别名兜底：无 _bracketAlias 时仍能匹配（实际 ${_bkgNoAlias.slots[0].score1}:${_bkgNoAlias.slots[0].score2}）`);
  // 2026-10-28（第 5 步补）：curation 显示名与 OpenDota 现网名不同（odName）／LP 带年份后缀
  //   注：归一化会剥掉结尾的 "Team" —— "1w Team" → "1w"，"BetBoom Team" → "betboom"；
  //   带年份的 "BetBoom Team 2024" 因 team 不在结尾而保留为 "betboomteam2024"。
  const _alias3 = inst4._mergeCurationAlias({}, ['1w Team', 'BetBoom Team 2024']);
  assert(_alias3['1w'] === '1win',
    `别名：LP "1w Team" → OD "1win"（odName 覆盖，实际 ${_alias3['1w']}）`);
  assert(_alias3['betboomteam2024'] === 'betboom',
    `别名：LP "BetBoom Team 2024" → OD "BetBoom Team"（年份后缀，实际 ${_alias3['betboomteam2024']}）`);
  // EWC 2026：LP 缩写 PVISION / 队标 BB Team → OD PARIVISION / BetBoom Team
  const _alias4 = inst4._mergeCurationAlias({}, ['PVISION', 'BB Team', 'Rune Eaters']);
  assert(_alias4['pvision'] === 'parivision', `别名：PVISION → PARIVISION（实际 ${_alias4['pvision']}）`);
  assert(_alias4['bb'] === 'betboom', `别名：BB Team → BetBoom Team（实际 ${_alias4['bb']}）`);
  const _bkgEwc = inst4._resolveBracketBo({
    slots: [{ key: 'R1M1', side: 'main', roundNo: 1, slotNo: 1,
      team1Name: 'PVISION', team2Name: 'Rune Eaters',
      score1: 0, score2: 0, finished: true, empty: false, startTime: 1782050400 }]
  });
  assert(Number(_bkgEwc.slots[0].score1) === 1 && Number(_bkgEwc.slots[0].score2) === 2,
    `借位：PVISION vs Rune Eaters → 1:2（实际 ${_bkgEwc.slots[0].score1}:${_bkgEwc.slots[0].score2}）`);
  const bkg = inst4._resolveBracketBo({
    slots: [
      { key: 'R1M1', side: 'upper', roundNo: 1, slotNo: 1, team1Name: 'Vici Gaming', team2Name: 'Yakult Brothers',
        score1: 0, score2: 0, finished: true, empty: false, startTime: 1781774100 },
      { key: 'R2M1', side: 'upper', roundNo: 2, slotNo: 1, team1Name: 'yakutou brothers 2025', team2Name: 'Team Resilience',
        score1: 0, score2: 0, finished: true, empty: false, startTime: 1781863200 }
    ]
  });
  assert(Number(bkg.slots[0].score1) === 2 && Number(bkg.slots[0].score2) === 0,
    `借位：占位队名场景按 team_id 兜底取到 2:0（实际 ${bkg.slots[0].score1}:${bkg.slots[0].score2}）`);
  assert(Number(bkg.slots[1].score1) === 0 && Number(bkg.slots[1].score2) === 2,
    `借位：跨源拼写（yakutou brothers 2025 ↔ Yakult Brothers）取到 0:2（实际 ${bkg.slots[1].score1}:${bkg.slots[1].score2}）`);
  // 系列到齐后必须重算（否则先于 OD 渲染的对战表会永久停在 0 比分）
  assert(/this\._lastBracketPayload = b/.test(js), '重算：_renderBracket 记录最近一次 payload');
  assert(/this\._lastBracketPayload\s*\)\s*\{\s*try\s*\{\s*this\._renderBracket/.test(js),
    '重算：series 就绪后按同一 payload 重渲染对战表');


  console.log(`\n=== 结果 ===\n通过: ${pass}  失败: ${fail}`);
  process.exit(fail ? 1 : 0);
})();
