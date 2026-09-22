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
// ★ 2026-09-20：赛事名「形状归一」单一实现（原为内联；全仓库 19 处收敛中）
const names = require('../../utils/names.js');

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
  // ★★ 2026-09-20 修复「结束日在界面晚一天」（系统性，15 条快照赛事全部命中）：
  //   本函数产出的是**日期边界**，而展示侧 `util.fmtShort()` 用 `getMonth()/getDate()`
  //   —— **设备本地时区**取日期。若把 end 存成「该日 **UTC** 23:59:59」，在 UTC+8 设备上
  //   换算为次日 07:59 → 结束日被显示成**次日**（实测 LP 原文 "Sep 19–27, 2026" 显示成 9/28）。
  //   故 end 对齐到**北京时间当日最后一秒**（= 该日 UTC 15:59:59），使 UTC+8 设备显示回 LP 原文。
  //   start 仍取「该日 UTC 00:00」不动 —— 换算到 UTC+8 是当天 08:00，不跨日、显示本就正确。
  //   ⚠️ 勿改回「UTC 日末」；若将来改为 UTC 展示口径，须同时改 util.fmtShort 与
  //      scripts/test/test-sources.js 的「快照数据自洽」守卫，三者必须同步。
  const BJ_OFFSET_SEC = 8 * 3600;   // 与 config.time.bjOffsetSec 一致（北京时间单一来源）
  return {
    start: Math.floor(Date.UTC(year, sm, sd, 0, 0, 0) / 1000),
    end: Math.floor(Date.UTC(year, em, ed, 23, 59, 59) / 1000) - BJ_OFFSET_SEC,
  };
}

// 稳定负数 id（与 curation 占位风格一致，避免和真实 leagueid 冲突）
function hashId(name) {
  const k = names.normAsciiKey(name);   // ★ 2026-09-20：统一走单一实现（⚠️ 改动会使既有 id 变化）
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
          const dn = names.normAsciiKey(name);
          const hit = prevSnap.events.find((e) => {
            const en = names.normAsciiKey(e.name);
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
  // ★ 2026-09-22：原镜像到 cloudfunctions/aggregation/upcoming-local.json —— 随微信云开发退役**已移除**
  //   （保留会在此次同步时把已删除的 cloudfunctions/ 目录重新造出来）

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

  // ★ 2026-09-21：同步写 Supabase `upcoming_schedule`（**微信云开发脱离**前置）
  //   目的：替代云函数 getUpcomingSchedule 的「读云缓存」接口 → 客户端改为 PostgREST 直读本表。
  //
  //   ★ 凭据选择（复核后调整）：**首选 repo 已有的 `SUPABASE_SERVICE_KEY`**（GitHub Secret 已配置，
  //     且 `backfill-curation.js` / `discover-tournaments.js` / `probe-ef.js` 与本脚本的
  //     3 个定时 workflow 都是这套 env）—— **无需新增任何 secret**。
  //     无 service key 时（本地手动跑）回退走 EF `admin-write` 的 `upsertUpcoming` + `ADMIN_TOKEN`。
  //   两者都是「集合语义」：整批 upsert 后删除不在本次集合中的旧行。
  //
  //   ⚠️ 带凭据却写失败 → 必须 exit 1：否则云端表会**静默陈旧**（最危险的失败模式）。
  const SB_URL = process.env.SUPABASE_URL || (require(path.join(__dirname, '..', '..', 'utils', 'config.js')).supabase.url || '');
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
  const adminToken = process.env.ADMIN_TOKEN || '';
  const ids = out.map((e) => Number(e.id)).filter((n) => Number.isFinite(n));

  async function syncByServiceKey() {
    const hdr = { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY, 'Content-Type': 'application/json' };
    const rows = out.map((e) => ({ league_id: Number(e.id), data: e, updated_at: new Date().toISOString() }));
    const up = await fetch(SB_URL + '/rest/v1/upcoming_schedule', {
      method: 'POST',
      headers: Object.assign({ Prefer: 'resolution=merge-duplicates' }, hdr),
      body: JSON.stringify(rows)
    });
    if (!(up.status >= 200 && up.status < 300)) {
      throw new Error('upsert HTTP ' + up.status + ' ' + (await up.text()).slice(0, 200));
    }
    // 清理不在本次集合中的旧行（保持「集合」语义）
    const del = await fetch(SB_URL + '/rest/v1/upcoming_schedule?league_id=not.in.(' + ids.join(',') + ')', {
      method: 'DELETE', headers: hdr
    });
    if (!(del.status >= 200 && del.status < 300)) {
      throw new Error('清理旧行 HTTP ' + del.status + ' ' + (await del.text()).slice(0, 200));
    }
  }

  async function syncByAdminEf() {
    const cfg = require(path.join(__dirname, '..', '..', 'utils', 'config.js'));
    const r = await fetch(cfg.supabase.url + '/functions/v1/admin-write', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: cfg.supabase.anonKey,
        Authorization: 'Bearer ' + cfg.supabase.anonKey,
        'x-admin-token': adminToken
      },
      body: JSON.stringify({ operation: 'upsertUpcoming', params: { entries: out } })
    });
    const body = await r.json().catch(() => null);
    if (!(r.status >= 200 && r.status < 300 && body && body.success)) {
      throw new Error('EF HTTP ' + r.status + ' ' + JSON.stringify((body && body.error) || body).slice(0, 200));
    }
  }

  if (!SERVICE_KEY && !adminToken) {
    console.log('（未设 SUPABASE_SERVICE_KEY / ADMIN_TOKEN → 跳过 Supabase 同步；三件套 JSON 仍是主产物）');
  } else {
    const via = SERVICE_KEY ? 'service-key' : 'admin-write EF';
    try {
      if (SERVICE_KEY) await syncByServiceKey();
      else await syncByAdminEf();
      console.log('Synced Supabase upcoming_schedule ->', out.length, 'rows (via ' + via + ')');
    } catch (e) {
      console.error('✗ Supabase upcoming_schedule 写入失败（via ' + via + '）：' + ((e && e.message) || e));
      console.error('  （表结构需先执行 supabase/migrations/004-upcoming-schedule.sql）');
      process.exit(1);
    }
  }

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

    // ★ 2026-09-20 新增：curation ↔ Liquipedia **日期一致性核对**
    //   动机：curation 是**人工录入**（权威但易错），本快照是**脚本抓取**（每次自动刷新）。
    //   实测教训：PGL Wallachia Season 9 的 curation 起始日被录成 9/17（LP 实为 9/19）→
    //   合并时 curation 优先 → 界面显示错误的开始日（且详情页按此判 ongoing/ended）。
    //   此处每次生成都交叉核对并提示，把「人工数据漂移」变成**可见的构建期信号**。
    //   ⚠️ **只提示不阻断**：curation 允许刻意采用更长窗口（如嘉年华全周期 > 正赛期），
    //      故不做断言/失败退出，由开发者判断。
    const dateMismatch = [];
    out.forEach((e) => {
      let ev = null;
      try { ev = curation.curatedEventFor(e.name, { game: 'dota2' }); } catch (_e) { ev = null; }
      if (!ev || !ev.start || !ev.end) return;
      const bj = (t) => new Date((t + 8 * 3600) * 1000).toISOString().slice(0, 10);
      const lpS = bj(e.start), lpE = bj(e.end), cuS = bj(ev.start), cuE = bj(ev.end);
      if (lpS !== cuS || lpE !== cuE) {
        dateMismatch.push({ name: e.name, cu: cuS + ' ~ ' + cuE, lp: lpS + ' ~ ' + lpE });
      }
    });
    if (dateMismatch.length) {
      console.log('\n⚠️  以下 ' + dateMismatch.length + ' 个赛事的 curation 日期与 Liquipedia 不一致' +
        '（合并时 curation 优先，界面会按 curation 显示）：');
      dateMismatch.forEach((x) => console.log('   -', x.name, ' curation ' + x.cu + '  |  LP ' + x.lp));
      console.log('   建议：核对 utils/curation.js 的 start/end（UTC 秒）。');
      console.log('   仅当确为「刻意的更长窗口」（如嘉年华全周期）时才保留差异。');
    }
  } catch (e) { /* curation 检查失败不影响主流程 */ }
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
