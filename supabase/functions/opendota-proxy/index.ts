// ============================================================
// supabase/functions/opendota-proxy/index.ts
// OpenDota API 代理 + Postgres 缓存（替代云函数 aggregation 的 11 个 OD action）
//
// 对应原 action：
//   getLeagues / getLeagueWindows / getLeagueMatches / getTeam / getTeamPlayers
//   getTeamMatches / getPlayer / getPlayerMatches / getHeroes / searchTeams
//   getProMatches / getLiveMatches / preheat
//
// 设计：
//   1. 收 { action, params, force? } → 查 aggregation_cache 表 → miss/过期拉 OpenDota
//   2. 缓存语义与云函数一致：默认走缓存，force=true 跳过；失败回退 stale 缓存
//   3. 表结构（v8.13 修正，与 001-init.sql 一致）：key/payload/expire_at/updated_at
//
// 部署：supabase functions deploy opendota-proxy --no-verify-jwt
// 验证：curl -X POST .../functions/v1/opendota-proxy \
//         -H "Content-Type: application/json" -d '{"action":"getHeroes"}'
// ============================================================
import { cors, db } from "../_shared/auth.ts";

const OD_BASE = "https://api.opendota.com/api";

// ===== 路由表（与原云函数 buildPath 一致） =====
const LEAGUE_WINDOWS_SQL =
  "SELECT leagueid, min(start_time) AS earliest, max(start_time) AS latest, " +
  "max(start_time + duration) AS last_end, count(*) AS n " +
  "FROM matches WHERE start_time > extract(epoch FROM now() - interval '6 months') " +
  "GROUP BY leagueid";

function buildPath(action: string, params: any): string | null {
  const p = params || {};
  switch (action) {
    case "getLeagues":       return "/leagues";
    case "getLeagueMatches": return "/leagues/" + p.leagueId + "/matches";
    case "getTeam":          return "/teams/" + p.teamId;
    case "getTeamPlayers":   return "/teams/" + p.teamId + "/players";
    case "getTeamMatches":   return "/teams/" + p.teamId + "/matches";
    case "getPlayer":        return "/players/" + p.accountId;
    case "getPlayerMatches": return "/players/" + p.accountId + "/matches";
    case "getHeroes":        return "/heroes";
    case "searchTeams":      return "/search?q=" + encodeURIComponent(p.q || "");
    case "getLeagueWindows": return "/explorer?sql=" + encodeURIComponent(LEAGUE_WINDOWS_SQL);
    case "getProMatches":    return "/proMatches";
    case "getLiveMatches":   return "/live";
    default: return null;
  }
}

// ===== TTL（与原云函数 resolveTtl 一致，毫秒） =====
function resolveTtl(action: string): number {
  switch (action) {
    case "getLeagues": return 6 * 3600 * 1000;
    case "getLeagueMatches":
    case "getTeamMatches":
    case "getPlayerMatches": return 30 * 60 * 1000;
    case "getTeam":
    case "getTeamPlayers":
    case "getPlayer": return 6 * 3600 * 1000;
    case "getHeroes": return 24 * 3600 * 1000;
    case "getProMatches": return 5 * 60 * 1000;
    case "getLiveMatches": return 60 * 1000;
    default: return 30 * 60 * 1000;
  }
}

// ===== 缓存层（字段与 001-init.sql 实际表结构一致：key/payload/expire_at） =====
// ★ v8.31：实例内存热缓存（L1）——preheat 灌入 + 热点 key 常驻，同实例重复请求
//   免 Postgres 往返（省 100-300ms）。实例级 best-effort（免费版单实例为主）。
const MEM = new Map<string, { payload: any; expire: number }>();
const MEM_CAP = 40;                 // 容量上限（防大响应撑爆 512MB 内存）
const MEM_TTL_MS = 10 * 60 * 1000;  // 内存 TTL 10min（表 TTL 是权威，此处仅加速）

function memGet(key: string): any | null {
  const m = MEM.get(key);
  if (!m) return null;
  if (m.expire < Date.now()) { MEM.delete(key); return null; }
  return m.payload;
}
function memSet(key: string, payload: any, ttlMs: number): void {
  if (MEM.size >= MEM_CAP) {
    const oldest = MEM.keys().next().value;
    if (oldest) MEM.delete(oldest);   // FIFO 淘汰
  }
  MEM.set(key, { payload, expire: Date.now() + Math.min(ttlMs, MEM_TTL_MS) });
}

async function getCache(key: string): Promise<any | null> {
  const hit = memGet(key);
  if (hit !== null) return hit;
  const client = await db();
  const { data, error } = await client
    .from("aggregation_cache")
    .select("payload, expire_at")
    .eq("key", key)
    .maybeSingle();
  if (error || !data) return null;
  if (new Date(data.expire_at) < new Date()) return null;  // 过期
  memSet(key, data.payload, 10 * 60 * 1000);               // 表命中 → 回填内存
  return data.payload;
}

async function setCache(key: string, value: any, ttlMs: number): Promise<void> {
  const client = await db();
  const { error } = await client
    .from("aggregation_cache")
    .upsert({
      key: key,
      payload: value,
      expire_at: new Date(Date.now() + ttlMs).toISOString(),
      updated_at: new Date().toISOString()
    }, { onConflict: "key" });
  if (error) { console.warn("[setCache] upsert failed:", error.message); return; }
  memSet(key, value, ttlMs);
}

// ===== stale 兜底查询（失败时用过期缓存顶上，与云函数语义一致） =====
async function getStaleCache(key: string): Promise<any | null> {
  const client = await db();
  const { data } = await client
    .from("aggregation_cache")
    .select("payload")
    .eq("key", key)
    .maybeSingle();
  return data ? data.payload : null;
}

// ===== HTTP 请求（原生 fetch 替代 got） =====
async function fetchOd(path: string): Promise<any> {
  const res = await fetch(OD_BASE + path, {
    headers: { "User-Agent": "DOTA2-Esports-Hub/1.0" }
  });
  if (!res.ok) {
    throw new Error(`OpenDota ${res.status}: ${await res.text()}`);
  }
  return await res.json();
}

// ===== Action 处理 =====
async function handleAction(action: string, params: any, force?: boolean): Promise<{ data?: any; error?: string; source?: string }> {
  // 特殊 action：预热（pg_cron 不可用的替代——可由 cron-job.org 定时 GET 触发）
  if (action === "preheat") {
    await preheat();
    return { data: { ok: true }, source: "preheat" };
  }

  const path = buildPath(action, params);
  if (!path) return { error: "unknown action: " + action };

  // 缓存 key 用裸 path（EF 缓存表独立于云开发缓存，无碰撞面）
  const cacheKey = "od:" + path;
  if (!force) {
    const cached = await getCache(cacheKey);
    if (cached !== null) return { data: cached, source: "cache" };
  }

  try {
    const data = await fetchOd(path);
    const ttl = resolveTtl(action);
    await setCache(cacheKey, data, ttl);
    return { data, source: "fresh" };
  } catch (e) {
    // 兜底：失败时返回 stale 缓存（与云函数语义一致）
    const stale = await getStaleCache(cacheKey);
    if (stale) return { data: stale, source: "cache_fallback" };
    return { error: (e as Error).message };
  }
}

// ===== 预热（cron-job.org 定时 GET 触发） =====
async function preheat(): Promise<void> {
  const hotPaths = ["/leagues", "/heroes", "/proMatches"];
  for (const path of hotPaths) {
    try {
      const data = await fetchOd(path);
      await setCache("od:" + path, data, path === "/proMatches" ? 5 * 60 * 1000 : 6 * 3600 * 1000);
    } catch (e) {
      console.warn("[preheat]", path, "failed:", (e as Error).message);
    }
  }
}

// ===== HTTP 入口 =====
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return cors();

  try {
    const body = await req.json().catch(() => ({ action: req.method === "GET" ? new URL(req.url).searchParams.get("action") : null }));
    const action = body.action;
    const params = body.params || {};
    const force = !!body.force;

    if (!action) {
      return Response.json({ error: "action required" }, { status: 400 });
    }

    const result = await handleAction(action, params, force);
    return Response.json(result, { status: result.error ? 500 : 200 });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
});
