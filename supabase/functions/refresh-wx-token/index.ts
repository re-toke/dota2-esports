// ============================================================
// supabase/functions/refresh-wx-token/index.ts
// pg_cron 每小时调用：预热 access_token，避免推送时临时刷新失败
// 验证：curl .../functions/v1/refresh-wx-token → {"ok":true}
//       SQL: SELECT * FROM wechat_tokens; 应有一行
// ============================================================
import { cors, db } from "../_shared/auth.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return cors();

  const client = await db();
  const appid = Deno.env.get("WX_APPID")!;

  const resp = await fetch(
    `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential` +
    `&appid=${appid}&secret=${Deno.env.get("WX_APPSECRET")}`
  );
  const data = await resp.json();
  if (!data.access_token) {
    return Response.json({ ok: false, detail: data });
  }

  await client.from("wechat_tokens").upsert({
    appid,
    access_token: data.access_token,
    expires_at: new Date(Date.now() + ((data.expires_in || 7200) - 120) * 1000).toISOString(),
  }, { onConflict: "appid" });

  return Response.json({ ok: true });
});
