// ⚠️ P1-20 子项 4｜不入门禁 ·「按需诊断」：调试脚本，调用 liquipedia.getScheduledMatches（需联网）。
// 调试脚本：直接查看 Liquipedia 返回的 wikitext 内容
const liquipedia = require('../../utils/liquipedia.js');

console.log('--- 调试 Liquipedia wikitext 拉取 ---');

// 测试多个赛事名
const events = [
  'ESL One Birmingham 2024',
  'ESL One/Birmingham/2024',
  'ESL One Birmingham 2024/Group Stage',
  'The International 2024',
  'EPL Masters I',
];

events.reduce((p, name) => {
  return p.then(() => {
    console.log('\n=== 赛事: ' + name + ' ===');
    return liquipedia.getScheduledMatches(name).then((scheduled) => {
      const matches = (scheduled && scheduled.matches) || [];
      console.log('  对阵数:', matches.length, 'boFormat:', JSON.stringify(scheduled && scheduled.boFormat));
      if (matches.length > 0) {
        console.log('  首场:', JSON.stringify(matches[0]));
      }
    });
  });
}, Promise.resolve());
