/*
 * 云函数鉴权守卫探测器（O-26 验证）
 * ----------------------------------------------------
 * 用途：验证 aggregation 云函数是否已部署 O-26 鉴权守卫（2026-08-15）
 *
 * 使用方法：
 *   1. 在微信开发者工具里打开本项目并编译
 *   2. 打开 Console（调试器面板下方）
 *   3. 复制本文件内容粘贴到 Console 回车运行
 *
 * 探测三层鉴权（全部生效才算部署成功）：
 *   [1] 普通调用 getCached 带非白名单前缀（如 /leagues）→ 应被 forbidden 拦截
 *   [2] 普通调用 getCached 带 follow_profile_ 前缀 → 应放行（hit 或 miss 均可）
 *   [3] 非管理员调用 adminWriteCuration → 应被 forbidden 拦截
 *       （若调用方 OPENID 已加入 ADMIN_OPENIDS，此项会放行——属正常，脚本会提示）
 *
 * 判定规则：
 *   - [1] 拦截 + [2] 放行 + [3] 拦截 = ✅ 鉴权三层全部生效
 *   - 任一项不符 = ❌ 未生效或部分生效（脚本会逐项标注）
 */
(function () {
  if (typeof wx === 'undefined' || !wx.cloud) {
    console.error('[probe-auth] 必须在小程序运行时环境（wx.cloud 不可用）');
    return;
  }

  // 确保 cloud 已初始化（若 app.js 已 init，重复 init 会被忽略）
  try { wx.cloud.init({ traceUser: true }); } catch (e) {}

  const TAG = '[鉴权守卫探测]';
  const CALL_TIMEOUT = 12000;

  console.log(`${TAG} 开始探测 O-26 鉴权守卫（2026-08-15）`);

  function callFunc(action, params) {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve({ __timeout: true });
        }
      }, CALL_TIMEOUT);

      wx.cloud.callFunction({
        name: 'aggregation',
        data: { action, params: params || {} },
        success: (res) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ __ok: true, result: res.result });
        },
        fail: (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ __ok: false, error: err });
        }
      });
    });
  }

  // 判断是否被 forbidden 拦截
  function isForbidden(result) {
    if (!result) return false;
    const err = result.error || {};
    return err.code === 'forbidden' || /forbidden|unauthorized|prefix not allowed/.test(err.message || err.error || '');
  }

  async function probe() {
    // ===== 探测 1：getCached 带非白名单前缀（应被拦截）=====
    console.log(`%c${TAG} [1/3] getCached 带非白名单前缀 "/leagues" → 期望：forbidden 拦截`, 'color:#3a7afe');
    const t1 = await callFunc('getCached', { key: '/leagues|{}' });
    let pass1 = false;
    let verdict1 = '';
    if (t1.__timeout) {
      verdict1 = '⚠️ 超时';
    } else if (!t1.__ok) {
      verdict1 = `⚠️ 调用失败：${(t1.error && t1.error.errMsg) || '网络错误'}`;
    } else if (isForbidden(t1.result)) {
      verdict1 = '✅ 已拦截（forbidden）';
      pass1 = true;
    } else {
      verdict1 = `❌ 未拦截（返回：${JSON.stringify(t1.result).slice(0, 80)}）`;
    }
    console.log(`%c  → ${verdict1}`, `color:${pass1 ? '#1aad19' : '#e64340'};font-weight:bold`);

    // ===== 探测 2：getCached 带白名单前缀（应放行）=====
    console.log(`%c${TAG} [2/3] getCached 带白名单前缀 "follow_profile_test" → 期望：放行`, 'color:#3a7afe');
    const t2 = await callFunc('getCached', { key: 'follow_profile_probe_auth_test' });
    let pass2 = false;
    let verdict2 = '';
    if (t2.__timeout) {
      verdict2 = '⚠️ 超时';
    } else if (!t2.__ok) {
      verdict2 = `⚠️ 调用失败：${(t2.error && t2.error.errMsg) || '网络错误'}`;
    } else if (isForbidden(t2.result)) {
      verdict2 = `❌ 被误拦截（forbidden）——前缀校验有误`;
    } else {
      // hit 或 miss 都算放行成功
      verdict2 = `✅ 已放行（${t2.result && t2.result.hit ? '命中缓存' : '未命中缓存'}）`;
      pass2 = true;
    }
    console.log(`%c  → ${verdict2}`, `color:${pass2 ? '#1aad19' : '#e64340'};font-weight:bold`);

    // ===== 探测 3：adminWriteCuration 非管理员（应被拦截）=====
    // 注意：如果你已把自己的 OPENID 配入 ADMIN_OPENIDS，此处会放行——脚本会提示
    console.log(`%c${TAG} [3/3] adminWriteCuration → 期望：forbidden（除非调用方是管理员）`, 'color:#3a7afe');
    const t3 = await callFunc('adminWriteCuration', { op: 'noop' });
    let pass3 = false;
    let verdict3 = '';
    if (t3.__timeout) {
      verdict3 = '⚠️ 超时';
    } else if (!t3.__ok) {
      verdict3 = `⚠️ 调用失败：${(t3.error && t3.error.errMsg) || '网络错误'}`;
    } else if (isForbidden(t3.result)) {
      verdict3 = '✅ 已拦截（forbidden，调用方非管理员）';
      pass3 = true;
    } else {
      verdict3 = `⚪ 放行（说明调用方 OPENID 已在 ADMIN_OPENIDS 白名单——属正常配置）`;
      pass3 = true; // 放行也通过（管理员自己调用）
    }
    console.log(`%c  → ${verdict3}`, `color:${pass3 ? '#1aad19' : '#e64340'};font-weight:bold`);

    // ===== 综合判定 =====
    const allPass = pass1 && pass2 && pass3;
    const color = allPass ? '#1aad19' : '#e64340';
    console.log('\n' + '='.repeat(60));
    console.log(`%c${TAG} 综合判定：${allPass ? '✅ O-26 鉴权守卫已生效' : '❌ 鉴权未完全生效，请检查部署'}`,
      `color:${color};font-weight:bold;font-size:14px;padding:4px 8px;border:2px solid ${color}`);
    console.log(`  [1] 非白名单前缀拦截：${pass1 ? '✅' : '❌'}`);
    console.log(`  [2] 白名单前缀放行：${pass2 ? '✅' : '❌'}`);
    console.log(`  [3] admin 拦截/放行：${pass3 ? '✅' : '❌'}`);
    console.log('='.repeat(60));

    return { pass1, pass2, pass3, allPass };
  }

  probe().catch((e) => console.error(`${TAG} 探测异常：`, e));
})();
