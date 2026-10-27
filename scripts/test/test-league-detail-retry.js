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

  // P4：对战表「显示赛程」开关
  inst3.toggleBracketSchedule();
  assert(inst3.data.showBracketSchedule === false, '赛程开关：默认开 → 点击关闭');
  inst3.toggleBracketSchedule();
  assert(inst3.data.showBracketSchedule === true, '赛程开关：再次点击恢复显示');

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

  // ----- 场景 4：源码守卫（WXML 分支与 handler 接线） -----
  const wxml = fs.readFileSync(path.join(PAGE_DIR, 'league-detail.wxml'), 'utf8');
  assert(/wx:elif="\{\{lpStructureError\}\}"/.test(wxml), 'WXML：error 分支在真无数据分支之前');
  assert(/bindtap="retryStructure"/.test(wxml), 'WXML：重试按钮绑定 retryStructure');

  console.log(`\n=== 结果 ===\n通过: ${pass}  失败: ${fail}`);
  process.exit(fail ? 1 : 0);
})();
