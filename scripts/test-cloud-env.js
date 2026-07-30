// scripts/test-cloud-env.js
// 云函数环境变量配置测试（STRATZ_API_KEY / STEAM_API_KEY）
//
// 使用方法（两种）：
//
// 方法 A：在微信开发者工具「云开发 → 云函数 → 本地调试」中调用
//   1. 打开云开发控制台 → 云函数 → aggregation → 本地调试
//   2. 事件参数粘贴：{ "action": "stratzGql", "query": "query { leagues(request:{take:1}){id name}}" }
//   3. 查看返回：data.data.leagues 存在 → STRATZ key 生效
//                error.code = 'upstream_error' → STRATZ_KEY 未配置或无效
//
// 方法 B：在小程序任意页面的 Console 中粘贴本文件内容运行
//   打开小程序任意页面（如首页），在开发者工具 Console 粘贴下方代码
//
// 返回值判读：
//   STRATZ:  data.data.leagues 数组 → ✅ STRATZ_API_KEY 配置成功
//            error.code = 'upstream_error' → ❌ STRATZ_API_KEY 未配置
//            error.code = 'bad_request' → query 参数格式问题
//
//   Steam:   data.data 匹配信息对象 → ✅ STEAM_API_KEY 配置成功
//            error.code = 'not_configured' → ❌ STEAM_API_KEY 未配置
//            error.code = 'upstream_error' → STEAM_API_KEY 已配置但请求失败

// ===== 方法 B：Console 直接运行版本 =====
// 把下面的 IIFE 代码块复制到开发者工具 Console，按回车运行

(function testCloudEnv() {
  if (typeof wx === 'undefined' || !wx.cloud) {
    console.error('[test-cloud-env] 当前环境不支持 wx.cloud，请在微信开发者工具的模拟器/真机 Console 中运行');
    return;
  }

  console.log('====== 云函数环境变量配置测试 ======');
  console.log('测试时间：', new Date().toLocaleString());
  console.log('');

  // ===== 测试 1：STRATZ_API_KEY =====
  console.log('--- 测试 1: STRATZ_API_KEY ---');
  wx.cloud.callFunction({
    name: 'aggregation',
    data: {
      action: 'stratzGql',
      query: 'query { leagues(request: { take: 1 }) { id name tier displayName } }'
    }
  }).then((res) => {
    const r = res && res.result;
    if (!r) {
      console.error('❌ STRATZ: 云函数无返回值（检查云函数是否部署）');
      return;
    }
    if (r.error) {
      console.error('❌ STRATZ_API_KEY 配置失败');
      console.error('   错误码：', r.error.code || 'unknown');
      console.error('   错误信息：', r.error.message || r.error.error || '');
      if (r.error.code === 'upstream_error') {
        console.error('   原因：STRATZ_API_KEY 环境变量未配置，或 key 已过期');
        console.error('   修复：①云开发控制台 → 设置 → 环境变量 → 新建 STRATZ_API_KEY');
        console.error('         ②重新部署 cloudfunctions/aggregation');
        console.error('         ③申请地址：https://stratz.com/api');
      }
      return;
    }
    if (r.data && r.data.data && r.data.data.leagues) {
      console.log('✅ STRATZ_API_KEY 配置成功');
      console.log('   leagues 数量：', r.data.data.leagues.length);
      console.log('   首条样例：', JSON.stringify(r.data.data.leagues[0]));
      console.log('   数据源：', r.source);
    } else {
      console.error('❌ STRATZ: 返回结构异常');
      console.error('   原始返回：', JSON.stringify(r).slice(0, 500));
    }
    console.log('');
    testSteam();  // 串行执行测试 2
  }).catch((err) => {
    console.error('❌ STRATZ 调用异常：', err && err.errMsg || err);
    console.error('   可能原因：云函数未部署 / 云环境 ID 错误 / 网络问题');
    console.log('');
    testSteam();
  });

  // ===== 测试 2：STEAM_API_KEY =====
  function testSteam() {
    console.log('--- 测试 2: STEAM_API_KEY ---');
    // 使用 GetLeagueInfo 接口（无参数依赖，返回固定结构）
    wx.cloud.callFunction({
      name: 'aggregation',
      data: {
        action: 'steamProxy',
        path: '/GetLeagueInfo/v1',
        params: { league_id: 15437 }
      }
    }).then((res) => {
      const r = res && res.result;
      if (!r) {
        console.error('❌ Steam: 云函数无返回值');
        return;
      }
      if (r.error) {
        if (r.error.code === 'not_configured') {
          console.error('❌ STEAM_API_KEY 未配置');
          console.error('   修复：①云开发控制台 → 设置 → 环境变量 → 新建 STEAM_API_KEY');
          console.error('         ②重新部署 cloudfunctions/aggregation');
          console.error('         ③申请地址：https://steamcommunity.com/dev/apikey');
        } else {
          console.error('❌ STEAM_API_KEY 已配置但请求失败');
          console.error('   错误码：', r.error.code);
          console.error('   错误信息：', r.error.message || r.error.error || '');
          console.error('   可能原因：key 无效 / Steam 服务不可用 / 网络问题');
        }
        return;
      }
      if (r.data) {
        console.log('✅ STEAM_API_KEY 配置成功');
        console.log('   数据源：', r.source);
        console.log('   返回样例：', JSON.stringify(r.data).slice(0, 300));
      } else {
        console.error('❌ Steam: 返回结构异常');
        console.error('   原始返回：', JSON.stringify(r).slice(0, 500));
      }
      console.log('');
      testSummary();
    }).catch((err) => {
      console.error('❌ Steam 调用异常：', err && err.errMsg || err);
      console.log('');
      testSummary();
    });
  }

  // ===== 测试 3：Liquipedia 云代理（无 key 依赖，仅验证云函数是否部署） =====
  function testSummary() {
    console.log('--- 测试 3: 云函数部署验证 ---');
    wx.cloud.callFunction({
      name: 'aggregation',
      data: { action: 'getExperiments' }
    }).then((res) => {
      const r = res && res.result;
      if (r && r.experiments) {
        console.log('✅ 云函数 aggregation 部署正常');
        console.log('   ab 实验：', JSON.stringify(r.experiments));
      } else {
        console.error('❌ 云函数 aggregation 异常：', JSON.stringify(r).slice(0, 200));
      }
      console.log('');
      console.log('====== 测试结束 ======');
    }).catch((err) => {
      console.error('❌ 云函数 aggregation 未部署或异常：', err && err.errMsg || err);
      console.error('   修复：右键 cloudfunctions/aggregation → 上传并部署：云端安装依赖');
      console.log('');
      console.log('====== 测试结束 ======');
    });
  }
})();
