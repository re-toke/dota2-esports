// scripts/diag/repro-participants-names.js
// ============================================================================
// 【手工诊断 · 离线可跑 · 不接入 test:all】
//
// 复现用户反馈：「赛事详情页 → 参赛队伍，**第一次进入队名显示错误**，
//                  退出再进入就正确」。
//
// 做法：桩化 wx / Page 后 require 真实的 league-detail 页面模块，
//   构造**真实形状**的页面状态（未开赛/进行中赛事：raw 比赛里队名为空、
//   participantsList 初始为空），然后按**真实调用时序**逐步驱动并打印每一步的
//   参赛队伍队名，从而定位是哪一步把队名改坏/覆盖。
//
// 用法：node scripts/diag/repro-participants-names.js
// ============================================================================
const ROOT = require('path').resolve(__dirname, '../..');

// ---- 受控网络桩：只服务 explorer SQL（getTeamNames），其余返回空 ----
let explorerNames = { 111: 'Team Alpha', 222: 'Team Beta', 333: 'Team Gamma' };
let explorerCalls = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

global.wx = {
  request: function (opts) {
    const url = opts.url || '';
    if (url.indexOf('/explorer') >= 0) {
      explorerCalls++;
      // 模拟网络延迟：让 enrich 与 finalize 形成竞态（可用 REPRO_FAST=1 关掉）
      const delay = process.env.REPRO_FAST ? 0 : 120;
      setTimeout(function () {
        const rows = Object.keys(explorerNames).map((id) => ({ team_id: Number(id), name: explorerNames[id] }));
        opts.success && opts.success({ statusCode: 200, data: { rows: rows } });
      }, delay);
      return;
    }
    // 其余（EF / opendota）一律返回空结构，避免真联网
    setTimeout(function () { opts.success && opts.success({ statusCode: 200, data: {} }); }, 1);
  },
  getStorageSync: function () { return null; },
  setStorageSync: function () {},
  removeStorageSync: function () {},
  getStorageInfoSync: function () { return { keys: [] }; },
  showToast: function () {}, hideToast: function () {},
  setNavigationBarTitle: function () {},
  navigateTo: function () {}, redirectTo: function () {},
  switchTab: function () {}, navigateBack: function () {},
  stopPullDownRefresh: function () {},
  setClipboardData: function () {},
  getFileSystemManager: function () { return { accessSync: function () { throw new Error('x'); } }; },
  downloadFile: function (o) { o.fail && o.fail({ errMsg: 'stub' }); },
  env: { USER_DATA_PATH: '/UD' },
  cloud: { callFunction: function () { return Promise.reject(new Error('cloud off')); } }
};
global.Page = function (o) { global.__page = o; };
global.getApp = function () { return { globalData: {} }; };
global.Component = function () {};

require(ROOT + '/subpackages/detail/league-detail/league-detail.js');
const pageDef = global.__page;
if (!pageDef) { console.log('✗ 未捕获页面定义'); process.exit(1); }

// ---- 构造实例：state 形状对齐 refreshMetadataDerived / enrichTeamNames 的真实读取 ----
function makeInstance() {
  const inst = Object.assign({}, pageDef);
  inst.data = Object.assign({}, pageDef.data, {
    metadata: {},                 // 骨架：participants 非数组（模拟 curation 数字形态）
    participantsList: [],
    series: [],
    pageSize: 10
  });
  inst.setData = function (patch) { Object.assign(this.data, patch); };
  // raw 比赛：OpenDota /leagues/{id}/matches 的真实形态 —— 队名常为空
  inst.allMatches = [
    { radiant_team_id: 111, radiant_team_name: '', dire_team_id: 222, dire_team_name: '' },
    { radiant_team_id: 111, radiant_team_name: '', dire_team_id: 333, dire_team_name: '' }
  ];
  // 已在界面上展示的 series（队名同样为空 → 需要 enrich 回填）
  inst.allSeries = [
    { radiantTeamId: 111, direTeamId: 222, radiantName: '', direName: '',
      games: [{ radiantTeamId: 111, direTeamId: 222, radiantName: '', direName: '' }] }
  ];
  return inst;
}
const names = (inst) => (inst.data.participantsList || []).map((t) => t.id + ':' + t.name).join(' | ') || '(空)';

(async () => {
  console.log('=== 复现：参赛队伍队名的「首次错误 / 再次正确」 ===');
  console.log('（受控 explorer 返回：' + JSON.stringify(explorerNames) + '）');
  console.log('');

  // ---------- 访问 1：真实时序 ----------
  console.log('---------- 访问 1（首次） ----------');
  let inst = makeInstance();
  inst.refreshMetadataDerived();
  console.log(' ① 初次 refreshMetadataDerived 后（同步）: ' + names(inst));
  // ★ 修复验证点：本函数内若残留 "Team {id}" 占位，应**自动触发** enrichTeamNames 回填
  await sleep(400);
  console.log(' ①\' 等 400ms 后（应已被安全网回填，不再有 Team {id}）: ' + names(inst));
  const syncOk = !/Team \d+/.test(names(inst));
  console.log('    → 安全网生效 = ' + (syncOk ? '✓' : '✗ 仍残留占位'));

  // L778：Promise.all([enrichTeamNames(), enrichTeamLogos()]) —— 异步
  const enrichP = Promise.resolve(inst.enrichTeamNames());
  // 模拟 finalize（L320，由 LP/metadata promise 或 8s 超时触发）在 enrich 完成**之后**到达
  await enrichP;
  console.log(' ② enrichTeamNames 完成后        : ' + names(inst));
  inst.refreshMetadataDerived();      // ← finalize 里的第二次调用
  console.log(' ③ finalize 再次 refreshMetadataDerived 后 : ' + names(inst));
  await sleep(400);
  console.log(' ③\' 再等 400ms 后              : ' + names(inst));
  const afterVisit1 = names(inst);
  console.log('');

  // ---------- 访问 2：缓存已热（getTeamNames 命中本地缓存 → enrich 瞬时完成） ----------
  console.log('---------- 访问 2（再次进入；explorer 已有缓存 → enrich 更快） ----------');
  explorerNames = { 111: 'Team Alpha', 222: 'Team Beta', 333: 'Team Gamma' };
  const inst2 = makeInstance();
  inst2.refreshMetadataDerived();
  console.log(' ① 初次 refreshMetadataDerived 后 : ' + names(inst2));
  // 缓存命中场景：enrich 立即完成（无延迟）
  const savedDelay = explorerCalls;
  await Promise.resolve(inst2.enrichTeamNames());
  console.log(' ② enrichTeamNames 完成后        : ' + names(inst2));
  inst2.refreshMetadataDerived();
  console.log(' ③ finalize 再次 refresh 后       : ' + names(inst2));
  const afterVisit2 = names(inst2);
  console.log('');

  console.log('=== 结论 ===');
  console.log('  访问1 最终 : ' + afterVisit1);
  console.log('  访问2 最终 : ' + afterVisit2);
  console.log('  ' + (afterVisit1 !== afterVisit2
    ? '★ 已复现「两次访问结果不同」——第 ③ 步把 enrich 回填的真名覆盖回占位。'
    : '未复现差异（需调整时序/数据形状）。'));
})();
