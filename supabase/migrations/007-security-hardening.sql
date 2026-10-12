-- ============================================================
-- 007-security-hardening.sql
-- P1-12（2026-10-12）：`keep_alive` 写入口收紧 —— **加列约束 + 触发频率限制**
--
-- 【问题】001-init.sql:112-115 给 anon 开了 `INSERT WITH CHECK (true)`。
--   anon key 是**公开键**（本就随客户端分发）⇒ 任何人可无限往 keep_alive 刷行（存储膨胀 / 刷表）。
--
-- 【不改什么（D10 硬约束）】该 anon INSERT **正是 cron-job.org 的保活手段**（001:112 注释）。
--   收紧时**绝不能误伤保活** —— 否则 Supabase 免费项目可能因「长期无流量」被暂停
--   （`005` 头注亦提示该风险）。⇒ **保留** anon INSERT 策略本身，只做两件不影响正常保活的事：
--     ① 列约束：`source` 只允许固定值；cron-job.org 的 POST **不带 source** ⇒ 走列默认值 ⇒ 仍通过；
--     ② 频率限制触发器：滚动 1 小时窗口内最多 12 行（保活实际 ≈ 1 行/3 天 ⇒ 余量约 860×）。
--
-- 【影响面】正常保活完全不受影响；滥用被限制在 ≤ 12 行/小时。
-- 幂等：DROP ... IF EXISTS / CREATE OR REPLACE。
-- 执行：Dashboard → SQL Editor → 粘贴执行。
-- 验证：`select count(*) from public.keep_alive;`（应 ≈ 保活次数）；
--       连插 13 行应第 13 行报 `keep_alive 写入频率超限`。
-- ============================================================

-- ① 先把历史 NULL 归一到默认值（否则下方 CHECK 约束会因存量行不满足而添加失败）
UPDATE public.keep_alive SET source = 'cron-job.org' WHERE source IS NULL;

-- ② 列约束：source 只允许白名单（默认值即此 ⇒ 不带 source 的保活 POST 依然通过）
ALTER TABLE public.keep_alive DROP CONSTRAINT IF EXISTS keep_alive_source_allowlist;
ALTER TABLE public.keep_alive
  ADD CONSTRAINT keep_alive_source_allowlist CHECK (source = 'cron-job.org');

-- ③ 频率限制触发器
--   ★ 必须 SECURITY DEFINER：anon 对 keep_alive **没有 SELECT 策略** ⇒ 以调用者身份 count(*) 恒为 0、
--     限流形同虚设。以函数属主（迁移执行者 / postgres，表属主不受 RLS 约束）身份计数才有效。
--   ★ 显式 `SET search_path` 防 search_path 注入（SECURITY DEFINER 的必备写法）。
CREATE OR REPLACE FUNCTION public.keep_alive_throttle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _n integer;
BEGIN
  SELECT count(*) INTO _n FROM public.keep_alive WHERE ping_at > now() - interval '1 hour';
  IF _n >= 12 THEN
    RAISE EXCEPTION 'keep_alive 写入频率超限（>12/小时）：疑似刷表';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_keep_alive_throttle ON public.keep_alive;
CREATE TRIGGER trg_keep_alive_throttle
  BEFORE INSERT ON public.keep_alive
  FOR EACH ROW EXECUTE FUNCTION public.keep_alive_throttle();

-- ④ 复核 anon 写策略**仍在**（保活路径不能被本迁移打断）
--   select policyname, cmd, roles from pg_policies
--    where tablename = 'keep_alive';   -- 期望仍有 anon_insert_keep_alive (INSERT / {anon})
