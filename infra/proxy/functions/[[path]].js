// infra/proxy/functions/[[path]].js
// Cloudflare **Pages Functions** 入口（与 Worker 版共用同一套路由逻辑）。
//
// 用法（二选一，见 ../README.md）：
//   · 方式 A：直接用 Worker（`wrangler deploy`）—— 本文件不参与
//   · 方式 B：用 Pages —— 把 `functions/` 目录一起上传，Pages 会自动把它作为全路径函数
//            （文件名 `[[path]].js` 是 Pages 的「捕获所有路径」约定，**不要改名**）
import { handle } from '../worker.mjs';

export const onRequest = ({ request, env }) => handle(request, env);
