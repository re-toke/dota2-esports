/**
 * scripts/ops/notify-alert.js
 * P1-13（2026-10-12）：**独立告警通道** —— 飞书群机器人 Webhook
 *
 * ## 为什么需要第二个通道
 * 现状告警**只有一条**：某个 GitHub job 失败 → GitHub 给仓库 owner 发邮件。
 * 实测问题（`ef-health.yml` 头注）：GH scheduled 会被丢弃/延迟（声明 2h、实际 5~7h），
 * 且「job 失败邮件」只覆盖被探测的那一件事、容易淹没在邮件里。
 * ⇒ 本脚本提供一个**可复用的二级通道**：CI 里任何失败分支都能把消息推到一个统一入口。
 *
 * ## 用法
 *   node scripts/ops/notify-alert.js "消息文本"
 * 环境变量：`ALERT_WEBHOOK`（飞书群机器人 webhook URL）。
 *   ⚠️ **未配置时打印提示并以 0 退出** —— 告警通道本身坏掉不应再制造第二个失败。
 *
 * 退出码：恒为 0（除非显式传 `--strict` 且推送失败）。
 */
'use strict';

const STRICT = process.argv.slice(2).includes('--strict');
const msg = process.argv.filter((a) => a !== '--strict').slice(2).join(' ').trim() || '(无消息内容)';
const HOOK = process.env.ALERT_WEBHOOK || '';

async function main() {
  if (!HOOK) {
    console.log('::warning::未配置 ALERT_WEBHOOK ⇒ 跳过 Webhook 告警（仍保留 GitHub job 失败邮件）');
    return;
  }
  const res = await fetch(HOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // 飞书自定义机器人文本消息形态；其它 Webhook 平台按其约定自行替换
    body: JSON.stringify({ msg_type: 'text', content: { text: '【DOTA2赛事通 · 运维告警】\n' + msg } }),
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new Error('Webhook HTTP ' + res.status + ' ' + text.slice(0, 200));
  console.log('[notify-alert] 已推送：' + msg);
}

main().catch((e) => {
  console.error('[notify-alert] ' + (e && e.message ? e.message : e));
  if (STRICT) process.exit(1);
});
