-- ============================================================
-- 001-init.sql —— dota2-esports Supabase 全量建表（v2）
-- 用法：Supabase Dashboard → SQL Editor → New query → 全文粘贴 → Run
-- 验证：Run 成功后执行文件末尾的验证 SQL，应返回 9 张表
-- ============================================================

-- ---------- 1. 迁移表（数据来自微信云数据库）----------

-- L2 缓存（对应云集合 aggregation_cache，follow_profile_* 也在里面）
CREATE TABLE IF NOT EXISTS public.aggregation_cache (
  key text PRIMARY KEY,
  payload jsonb NOT NULL,
  expire_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agg_cache_expire ON public.aggregation_cache(expire_at);

-- 赛事 curation（对应 curation_events）
CREATE TABLE IF NOT EXISTS public.curation_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  league_id bigint NOT NULL UNIQUE,
  data jsonb NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 战队 curation（对应 curation_teams）
CREATE TABLE IF NOT EXISTS public.curation_teams (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  team_id bigint NOT NULL UNIQUE,
  data jsonb NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 元数据（对应 curation_meta）
CREATE TABLE IF NOT EXISTS public.curation_meta (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 管理日志（对应 admin-logs）
CREATE TABLE IF NOT EXISTS public.admin_logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  action text NOT NULL,
  detail jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- 2. 新增表（微信能力替代）----------

-- 用户（wechat-auth 写入）
CREATE TABLE IF NOT EXISTS public.users (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  openid text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz NOT NULL DEFAULT now()
);

-- 微信 access_token 缓存（全局每 AppID 一份，7200s 有效）
CREATE TABLE IF NOT EXISTS public.wechat_tokens (
  appid text PRIMARY KEY,
  access_token text NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 订阅推送日志
CREATE TABLE IF NOT EXISTS public.subscribe_logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  openid text,
  template_id text,
  errcode int,
  errmsg text,
  msgid bigint,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 保活表（cron-job.org 每 3 天 POST 一行）
CREATE TABLE IF NOT EXISTS public.keep_alive (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ping_at timestamptz NOT NULL DEFAULT now(),
  source text DEFAULT 'cron-job.org'
);

-- ---------- 3. RLS ----------
-- 原则：公开数据 anon 只读；其余表不建 anon 策略 = 只有 service_role 能读写（Edge Function 用）。

ALTER TABLE public.aggregation_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_read_cache" ON public.aggregation_cache
  FOR SELECT TO anon USING (true);

ALTER TABLE public.curation_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_read_events" ON public.curation_events
  FOR SELECT TO anon USING (true);

ALTER TABLE public.curation_teams ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_read_teams" ON public.curation_teams
  FOR SELECT TO anon USING (true);

ALTER TABLE public.curation_meta ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_read_meta" ON public.curation_meta
  FOR SELECT TO anon USING (true);

-- admin_logs / users / wechat_tokens / subscribe_logs：只 ENABLE，不建 anon 策略
ALTER TABLE public.admin_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wechat_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscribe_logs ENABLE ROW LEVEL SECURITY;

-- keep_alive：允许 anon 插入（cron-job.org 用 anon key POST）
ALTER TABLE public.keep_alive ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_insert_keep_alive" ON public.keep_alive
  FOR INSERT TO anon WITH CHECK (true);

-- ---------- 4. 定时任务（v1.1 修正：pg_cron 扩展在部分免费项目不可用）----------
--
-- 原方案用 pg_cron 做缓存/日志清理。实测报错：
--   ERROR 0A000: extension "cron" is not available
-- 替代方案（全部不依赖 pg_cron）：
--   ① 清理任务：改为「读取时惰性跳过 + 每周手动跑一次清理 SQL」（见下方 CLEANUP.sql 注释）
--   ② refresh-wx-token 定时预热：在 cron-job.org 加第 2 个 Job（每小时 GET 一次 EF），
--      复用已有账号，零新增依赖
--   ③ 未来若需要服务端扫描类任务：Supabase Dashboard → Edge Functions → 选函数 →
--      Schedules 页签可直接配置定时（免费版可用）
--
-- 每周清理 SQL（周日晚手动跑一次，或加进 cron-job.org 提醒）：
--   DELETE FROM public.aggregation_cache WHERE expire_at < now();
--   DELETE FROM public.subscribe_logs    WHERE created_at < now() - interval '30 days';
-- ============================================================
-- 验证（单独执行）：
--   SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1;
-- 预期 9 行：admin_logs, aggregation_cache, curation_events,
--           curation_meta, curation_teams, keep_alive,
--           subscribe_logs, users, wechat_tokens
-- ============================================================
