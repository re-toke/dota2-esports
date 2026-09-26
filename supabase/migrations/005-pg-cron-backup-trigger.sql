-- ============================================================
-- 005-pg-cron-backup-trigger.sql
-- P1-A（2026-09-26）：**互补触发** —— 用 Supabase `pg_cron` 唤醒 GitHub 的赛程同步工作流
--
-- ## 为什么需要（实测依据）
-- 调度目前 100% 押在 GitHub Actions，而 **scheduled workflow 在高峰期会被丢弃/延迟**：
--   · 本仓 `ef-health.yml` 声明「每 2 小时」，实际运行时刻为 04:52 / 23:16 / 18:32 / 13:42 / 07:43
--     ⇒ 实际间隔 5~7 小时（**远低于声明频率**）；
--   · `阶段6` 记录：曾"近 11 次全失败"，**9/18 才由人工检查发现**。
-- 本迁移让**数据库侧**在 GitHub 漏跑时补一次触发。
--
-- ## ⚠️ 诚实定性：**这是"互补触发"，不是"独立双轨"**
--   · 两个触发源唤醒的是**同一个 GitHub 工作流、同一套 Node 脚本**
--     ⇒ 只解决"**同一个任务被漏触发**"，**不解决**"GitHub 整体不可用"；
--   · 真"双轨"需把管道逻辑搬进 EF 由 `pg_cron` 直调 —— 该路线项目**已明确否决**
--     （`b5d228f Revert` + `bfe7c7f`「撤回不必要的 LP 迁移」）。
--   · 另注：`pg_cron` 自身也会静默失败（官方文档：`net.http_post` 是 fire-and-forget，
--     5xx 不重试、非 2xx 不告警；项目被暂停即整体停摆）⇒ **它不是"更可靠的调度器"**。
--
-- ## 前置（**需人工执行，不可自动完成**）
--   1. 建一个 GitHub **fine-grained PAT**，仅授予本仓库 `Contents: Read and write`（`repository_dispatch` 需要）
--      或 classic token 的 `repo` scope；
--   2. 存入 **Supabase Vault**（官方推荐，勿明文写进本文件）：
--        select vault.create_secret('<PAT>', 'github_dispatch_token', 'GitHub PAT for repository_dispatch');
--   3. 应用本迁移。**未配置该 secret 时本迁移是安全的 no-op**（见下方 DO 块），
--      绝不会因为没有 secret 而报错或建出朝空气发请求的 job。
--
-- ## 验证
--   · `select * from cron.job where jobname = 'upcoming-backup-dispatch';`
--   · `select status, return_message, start_time from cron.job_run_details
--        where jobid = (select jobid from cron.job where jobname='upcoming-backup-dispatch')
--        order by start_time desc limit 5;`
--   · 手动触发一次：`select cron.schedule('upcoming-backup-dispatch-once', '* * * * *', $$...$$)` 不推荐；
--     更简单的是直接在工作流页面用 workflow_dispatch 调试。
-- ============================================================

-- pg_cron / pg_net / Vault 均由 Supabase 提供（免费/Pro/Team 默认启用）。
-- ★ 逐层守护，且**不使用 `RETURN`**（PL/pgSQL 的 DO 块语义与函数不同，此处不依赖它），
--   保证在"PG 可跑但组件缺失/未配 secret"的任何组合下都**只提示、不报错**。
DO $$
DECLARE
  _has_cron boolean;
  _has_net  boolean;
  _has_vault boolean;
  _has_token boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') INTO _has_cron;
  SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net')  INTO _has_net;
  SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'vault') INTO _has_vault;
  -- ★ 只有 Vault 真存在时才去查 secret（否则整条语句会因 schema 缺失而报错）
  IF _has_vault THEN
    SELECT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'github_dispatch_token') INTO _has_token;
  ELSE
    _has_token := false;
  END IF;

  IF NOT (_has_cron AND _has_net AND _has_vault AND _has_token) THEN
    RAISE NOTICE '跳过创建互补触发 job：pg_cron=% pg_net=% vault=% token=%（按文件头部说明补齐后重跑本迁移即可）',
      _has_cron, _has_net, _has_vault, _has_token;
  ELSE
    -- 幂等：先清同名 job（cron.schedule 遇同名会报错）
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'upcoming-backup-dispatch') THEN
      PERFORM cron.unschedule('upcoming-backup-dispatch');
    END IF;

    -- GitHub 自家 cron 是 '0 3,15 * * *'；此处错开做**补偿**触发
    --（若 GH 那次被丢弃，这条会在 4:30 / 16:30 UTC 补唤醒）
    PERFORM cron.schedule(
      'upcoming-backup-dispatch',
      '30 4,16 * * *',
      $job$
        SELECT net.http_post(
          url := 'https://api.github.com/repos/re-toke/dota2-esports/dispatches',
          headers := jsonb_build_object(
            'Accept', 'application/vnd.github+json',
            'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'github_dispatch_token'),
            'Content-Type', 'application/json'
          ),
          body := jsonb_build_object('event_type', 'sync-upcoming-backup')
        );
      $job$
    );
    RAISE NOTICE 'pg_cron job upcoming-backup-dispatch 已创建（**互补触发**，非独立双轨）';
  END IF;
END $$;
