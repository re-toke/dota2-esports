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
import { LP_UA } from "../_shared/lp-ua.ts";

const LP_BASE = "https://liquipedia.net/dota2/api.php";
// ★★ 2026-09-26（P0-E-1）：UA 由「伪装浏览器指纹」**回退为标识性 UA**（LP_UA，定义见 _shared/lp-ua.ts）。
//   原因：伪装浏览器 UA **明确违反 Liquipedia API ToS**（要求「标识项目 + 含联系方式」），
//   违规可致**自动临时 IP 封禁**、反复触发转**永久** —— 而在本架构下 LP 是「族 B」权威锚点，
//   一旦被封会连带击穿分级体系（P0-A / P1-C 一并失效）。
//   ★ 落地前做过**真实请求预检**（2026-09-26）：伪装 UA / 标识性 UA / 早期合规 UA
//     对 LP API **均返回 HTTP 200 + 有效内容**，标识性 UA 无副作用
//     ⇒ 「换回合规 UA 会被 Cloudflare 挑战」的担忧**未被证实**（当年的"更隐蔽"是错误应对，
//        正确应对是降频 / 加缓存 / 走缓存表）。
const RATE_LIMIT_MS = 2200;               // LP 官方 ≥2s，留 200ms 余量

const SCHEDULE_TTL_MS = 24 * 3600 * 1000; // 对齐 cacheStaleTtlSchedule（24h）

// ===== slug 映射（与云函数 liquipediaSlugFor 同源） =====
function slugFor(name: string): string {
  const m = SLUGMAP_MAPPINGS || {};
  return m[name] || name;
}

// ===== 全局限流队列（2.2s 串行，实例级） =====
let _lastLpFetch = 0;
let _queue: Promise<void> = Promise.resolve();
// ★ 2026-09-26（P0-E-1）：UA 回退为标识性（LP_UA）。其余头**必须保留** ——
//   `Accept-Encoding: gzip` 是 ToS 明列要求（缺它会 HTTP 406，那是请求头不合法而非被封，历史踩过）；
//   `Accept` / `Accept-Language` 是正常内容协商头，与"伪装"无关，保留。
function lpHeaders(): Record<string, string> {
  return {
    "User-Agent": LP_UA,
    "Accept": "application/json",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip"
  };
}
function rateLimitedFetch(path: string): Promise<any> {
  const job = _queue.then(async () => {
    const wait = _lastLpFetch + RATE_LIMIT_MS - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    _lastLpFetch = Date.now();
    const res = await fetch(LP_BASE, { headers: lpHeaders() });
    if (!res.ok) throw new Error("Liquipedia " + res.status);
    // Deno fetch 自动解压 gzip
    return await res.json();
  });
  // 队列容错：单次失败不阻塞后续（但保持顺序）
  _queue = job.then(() => undefined).catch(() => undefined);
  return job;
}

// ===== 抓取 wikitext（action=query&prop=revisions，与云函数同参数） =====
// ★ 2026-09-10 修复：补 `redirects=1`。
//   此前 EF 漏了该参数，而云函数（aggregation L549）与客户端本地路径（liquipedia.js L251）
//   都带 —— EF 注释里「与云函数同参数」实际已不成立。
//   后果（实测确认）：LP 上不少赛事主页面是重定向页（如 `The International 2026` 实测
//   仅 36 字节 `#REDIRECT [[...]]`）。EF 抓到这种页面会把 36B 重定向文本写进
//   `lp:w:<slug>` 缓存（TTL 24h），而读取端 getAnyCache **不过滤 expire_at**（v8.22 设计）
//   → 该 key 被永久污染 → 客户端 parseScheduledMatches 找不到任何 {{Match}} → 赛程空白。
//   当前因 EF 出口被 LP 限流（429）而极少写入，属**潜伏缺陷**；一旦限流解除即静默发作。
// ===== wikitext 可用性判定（★ 2026-09-10）=====
// 重定向占位文本 / 空文本 一律视为**不可用**——读写两侧共用同一判定：
//   · 写侧（fetchWikitext）：不可用则不返回、不入缓存；
//   · 读侧（handle）：不可用则视为 miss（继续尝试现抓；仍失败则返回 null，由客户端回落）。
// 这样即便表里已存在修复前写入的污染条目，也不会再被读出。
function isUsableWikitext(wt: any): boolean {
  if (typeof wt !== "string") return false;
  if (!wt.trim()) return false;
  // #REDIRECT 占位（正常页面内容不会以它开头且这么短）
  if (/^\s*#redirect\s/i.test(wt) && wt.length < 500) return false;
  return true;
}

async function fetchWikitext(pageTitle: string): Promise<string | null> {
  const url = LP_BASE + "?action=query&format=json&prop=revisions&rvprop=content" +
              "&redirects=1" +   // ★ 跟随 #REDIRECT，返回最终页面内容（与云函数/客户端同口径）
              "&titles=" + encodeURIComponent(pageTitle);
  const j = await rateLimitedFetch(url);
  const pages = j && j.query && j.query.pages;
  if (!pages) return null;
  const p = Object.values(pages)[0] as any;
  const wt = (p && p.revisions && p.revisions[0] && p.revisions[0]["*"]) || null;
  if (!isUsableWikitext(wt)) {
    if (wt) console.warn("[liquipedia] 拒绝不可用文本(len=" + String(wt).length + "): " + pageTitle);
    return null;
  }
  return wt;
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

// ★ v8.22：读表不过滤过期——LP 数据 TTL 由 sync 脚本管理，EF 纯读
async function getAnyCache(key: string): Promise<any | null> {
  const client = await db();
  const { data } = await client
    .from("aggregation_cache").select("payload")
    .eq("key", key).maybeSingle();
  return data ? data.payload : null;
}

// ===== action 处理 =====
async function handle(body: any): Promise<any> {
  const action = body.action;
  const params = body.params || {};
  const force = !!body.force;
  // ★ 2026-09-11：cacheOnly 支持顶层与 params 两种传法（客户端走顶层，便于统一透传）
  const cacheOnly = !!(body.cacheOnly || params.cacheOnly);

  if (action === "liquipediaFetchRawWikitext") {
    const pageName = params.pageName || params.name || null;
    if (!pageName) return { error: "pageName required" };
    const slug = slugFor(pageName);
    const cacheKey = "lp:w:" + slug;
    // ★ v8.22（单后端终态）：LP 数据生命周期完全由 sync 脚本管理（GH Actions/本地
    //   定时灌表），EF 变成纯读表——不过滤 expire_at（表里有就用，旧数据也好过 500）。
    //   表里没有才尝试现抓（Supabase 出口当前被 LP Cloudflare 拦，会 500 → 客户端回退云开发）。
    const cached = await getAnyCache(cacheKey);
    // ★ 2026-09-10：读侧同样过 isUsableWikitext —— 表里可能存有修复前写入的重定向占位条目
    //   （写入时不过滤过期、读取时也不过滤 → 本会永久污染）。不可用则视为 miss，继续走现抓。
    if (isUsableWikitext(cached)) return { data: { wikitext: cached }, source: "cache" };
    if (cached) console.warn("[liquipedia] 缓存内容不可用，按 miss 处理: " + cacheKey);

    // ★★ 2026-09-11（LP 服务迁 EF 第一步）：cacheOnly —— 未命中**立即返回**，不尝试现抓。
    //
    // 为什么需要：Supabase 出口抓 LP 被**持续 429**（共享 IP 限流），现抓必然失败且要等约 7s。
    //   这 7s 让「EF 缓存优先」策略变得毫无价值 —— 未命中时反而比直接走云函数更慢。
    //   加上本参数后：未命中 <100ms 返回，客户端可安全地「EF 缓存优先 → 未命中回落云函数」：
    //     · 热门/已知赛事（GH Actions 已灌表）→ 走 EF 快路径，零云开发调用
    //     · 冷门/新赛事 → 立即回落云函数（可靠的 LP 出口），无额外延迟
    //   → 这是**不依赖 GitHub 打通**就能拿到的收益，且零回归风险。
    if (cacheOnly) return { data: null, source: "cache-miss", cacheOnly: true };

    const wikitext = await fetchWikitext(slug);
    if (!wikitext) return { data: null, source: "liquipedia" };
    await setCache(cacheKey, wikitext, SCHEDULE_TTL_MS);
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
