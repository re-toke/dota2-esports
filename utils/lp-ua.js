// utils/lp-ua.js
// ★★ 2026-09-26（P0-E-1/E-2）：Liquipedia User-Agent 的**单一来源**（客户端 / 脚本侧）。
//
// 为什么要有这个文件：
//   Liquipedia API ToS 要求 ——「Use a custom HTTP User-Agent header in your requests that
//   **identifies your project / use of the API, and includes contact information**.」
//   违规可能被**自动临时 IP 封禁**，反复触发可转**永久**。
//   实测教训（v8.19 起的历史包袱）：曾被 Cloudflare 挑战后**改用伪装浏览器 UA**
//   （`Mozilla/5.0 … Chrome/126.0.0.0`）——这既不标识项目、也不含联系方式，属**明确违规**；
//   且把"被拦"当成"要更隐蔽"，风险单调上升。
//   ★ 正确应对是**降频 / 加缓存 / 走缓存表**，不是再伪装。
//
// 预检（2026-09-26，真实请求三连测）：伪装 UA / 标识性 UA / 早期合规 UA
//   对 LP API **均返回 HTTP 200 + 有效内容**，标识性 UA 无任何副作用
//   ⇒「换回合规 UA 会被 Cloudflare 拦」的担忧**未被证实**。
//
// ⚠️ 与 `supabase/functions/_shared/lp-ua.ts` 是**镜像**（EF 跑 Deno，无法 require 本文件）；
//    一致性由 `scripts/test/test-sources.js` 的「LP UA 单点」守卫断言（含镜像逐字比对）。
// ⚠️ 待补：**真实联系邮箱** —— 当前以项目主页充当联系方式渠道。
//    补法：只改本文件（与 EF 镜像）这一行，全仓 11 处引用自动跟随（这正是单点化的目的）。
'use strict';

var LP_CONTACT = 'https://github.com/re-toke/dota2-esports';
var LP_UA = 'DOTA2-Esports-Hub/1.0 (+' + LP_CONTACT + ')';

module.exports = {
  LP_CONTACT: LP_CONTACT,
  LP_UA: LP_UA
};
