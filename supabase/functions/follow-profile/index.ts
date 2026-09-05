// ============================================================
// supabase/functions/follow-profile/index.ts
// 替代云开发 getFollowProfile / saveFollowProfile
// follow_profile_<openid> 存 aggregation_cache 表，30 天过期
// ★ 必须验 JWT：openid 以签发凭证为信任源，防 anon key 读写他人画像
// 验证：
//   无 token → {"errcode":401}
//   有效 JWT → {"profile":...}
// ============================================================
import { verifyJwt, bearer, cors, db } from "../_shared/auth.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return cors();

  // 1. 验 JWT → openid（唯一信任源）
  const openid = await verifyJwt(bearer(req), Deno.env.get("WX_APPSECRET")!);
  if (!openid) return Response.json({ errcode: 401, errmsg: "invalid token" }, { status: 401 });

  const { op, profile } = await req.json().catch(() => ({ op: "get" }));
  const client = await db();
  const cacheKey = `follow_profile_${openid}`;

  // 2. save：upsert，30 天过期（对齐原云函数 setCache(..., 30d)）
  if (op === "save") {
    await client.from("aggregation_cache").upsert({
      key: cacheKey,
      payload: profile || {},
      expire_at: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
    }, { onConflict: "key" });
    return Response.json({ ok: true });
  }

  // 3. get：过期则删（对齐原 getCache 行为）
  const { data } = await client.from("aggregation_cache")
    .select("payload, expire_at").eq("key", cacheKey).maybeSingle();
  if (!data) return Response.json({ profile: null });
  if (new Date(data.expire_at) < new Date()) {
    await client.from("aggregation_cache").delete().eq("key", cacheKey);
    return Response.json({ profile: null });
  }
  return Response.json({ profile: data.payload });
});
