// ============================================================
// supabase/functions/smart-reminders/index.ts
// 替代云开发 handleSendSmartReminders（aggregation/index.js L2172-2225）
// 链路：客户端打开 App 时调用 → 读 follow_profile → 逐关注队查
//       OpenDota upcoming → 开赛倒计时 ≤ leadSec(默认1800s) → 推送
//       43101（订阅额度耗尽）→ 中断剩余队伍
// 验证：需真实 JWT + follow_profile 有 teams 数据
// ============================================================
import { verifyJwt, bearer, cors, db } from "../_shared/auth.ts";

function fmtTime(sec: number): string {
  const d = new Date(sec * 1000);
  const pad = (n: number) => (n < 10 ? "0" + n : "" + n);
  return `${d.getMonth() + 1}-${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 推一条：内部复用 subscribe-send（自带 token 缓存/日志） */
async function push(serviceUrl: string, serviceKey: string,
  touser: string, templateId: string, page: string, data: any) {
  const r = await fetch(`${serviceUrl}/functions/v1/subscribe-send`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // 用 service key 调自家 EF（subscribe-send 不验 JWT，靠内网调用）
      "Authorization": `Bearer ${serviceKey}`,
    },
    body: JSON.stringify({ touser, template_id: templateId, page, data }),
  });
  return r.json();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return cors();

  // 1. 验 JWT
  const openid = await verifyJwt(bearer(req), Deno.env.get("WX_APPSECRET")!);
  if (!openid) return Response.json({ errcode: 401, errmsg: "invalid token" }, { status: 401 });

  const { templateId, page } = await req.json().catch(() => ({}));
  if (!templateId) {
    return Response.json({ errcode: -1, errmsg: "templateId required" }, { status: 400 });
  }

  // 2. 读 follow_profile
  const client = await db();
  const { data } = await client.from("aggregation_cache")
    .select("payload, expire_at").eq("key", `follow_profile_${openid}`).maybeSingle();
  const profile = data && new Date(data.expire_at) > new Date() ? data.payload : null;
  if (!profile || !profile.teams || !profile.teams.length) {
    return Response.json({ ok: true, sent: 0, skipped: 0, failed: 0, reason: "empty_profile" });
  }

  // 3. 订阅授权检查（对齐审核 R4：subs 有值才校验，老用户兼容）
  const subs = profile.subs;
  if (subs && subs[String(templateId)] && subs[String(templateId)].subscribed !== true) {
    return Response.json({ ok: true, sent: 0, skipped: profile.teams.length, failed: 0, reason: "sub_not_authorized" });
  }

  const strategy = profile.strategy || { leadSec: 1800, tiers: ["SSS", "S", "A"] };
  const now = Math.floor(Date.now() / 1000);
  const serviceUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  let sent = 0, skipped = 0, failed = 0;

  // 4. 逐队查 OpenDota upcoming，时间窗判断后推送
  for (const tid of profile.teams) {
    let ms: any = null;
    try {
      const r = await fetch(`https://api.opendota.com/api/teams/${tid}/matches`);
      ms = await r.json();
    } catch { /* 网络失败按 skipped 处理 */ }
    if (!ms || !ms.length) { skipped++; continue; }

    const m = ms.filter((x: any) => x.start_time > now)
      .sort((a: any, b: any) => a.start_time - b.start_time)[0];
    if (!m) { skipped++; continue; }
    if (m.start_time - now > (strategy.leadSec || 1800)) { skipped++; continue; }

    const result = await push(serviceUrl, serviceKey, openid, String(templateId),
      String(page || "pages/index/index"), {
        // TODO(M2.5)：接入 canonicalLeagueNameWithCtx 赛事名规范化（从 utils/consensus.js 移植）
        thing1: { value: String(m.league_name || "").slice(0, 20) },
        thing2: { value: fmtTime(m.start_time) },
        thing6: { value: `${m.radiant_name || "天辉"} VS ${m.dire_name || "夜魇"}`.slice(0, 20) },
        thing5: { value: "即将开始，别错过" },
      });

    const code = result.errcode ?? (result.msgid ? 0 : -1);
    if (code === 0) { sent++; continue; }
    // 43101 = 一次性订阅额度耗尽 → 中断剩余（对齐 R4，防失败刷屏）
    if (code === 43101) break;
    failed++;
  }

  return Response.json({ ok: true, sent, skipped, failed });
});
