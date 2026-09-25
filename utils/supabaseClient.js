// utils/supabaseClient.js —— Supabase 请求封装（方案 C+，2026-09-04）
//
// ## 设计
// - wx.request 直调 PostgREST / Edge Functions，不依赖 supabase-js（小程序兼容性）
// - edge(name, data, opts)：调 Edge Function；opts.jwt 有值时 Authorization 带业务 JWT
//   （follow-profile / smart-reminders 必须带），否则用 anon key（公开数据）
// - rest(table, query)：PostgREST 直查公开表（anon 只读，不消耗 EF 调用配额）
// - EF 熔断（2026-09-17 重构）：**按 EF 名分桶**独立熔断 —— 连续 3 次 edge 失败 →
//   该 EF 进入 10min OPEN（冷却到期后放行一次 HALF_OPEN 探测）；不同 EF 互不影响
//   （旧实现为单一全局开关，任一 EF 失败会连带禁用全部 EF；见下方 efAvailable 注释）
//   ⚠️ 语义变化：efAvailable(name) 不传 name 时返回「EF 通道整体是否启用」而不再反映
//      熔断状态（熔断已按名隔离，无法用单一布尔表达）。现有 10 处调用点均不传 name →
//      仍会尝试 EF，失败后由 edge() 按 name 判定并回落云开发，功能等价、仅多一次往返。
// - 安全：anon key 是公开密钥（RLS 保护），JWT 来自 wechat-auth 签发（WX_APPSECRET 在 EF Secrets）

var config = require('./config');

var EF_BREAKER_THRESHOLD = 3;              // 连续失败阈值
// ★ 2026-09-25：OPEN 冷却 10min → **2min**。
//   实测（真机/模拟器 Console）：一次约 3 秒的境外网络抖动（supabase 与 steam CDN **同时** timeout）
//   会把 opendota-proxy 熔断 10 分钟 ⇒ **首页主数据源停摆 10 分钟**（只能靠本地快照兜底出卡）。
//   改 2min 的代价：硬故障期间每 ~2min 一次半开探测（单请求 12s 超时）⇒ 30min 故障约 15 次探测，可忽略；
//   收益：抖动恢复后 **≤2min** 自动回血（原 10min），首页少空 8 分钟。
//   ⚠️ 不再是「对齐 cloudBreaker.js 的 10min」——本熔断器只管 EF（supabaseClient），
//      cloudBreaker.js 是云函数时代的另一套（调用方 api.js / cloudProxy.js 仍存活，语义不同）。
var EF_BREAKER_TTL_MS = 2 * 60 * 1000;     // OPEN 冷却时长（到期后 efAvailable 放行一次半开探测）
// ★ 2026-09-17（P1-10 修复）：熔断状态改为「按 EF 名分桶 + TTL 冷却 + 半开探测」。
//   原实现是单一全局布尔（_efBreakerOpen），三个缺陷：
//     ① 不分桶：最不稳定的 haglund-proxy 连续 3 次 502，会把 opendota-proxy /
//        liquipedia-proxy / steam-proxy / bundle-aggregator 一起拖下水；
//     ② 无 TTL：置 true 后**整个会话**不再尝试任何 EF，无冷却窗口；
//     ③ 无半开：没有恢复探测，源恢复后客户端也无从得知。
//   项目内另两套熔断器（cloudBreaker.js 有 10min TTL、haglund.js 有 HALF_OPEN）
//   均已具备这些能力，本处属实现不一致。
//   ⚠️ 云函数下线后 EF 是这些 action 的唯一后端 —— 该缺陷届时会由 P1 升为 P0。
var _efBreakers = {};                      // { [efName]: { fails, openUntil, halfOpen } }

function _breakerOf(name) {
  if (!_efBreakers[name]) _efBreakers[name] = { fails: 0, openUntil: 0, halfOpen: false };
  return _efBreakers[name];
}

function sb() { return config.supabase || {}; }

function enabled() {
  return !!(sb().enabled && sb().url && sb().anonKey);
}

/**
 * 该 EF 当前是否可用（按 name 分桶；OPEN 冷却到期后放行一次探测 = HALF_OPEN）。
 * @param {string} [name] 不传时不做熔断限制（兼容不含 name 的旧调用）
 */
function efAvailable(name) {
  if (!enabled()) return false;
  if (!name) return true;
  var b = _breakerOf(name);
  if (!b.openUntil) return true;
  if (Date.now() >= b.openUntil) {
    b.halfOpen = true;    // 冷却到期 → 放行一次探测（HALF_OPEN）
    return true;
  }
  return false;
}

/**
 * 调 Edge Function。
 * @param {string} name   function 目录名，如 'wechat-auth'
 * @param {Object} [data] JSON body
 * @param {Object} [opts] { jwt: string } 业务 JWT（需鉴权的 EF 必传）
 * @returns {Promise<Object>} 响应 JSON
 */
function edge(name, data, opts) {
  return new Promise(function (resolve, reject) {
    if (!efAvailable(name)) { reject(new Error('supabase ef unavailable: ' + name)); return; }

    var authKey = (opts && opts.jwt) ? opts.jwt : sb().anonKey;
    wx.request({
      url: sb().url + '/functions/v1/' + name,
      method: 'POST',
      data: data || {},
      timeout: 25000,
      header: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + authKey
      },
      success: function (res) {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          _countSuccess(name);   // 成功复位该 EF 的熔断计数
          resolve(res.data);
        } else if (res.statusCode === 401 && opts && opts.jwt) {
          // JWT 过期/无效：属鉴权问题而非 EF 服务故障 —— 不计失败、也不复位累计
          // （下次登录换新 JWT 自然恢复；旧实现此处复位会掩盖真实的服务端连续失败）
          reject(new Error('EF ' + name + ' auth failed (401)'));
        } else if (name === 'bundle-aggregator' && res.statusCode === 502 &&
                   res.data && typeof res.data.error === 'string' &&
                   res.data.error.indexOf('bundle empty') >= 0) {
          // ★ 2026-09-19 新增：**「空结果」不计熔断**（与上方 401 的处理同思路）。
          //   背景：`bundle-aggregator` 在「两者皆空」时超返 502
          //   `{error:"league detail bundle empty"}`（设计意图=通知客户端回退旧链），
          //   但熔断器把它当成**服务故障** → 连续 3 次即熔断该 EF →
          //   此后所有请求都直接 `supabase ef unavailable: bundle-aggregator` 回落云开发，
          //   **连"本来可能成功"的也不试**（真机日志已复现该状态）。
          //   「空结果」是正常业务态、不是故障 —— 故**不计失败**；
          //   也**不复位**已有累计（避免掩盖真实故障，与 401 同策略）。
          //   注：EF 侧已改为返 200 + data:null（走上方成功分支，加 `_countSuccess`）；
          //   此分支用于**兼容尚未部署新 EF 的环境**。
          reject(new Error('EF ' + name + ' empty result (not counted)'));
        } else {
          _countFail(name);
          reject(new Error('EF ' + name + ' HTTP ' + res.statusCode));
        }
      },
      fail: function (err) {
        _countFail(name);
        reject(new Error(err.errMsg || 'network fail'));
      }
    });
  });
}

/** 该 EF 连续失败计数 + 熔断（按 name 分桶；3 次后该 EF 进入 10min OPEN） */
function _countFail(name) {
  if (!name) return;
  var b = _breakerOf(name);
  b.fails++;
  if (b.fails >= EF_BREAKER_THRESHOLD) {
    b.openUntil = Date.now() + EF_BREAKER_TTL_MS;
    b.halfOpen = false;
    console.info('[supabaseClient] EF breaker OPEN: ' + name + ' after ' + b.fails +
      ' fails, cooldown ' + (EF_BREAKER_TTL_MS / 60000) + 'min（该 EF 独立熔断，不影响其它 EF）');
  }
}

/** 成功 → 复位该 EF 的熔断状态 */
function _countSuccess(name) {
  if (!name) return;
  _efBreakers[name] = { fails: 0, openUntil: 0, halfOpen: false };
}

/**
 * PostgREST 直查公开表（anon 只读）。
 * @param {string} table  表名，如 'curation_events'
 * @param {Object} [query] { select, eq:{col:val}, limit, order }
 * @returns {Promise<Array>}
 */
function rest(table, query) {
  return new Promise(function (resolve, reject) {
    if (!enabled()) { reject(new Error('supabase disabled')); return; }
    var q = query || {};
    var hdr = {
      'apikey': sb().anonKey,
      'Authorization': 'Bearer ' + sb().anonKey
    };
    var url = sb().url + '/rest/v1/' + table + '?select=' + encodeURIComponent(q.select || '*');
    if (q.eq) {
      Object.keys(q.eq).forEach(function (k) {
        // ★ 2026-09-13：值可带操作符前缀（gte./lte./gt./lt./not.）——若带则原样使用
        var v = String(q.eq[k]);
        var isOp = /^(eq|gte|lte|gt|lt|not|like|in)\./.test(v);
        url += '&' + k + '=' + (isOp ? v : 'eq.' + encodeURIComponent(v));
      });
    }
    if (q.limit) url += '&limit=' + q.limit;
    // ★ 2026-09-13：支持 Range 分页（PostgREST 单次有 max-rows 上限，默认 1000，
    //   超过会静默截断 —— 与云开发 .limit(500) 是同一类坑，必须显式分页）
    if (q.range) hdr.Range = q.range;
    if (q.order) url += '&order=' + q.order;

    wx.request({
      url: url,
      method: 'GET',
      timeout: 25000,
      header: hdr,
      success: function (res) {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(res.data || []);
        else reject(new Error('REST ' + table + ' HTTP ' + res.statusCode));
      },
      fail: function (err) { reject(new Error(err.errMsg || 'network fail')); }
    });
  });
}

module.exports = {
  enabled: enabled,
  efAvailable: efAvailable,
  edge: edge,
  rest: rest
};
