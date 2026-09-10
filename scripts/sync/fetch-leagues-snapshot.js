#!/usr/bin/env node
// scripts/sync/fetch-leagues-snapshot.js —— P2-2（2026-09-01）：列表页 build-time 快照生成器
//
// 产出：
//   utils/leagues-local.json        （数据快照，仓库留档；packOptions ignore 不进包）
//   utils/leagues-local-data.js     （JS wrapper，分包/主包 require 稳定 —— 同 upcoming-local-data.js 模式）
//
// 动机（v8.5 复核修正版）：列表页 loadLeagues 首次进入（无本地缓存）且云函数冷启动 +
//   直连 OpenDota 慢（国内跨网 12s 超时）时，用户面对长时间骨架屏甚至「加载失败」。
//   build-time 快照让 onLoad 先渲染裁剪后的联赛列表（标注「数据截至」），网络数据到达后
//   全量替换。快照是纯视觉层快路径 —— 不占 storage 配额（复核否决 storage 方案：
//   同步 IO jank + 6MB LRU 配额挤占）。
//
// 数据源（免费无 key，符合项目硬约束）：
//   ① OpenDota /api/leagues                     —— 全量联赛元数据（leagueid/tier/name，实测 1 万+ 条）
//   ② OpenDota /explorer + LEAGUE_WINDOWS_SQL   —— 近 6 个月各联赛比赛窗口（与客户端
//      api.getLeagueWindows / 云函数 handleTimer 使用完全相同的 SQL，utils/sqlFragments.js 权威源）
//   ③ curation CURATED_EVENTS                   —— 活跃策展赛事（60 天窗口，含未开赛 leagueId pin 赛事）
//
// 裁剪（防主包体积膨胀）：仅保留
//   - tier ∈ {premium, professional} 且近 90 天有比赛活动（windows 命中）
//   - 或 curation 60 天活跃赛事（leagueId > 0）
//   裁剪后预计 100-300 条（~20KB），历史/无活动联赛不进快照（网络数据到达后自然补全）。
//
// 用法：npm run fetch:leagues（SOP：与 fetch:upcoming 同批执行，快照随版本发布生效）

'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const OUT_JSON = path.join(ROOT, 'utils', 'leagues-local.json');
const OUT_JS = path.join(ROOT, 'utils', 'leagues-local-data.js');

const OD_BASE = 'https://api.opendota.com/api';
const ACTIVE_DAYS = 90;       // windows 活动窗口（快照收录范围）
const CURATED_DAYS = 60;      // curation 活跃窗口（与 fetch-team-logos.js 同口径）

function getJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'Accept': 'application/json' } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error('HTTP ' + res.statusCode + ' ' + url));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs || 15000, () => { req.destroy(new Error('timeout ' + url)); });
  });
}

// 与客户端 api.js transformLeagueWindows 完全一致的形状（leagues.js normalizeLite 直接消费）
function transformWindows(data) {
  const rows = (data && data.rows) || [];
  const map = {};
  rows.forEach((r) => {
    if (r && r.leagueid != null) {
      map[r.leagueid] = {
        earliest: Number(r.earliest) || 0,
        latest: Number(r.latest) || 0,
        lastEnd: Number(r.last_end) || 0,
        count: Number(r.n) || 0
      };
    }
  });
  return map;
}

(async function main() {
  const sqlFragments = require(path.join(ROOT, 'utils', 'sqlFragments.js'));
  const curation = require(path.join(ROOT, 'utils', 'curation.js'));
  const nowSec = Math.floor(Date.now() / 1000);

  // ① /api/leagues 全量
  const leagues = await getJson(OD_BASE + '/leagues');
  console.log('[fetch:leagues] /api/leagues 返回 ' + leagues.length + ' 条');

  // ② explorer windows（与客户端/云函数同款 SQL，权威源 utils/sqlFragments.js）
  //   explorer 全表 group-by 较重（实测本地直连 >15s）→ 45s 超时 + 一次重试
  const winUrl = OD_BASE + '/explorer?sql=' + encodeURIComponent(sqlFragments.LEAGUE_WINDOWS_SQL());
  let winData = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try { winData = await getJson(winUrl, 45000); break; }
    catch (e) { console.warn('[fetch:leagues] explorer 第 ' + attempt + ' 次失败: ' + (e && e.message)); }
  }
  if (!winData) {
    console.error('[fetch:leagues] explorer windows 两次均失败（SQL: ' + sqlFragments.LEAGUE_WINDOWS_SQL().slice(0, 60) + '…）');
    process.exit(1);
  }
  const windows = transformWindows(winData);
  console.log('[fetch:leagues] explorer windows 覆盖 ' + Object.keys(windows).length + ' 个联赛（近 6 个月）');

  // ③ curation 活跃 league ids（60 天窗口，含未开赛 pin 赛事）
  const curatedActive = {};
  const curatedFrom = nowSec - CURATED_DAYS * 86400;
  (curation.CURATED_EVENTS || []).forEach((ev) => {
    const lid = Number(ev && ev.leagueId);
    if (!lid || lid <= 0 || curation.isExcludedLeagueId(lid)) return;
    const end = ev.end || 0;
    const start = ev.start || 0;
    if (end && end < curatedFrom) return;
    if (!end && start && start < curatedFrom) return;
    curatedActive[lid] = 1;
  });

  // ④ 裁剪组装
  const activeFrom = nowSec - ACTIVE_DAYS * 86400;
  const kept = [];
  const snapWindows = {};
  leagues.forEach((l) => {
    if (!l || !l.leagueid) return;
    const lid = Number(l.leagueid);
    if (curation.isExcludedLeagueId(lid)) return;
    const w = windows[lid];
    const isCurated = !!curatedActive[lid];
    // 活动判定：近 90 天内有比赛结束，或有开赛记录（lastEnd 未知时用 latest 近似）
    const active = !!(w && ((w.lastEnd && w.lastEnd >= activeFrom) ||
                            (!w.lastEnd && w.latest && w.latest >= activeFrom)));
    const tierOk = l.tier === 'premium' || l.tier === 'professional';
    if (!((tierOk && active) || isCurated)) return;
    kept.push({ leagueid: lid, tier: l.tier || '', name: l.name || '' });
    if (w) snapWindows[lid] = w;
  });
  // curation 活跃但不在 /api/leagues 返回中的联赛（OpenDota 元数据滞后）→ 补一条最小记录
  Object.keys(curatedActive).forEach((lid) => {
    const n = Number(lid);
    if (!kept.some((k) => k.leagueid === n)) {
      const ev = (curation.CURATED_EVENTS || []).find((e) => Number(e.leagueId) === n);
      kept.push({ leagueid: n, tier: 'premium', name: (ev && ev.canonical) || ('赛事 ' + n) });
    }
  });

  const out = {
    generatedAt: nowSec,
    source: 'opendota',
    note: 'build-time leagues snapshot (active 90d + curated 60d), refresh via scripts/sync/fetch-leagues-snapshot.js',
    stats: { total: leagues.length, kept: kept.length, windows: Object.keys(snapWindows).length },
    leagues: kept,
    windows: snapWindows
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));
  // JS wrapper（分包 require 主包 JSON 有兼容性问题 —— 同 upcoming-local-data.js 模式）
  const jsOut = '// utils/leagues-local-data.js\n' +
    '// leagues-local.json 的 JS 包装模块（由 scripts/sync/fetch-leagues-snapshot.js 自动生成，请勿手动修改）\n' +
    '//\n' +
    '// 背景：微信小程序分包直接 require 主包 JSON 存在兼容性问题（返回 null），\n' +
    '//   改为 JS 模块导出，在主包/分包中 require 均稳定可靠（同 upcoming-local-data.js 模式）。\n' +
    '// 用途：列表页 loadLeagues 快照秒开（P2-2）—— 网络数据到达后全量替换。\n' +
    '// 刷新：npm run fetch:leagues\n\n' +
    'module.exports = ' + JSON.stringify(out, null, 2) + ';\n';
  fs.writeFileSync(OUT_JS, jsOut);

  const kb = (fs.statSync(OUT_JS).size / 1024).toFixed(1);
  console.log('[fetch:leagues] 完成：收录 ' + kept.length + ' 个联赛 / ' + Object.keys(snapWindows).length +
    ' 个窗口（全量 ' + leagues.length + '）→ ' + path.basename(OUT_JS) + ' (' + kb + 'KB) + JSON 留档');
})().catch((e) => {
  console.error('[fetch:leagues] FATAL:', e);
  process.exit(1);
});
