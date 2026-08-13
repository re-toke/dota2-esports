#!/usr/bin/env node
/**
 * TI 2026 预选赛晋级队伍辅助校验脚本（方案 D · P2 长期 · 离线人工工具）
 *
 * 用途：人工更新 curation participants 数组时，跑一次辅助核对晋级队伍候选名单。
 *       不集成进运行时，纯离线工具。输出供人工交叉验证的「每赛区晋级候选」。
 *
 * 背景（方案文档 §4.6）：
 *   - TI 预选赛是双败淘汰，每赛区产生 2-3 个晋级名额（胜者组冠军 + 败者组冠军 + 有时第三名）。
 *   - OpenDota 的 matches 端点不保证按赛程顺序，且同赛区多场 BO3 并行——
 *     单取「最后一场」会漏队；48 个 distinct team_id 是「预选赛参与者」而非「主赛事晋级者」。
 *   - 因此本脚本不做自动推导，只输出「候选名单 + 关键系列赛标注」，最终晋级名单由人工判定。
 *
 * 运行方式：node scripts/verify-ti-qualifiers.js [--leagueIds 19890,19891,...] [--output scripts/output/verify-ti-qualifiers.md]
 *   默认 leagueIds = TI 2026 五赛区预选赛（19890 NA / 19891 SA / 19892 EU / 19893 CN / 19894 SEA，2026-08-11 实测）
 *   退出码：始终 0（仅报告，不阻断）
 *
 * 依赖：Node.js 18+ 内置 fetch（无第三方依赖）
 */
'use strict';

const path = require('path');
const fs = require('fs');

const DEFAULT_LEAGUE_IDS = [19890, 19891, 19892, 19893, 19894];
const DEFAULT_OUTPUT = path.join(__dirname, 'output', 'verify-ti-qualifiers.md');
const API = 'https://api.opendota.com/api/explorer?sql=';

// series_type 映射（OpenDota：0=BO1 1=BO3 2=BO5 3=BO2）
const SERIES_TYPE_LABEL = { 0: 'BO1', 1: 'BO3', 2: 'BO5', 3: 'BO2' };

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { leagueIds: DEFAULT_LEAGUE_IDS.slice(), output: DEFAULT_OUTPUT };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--leagueIds') out.leagueIds = String(args[++i]).split(',').map(Number).filter(Boolean);
    else if (args[i] === '--output') out.output = args[++i];
    else if (args[i] === '--help' || args[i] === '-h') { out.help = true; }
  }
  return out;
}

function fmtDate(sec) {
  if (!sec) return '-';
  const d = new Date(sec * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
}

async function query(sql) {
  const res = await fetch(API + encodeURIComponent(sql));
  if (!res.ok) throw new Error('OpenDota explorer HTTP ' + res.status);
  const data = await res.json();
  return (data && data.rows) || [];
}

function fetchMatches(leagueIds) {
  const ids = leagueIds.join(',');
  // 单次 IN 查询（方案文档 C1 修复：避免逐赛区请求触发 OpenDota 频率限制）
  // 队伍名在 matches 表为 NULL，LEFT JOIN teams 表拿 name（radiant_team_id=0 时 JOIN 不到 → NULL，脚本兜底显示 id）
  const sql =
    'SELECT m.leagueid, m.match_id, m.start_time, m.duration, m.radiant_win, ' +
    'm.radiant_team_id, m.dire_team_id, ' +
    'rt.name AS radiant_team_name, dt.name AS dire_team_name, ' +
    'm.radiant_score, m.dire_score, m.series_id, m.series_type ' +
    'FROM matches m ' +
    'LEFT JOIN teams rt ON rt.team_id = m.radiant_team_id ' +
    'LEFT JOIN teams dt ON dt.team_id = m.dire_team_id ' +
    'WHERE m.leagueid IN (' + ids + ') ' +
    'ORDER BY m.leagueid, m.series_id, m.start_time';
  return query(sql);
}

// 按 leagueid + series_id 聚合系列赛，输出每场（BO）胜者
function buildSeriesSummary(matches) {
  const byLeague = {};
  (matches || []).forEach((m) => {
    const lid = m.leagueid;
    if (!byLeague[lid]) byLeague[lid] = { id: lid, series: {} };
    const sid = m.series_id || 0;
    if (!byLeague[lid].series[sid]) {
      byLeague[lid].series[sid] = {
        seriesId: sid,
        seriesType: m.series_type,
        games: [],
        teams: new Set()
      };
    }
    const s = byLeague[lid].series[sid];
    s.games.push(m);
    if (m.radiant_team_id) s.teams.add(m.radiant_team_id);
    if (m.dire_team_id) s.teams.add(m.dire_team_id);
  });
  // 每场系列赛计算：起止时间、队伍、胜者（BO 内胜场多者）
  Object.keys(byLeague).forEach((lid) => {
    const series = byLeague[lid].series;
    Object.keys(series).forEach((sid) => {
      const s = series[sid];
      s.games.sort((a, b) => (a.start_time || 0) - (b.start_time || 0));
      s.start = s.games[0].start_time;
      s.end = s.games[s.games.length - 1].start_time;
      // 胜者统计（radiant_win 是 game 级胜负）
      const score = {};
      s.games.forEach((g) => {
        const winName = g.radiant_win ? g.radiant_team_name : g.dire_team_name;
        const winId = g.radiant_win ? g.radiant_team_id : g.dire_team_id;
        const key = winId || winName || 'unknown';
        if (!score[key]) score[key] = { id: winId, name: winName || '(未知)', wins: 0 };
        score[key].wins++;
      });
      const entries = Object.keys(score).map((k) => score[k]).sort((a, b) => b.wins - a.wins);
      s.standings = entries;
      s.winner = entries.length && entries[0].wins > entries.length - 1 ? entries[0] : null; // 仅当有明确胜者
    });
  });
  return byLeague;
}

// 推断关键系列赛：取每个赛区时间上最后 N 个已完赛系列（含 BO5/胜者组/败者组特征）
function pickKeySeries(seriesList, n) {
  const finished = seriesList.filter((s) => s.winner);
  finished.sort((a, b) => (b.end || 0) - (a.end || 0));
  return finished.slice(0, n);
}

function renderReport(byLeague, leagueNames) {
  const lines = [];
  lines.push('# TI 2026 预选赛晋级队伍辅助校验（verify-ti-qualifiers）');
  lines.push('');
  lines.push('> 生成时间：' + new Date().toISOString());
  lines.push('> ⚠️ 本报告仅提供「候选 + 关键系列赛标注」，**晋级名单以人工判定为准**（双败淘汰赛制推导复杂）。');
  lines.push('');
  const leagueIds = Object.keys(byLeague).map(Number).sort((a, b) => a - b);
  leagueIds.forEach((lid) => {
    const league = byLeague[lid];
    const name = leagueNames[lid] || ('赛区 leagueid=' + lid);
    lines.push('## ' + name + '（leagueid=' + lid + '）');
    const seriesList = Object.keys(league.series).map((k) => league.series[k]);
    const finishedAll = seriesList.filter((s) => s.winner).sort((a, b) => (b.end || 0) - (a.end || 0));
    lines.push('');
    lines.push('- 系列赛总数：' + seriesList.length + '，已完赛（有明确胜者）：' + finishedAll.length);
    lines.push('');
    // 所有系列赛明细
    seriesList.sort((a, b) => (a.start || 0) - (b.start || 0));
    lines.push('### 系列赛明细（按开始时间排序）');
    lines.push('');
    lines.push('| 系列ID | 赛制 | 开始(UTC) | 结束(UTC) | 对阵 | 胜者 |');
    lines.push('|---|---|---|---|---|---|');
    seriesList.forEach((s) => {
      const teams = Array.from(s.teams).map((id) => {
        const found = s.games.find((g) => g.radiant_team_id === id) || s.games.find((g) => g.dire_team_id === id);
        return found ? (found.radiant_team_id === id ? found.radiant_team_name : found.dire_team_name) : String(id);
      });
      const vs = teams.join(' vs ') || '(队伍名未知)';
      const winnerName = s.winner ? (s.winner.name || String(s.winner.id)) : '—';
      const bo = SERIES_TYPE_LABEL[s.seriesType] || ('type=' + s.seriesType);
      lines.push('| ' + s.seriesId + ' | ' + bo + ' | ' + fmtDate(s.start) + ' | ' + fmtDate(s.end) + ' | ' + vs + ' | ' + winnerName + ' |');
    });
    lines.push('');
    // 晋级候选（取最后若干完赛系列）
    const key = pickKeySeries(seriesList, 4);
    lines.push('### 晋级候选（时间上最后 ' + key.length + ' 个完赛系列 — 仅供人工参考，按赛制名额核对）');
    lines.push('');
    if (!key.length) {
      lines.push('（无已完赛系列赛，可能预选赛尚未结束或数据未入库）');
    } else {
      key.forEach((s, idx) => {
        const winnerName = s.winner ? (s.winner.name || String(s.winner.id)) : '—';
        lines.push((idx + 1) + '. **' + winnerName + '**（系列 ' + s.seriesId + '，' + (SERIES_TYPE_LABEL[s.seriesType] || '未知赛制') + '，结束于 ' + fmtDate(s.end) + '）');
      });
    }
    lines.push('');
  });
  lines.push('---');
  lines.push('');
  lines.push('## 使用方法');
  lines.push('1. 更新 `utils/curation.js` 中 TI 2026 条目的 `participants` 数组前，先跑本脚本核对候选');
  lines.push('2. 候选名单 + Valve 官方公告 / Liquipedia 云函数代理（≥2 独立源）交叉验证后人工确认');
  lines.push('3. 晋级队伍应为「主赛事参赛队」而非「预选赛参与者」——48 个 distinct team_id 含被淘汰队伍，勿直接采用');
  return lines.join('\n');
}

async function main() {
  const opt = parseArgs();
  if (opt.help) {
    console.log('用法：node scripts/verify-ti-qualifiers.js [--leagueIds 19890,...] [--output <file.md>]');
    return;
  }
  process.stderr.write('[1/3] 查询 OpenDota matches（leagueid IN (' + opt.leagueIds.join(',') + ')，单次 IN 查询）...\n');
  const matches = await fetchMatches(opt.leagueIds);
  process.stderr.write('[2/3] 聚合系列赛... 共 ' + matches.length + ' 场比赛\n');
  const byLeague = buildSeriesSummary(matches);

  // 联赛名（辅助展示）
  const leagueNames = {};
  try {
    const sql = 'SELECT leagueid, name FROM leagues WHERE leagueid IN (' + opt.leagueIds.join(',') + ')';
    const rows = await query(sql);
    rows.forEach((r) => { leagueNames[r.leagueid] = r.name; });
  } catch (e) { /* 名字查询失败不影响主流程 */ }

  process.stderr.write('[3/3] 生成报告...\n');
  const md = renderReport(byLeague, leagueNames);
  fs.mkdirSync(path.dirname(opt.output), { recursive: true });
  fs.writeFileSync(opt.output, md, 'utf8');
  process.stdout.write('✅ 报告已写入 ' + opt.output + '\n');
}

main().catch((e) => {
  console.error('❌ 脚本执行失败：', e && e.message ? e.message : e);
  process.exit(1);
});
