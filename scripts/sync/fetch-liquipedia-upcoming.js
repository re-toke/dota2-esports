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

  // ★ 2026-08-31 P1：双段抓取（Upcoming + Ongoing），对齐云函数 fetchLiquipediaUpcoming 行为。
  //   此前只读 Upcoming 段：Liquipedia 把开赛赛事移入 Ongoing 段后，本地快照漏采进行中赛事
  //   （云函数 2026-07-30 已修复同样的问题，本地脚本一直没跟上）。
  //   抓取顺序 Upcoming 在前：先把完整赛期记入内存，供 Ongoing 段同名条目（日期常被截断为
  //   仅开始日）回填；回填不出时再查旧快照。同名 hashId 去重，两段重叠不重复输出。
  //   ★ tier 过滤同步放宽：1/2 → 1/2/3（tier3=B级，如 EPL Masters II、ExitLag ChampZ。
  //   此前 tier3 全被滤掉，是 EPL Masters II 从「即将到来/进行中」消失的第二根因）。
  const nowSec = Math.floor(Date.now() / 1000);
  const out = [];
  const seen = {};               // hashId -> true（Upcoming/Ongoing 同名去重）
  const fullDateMem = {};        // hashId -> {start,end}（Upcoming 完整赛期，供 Ongoing 回填）
  let prevSnap = null;           // 旧快照（Ongoing 截断日期的兜底回填源）
  try {
    prevSnap = require(path.join(__dirname, '..', '..', 'utils', 'upcoming-local.json'));
  } catch (_e) { /* 首次生成无旧文件，跳过 */ }

  const rowRe = /<tr class="table2&#95;&#95;row--(body|highlighted)">(.*?)<\/tr>/gs;
  const SECTIONS = ['Upcoming', 'Ongoing'];
  SECTIONS.forEach((secId) => {
    const startIdx = html.indexOf('id="' + secId + '"');
    if (startIdx < 0) return; // 该段不存在则跳过
    const nextHead = html.indexOf('class="mw-headline"', startIdx + 10);
    const section = html.slice(startIdx, nextHead > 0 ? nextHead : html.length);
    let m;
    rowRe.lastIndex = 0;
    while ((m = rowRe.exec(section)) !== null) {
      const row = m[2];
      const tm = row.match(/Tier_(\d+)_Tournaments/);
      const liqTier = tm ? parseInt(tm[1], 10) : 0;
      if (liqTier > 3) continue; // ★ P1：只取 Tier 1/2/3（tier3 映射 B级）
      const nm = row.match(/column&#95;&#95;tournament[^>]*><a[^>]*>([^<]+)<\/a>/);
      const name = nm ? nm[1].trim() : null;
      if (!name) continue;
      const dm = row.match(/<td class="" data-nowrap="">([^<]+)<\/td>/);
      const dr = dm ? parseLiquipediaDate(dm[1]) : null;
      if (!dr) continue; // 日期解析失败（非日期单元格）跳过
      const id = hashId(name);
      if (secId === 'Upcoming') {
        // Upcoming 段通常含完整日期范围 → 记入内存，供同赛事 Ongoing 行回填
        if (dr.end > dr.start) fullDateMem[id] = { start: dr.start, end: dr.end };
      } else if (dr.end <= dr.start) {
        // Ongoing 段日期单元格可能仅显示开始日（end==start 截断）→ 回填完整赛期
        let full = fullDateMem[id];
        if ((!full || full.end <= full.start) && prevSnap && prevSnap.events) {
          const dn = name.toLowerCase().replace(/[^a-z0-9]/g, '');
          const hit = prevSnap.events.find((e) => {
            const en = (e.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
            return en && (en === dn || dn.indexOf(en) >= 0 || en.indexOf(dn) >= 0);
          });
          if (hit && hit.end > hit.start) full = { start: hit.start, end: hit.end };
        }
        if (full && full.end > full.start) { dr.start = full.start; dr.end = full.end; }
      }
      if (dr.end < nowSec) continue; // 已结束不进快照（回填后 end 为真实结束日）
      if (seen[id]) return;          // 同名去重（Ongoing 与 Upcoming 重叠）
      seen[id] = true;
      const g = gradeOf(liqTier);
      out.push({ id: id, name, grade: g.grade, rank: g.rank, label: g.label, tier: liqTier, start: dr.start, end: dr.end, date: dm[1].trim(), source: 'liquipedia' });
    }
  });
  out.sort((a, b) => a.start - b.start);

  const payload = { generatedAt: Math.floor(Date.now() / 1000), source: 'liquipedia', note: 'build-time snapshot (Upcoming+Ongoing, Tier1-3), refresh via scripts/sync/fetch-liquipedia-upcoming.js', events: out };
  const jsonPath = path.join(__dirname, '..', '..', 'utils', 'upcoming-local.json');
  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2), 'utf8');
  console.log('Wrote', out.length, 'events (Upcoming+Ongoing) ->', jsonPath);

  // ★ 2026-08-31 P1：镜像 JSON 到云函数目录（fetchLiquipediaUpcoming 的 Ongoing 回填兜底源）。
  //   此前靠手动复制，云侧镜像曾陈旧到 07-25（8 条）而本地已 08-31（6 条）。
  const cloudPath = path.join(__dirname, '..', '..', 'cloudfunctions', 'aggregation', 'upcoming-local.json');
  fs.writeFileSync(cloudPath, JSON.stringify(payload, null, 2), 'utf8');
  console.log('Mirrored ->', cloudPath);

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
