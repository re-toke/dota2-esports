#!/usr/bin/env node
/**
 * scripts/ops/diff-team-logos.js
 * 队标差异清单（★ 2026-11-15）
 *
 * ## 目的
 *   我们的队标主源是 OpenDota / Steam CDN（快照见 utils/team-logo-map.json），
 *   Liquipedia 仅在「前三源都没有图」时兜底 ⇒ 两套图本来就可能不同。
 *   本脚本拉取 Liquipedia 队标，与快照并排渲染成一份本地 HTML，供**目视核对**，
 *   用于先量化「到底哪些队不一致」，再决定是否加人工覆盖或调整优先级。
 *
 * ## 覆盖范围
 *   OpenDota 评分榜 Top N（默认 30；经中转 `/od/api/teams` 取数，避免直连 DNS 劫持）。
 *   可用 `--teams=Team Spirit,Team Falcons` 指定名单（跳过网络取数）。
 *
 * ## 成本与限流
 *   每队 2 次 LP 请求（wikitext + imageinfo），请求间隔 2.2s（Liquipedia ToS）。
 *   N=30 约 2.5~3 分钟。
 *
 * ## 产物
 *   scripts/ops/output/team-logo-diff.html（该目录已 gitignore）
 *
 * 用法：node scripts/ops/diff-team-logos.js [--limit=30] [--teams=A,B]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const LiquiParse = require(path.join(ROOT, 'utils', 'liquipedia-parse.js'));
const LP_UA = require(path.join(ROOT, 'utils', 'lp-ua.js')).LP_UA;
const snapshot = require(path.join(ROOT, 'utils', 'team-logo-map.json'));
const names = require(path.join(ROOT, 'utils', 'names.js'));
const config = require(path.join(ROOT, 'utils', 'config.js'));

const PROXY_OD = (config.endpoints.proxy[0] || '') + '/od/api';
const LP_BASE = 'https://liquipedia.net/dota2/api.php';
const RATE_MS = 2200;
const OUT = path.join(__dirname, 'output', 'team-logo-diff.html');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function lpJson(url) {
  const r = await fetch(url, {
    headers: { 'User-Agent': LP_UA, 'Accept-Encoding': 'gzip' },
    signal: AbortSignal.timeout(20000)
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

/** 我们的队标：优先快照 byId（id 精确），再按名归一兜底 */
function ourLogoOfTeam(t) {
  const byId = t.id != null && snapshot.byId && snapshot.byId[t.id];
  if (byId && byId.logo) return byId.logo;
  const hit = snapshot.byName && snapshot.byName[names.normTeamName(t.name)];
  return (hit && hit.logo) || t.logo || '';
}

/** OpenDota 评分榜 Top N（经中转；避免直连 api.opendota.com 的 DNS 劫持）
 *  只保留近 180 天有比赛的队伍（过滤掉已解散/历史队，避免清单全是冷门老队）。 */
async function topTeams(limit) {
  const r = await fetch(PROXY_OD + '/teams', {
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(60000)
  });
  if (!r.ok) throw new Error('OpenDota /teams HTTP ' + r.status);
  const list = await r.json();
  if (!Array.isArray(list)) throw new Error('/teams 返回非数组');
  const cutoff = Math.floor(Date.now() / 1000) - 180 * 86400;
  return list
    .filter((t) => t && t.name && (!t.last_match_time || t.last_match_time >= cutoff))
    .slice(0, limit)
    .map((t) => ({
      id: t.team_id,
      name: t.name || '',
      logo: t.logo_url || '',
      rating: t.rating || 0
    }));
}

/** Liquipedia 队标（wikitext → parseTeamLogo → imageinfo） */
async function lpLogoOf(name) {
  const slug = name.replace(/ /g, '_');
  const u1 = LP_BASE + '?action=query&format=json&redirects=1&prop=revisions&rvprop=content&titles=' +
    encodeURIComponent(slug).replace(/%2F/g, '/');
  const r1 = await lpJson(u1);
  const page1 = Object.values((r1.query && r1.query.pages) || {})[0];
  const wt = page1 && page1.revisions && page1.revisions[0] && page1.revisions[0]['*'];
  if (!wt) throw new Error('页面无内容');
  const parsed = LiquiParse.parseTeamLogo(wt);
  if (!parsed || !parsed.image) throw new Error('未解析到 image 字段');

  await sleep(RATE_MS);
  const u2 = LP_BASE + '?action=query&format=json&redirects=1&prop=imageinfo&iiprop=url&iiurlwidth=160&titles=' +
    encodeURIComponent('File:' + parsed.image);
  const r2 = await lpJson(u2);
  const page2 = Object.values((r2.query && r2.query.pages) || {})[0];
  const info = page2 && page2.imageinfo && page2.imageinfo[0];
  const logo = info && (info.thumburl || info.url);
  if (!logo) throw new Error('imageinfo 无 url');
  return { logo: logo, file: parsed.image, page: 'https://liquipedia.net/dota2/' + slug };
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

(async function main() {
  const arg = process.argv.find((a) => a.startsWith('--limit='));
  const limit = Math.max(1, parseInt(arg ? arg.split('=')[1] : '30', 10) || 30);
  const teamsArg = process.argv.find((a) => a.startsWith('--teams='));
  let teams;
  if (teamsArg) {
    teams = teamsArg.slice('--teams='.length).split(',').map((s) => s.trim()).filter(Boolean)
      .map((n) => ({ id: null, name: n, logo: '', rating: 0 }));
  } else {
    try {
      teams = await topTeams(limit);
    } catch (e) {
      console.error('获取 OpenDota 队伍列表失败：' + ((e && e.message) || e));
      console.error('可改用 --teams="Team Spirit,Team Falcons" 指定名单。');
      process.exit(1);
    }
  }
  console.log('=== 队标差异清单：' + teams.length + ' 支（上限 ' + limit + '）===');

  const rows = [];
  for (const t of teams) {
    const name = t.name;
    const ours = ourLogoOfTeam(t);
    let lpPage = 'https://liquipedia.net/dota2/' + name.replace(/ /g, '_');
    let lp = null;
    let err = '';
    try {
      lp = await lpLogoOf(name);
      if (lp && lp.page) lpPage = lp.page;
    } catch (e) {
      err = (e && e.message) || String(e);
    }
    rows.push({ name: name, ours: ours, lp: lp, err: err, rating: t.rating, lpPage: lpPage });
    console.log((lp ? '✓ ' : '✗ ') + name + (lp ? '' : ' → ' + err));
    await sleep(RATE_MS);
  }

  const okCount = rows.filter((r) => r.lp).length;
  const ourMissing = rows.filter((r) => !r.ours).length;
  const nowStr = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

  const body = rows.map((r, i) => {
    const ours = r.ours
      ? '<img src="' + esc(r.ours) + '" alt="ours">'
      : '<span class="miss">无（快照未覆盖）</span>';
    const lp = r.lp
      ? '<img src="' + esc(r.lp.logo) + '" alt="lp">'
      : '<span class="miss">' + esc(r.err || '未获取') + ' · <a href="' + esc(r.lpPage) +
        '" target="_blank">LP 页面</a></span>';
    return '<tr><td>' + (i + 1) + '</td><td class="nm">' + esc(r.name) + '</td>' +
      '<td>' + ours + '</td><td>' + lp + '</td>' +
      '<td class="url">' + (r.ours ? '<a href="' + esc(r.ours) + '" target="_blank">ours</a>' : '—') +
      ' · <a href="' + esc(r.lpPage) + '" target="_blank">LP 页面</a></td></tr>';
  }).join('\n');

  const html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>队标差异清单</title><style>' +
    'body{background:#14161a;color:#e5e7eb;font:14px/1.5 -apple-system,"Microsoft YaHei",sans-serif;padding:24px}' +
    'h1{font-size:20px;margin:0 0 6px}p.meta{color:#9ca3af;margin:0 0 18px}' +
    'table{border-collapse:collapse;width:100%;max-width:1000px}' +
    'th,td{border-bottom:1px solid #2a2f37;padding:10px 8px;text-align:left;vertical-align:middle}' +
    'th{color:#9ca3af;font-weight:500}.nm{font-weight:600}' +
    'img{max-height:64px;max-width:120px;background:#0b0d10;border-radius:6px;padding:4px}' +
    '.miss{color:#f59e0b}.url a{color:#93c5fd;text-decoration:none}' +
    '</style></head><body>' +
    '<h1>队标差异清单（我们 vs Liquipedia）</h1>' +
    '<p class="meta">生成 ' + esc(nowStr) + ' · 共 ' + rows.length + ' 队（LP 获取成功 ' + okCount +
    '，快照缺图 ' + ourMissing + '）· 左侧=OpenDota/Steam 快照，右侧=Liquipedia</p>' +
    '<table><thead><tr><th>#</th><th>战队</th><th>我们（Steam）</th><th>Liquipedia</th><th>链接</th></tr></thead>' +
    '<tbody>' + body + '</tbody></table></body></html>';

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, html, 'utf8');
  console.log('');
  console.log('=== 完成：LP 成功 ' + okCount + '/' + rows.length + '，快照缺图 ' + ourMissing + ' ===');
  console.log('报告：' + OUT);
})();
