// scripts/test-refresh-participants.js
// 验证 league-detail.js refreshMetadataDerived 分支②的逻辑：
// 当 Liquipedia 提供 16 支队伍列表，但实际比赛数据只有 7 支已参赛队伍时，
// 应以 Liquipedia 列表为基础重建 participantsList，关联真实 team_id，
// 未参赛队伍显示真实队名（非「待定队伍 N」），TBD 显示「待公布」。
'use strict';

let passed = 0;
let failed = 0;
const tests = [];

function section(title) { tests.push({ kind: 'section', title: title }); }
function check(label, fn) { tests.push({ kind: 'test', label: label, fn: fn }); }
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

// ===== 1. mock wx 环境 =====
const storage = {};
let requestHandler = null;
global.wx = {
  request: function (opts) {
    if (requestHandler) return requestHandler(opts);
    if (opts.fail) opts.fail({ errMsg: 'request:fail (no handler)' });
  },
  getStorageSync: function (key) { return storage[key] || null; },
  setStorageSync: function (key, val) { storage[key] = val; },
  removeStorageSync: function (key) { delete storage[key]; },
  getStorageInfoSync: function () { return { keys: Object.keys(storage) }; }
};
global.setTimeout = function (fn) { if (typeof fn === 'function') fn(); return 0; };

// ===== 2. 清除 module cache =====
const purge = ['cache.js', 'config.js', 'consensus.js', 'liquipedia.js', 'cloudProxy.js'];
for (const k of Object.keys(require.cache)) {
  for (const name of purge) { if (k.indexOf(name) >= 0) delete require.cache[k]; }
}

// ===== 3. require 模块 =====
const path = require('path');
const fs = require('fs');
const SRC = path.resolve(__dirname, '..', 'utils');
const cache = require(path.join(SRC, 'cache.js'));
const consensus = require(path.join(SRC, 'consensus.js'));
const liquipedia = require(path.join(SRC, 'liquipedia.js'));

// ===== 4. 读取真实 EPL wikitext =====
const rawJsonPath = path.join(__dirname, 'epl-wikitext.json');
let EPL_WIKITEXT = null;
try {
  const rawJson = JSON.parse(fs.readFileSync(rawJsonPath, 'utf8'));
  EPL_WIKITEXT = rawJson.query.pages[0].revisions[0].slots.main.content;
} catch (e) {
  EPL_WIKITEXT = null;
}

function makeRevisionsResponse(pageTitle, wikitext) {
  return {
    batchcomplete: true,
    query: {
      pages: [{
        pageid: 191619, ns: 0, title: pageTitle,
        revisions: [{ slots: { main: { contentmodel: 'wikitext', contentformat: 'text/x-wiki', content: wikitext } } }]
      }]
    }
  };
}

// ===== 模拟 refreshMetadataDerived 分支②的核心逻辑 =====
// 提取 league-detail.js 中的分支②代码，用于独立测试
function refreshBranch2(participantsList, liqParticipantsArr, metaParticipants) {
  const actualCount = participantsList.length;
  // 仅在 meta > 实际 时触发分支②
  if (!(metaParticipants > 0 && metaParticipants > actualCount)) {
    return participantsList;
  }
  if (!liqParticipantsArr || !liqParticipantsArr.length) {
    // 无 Liquipedia 列表：占位逻辑
    const need = metaParticipants - actualCount;
    const existingIds = new Set(participantsList.map((t) => t && t.id));
    const fillers = [];
    for (let i = 0; i < need; i++) {
      const fakeId = -1 - i;
      if (!existingIds.has(fakeId)) {
        fillers.push({ id: fakeId, name: '待定队伍 ' + (i + 1) });
      }
    }
    return participantsList.concat(fillers);
  }
  // Liquipedia 列表存在：重建 participantsList
  const nameToId = {};
  const normList = [];
  participantsList.forEach((t) => {
    if (!t || !t.name || t.id == null || t.id < 0) return;
    if (/^Team \d+$/.test(t.name)) return;
    nameToId[t.name.toLowerCase()] = t.id;
    normList.push({ name: t.name, id: t.id });
  });
  const normalize = function (s) {
    return (s || '').toLowerCase()
      .replace(/\s*(esports|eports?|gaming|team|dota)\s*/gi, '')
      .replace(/[^a-z0-9]/g, '');
  };
  const normIndexed = normList.map((it) => ({ norm: normalize(it.name), id: it.id, name: it.name }));
  return liqParticipantsArr.map((t, i) => {
    const liqName = (t && t.name) || '';
    const isTBD = !liqName || liqName === 'TBD';
    let matchedId = null;
    if (!isTBD) {
      matchedId = nameToId[liqName.toLowerCase()];
      if (matchedId == null) {
        const liqNorm = normalize(liqName);
        if (liqNorm) {
          for (let j = 0; j < normIndexed.length; j++) {
            const it = normIndexed[j];
            if (!it.norm) continue;
            if (it.norm === liqNorm ||
                (it.norm.length >= 3 && (it.norm.indexOf(liqNorm) >= 0 || liqNorm.indexOf(it.norm) >= 0))) {
              matchedId = it.id;
              break;
            }
          }
        }
      }
    }
    return {
      id: matchedId != null ? matchedId : -1 - i,
      name: isTBD ? '待公布' : liqName,
      status: (t && t.status) || 'TBD',
      liquipediaSlug: (t && t.liquipediaSlug) || null
    };
  });
}

// ===== 5. 测试 =====

section('\n--- refreshMetadataDerived 分支② 测试 ---');

// 测试 1：Liquipedia 16 支 + 实际 7 支已参赛 → 应输出 16 支，含真实队名
check('Liquipedia 16 支 + 实际 7 支已参赛：应输出 16 支含真实队名', async () => {
  assert(EPL_WIKITEXT !== null, 'wikitext 不应为 null');

  const cacheKey = 'liquipedia_league_' + consensus.normName('EPL/Masters/1');
  cache.remove(cacheKey);
  requestHandler = function (opts) {
    opts.success({
      statusCode: 200,
      data: makeRevisionsResponse('EPL/Masters/1', EPL_WIKITEXT)
    });
  };

  try {
    const meta = await liquipedia.getLeagueMetadata('EPL/Masters/1');
    assert(meta !== null, 'metadata 不应为 null');
    assert(Array.isArray(meta.participants), 'participants 应为数组');
    assert(meta.participants.length === 16, 'Liquipedia 应返回 16 支队伍');

    // 模拟实际比赛数据中只有 7 支队伍已参赛（OpenDota team_id 假设）
    // 注意：队名与 Liquipedia 一致，验证精确匹配
    const actualTeams = [
      { id: 8262783, name: 'MOUZ' },
      { id: 8262784, name: 'Rune Eaters' },
      { id: 8262785, name: 'Yellow Submarine' },
      { id: 8262786, name: 'Amaru Gaming' },
      { id: 8262787, name: 'Power Rangers' },
      { id: 8262788, name: 'Team Jenz' },
      { id: 8262789, name: 'Level UP' }
    ];

    const result = refreshBranch2(actualTeams, meta.participants, 16);

    // 1. 数量应为 16
    assert(result.length === 16, '结果应有 16 支队伍，实际: ' + result.length);

    // 2. 已参赛的 7 支队伍应保留真实 team_id（正数）
    const mouz = result.find((t) => t.name === 'MOUZ');
    assert(mouz && mouz.id === 8262783, 'MOUZ 应保留真实 id 8262783，实际: ' + (mouz && mouz.id));

    const jenz = result.find((t) => t.name === 'Team Jenz');
    assert(jenz && jenz.id === 8262788, 'Team Jenz 应保留真实 id 8262788，实际: ' + (jenz && jenz.id));

    // 3. 未参赛的 8 支队伍应显示真实队名，id 为负数
    const puck = result.find((t) => t.name === 'PuckChamp');
    assert(puck && puck.id < 0, 'PuckChamp 未参赛，id 应为负数，实际: ' + (puck && puck.id));

    const nemiga = result.find((t) => t.name === 'Nemiga Gaming');
    assert(nemiga && nemiga.id < 0, 'Nemiga Gaming 未参赛，id 应为负数');

    // 4. TBD 队伍应显示「待公布」
    const tbd = result.find((t) => t.name === '待公布');
    assert(tbd, '应有一个「待公布」队伍');
    assert(tbd.id < 0, '待公布 id 应为负数');

    // 5. 不应含「待定队伍 N」占位符
    const placeholder = result.find((t) => /^待定队伍 /.test(t.name));
    assert(!placeholder, '不应含「待定队伍 N」占位符');

    // 6. 验证所有 16 支队伍名
    const names = result.map((t) => t.name).sort();
    console.log('  结果队伍:', result.map((t) => t.name + '(id=' + t.id + ')').join(', '));
  } finally {
    requestHandler = null;
    cache.remove(cacheKey);
  }
});

// 测试 2：模糊匹配验证（OpenDota 名带后缀 Esports，Liquipedia 名不带）
check('模糊匹配：OpenDota "Ilbirs esports" vs Liquipedia "Ilbirs eSports"', async () => {
  assert(EPL_WIKITEXT !== null, 'wikitext 不应为 null');

  const cacheKey = 'liquipedia_league_' + consensus.normName('EPL/Masters/1');
  cache.remove(cacheKey);
  requestHandler = function (opts) {
    opts.success({
      statusCode: 200,
      data: makeRevisionsResponse('EPL/Masters/1', EPL_WIKITEXT)
    });
  };

  try {
    const meta = await liquipedia.getLeagueMetadata('EPL/Masters/1');
    // 模拟 OpenDota 返回的队名大小写不一致："Ilbirs esports" (小写 e)
    const actualTeams = [
      { id: 8262790, name: 'Ilbirs esports' }
    ];
    const result = refreshBranch2(actualTeams, meta.participants, 16);
    const ilbirs = result.find((t) => t.name === 'Ilbirs eSports');
    assert(ilbirs, '结果应含 Liquipedia 原名 "Ilbirs eSports"');
    assert(ilbirs && ilbirs.id === 8262790, 'Ilbirs 应通过模糊匹配关联到真实 id 8262790，实际: ' + (ilbirs && ilbirs.id));
  } finally {
    requestHandler = null;
    cache.remove(cacheKey);
  }
});

// 测试 3：无 Liquipedia 列表时回退到「待定队伍 N」占位
check('无 Liquipedia 列表：回退到「待定队伍 N」占位', () => {
  const actualTeams = [
    { id: 100, name: 'Team A' },
    { id: 101, name: 'Team B' }
  ];
  // liqParticipantsArr = null, metaParticipants = 5
  const result = refreshBranch2(actualTeams, null, 5);
  assert(result.length === 5, '应补到 5 支，实际: ' + result.length);
  assert(result[0].id === 100 && result[0].name === 'Team A', '保留已参赛 Team A');
  const fillers = result.filter((t) => /^待定队伍 /.test(t.name));
  assert(fillers.length === 3, '应补 3 个占位，实际: ' + fillers.length);
});

// 测试 4：实际 >= meta 时不应触发分支②
check('实际 >= meta：不触发分支②', () => {
  const actualTeams = [
    { id: 100, name: 'Team A' },
    { id: 101, name: 'Team B' }
  ];
  // metaParticipants = 2，actualCount = 2，相等，不触发
  const result = refreshBranch2(actualTeams, null, 2);
  assert(result.length === 2, '应原样返回 2 支，实际: ' + result.length);
  assert(result === actualTeams, '应返回原数组引用');
});

// ===== 运行全部测试 =====
async function runAll() {
  for (const t of tests) {
    if (t.kind === 'section') { console.log(t.title); continue; }
    try {
      await t.fn();
      passed++;
      console.log('PASS  ' + t.label);
    } catch (e) {
      failed++;
      console.log('FAIL  ' + t.label + '  ->  ' + (e && e.message || e));
    }
  }
  console.log('\n=== 结果 ===');
  console.log('通过: ' + passed + '  失败: ' + failed);
  console.log(failed === 0 ? '全部通过 ✅' : '存在失败 ❌');
  process.exit(failed === 0 ? 0 : 1);
}

runAll();
