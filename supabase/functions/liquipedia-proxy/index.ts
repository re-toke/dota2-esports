// ============================================================
// supabase/functions/liquipedia-proxy/index.ts
// Liquipedia 薄代理（替代云函数 liquipediaFetchRawWikitext / liquipediaPrewarm）
//
// ★ 架构决策（2026-09-09）：「薄代理」——EF 只负责抓 raw wikitext（合规 UA + 限流 + 缓存），
//   解析留在客户端（utils/liquipedia-parse.js，G14 双源测试覆盖）。
//   相比「EF 全量移植解析」：零移植风险、客户端解析逻辑不动、EF 体量小。
//
// 对应原 action：
//   liquipediaFetchRawWikitext  { pageName }  → slugmap 映射 → wikitext
//   liquipediaPrewarm           （预热门面：多个 slug 批量预热）
//
// LP 限流要求：普通端点 ≤ 1 次/2 秒（config.rateLimitMs=2200 同口径）——
//   EF 内置 2.2s 全局串行队列（实例级；免费版单实例足够）。
//
// 部署：supabase functions deploy liquipedia-proxy --no-verify-jwt
// 验证：curl -X POST .../functions/v1/liquipedia-proxy \
//         -d '{"action":"liquipediaFetchRawWikitext","params":{"pageName":"PGL Wallachia Season 9"}}'
// ============================================================
import { cors, db } from "../_shared/auth.ts";

// ★ v8.16：slugmap 改为 TS 内联常量（Supabase EF 运行时对 `with { type: "json" }`
//   import attributes 支持不稳，导致 500 启动错误）。由 scripts/gen-slugmap-ts.js 生成。
import { SLUGMAP_MAPPINGS } from "./slugmap.ts";

const LP_BASE = "https://liquipedia.net/dota2/api.php";
const LP_UA = "DOTA2-Esports-Hub/1.0 (WeChat Mini Program; contact: dev@local)";
const RATE_LIMIT_MS = 2200;               // LP 官方 ≥2s，留 200ms 余量
const META_TTL_MS = 6 * 3600 * 1000;      // 对齐 config.liquipedia.cacheTtl
const SCHEDULE_TTL_MS = 24 * 3600 * 1000; // 对齐 cacheStaleTtlSchedule（24h）

// ===== slug 映射（与云函数 liquipediaSlugFor 同源） =====
function slugFor(name: string): string {
  const m = SLUGMAP_MAPPINGS || {};
  return m[name] || name;
}

// ===== 全局限流队列（2.2s 串行，实例级） =====
let _lastLpFetch = 0;
let _queue: Promise<void> = Promise.resolve();
function rateLimitedFetch(path: string): Promise<any> {
  const job = _queue.then(async () => {
    const wait = _lastLpFetch + RATE_LIMIT_MS - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    _lastLpFetch = Date.now();
    const res = await fetch(LP_BASE, {
      headers: { "User-Agent": LP_UA, "Accept-Encoding": "gzip" }
    });
    if (!res.ok) throw new Error("Liquipedia " + res.status);
    // Deno fetch 自动解压 gzip
    return await res.json();
  });
  // 队列容错：单次失败不阻塞后续（但保持顺序）
  _queue = job.then(() => undefined).catch(() => undefined);
  return job;
}

// ===== 抓取 wikitext（action=query&prop=revisions，与云函数同参数） =====
async function fetchWikitext(pageTitle: string): Promise<string | null> {
  const url = LP_BASE + "?action=query&format=json&prop=revisions&rvprop=content&titles=" +
              encodeURIComponent(pageTitle);
  const j = await rateLimitedFetch(url);
  const pages = j && j.query && j.query.pages;
  if (!pages) return null;
  const p = Object.values(pages)[0] as any;
  return (p && p.revisions && p.revisions[0] && p.revisions[0]["*"]) || null;
}

// ===== 缓存（key: lp:<slug>，TTL 按用途） =====
async function getCache(key: string): Promise<any | null> {
  const client = await db();
  const { data, error } = await client
    .from("aggregation_cache").select("payload, expire_at")
    .eq("key", key).maybeSingle();
  if (error || !data) return null;
  if (new Date(data.expire_at) < new Date()) return null;
  return data.payload;
}
async function setCache(key: string, value: any, ttlMs: number): Promise<void> {
  const client = await db();
  await client.from("aggregation_cache").upsert({
    key, payload: value,
    expire_at: new Date(Date.now() + ttlMs).toISOString(),
    updated_at: new Date().toISOString()
  }, { onConflict: "key" }).then(r => { if (r.error) console.warn("[setCache]", r.error.message); });
}

// ===== action 处理 =====
async function handle(body: any): Promise<any> {
  const action = body.action;
  const params = body.params || {};
  const force = !!body.force;

  if (action === "liquipediaFetchRawWikitext") {
    const pageName = params.pageName || params.name || null;
    if (!pageName) return { error: "pageName required" };
    const slug = slugFor(pageName);
    const cacheKey = "lp:w:" + slug;
    if (!force) {
      const cached = await getCache(cacheKey);
      if (cached) return { data: { wikitext: cached }, source: "cache" };
    }
    const wikitext = await fetchWikitext(slug);
    if (!wikitext) return { data: null, source: "liquipedia" };
    await setCache(cacheKey, wikitext, META_TTL_MS);
    return { data: { wikitext }, source: "liquipedia" };
  }

  if (action === "liquipediaPrewarm") {
    // 预热 slugmap 全量（串行限流；冷启动后由 cron-job.org/客户端触发）
    const m = SLUGMAP_MAPPINGS || {};
    const slugs = Array.from(new Set(Object.values(m))) as string[];
    let ok = 0;
    for (const slug of slugs.slice(0, 30)) {   // 单次调用上限 30 个（LP 限流 + EF 30s 超时）
      try {
        const w = await fetchWikitext(slug);
        if (w) { await setCache("lp:w:" + slug, w, SCHEDULE_TTL_MS); ok++; }
      } catch (e) { /* 单个失败继续 */ }
    }
    return { data: { ok: true, prewarmed: ok, total: Math.min(slugs.length, 30) }, source: "prewarm" };
  }

  return { error: "unknown action: " + (action || "(empty)") };
}

// ===== HTTP 入口 =====
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return cors();
  try {
    const body = await req.json().catch(() => ({}));
    const result = await handle(body);
    if (result.error) {
      // ★ v8.16：业务错误也打日志（Dashboard Logs 可见），方便远程诊断
      console.error("[liquipedia] action failed:", body.action, "→", result.error);
    }
    return Response.json(result, { status: result.error ? 500 : 200 });
  } catch (e) {
    // ★ v8.16：未捕获异常打全堆栈（此前 catch 静默 → Dashboard 只见 500 不见原因）
    console.error("[liquipedia] unhandled:", (e as Error).message, "\n", (e as Error).stack);
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
});
