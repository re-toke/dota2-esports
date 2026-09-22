// ============================================================
// supabase/functions/stratz-proxy/index.ts
// STRATZ GraphQL 透传代理（替代云函数 handleStratzGql）
//
// 关键价值：绕开「云函数出口 IP 被 STRATZ Cloudflare 403 拦截」——
//   Supabase Edge Function（香港）出口 IP 不同，实测可达（2026-09-09 探测 HTTP 200）。
//
// 契约（与云函数一致）：收 { query, variables } → POST api.stratz.com/graphql
//   Bearer STRATZ_API_KEY → 透传 { data } 或 { error }
// 无缓存（与云函数一致——stratz 结果由客户端缓存层管理）
//
// 部署：supabase secrets set STRATZ_API_KEY=<key>
//       supabase functions deploy stratz-proxy --no-verify-jwt
// 验证：curl -X POST .../functions/v1/stratz-proxy \
//         -d '{"query":"{ leagues(request:{take:1,skip:0}){ id name } }"}'
// ============================================================
import { cors } from "../_shared/auth.ts";

const STRATZ_BASE = "https://api.stratz.com/graphql";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return cors();

  try {
    const body = await req.json().catch(() => ({}));
    const { query, variables } = body || {};
    if (!query) {
      return Response.json({ error: "query required" }, { status: 400 });
    }

    const key = Deno.env.get("STRATZ_API_KEY");
    if (!key) {
      return Response.json({ error: "STRATZ_API_KEY not set" }, { status: 500 });
    }

    const res = await fetch(STRATZ_BASE, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Authorization": "Bearer " + key,
        "User-Agent": "STRATZ_API"
      },
      body: JSON.stringify({ query, variables: variables || {} })
    });

    const json = await res.json().catch(() => null);
    if (!res.ok) {
      console.warn("[stratz] HTTP " + res.status + ":", JSON.stringify(json).slice(0, 200));
      return Response.json({ error: "STRATZ 请求失败: HTTP " + res.status }, { status: 502 });
    }
    if (json && json.errors) {
      console.warn("[stratz] gql errors:", JSON.stringify(json.errors).slice(0, 300));
    }
    return Response.json({ data: json ? json.data : null, source: "stratz" });
  } catch (e) {
    return Response.json({ error: "STRATZ 请求异常: " + (e as Error).message }, { status: 502 });
  }
});
