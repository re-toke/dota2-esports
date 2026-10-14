/*
 * ⚠️ 历史版本，勿用（DEPRECATED）
 * ----------------------------------------------------
 * 用途（历史）：验证 **微信云开发** aggregation 云函数是否已部署 O-26 鉴权守卫（2026-08-15）。
 *   原探测三层：getCached 非白名单前缀应 forbidden / follow_profile_ 前缀应放行 /
 *   非管理员 adminWriteCuration 应 forbidden。
 *
 * ★★ 2026-09-22 微信云开发**已退役**（`cloudfunctions/` 已删除、`app.js` 不再 init）⇒
 *   本脚本依赖的 `wx.cloud.callFunction({name:'aggregation'})` 与 `getCached` /
 *   `adminWriteCuration` 等 action **均已不存在** ⇒ **本脚本已彻底失效**，
 *   若照旧文档指引在开发者工具运行只会得到误导结果。
 *
 * ✅ 现役替代（EF 时代）：
 *   · 健康 + 鉴权可达性：`node scripts/ops/probe-ef.js`
 *     （覆盖 wechat-auth / opendota-proxy / liquipedia-proxy / follow-profile /
 *      subscribe-send / bundle-aggregator / haglund-proxy；`follow-profile` 无 JWT 返回 401 即鉴权生效）
 *   · EF 契约静态守卫：`node scripts/ops/check-ef-contract.js`
 *   · CI 定时探测 + 失败告警：`.github/workflows/ef-health.yml`
 *
 * 保留本文件仅为**历史存档**；请勿在开发者工具运行。
 */
(function () {
  console.error(
    '[probe-auth-guard] ⚠️ 历史版本，勿用：微信云开发已退役 ⇒ 云函数 action 已不存在，本脚本失效。\n' +
    '  → 请改用 `node scripts/ops/probe-ef.js`（EF 健康 + 鉴权探测），CI 侧见 ef-health.yml。'
  );
})();
