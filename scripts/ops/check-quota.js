/**
 * scripts/ops/check-quota.js
 * P2-16（2026-10-14）：**存储配额监控** —— `aggregation_cache` 行数阈值告警
 *
 * ## 为什么只盯「行数」
 * P2-16 的改法要求监控三类：**存储行数 / EF 调用数 / 中转请求数**。后两者**只在各平台
 * Dashboard 可见**（Supabase / Deno / Netlify 均无脚本化取数接口）⇒ 本脚本只做**可脚本化**的
 * 「存储行数」一项；另两项在方案文档 §P2-16 的配额预算表里标注「以 Dashboard 为准」。
 *
 * ## 判定
 *   · 行数 > `QUOTA_ROWS_MAX`（默认 **5000**）⇒ 打印 `::error::` + **exit 1**
 *     （供 `ops-maintenance.yml` 判失败 → 触发 `notify-alert.js` 二级告警）。
 *   · 缺凭据 ⇒ **跳过（exit 0）**，不制造假失败。
 *
 * ## 凭据（与 cleanup-cache.js / probe-ef.js 同一套）
 *   SUPABASE_URL（**必须直连** `<ref>.supabase.co`）/ SUPABASE_SERVICE_KEY。
 *   ⚠️ 计数需读全表行数 ⇒ 用 service key（anon 亦可读，但 service 口径更稳、且与清理同源）。
 *
 * 用法：node scripts/ops/check-quota.js
 * 退出码：0 = 正常/跳过；1 = 超阈值（配额风险）
 */
'use strict';

const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const ROWS_MAX = Number(process.env.QUOTA_ROWS_MAX || 5000);

/** 从 PostgREST 的 Content-Range 头取总命中数（形如 `0-9/123`；未知总数时为星号） */
function countOf(res) {
  const cr = res.headers.get('content-range') || '';
  const m = /\/(\d+|\*)$/.exec(cr);
  return m && m[1] !== '*' ? Number(m[1]) : null;
}

function headers() {
  return { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, Prefer: 'count=exact' };
}

async function countRows(qs) {
  const res = await fetch(SB_URL + '/rest/v1/aggregation_cache?select=key&limit=1' + (qs || ''), { headers: headers() });
  if (!res.ok) throw new Error('配额计数失败 HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200));
  return countOf(res);
}

async function main() {
  if (!SB_URL || !SB_KEY) {
    console.log('::warning::未配置 SUPABASE_URL / SUPABASE_SERVICE_KEY ⇒ 跳过配额检查（不视为失败）');
    return;
  }
  const nowIso = new Date().toISOString();
  const rows = await countRows('');                                                     // 总行数（含未过期）
  const expired = await countRows('&expire_at=lt.' + encodeURIComponent(nowIso));        // 过期行数（与 cleanup-cache 口径一致）

  const line = '[check-quota] aggregation_cache 总行数=' + (rows ?? '?') +
    '（其中过期 ' + (expired ?? '?') + '）｜ 阈值 ' + ROWS_MAX;

  if (rows != null && rows > ROWS_MAX) {
    console.error('::error::' + line + ' ⇒ **超阈值**：存储配额风险，'
      + '处置见方案文档 §P2-16 降级预案（提高清理频率 / 下调 TTL / 只读快照模式）。');
    process.exitCode = 1;
    return;
  }
  console.log(line + ' ⇒ 正常');
}

main().catch((e) => {
  console.error('[check-quota] ' + (e && e.message ? e.message : e));
  process.exit(1);
});
