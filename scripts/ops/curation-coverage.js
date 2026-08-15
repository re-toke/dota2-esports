#!/usr/bin/env node
/**
 * §6.2 curation 覆盖度仪表（2026-07-29）
 *
 * 对比 CURATED_EVENTS 与 OpenDota /leagues 返回的活跃赛事，
 * 统计 curation 覆盖率、未覆盖的活跃赛事列表，输出可操作的补全建议。
 *
 * 覆盖判定：OpenDota league.name 经 normKey 归一后存在于 curation map 中 → 已覆盖。
 * 活跃赛事定义：OpenDota /leagues 返回的所有赛事（OpenDota 仅返回有比赛记录的赛事）。
 *
 * 输出示例：
 *   [coverage] 活跃赛事 80，已覆盖 65，覆盖率 81.2%
 *   [coverage] 未覆盖 15 个（Top 3 by tier）：
 *     - ESL One Something 2026 (premium)
 *     - ...
 *
 * 用法：
 *   node scripts/curation-coverage.js              # 在线拉取 OpenDota /leagues
 *   node scripts/curation-coverage.js --offline     # 仅用 curation 自身统计（不联网）
 *
 * 退出码：0 = 成功；非 0 = 拉取失败或脚本错误
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..');

// 复用 curation 的归一口径（与 sync-canon-map.js 一致）
// §8.3 多语言支持（2026-07-29）：与 consensus.normName 同步，保留西里尔字母
function normKey(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9一-鿿а-яё]/g, '');
}

function loadCurationMap() {
  const curation = require(path.join(ROOT, 'utils', 'curation.js'));
  const events = curation.CURATED_EVENTS || [];
  const map = {};
  let count = 0;
  events.forEach((ev) => {
    if (!ev || !ev.canonical) return;
    const canonKey = normKey(ev.canonical);
    if (canonKey) { map[canonKey] = ev.canonical; count++; }
    (ev.aliases || []).forEach((a) => {
      const k = normKey(a);
      if (k) { map[k] = ev.canonical; }
    });
  });
  return { map, eventCount: events.length, keyCount: Object.keys(map).length };
}

// 离线模式：仅输出 curation 自身统计
function offlineReport() {
  const { map, eventCount, keyCount } = loadCurationMap();
  console.log('========== curation 覆盖度（离线模式） ==========');
  console.log('CURATED_EVENTS 条目 : ' + eventCount);
  console.log('规范映射 key 数     : ' + keyCount);
  console.log('说明：离线模式不拉取 OpenDota /leagues，仅统计 curation 自身规模。');
  console.log('     如需查看覆盖率，请去掉 --offline 参数运行（需联网）。');
}

// 在线模式：拉取 OpenDota /leagues 对比
async function onlineReport() {
  const { map, eventCount, keyCount } = loadCurationMap();

  console.log('[coverage] 拉取 OpenDota /leagues ...');
  const fetch = (await import('node-fetch')).default;
  const res = await fetch('https://api.opendota.com/api/leagues', {
    headers: { 'User-Agent': 'DOTA2-Esports-Hub/1.0 (coverage-check)' },
    timeout: 15000
  });
  if (!res.ok) throw new Error('OpenDota /leagues HTTP ' + res.status);
  const leagues = await res.json();

  const tierRank = { professional: 3, premium: 2, amateur: 1, excluded: 0 };
  const uncovered = [];
  let covered = 0;
  (leagues || []).forEach((l) => {
    if (!l || !l.name) return;
    const k = normKey(l.name);
    if (map[k]) {
      covered++;
    } else {
      uncovered.push({
        name: l.name,
        leagueid: l.leagueid,
        tier: l.tier || 'unknown',
        rank: tierRank[l.tier] || 0
      });
    }
  });

  const total = covered + uncovered.length;
  const rate = total > 0 ? (covered / total * 100).toFixed(1) : '0.0';

  console.log('\n========== curation 覆盖度 ==========');
  console.log('CURATED_EVENTS 条目 : ' + eventCount);
  console.log('规范映射 key 数     : ' + keyCount);
  console.log('OpenDota 活跃赛事    : ' + total);
  console.log('已覆盖              : ' + covered);
  console.log('未覆盖              : ' + uncovered.length);
  console.log('覆盖率              : ' + rate + '%');

  if (uncovered.length > 0) {
    // 按 tier rank 降序，优先展示高级别未覆盖赛事
    uncovered.sort((a, b) => b.rank - a.rank);
    const top = uncovered.slice(0, 10);
    console.log('\n未覆盖赛事（Top 10 by tier）：');
    top.forEach((u) => {
      console.log('  - ' + u.name + ' (tier: ' + u.tier + ', leagueid: ' + u.leagueid + ')');
    });
    if (uncovered.length > 10) {
      console.log('  ... 等共 ' + uncovered.length + ' 个未覆盖赛事');
    }
    console.log('\n💡 补全建议：');
    console.log('  1. 检查上述赛事是否应纳入 CURATED_EVENTS（utils/curation.js）');
    console.log('  2. 若为低级别赛事（amateur/excluded），可忽略');
    console.log('  3. 若为高级别赛事（professional/premium），建议补充 canonical + aliases');
  } else {
    console.log('\n✅ 所有活跃赛事均已覆盖');
  }
}

async function main() {
  const offline = process.argv.includes('--offline');
  try {
    if (offline) {
      offlineReport();
    } else {
      await onlineReport();
    }
  } catch (e) {
    console.error('[coverage] 失败：' + (e.message || e));
    console.error('  提示：如网络不可用，可加 --offline 参数仅查看 curation 自身统计');
    process.exit(1);
  }
}

main();
