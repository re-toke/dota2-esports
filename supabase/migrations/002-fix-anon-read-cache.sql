-- ============================================================
-- 002-fix-anon-read-cache.sql
-- ★★ 安全修复（2026-09-12）：aggule_cache 的 anon 策略过宽，导致用户画像越权可读
--
-- 【问题】
--   001-init.sql 中：
--     CREATE POLICY "anon_read_cache" ON public.aggregation_cache
--       FOR SELECT TO anon USING (true);
--   `USING (true)` = **全表可读**。而该表同时存着 `follow_profile_<openid>`（用户的
--   关注战队、提醒策略、订阅授权状态）。
--   由于 anon key 随小程序分发包一同下发（utils/config.js），**任何人都能**：
--     curl 'https://<proj>.supabase.co/rest/v1/aggregation_cache?select=*&key=like.follow_profile_*' \
--          -H 'apikey: <anon key>'
--   → dump 全量用户关注画像。**实测确认可读到真实用户行**（2026-09-12）。
--
-- 【修复】
--   把 anon 的读范围收敛为「仅公开缓存」：排除用户画像前缀。
--   EF（follow-profile 等）用 service_role 调用，绕过 RLS，**不受影响**。
--
-- 【影响面】
--   · 公开缓存（lp:w:*、od:*、search_index、teams_hot、teams_search 等）仍可 anon 读
--     → 这也是「通用 KV 迁 Supabase 直读」方案的前提
--   · follow_profile_* 仅 service_role 可读 → 用户画像不再外泄
--
-- 执行方式：Supabase Dashboard → SQL Editor → 粘贴执行（幂等，可重复跑）
-- ============================================================

-- 1) 删除过宽策略
DROP POLICY IF EXISTS "anon_read_cache" ON public.aggregation_cache;

-- 2) 重建为「仅公开缓存」策略
--    排除用户级数据前缀：follow_profile_（关注画像）
--    注：新增用户级前缀时，必须同步加入此排除列表
CREATE POLICY "anon_read_public_cache" ON public.aggregation_cache
  FOR SELECT TO anon
  USING (
    key NOT LIKE 'follow_profile_%'
    AND key NOT LIKE 'user_%'
    AND key NOT LIKE 'private_%'
  );

-- 3) 自查（执行后应返回 0 行）
--    SELECT count(*) AS leaked FROM public.aggregation_cache
--    WHERE key LIKE 'follow_profile_%';
--    ↑ 注意：此查询用 service_role/owner 跑仍会返回真实数量（RLS 对 owner 不生效），
--      要验证「anon 读不到」请用 anon key 走 REST 验证：
--      curl "$SUPABASE_URL/rest/v1/aggregation_cache?select=key&key=like.follow_profile_*&limit=1" \
--           -H "apikey: $ANON_KEY"
--      期望：返回 [] （修复前返回用户行）

-- 4) 附：其他表策略复核（001-init.sql 同为 USING (true)，但其表内无用户级数据，暂可保留）
--    curation_events / curation_teams / curation_meta —— 均为策展公开数据
