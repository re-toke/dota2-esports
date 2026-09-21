#!/usr/bin/env node
/**
 * scripts/test/test-discover-mirror.js
 *
 * 收录口径「镜像一致性」守卫（2026-09-19 新增）。
 *
 * ## 为什么需要它
 * 收录/分级规则被**镜像在 4 处**，任何一处漏改都会造成口径漂移：
 *   1. utils/tiers.js                                  （客户端权威）
 *   2. cloudfunctions/cron-discover-tournaments/discover-core.js （GH Actions + 云函数共用）
 *   3. cloudfunctions/aggregation/index.js             （服务端裁剪 COMMUNITY_TIER_RES）
 *   4. supabase/functions/opendota-proxy/index.ts      （服务端裁剪 COMMUNITY_TIER_RES）
 *
 * ⚠️ 此前 discover-core.js 的注释声称「test-discover-mirror.js 会校验」，**但该文件从未存在**
 *    → 四处镜像长期无守卫。本文件补齐。
 *
 * 另含**行为快照断言**：固定样本赛事名的「收录/剔除/降级」结果（防口径被无意改宽）。
 *
 * 用法：node scripts/test/test-discover-mirror.js
 * 退出码：0 = 全部一致；1 = 存在漂移
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const tiers = require(path.join(ROOT, 'utils/tiers.js'));
const core = require(path.join(ROOT, 'cloudfunctions/cron-discover-tournaments/discover-core.js'));

let failed = 0;
let passed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log('PASS  ' + label); }
  else { failed++; console.log('FAIL  ' + label); }
}

/** 从源文件里数出 `COMMUNITY_TIER_RES = [ ... ]` 块中的正则条数 */
function countRegexInBlock(src, marker) {
  const i = src.indexOf(marker);
  if (i < 0) return -1;
  const j = src.indexOf('];', i);
  if (j < 0) return -1;
  const block = src.slice(i, j);
  return (block.match(/^\s*\/.*\/[a-z]*,?\s*$/gm) || []).length;
}

// ===== 1. utils/tiers.js ↔ discover-core.js 逐条一致 =====
function sameSources(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (String(a[i]) !== String(b[i])) return false;
  }
  return true;
}

ok(tiers.COMMUNITY_TIERS.length === core.COMMUNITY_TIERS.length,
  'COMMUNITY_TIERS 条数一致（' + tiers.COMMUNITY_TIERS.length + ' vs ' + core.COMMUNITY_TIERS.length + '）');
ok(sameSources(tiers.COMMUNITY_TIERS.map((x) => x.test), core.COMMUNITY_TIERS.map((x) => x.test)),
  'COMMUNITY_TIERS 正则逐条一致');

ok(tiers.HARD_EXCLUDE_RULES.length === core.HARD_EXCLUDE_RULES.length,
  'HARD_EXCLUDE_RULES 条数一致（' + tiers.HARD_EXCLUDE_RULES.length + '）');
ok(sameSources(tiers.HARD_EXCLUDE_RULES, core.HARD_EXCLUDE_RULES),
  'HARD_EXCLUDE_RULES 正则逐条一致');

ok(sameSources(tiers.QUALIFIER_RULES, core.QUALIFIER_RULES),
  'QUALIFIER_RULES 正则逐条一致');

ok(tiers.QUALIFIER_MAX_GRADE === core.QUALIFIER_MAX_GRADE
  && tiers.QUALIFIER_MAX_RANK === core.QUALIFIER_MAX_RANK,
  '预选赛降级上限一致（' + tiers.QUALIFIER_MAX_GRADE + '/rank' + tiers.QUALIFIER_MAX_RANK + '）');

// ===== 2. 两处服务端裁剪的正则条数 = 客户端 COMMUNITY_TIERS 条数 =====
/**
 * 剔除注释后再判定。
 * ⚠️ 铁律（本项目已踩过）：检测工具**必须先剥注释** —— 否则「在注释里文档化这个 BUG」的
 *    源码会污染检测串，造成**永久误报（自指陷阱）**。本轮即因此误报过一次。
 */
function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, '')                        // 块注释
    .split('\n')
    // ⚠️ 实测（本项目文件为 CRLF）：仅靠 `(^|[^:])//` 的行内替换**剥不掉整行注释**，
    //    必须显式判「本行是否以 // 开头」。漏了这一步会造成自指误报。
    .map((l) => (/^\s*\/\//.test(l) ? '' : l.replace(/(^|[^:])\/\/.*$/, '$1')))
    .join('\n');
}

// 所有文本断言一律基于「去注释」后的源码
const aggSrc = stripComments(fs.readFileSync(path.join(ROOT, 'cloudfunctions/aggregation/index.js'), 'utf8'));
const efSrc = stripComments(fs.readFileSync(path.join(ROOT, 'supabase/functions/opendota-proxy/index.ts'), 'utf8'));
const aggCount = countRegexInBlock(aggSrc, 'COMMUNITY_TIER_RES');
const efCount = countRegexInBlock(efSrc, 'COMMUNITY_TIER_RES');
ok(aggCount === tiers.COMMUNITY_TIERS.length,
  'cloudfunctions/aggregation COMMUNITY_TIER_RES 条数一致（' + aggCount + '）');
ok(efCount === tiers.COMMUNITY_TIERS.length,
  'opendota-proxy EF COMMUNITY_TIER_RES 条数一致（' + efCount + '）');

// ===== 3. 服务端必须是「白名单准入」：KEEP_LEAGUE_TIERS 不得含 amateur/professional =====
function keepTiersLine(src) {
  const m = src.match(/KEEP_LEAGUE_TIERS[^=]*=\s*\{([^}]*)\}/);
  return m ? m[1] : '';
}
const aggKeep = keepTiersLine(aggSrc);
const efKeep = keepTiersLine(efSrc);
ok(!/amateur/.test(aggKeep), 'aggregation：KEEP_LEAGUE_TIERS 已移除 amateur');
ok(!/professional/.test(aggKeep), 'aggregation：KEEP_LEAGUE_TIERS 已移除 professional（改为白名单准入）');
ok(!/amateur/.test(efKeep), 'EF：KEEP_LEAGUE_TIERS 已移除 amateur');
ok(!/professional/.test(efKeep), 'EF：KEEP_LEAGUE_TIERS 已移除 professional（改为白名单准入）');

// ===== 4. 行为快照（收录口径）=====
// 4.1 社区/娱乐赛：不命中白名单（服务端据此丢弃）
ok(tiers.communityTierFromName('肛宝联赛-老婆杯') === null,
  '社区赛「肛宝联赛-老婆杯」不命中白名单（服务端丢弃）');
// 4.2 硬排除
ok(tiers.shouldExclude('Dota 2 Amateur Series') === true, '硬排除：Amateur Series');
ok(tiers.shouldExclude('BETBOOM Streamers Battle Dota 15') === true, '硬排除：Streamers Battle（表演赛）');
ok(tiers.shouldExclude('The International 2026 - Weekly Cup') === true, '硬排除：Weekly 周赛');
// 4.3 预选赛：保留但降级为 B + 标注
(function () {
  const q1 = tiers.communityTierFromName('BLAST Slam IX China Qualifier');
  ok(!!q1 && q1.grade === 'B' && q1.qualifier === true, '预选赛降级：BLAST Slam IX China Qualifier → B级+标注');
  const q2 = tiers.communityTierFromName('The International 2026 - Regional Qualifier China');
  ok(!!q2 && q2.grade === 'B' && q2.qualifier === true, '预选赛降级：TI Regional Qualifier → B级+标注');
  const q3 = tiers.communityTierFromName('Knight Cup Qualifier');
  ok(!!q3 && q3.grade === 'B' && q3.qualifier === true, '预选赛降级：无名预选赛也保留为 B级+标注');
})();
// 4.4 正赛不得被误伤
(function () {
  const s1 = tiers.communityTierFromName('The International 2013');
  ok(!!s1 && s1.grade === 'S' && !s1.qualifier, '正赛保留：The International 2013 → S级');
  const s2 = tiers.communityTierFromName('ESL One Birmingham 2026');
  ok(!!s2 && s2.grade === 'S' && !s2.qualifier, '正赛保留：ESL One Birmingham 2026 → S级');
})();

// ===== 5. 「口径单点权威」守卫（2026-09-19 选项 C）=====
const cpSrc = stripComments(fs.readFileSync(path.join(ROOT, 'utils/cloudProxy.js'), 'utf8'));
const apiSrc = stripComments(fs.readFileSync(path.join(ROOT, 'utils/api.js'), 'utf8'));

// 5.1 服务端 keep 语义必须是「OR 白名单」
//     ⚠️ The International 自身 tier=excluded，只有 OR 语义才保留得住；
//        曾误写成 `l.tier === 'professional' && hitWhitelist` → 会把 TI 删掉。
ok(/\|\|\s*hitWhitelist\s*;/.test(aggSrc), 'aggregation：keep 保持「OR 白名单」语义（否则 TI 被删）');
ok(/\|\|\s*hitWhitelist\s*;/.test(efSrc), 'EF：keep 保持「OR 白名单」语义（否则 TI 被删）');
ok(!/l\.tier\s*===?\s*['"]professional['"]\s*&&\s*hitWhitelist/.test(aggSrc),
  'aggregation：未出现「professional && whitelist」错误收紧');
ok(!/l\.tier\s*===?\s*["']professional["']\s*&&\s*hitWhitelist/.test(efSrc),
  'EF：未出现「professional && whitelist」错误收紧');

// 5.2 getLeagues 不再回落云函数（口径由 EF 唯一负责）
ok(/NO_CLOUD_FALLBACK_ACTIONS\s*=\s*\{[^}]*getLeagues\s*:\s*1/.test(cpSrc),
  'cloudProxy：getLeagues 已登记为「不回云函数」');

// 5.3 客户端入口闸门存在且已接线（EF 失败/直连时兜底，与来源无关）
ok(/function\s+filterCollectableLeagues/.test(apiSrc), 'api.js：存在 filterCollectableLeagues 入口闸门');
ok(/\.then\(filterCollectableLeagues\)/.test(apiSrc), 'api.js：getLeagues 已接线该闸门');

// 5.4 行为快照：闸门语义（premium 放行 / 其余需命中白名单）
(function () {
  const keep = (name, tier) => (tier === 'premium') || (tiers.communityTierFromName(name) !== null);
  ok(keep('The International 2013', 'excluded') === true, '闸门：TI（tier=excluded）必须保留');
  ok(keep('肛宝联赛-老婆杯', 'professional') === false, '闸门：社区赛（被标 professional）必须挡住');
  ok(keep('ESL One Birmingham 2026', 'professional') === true, '闸门：ESL One 必须保留');
  ok(keep('Some Random Cup', 'amateur') === false, '闸门：无名 amateur 赛事必须挡住');
})();

console.log('---');
console.log('通过 ' + passed + ' / ' + (passed + failed));
if (failed) {
  console.log('⚠️ 镜像漂移 ' + failed + ' 处 —— 请同步 utils/tiers.js / discover-core.js / aggregation / opendota-proxy');
  process.exit(1);
}
console.log('✅ 收录口径四处镜像一致 + 行为快照通过');
