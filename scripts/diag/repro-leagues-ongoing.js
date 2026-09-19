// scripts/diag/repro-leagues-ongoing.js
// ============================================================================
// 【手工诊断工具 · 不接入 test:all】（需联网，跑一次约 60s，故不进 CI）
//
// 用途：**在 Node 里复现赛事列表页的真实渲染结果** —— 桩化 wx / Page，
//       直接 require 页面模块并调用其真实方法（loadLeagues → tryLocalUpcoming
//       → applyAndSlice），然后用真实网络数据打印每个 Tab 的最终卡片列表。
//
// 为什么需要它：本项目的测试套件全是**纯函数**测试，而「列表去重 / 跨源合并 /
//   卡片字段」这类 bug 恰恰出在**页面层**（同源事故已 ≥3 次：passGrade 字段契约、
//   Tab 重复卡片、年份变体重复）。纯函数测试**拦不住**页面层问题 ——
//   本工具就是那个缺口的最小补丁。
//
// 用法：
//   node scripts/diag/repro-leagues-ongoing.js
//   改 `inst.data.filter` 可切 Tab（all / ongoing / upcoming / ended）。
//
// ⚠️ 注意：桩环境并行拉取 EF 时偶发 `fetch failed`（首次冷启动），
//   脚本已先**预热** getLeagueWindows 再跑主链路；若仍见 windows 为 0 条，
//   重跑一次即可（这是 EF 冷启动问题，非页面逻辑问题）。
// ============================================================================
const ROOT = require('path').resolve(__dirname, '../..');


global.wx = {
  request: function (opts) {
    fetch(opts.url, {
      method: opts.method || 'GET',
      headers: opts.header || {},
      body: opts.data ? JSON.stringify(opts.data) : undefined
    })
      .then(async function (r) {
        var d = null; try { d = await r.json(); } catch (e) {}
        opts.success && opts.success({ statusCode: r.status, data: d });
      })
      .catch(function (e) { opts.fail && opts.fail({ errMsg: e.message }); });
  },
  getStorageSync: function () { return null; },
  setStorageSync: function () {},
  removeStorageSync: function () {},
  getStorageInfoSync: function () { return { keys: [] }; },
  showToast: function () {}, hideToast: function () {},
  stopPullDownRefresh: function () {},
  setNavigationBarTitle: function () {},
  navigateTo: function () {},
  cloud: { init: function () {}, callFunction: function () { return Promise.reject(new Error('cloud off')); } }
};
global.Page = function (o) { global.__page = o; };
global.getApp = function () { return { globalData: {} }; };
global.Component = function (o) { global.__comp = o; };

require(ROOT + '/pages/leagues/leagues.js');
const page = global.__page;

const inst = Object.create(page);
inst.data = { filter: 'ongoing', gradeFilter: 'all', sortMode: 'time', pageSize: 20, page: 0 };
inst.teamLeagueIds = null;
inst.setData = function (p) { Object.assign(this.data, p); };
inst._leagueMap = {};
inst._normalizeGen = 1;
inst._leaguesSnapChecked = true;
inst._leaguesSnap = null;
inst.upcomingList = null;
inst.allLeagues = [];
inst._snapshotRendered = false;

const util = require(ROOT + '/utils/util.js');

(async () => {
  // ---- 0) 预热 windows（桩环境并行拉取时 EF 偶发 fetch failed，先单独拉一次入热缓存）----
  const api = require(ROOT + '/utils/api.js');
  try {
    const w = await api.getLeagueWindows();
    console.log('预热 windows = ' + Object.keys(w || {}).length + ' 条  windows["20279"]=' + JSON.stringify((w || {})['20279']));
  } catch (e) { console.log('预热 windows 失败: ' + e.message); }

  // ---- 1) loadLeagues（阶段1 + 阶段2 全量）----
  await new Promise((res) => {
    page.loadLeagues.call(inst, function () { res(); });
    setTimeout(res, 30000);   // 兜底：阶段1 回调未到也放行
  });
  // 等阶段2 完成
  for (let i = 0; i < 60 && !inst._normalizeDone; i++) {
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log('allLeagues = ' + (inst.allLeagues || []).length + ' 条  _normalizeDone=' + inst._normalizeDone);

  // ---- 2) upcomingList（本地快照路径，真机 onShow 亦走此链）----
  try {
    await page.tryLocalUpcoming.call(inst);
  } catch (e) {
    console.log('tryLocalUpcoming 失败: ' + e.message);
  }
  console.log('upcomingList = ' + ((inst.upcomingList || []).length) + ' 条');

  // ---- 3) 关键：看 PGL Wallachia 在三个数据源里的真实形态 ----
  const dump = (label, arr) => {
    const hits = (arr || []).filter((x) => /wallachia/i.test(x.name || x.displayName || ''));
    console.log('\n=== ' + label + ' 中的 PGL Wallachia（' + hits.length + ' 条）===');
    hits.forEach((x) => {
      console.log('  id=' + String(x.leagueid).padEnd(10) +
        ' name=' + String(x.name).padEnd(30) +
        ' status=' + String(x.status).padEnd(9) +
        ' match=' + String(x.matchCount).padEnd(4) +
        ' start=' + String(x.startDate || x.earliest).padEnd(11) +
        ' end=' + String(x.endDate || x.latest).padEnd(11) +
        ' dateRange=' + (x.dateRange || '-'));
    });
  };
  dump('allLeagues', inst.allLeagues);
  dump('upcomingList', inst.upcomingList);

  console.log('\n=== 关键条目原始字段（PGL Wallachia Season 9 相关，非 Qualifier）===');
  (inst.allLeagues || [])
    .filter((x) => /wallachia/i.test(x.name || '') && !/qualifier/i.test(x.name || ''))
    .forEach((x) => {
      console.log('  [allLeagues] ' + JSON.stringify({
        leagueid: x.leagueid, name: x.name, displayName: x.displayName, status: x.status,
        earliest: x.earliest, latest: x.latest, matchCount: x.matchCount,
        startDate: x.startDate, endDate: x.endDate, dateRange: x.dateRange, grade: x.grade
      }));
    });
  (inst.upcomingList || [])
    .filter((x) => /wallachia/i.test(x.name || ''))
    .forEach((x) => {
      console.log('  [upcomingList] ' + JSON.stringify({
        leagueid: x.leagueid, name: x.name, displayName: x.displayName, status: x.status,
        earliest: x.earliest, latest: x.latest, matchCount: x.matchCount,
        startDate: x.startDate, endDate: x.endDate, dateRange: x.dateRange, grade: x.grade
      }));
    });

  // ---- 4) 最终渲染列表（逐个 Tab）----
  ['all', 'ongoing', 'upcoming', 'ended'].forEach((tab) => {
    inst.data.filter = tab;
    inst.data.page = 0;
    try {
      page.applyAndSlice.call(inst, true);
    } catch (e) {
      console.log('applyAndSlice(' + tab + ') 抛错: ' + e.message);
    }
    const rendered = inst.data.list || [];
    console.log('\n########## Tab=' + tab + '  共 ' + rendered.length + ' 条 ##########');
    // 同名重复检测（按归一化键分组，>1 条即重复）
    const byKey = {};
    rendered.forEach((x) => {
      const k = require(ROOT + '/utils/sources.js').leagueKey(x.displayName || x.name);
      (byKey[k] = byKey[k] || []).push(x.leagueid + ':' + (x.displayName || x.name));
    });
    const dup = Object.keys(byKey).filter((k) => byKey[k].length > 1);
    console.log('同名重复组: ' + (dup.length ? dup.map((k) => '[' + k + '] ' + byKey[k].join(' | ')).join('  ;  ') : '无 ✓'));
    rendered.forEach((x) => {
      console.log('  id=' + String(x.leagueid).padEnd(10) +
        ' name=' + String(x.name).padEnd(32) +
        ' status=' + String(x.status).padEnd(9) +
        ' start=' + String(x.startDate || x.earliest || 0).padEnd(11) +
        ' end=' + String(x.endDate || x.latest || 0).padEnd(11) +
        ' match=' + String(x.matchCount).padEnd(4) +
        ' range=' + (x.dateRange || '-'));
    });
  });
})();
