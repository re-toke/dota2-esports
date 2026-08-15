/*
 * 云函数部署版本探测器（432ae9b 验证）
 * ----------------------------------------------------
 * 用途：判断云端 aggregation 云函数是否已部署 432ae9b（2026-08-15）之后的版本
 *
 * 使用方法：
 *   1. 在微信开发者工具里打开本项目并编译
 *   2. 打开 Console（调试器面板下方）
 *   3. 复制本文件内容粘贴到 Console 回车运行
 *   或者：
 *   4. 在小程序任意页面 Console 里运行 require('../../scripts/probe-cloud-version.js')
 *
 * 探测特征（基于 432ae9b 的真实代码差异）：
 *   - health action：旧版返回 unknown action；新版返回 { ts, sources:{liquipedia,opendota}, ok }
 *   - getUpcomingSchedule action：旧版冷缓存现场预热挂起30-60s 返回 source:'fresh'；
 *     新版 fire-and-forget 立即返回 { data:{}, source:'cold', preheating:true }
 *
 * 注意：getUpcomingSchedule 若云端缓存命中会返回 source:'cache'，探测不出差异，
 *       所以本脚本同时探测 health（绝对特征）+ getUpcomingSchedule（辅助特征）。
 */
(function () {
  if (typeof wx === 'undefined' || !wx.cloud) {
    console.error('[probe] 必须在小程序运行时环境（wx.cloud 不可用）');
    return;
  }

  // 确保 cloud 已初始化（若 app.js 已 init，重复 init 会被忽略）
  try { wx.cloud.init({ traceUser: true }); } catch (e) {}

  const TAG = '[云函数版本探测]';
  const TARGET_COMMIT = '432ae9b';
  const CALL_TIMEOUT = 15000; // 新版应秒回；旧版 preheat 会挂起，用 15s 超时兜底

  console.log(`${TAG} 开始探测，目标验证提交 = ${TARGET_COMMIT}（2026-08-15）`);

  function callFunc(action, params) {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve({ __timeout: true, __elapsedMs: CALL_TIMEOUT });
        }
      }, CALL_TIMEOUT);

      const t0 = Date.now();
      wx.cloud.callFunction({
        name: 'aggregation',
        data: { action, params: params || {} },
        success: (res) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ __ok: true, result: res.result, __elapsedMs: Date.now() - t0 });
        },
        fail: (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ __ok: false, error: err, __elapsedMs: Date.now() - t0 });
        }
      });
    });
  }

  async function probe() {
    // ===== 探测 1：health（绝对特征） =====
    console.log(`%c${TAG} [1/2] 调用 health（2026-08-11 新增，旧版应有 unknown action）`, 'color:#3a7afe');
    const healthRes = await callFunc('health');
    let healthVerdict = '';
    let healthIsNew = false;
    if (healthRes.__timeout) {
      healthVerdict = '超时（不正常，health 应秒回）';
    } else if (!healthRes.__ok) {
      healthVerdict = `调用失败：${(healthRes.error && healthRes.error.errMsg) || JSON.stringify(healthRes.error)}`;
    } else if (healthRes.result && healthRes.result.error && /unknown action/.test(healthRes.result.error.message || '')) {
      healthVerdict = '❌ 旧版（返回 unknown action: health）';
      healthIsNew = false;
    } else if (healthRes.result && healthRes.result.data && healthRes.result.data.ts && healthRes.result.data.sources) {
      // ⚠️ 2026-08-15 修正（重复踩坑记录）：handleHealth 返回 {data:{ts,sources,ok}, source:'fresh'}
      //   字段在 result.data 层，非顶层。旧判定检查 result.ts 会误判新版为「异常」。
      healthVerdict = '✅ 新版（返回 data.ts + data.sources 健康对象）';
      healthIsNew = true;
    } else {
      healthVerdict = `⚠️ 异常返回：${JSON.stringify(healthRes.result)}`;
    }
    console.log(`%c  → ${healthVerdict}`, `color:${healthIsNew ? '#1aad19' : '#e64340'};font-weight:bold`);
    console.log(`  耗时：${healthRes.__elapsedMs}ms`, healthRes.result || healthRes.error || '(timeout)');

    // ===== 探测 2：getUpcomingSchedule（辅助特征，可能被缓存命中干扰） =====
    console.log(`%c${TAG} [2/2] 调用 getUpcomingSchedule（432ae9b 冷缓存应返回 preheating:true）`, 'color:#3a7afe');
    const schedRes = await callFunc('getUpcomingSchedule', { force: true });
    let schedVerdict = '';
    let schedIsNew = false;
    if (schedRes.__timeout) {
      // 旧版会现场预热 30-60s，15s 超时刚好能截获"还在挂起"的特征
      schedVerdict = '⚠️ 超时（疑似旧版现场预热挂起，或网络异常）';
    } else if (!schedRes.__ok) {
      schedVerdict = `调用失败：${(schedRes.error && schedRes.error.errMsg) || JSON.stringify(schedRes.error)}`;
    } else if (schedRes.result && schedRes.result.source === 'cold' && schedRes.result.preheating === true) {
      schedVerdict = '✅ 新版（fire-and-forget 返回 cold + preheating:true）';
      schedIsNew = true;
    } else if (schedRes.result && schedRes.result.source === 'cache') {
      schedVerdict = '⚪ 缓存命中（云端有 upcoming_schedule 缓存，探测不出差异，参考 health 判定）';
      schedIsNew = healthIsNew; // 以 health 为准
    } else if (schedRes.result && schedRes.result.source === 'fresh') {
      schedVerdict = '❌ 旧版（现场预热返回 fresh）';
      schedIsNew = false;
    } else {
      schedVerdict = `⚠️ 异常返回：${JSON.stringify(schedRes.result)}`;
    }
    console.log(`%c  → ${schedVerdict}`, `color:${schedIsNew ? '#1aad19' : '#e64340'};font-weight:bold`);
    console.log(`  耗时：${schedRes.__elapsedMs}ms`, schedRes.result || schedRes.error || '(timeout)');

    // ===== 综合判定 =====
    const finalIsNew = healthIsNew; // health 是绝对特征，以其为准
    const tagColor = finalIsNew ? '#1aad19' : '#e64340';
    console.log('\n' + '='.repeat(60));
    console.log(`%c${TAG} 综合判定：${finalIsNew ? '✅ 云端已部署新版（≥432ae9b）' : '❌ 云端仍是旧版，需要重新部署'}`,
      `color:${tagColor};font-weight:bold;font-size:14px;padding:4px 8px;border:2px solid ${tagColor}`);
    console.log(`  health 探测：${healthIsNew ? '新版' : '旧版'}`);
    console.log(`  getUpcomingSchedule 探测：${schedIsNew ? '新版或缓存命中' : '旧版或超时'}`);
    console.log(`  最终结论以 health 为准（它是 2026-08-11 之后才有的绝对特征）`);
    console.log('='.repeat(60));

    return { healthIsNew, schedIsNew, finalIsNew };
  }

  probe().catch((e) => console.error(`${TAG} 探测异常：`, e));
})();
