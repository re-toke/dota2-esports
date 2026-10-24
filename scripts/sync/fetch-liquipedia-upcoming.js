#!/usr/bin/env node
/**
 * 抓 Liquipedia「即将到来」赛事 → 写 Supabase `upcoming_schedule`（**不再生成包内快照**）
 *
 * 用途：客户端「即将到来」改为纯联网获取后，`upcoming_schedule` 表是**权威远程源**。
 *       ★ 2026-10-24：原先同时生成包内赛程快照（JSON + JS 包装）作为本地兜底，
 *       该内置快照已按用户决策移除；本脚本只保留「抓 LP → 写表」这一段。
 *
 * 为什么必须走脚本而非小程序前端直连：
 *   - Liquipedia API 强制要求描述性 User-Agent，否则 403；
 *   - 微信 wx.request 的 User-Agent 被平台强制覆盖，无法设置；
 *   - 所以只能在「能自由设 UA 的 Node 环境」抓取，再由 CI 写入 Supabase。
 *
 * 运行：node scripts/sync/fetch-liquipedia-upcoming.js
 * 依赖：仅 Node 内置 https + zlib（无需 npm install）
 */

const https = require('https');
const zlib = require('zlib');
const path = require('path');
// ★ 2026-09-20：赛事名「形状归一」单一实现（原为内联；全仓库 19 处收敛中）
const names = require('../../utils/names.js');

// 合规 UA（Liquipedia 要求带联系方式/项目说明，否则可能被限流或封禁）
const UA = require('../../utils/lp-ua.js').LP_UA;   // ★ 单点：utils/lp-ua.js（LP ToS）
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
  // ★★ 2026-09-20 修复「结束日在界面晚一天」（系统性，15 条 LP 赛事全部命中）：
  //   本函数产出的是**日期边界**，而展示侧 `util.fmtShort()` 用 `getMonth()/getDate()`
  //   —— **设备本地时区**取日期。若把 end 存成「该日 **UTC** 23:59:59」，在 UTC+8 设备上
  //   换算为次日 07:59 → 结束日被显示成**次日**（实测 LP 原文 "Sep 19–27, 2026" 显示成 9/28）。
  //   故 end 对齐到**北京时间当日最后一秒**（= 该日 UTC 15:59:59），使 UTC+8 设备显示回 LP 原文。
  //   start 仍取「该日 UTC 00:00」不动 —— 换算到 UTC+8 是当天 08:00，不跨日、显示本就正确。
  //   ⚠️ 勿改回「UTC 日末」；若将来改为 UTC 展示口径，须同时改 util.fmtShort 与
  //      scripts/test/test-sources.js 的「LP 日期自洽」守卫，两者必须同步。
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

// ★★ 2026-09-28（A′）：LP「限流/挑战页」的识别 + 退避重试 + **按失败类型分流**。
//
//   线上实例（用户提供 CI 日志）：
//     `FAILED: not json: <!DOCTYPE HTML><title>Rate Limited - Liquipedia</title>…`
//   LP 的 API ToU：**通用 ≤1 req/2s；`action=parse` ≤1 req/30s**；超限会触发
//   「automated **temporary IP bans**（可过 CAPTCHA 自解，**反复触发可能转永久**）」。
//   ★ 我方**合规**：本脚本每次只发 **1** 个 parse 请求、2 次/天；兄弟脚本 `sync-liquipedia-cache.js`
//     亦有 `RATE_LIMIT_MS=2200` 节流 ⇒ **不是自己请求过快**。
//   ★ 真因：**GitHub 托管 runner 的 IP 是共用池**，被他人对 LP 的滥用/风控波及 ⇒ 外部、瞬时可自愈。
//
//   ★★ 处置原则 = **按失败类型分流**（原实现把三类性质完全不同的失败混进同一个 exit(1)）：
//     · **被拦截页（Rate Limited / CAPTCHA）** → 退避重试；**仍被拦 ⇒ 警告 + exit 0**
//       （不写库、保留上次成功写入的旧数据）。理由：被拦时**不产生错误数据**，只是"不更新"；"不更新"由
//       **心跳不前进**（客户端「我的」页可见）+ 鲜度守卫体现 ⇒ 不必再用"失败邮件"重复告知，
//       否则就是**告警疲劳**（本项目已多次踩：快照年龄判定 ⇒ 永久红灯 ⇒ 疲劳）。
//     · **上游 0 条** → 仍 **exit(1)**（见下方 EMPTY-UPSTREAM GUARD：可能解析失效/结构变化，必须人看）。
//     · **写库失败 / 无法识别的响应** → 仍 **exit(1)**（我方或下游故障）。
//   ★ 为什么**不是**"无脑重试"：唯一数据点（09:27Z 被限 → 09:44Z 恢复）⇒ 被拦窗口 ∈ (0, 17min)，
//     **若 >60s 则 30s/60s 重试会全败** ⇒ 重试只降概率，**不解决"发失败邮件"这个真痛点**。
//   ★ 为什么**无法从根上规避**（均已实测否定，勿再试）：
//     `action=parse` 绕不开 —— Portal 页 wikitext 仅 2.2KB，赛事行由 `{{TournamentsList}}` **服务端展开**；
//     LP **已禁用** `action=ask`（`Unrecognized value for parameter "action": ask`）；
//     改走 `Tier N Tournaments/<年>` 分档页要 **3~4 个** parse（同为最严端点）⇒ 更差。
const RATE_LIMITED_RE = /Rate\s*Limited/i;
// 只把「被拦截」特征页当可降级对象：LP ToU 明写两种 —— Rate Limited 页 + CAPTCHA 解封 ⇒ 证据只取这两种。
// 其它 HTML（如代理 502 页）**不**降级 ⇒ 仍走 exit(1)，避免把未知故障静默掉。
const BLOCK_PAGE_RE = /Rate\s*Limited|CAPTCHA/i;
const LP_RETRY_DELAYS_MS = [30 * 1000, 60 * 1000];   // 2 次重试：+30s、+60s（共约 90s）

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

class LpRateLimitedError extends Error {
  constructor(message, status) {
    super(message); this.name = 'LpRateLimitedError'; this.status = status;
  }
}

// 纯函数（可离线单测）：只依赖入参判断 LP 响应属于哪一类
function classifyLpBody(status, body) {
  const str = String(body == null ? '' : body);
  const t = str.trim();
  if (t.startsWith('{')) return { kind: 'json', status: status };
  if (BLOCK_PAGE_RE.test(str)) return { kind: 'blocked', status: status };
  if (/^<!DOCTYPE|<html[\s>]/i.test(t)) return { kind: 'html', status: status };
  return { kind: 'unknown', status: status };
}

// 单次请求：**只负责取回原始正文 + 状态码**（不在解析处顺手 reject —— 交给上层分类）
function fetchParseOnce() {
  return new Promise((resolve, reject) => {
    const req = https.get(API, { headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Accept-Encoding': 'gzip' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let str = '';
        try {
          str = res.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8');
        } catch (e) { return reject(new Error('gzip 解压失败: ' + e.message)); }
        resolve({ status: res.statusCode, body: str });
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// 分类 + **仅对「被拦截」退避重试**。delays/fetchOnce/sleepFn 可注入 ⇒ 可离线单测（不发网络、不真等）
async function fetchParseWithRetry(opts) {
  const o = opts || {};
  const delays = o.delays || LP_RETRY_DELAYS_MS;
  const once = o.fetchOnce || fetchParseOnce;
  const wait = o.sleepFn || sleep;
  for (let attempt = 0; ; attempt++) {
    const r = await once();
    const cls = classifyLpBody(r.status, r.body);
    if (cls.kind === 'json') return JSON.parse(r.body).parse.text['*'];
    if (cls.kind === 'blocked' && attempt < delays.length) {
      console.warn('[upcoming] ⏸ LP 被拦（HTTP ' + r.status + '），' + (delays[attempt] / 1000)
        + 's 后重试（第 ' + (attempt + 1) + '/' + delays.length + ' 次）…');
      await wait(delays[attempt]);
      continue;
    }
    if (cls.kind === 'blocked') {
      const which = RATE_LIMITED_RE.test(r.body) ? 'Rate Limited' : 'CAPTCHA/挑战页';
      throw new LpRateLimitedError('LP 拦截未解除（' + which + '，HTTP ' + r.status
        + '，已重试 ' + delays.length + ' 次）', r.status);
    }
    if (cls.kind === 'html') {
      throw new Error('LP 返回 HTML（非 JSON、且非限流页，HTTP ' + r.status + '）: ' + r.body.slice(0, 120));
    }
    throw new Error('LP 响应无法识别（HTTP ' + r.status + '）: ' + r.body.slice(0, 120));
  }
}

async function main() {
  let html;
  try {
    html = await fetchParseWithRetry();
  } catch (e) {
    if (e && e.name === 'LpRateLimitedError') {
      // ★★ A′ 分流：外部拦截 ⇒ 降级为**警告 + exit 0**（不写库、保留旧数据）。
      //   依据见文件上方长注释：被拦时不产生错误数据（只是"不更新"），而"不更新"已由
      //   心跳不前进（客户端可见）+ 鲜度守卫体现 ⇒ 无需再用"失败邮件"重复告知。
      console.warn('[upcoming] ⚠ 本次跳过（不写库）：' + e.message);
      console.warn('[upcoming]   这是 LP 侧的外部拦截（GitHub 共用 runner IP 被波及），非我方故障；');
      console.warn('[upcoming]   Supabase upcoming_schedule 保持上次成功内容 ⇒「不更新」由心跳 + 鲜度守卫体现，故不判失败（避免告警疲劳）。');
      return;
    }
    throw e;   // 其它错误（超时/解压失败/非限流的 HTML）仍按失败处理
  }

  // ★ 2026-08-31 P1：双段抓取（Upcoming + Ongoing），对齐云函数 fetchLiquipediaUpcoming 行为。
  //   此前只读 Upcoming 段：Liquipedia 把开赛赛事移入 Ongoing 段后会漏采进行中赛事。
  //   抓取顺序 Upcoming 在前：先把完整赛期记入内存，供 Ongoing 段同名条目（日期常被截断为
  //   仅开始日）回填。同名 hashId 去重，两段重叠不重复输出。
  //   ★ tier 过滤同步放宽：1/2 → 1/2/3（tier3=B级，如 EPL Masters II、ExitLag ChampZ。
  //   此前 tier3 全被滤掉，是 EPL Masters II 从「即将到来/进行中」消失的第二根因）。
  const nowSec = Math.floor(Date.now() / 1000);
  const out = [];
  const seen = {};               // hashId -> true（Upcoming/Ongoing 同名去重）
  const fullDateMem = {};        // hashId -> {start,end}（Upcoming 完整赛期，供 Ongoing 回填）

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
        // Ongoing 段日期单元格可能仅显示开始日（end==start 截断）→ 用 Upcoming 段内存回填
        const full = fullDateMem[id];
        if (full && full.end > full.start) { dr.start = full.start; dr.end = full.end; }
      }
      if (dr.end < nowSec) continue; // 已结束不进本次结果（回填后 end 为真实结束日）
      if (seen[id]) return;          // 同名去重（Ongoing 与 Upcoming 重叠）
      seen[id] = true;
      const g = gradeOf(liqTier);
      out.push({ id: id, name, grade: g.grade, rank: g.rank, label: g.label, tier: liqTier, start: dr.start, end: dr.end, date: dm[1].trim(), source: 'liquipedia' });
    }
  });
  out.sort((a, b) => a.start - b.start);
  // ★ 2026-10-24：不再生成包内赛程快照（JSON / JS 包装，内置快照已移除）；
  //   抓取结果仅用于下方 Supabase `upcoming_schedule` 写入。

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
  // ★★ 2026-09-25: EMPTY-UPSTREAM GUARD (fixes recurring CI failure).
  //   Root cause of "Sync Upcoming Schedule / All jobs have failed":
  //   when the LP fetch yields 0 events, the previous code still attempted:
  //     (a) upsert with body=[]            -> meaningless write
  //     (b) DELETE ...?league_id=not.in.() -> MALFORMED PostgREST query (400)
  //   -> threw -> process.exit(1) -> CI red. The exit(1) guard was doing its job,
  //      but the message could not tell "upstream empty" from "write failed".
  //   Now: never touch the DB on an empty upstream; fail with a precise message.
  //   (mirrors the EF-side upsertUpcoming, which already returns 400 on empty entries)
  if (!out.length) {
    console.error('[upcoming] ✗ 上游返回 0 条赛事 —— LP 可能限流/被拦，或抓取逻辑失效；'
      + '本次**不写库**（避免空列表 DELETE 误伤整表）');
    if (process.env.SUPABASE_SERVICE_KEY || process.env.ADMIN_TOKEN) {
      process.exit(1);   // 有凭据却拿不到上游 ⇒ 明确失败（避免云端表静默陈旧）
    }
  }

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
    // ★ 2026-09-25: 空 ids 时 not.in.() 是畸形查询（会被 PostgREST 400）⇒ 直接跳过清理 ✓
    if (!ids.length) return;
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
    console.log('（未设 SUPABASE_SERVICE_KEY / ADMIN_TOKEN → 跳过 Supabase 同步；本次仅打印抓取结果）');
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

  // ★ 2026-07-30 后置检查：扫描本次抓取结果中未纳入 curation 的赛事
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
    //   动机：curation 是**人工录入**（权威但易错），本次抓取是**脚本自动刷新**。
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

// ★ 2026-09-28：只在**被直接执行**时跑主流程 —— 被 require 时仅导出可测单元（不触发网络/写产物）。
if (require.main === module) {
  main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
}

// 供 scripts/test/test-lp-fetch-guard.js 单测（纯函数 + 可注入重试）
module.exports = {
  classifyLpBody: classifyLpBody,
  fetchParseWithRetry: fetchParseWithRetry,
  RATE_LIMITED_RE: RATE_LIMITED_RE,
  BLOCK_PAGE_RE: BLOCK_PAGE_RE,
  LP_RETRY_DELAYS_MS: LP_RETRY_DELAYS_MS,
  LpRateLimitedError: LpRateLimitedError
};
