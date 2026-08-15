#!/usr/bin/env node
/**
 * discover-tournaments.js — 赛事发现管道脚本
 *
 * 目标：定期扫描「OpenDota 有但 curation 未覆盖」的赛事，输出清单供人工补全 curation。
 *
 * 流程：
 *   1. 从 OpenDota 公共 API 拉取赛事列表（Node.js 内置 https，不依赖 wx/cloud）。
 *   2. 从 utils/curation.js 获取已收录赛事（canonical 名集合）。
 *   3. 用 consensus.eventFingerprint 做指纹去重（避免同名不同年份赛事误判为同一赛事）。
 *   4. 用 tiers.communityTierFromName 给未覆盖赛事做分级预判。
 *   5. 按等级排序输出（S/A/B 级优先，C 级标注「不收录」）。
 *   6. 写入 scripts/output/discovered-tournaments.json。
 *
 * 运行方式：
 *   node scripts/discover-tournaments.js
 *
 * 说明：
 *   - 独立 Node.js 运行，无 wx/cloud 依赖；require utils/curation.js 失败时回退到空 mock。
 *   - 失败时输出错误信息但退出码 0，不阻断 CI。
 *   - 不使用 emoji。
 */
'use strict';

const path = require('path');
const fs = require('fs');
const https = require('https');

const ROOT = path.resolve(__dirname, '..', '..');
const OUTPUT_DIR = path.join(__dirname, 'output');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'discovered-tournaments.json');
const OPENDOTA_URL = 'https://api.opendota.com/api/leagues?scheduled=true';

// ===== 依赖加载（try/catch，失败回退到 mock，确保无 wx/cloud 环境可用）=====
// curation.js 仅依赖 consensus.js（纯 JS，无 wx/cloud），正常情况下可直连加载；
// 此处 try/catch 为防御性兜底：若未来 curation 引入 wx/cloud 依赖，脚本仍可运行。
let consensus = null;
let tiers = null;
let curation = null;

try {
  consensus = require(path.join(ROOT, 'utils', 'consensus.js'));
} catch (e) {
  console.warn('[discover] warn: 加载 utils/consensus.js 失败，使用内联回退实现：' + (e.message || e));
  consensus = {
    normName: function (s) {
      return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
    },
    extractYear: function (s) {
      if (!s) return '';
      const m = String(s).match(/(20\d{2})/);
      return m ? m[1] : '';
    },
    eventFingerprint: function (ev) {
      if (!ev) return '';
      const name = ev.canonical || ev.name || '';
      const nameKey = consensus.normName(name);
      if (!nameKey) return '';
      const year = String(ev.year || consensus.extractYear(name) || '');
      return [nameKey, year, '', ''].join('|');
    }
  };
}

try {
  tiers = require(path.join(ROOT, 'utils', 'tiers.js'));
} catch (e) {
  console.warn('[discover] warn: 加载 utils/tiers.js 失败，使用回退实现（全部判为 C 级）：' + (e.message || e));
  tiers = { communityTierFromName: function () { return null; } };
}

try {
  curation = require(path.join(ROOT, 'utils', 'curation.js'));
} catch (e) {
  console.warn('[discover] warn: 加载 utils/curation.js 失败，使用空 mock（所有赛事视为未覆盖）：' + (e.message || e));
  curation = { CURATED_EVENTS: [], curatedEventFor: function () { return null; } };
}

// ===== HTTP（Node 内置 https，无第三方库）=====
function fetchJson(url) {
  return new Promise(function (resolve, reject) {
    let timedOut = false;
    const req = https.get(url, {
      headers: {
        'User-Agent': 'DOTA2-Esports-Hub/1.0 (discover-tournaments)',
        'Accept': 'application/json'
      },
      timeout: 20000
    }, function (res) {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        const err = new Error('OpenDota API HTTP ' + res.statusCode);
        res.resume();
        reject(err);
        return;
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', function (c) { data += c; });
      res.on('end', function () {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('OpenDota JSON 解析失败：' + e.message)); }
      });
    });
    req.on('timeout', function () { timedOut = true; req.destroy(new Error('OpenDota 请求超时')); });
    req.on('error', function (e) { if (!timedOut) reject(e); });
  });
}

// ===== 覆盖判定 =====
// 用 curation 库的 curatedEventFor（与项目运行时一致的权威匹配器，含 leagueId pin +
// game 跨游戏隔离 + 别名边界匹配）判定 OpenDota 赛事是否已被 curation 收录。
// 年份守卫：双方年份均可提取且不同 → 视为不同届次（未覆盖），避免同名不同年份误判。
function isCoveredByCuration(league) {
  const matched = curation.curatedEventFor
    ? curation.curatedEventFor(league.name, { leagueId: league.leagueid, game: 'dota2' })
    : null;
  if (!matched) return false;
  const leagueYear = consensus.extractYear(league.name) || '';
  const curYear = String(matched.year || consensus.extractYear(matched.canonical) || '');
  if (leagueYear && curYear && leagueYear !== curYear) return false; // 不同届次
  return true;
}

// 分级预判：优先用 communityTierFromName，未命中回退 C 级（社区赛，不收录）
function gradeOf(name) {
  const t = tiers.communityTierFromName(name);
  if (t && t.grade) return t;
  return { grade: 'C', rank: 0, label: '社区赛' };
}

async function main() {
  console.log('[discover] 拉取 OpenDota 赛事列表 ...');
  console.log('[discover] URL: ' + OPENDOTA_URL);

  const leagues = await fetchJson(OPENDOTA_URL);
  if (!Array.isArray(leagues)) {
    throw new Error('OpenDota 返回非数组（' + typeof leagues + '）');
  }

  const curationCount = (curation.CURATED_EVENTS || []).length;
  console.log('[discover] curation 已收录赛事基线：' + curationCount + ' 个');

  let total = 0;       // 有效赛事数（有非空归一名）
  let covered = 0;     // 已被 curation 覆盖
  const seenFp = {};   // 未覆盖指纹去重集合
  const uncovered = [];

  leagues.forEach(function (l) {
    if (!l || !l.name) return;
    const nameKey = consensus.normName(l.name);
    if (!nameKey) return; // 归一名为空（纯非拉丁/符号名）无法判定，跳过
    total++;

    if (isCoveredByCuration(l)) { covered++; return; }

    const year = consensus.extractYear(l.name) || '';
    // consensus.eventFingerprint 做指纹去重（同名同年的重复条目只保留首个；
    // 同名不同年因 year 不同产生不同指纹，不会被误并为同一赛事）
    const fullFp = consensus.eventFingerprint({ name: l.name, year: year });
    const dedupKey = fullFp || (nameKey + '|' + year + '@' + (l.leagueid != null ? l.leagueid : ''));
    if (seenFp[dedupKey]) return;
    seenFp[dedupKey] = true;

    const g = gradeOf(l.name);
    uncovered.push({
      name: l.name,
      tier: g.grade,
      year: year ? Number(year) : null,
      source: 'opendota',
      fingerprint: fullFp,
      suggestedAction: (g.rank != null && g.rank >= 1) ? 'add_to_curation' : 'skip'
    });
  });

  // 按等级排序：rank 降序（SSS > S > A > B > C），同级按 name 升序
  const rankOf = { SSS: 4, S: 3, A: 2, B: 1, C: 0 };
  uncovered.sort(function (a, b) {
    const ra = rankOf[a.tier] != null ? rankOf[a.tier] : 0;
    const rb = rankOf[b.tier] != null ? rankOf[b.tier] : 0;
    if (ra !== rb) return rb - ra;
    return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
  });

  // 写入输出（确保 output 目录存在）
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(uncovered, null, 2), 'utf8');

  const uncoveredCount = uncovered.length;
  const addCount = uncovered.filter(function (u) {
    return u.suggestedAction === 'add_to_curation';
  }).length;

  console.log('');
  console.log('[discover] 发现 ' + total + ' 个赛事');
  console.log('[discover] 已覆盖 ' + covered + ' 个');
  console.log('[discover] 未覆盖 ' + uncoveredCount + ' 个');
  console.log('[discover] 建议补全 curation 的 S/A/B 级共 ' + addCount + ' 个');
  console.log('[discover] 输出文件：' + OUTPUT_FILE);
}

main().catch(function (e) {
  // 失败时输出错误信息但退出码 0，不阻断 CI
  console.error('[discover] 失败：' + (e && e.message ? e.message : e));
});
