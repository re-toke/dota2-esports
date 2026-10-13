// ============================================================
// supabase/functions/bundle-aggregator/index.ts
// 赛事详情页聚合（替代云函数 getLeagueDetailBundle）
//
// 聚合内容：
//   ① OD /leagues/{id}/matches（比赛列表）
//   ② explorer teams 名字映射（team_id → name，从 od 结果提取 id 集合）
//
// ★ 缓存 key 与 opendota-proxy 对齐（"od:" + path）——bundle 与通用路径
//   共享同一份缓存：详情页与列表页数据一致，且互相预热。
//
// 移植自 cloudfunctions/aggregation/index.js getLeagueDetailBundle（L2241-2329）：
//   - 快失败优于慢成功：OD 现抓失败/超时 → 用 stale 缓存顶上（客户端 direct 有自己的兜底链）
//   - 两者皆空 → error（客户端回退旧链）
//
// 部署：supabase functions deploy bundle-aggregator --no-verify-jwt
// 验证：curl -X POST .../functions/v1/bundle-aggregator \
//         -d '{"action":"getLeagueDetailBundle","params":{"leagueId":19944}}'
// ============================================================
import { cors, db } from "../_shared/auth.ts";
import { createL1Cache } from "../_shared/l1cache.ts";

const OD_BASE = "https://api.opendota.com/api";
const NAMES_TTL_MS = 6 * 3600 * 1000;

// ★ 2026-10-13（P1-10）：`loadNames` 的 explorer IN 列表**分批上限** —— 原实现为单个无界
//   `IN (…)`（最坏数百 id 一条 SQL）⇒ 现按 150 分块并行查询（各块独立缓存），消除无界 SQL。
const NAMES_ID_CHUNK = 150;
// ★ 2026-10-13（P1-10 · bundle 裁剪）：返回的 `matches` 字段**当前无客户端消费方** ——
//   唯一调用方 `subpackages/detail/league-detail/league-detail.js` 只读 `bundle.teamNames`
//   （实测核过），赛事列表另经 `api.getLeagueMatches` 单独获取 ⇒ 把返回的 `matches` 裁到
//   最近 N 条（复用 P0-1 思路：OD `/leagues/{id}/matches` 按时间倒序），既控 EF→客户端
//   payload 又**零功能回归**；`teamNames` 仍由**全量** od 推导，不受此裁剪影响。
const BUNDLE_MATCH_CAP = 300;

// ===== 缓存（key 与 opendota-proxy 对齐："od:" + path） =====
async function getAnyCache(key: string): Promise<any | null> {
  const client = await db();
  const { data } = await client
    .from("aggregation_cache").select("payload")
    .eq("key", key).maybeSingle();
  return data ? data.payload : null;
}

// ★ 2026-10-13（P1-9）：L1（进程内）优先 —— 命中免一次 Postgres 往返（bundle 热路径重复命中收益最直接）。
const L1 = createL1Cache({ cap: 40, ttlMs: 10 * 60 * 1000 });
async function getFreshCache(key: string): Promise<any | null> {
  const hit = L1.get(key);
  if (hit !== null) return hit;
  const client = await db();
  const { data, error } = await client
    .from("aggregation_cache").select("payload, expire_at")
    .eq("key", key).maybeSingle();
  if (error || !data) return null;
  if (new Date(data.expire_at) < new Date()) return null;
  L1.set(key, data.payload, 10 * 60 * 1000);   // 表命中 → 回填内存
  return data.payload;
}

async function setCache(key: string, value: any, ttlMs: number): Promise<void> {
  const client = await db();
  const { error } = await client
    .from("aggregation_cache").upsert({
      key, payload: value,
      expire_at: new Date(Date.now() + ttlMs).toISOString(),
      updated_at: new Date().toISOString()
    }, { onConflict: "key" });
  if (error) console.warn("[setCache]", error.message);
  L1.set(key, value, ttlMs);
}

// ===== OpenDota 抓取（6s 短超时单次尝试，对齐云函数「快失败」设计） =====
async function fetchOd(path: string): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(OD_BASE + path, {
      headers: { "User-Agent": "DOTA2-Esports-Hub/1.0" },   // 注：这是 **OpenDota** 的 UA，非 LP（见 OD_BASE）；LP 的 UA 见 _shared/lp-ua.ts
      signal: controller.signal
    });
    if (!res.ok) throw new Error("OpenDota " + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ===== 子任务 ①：OD league matches（缓存→现抓→stale 兜底） =====
async function loadOd(leagueId: number, force: boolean, odPath: string): Promise<any[]> {
  if (!(leagueId > 0)) return [];
  if (!force) {
    const cached = await getFreshCache(odPath);
    if (cached) return cached;
  }
  try {
    const data = await fetchOd(odPath);
    if (!Array.isArray(data)) return (await getAnyCache(odPath)) || [];
    // TTL.leagueMatches = 30min（与 opendota-proxy resolveTtl 一致）
    await setCache(odPath, data, 30 * 60 * 1000);
    return data;
  } catch (e) {
    const fallback = await getAnyCache(odPath);
    return fallback || [];
  }
}

// ===== 子任务 ②：explorer teamNames（id 集合从 od 结果提取） =====
// ★ P1-10：原为单个无界 IN 查询；现按 NAMES_ID_CHUNK 分块**并行**（各块独立缓存）。
async function loadNames(odList: any[]): Promise<Record<string, string>> {
  const ids: number[] = [];
  const seen: Record<string, boolean> = {};
  (Array.isArray(odList) ? odList : []).forEach((m: any) => {
    if (m && m.radiant_team_id && !seen[m.radiant_team_id]) {
      seen[m.radiant_team_id] = true;
      const n = Number(m.radiant_team_id);
      if (n > 0) ids.push(n);
    }
    if (m && m.dire_team_id && !seen[m.dire_team_id]) {
      seen[m.dire_team_id] = true;
      const n = Number(m.dire_team_id);
      if (n > 0) ids.push(n);
    }
  });
  if (!ids.length) return {};
  // ★ P1-10：升序排序 ⇒ 分块键稳定（跨 bundle 命中缓存；od 顺序变化不影响键）。
  ids.sort((a, b) => a - b);
  const chunks: number[][] = [];
  for (let i = 0; i < ids.length; i += NAMES_ID_CHUNK) {
    chunks.push(ids.slice(i, i + NAMES_ID_CHUNK));
  }
  const parts = await Promise.all(chunks.map((c) => loadNamesChunk(c)));
  const map: Record<string, string> = {};
  parts.forEach((p) => Object.assign(map, p));
  return map;
}

// ★ P1-10：单块 explorer 查询（有界 IN）+ 6h 缓存 / stale 兜底。
async function loadNamesChunk(chunk: number[]): Promise<Record<string, string>> {
  const sqlPath = "/explorer?sql=" + encodeURIComponent(
    "SELECT team_id, name FROM teams WHERE team_id IN (" + chunk.join(",") + ")");
  let data: any = null;
  const cached = await getFreshCache(sqlPath);
  if (cached) {
    data = cached;
  } else {
    try {
      data = await fetchOd(sqlPath);
      await setCache(sqlPath, data, NAMES_TTL_MS);
    } catch (e) {
      data = await getAnyCache(sqlPath);   // 失败 → stale 兜底
    }
  }
  const map: Record<string, string> = {};
  ((data && data.rows) || []).forEach((r: any) => {
    if (r && r.team_id != null) map[r.team_id] = r.name || "";
  });
  return map;
}

// ===== HTTP 入口 =====
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return cors();
  try {
    const body = await req.json().catch(() => ({}));
    const p = body.params || {};
    const leagueId = Number(p.leagueId) || 0;
    const force = !!body.force;
    const odPath = "/leagues/" + leagueId + "/matches";

    const od = await loadOd(leagueId, force, odPath);
    const names = await loadNames(od);
    const odOk = Array.isArray(od) && od.length > 0;
    const namesOk = Object.keys(names).length > 0;
    console.log("[LeagueDetailBundle] leagueId=" + leagueId +
      " matches=" + (Array.isArray(od) ? od.length : 0) +
      " teamNames=" + Object.keys(names).length +
      (odOk ? "" : " (od empty→client fallback)"));

    // 两者皆空 → **返回 200 + data:null**（语义：本条赛事确实没有 bundle 数据）
    //
    // ★ 2026-09-19 修正（原为 `502 {error:"league detail bundle empty"}`）：
    //   原设计意图是用 502 通知客户端"回退旧链"，但**副作用严重** ——
    //   客户端熔断器（utils/supabaseClient.js `_countFail`）把 502 计入**服务故障**，
    //   连续 3 次即**熔断该 EF**；此后所有请求都直接 `supabase ef unavailable: bundle-aggregator`
    //   回落云开发，**连"本来可能成功"的也不试**（真机日志已复现）。
    //   「**空结果**」≠「**服务故障**」—— 前者是正常业务态，不应影响熔断状态。
    //   现改为语义正确的 200；客户端据 `data === null` 判断是否需要回退
    //   （客户端侧同时做了兼容：旧 502 的 `error` 含 "empty" 也**不计熔断**）。
    if (!odOk && !namesOk) {
      console.log("[bundle] league=" + leagueId + " 两者皆空 → 200 + data:null（非故障，不计熔断）");
      return Response.json({ data: null, source: "empty" }, { status: 200 });
    }
    // ★ P1-10：返回的 matches 裁到最近 BUNDLE_MATCH_CAP 条（客户端不读 matches，见顶部注释）
    const odOut = (Array.isArray(od) && od.length > BUNDLE_MATCH_CAP) ? od.slice(0, BUNDLE_MATCH_CAP) : od;
    return Response.json({ data: { matches: odOut, teamNames: names }, source: "bundle" });
  } catch (e) {
    console.error("[bundle-aggregator] unhandled:", (e as Error).message);
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
});
