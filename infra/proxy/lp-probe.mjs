// infra/proxy/lp-probe.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Liquipedia 出口探针（Deno Deploy / Deno Playground 专用，**无服务器**）
//
// ## 它只回答一个问题
// 「这台服务器的出口 IP 访问 Liquipedia，会不会被 429？」——用来判定能否把
//   LP 抓取从 GitHub Actions（Azure 共享 IP，实测首条请求就 429）搬到 Deno 边缘。
//
// ## 为什么需要它（2026-11-05 实测结论）
// · GitHub runner 抓 LP 时 205/205 条全部 `HTTP 429`，且**第一条就 429**
//   ⇒ 不是请求太快，是落地 IP 早被打满（LP 限流按来源 IP 计数）。
// · 同一生产 UA 从本机请求同一页面 → `HTTP 200 / 1.07s`
//   ⇒ 不是 UA 问题、不是代码问题，换出口就能通。
// · 但 Deno 边缘出口是否被 LP 拦，本地无法证明，必须真机跑一次。
//
// ## 部署（2 分钟，不需要任何机器）
//   1. 打开 Deno Playground / Deno Deploy → 新建项目 → 粘贴本文件 → Save
//   2. 浏览器访问项目根路径（`/`），得到一段 JSON
//   3. 把 JSON 贴回来即可判定
//   （本文件**不写库、不读凭证、无需环境变量**）
//
// ## 结果怎么读
//   verdict = "OK"        → API 200，出口干净 ⇒ 方案 D（Deno cron 定时抓取）可行
//   verdict = "BLOCKED"   → API 429，与 GitHub 同病 ⇒ 放弃 D，转方案 E（外部定时 + 现有 Actions）
//   verdict = "GZIP_REQ"  → API 406，Liquipedia 要求 `Accept-Encoding: gzip`
//                          （运行时把该头剥掉了 ⇒ 不是封锁，换实现方式即可）
//   verdict = "NETWORK"   → 连不上 / 超时，看每个 check 的 error
//
// ## 合规
//   · 只发 4 个只读 GET；相邻请求强制间隔 2.2s（LP 要求 1 req/2s）
//   · UA 与仓库唯一来源 `utils/lp-ua.js` 保持一致（标识项目 + 联系方式，不伪装浏览器）
//   · 结果在模块内缓存 60s，反复刷新页面不会重复打 LP
// ─────────────────────────────────────────────────────────────────────────────

const LP_UA = 'DOTA2-Esports-Hub/1.0 (+https://github.com/re-toke/dota2-esports; 295231347@qq.com)';
const API = 'https://liquipedia.net/dota2/api.php';
const PAGE = 'https://liquipedia.net/dota2/EPL/Masters/3';
const RATE_MS = 2200;          // LP ToS：1 req/2s
const MEMO_MS = 60 * 1000;     // 结果缓存

let _last = 0;
let _memo = null;              // { at, out }

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function json(body, status) {
  return new Response(JSON.stringify(body, null, 2), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

/** 单次探测：返回状态码 / 耗时 / 内容类型 / 是否 JSON / 是否挑战页 */
async function probe(url, label, extraHeaders) {
  const wait = _last + RATE_MS - Date.now();
  if (wait > 0) await sleep(wait);
  _last = Date.now();
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      headers: Object.assign({ 'User-Agent': LP_UA, 'Accept': 'application/json' }, extraHeaders || {})
    });
    const txt = await r.text();
    const ct = r.headers.get('content-type') || '';
    const head = txt.slice(0, 200);
    const isJson = /^\s*[{\[]/.test(head);
    return {
      label: label,
      status: r.status,
      ms: Date.now() - t0,
      contentType: ct,
      bytes: txt.length,
      variant: (extraHeaders && extraHeaders['Accept-Encoding']) || 'none',
      json: isJson,
      // HTML + 200(403/503) 基本等于 Cloudflare 挑战页；429 单独由 status 判定
      challenge: !isJson && /<html|cloudflare|captcha|attention required/i.test(head),
      snippet: head.replace(/\s+/g, ' ').slice(0, 160)
    };
  } catch (e) {
    return { label: label, error: String((e && e.message) || e), ms: Date.now() - t0 };
  }
}

function verdictOf(checks) {
  const api = checks.filter((c) => c && c.status != null && /siteinfo|page/.test(c.label));
  if (!api.length) return 'NETWORK';
  const ok = api.filter((c) => c.status === 200 && c.json);
  if (ok.length) return 'OK';
  if (api.some((c) => c.status === 429)) return 'BLOCKED';
  if (api.some((c) => c.status === 406)) return 'GZIP_REQ';
  if (api.some((c) => c.status === 403)) return 'FORBIDDEN';
  if (api.every((c) => c.status == null)) return 'NETWORK';
  return 'UNKNOWN';
}

async function run() {
  const out = { startedAt: new Date().toISOString(), region: '', checks: [] };
  try { out.region = Deno.env.get('DENO_REGION') || ''; } catch (e) { out.region = ''; }

  // ① 不带 gzip 的最小 API 调用 —— 用来区分「406（要 gzip）」与「429（被封）」
  out.checks.push(await probe(API + '?action=query&format=json&meta=siteinfo', 'siteinfo-no-gzip', null));
  // ② 带 gzip 的最小 API 调用（正式写法）
  out.checks.push(await probe(API + '?action=query&format=json&meta=siteinfo', 'siteinfo-gzip',
    { 'Accept-Encoding': 'gzip' }));
  // ③ 真实业务页（批量取数的最小单元）
  out.checks.push(await probe(
    API + '?action=query&format=json&prop=revisions&rvprop=content&redirects=1&titles=' +
    encodeURIComponent('EPL/Masters/3'),
    'page-gzip', { 'Accept-Encoding': 'gzip' }));
  // ④ 普通 HTML 页面 —— 看看是否被 Cloudflare 挑战（与 API 可能不同策略）
  out.checks.push(await probe(PAGE, 'html-page', { 'Accept-Encoding': 'gzip' }));

  out.verdict = verdictOf(out.checks);
  out.hint = {
    OK: '出口干净：可把 LP 抓取搬到 Deno cron（方案 D）',
    BLOCKED: '与 GitHub 同病（429）：放弃 D，转方案 E（外部定时器 + 现有 Actions + 批量/增量）',
    GZIP_REQ: '只是缺 gzip 头（非封锁）：保留 Accept-Encoding: gzip 重试即可',
    FORBIDDEN: '403：LP 对该出口设了更硬的拦截，需换方案',
    NETWORK: '连不上：看每个 check 的 error（可能是平台出网策略或 DNS）',
    UNKNOWN: '状态码不符合已知模式：把完整 JSON 发回来人工判定'
  }[out.verdict] || '';
  return out;
}

export default {
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/healthz') return json({ ok: true, ts: new Date().toISOString() });
    if (url.pathname !== '/') return json({ error: 'not found', hint: '访问根路径 / 即可运行探针' }, 404);
    const now = Date.now();
    if (_memo && now - _memo.at < MEMO_MS) {
      return json(Object.assign({ cached: true, cacheAgeSec: Math.round((now - _memo.at) / 1000) }, _memo.out));
    }
    const out = await run();
    _memo = { at: Date.now(), out: out };
    return json(out);
  }
};

export { run, probe, verdictOf, LP_UA };
