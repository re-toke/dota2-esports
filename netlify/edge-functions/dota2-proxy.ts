// netlify/edge-functions/dota2-proxy.ts
// P1-2 备出口 [2]：把 Netlify Edge 的调用约定「翻译」成 worker.mjs 的 handle()。
// 与 Deno 那台**共用同一份路由代码**（`infra/proxy/worker.mjs`）—— 不重复实现，避免口径漂移。
//
// ## 为什么是 `.ts` 而不是 `.js`（本条有实际原因，不是随手选的）
//   Netlify Edge Functions 是 **ESM**（`import` / `export default` / `export const config`），
//   而本仓库是 CJS 小程序工程（`package.json` 无 `"type":"module"`）。项目 pre-commit 钩子会对
//   **已暂存的 `.js`** 跑 `node --check`（`scripts/hooks/pre-commit.sh`）—— 以 CJS 口径解析一个
//   ESM 文件必然报 `Cannot use import statement outside a module` ⇒ **提交会被阻断**。
//   `.ts` 不在该钩子的 `\.js$` 扫描面内，且与本仓库既有的 `supabase/functions/**/*.ts`
//   （同样是 ESM/TS 运行时代码）做法一致 ⇒ 不改动任何门禁脚本。
//
// ## 三条必须知道的约束
//  1. `export const config = { path: '/*' }` **必须存在** —— 只写 `'/'` 会让 `/sb/*` 与
//     `/od/api/*` 直接 404（`/healthz` 反而能通，是最容易误判成"部署成功"的坑）。
//  2. 运行时是 **Deno**（与主出口 Deno Deploy 同族）⇒ 本台的价值是
//     **「不同注册域」**（`*.netlify.app` ≠ `*.deno.net`，能防**域名级阻断**），
//     **不是**「不同提供商」。真正的跨提供商冗余本轮因无卡未能落地。
//  3. 环境变量在 Netlify 站点设置里配；`Netlify.env` 是现行 API，`Deno.env` 作兜底。
//
// ## 若打包报「找不到 ../../infra/proxy/worker.mjs」
//   ⇒ 把 `infra/proxy/worker.mjs` **复制**到本目录，再把下面的 import 改成 `./worker.mjs`。
//      （代价：多一份副本，改代码时要同步。）
//
// 验证：本文件**不能**本地跑（依赖 Netlify/Deno 全局对象）⇒ 靠部署后的三条自检（DEPLOY.md §E4）。

import { handle } from '../../infra/proxy/worker.mjs';

/** 读环境变量：优先 Netlify 现行 API，退回 Deno（该运行时即 Deno） */
function envGet(key: string): string | undefined {
  try {
    // @ts-ignore Netlify 运行时全局对象
    if (typeof Netlify !== 'undefined' && Netlify.env && Netlify.env.get) return Netlify.env.get(key);
  } catch (e) { /* 落到下一个 */ }
  try {
    // @ts-ignore Deno 运行时全局对象
    if (typeof Deno !== 'undefined' && Deno.env && Deno.env.get) return Deno.env.get(key);
  } catch (e) { /* 无环境变量 */ }
  return undefined;
}

// @ts-ignore handle 来自 .mjs（无类型声明），此处只需其运行时行为
export default async (request: Request) => handle(request, {
  SB_ANON_KEY: envGet('SB_ANON_KEY') || '',
  SUPABASE_REF: envGet('SUPABASE_REF') || undefined,
  // P1-12 的限流开关：**默认不设**（取不到客户端 IP 时会误伤，先不开）
  PROXY_RATE_LIMIT_MAX: envGet('PROXY_RATE_LIMIT_MAX') || ''
});

// ⚠️ 挂在全部路径（见文件头约束 1）
export const config = { path: '/*' };
