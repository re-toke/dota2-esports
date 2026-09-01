#!/usr/bin/env node
// scripts/sync/fetch-team-logos.js —— P1-3（2026-09-01）：build-time 队伍 logo 快照生成器
//
// 产出：
//   utils/team-logo-map.json        （数据快照，主包 require 用）
//   utils/team-logo-local-data.js   （JS wrapper，分包 require 稳定——同 upcoming-local-data.js 模式）
//
// 动机（v8.5 复核结论）：赛事详情页 enrichTeamLogos 对每支无 logo 队伍发起
//   api.getTeam / api.findTeamByName 网络查询（客户端 60req/min 配额 + 慢网 RTT），
//   S/A 级赛事 ~16 队 × 轮询反复查是详情页慢的次因。快照把「活跃赛事参赛队 + 高排名队」
//   的 logo_url 固化为 build-time 静态数据，运行时零网络命中；未覆盖队伍仍走原查询链（增量兜底）。
//
// 数据源（全部免费无 key，符合项目硬约束）：
//   ① OpenDota /api/teams          —— 全量队表（含 logo_url，rating 降序），取前 TOP_RATED=400 广覆盖
//   ② curation CURATED_EVENTS      —— 近 ACTIVE_DAYS=60 天内结束/进行中/未开始且带 leagueId 的赛事
//      → OpenDota /leagues/{id}/matches 收集精确参赛 team_id（预选赛/中型赛 tier3 队也能覆盖）
//
// 节流：OpenDota 未鉴权限流 3/s、60/min —— 请求间隔 700ms，联赛数上限 LEAGUE_CAP=25。
//
// 用法：npm run fetch:logos（SOP：与 fetch:upcoming 同批执行，快照随版本发布生效）

'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const OUT_JSON = path.join(ROOT, 'utils', 'team-logo-map.json');
const OUT_JS = path.join(ROOT, 'utils', 'team-logo-local-data.js');

const OD_BASE = 'https://api.opendota.com/api';
const TOP_RATED = 400;        // /api/teams 高排名广覆盖条数
const ACTIVE_DAYS = 60;       // curation 活跃赛事窗口（end >= now - 60d 或未结束）
const LEAGUE_CAP = 25;        // 单次最多爬多少个联赛（防配额耗尽）
const REQ_GAP_MS = 700;       // OpenDota 节流间隔

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function getJson(url) {
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
    req.setTimeout(15000, () => { req.destroy(new Error('timeout ' + url)); });
  });
}

function normName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

(async function main() {
  const curation = require(path.join(ROOT, 'utils', 'curation.js'));
  const nowSec = Math.floor(Date.now() / 1000);
  const activeFrom = nowSec - ACTIVE_DAYS * 86400;

  // ① curation 活跃赛事 league ids（去重 + 黑名单过滤）
  const leagueIds = [];
  const seen = {};
  (curation.CURATED_EVENTS || []).forEach((ev) => {
    const lid = Number(ev && ev.leagueId);
    if (!lid || lid <= 0 || seen[lid]) return;
    if (curation.isExcludedLeagueId(lid)) return;
    // 活跃判定：无 end（长期/未标注）视为活跃；有 end 需在窗口内；有 start 未开始也保留
    const end = ev.end || 0;
    const start = ev.start || 0;
    if (end && end < activeFrom) return;          // 早已结束（如 TI2024）跳过
    if (!end && start && start < activeFrom) return; // 无 end 但 start 久远 → 历史赛事跳过
    seen[lid] = 1;
    leagueIds.push({ id: lid, name: ev.canonical || '' });
  });
  console.log('[fetch:logos] curation 活跃赛事 ' + leagueIds.length + ' 个（上限 ' + LEAGUE_CAP + '）');

  // ② 爬联赛比赛收 team_id（精确覆盖）
  const activeTeamIds = {};
  const matchCount = {};
  let crawled = 0;
  for (const lg of leagueIds.slice(0, LEAGUE_CAP)) {
    try {
      const ms = await getJson(OD_BASE + '/leagues/' + lg.id + '/matches');
      (Array.isArray(ms) ? ms : []).forEach((m) => {
        [m.radiant_team_id, m.dire_team_id].forEach((tid) => {
          const n = Number(tid);
          if (n > 0) {
            activeTeamIds[n] = 1;
            matchCount[n] = (matchCount[n] || 0) + 1;
          }
        });
      });
      crawled++;
      console.log('  league ' + lg.id + ' (' + (lg.name || '?') + '): ' + (Array.isArray(ms) ? ms.length : 0) + ' 场');
    } catch (e) {
      console.warn('  league ' + lg.id + ' 抓取失败（跳过）: ' + (e && e.message));
    }
    await sleep(REQ_GAP_MS);
  }
  console.log('[fetch:logos] 爬取 ' + crawled + ' 个联赛，收集 ' + Object.keys(activeTeamIds).length + ' 个 team_id');

  // ③ /api/teams 全量表（一次请求）
  let teams = [];
  try {
    teams = await getJson(OD_BASE + '/teams');
    console.log('[fetch:logos] /api/teams 返回 ' + teams.length + ' 队');
  } catch (e) {
    console.error('[fetch:logos] /api/teams 失败: ' + (e && e.message));
    process.exit(1);
  }

  // ④ 组装：活跃赛事队（精确，必收）+ rating 前 TOP_RATED（广覆盖）
  //    /api/teams 已按 rating 降序返回 → 顺序遍历中先遇到的非活跃队即高排名队
  // ★ 2026-09-01（v8.5 Fix-G）：写入前 URL 规范化（image.js normalizeLogoUrl 同规则）——
  //   ① http:// → https://（微信强制 https，cloud-3.steamusercontent.com 等 http 必挂）
  //   ② steamcdn-a.akamaihd.net → cdn.cloudflare.steamstatic.com（已白名单，实测 100% 同文件镜像）
  //   ③ steamusercontent-a.akamaihd.net（实测 100% 404 死域）与 cloud-3 剔除 → 不收录
  //   ④ cdn.steamusercontent.com（UGC 主力，URL 有效）原样保留 —— 微信白名单待用户补配
  const imageUtil = require('../../utils/image.js');
  const finalById = {};
  let topCount = 0;
  teams.forEach((t) => {
    if (!t || !t.team_id) return;
    const logo = imageUtil.normalizeLogoUrl(t.logo_url || '');
    if (!logo) return;   // 无有效 logo（含死域剔除）不收录（负缓存语义交给运行时）
    if (activeTeamIds[t.team_id]) {
      finalById[t.team_id] = { name: t.name || '', logo: logo };
    } else if (topCount < TOP_RATED) {
      finalById[t.team_id] = { name: t.name || '', logo: logo };
      topCount++;
    }
  });

  // byName：归一化队名 → logo（同名多 id：活跃队优先，其次 matchCount 多者）
  const byName = {};
  Object.keys(finalById).forEach((tid) => {
    const norm = normName(finalById[tid].name);
    if (!norm) return;
    const cur = byName[norm];
    const score = (activeTeamIds[tid] ? 1000 : 0) + (matchCount[tid] || 0);
    const curScore = cur ? cur._score : -1;
    if (!cur || score > curScore) {
      byName[norm] = { logo: finalById[tid].logo, _score: score };
    }
  });
  Object.keys(byName).forEach((k) => { delete byName[k]._score; });

  const out = {
    generatedAt: nowSec,
    source: 'opendota',
    note: 'build-time team logo snapshot (active leagues + top rated), refresh via scripts/sync/fetch-team-logos.js',
    stats: {
      leaguesCrawled: crawled,
      activeTeamIds: Object.keys(activeTeamIds).length,
      byIdCount: Object.keys(finalById).length,
      byNameCount: Object.keys(byName).length
    },
    byId: finalById,
    byName: byName
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));
  // JS wrapper（分包 require 主包 JSON 有兼容性问题 —— 同 upcoming-local-data.js 模式）
  const jsOut = '// utils/team-logo-local-data.js\n' +
    '// team-logo-map.json 的 JS 包装模块（由 scripts/sync/fetch-team-logos.js 自动生成，请勿手动修改）\n' +
    '//\n' +
    '// 背景：微信小程序分包直接 require 主包 JSON 存在兼容性问题（返回 null），\n' +
    '//   改为 JS 模块导出，在主包/分包中 require 均稳定可靠（同 upcoming-local-data.js 模式）。\n' +
    '// 运行时用法：league-detail _doEnrichTeamLogos 快照命中 → 零网络；未命中走原查询链。\n' +
    '// 刷新：npm run fetch:logos\n\n' +
    'module.exports = ' + JSON.stringify(out, null, 2) + ';\n';
  fs.writeFileSync(OUT_JS, jsOut);

  const kb = (fs.statSync(OUT_JSON).size / 1024).toFixed(1);
  console.log('[fetch:logos] 完成：byId ' + out.stats.byIdCount + ' / byName ' + out.stats.byNameCount +
    '（活跃 ' + out.stats.activeTeamIds + ' 队）→ ' + path.basename(OUT_JSON) + ' (' + kb + 'KB) + JS wrapper');
})().catch((e) => {
  console.error('[fetch:logos] FATAL:', e);
  process.exit(1);
});
