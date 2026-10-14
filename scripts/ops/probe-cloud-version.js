/*
 * ⚠️ 历史版本，勿用（DEPRECATED）
 * ----------------------------------------------------
 * 用途（历史）：判断 **微信云开发** aggregation 云函数是否已部署 432ae9b（2026-08-15）之后的版本。
 *   原探测依据：health 返回 data.ts+data.sources（新版）vs unknown action（旧版）；
 *   getUpcomingSchedule 冷缓存 fire-and-forget（cold+preheating:true）vs 现场预热（fresh）。
 *
 * ★★ 2026-09-22 微信云开发**已退役** ⇒ `wx.cloud.callFunction({name:'aggregation'})` 已不存在，
 *   且「云函数 432ae9b 前/后版本」之分**已无意义** ⇒ **本脚本已彻底失效**，
 *   若照旧文档指引在开发者工具运行只会得到误导结果。
 *
 * ✅ 现役替代（EF 时代）：`node scripts/ops/probe-ef.js`
 *   （探 EF `health` 等真实可达性 + 延迟阈值；失败 → 非零退出码，供 CI 判失败）；
 *   CI 定时探测 + 失败告警见 `.github/workflows/ef-health.yml`。
 *
 * 保留本文件仅为**历史存档**；请勿在开发者工具运行。
 */
(function () {
  console.error(
    '[probe-cloud-version] ⚠️ 历史版本，勿用：微信云开发已退役 ⇒ 云函数版本探测已无意义，本脚本失效。\n' +
    '  → 请改用 `node scripts/ops/probe-ef.js`（EF 可达性 + 延迟探测）。'
  );
})();
