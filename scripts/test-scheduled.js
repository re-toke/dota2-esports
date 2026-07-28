// 测试 Liquipedia 赛程解析（parseScheduledMatches + getScheduledMatches）
// 用法：node scripts/test-scheduled.js

const liquipedia = require('../utils/liquipedia.js');
const LiquiParse = require('../utils/liquipedia-parse.js');

let pass = 0, fail = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => { pass++; console.log('  ✓ ' + name); })
    .catch((e) => { fail++; console.log('  ✗ ' + name + ' -- ' + (e && e.message || e)); });
}

console.log('--- Liquipedia 赛程解析测试 ---');

// 1) 单元测试：parseScheduledMatches 解析合成 wikitext
check('parseScheduledMatches 解析合成 Match 模板', () => {
  const wikitext = [
    '{{Matchlist|title=Day 1',
    '|M1={{Match',
    '|bestof=3',
    '|opponent1={{TeamOpponent|Team Falcons}}',
    '|opponent2={{TeamOpponent|BetBoom Team}}',
    '|date=April 22, 2024 - 13:00 {{Abbr/CEST}}',
    '|finished=false',
    '}}',
    '|M2={{Match',
    '|bestof=2',
    '|opponent1={{TeamOpponent|[[Team Liquid|Liquid]]}}',
    '|opponent2={{TeamOpponent|Tundra Esports}}',
    '|date=2024-04-23 10:00',
    '|finished=true',
    '}}',
    '}}'
  ].join('\n');
  const matches = LiquiParse.parseScheduledMatches(wikitext);
  if (matches.length !== 2) throw new Error('应解析出 2 场对阵，实际: ' + matches.length);
  const m1 = matches[0];
  if (m1.team1Name !== 'Team Falcons') throw new Error('team1Name 应为 Team Falcons，实际: ' + m1.team1Name);
  if (m1.team2Name !== 'BetBoom Team') throw new Error('team2Name 应为 BetBoom Team，实际: ' + m1.team2Name);
  if (m1.boType !== 'BO3') throw new Error('boType 应为 BO3，实际: ' + m1.boType);
  if (m1.finished !== false) throw new Error('finished 应为 false');
  if (m1.startTime <= 0) throw new Error('startTime 解析失败: ' + m1.startTime);
  console.log('    M1:', JSON.stringify(m1));
  const m2 = matches[1];
  if (m2.team1Name !== 'Liquid') throw new Error('team1Name 应为 Liquid（[[链接|显示名]] 提取），实际: ' + m2.team1Name);
  if (m2.finished !== true) throw new Error('M2 finished 应为 true');
  console.log('    M2:', JSON.stringify(m2));
});

// 2) 集成测试：getScheduledMatches 真实拉取 Liquipedia 数据
check('getScheduledMatches 拉取 ESL One Birmingham 2024 真实数据', () => {
  return liquipedia.getScheduledMatches('ESL One Birmingham 2024')
    .then((matches) => {
      console.log('    总对阵数:', matches.length);
      if (matches.length === 0) {
        console.log('    ⚠ 警告: 未解析到任何对阵，可能 Liquipedia API 失败或页面结构变化');
        return;
      }
      const live = matches.filter(m => m.phase === 'live');
      const upcoming = matches.filter(m => m.phase === 'upcoming');
      const recent = matches.filter(m => m.phase === 'recent');
      console.log('    LIVE:', live.length, 'UPCOMING:', upcoming.length, 'RECENT:', recent.length);
      if (matches.length > 0) {
        console.log('    首场:', JSON.stringify(matches[0]));
      }
    });
});

// 3) 测试 {{Matchlist}} 容器被正确跳过
check('parseScheduledMatches 跳过 Matchlist 容器', () => {
  const wikitext = '{{Matchlist|title=Test|M1={{Match|bestof=1|opponent1={{TeamOpponent|A}}|opponent2={{TeamOpponent|B}}|date=2026-08-15 18:00|finished=false}}}}';
  const matches = LiquiParse.parseScheduledMatches(wikitext);
  if (matches.length !== 1) throw new Error('应解析出 1 场对阵（跳过 Matchlist），实际: ' + matches.length);
});

Promise.resolve()
    .then(() => check('parseScheduledMatches 解析合成 Match 模板', () => {
      const wikitext = [
        '{{Matchlist|title=Day 1',
        '|M1={{Match',
        '|bestof=3',
        '|opponent1={{TeamOpponent|Team Falcons}}',
        '|opponent2={{TeamOpponent|BetBoom Team}}',
        '|date=April 22, 2024 - 13:00 {{Abbr/CEST}}',
        '|finished=false',
        '}}',
        '|M2={{Match',
        '|bestof=2',
        '|opponent1={{TeamOpponent|[[Team Liquid|Liquid]]}}',
        '|opponent2={{TeamOpponent|Tundra Esports}}',
        '|date=2024-04-23 10:00',
        '|finished=true',
        '}}',
        '}}'
      ].join('\n');
      const matches = LiquiParse.parseScheduledMatches(wikitext);
      if (matches.length !== 2) throw new Error('应解析出 2 场对阵，实际: ' + matches.length);
    }))
    .then(() => check('getScheduledMatches 拉取 ESL One Birmingham 2024', () => {
      return liquipedia.getScheduledMatches('ESL One Birmingham 2024').then((m) => {
        console.log('    总数:', m.length, 'LIVE:', m.filter(x=>x.phase==='live').length,
          'UPCOMING:', m.filter(x=>x.phase==='upcoming').length);
      });
    }))
    .then(() => {
      console.log('\n--- 测试结果 ---');
      console.log('通过: ' + pass + ', 失败: ' + fail);
      process.exit(fail > 0 ? 1 : 0);
    });
