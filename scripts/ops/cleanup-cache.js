/**
 * scripts/ops/cleanup-cache.js
 * P1-13（2026-10-12）：`aggregation_cache` **过期行清理** —— GH Action 定时 SQL 路线
 *
 * ## 为什么走这里，而不是 pg_cron
 * `supabase/migrations/005-pg-cron-backup-trigger.sql` 头注定性：pg_cron 的 `net.http_post` 是
 * **fire-and-forget**（5xx 不重试、非 2xx 不告警）⇒ **不是更可靠的调度器**；且「把管道逻辑搬进
 * EF 由 pg_cron 直调」这条路线项目**已明确否决**（`b5d228f` Revert + `bfe7c7f`）。
 * ⇒ 本条**严格限缩**为「定时执行一条清理 SQL」，**不触碰任何管道迁移**。
 *
 * ## 凭据（GitHub Secrets，与 probe-ef.js / diag-report.js 同一套）
 *   SUPABASE_URL + SUPABASE_SERVICE_KEY。
 *   ⚠️ **必须 service key**：`002-fix-anon-read-cache.sql` 后 anon 只读 ⇒ DELETE 需绕过 RLS
 *      （匿名 key 会静默 0 行删除 —— 那才是最难查的失败形态）。
 *   ⚠️ **SUPABASE_URL 必须是直连** `<ref>.supabase.co`：`utils/config.js` 的 `supabase.url`
 *      已改为**中转域名**，而中转的 `/sb/rest/v1/*` 只放行 GET ⇒ 用它会 405。
 *
 * 用法：node scripts/ops/cleanup-cache.js [--dry-run]
 * 退出码：0 = 成功 / 缺少凭据时跳过；1 = 清理失败
 */
'use strict';

const DRY = process.argv.slice(2).includes('--dry-run');

const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';

function headers(extra) {
  return Object.assign({
    apikey: SB_KEY,
    Authorization: 'Bearer ' + SB_KEY,
    'Content-Type': 'application/json',
  }, extra || {});
}

/** 从 PostgREST 的 Content-Range 头取总命中数（形如 `0-9/123`；未知总数时为星号） */
function countOf(res) {
  const cr = res.headers.get('content-range') || '';
  const m = /\/(\d+|\*)$/.exec(cr);
  return m && m[1] !== '*' ? Number(m[1]) : null;
}

async function main() {
  if (!SB_URL || !SB_KEY) {
    console.log('::warning::未配置 SUPABASE_URL / SUPABASE_SERVICE_KEY ⇒ 跳过缓存清理（不视为失败）');
    return;
  }
  if (/deno\.net|netlify|vercel|render\.com/.test(SB_URL)) {
    throw new Error('SUPABASE_URL 看起来是**中转**域名；清理需直连 <ref>.supabase.co（中转 /sb/rest/v1 只允许 GET）');
  }

  const nowIso = new Date().toISOString();
  const filter = 'expire_at=lt.' + encodeURIComponent(nowIso);

  if (DRY) {
    const res = await fetch(SB_URL + '/rest/v1/aggregation_cache?' + filter + '&select=key&limit=1', {
      headers: headers({ Prefer: 'count=exact' }),
    });
    if (!res.ok) throw new Error('dry-run 计数失败 HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200));
    console.log('[cleanup-cache] dry-run：过期行 ' + (countOf(res) ?? '?') + ' 条（expire_at < ' + nowIso + '）');
    return;
  }

  const res = await fetch(SB_URL + '/rest/v1/aggregation_cache?' + filter, {
    method: 'DELETE',
    headers: headers({ Prefer: 'return=minimal, count=exact' }),
  });
  if (!res.ok) throw new Error('清理失败 HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200));
  console.log('[cleanup-cache] 已删除过期行 ' + (countOf(res) ?? '?') + ' 条（expire_at < ' + nowIso + '）');
}

main().catch((e) => {
  console.error('[cleanup-cache] ' + (e && e.message ? e.message : e));
  process.exit(1);
});
