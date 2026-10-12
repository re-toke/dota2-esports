-- ============================================================
-- 006-indexes.sql
-- P1-11（2026-10-12）：补两处缺失索引（**纯加索引，无数据/结构变更**）
--
-- 【缺口 1 · curation_events 版本探针全表扫】
--   客户端「廉价版本探针」的回退路径每次启动都会跑（`utils/remoteCuration.js:329`）：
--     select data->>updatedAt
--       from curation_events
--      order by data->>updatedAt desc nulls last
--      limit 1
--   该查询**无表达式索引** ⇒ 全表扫 + 排序（当前 2400+ 行且随 curation 只增）。
--   修复：建表达式索引，且**排序方向与空值序必须与查询逐字对齐**
--     （`DESC NULLS LAST` —— PG 的 DESC 默认是 NULLS FIRST，不写就对不上、索引白建）。
--
-- 【缺口 2 · aggregation_cache 按 updated_at 观测/清理】
--   001 已建 `idx_agg_cache_expire`（按 expire_at，过期清理用）。但按 updated_at 做
--   「最近写入」观测/清理时无索引 ⇒ 顺序扫。
--
-- 幂等：CREATE INDEX IF NOT EXISTS。执行：Dashboard → SQL Editor → 粘贴执行。
-- 验证：EXPLAIN (ANALYZE, BUFFERS) <上述探针查询> 应出现 Index Scan / Index Only Scan。
-- ============================================================

CREATE INDEX IF NOT EXISTS ix_curation_events_updated_at
  ON public.curation_events (((data->>'updatedAt')) DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS ix_agg_cache_updated_at
  ON public.aggregation_cache (updated_at);

-- 验证 SQL（单独执行）：
--   EXPLAIN (ANALYZE, BUFFERS)
--     SELECT data->>'updatedAt' FROM public.curation_events
--      ORDER BY data->>'updatedAt' DESC NULLS LAST LIMIT 1;   -- 期望 Index Only Scan
