#!/usr/bin/env node
// ============================================================
// scripts/ops/probe-ef.js
// Supabase Edge Functions 健康探测 + 告警（2026-09-12）
//
// ## 为什么需要
// 「接受 EF 单点」的前提是**故障能被及时发现**。此前 EF 挂了只有小程序端使用者
// 才知道（Console 里的回落日志）。本脚本由 GH Actions 定时独立探测，
// 失败 → job 失败 → GitHub 自动发失败通知邮件（零成本告警通道）。
//
// ## 判定口径（重要：避免误报）
// 「EF 活着」= **有任何 HTTP 响应**（含 400/401）—— 只证明函数被调度起来了。
// 只有以下情况才算故障：
//   · 网络错误 / 超时
//   · HTTP 5xx（函数内部崩溃）
//   · 延迟超过阈值（默认 8000ms，冷启动通常 3s 内）
//
// ## 用法
//   node scripts/ops/probe-ef.js              # 探测并打印
//   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node scripts/ops/probe-ef.js
//     → 额外把结果写入 aggregation_cache 的 ops:ef_health（留历史）
//   退出码：0 全健康；1 有故障（供 CI 判失败）
// ============================================================
'use strict';

const https = require('https');

const CFG = require('./../../utils/config.js');
const SUPABASE_URL = process.env.SUPABASE_URL || (CFG.supabase && CFG.supabase.url) || '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const ANON_KEY = (CFG.supabase && CFG.supabase.anonKey) || '';
const LAT_THRESHOLD_MS = Number(process.env.PROBE_LAT_MS || 8000);
// 大响应类探针单独放宽超时（/leagues 冷启动可达 20s+，非故障）
const SLOW_OK = { 'opendota-proxy': 30000 };

// 探测清单：{ 名称, action, params, 说明 }
// 关键路径优先（登录是硬依赖）
const PROBES = [
  { name: 'wechat-auth', action: 'login', params: { code: 'probe-invalid-code' }, desc: '登录（硬依赖：拿不到 openid 则关注/提醒/订阅全废）' },
  { name: 'opendota-proxy', action: 'getLeagues', params: {}, desc: '赛事数据主源' },
  { name: 'liquipedia-proxy', action: 'liquipediaFetchRawWikitext', params: { pageName: '__probe__' }, extra: { cacheOnly: true }, desc: 'LP 读表（cacheOnly 探针，不触发现抓；★ 必须传 cacheOnly 否则 EF 会真去抓 LP）' },
  { name: 'follow-profile', action: 'get', params: {}, desc: '关注画像（无 JWT 应返回 401，仍算存活）' },
  { name: 'subscribe-send', action: 'send', params: {}, desc: '订阅消息发送' },
  { name: 'bundle-aggregator', action: 'getLeagueDetailBundle', params: { leagueId: 19944 }, desc: '详情页聚合（用真实联赛 id；空 bundle 的 502 属设计内响应）' },
  { name: 'haglund-proxy', action: 'haglundUpcoming', params: {}, desc: '第三方兜底源' }
];

function probe(name, action, params, extra) {
  return new Promise((resolve) => {
    const body = JSON.stringify(Object.assign({ action: action, params: params || {} }, extra || {}));
    const t0 = Date.now();
    const req = https.request({
      hostname: new URL(SUPABASE_URL).hostname,
      path: '/functions/v1/' + name,
      method: 'POST',
      timeout: SLOW_OK[name] || 20000,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + (ANON_KEY || SERVICE_KEY),
        'Content-Length': Buffer.byteLength(body)
      }
    }, (r) => {
      let d = '';
      r.on('data', (x) => d += x);
      r.on('end', () => resolve({ ok: r.statusCode < 500, status: r.statusCode, ms: Date.now() - t0, body: d.slice(0, 160) }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, ms: Date.now() - t0, err: 'timeout' }); });
    req.on('error', (e) => resolve({ ok: false, status: 0, ms: Date.now() - t0, err: e.message }));
    req.write(body);
    req.end();
  });
}

/** 把探测结果写入 aggregation_cache（ops:ef_health，TTL 7 天） */
function record(payload) {
  if (!SERVICE_KEY) return Promise.resolve(false);
  return new Promise((resolve) => {
    const body = JSON.stringify({
      key: 'ops:ef_health',
      payload: payload,
      expire_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      updated_at: new Date().toISOString()
    });
    const u = new URL(SUPABASE_URL + '/rest/v1/aggregation_cache');
    const req = https.request({
      hostname: u.hostname, path: u.pathname, method: 'POST',
      headers: {
        apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (r) => { r.resume(); r.on('end', () => resolve(r.statusCode < 300)); });
    req.on('error', () => resolve(false));
    req.write(body);
    req.end();
  });
}

(async () => {
  if (!SUPABASE_URL || !ANON_KEY) { console.error('缺少 SUPABASE_URL / anonKey'); process.exit(2); }
  console.log('EF 健康探测 ｜ ' + new Date().toISOString() + ' ｜ 延迟阈值 ' + LAT_THRESHOLD_MS + 'ms');
  console.log('');

  const results = [];
  let bad = 0;
  for (const p of PROBES) {
    const r = await probe(p.name, p.action, p.params, p.extra);
    // ★ 判定口径：超时/网络错/5xx = 失败（计入告警）；仅「慢」= warning（不计入，避免噪音）
    const emptyBundle = r.status === 502 && /empty/i.test(r.body || '');
    const failed = (!r.ok && !emptyBundle) || r.err;
    const slow = !failed && r.ms > LAT_THRESHOLD_MS;
    if (failed) bad++;
    results.push({ name: p.name, ok: !failed, slow: slow, status: r.status, ms: r.ms, err: r.err || null });
    const tag = failed ? '❌ 失败' : (slow ? '🐢 过慢' : '✅');
    console.log('  ' + tag + ' ' + p.name.padEnd(20) + String(r.ms).padStart(6) + 'ms  HTTP ' + String(r.status).padEnd(4) +
      (r.err ? ' ' + r.err : '') + (r.body && !r.ok ? '  ' + r.body.replace(/\s+/g, ' ').slice(0, 80) : ''));
    console.log('       ' + p.desc);
  }

  console.log('');
  console.log(bad === 0
    ? '✅ 全部 ' + PROBES.length + ' 个 EF 健康'
    : '⚠️ ' + bad + ' / ' + PROBES.length + ' 个 EF 异常 —— 这会造成小程序端功能不可用（无兜底）');

  const wrote = await record({ ts: Date.now(), at: new Date().toISOString(), total: PROBES.length, bad: bad, results: results });
  console.log(wrote ? '（结果已写入 aggregation_cache: ops:ef_health）' : '（未写历史：无 SUPABASE_SERVICE_KEY）');

  process.exit(bad === 0 ? 0 : 1);
})();
