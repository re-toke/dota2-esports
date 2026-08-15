#!/usr/bin/env node
/**
 * 本地预抓取 Liquipedia 即将到来赛事 → 生成 utils/upcoming-local.json
 *
 * 用途：在不依赖微信云函数 / CloudBase 的前提下，让「即将到来」tab
 *       也能跟随 Liquipedia 实时数据。代价是数据为「运行脚本那一刻」的快照，
 *       需要重新构建/发布小程序时才会更新（适合更新频率不高的个人项目）。
 *
 * 为什么必须走脚本而非小程序前端直连：
 *   - Liquipedia API 强制要求描述性 User-Agent，否则 403；
 *   - 微信 wx.request 的 User-Agent 被平台强制覆盖，无法设置；
 *   - 所以只能在「能自由设 UA 的 Node 环境」抓取，再把结果打包进小程序。
 *
 * 运行：node scripts/fetch-liquipedia-upcoming.js
 * 依赖：仅 Node 内置 https + zlib（无需 npm install）
 */

const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

// 合规 UA（Liquipedia 要求带联系方式/项目说明，否则可能被限流或封禁）
const UA = 'DOTA2-Esports-Hub/1.0 (WeChat Mini Program build-time snapshot; contact: dev@local)';
const API = 'https://liquipedia.net/dota2/api.php?action=parse&page=Portal:Tournaments&prop=text&format=json';

const MONTHS = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };

function parseLiquipediaDate(text) {
  if (!text) return null;
  const s = String(text).replace(/[‒–—―]/g, '-').trim();
  // Mon DD–DD, YYYY / Mon DD, YYYY（en-dash，空格不固定）
  const m = s.match(/^([A-Z][a-z]{2})\s+(\d{1,2})(?:\s*-\s*(?:([A-Z][a-z]{2})\s+)?(\d{1,2}))?,\s*(\d{4})$/);
  if (!m) return null;
  const sm = MONTHS[m[1].toLowerCase()];
  const em = m[3] ? MONTHS[m[3].toLowerCase()] : sm;
  const sd = parseInt(m[2], 10);
  const ed = m[4] ? parseInt(m[4], 10) : sd;
  const year = parseInt(m[5], 10);
  if (sm == null || em == null || isNaN(sd) || isNaN(ed) || isNaN(year)) return null;
  return {
    start: Math.floor(Date.UTC(year, sm, sd, 0, 0, 0) / 1000),
    end: Math.floor(Date.UTC(year, em, ed, 23, 59, 59) / 1000),
  };
}

// 稳定负数 id（与 curation 占位风格一致，避免和真实 leagueid 冲突）
function hashId(name) {
  const k = String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
  let h = 0;
  for (let i = 0; i < k.length; i++) h = ((h << 5) - h + k.charCodeAt(i)) | 0;
  return -(Math.abs(h) % 1000000 + 1000000);
}

function gradeOf(t) {
  if (t <= 1) return { grade: 'S', rank: 3, label: 'S级' };
  if (t === 2) return { grade: 'A', rank: 2, label: 'A级' };
  return { grade: 'B', rank: 1, label: 'B级' };
}

function fetchParse() {
  return new Promise((resolve, reject) => {
    const req = https.get(API, { headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Accept-Encoding': 'gzip' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const str = res.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8');
        if (!str.trim().startsWith('{')) return reject(new Error('not json: ' + str.slice(0, 120)));
        resolve(JSON.parse(str).parse.text['*']);
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function main() {
  const html = await fetchParse();
  const startIdx = html.indexOf('id="Upcoming"');
  const nextHead = html.indexOf('class="mw-headline"', startIdx + 10);
  const section = html.slice(startIdx, nextHead > 0 ? nextHead : html.length);

  const nowSec = Math.floor(Date.now() / 1000);
  const out = [];
  const rowRe = /<tr class="table2&#95;&#95;row--(body|highlighted)">(.*?)<\/tr>/gs;
  let m;
  while ((m = rowRe.exec(section)) !== null) {
    const row = m[2];
    const tm = row.match(/Tier_(\d+)_Tournaments/);
    const liqTier = tm ? parseInt(tm[1], 10) : 0;
    if (liqTier > 2) continue; // 只取 Tier 1/2
    const nm = row.match(/column&#95;&#95;tournament[^>]*><a[^>]*>([^<]+)<\/a>/);
    const name = nm ? nm[1].trim() : null;
    if (!name) continue;
    const dm = row.match(/<td class="" data-nowrap="">([^<]+)<\/td>/);
    const dr = dm ? parseLiquipediaDate(dm[1]) : null;
    if (!dr || dr.end < nowSec) continue; // 过滤已结束
    const g = gradeOf(liqTier);
    out.push({ id: hashId(name), name, grade: g.grade, rank: g.rank, label: g.label, tier: liqTier, start: dr.start, end: dr.end, date: dm[1].trim(), source: 'liquipedia' });
  }
  out.sort((a, b) => a.start - b.start);

  const payload = { generatedAt: Math.floor(Date.now() / 1000), source: 'liquipedia', note: 'build-time snapshot, refresh via scripts/fetch-liquipedia-upcoming.js', events: out };
  const jsonPath = path.join(__dirname, '..', '..', 'utils', 'upcoming-local.json');
  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2), 'utf8');
  console.log('Wrote', out.length, 'upcoming events ->', jsonPath);

  // ★ 2026-07-30 同步生成 JS 包装模块（upcoming-local-data.js）
  //   微信小程序分包对 require JSON 存在兼容性问题，JS 模块在主包/分包中 require 均稳定可靠。
  //   本文件与 upcoming-local.json 内容完全一致，仅格式从 JSON 改为 module.exports。
  //   严禁手动修改本文件，数据源以 upcoming-local.json 为准，由本脚本自动同步。
  const jsPath = path.join(__dirname, '..', '..', 'utils', 'upcoming-local-data.js');
  const jsContent = '// utils/upcoming-local-data.js\n' +
    '// upcoming-local.json 的 JS 包装模块（由 scripts/fetch-liquipedia-upcoming.js 自动生成，请勿手动修改）\n' +
    '//\n' +
    '// 背景：微信小程序分包直接 require 主包 JSON 存在兼容性问题（返回 null），\n' +
    '//   改为 JS 模块导出，在主包/分包中 require 均稳定可靠。\n' +
    '// 数据来源：utils/upcoming-local.json（由本脚本生成）\n\n' +
    'module.exports = ' + JSON.stringify(payload, null, 2) + ';\n';
  fs.writeFileSync(jsPath, jsContent, 'utf8');
  console.log('Synced JS wrapper ->', jsPath);

  out.forEach((e) => console.log(' -', e.name, '(' + e.grade + ')', new Date(e.start * 1000).toISOString().slice(0, 10) + ' ~ ' + new Date(e.end * 1000).toISOString().slice(0, 10)));

  // ★ 2026-07-30 后置检查：扫描 upcoming-local 中未纳入 curation 的赛事
  //   防止"新增赛事赛期截断"问题复发：未纳入 curation 的赛事若被 OpenDota 收录部分比赛，
  //   详情页会优先用 OpenDota 真实窗口（可能只有1天）而非完整赛期。
  //   提示开发者将高频赛事补入 CURATED_EVENTS。
  try {
    const curation = require(path.join(__dirname, '..', '..', 'utils', 'curation.js'));
    const consensus = require(path.join(__dirname, '..', '..', 'utils', 'consensus.js'));
    const uncovered = out.filter((e) => {
      const ev = curation.curatedEventFor(e.name, { game: 'dota2' });
      return !ev;
    });
    if (uncovered.length) {
      console.log('\n⚠️  以下 ' + uncovered.length + ' 个赛事未纳入 curation（详情页赛期可能被截断）：');
      uncovered.forEach((e) => console.log('   -', e.name, '(' + e.grade + ')'));
      console.log('   建议：将上述赛事补入 utils/curation.js 的 CURATED_EVENTS，含 start/end 字段');
    }
  } catch (e) { /* curation 检查失败不影响主流程 */ }
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
