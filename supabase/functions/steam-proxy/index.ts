// ============================================================
// supabase/functions/steam-proxy/index.ts
// Steam Web API 代理（替代云函数 steamProxy + steamLeagueScheduled 两个 action）
//
// 对应原 action：
//   steamProxy           { path, params }        → IDOTA2Match_570 通用 GET 透传
//   steamLeagueScheduled { leagueId, force? }    → LIVE 对局抓取 + 归一化（schedule 主源）
//
// 移植自 cloudfunctions/aggregation/index.js：
//   fetchSteam / fetchSteamLiveLeagueGames / normalizeSteamLiveGame /
//   steamLeagueScheduledMatches（含 series 结束判定、force 节流）
//
// 部署：supabase secrets set STEAM_API_KEY=<key>
//       supabase functions deploy steam-proxy --no-verify-jwt
// 验证：curl -X POST .../functions/v1/steam-proxy \
//         -d '{"action":"steamProxy","params":{"path":"/GetHeroStats"}}'
// ============================================================
import { cors, db } from "../_shared/auth.ts";

const STEAM_BASE = "https://api.steampowered.com/IDOTA2Match_570";
const SCHEDULE_TTL_MS = 5 * 60 * 1000;      // 对齐云函数 TTL.liquipediaSchedule
const FORCE_MIN_GAP_MS = 30 * 1000;         // force 节流（对齐云函数）

// ===== 缓存（aggregation_cache 表，语义与云函数 getCache/setCache 一致） =====
async function getCache(key: string): Promise<any | null> {
  const client = await db();
  const { data, error } = await client
    .from("aggregation_cache")
    .select("payload, expire_at")
    .eq("key", key)
    .maybeSingle();
  if (error || !data) return null;
  if (new Date(data.expire_at) < new Date()) return null;
  return data.payload;
}

async function setCache(key: string, value: any, ttlMs: number): Promise<void> {
  const client = await db();
  const { error } = await client
    .from("aggregation_cache")
    .upsert({
      key, payload: value,
      expire_at: new Date(Date.now() + ttlMs).toISOString(),
      updated_at: new Date().toISOString()
    }, { onConflict: "key" });
  if (error) console.warn("[setCache]", error.message);
}

// ===== Steam GET 透传（对齐 fetchSteam：path + '/v1/?key=...&query'） =====
async function fetchSteam(path: string, params: Record<string, any> | null): Promise<any> {
  const key = Deno.env.get("STEAM_API_KEY")!;
  const ps: Record<string, any> = Object.assign({ key }, params || {});
  const qs = Object.keys(ps).map(k => k + "=" + encodeURIComponent(String(ps[k]))).join("&");
  const res = await fetch(STEAM_BASE + path + "/v1/?" + qs, {
    headers: { "User-Agent": "DOTA2-Esports-Hub/1.0" }
  });
  if (!res.ok) throw new Error("Steam " + res.status + ": " + (await res.text()).slice(0, 200));
  return await res.json();
}

// ===== GetLiveLeagueGames：无 league 过滤参数，全量抓取后本地筛（对齐云函数） =====
async function fetchSteamLiveLeagueGames(leagueId: string): Promise<any[]> {
  const data = await fetchSteam("/GetLiveLeagueGames", {});
  if (!data || !data.result) {
    console.log("[SteamLive] league=" + leagueId + " rawResp=" + JSON.stringify(data).slice(0, 200));
    return [];
  }
  const result = data.result;
  const games = Array.isArray(result.games) ? result.games
              : (Array.isArray(data.games) ? data.games : []);
  const leagueSet: Record<string, number> = {};
  games.forEach((g: any) => {
    const lid = g.league_id || 0;
    leagueSet[lid] = (leagueSet[lid] || 0) + 1;
  });
  console.log("[SteamLive] league=" + leagueId + " totalGames=" + games.length +
              " leagueDistribution=" + JSON.stringify(leagueSet));
  return games.filter((g: any) => String(g.league_id) === String(leagueId));
}

// ===== 归一化 LIVE 对局（逐行移植 normalizeSteamLiveGame，含 series 结束判定） =====
function normalizeSteamLiveGame(g: any): any | null {
  if (!g) return null;
  try {
    const rad = g.radiant_team || {};
    const dire = g.dire_team || {};
    const seriesId = g.series_id || 0;
    const seriesType = typeof g.series_type === "number" ? g.series_type : null;
    const startTime = Math.floor(Date.now() / 1000);  // live 无固定开始时间，用当前
    const score1 = typeof g.radiant_series_wins === "number" ? g.radiant_series_wins : 0;
    const score2 = typeof g.dire_series_wins === "number" ? g.dire_series_wins : 0;
    // series 结束判定（2026-08-22 + 2026-09-01 修复：残留场不标 live）
    let phase = "live";
    const totalScore = score1 + score2;
    if (seriesType != null && seriesType >= 0) {
      // series_type: 0=BO1, 1=BO3, 2=BO5, 3=BO2, 4=BO7
      const boNum = [1, 3, 5, 2, 7][seriesType] || (seriesType * 2 + 1);
      const winsToClinch = Math.ceil(boNum / 2);
      if (Math.max(score1, score2) >= winsToClinch) phase = "recent";
    } else if (totalScore >= 6 || Math.max(score1, score2) >= 3 ||
               (score1 === 2 && score2 === 0) || (score2 === 2 && score1 === 0)) {
      // series_type 缺失兜底（与客户端 buildLpLiveSeries._seriesEnded 同口径）
      phase = "recent";
    }
    return {
      series_id: seriesId,
      series_type: seriesType,
      league_id: g.league_id,
      radiant_team_id: rad.team_id || 0,
      dire_team_id: dire.team_id || 0,
      radiant_win: (score1 > score2),
      match_id: g.match_id || g.server_steam_id || 0,
      start_time: startTime,
      team1Name: rad.team_name || "",
      team2Name: dire.team_name || "",
      team1Short: rad.team_name || "",
      team2Short: dire.team_name || "",
      startTime: startTime,
      score1: score1,
      score2: score2,
      phase: phase,
      boType: null,
      team1Logo: rad.team_logo || "",
      team2Logo: dire.team_logo || "",
      stage: g.stage_name || "",
      source: "steam-live"
    };
  } catch (e) {
    console.warn("[SteamLive] normalize failed:", (e as Error).message);
    return null;
  }
}

// ===== steamLeagueScheduled：LIVE 抓取 + 缓存 + force 节流 =====
// force 节流内存表（Edge Function 实例级，非强一致——与云函数语义同级）
const _lastForceFetch: Record<string, number> = {};

async function steamLeagueScheduled(params: any, force: boolean): Promise<any> {
  const leagueId = (params && (params.leagueId || params.id)) || null;
  if (!leagueId) return { error: "leagueId required" };

  const cacheKey = "steam_schedule_" + leagueId;
  if (!force) {
    const cached = await getCache(cacheKey);
    if (cached) return { data: cached, source: "cache" };
  } else {
    const last = _lastForceFetch[cacheKey] || 0;
    if (Date.now() - last < FORCE_MIN_GAP_MS) {
      const cached = await getCache(cacheKey);
      if (cached) return { data: cached, source: "cache-recent" };
    }
    _lastForceFetch[cacheKey] = Date.now();
  }

  try {
    // GetScheduledLeagueGames 已被 Valve 删除（404）——只抓 LIVE（对齐云函数 2026-08-21）
    const liveRaw = await fetchSteamLiveLeagueGames(String(leagueId)).catch((e) => {
      console.warn("[SteamLive] fetch failed:", (e as Error).message);
      return [] as any[];
    });
    const liveMatches = (liveRaw || []).map(normalizeSteamLiveGame).filter(Boolean);
    const all = liveMatches;
    console.log("[SteamLeague] league=" + leagueId + " liveGames=" + (liveRaw || []).length +
                " normalized=" + liveMatches.length);

    const payload = { matches: all, boFormat: null };
    if (all.length) {
      await setCache(cacheKey, payload, SCHEDULE_TTL_MS).catch(() => {});
    }
    return { data: payload, source: "steam" };
  } catch (e) {
    return { error: "Steam 联赛对阵请求异常: " + (e as Error).message };
  }
}

// ===== HTTP 入口 =====
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return cors();

  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action;
    const params = body.params || {};
    const force = !!body.force;

    if (action === "steamProxy") {
      // 通用 GET 透传（与云函数 handleSteamProxy 一致：无缓存）
      const { path, params: q } = params || {};
      if (!path) return Response.json({ error: "path required" }, { status: 400 });
      try {
        const data = await fetchSteam(path, q || {});
        return Response.json({ data, source: "steam" });
      } catch (e) {
        return Response.json({ error: "Steam 请求失败: " + (e as Error).message }, { status: 502 });
      }
    }

    if (action === "steamLeagueScheduled") {
      return Response.json(await steamLeagueScheduled(params, force));
    }

    return Response.json({ error: "unknown action: " + (action || "(empty)") }, { status: 400 });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
});
