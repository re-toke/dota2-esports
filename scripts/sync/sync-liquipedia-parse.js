// scripts/sync-liquipedia-parse.js
// 消除云函数与小程序「Liquipedia 解析双源漂移」：把唯一手工维护的纯解析模块
// utils/liquipedia-parse.js 镜像到 cloudfunctions/aggregation/liquipedia-parse.js，
// 保证两侧共用同一份 wikitext 解析逻辑（客户端 getLeagueMetadata + 云函数 liquipediaLeagueMeta
// 都依赖它 → 解析结果必然一致）。
//
// 与 sync-canon-map.js 同构：写入两侧 + 断言字节一致 + 功能漂移自检 + 非 0 退出码（CI 拦截）。
//
// ⚠️ 产物必须是 .js 模块（module.exports = {...}）：微信小程序 require() 不支持 .json。
//
// 用法：node scripts/sync-liquipedia-parse.js
// 退出码 0 = 成功且两侧一致；非 0 = 失败（镜像不一致 / 校验未通过）。

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const MINI_JS = path.join(ROOT, 'utils', 'liquipedia-parse.js');
const CLOUD_JS = path.join(ROOT, 'cloudfunctions', 'aggregation', 'liquipedia-parse.js');

function main() {
  if (!fs.existsSync(MINI_JS)) {
    console.error('[sync-liquipedia-parse] 致命：源文件不存在: ' + MINI_JS);
    process.exit(1);
  }
  // G7.2 修复换行符坑（2026-07-29）：用 Buffer 直接读写，避免 Windows 上
  // fs.writeFileSync 的 'utf8' 模式把 \n 静默转换为 \r\n，导致两侧字节不一致。
  // 原实现：readFileSync(utf8) → writeFileSync(utf8) 会引入 CRLF 污染。
  // 修复：Buffer 直读直写 + 字节级对比，保留源文件原始换行符格式。
  const buf = fs.readFileSync(MINI_JS);

  // 写入小程序侧（源，已存在，覆写保证）
  fs.mkdirSync(path.dirname(MINI_JS), { recursive: true });
  fs.writeFileSync(MINI_JS, buf);

  // 镜像到云函数侧（独立部署，无法共享小程序 utils）
  fs.mkdirSync(path.dirname(CLOUD_JS), { recursive: true });
  fs.writeFileSync(CLOUD_JS, buf);

  // 断言两侧字节一致（核心不变量）—— 字节级对比，不经字符串转换
  const a = fs.readFileSync(MINI_JS);
  const b = fs.readFileSync(CLOUD_JS);
  if (!a.equals(b)) {
    console.error('[sync-liquipedia-parse] 致命：两侧 liquipedia-parse.js 字节不一致，镜像写入失败');
    console.error('  mini size=' + a.length + ' cloud size=' + b.length);
    process.exit(1);
  }

  // 功能漂移自检：两侧导出形状一致，且同一输入解析结果一致。
  // 清空 require 缓存后分别加载，避免命中同一份实例。
  delete require.cache[require.resolve(MINI_JS)];
  delete require.cache[require.resolve(CLOUD_JS)];
  const mini = require(MINI_JS);
  const cloud = require(CLOUD_JS);

  const exportNames = [
    'parseTemplate', 'splitTopLevel', 'stripWikitextMarkup', 'stripTags',
    'parsePrizePool', 'collectDates', 'findTemplateEnd', 'extractLink',
    'parseOpponentBlock', 'parseTeamCardBlock', 'parseParticipants', 'parseLeagueMetadata',
    'parseScheduledMatches', 'parseTeamLogo', 'parseLeagueTier', 'parseBoFormat'
  ];
  const missingMini = exportNames.filter((n) => typeof mini[n] !== 'function');
  const missingCloud = exportNames.filter((n) => typeof cloud[n] !== 'function');
  if (missingMini.length || missingCloud.length) {
    console.error('[sync-liquipedia-parse] 致命：导出形状缺失 mini=[' + missingMini + '] cloud=[' + missingCloud + ']');
    process.exit(1);
  }

  // §8.3 parseTeamLogo 漂移自检（2026-07-29）：两侧对同一战队页 wikitext 的解析结果必须一致
  const teamWikitext = [
    '{{Infobox team',
    '|name=Team Spirit',
    '|image=Team_Spirit_logo.png',
    '|imagecaption=',
    '|region=CIS',
    '}}'
  ].join('\n');
  const miniLogo = mini.parseTeamLogo(teamWikitext);
  const cloudLogo = cloud.parseTeamLogo(teamWikitext);
  if (JSON.stringify(miniLogo) !== JSON.stringify(cloudLogo)) {
    console.error('[sync-liquipedia-parse] 致命：parseTeamLogo 两侧结果不一致');
    console.error('  mini : ' + JSON.stringify(miniLogo));
    console.error('  cloud: ' + JSON.stringify(cloudLogo));
    process.exit(1);
  }
  if (!miniLogo || miniLogo.image !== 'Team_Spirit_logo.png') {
    console.error('[sync-liquipedia-parse] 致命：parseTeamLogo 合成用例解析异常: ' + JSON.stringify(miniLogo));
    process.exit(1);
  }

  // §9 parseLeagueTier 漂移自检（2026-07-30）：两侧对同一赛事页 wikitext 的解析结果必须一致
  const leagueWikitext = [
    '{{Infobox league',
    '|name=DreamLeague Season 27',
    '|liquipediatier=1',
    '|sdate=2025-12-10',
    '|edate=2025-12-21',
    '|prizepoolusd=1,000,000',
    '}}'
  ].join('\n');
  const miniTier = mini.parseLeagueTier(leagueWikitext);
  const cloudTier = cloud.parseLeagueTier(leagueWikitext);
  if (JSON.stringify(miniTier) !== JSON.stringify(cloudTier)) {
    console.error('[sync-liquipedia-parse] 致命：parseLeagueTier 两侧结果不一致');
    console.error('  mini : ' + JSON.stringify(miniTier));
    console.error('  cloud: ' + JSON.stringify(cloudTier));
    process.exit(1);
  }
  if (!miniTier || miniTier.tier !== 1) {
    console.error('[sync-liquipedia-parse] 致命：parseLeagueTier 合成用例解析异常: ' + JSON.stringify(miniTier));
    process.exit(1);
  }

  // 同一合成 wikitext 的解析结果必须逐字节一致（这是 A+B 双源一致性的硬闸门）
  const synthetic = [
    '{{Infobox league',
    '|name=Drift Check Cup',
    '|sdate=2026-08-01',
    '|edate=2026-08-15',
    '|prizepool=1000000',
    '|city=Shanghai',
    '|country=China',
    '|organizer=Valve',
    '|format=Double-elimination',
    '}}',
    '',
    '{{TeamParticipants',
    '|{{Opponent|Team Alpha|qualification={{Qualification|method=invite|qual}}}}',
    '|{{Opponent|Team Beta|qualification={{Qualification|method=qual|qual}}}}',
    '}}'
  ].join('\n');

  const miniOut = mini.parseLeagueMetadata(synthetic, 'Drift Check Cup');
  const cloudOut = cloud.parseLeagueMetadata(synthetic, 'Drift Check Cup');
  if (JSON.stringify(miniOut) !== JSON.stringify(cloudOut)) {
    console.error('[sync-liquipedia-parse] 致命：parseLeagueMetadata 两侧结果不一致');
    console.error('  mini : ' + JSON.stringify(miniOut));
    console.error('  cloud: ' + JSON.stringify(cloudOut));
    process.exit(1);
  }
  if (!miniOut || miniOut.participants.length !== 2) {
    console.error('[sync-liquipedia-parse] 致命：合成用例解析异常: ' + JSON.stringify(miniOut));
    process.exit(1);
  }

  console.log(
    '[sync-liquipedia-parse] OK · 两侧 liquipedia-parse.js 字节一致 · 导出 ' +
    exportNames.length + ' 个纯函数 · 合成用例解析漂移自检通过（含 parseTeamLogo + parseLeagueTier）'
  );
}

main();
