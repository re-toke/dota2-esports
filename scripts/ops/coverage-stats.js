#!/usr/bin/env node
/**
 * coverage-stats.js — 赛事覆盖率统计脚本
 *
 * 脚本用途：
 *   聚合多源数据（curation 常驻权威库 + community 分级规则 + OpenDota 发现结果），
 *   输出赛事覆盖率统计 JSON，作为覆盖率仪表盘的数据源。
 *
 * 运行方式：
 *   node scripts/coverage-stats.js
 *
 * 前置条件：
 *   - 如需 OpenDota 发现数据，请先运行 `node scripts/discover-tournaments.js`
 *     生成 scripts/output/discovered-tournaments.json。
 *   - 本脚本不依赖 wx/cloud，可在普通 Node.js 环境运行。
 *   - 若 discovered-tournaments.json 不存在，openDotaDiscovery.available 标记为 false。
 *   - 若 scripts/output 目录不存在会自动创建。
 *
 * 输出文件：scripts/output/coverage-stats.json
 *
 * 退出码：0（即使部分数据源不可用也正常退出，不阻断 CI）
 */
'use strict';

const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..');
const OUTPUT_DIR = path.join(__dirname, 'output');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'coverage-stats.json');
const DISCOVERED_FILE = path.join(OUTPUT_DIR, 'discovered-tournaments.json');

// ===== 依赖加载（try/catch，失败时回退，确保无 wx/cloud 环境可用）=====
// curation.js 仅依赖 consensus.js（纯 JS，无 wx/cloud），与 discover-tournaments.js
// / audit-coverage.js 一致，正常情况下可直连加载；try/catch 为防御性兜底。
function loadDeps() {
  const deps = { curation: null, tiers: null, liquipediaAvailable: false, errors: [] };
  try {
    deps.curation = require(path.join(ROOT, 'utils', 'curation.js'));
  } catch (e) {
    deps.errors.push('curation.js: ' + (e && e.message ? e.message : String(e)));
  }
  try {
    deps.tiers = require(path.join(ROOT, 'utils', 'tiers.js'));
  } catch (e) {
    deps.errors.push('tiers.js: ' + (e && e.message ? e.message : String(e)));
  }
  // liquipedia.js 依赖 config.js / cache.js / cloudProxy.js，可能引用 wx → try/catch 探测。
  // 本脚本不调用 listAllTournaments（需 wx.cloud 代理，纯 Node 不可用），
  // 仅记录模块是否可 require，供日志输出。
  try {
    require(path.join(ROOT, 'utils', 'liquipedia.js'));
    deps.liquipediaAvailable = true;
  } catch (e) {
    deps.liquipediaAvailable = false;
    // 预期在纯 Node 环境下可能加载失败（依赖 wx），不计入 errors，仅记录到日志
    deps.liquipediaLoadError = (e && e.message ? e.message : String(e));
  }
  return deps;
}

// ===== §1 curation 统计：总数 / 等级分布 / 状态分布 / liquipediaSlug 覆盖 =====
function curationStats(curation) {
  const events = (curation && curation.CURATED_EVENTS) || [];
  const byGrade = { SSS: 0, S: 0, A: 0, B: 0, C: 0 };
  const byStatus = { '即将到来': 0, '进行中': 0, '已结束': 0, '已取消': 0, '无状态': 0 };
  let hasSlug = 0;
  let missingSlug = 0;

  events.forEach(function (ev) {
    if (!ev) return;
    // 等级分布（未知等级归入 C）
    const grade = (ev.tier && ev.tier.grade) || 'C';
    if (byGrade[grade] != null) byGrade[grade]++;
    else byGrade.C++;
    // 状态分布（无 status 字段归入「无状态」）
    const status = ev.status || '无状态';
    if (byStatus[status] != null) byStatus[status]++;
    else byStatus['无状态']++;
    // liquipediaSlug 覆盖
    if (ev.liquipediaSlug) hasSlug++;
    else missingSlug++;
  });

  return {
    total: events.length,
    byGrade: byGrade,
    byStatus: byStatus,
    hasLiquipediaSlug: hasSlug,
    missingLiquipediaSlug: missingSlug
  };
}

// ===== §3 等级一致性检查 =====
// 用 communityTierFromName 检查 curation 中每条赛事的等级与 community 规则是否一致：
//   - community 返回 null → communityBlindSpot（community 规则未覆盖该赛事名）
//   - community.grade === curation tier.grade → consistent
//   - 否则 → inconsistent
function tierConsistencyStats(curation, tiers) {
  const events = (curation && curation.CURATED_EVENTS) || [];
  const fn = (tiers && typeof tiers.communityTierFromName === 'function')
    ? tiers.communityTierFromName : null;
  let consistent = 0;
  let inconsistent = 0;
  let communityBlindSpot = 0;

  events.forEach(function (ev) {
    if (!ev || !ev.canonical) return;
    const curGrade = (ev.tier && ev.tier.grade) || null;
    if (!fn) { communityBlindSpot++; return; }
    const community = fn(ev.canonical);
    if (!community) {
      communityBlindSpot++;
    } else if (community.grade === curGrade) {
      consistent++;
    } else {
      inconsistent++;
    }
  });

  return {
    consistent: consistent,
    inconsistent: inconsistent,
    communityBlindSpot: communityBlindSpot
  };
}

// ===== §4 OpenDota 发现统计 =====
// 读取 discover-tournaments.js 生成的 discovered-tournaments.json（未覆盖赛事清单）。
// 该文件仅持久化「未覆盖」清单（去重后），不含 OpenDota 原始总量与已覆盖数
// （discover-tournaments.js 仅打印到控制台未落盘），故 totalOpenDota / covered 置 null。
function openDotaDiscoveryStats() {
  let raw = null;
  try {
    raw = fs.readFileSync(DISCOVERED_FILE, 'utf8');
  } catch (e) {
    return { available: false };
  }
  let list = null;
  try {
    list = JSON.parse(raw);
  } catch (e) {
    return { available: false };
  }
  if (!Array.isArray(list)) {
    return { available: false };
  }

  const uncovered = list.length;
  let suggestedForCuration = 0;
  list.forEach(function (item) {
    if (item && item.suggestedAction === 'add_to_curation') suggestedForCuration++;
  });

  return {
    available: true,
    totalOpenDota: null,   // discover-tournaments.json 未持久化原始总量
    covered: null,         // 同上，未持久化已覆盖数
    uncovered: uncovered,
    suggestedForCuration: suggestedForCuration
  };
}

// ===== 主流程 =====
function main() {
  console.log('========== 赛事覆盖率统计 ==========');
  const deps = loadDeps();

  if (deps.errors.length) {
    deps.errors.forEach(function (e) { console.warn('[coverage] 依赖加载失败: ' + e); });
  }
  if (!deps.curation) {
    console.error('[coverage] curation.js 加载失败，无法生成统计');
    return;
  }

  // liquipedia.js 可 require 性探测（仅日志，不影响输出）
  if (deps.liquipediaAvailable) {
    console.log('[coverage] liquipedia.js: 可 require（listAllTournaments 仍需 wx.cloud 代理）');
  } else {
    console.log('[coverage] liquipedia.js: 不可 require（' + (deps.liquipediaLoadError || '未知原因') + '）');
  }

  // §1 curation 统计
  const cStat = curationStats(deps.curation);
  console.log('');
  console.log('[coverage] curation 总数: ' + cStat.total);
  console.log('[coverage] 等级分布: ' + JSON.stringify(cStat.byGrade));
  console.log('[coverage] 状态分布: ' + JSON.stringify(cStat.byStatus));
  console.log('[coverage] liquipediaSlug: 有 ' + cStat.hasLiquipediaSlug + ' / 缺 ' + cStat.missingLiquipediaSlug);

  // §2 取消赛事检测
  const cancelledEvents = deps.curation.detectCancelledEvents
    ? deps.curation.detectCancelledEvents() : [];
  console.log('[coverage] 疑似取消赛事: ' + cancelledEvents.length + ' 个');
  cancelledEvents.forEach(function (c) {
    console.log('  - ' + c.canonical + '（' + c.reason + '）');
  });

  // §3 等级一致性
  const tc = tierConsistencyStats(deps.curation, deps.tiers);
  console.log('[coverage] 等级一致性: 一致 ' + tc.consistent + ' / 不一致 ' + tc.inconsistent + ' / community 盲区 ' + tc.communityBlindSpot);

  // §4 OpenDota 发现
  const od = openDotaDiscoveryStats();
  if (od.available) {
    console.log('[coverage] OpenDota 发现: 未覆盖 ' + od.uncovered + ' 个，建议补全 ' + od.suggestedForCuration + ' 个');
  } else {
    console.log('[coverage] OpenDota 发现: 不可用（' + DISCOVERED_FILE + ' 不存在或格式错误，请先运行 discover-tournaments.js）');
  }

  // 汇总输出
  const result = {
    generatedAt: new Date().toISOString(),
    curation: cStat,
    tierConsistency: tc,
    cancelledEvents: cancelledEvents,
    openDotaDiscovery: od
  };

  // 确保输出目录存在并写入
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2), 'utf8');

  console.log('');
  console.log('[coverage] 输出文件: ' + OUTPUT_FILE);
  console.log('======================================');
}

try {
  main();
} catch (e) {
  // 任何未捕获异常都输出但不阻断 CI（退出码 0）
  console.error('[coverage] 异常: ' + (e && e.message ? e.message : String(e)));
}
process.exitCode = 0;
