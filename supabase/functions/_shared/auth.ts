// ============================================================
// supabase/functions/_shared/auth.ts —— JWT 签发/验证（共享模块）
// 密钥用 WX_APPSECRET（也可单独设 JWT_SECRET）
// ============================================================

const b64url = (s: string) =>
  btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function hmacSign(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 签发业务 JWT（30 天有效） */
export async function makeJwt(openid: string, secret: string): Promise<string> {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(JSON.stringify({ openid, iat: now, exp: now + 30 * 24 * 3600 }));
  const sig = await hmacSign(secret, `${header}.${payload}`);
  return `${header}.${payload}.${sig}`;
}

/** 验证 JWT，成功返回 openid，失败返回 null */
export async function verifyJwt(token: string, secret: string): Promise<string | null> {
  const parts = (token || "").split(".");
  if (parts.length !== 3) return null;
  try {
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const sigBytes = Uint8Array.from(
      atob(parts[2].replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
    const ok = await crypto.subtle.verify(
      "HMAC", key, sigBytes, new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    if (!ok) return null;
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
    return payload.exp > Math.floor(Date.now() / 1000) ? String(payload.openid) : null;
  } catch {
    return null;
  }
}

/** 从请求头提取 Bearer token */
export function bearer(req: Request): string {
  return (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
}

/** 跨域预检响应（小程序 wx.request 不需要，浏览器调试用） */
export function cors(): Response {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, content-type",
    },
  });
}

/** 拿一个带 service_role 的 Supabase 客户端 */
export async function db() {
  const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
}
