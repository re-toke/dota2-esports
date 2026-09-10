// ============================================================
// supabase/functions/haglund-proxy/index.ts
// haglund.dev 第三方兜底源代理（替代云函数 haglundUpcoming action）
//
// 背景（P0-C1）：客户端 wx.request 直连 dota.haglund.dev 在正式版必被
//   域名白名单拦截（海外未备案不可配）——需服务端代理。
// 返回**原始数组**（归一化在客户端 haglund.js 完成，单一实现零漂移）。
//
// 移植自 cloudfunctions/aggregation/index.js haglundUpcoming（L833-855）：
//   缓存 10min（TTL.haglundUpcoming）+ 浏览器请求头（降低 Cloudflare 403 概率）
//
// 部署：supabase functions deploy haglund-proxy --no-verify-jwt
// 验证：curl -X POST .../functions/v1/haglund-proxy -d '{}'
// ============================================================
import { cors, db } from "../_shared/auth.ts";

const HAGLUND_BASE = "https://dota.haglund.dev/v1/matches";
const TTL_MS = 10 * 60 * 1000;

async function getFreshCache(key: string): Promise<any | null> {
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
  const { error } = await client
    .from("aggregation_cache").upsert({
      key, payload: value,
      expire_at: new Date(Date.now() + ttlMs).toISOString(),
      updated_at: new Date().toISOString()
    }, { onConflict: "key" });
  if (error) console.warn("[setCache]", error.message);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return cors();
  try {
    const body = await req.json().catch(() => ({}));
    const force = !!body.force;
    const cacheKey = "haglund_upcoming";

    if (!force) {
      const cached = await getFreshCache(cacheKey);
      if (cached) return Response.json({ data: cached, source: "cache" });
    }

    // 与客户端 haglund.js 同款浏览器请求头（降低 Cloudflare 403 概率）
    const res = await fetch(HAGLUND_BASE, {
      headers: {
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://liquipedia.net/",
        "User-Agent": "DOTA2-Esports-Hub/1.0"
      }
    });
    if (!res.ok) throw new Error("Haglund HTTP " + res.status);
    const bodyData = await res.json();
    if (!Array.isArray(bodyData)) return Response.json({ data: [], source: "haglund" });

    await setCache(cacheKey, bodyData, TTL_MS);
    return Response.json({ data: bodyData, source: "haglund" });
  } catch (e) {
    console.error("[haglund-proxy]", (e as Error).message);
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
});
