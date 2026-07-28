// scripts/test-epl-participants.js
// 用真实 EPL Masters I wikitext 测试 parseParticipants 解析逻辑
// 验证是否能正确解析出 16 支队伍（含 1 TBD）
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

// 加速测试：让 setTimeout 回调立即执行
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

// ===== 4. 读取真实 wikitext =====
// 从 WebFetch 保存的 JSON 文件中提取 wikitext
const rawJsonPath = path.join(__dirname, 'epl-wikitext.json');
let EPL_WIKITEXT = null;
try {
  const rawJson = JSON.parse(fs.readFileSync(rawJsonPath, 'utf8'));
  EPL_WIKITEXT = rawJson.query.pages[0].revisions[0].slots.main.content;
} catch (e) {
  // 如果没有保存的文件，用内嵌的精简版 wikitext（仅 Participants 区块）
  EPL_WIKITEXT = null;
}

// 模拟 MediaWiki revisions 响应
function makeRevisionsResponse(pageTitle, wikitext) {
  return {
    batchcomplete: true,
    query: {
      pages: [{
        pageid: 191619,
        ns: 0,
        title: pageTitle,
        revisions: [{
          slots: {
            main: {
              contentmodel: 'wikitext',
              contentformat: 'text/x-wiki',
              content: wikitext
            }
          }
        }]
      }]
    }
  };
}

// ===== 5. 测试 =====

section('\n--- EPL Masters I 参赛队伍解析测试 ---');

// 测试 1：解析完整 wikitext，验证参赛队伍数量
check('parseParticipants 解析 EPL Masters I 应返回 16 支队伍', async () => {
  assert(EPL_WIKITEXT !== null, 'wikitext 不应为 null（请确保 epl-wikitext.json 存在）');
  assert(EPL_WIKITEXT.length > 10000, 'wikitext 应为完整内容（长度 > 10000）');

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
    assert(meta.canonical === 'EPL Masters I',
      'canonical 应为 "EPL Masters I"，实际: ' + meta.canonical);
    assert(meta.participants !== null, 'participants 不应为 null');
    assert(Array.isArray(meta.participants), 'participants 应为数组');
    assert(meta.participants.length === 16,
      '应有 16 支队伍，实际: ' + meta.participants.length);

    // 验证具体队伍
    const names = meta.participants.map(function (t) { return t.name; });
    console.log('  解析到的队伍:', names.join(', '));

    // Playoff Seed（4 支）
    assert(names.indexOf('MOUZ') >= 0, '应含 MOUZ');
    assert(names.indexOf('Rune Eaters') >= 0, '应含 Rune Eaters');
    assert(names.indexOf('Yellow Submarine') >= 0, '应含 Yellow Submarine');
    // 第 4 支是 TBD（空 Opponent）
    assert(names.indexOf('TBD') >= 0, '应含 TBD（未公布队伍）');

    // Group Stage Seed（12 支）
    assert(names.indexOf('Amaru Gaming') >= 0, '应含 Amaru Gaming');
    assert(names.indexOf('Power Rangers') >= 0, '应含 Power Rangers');
    assert(names.indexOf('Nemiga Gaming') >= 0, '应含 Nemiga Gaming');
    assert(names.indexOf('Team Jenz') >= 0, '应含 Team Jenz');

    // 验证 FormerParticipants 已过滤
    assert(names.indexOf('GLYPH') < 0, '不应含 GLYPH（FormerParticipants）');
    assert(names.indexOf('Team Bald') < 0, '不应含 Team Bald（FormerParticipants）');

    // 验证状态
    const mouz = meta.participants.find(function (t) { return t.name === 'MOUZ'; });
    assert(mouz && mouz.status === 'invited', 'MOUZ 应为 invited');

    const jenz = meta.participants.find(function (t) { return t.name === 'Team Jenz'; });
    assert(jenz && jenz.status === 'qualifier', 'Team Jenz 应为 qualifier');
  } finally {
    requestHandler = null;
    cache.remove(cacheKey);
  }
});

// 测试 2：验证 team_number 字段
check('Infobox league 的 team_number 应为 16', async () => {
  assert(EPL_WIKITEXT !== null, 'wikitext 不应为 null');
  // 直接在 wikitext 中搜索 team_number
  const m = EPL_WIKITEXT.match(/team_number\s*=\s*(\d+)/);
  assert(m !== null, 'wikitext 应含 team_number 字段');
  assert(m[1] === '16', 'team_number 应为 16，实际: ' + m[1]);
});

// ===== TeamCard 模板测试（旧版赛事页，如 ESL One Birmingham 2024）=====

section('\n--- TeamCard 模板解析测试（ESL One Birmingham 2024）---');

// 读取真实 ESL One Birmingham 2024 wikitext fixture
const eslJsonPath = path.join(__dirname, 'esl-birmingham-wikitext.json');
let ESL_WIKITEXT = null;
try {
  const rawJson = JSON.parse(fs.readFileSync(eslJsonPath, 'utf8'));
  ESL_WIKITEXT = rawJson.query.pages[0].revisions[0].slots.main.content;
} catch (e) {
  ESL_WIKITEXT = null;
}

// 测试 3：parseParticipants 解析 TeamCard 模板赛事应返回 12 支队伍
check('parseParticipants 解析 ESL One Birmingham 2024 应返回 12 支 TeamCard 队伍', async () => {
  assert(ESL_WIKITEXT !== null, 'ESL wikitext 不应为 null（请确保 esl-birmingham-wikitext.json 存在）');
  assert(ESL_WIKITEXT.length > 10000, 'ESL wikitext 应为完整内容（长度 > 10000）');

  const cacheKey = 'liquipedia_league_' + consensus.normName('ESL One Birmingham 2024');
  cache.remove(cacheKey);
  requestHandler = function (opts) {
    opts.success({
      statusCode: 200,
      data: makeRevisionsResponse('ESL One Birmingham 2024', ESL_WIKITEXT)
    });
  };

  try {
    const meta = await liquipedia.getLeagueMetadata('ESL One Birmingham 2024');
    assert(meta !== null, 'metadata 不应为 null');
    assert(meta.participants !== null, 'participants 不应为 null');
    assert(Array.isArray(meta.participants), 'participants 应为数组');
    assert(meta.participants.length === 12,
      '应有 12 支队伍，实际: ' + meta.participants.length);

    const names = meta.participants.map(function (t) { return t.name; });
    console.log('  解析到的队伍:', names.join(', '));

    // 验证具体队伍
    assert(names.indexOf('Gaimin Gladiators') >= 0, '应含 Gaimin Gladiators');
    assert(names.indexOf('BetBoom Team') >= 0, '应含 BetBoom Team');
    assert(names.indexOf('Xtreme Gaming') >= 0, '应含 Xtreme Gaming');

    // 验证 EPT Leaderboard 队伍状态为 invited
    const gg = meta.participants.find(function (t) { return t.name === 'Gaimin Gladiators'; });
    assert(gg && gg.status === 'invited',
      'Gaimin Gladiators 应为 invited（EPT Leaderboard），实际: ' + (gg && gg.status));

    // 验证 Closed Qualifier 队伍状态为 qualifier
    const qualTeam = meta.participants.find(function (t) {
      return t.status === 'qualifier';
    });
    assert(qualTeam, '应至少有 1 支 qualifier 队伍');
    console.log('  qualifier 队伍示例:', qualTeam.name, '—', qualTeam.status);
  } finally {
    requestHandler = null;
    cache.remove(cacheKey);
  }
});

// 测试 4：合成 TeamCard + FormerParticipants 测试，验证过滤逻辑
check('TeamCard FormerParticipants 过滤：应移除已替换队伍', async () => {
  // 构造合成的 wikitext：3 支 TeamCard，其中 1 支在 FormerParticipants 中（已替换）
  const syntheticWikitext = [
    '{{Infobox league',
    '|name=Synthetic Test Cup',
    '|team_number=2',
    '}}',
    '',
    '==Participants==',
    '{{TeamCard columns start|cols=4}}',
    '{{TeamCard',
    '|team=Team Alpha',
    '|p1=Player1',
    '|qualifier=[[Test/Qualifier|Closed Qualifier]]',
    '}}',
    '{{TeamCard',
    '|team=Team Beta',
    '|qualifier=[[Test/Leaderboard|EPT Leaderboard]]',
    '}}',
    '{{TeamCard columns end}}',
    '',
    '{{FormerParticipants|{{TeamCard',
    '|team=Team Replaced',
    '|qualifier=[[Test/Qualifier|Closed Qualifier]]',
    '}}}}'
  ].join('\n');

  // 直接调用 parseParticipants（不经过 getLeagueMetadata 的网络层）
  const teams = liquipedia.parseParticipants(syntheticWikitext);
  assert(teams !== null, 'teams 不应为 null');
  assert(teams.length === 2, '应有 2 支队伍（Team Replaced 被过滤），实际: ' + teams.length);

  const names = teams.map(function (t) { return t.name; });
  console.log('  解析到的队伍:', names.join(', '));

  assert(names.indexOf('Team Alpha') >= 0, '应含 Team Alpha');
  assert(names.indexOf('Team Beta') >= 0, '应含 Team Beta');
  assert(names.indexOf('Team Replaced') < 0, '不应含 Team Replaced（FormerParticipants）');

  // 验证状态判定
  const alpha = teams.find(function (t) { return t.name === 'Team Alpha'; });
  assert(alpha && alpha.status === 'qualifier',
    'Team Alpha 应为 qualifier（Closed Qualifier），实际: ' + (alpha && alpha.status));

  const beta = teams.find(function (t) { return t.name === 'Team Beta'; });
  assert(beta && beta.status === 'invited',
    'Team Beta 应为 invited（EPT Leaderboard），实际: ' + (beta && beta.status));
});

// 测试 5：TeamCard 缺失 qualifier 字段应返回 TBD 状态
check('TeamCard 无 qualifier 字段时 status 应为 TBD', async () => {
  const wikitext = [
    '{{TeamCard',
    '|team=Team Gamma',
    '|p1=Player1',
    '}}'
  ].join('\n');

  const teams = liquipedia.parseParticipants(wikitext);
  assert(teams !== null, 'teams 不应为 null');
  assert(teams.length === 1, '应有 1 支队伍，实际: ' + teams.length);
  assert(teams[0].name === 'Team Gamma', '队名应为 Team Gamma');
  assert(teams[0].status === 'TBD', '无 qualifier 时 status 应为 TBD，实际: ' + teams[0].status);
});

// 测试 6：TeamCard 队名含 [[...]] 链接时应正确提取展示名与 slug
check('TeamCard team= 字段含 [[...]] 链接时正确提取', async () => {
  const wikitext = [
    '{{TeamCard',
    '|team=[[Team Spirit|TS]]',
    '|qualifier=[[Leaderboard]]',
    '}}'
  ].join('\n');

  const teams = liquipedia.parseParticipants(wikitext);
  assert(teams !== null, 'teams 不应为 null');
  assert(teams.length === 1, '应有 1 支队伍，实际: ' + teams.length);
  assert(teams[0].name === 'TS', '展示名应为 TS（链接文本），实际: ' + teams[0].name);
  assert(teams[0].liquipediaSlug === 'Team Spirit',
    'slug 应为 Team Spirit，实际: ' + teams[0].liquipediaSlug);
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
