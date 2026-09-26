// supabase/functions/_shared/lp-ua.ts
// ★★ 2026-09-26（P0-E-1）：Liquipedia User-Agent 的**EF 侧单一来源**。
//
// 背景同 `utils/lp-ua.js` 的说明：伪装浏览器 UA 违反 Liquipedia API ToS
// （要求「标识项目 + 含联系方式」，违规可致 IP 封禁），本项目 v8.19 起的历史包袱。
// EF 跑 Deno，无法 require 客户端的 CommonJS 文件 ⇒ 本文件是与
// `utils/lp-ua.js` 的**镜像**；一致性由 `scripts/test/test-sources.js` 的守卫断言
// （逐字比对两文件）保证，防止再次漂移。
//
// ✅ 联系邮箱已补（2026-09-26，用户提供）—— 公开性已知情并接受（仓库 public + UA 随请求发送）。
//    若要更换联系人渠道：本文件 + `utils/lp-ua.js` 各改 LP_EMAIL 一行。
export const LP_CONTACT = "https://github.com/re-toke/dota2-esports";
export const LP_EMAIL = "295231347@qq.com";
export const LP_UA = `DOTA2-Esports-Hub/1.0 (+${LP_CONTACT}; ${LP_EMAIL})`;
