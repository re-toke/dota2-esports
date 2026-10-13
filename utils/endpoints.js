// utils/endpoints.js
// P1-2：中转「跨宿主双出口」寻址抽象 —— **唯一出口来源** + 主→备失败切换 + 会话粘滞 + 开机通道体检。
//
// ## 为什么需要
// 客户端**所有**网络出口收敛到**同一台 Deno Deploy 中转**（国内 `*.supabase.co` 被 SNI 阻断、
// `api.opendota.com` 被 DNS 劫持 ⇒ 只能绕中转）：
//   · `config.supabase.url`   = `<host>/sb`      （EF + PostgREST）
//   · `utils/api.js` 的 BASE  = `<host>/od/api`  （OpenDota 兜底）
// ⇒ **中转挂即全挂**（单点）。本模块把「出口主机」抽成唯一来源（`config.endpoints.proxy`），
//   主不可达时切备；探测/切换结果**会话级粘滞**（避免抖动时反复横跳），小程序重启即复位。
//
// ## 依赖纪律（重要）
// 本模块**不 require 任何 utils/**（`config` 为函数内**延迟 require**，避免与 config 成环）；
// `wx` 仅在 `probe()` 内部使用 ⇒ 可被 node 侧（infra/proxy/test.mjs、scripts）直接 require 单测。
//
// ## 现状（2026-10-13）
// 候选 3 台（`config.endpoints.proxy`）：`[0]` 主（Deno 现网）/ `[1]` Deno 新项目 / `[2]` Netlify。
// ⇒ `count()>1` ⇒ `failover()` / `probe()` **均已生效**（单槽时会退化为 no-op，行为与改造前等价）。

var _hosts = null;   // 懒加载（首次访问时从 config.endpoints.proxy 构建）；null = 未加载
var _idx = 0;        // 当前会话选中的宿主下标（粘滞）

function _norm(h) { return String(h == null ? '' : h).replace(/\/+$/, ''); }

// 归一化 + 去重 + 保序（过滤空槽）
function _build(list) {
  var seen = {};
  var out = [];
  (list || []).forEach(function (h) {
    h = _norm(h);
    if (!h || seen[h]) return;
    seen[h] = 1;
    out.push(h);
  });
  return out;
}

// 候选宿主（去重、保序、去尾斜杠）。首次调用从 `config.endpoints.proxy` 构建。
function hosts() {
  if (_hosts === null) {
    var list = [];
    try { list = (require('./config.js').endpoints || {}).proxy || []; } catch (e) { list = []; }
    _hosts = _build(list);
    if (_idx >= _hosts.length) _idx = 0;
  }
  return _hosts.slice();
}

// 注入候选宿主（单测 / 未来远端下发配置用）。返回归一化后的列表。
function setHosts(list) {
  _hosts = _build(list);
  _idx = 0;
  return _hosts.slice();
}

function reset() { _idx = 0; }
function index() { return _idx; }
function count() { return hosts().length; }
function current() { return hosts()[_idx] || ''; }

// 主失败 → 切到下一台（单台时原地不动）。返回切换后的宿主。
//
// ★★ 2026-10-13（真机演练修「切换过冲」）：可选传入 `fromHost` = **刚才失败的那台**。
//   · `fromHost` 与当前出口**一致** ⇒ 正常切换（→ 下一台）；
//   · `fromHost` 与当前出口**不一致** ⇒ 属**迟到失败**（该宿主早已被放弃、`_idx` 已前进）
//     ⇒ **原地不动**。否则每个迟到失败都会再推一次 `_idx`，把出口推过可用的备台、甚至绕回起点。
//   **实测依据**：真机「把主出口换成不可达域名」演练出现 **8 次轮转**（正确行为只需 1 次）——
//   启动瞬间一批并发请求同时打到坏出口、各自失败各自盲转 ⇒ 过冲。加本守卫后，每个宿主的失败
//   最多推进一格，且**只有它仍是当前出口时**才推进 ⇒ 复现的 8 次收敛为 1 次。
//   不传 `fromHost` 时保持旧行为（供不关心来源的调用方与既有单测使用）。
function failover(fromHost) {
  var h = hosts();
  if (h.length <= 1) return h[0] || '';
  if (fromHost) {
    var from = _norm(fromHost);
    if (from && from !== h[_idx]) return h[_idx];   // 迟到失败 ⇒ 忽略，原地不动
  }
  var next = (_idx + 1) % h.length;
  if (next !== _idx) {
    console.info('[endpoints] 出口切换 ' + h[_idx] + ' → ' + h[next]);
    _idx = next;
  }
  return h[_idx];
}

// 派生前缀（与 `config.supabase.url` / `api.js` BASE **同一台宿主**，不许各自持有字面量）
function sbUrl() { var h = current(); return h ? h + '/sb' : ''; }
function odBase() { var h = current(); return h ? h + '/od/api' : ''; }

// 开机通道体检：并发探测各候选宿主的 `/healthz`，命中即写回会话粘滞（**主优先**）。
// **异步、不阻塞首屏**；单出口时直接 resolve（no-op）。
// @param {(host:string)=>Promise<boolean>} [checkFn] 自定义探活（缺省用 wx.request 探 /healthz）
function probe(checkFn) {
  var h = hosts();
  if (h.length <= 1) return Promise.resolve(current());
  var check = checkFn || defaultCheck;
  return Promise.all(h.map(function (host) {
    return Promise.resolve()
      .then(function () { return check(host); })
      .then(function (ok) { return !!ok; }, function () { return false; });
  })).then(function (results) {
    for (var i = 0; i < results.length; i++) {
      if (results[i]) {
        if (i !== _idx) console.info('[endpoints] 体检选中 ' + h[i]);
        _idx = i;
        return h[i];
      }
    }
    console.info('[endpoints] 体检全部不可达，维持 ' + current());
    return current();
  });
}

// 缺省探活：GET <host>/healthz（3xx 也视为可达 —— 备用宿主可能有重定向）
function defaultCheck(host) {
  return new Promise(function (resolve) {
    if (typeof wx === 'undefined' || !wx.request) { resolve(false); return; }
    var done = false;
    var timer = setTimeout(function () { if (done) return; done = true; resolve(false); }, 4000);
    wx.request({
      url: host + '/healthz',
      method: 'GET',
      timeout: 4000,
      success: function (res) {
        if (done) return; done = true; clearTimeout(timer);
        resolve(res.statusCode >= 200 && res.statusCode < 400);
      },
      fail: function () { if (done) return; done = true; clearTimeout(timer); resolve(false); }
    });
  });
}

module.exports = {
  hosts: hosts,
  setHosts: setHosts,
  reset: reset,
  index: index,
  count: count,
  current: current,
  failover: failover,
  sbUrl: sbUrl,
  odBase: odBase,
  probe: probe
};
