#!/usr/bin/env node
/**
 * scripts/test/test-lp-fetch-guard.js
 * 「LP 抓取失败分流（A′）+ 快照回写不被 LP 绑架」防护测试（2026-09-28）
 *
 * 背景（线上实例，用户提供 CI 日志）：
 *   `FAILED: not json: <!DOCTYPE HTML><title>Rate Limited - Liquipedia</title>…` ⇒ exit 1。
 *   LP ToU：通用 ≤1 req/2s、**action=parse ≤1 req/30s**；超限触发 **temporary IP bans**。
 *   我方合规（每次仅 1 个 parse、2 次/天）⇒ 真因是 **GitHub 共用 runner IP 被波及**（外部、瞬时可自愈）。
 *
 * 本测试锁三件事：
 *  ① **分类正确**：`classifyLpBody` 把「JSON / 被拦截页 / 其它 HTML / 无法识别」分开
 *     —— 分类错了，"分流"就成了空话。
 *  ② **分流正确（A′ 契约）**：**只有"被拦截"才退避重试、才降级**；
 *     其它错误**立刻失败不重试**；且「上游 0 条」的 exit(1) **必须保留**（真故障不许被静默）。
 *  ③ **workflow 契约**：提交步带 `if: always()`；两个补接线步**前置**在 LP 抓取之前
 *     （它们只依赖 OpenDota/Steam，不该被 LP 的抖动连带跳过）。
 *  ★ 每个源码级守卫都配**字符串变异证伪**（证明守卫非永真）。
 *
 * 运行：node scripts/test/test-lp-fetch-guard.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + '  ->  ' + (detail || '')); }
}
function summary() {
  console.log('\n=== 结果 ===');
  console.log('通过: ' + pass + '  失败: ' + fail);
  if (fail) { console.log('存在失败 ❌'); process.exit(1); }
  console.log('全部通过 ✅');
}

const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

const SCRIPT_REL = 'scripts/sync/fetch-liquipedia-upcoming.js';
const WF_REL = '.github/workflows/sync-upcoming.yml';
const src = read(SCRIPT_REL);
const wf = read(WF_REL);

// ============================================================================
// 0) ★ 安全前置：`require.main` 守卫**必须**存在，否则 require 下面这个模块会
//    直接执行 main()（发真实网络请求 + 写 utils/upcoming-local.json 产物！）
//    ⇒ 守卫缺失时**立刻退出**，绝不 require（这是本测试自身的安全阀）。
// ============================================================================
const hasMainGuard = src.indexOf('if (require.main === module)') !== -1;
assert('★ 前置：脚本必须有 `require.main === module` 守卫（防 require 时跑主流程、发网络/写产物）', hasMainGuard);
if (!hasMainGuard) {
  console.log('\n守卫缺失 ⇒ 拒绝 require，避免测试触发真实抓取与产物写入。');
  summary();
}
const lp = require(path.join(ROOT, SCRIPT_REL));

// ============================================================================
// 1) classifyLpBody：四类响应必须分清
// ============================================================================
const JSON_BODY = '{"parse":{"title":"Portal:Tournaments","text":{"*":"<div>ok</div>"}}}';
// ★ 用**线上真实日志**里的页面形状做样本（不是编的）
const RATE_LIMITED_BODY = '<!DOCTYPE HTML><title>Rate Limited - Liquipedia</title>'
  + '<meta charset=utf-8><meta name=viewport content="width=device-width">';
const CAPTCHA_BODY = '<!DOCTYPE html><html><body><h1>Please complete the CAPTCHA to continue</h1></body></html>';
const PROXY_HTML_BODY = '<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>';

assert('① JSON 正文 ⇒ json', lp.classifyLpBody(200, JSON_BODY).kind === 'json',
  '实际 ' + lp.classifyLpBody(200, JSON_BODY).kind);
assert('★ ① 线上那条「Rate Limited」页 ⇒ blocked（必须被识别出来，否则分流无从谈起）',
  lp.classifyLpBody(200, RATE_LIMITED_BODY).kind === 'blocked',
  '实际 ' + lp.classifyLpBody(200, RATE_LIMITED_BODY).kind);
assert('★ ① CAPTCHA 挑战页 ⇒ blocked（LP ToU 明写"可过 CAPTCHA 自解" ⇒ 同属被拦截）',
  lp.classifyLpBody(200, CAPTCHA_BODY).kind === 'blocked',
  '实际 ' + lp.classifyLpBody(200, CAPTCHA_BODY).kind);
assert('★ ① 其它 HTML（如代理 502 页）**不得**判 blocked ⇒ 归 html（保守：不静默未知故障）',
  lp.classifyLpBody(502, PROXY_HTML_BODY).kind === 'html',
  '实际 ' + lp.classifyLpBody(502, PROXY_HTML_BODY).kind);
assert('① 空/垃圾正文 ⇒ unknown', lp.classifyLpBody(200, '   ').kind === 'unknown',
  '实际 ' + lp.classifyLpBody(200, '   ').kind);
assert('① status 必须原样带出（便于日志定位 403/429/502）',
  lp.classifyLpBody(429, RATE_LIMITED_BODY).status === 429);

// ============================================================================
// 2) fetchParseWithRetry：**只对 blocked 重试**，其它立刻失败
//    （注入 fetchOnce / sleepFn ⇒ 不发网络、不真等待）
// ============================================================================
function mkFetch(seq) {
  let i = 0;
  const calls = { n: 0 };
  return {
    calls: calls,
    fn: function () {
      calls.n++;
      const r = seq[Math.min(i, seq.length - 1)];
      i++;
      return Promise.resolve(r);
    }
  };
}

(async function () {
  // 2a) blocked ×2 → JSON：应重试两次后成功
  {
    const f = mkFetch([{ status: 429, body: RATE_LIMITED_BODY },
      { status: 429, body: RATE_LIMITED_BODY },
      { status: 200, body: JSON_BODY }]);
    const waited = [];
    const html = await lp.fetchParseWithRetry({
      fetchOnce: f.fn, sleepFn: (ms) => { waited.push(ms); return Promise.resolve(); }
    });
    assert('② 被拦截→被拦截→JSON ⇒ 最终成功取回 html', html === '<div>ok</div>', '实际 ' + html);
    assert('② 共发起 3 次请求', f.calls.n === 3, '实际 ' + f.calls.n);
    assert('★ ② 退避间隔必须等于配置值（30s、60s）',
      JSON.stringify(waited) === JSON.stringify(lp.LP_RETRY_DELAYS_MS),
      '实际 ' + JSON.stringify(waited));
  }

  // 2b) 全程被拦截：抛 LpRateLimitedError（＝上游会降级为警告 + exit 0 的那一类）
  {
    const f = mkFetch([{ status: 429, body: RATE_LIMITED_BODY }]);
    let err = null;
    try {
      await lp.fetchParseWithRetry({ fetchOnce: f.fn, sleepFn: () => Promise.resolve() });
    } catch (e) { err = e; }
    assert('★ ② 全程被拦截 ⇒ 抛 LpRateLimitedError（上层据此降级为警告）',
      !!err && err.name === 'LpRateLimitedError', '实际 ' + (err && err.name));
    assert('★ ② 错误信息需带"Rate Limited"与重试次数，便于人从日志一眼定位',
      !!err && /Rate Limited/.test(err.message) && /已重试 2 次/.test(err.message),
      '实际 ' + (err && err.message));
    assert('② 被拦截时总请求数 = 1 + 重试次数 = 3', f.calls.n === 3, '实际 ' + f.calls.n);
  }

  // 2c) ★ 反向：非"被拦截"的 HTML **不得**重试、**不得**降级（立刻硬失败）
  {
    const f = mkFetch([{ status: 502, body: PROXY_HTML_BODY }]);
    let err = null;
    try {
      await lp.fetchParseWithRetry({ fetchOnce: f.fn, sleepFn: () => Promise.resolve() });
    } catch (e) { err = e; }
    assert('★ ② 代理 502 HTML ⇒ 抛普通 Error（**不**是 LpRateLimitedError ⇒ 保持 exit 1）',
      !!err && err.name !== 'LpRateLimitedError', '实际 ' + (err && err.name));
    assert('★★ ② 非被拦截错误**不得重试**（否则会把真故障拖长 + 掩盖）', f.calls.n === 1, '实际 ' + f.calls.n);
  }

  // 2d) 反向：无法识别的正文同样立刻失败
  {
    const f = mkFetch([{ status: 200, body: 'garbage-not-html-not-json' }]);
    let err = null;
    try {
      await lp.fetchParseWithRetry({ fetchOnce: f.fn, sleepFn: () => Promise.resolve() });
    } catch (e) { err = e; }
    assert('★ ② 无法识别的响应 ⇒ 立刻失败、不重试', !!err && f.calls.n === 1, 'err=' + (err && err.name) + ' calls=' + f.calls.n);
  }

  // ============================================================================
  // 3) 源码级契约守卫（每条配变异证伪）
  // ============================================================================
  // 3a) ★★ A′ 核心：被拦截分支**不得** process.exit —— 必须是 return（⇒ 进程 exit 0）
  function rateLimitedBranchExitsCleanly(text) {
    const i = text.indexOf("if (e && e.name === 'LpRateLimitedError') {");
    if (i < 0) return false;
    const j = text.indexOf("throw e;", i);
    if (j < 0) return false;
    return text.slice(i, j).indexOf('process.exit') === -1;
  }
  assert('★★ 3a: 「被拦截 ⇒ 降级」分支必须 return（**不得** process.exit）—— A′ 的分流契约',
    rateLimitedBranchExitsCleanly(src));
  {
    const mut = src.replace("if (e && e.name === 'LpRateLimitedError') {",
      "if (e && e.name === 'LpRateLimitedError') {\n      process.exit(1);");
    assert('变异3a 确实改到了源码', mut !== src);
    assert('★ 变异3a：往降级分支塞 process.exit ⇒ 契约必须判 false',
      !rateLimitedBranchExitsCleanly(mut));
  }

  // 3b) ★★ 反向契约：**「上游 0 条」的 exit(1) 必须保留**（真故障不许被静默）
  function zeroRowsStillFails(text) {
    const i = text.indexOf('if (!out.length) {');
    if (i < 0) return false;
    return text.slice(i, i + 600).indexOf('process.exit(1)') !== -1;
  }
  assert('★★ 3b: 「上游 0 条」仍必须 exit(1)（防把"解析失效"静默成"不更新"）', zeroRowsStillFails(src));
  {
    const mut = src.replace('if (!out.length) {', 'if (!out.length) { /* mutated */')
      .replace(/(if \(!out\.length\) \{ \/\* mutated \*\/[\s\S]{0,600}?)process\.exit\(1\);/, '$1/*noexit*/');
    assert('变异3b 确实改到了源码', mut !== src && mut.indexOf('/*noexit*/') !== -1);
    assert('★ 变异3b：抽掉 0 条的 exit(1) ⇒ 契约必须判 false', !zeroRowsStillFails(mut));
  }

  // 3c) ★ workflow：两个补接线步必须**前置**在 LP 抓取之前
  function orderOk(text) {
    const i11 = text.indexOf('Refresh leagues snapshot (补接线)');
    const i12 = text.indexOf('Refresh team-logo snapshot (补接线)');
    const iLp = text.indexOf('Run upcoming sync (snapshot + Supabase)');
    return i11 > -1 && i12 > -1 && iLp > -1 && i11 < iLp && i12 < iLp;
  }
  assert('★ 3c: workflow 中「两个补接线步」必须在 LP 抓取**之前**（否则 LP 一红就带走它们）', orderOk(wf));
  {
    // 变异：在文件最前插入一个 LP 步标记 ⇒ 首个 LP 出现位置早于补接线步 ⇒ 顺序被破坏
    const mut = '- name: Run upcoming sync (snapshot + Supabase)\n' + wf;
    assert('变异3c 确实改到了源码', mut !== wf);
    assert('★ 变异3c：顺序颠倒 ⇒ 契约必须判 false', !orderOk(mut));
  }

  // 3d) ★ workflow：提交步必须带 `if: always()`
  function commitAlways(text) {
    const i = text.indexOf('- name: Commit refreshed snapshot artifacts');
    if (i < 0) return false;
    return /if:\s*always\(\)/.test(text.slice(i, i + 400));
  }
  assert('★ 3d: 提交步必须带 `if: always()`（否则 LP 一红则已刷新的其它产物全丢）', commitAlways(wf));
  {
    const mut = wf.replace('if: always() && steps.checkout.outcome', 'if: success() && steps.checkout.outcome');
    assert('变异3d 确实改到了源码', mut !== wf);
    assert('★ 变异3d：把 always() 换成 success() ⇒ 契约必须判 false', !commitAlways(mut));
  }

  summary();
})().catch((e) => {
  console.error('测试异常：' + ((e && e.message) || e));
  process.exit(1);
});
