// ============================================================
// supabase/functions/wechat-auth/index.ts
// 替代云开发 getOpenId：wx.login 的 code → openid + 业务 JWT
// 验证：curl -X POST .../functions/v1/wechat-auth -d '{"code":"test"}'
//       预期返回微信真实 errcode（如 40029 invalid code）= 链路通
// ============================================================
import { makeJwt, cors, db } from "../_shared/auth.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return cors();

  const { code } = await req.json().catch(() => ({ code: "" }));
  if (!code) {
    return Response.json({ errcode: -1, errmsg: "missing code" }, { status: 400 });
  }

  // 1. code 换 openid（微信标准接口）
  const wxResp = await fetch(
    `https://api.weixin.qq.com/sns/jscode2session` +
    `?appid=${Deno.env.get("WX_APPID")}` +
    `&secret=${Deno.env.get("WX_APPSECRET")}` +
    `&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`
  );
  const wxData = await wxResp.json();
  if (!wxData.openid) {
    // 微信返回 errcode（40029 code 无效 / 45011 频率限制等）——直接透传给客户端
    return Response.json({
      errcode: wxData.errcode ?? -1,
      errmsg: wxData.errmsg ?? "jscode2session failed",
    });
  }
  const openid: string = wxData.openid;

  // 2. users 表 upsert
  const client = await db();
  await client.from("users").upsert(
    { openid, last_login_at: new Date().toISOString() },
    { onConflict: "openid" }
  );

  // 3. 签发业务 JWT（客户端存 dota2_jwt，后续调 follow-profile / smart-reminders 时带上）
  const token = await makeJwt(openid, Deno.env.get("WX_APPSECRET")!);

  return Response.json({ errcode: 0, openid, token });
});
