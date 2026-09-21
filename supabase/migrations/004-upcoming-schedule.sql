-- ============================================================
-- 004-upcoming-schedule.sql
-- ★★ 微信云开发「彻底脱离」前置：把云函数缓存 `upcoming_schedule` 迁到 Supabase 表
--
-- 【背景】
--   客户端 `pages/leagues/leagues.js` 的「即将到来」有两条来源：
--     ① 云函数 `getUpcomingSchedule`（直接 wx.cloud.callFunction，不经 cloudProxy）
--        —— 实为「读云缓存 upcoming_schedule（TTL 6h） + 触发 preheatUpcoming 预热」的薄接口；
--     ② 本地预构建快照 `utils/upcoming-local.json`（随版本发布，滞后）。
--   两者**共用同一构造器** `buildUpcomingCard(entry, ctx)`，且条目字段集**完全一致**
--   （id/name/grade/rank/label/tier/start/end/source，本地快照多一个 `date` 原文串）。
--   ⇒ 把 ① 换成「Supabase 表 + PostgREST 直读」即可**等值替换**，客户端已有该能力。
--
-- 【写入方】GH Actions 的 `scripts/sync/fetch-liquipedia-upcoming.js`
--   通过 EF `admin-write` 的 `upsertUpcoming`（带 ADMIN_TOKEN）写入 —— 与
--   `scripts/ops/sync-curation-dates.js` 同一套路，**无需引入 service key**。
--
-- 【权限】公开数据（赛事名/赛期/分级），anon 可读；写走 service_role（EF 内），绕过 RLS。
--
-- 执行方式：Supabase Dashboard → SQL Editor → 粘贴执行（幂等，可重复跑）
-- ============================================================

create table if not exists public.upcoming_schedule (
  -- 以 leagueid 为主键：与客户端「lid」键一致（STRINGZ/LP 的负数占位 id 亦适用 bigint）
  league_id  bigint primary key,
  -- 条目本体：{ id, name, grade, rank, label, tier, start, end, source, date? }
  --   —— 直接存整体，避免与上游字段演进脱钩（客户端按 buildUpcomingCard 的读取面消费）
  data       jsonb  not null,
  updated_at timestamptz not null default now()
);

-- 客户端按「视野内的 start」筛选，加索引避免全表扫（当前约 16~30 行，仍是好习惯）
create index if not exists upcoming_schedule_start_idx
  on public.upcoming_schedule (((data->>'start')::bigint));

-- RLS：anon 只读（与 curation_events / curation_meta 同为策展公开数据）
alter table public.upcoming_schedule enable row level security;

drop policy if exists "anon_read_upcoming_schedule" on public.upcoming_schedule;
create policy "anon_read_upcoming_schedule" on public.upcoming_schedule
  for select to anon using (true);

-- ------------------------------------------------------------
-- 自查（执行后应能看到表已建好；数据由脚本或 EF 写入）
--   select count(*) from public.upcoming_schedule;
--
-- 验证 anon 可读（应返回 200；表为空时返回 []）
--   curl "$SUPABASE_URL/rest/v1/upcoming_schedule?select=data&limit=1" \
--        -H "apikey: $ANON_KEY"
-- ------------------------------------------------------------
