// ============================================================
// supabase/functions/subscribe-send/index.ts
// 替代云开发 sendSubscribeMessage：调微信 cgi-bin/message/subscribe/send
// 含 access_token 缓存（wechat_tokens 表）+ 40001 失效自动重刷一次
// 验证：curl -X POST .../functions/v1/subscribe-send \
//         -d '{"touser":"fake","template_id":"T","data":{"thing1":{"value":"x"}}}'
//       预期 {"errcode":43004,...}（openid 无效）= 链路通
// ============================================================
import { cors, db } from "../_shared/auth.ts";

const WX_API = "https://api.weixin.qq.com";

/** 取 access_token：缓存有效（余量>5min）直接用；否则刷新并写回 */
async function getAccessToken(client: any, appid: string, force = false): Promise<string | null> {
  if (!force) {
    const { data: row } = await client
      .from("wechat_tokens").select("access_token, expires_at")
      .eq("appid", appid).maybeSingle();
    if (row && new Date(row.expires_at) > new Date(Date.now() + 5 * 60 * 1000)) {
      return row.access_token;
    }
  }
  const resp = await fetch(
    `${WX_API}/cgi-bin/token?grant_type=client_credential` +
    `&appid=${appid}&secret=${Deno.env.get("WX_APPSECRET")}`
  );
  const data = await resp.json();
  if (!data.access_token) {
    console.error("token refresh failed", JSON.stringify(data));
    return null;
  }
  await client.from("wechat_tokens").upsert({
    appid,
    access_token: data.access_token,
    expires_at: new Date(Date.now() + ((data.expires_in || 7200) - 120) * 1000).toISOString(),
  }, { onConflict: "appid" });
  return data.access_token;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return cors();

  const body = await req.json().catch(() => null);
  const { touser, template_id, page, data: tmplData, miniprogram_state } = body || {};
  if (!touser || !template_id || !tmplData) {
    return Response.json({ errcode: -1, errmsg: "missing touser/template_id/data" }, { status: 400 });
  }

  const client = await db();
  const appid = Deno.env.get("WX_APPID")!;
  let token = await getAccessToken(client, appid);
  if (!token) return Response.json({ errcode: -1, errmsg: "cannot obtain access_token" });

  const doSend = async (tk: string) => {
    const r = await fetch(`${WX_API}/cgi-bin/message/subscribe/send?access_token=${tk}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        touser,
        template_id,
        // ★ 微信 HTTPS 接口 page 不带前导斜杠（云开发路径才带 /）
        page: String(page || "pages/index/index").replace(/^\//, ""),
        miniprogram_state: miniprogram_state || "formal",
        lang: "zh_CN",
        data: tmplData,
      }),
    });
    return r.json();
  };

  let result = await doSend(token);

  // token 中途被其他端刷失效 → 强制重刷一次再发
  if (result.errcode === 40001 || result.errcode === 42001) {
    token = await getAccessToken(client, appid, true);
    if (token) result = await doSend(token);
  }

  // 记日志（含失败）
  await client.from("subscribe_logs").insert({
    openid: touser,
    template_id,
    errcode: result.errcode ?? 0,
    errmsg: result.errmsg ?? "",
    msgid: result.msgid ?? null,
  });

  return Response.json(result);
});
