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
// ★ v8.31（赛事页 4s 优化）：SQL 改为「整数秒下界」动态生成——原 `extract(epoch FROM now()
//   - interval '6 months')` 是函数表达式，Postgres 无法走 start_time 索引 → 全表扫描 →
//   OpenDota explorer 14-16s 后 400 "Query read timeout"（列表页 leagueWindows 长期静默降级）。
//   窗口同时 6 个月 → 3 个月（列表只需近 90 天活跃 + curation 窗口）。
//   实测 16566ms/500 → 1215ms/200。
//   ⚠️ G14 双源镜像：与 utils/sqlFragments.js、cloudfunctions/aggregation/index.js 保持同源。
//   ★ 下界对齐到当日 00:00 UTC —— 若用实时 now-90d，SQL 文本每秒变化 → EF/api 缓存 key
//     每秒漂移 → 永远 miss（实测 source=fresh 永不命中）。对齐后 24h 内 key 恒定。
const LEAGUE_WINDOWS_WINDOW_DAYS = 90;
function leagueWindowsSql(nowSec?: number): string {
  const now = (typeof nowSec === "number" && nowSec > 0) ? nowSec : Math.floor(Date.now() / 1000);
  const dayStart = Math.floor(now / 86400) * 86400;
  const floor = dayStart - LEAGUE_WINDOWS_WINDOW_DAYS * 86400;
  return "SELECT leagueid, min(start_time) AS earliest, max(start_time) AS latest, " +
    "max(start_time + duration) AS last_end, count(*) AS n " +
    "FROM matches WHERE start_time > " + floor + " GROUP BY leagueid";
}

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
    case "getLeagueWindows": return "/explorer?sql=" + encodeURIComponent(leagueWindowsSql());
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

// ===== ★ v8.31（赛事页 4s 优化 · 核心）：getLeagues 服务端裁剪 =====
// 问题：OpenDota /leagues 返回 **10176 条 / 1001 KB** 全量历史（含 7314 条 tier=excluded），
//   这是 loadLeagues 网络段 4 秒的主因——1MB 跨网传输 + 客户端 JSON.parse 都极慢。
//   而客户端只用：leagueid / tier / name（banner、ticket 全未使用），且只展示 rank>=1。
// 方案：EF 侧裁剪 payload（缓存里存**裁剪后**的，命中即直发小体积）：
//   ① 丢弃 tier=excluded 与 none（客户端 unifiedTier 判 rank=0 必被 filter 掉）；
//   ② 只保留 leagueid / tier / name 三字段（去掉 banner/ticket）；
//   ③ name 为空的行丢弃（无法展示）。
// 实测预期：1001 KB → ~223 KB（2968 条；原始 10176 条）。
// ⚠️ 关键安全约束（实测踩坑，务必保留）：
//   ① **不能只按 tier 裁剪**——`The International` 自身 tier=excluded，纯 tier 裁剪会删掉 TI！
//   ② 也不能自造白名单——首版自造关键词漏了 EPL，导致 2 条**活跃**赛事
//      （European Pro League 2025-2026 Season / EPL World Series: SEA）被误删。
//   ③ 正解：对 excluded/none 条目跑**与客户端 tiers.js COMMUNITY_TIERS 完全同源**的正则。
//      实测这样「丢失 rank>=1 条目 = 0」（零行为回归），同时压到 223KB。
// ⚠️ 镜像维护：下列正则须与 utils/tiers.js 的 COMMUNITY_TIERS 保持同源（改动同步三处：
//   utils/tiers.js / 本文件 / cloudfunctions/aggregation/index.js）。
// ⚠️ 缓存兼容：裁剪在**写入缓存前**做，老缓存（未裁剪）命中时也走一次 trim（幂等）。
const KEEP_LEAGUE_TIERS: Record<string, number> = { professional: 1, premium: 1, amateur: 1 };
const COMMUNITY_TIER_RES: RegExp[] = [
  /the\s+international/i,
  /(riyadh\s+masters|esports\s+world\s+cup|ewc)/i,
  /major(?!.*minor)(?!\s+(meme|fun|league|cup|scrim|trial|challenge|show|march|madness|monday))/i,
  /(esl\s+one|dreamleague|pgl|blast\s+slam|fissure|betboom|elite\s+league)/i,
  /premier/i,
  /(clavision|the\s+summit|g\s+dexter|games\s+of\s+the\s+future)/i,
  /(cct\s+series|cct\b|pinnacle\s+cup|pinnacle\b|1win\s+(series|essence|duel|standoff|motion))/i,
  /(european\s+pro\s+league|\bepl\b|moonstorm|resurrection|heroic\s+league|1win\s+not\s+int)/i,
  /\bminor\b(?!(\s+(league|scrim|scrims|cup|series|weekly|daily|challenge|fun|meme|trial|show|madness)))/i,
  /(division\s*(i\b|1\b|one\b)|super\s*group|甲级组|upper\s*division)/i,
  /(division\s*(ii\b|2\b|two\b)|乙级组|lower\s*division)/i,
  /(triton|mega\s+arena|world\s+invitational)/i,
  /(dreamleague\s+(division|div)\s*2|dl\s+div\s*2|d2cl|cosmic\s+clash|winline|perfect\s+world\s+league\s+2)/i
];
function communityTierHits(name: string): boolean {
  for (const re of COMMUNITY_TIER_RES) { if (re.test(name)) return true; }
  return false;
}

function trimLeagues(payload: any): any {
  if (!Array.isArray(payload)) return payload;
  const out: any[] = [];
  for (const l of payload) {
    if (!l || !l.leagueid || !l.name) continue;
    if (!KEEP_LEAGUE_TIERS[l.tier] && !communityTierHits(l.name)) continue;
    out.push({ leagueid: l.leagueid, tier: l.tier, name: l.name });
  }
  return out;
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
    if (cached !== null) {
      // ★ v8.31：老缓存兼容——裁剪前写入的历史缓存命中时补一次 trim（幂等，小数据跳过）
      if (action === "getLeagues" && Array.isArray(cached) && cached.length > 4000) {
        const trimmed = trimLeagues(cached);
        await setCache(cacheKey, trimmed, resolveTtl(action));   // 回写裁剪版（下次秒发小包）
        return { data: trimmed, source: "cache_trimmed" };
      }
      return { data: cached, source: "cache" };
    }
  }

  try {
    let data = await fetchOd(path);
    // ★ v8.31：裁剪在写入缓存前做（缓存里存小包，命中即直发）
    if (action === "getLeagues") data = trimLeagues(data);
    const ttl = resolveTtl(action);
    await setCache(cacheKey, data, ttl);
    return { data, source: "fresh" };
  } catch (e) {
    // 兜底：失败时返回 stale 缓存（与云函数语义一致）
    const stale = await getStaleCache(cacheKey);
    if (stale) return { data: action === "getLeagues" ? trimLeagues(stale) : stale, source: "cache_fallback" };
    return { error: (e as Error).message };
  }
}

// ===== 预热（cron-job.org 定时 GET 触发） =====
async function preheat(): Promise<void> {
  const hotPaths = ["/leagues", "/heroes", "/proMatches"];
  for (const path of hotPaths) {
    try {
      let data = await fetchOd(path);
      // ★ v8.31：/leagues 预热同样裁剪（保证缓存里恒为小包，命中即直发 ~150KB）
      if (path === "/leagues") data = trimLeagues(data);
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
