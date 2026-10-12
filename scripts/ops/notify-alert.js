/**
 * scripts/ops/notify-alert.js
 * P1-13（2026-10-12）：**独立告警通道** —— 推送到 IM/推送服务的 Webhook
 *
 * ## 为什么需要第二个通道
 * 现状告警**只有一条**：某个 GitHub job 失败 → GitHub 给仓库 owner 发邮件。
 * 实测问题（`ef-health.yml` 头注）：GH scheduled 会被丢弃/延迟（声明 2h、实际 5~7h），
 * 且「job 失败邮件」只覆盖被探测的那一件事、容易淹没在邮件里。
 * ⇒ 本脚本提供一个**可复用的二级通道**：CI 里任何失败分支都能把消息推到一个统一入口。
 *
 * ## 用法
 *   node scripts/ops/notify-alert.js "消息文本"
 * 环境变量：`ALERT_WEBHOOK`（推送地址）。
 *   ⚠️ **未配置时打印提示并以 0 退出** —— 告警通道本身坏掉不应再制造第二个失败。
 *
 * ## ★ 支持的平台（按 URL 自动判别，2026-10-12）
 *   ① **Server酱·Turbo**：`https://sctapi.ftqq.com/<SendKey>.send` → form 表单（`title`/`desp`）
 *   ② **Server酱³**：`https://<uid>.push.ft07.com/send/<sendkey>.send` → JSON（`title`/`desp`）
 *   ③ **飞书自定义机器人**：`https://open.feishu.cn/open-apis/bot/v2/hook/<uuid>` → JSON（`msg_type`/`content`）
 *   ★ 为什么原生支持多个：本项最初按飞书设计，但实测该飞书租户**看不到「自定义机器人」**
 *     （群机器人列表里只有官方应用）⇒ 改用 Server酱。为免后续再被单一平台绑住，
 *     这里按 URL 判别而非写死。**环境变量名保持 `ALERT_WEBHOOK` 不变** ⇒ 两个 workflow 无需改动。
 *
 * ## 成功判定
 *   除了 `res.ok`，还校验**业务码**（Server酱 `code` / 飞书 `StatusCode`）——
 *   否则 HTTP 200 但业务失败（如 SendKey 失效）会被当成"推送成功"，通道静默失效。
 *
 * 退出码：恒为 0（除非显式传 `--strict` 且推送失败）。
 */
'use strict';

const STRICT = process.argv.slice(2).includes('--strict');
const msg = process.argv.filter((a) => a !== '--strict').slice(2).join(' ').trim() || '(无消息内容)';
const HOOK = process.env.ALERT_WEBHOOK || '';
const TITLE = 'DOTA2赛事通 · 运维告警';

/** 按目标平台生成请求体（见文件头「支持的平台」） */
function buildRequest(hook, text) {
  // ① Server酱·Turbo：官方示例是 form 表单
  if (/sctapi\.ftqq\.com/i.test(hook)) {
    return {
      ct: 'application/x-www-form-urlencoded',
      body: 'title=' + encodeURIComponent(TITLE) + '&desp=' + encodeURIComponent(text),
    };
  }
  // ② Server酱³：新域名，走 JSON
  if (/push\.ft07\.com/i.test(hook)) {
    return { ct: 'application/json', body: JSON.stringify({ title: TITLE, desp: text }) };
  }
  // ③ 飞书自定义机器人（默认形态；其它平台按其约定在此扩展）
  return {
    ct: 'application/json',
    body: JSON.stringify({ msg_type: 'text', content: { text: '【' + TITLE + '】\n' + text } }),
  };
}

async function main() {
  if (!HOOK) {
    console.log('::warning::未配置 ALERT_WEBHOOK ⇒ 跳过 Webhook 告警（仍保留 GitHub job 失败邮件）');
    return;
  }
  const req = buildRequest(HOOK, msg);
  const res = await fetch(HOOK, {
    method: 'POST',
    headers: { 'Content-Type': req.ct },
    body: req.body,
  });
  const raw = await res.text().catch(() => '');
  if (!res.ok) throw new Error('Webhook HTTP ' + res.status + ' ' + raw.slice(0, 200));
  // 业务码校验：HTTP 200 也可能是业务失败（Server酱 code / 飞书 StatusCode，0 为成功）
  let biz = null;
  try { biz = JSON.parse(raw); } catch (e) { biz = null; }
  const code = biz ? (biz.code !== undefined ? biz.code : biz.StatusCode) : undefined;
  if (code !== undefined && Number(code) !== 0) {
    throw new Error('Webhook 业务失败 code=' + code + ' ' + raw.slice(0, 200));
  }
  console.log('[notify-alert] 已推送：' + msg);
}

main().catch((e) => {
  console.error('[notify-alert] ' + (e && e.message ? e.message : e));
  // ★ 用 process.exitCode 而非 process.exit(1)：后者会在 Windows 上撞 libuv 断言
  //   （`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` ⇒ 进程被 abort，
  //   2026-10-12 实测复现）。exitCode 语义相同（失败仍非 0）但会正常 flush 后退出。
  if (STRICT) process.exitCode = 1;
});
