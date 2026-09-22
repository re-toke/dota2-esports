-- ============================================================
-- 003-curation-schema-fix.sql
-- 修正 curation_events 唯一键设计（2026-09-13）
--
-- 【问题】
-- 001-init.sql 的设计与云开发真实数据不匹配：
--     CREATE TABLE curation_events (id bigint, league_id bigint NOT NULL UNIQUE, data jsonb);
--                                                        ↑ 唯一键是 league_id
-- 但实测（2414 条真实数据）：
--     · 云开发 _id 是【归一化名字符串】，如 'theinternational2025'
--     · canonical 是展示名，如 'The International 2025'
--     · 只有 1600/2414 条有 leagueId（34% 没有）→ NOT NULL 会直接插入失败
--
-- 【修复】
--   1. 新增 canonical_key（存放云开发的 _id，作为真正的业务唯一键）
--   2. league_id 改为可空（34% 条目本就没有）
--   3. canonical_key 建唯一索引（backfill 的 upsert 目标）
--
-- 【风险】
--   三张表当前均为 **空表**（已实测 0 行），故本迁移无数据风险。
--
-- 执行方式：Supabase Dashboard → SQL Editor → 粘贴执行（幂等）
-- ============================================================

-- 1) 新增业务唯一键
ALTER TABLE public.curation_events
  ADD COLUMN IF NOT EXISTS canonical_key text;

-- 2) league_id 改为可空（真实数据 34% 无此字段）
ALTER TABLE public.curation_events
  ALTER COLUMN league_id DROP NOT NULL;

-- 3) 唯一索引（backfill 的 upsert 冲突目标）
CREATE UNIQUE INDEX IF NOT EXISTS ux_curation_events_canonical
  ON public.curation_events (canonical_key);

-- 4) 便于按年份/状态筛选（客户端「按需拉」要用）
CREATE INDEX IF NOT EXISTS ix_curation_events_year
  ON public.curation_events (((data->>'year')));

CREATE INDEX IF NOT EXISTS ix_curation_events_status
  ON public.curation_events (((data->>'status')));

-- 5) curation_teams：team_id 已是 bigint UNIQUE（001-init 已建），无需改动
-- 6) curation_meta：确认有 key 列
--    （001-init 建的是 (key text PRIMARY KEY, data jsonb)，此处仅确保存在）
ALTER TABLE public.curation_meta
  ADD COLUMN IF NOT EXISTS key text;

-- 7) 校验（执行后可用）：
--    SELECT count(*) FROM public.curation_events;               -- 迁移前应为 0
--    SELECT column_name, is_nullable FROM information_schema.columns
--     WHERE table_name='curation_events';
