// ============================================================
// supabase/functions/admin-write/index.ts
// 管理后台写入口（2026-09-14 · 阶段2-⑤）
//
// ## 为什么需要它
// 管理后台（admin/）原来把写操作经微信云函数 adminWriteCuration 中转。
// 云开发退场后必须换出口。**不能**让前端直连数据库写：
//   · anon 无权写（RLS 只给了读）
//   · service key 放进浏览器 = 泄露 + 绕过 RLS = 数据库全权外泄
// 所以走 EF：service key 只存在于 EF 的 env（服务端），前端只持有管理令牌。
//
// ## 鉴权
//   请求头 `x-admin-token` 必须等于 EF 环境变量 `ADMIN_TOKEN`。
//   （令牌放前端 .env.local 的 VITE_ADMIN_TOKEN；EF 侧用 supabase secrets set ADMIN_TOKEN=...）
//
// ## 支持的 operation（与前端 api 层一一对应）
//   upsertEvent  { data }   → curation_events（canonical_key = 归一化 canonical）
//   deleteEvent  { docId }  → curation_events（按 canonical_key）
//   upsertTeam   { data }   → curation_teams（team_id）
//   deleteTeam   { docId }  → curation_teams（按 team_id）
//   updateMeta   { data }   → curation_meta（key = 'ti_contestant_ids'）
//
// ## 与云函数 adminWriteCuration 的差异
//   · version 重算：不再持久化。客户端迁到 Supabase 直读后（阶段2-③B），
//     version 是派生值（'sb:' + 条数），不再依赖此字段。
//   · admin-logs：改写入 Supabase 的 admin_logs 表（云开发是 admin-logs 集合）。
// ============================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-admin-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

/** 与小程序/云函数一致的赛事名归一化（用作 canonical_key） */
function normalizeEventName(name: string): string {
  if (!name) return '';
  return String(name).toLowerCase().replace(/[^a-z0-9一-鿿а-яё]/g, '').replace(/^the/, '');
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ success: false, error: { message: 'POST only' } }, 405);

  // ---- 鉴权 ----
  const expect = Deno.env.get('ADMIN_TOKEN') || '';
  const got = req.headers.get('x-admin-token') || '';
  if (!expect) return json({ success: false, error: { code: 'NO_TOKEN_CONFIGURED', message: 'EF 未配置 ADMIN_TOKEN' } }, 500);
  if (got !== expect) return json({ success: false, error: { code: 'UNAUTHORIZED', message: '管理令牌无效' } }, 401);

  // ---- 解析 ----
  let body: any = null;
  try { body = await req.json(); } catch { return json({ success: false, error: { message: 'body 非 JSON' } }, 400); }
  const operation = String(body?.operation || '');
  const params = body?.params || {};

  const url = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const db = createClient(url, serviceKey, { auth: { persistSession: false } });

  const logRow = async (detail: Record<string, unknown>) => {
    try {
      await db.from('admin_logs').insert({
        action: 'admin_write',
        operator: 'admin-web',
        details: { operation, ...detail },
      });
    } catch { /* 静默：日志失败不影响主流程（与云函数行为一致） */ }
  };

  // ★★ 2026-09-20：**bump 全局 curation 版本**（客户端「廉价探针」用）
  //
  // 背景：客户端 `remoteCuration.load()` 的早退条件是「缓存是否过期」而非「版本是否一致」，
  //   且只有云函数兜底路径才比版本 → curation 改动后热客户端最多滞后 6h（只能靠用户清缓存）。
  //   客户端现改为：早退前**单行读**本品版本号（~200B），变了才重新拉取。
  //
  // 为什么放在这里（而不是让客户端去算）：admin_logs 对 anon 不可读，无法作为探针；
  //   而 `curation_events.data.updatedAt` 只能覆盖 upsert，**覆盖不到 deleteEvent / upsertTeam / updateMeta**。
  //   本函数在**任何**成功写入后 bump `curation_meta.key='version'` → 探针即可覆盖全部变更类型。
  //   ⚠️ 客户端另有回退路径（读 curation_events 的最大 updatedAt），故**本 EF 未部署时也不会失效**，
  //      只是覆盖范围退化为「仅 upsert」。
  const bumpCurationVersion = async () => {
    try {
      await db.from('curation_meta').upsert(
        { key: 'version', value: { v: Date.now() }, updated_at: new Date().toISOString() },
        { onConflict: 'key' }
      );
    } catch { /* 静默：版本 bump 失败不影响主流程（客户端会回退到 events 探针） */ }
  };

  // 每次成功写入后统一收口：落 admin_logs + bump 全局 curation 版本（探针用）。
  const afterWrite = async (detail: Record<string, unknown>) => {
    await logRow(detail);
    await bumpCurationVersion();
  };

  try {
    switch (operation) {
      case 'upsertEvent': {
        const data = params.data || {};
        if (!data.canonical) return json({ success: false, error: { message: 'canonical 必填' } }, 400);
        const key = normalizeEventName(data.canonical);
        if (!key) return json({ success: false, error: { message: 'canonical 归一化后为空' } }, 400);
        const row = {
          canonical_key: key,
          league_id: data.leagueId != null ? Number(data.leagueId) : null,
          data: { ...data, updatedAt: Date.now() },
        };
        const { error } = await db.from('curation_events').upsert(row, { onConflict: 'canonical_key' });
        if (error) throw error;
        await afterWrite({ table: 'curation_events', key, op: 'upsert' });
        return json({ success: true, version: 'v' + Date.now(), source: 'supabase' });
      }

      case 'deleteEvent': {
        const key = String(params.docId || '');
        if (!key) return json({ success: false, error: { message: 'docId 必填' } }, 400);
        const { error } = await db.from('curation_events').delete().eq('canonical_key', key);
        if (error) throw error;
        await afterWrite({ table: 'curation_events', key, op: 'delete' });
        return json({ success: true, version: 'v' + Date.now(), source: 'supabase' });
      }

      case 'upsertTeam': {
        const data = params.data || {};
        const tid = Number(data.team_id != null ? data.team_id : data._id);
        if (!tid || isNaN(tid)) return json({ success: false, error: { message: 'team_id 必填且为数字' } }, 400);
        const clean = { ...data, updatedAt: Date.now() };
        delete clean.team_id; delete clean._id;
        const row = { team_id: tid, data: clean };
        const { error } = await db.from('curation_teams').upsert(row, { onConflict: 'team_id' });
        if (error) throw error;
        await afterWrite({ table: 'curation_teams', key: String(tid), op: 'upsert' });
        return json({ success: true, version: 'v' + Date.now(), source: 'supabase' });
      }

      case 'deleteTeam': {
        const tid = Number(params.docId);
        if (!tid || isNaN(tid)) return json({ success: false, error: { message: 'docId 必须为数字 team_id' } }, 400);
        const { error } = await db.from('curation_teams').delete().eq('team_id', tid);
        if (error) throw error;
        await afterWrite({ table: 'curation_teams', key: String(tid), op: 'delete' });
        return json({ success: true, version: 'v' + Date.now(), source: 'supabase' });
      }

      // ★ 2026-09-21：「即将到来」赛程表 —— 微信云开发脱离前置。
      //   替代云函数 getUpcomingSchedule 的「读缓存」接口（该接口实为「读云缓存 + 触发预热」的薄壳）。
      //   集合语义：先整批 upsert，再删除**不在本次集合中**的旧行（避免下架赛事残留在表里）。
      //   ⚠️ entries 为空时直接 400 —— 否则会把整表清空（幂等脚本的经典误伤）。
      case 'upsertUpcoming': {
        const entries = Array.isArray(params.entries) ? params.entries : [];
        if (!entries.length) {
          return json({ success: false, error: { message: 'entries 不能为空（避免误清空整表）' } }, 400);
        }
        const rows = entries
          .map((e) => ({ league_id: Number(e && e.id), data: e, updated_at: new Date().toISOString() }))
          .filter((r) => Number.isFinite(r.league_id));
        if (!rows.length) {
          return json({ success: false, error: { message: 'entries 缺少有效 id' } }, 400);
        }
        const { error } = await db.from('upcoming_schedule').upsert(rows, { onConflict: 'league_id' });
        if (error) throw error;
        // 清理不在本次集合中的行（保持「集合」语义）
        const ids = rows.map((r) => r.league_id);
        const { error: delErr } = await db
          .from('upcoming_schedule')
          .delete()
          .not('league_id', 'in', '(' + ids.join(',') + ')');
        if (delErr) throw delErr;
        await afterWrite({ table: 'upcoming_schedule', key: 'n=' + rows.length, op: 'upsert' });
        return json({ success: true, count: rows.length, source: 'supabase' });
      }

      case 'updateMeta': {
        const data = params.data || {};
        const { error } = await db.from('curation_meta').upsert(
          { key: 'ti_contestant_ids', value: data, updated_at: new Date().toISOString() },
          { onConflict: 'key' },
        );
        if (error) throw error;
        await afterWrite({ table: 'curation_meta', key: 'ti_contestant_ids', op: 'upsert' });
        return json({ success: true, version: 'v' + Date.now(), source: 'supabase' });
      }

      default:
        return json({ success: false, error: { code: 'BAD_OPERATION', message: '未知 operation: ' + operation } }, 400);
    }
  } catch (e) {
    return json({ success: false, error: { code: 'WRITE_FAILED', message: (e as Error)?.message || String(e) } }, 500);
  }
});
