// scripts/test-keys-local.js
// 本地直连 STRATZ + Steam API 测试 key 有效性
// 使用方法：
//   1. 把下方 API_KEY 和 STEAM_KEY 替换为你申请的 key
//   2. 在终端运行：node scripts/test-keys-local.js
//
// 作用：区分「key 本身无效」还是「云函数 IP 被屏蔽」
//   - 本地测试成功 + 云函数测试失败 → 云函数 IP 被外部服务屏蔽
//   - 本地测试失败 → key 本身无效，需重新申请

const https = require('https');
const http = require('http');

// ★★★ 把下面两个 key 替换为你申请的 key ★★★
// ★ 2026-09-11（脱敏）：原硬编码 STRATZ token —— 推 GitHub 即泄露个人凭证，改为本地密钥文件/env。
const LOCAL_SECRETS = require('./load-local-secrets.js');
const API_KEY = process.env.STRATZ_API_KEY || LOCAL_SECRETS.STRATZ_API_KEY || '';
if (!API_KEY) {
  console.log('跳过：未配置 STRATZ_API_KEY（本机无 .secrets.local.json / 环境变量）');
  process.exit(0);
}
const STEAM_KEY = 'E1D15F00CCE474FC2539B47E44A322E1';
// ★★★★★★★★★★★★★★★★★★★★★★★★★★★

const STRATZ_BASE = 'https://api.stratz.com/graphql';
const STEAM_BASE = 'https://api.steampowered.com/IDOTA2Match_570';

function httpsGet(url, options) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options || {}, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => resolve({ statusCode: res.statusCode, data: data }));
    });
    req.on('error', reject);
    if (options && options.body) req.write(options.body);
    req.end();
  });
}

function httpsPost(url, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: headers
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => resolve({ statusCode: res.statusCode, data: data }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function testStratz() {
  console.log('====== 测试 1: STRATZ_API_KEY 本地直连 ======');
  console.log('Key 前 30 字符:', API_KEY.slice(0, 30) + '...');
  console.log('Key 总长度:', API_KEY.length, '字符');
  console.log('');

  if (API_KEY === '在此粘贴你的 STRATZ key' || !API_KEY) {
    console.log('⚠️ 请先在脚本顶部填入 STRATZ key');
    return;
  }

  // 检查 JWT 格式
  const parts = API_KEY.split('.');
  if (parts.length !== 3) {
    console.log('❌ Key 格式错误：STRATZ key 应为 JWT 格式（三段以 . 分隔）');
    console.log('   当前分段数:', parts.length);
    console.log('   可能原因：复制时漏掉字符 / 复制了 OAuth 回调 URL 而非 key');
    return;
  }

  // 解码 JWT payload 检查过期时间
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
    const expDate = new Date(payload.exp * 1000);
    const now = new Date();
    console.log('Key 过期时间:', expDate.toLocaleString());
    console.log('当前时间:', now.toLocaleString());
    if (payload.exp * 1000 < now.getTime()) {
      console.log('❌ Key 已过期！需到 https://stratz.com/api 重新申请');
      return;
    }
    console.log('✅ Key 未过期');
    console.log('');
  } catch (e) {
    console.log('⚠️ 无法解析 JWT payload:', e.message);
  }

  // 测试 GraphQL 请求
  console.log('--- 发送 GraphQL 请求 ---');
  const query = 'query { leagues(request: { take: 1 }) { id name tier displayName } }';
  const body = JSON.stringify({ query });
  try {
    const res = await httpsPost(STRATZ_BASE, {
      'content-type': 'application/json',
      'Accept': 'application/json',
      'Authorization': 'Bearer ' + API_KEY
    }, body);
    console.log('HTTP 状态码:', res.statusCode);
    if (res.statusCode === 200) {
      const j = JSON.parse(res.data);
      if (j.data && j.data.leagues) {
        console.log('✅ STRATZ key 有效！');
        console.log('   leagues 数量:', j.data.leagues.length);
        console.log('   首条:', JSON.stringify(j.data.leagues[0]));
      } else if (j.errors) {
        console.log('❌ GraphQL 返回错误:', JSON.stringify(j.errors));
      }
    } else if (res.statusCode === 401) {
      console.log('❌ 401 Unauthorized：key 无效或格式错误');
    } else if (res.statusCode === 403) {
      console.log('❌ 403 Forbidden：key 被拒绝');
      console.log('   可能原因：key 已吊销 / STRATZ 封禁了你的 IP');
      console.log('   响应内容:', res.data.slice(0, 500));
    } else {
      console.log('❌ 异常状态码:', res.statusCode);
      console.log('   响应内容:', res.data.slice(0, 500));
    }
  } catch (e) {
    console.log('❌ 请求异常:', e.message);
    console.log('   可能原因：本地网络无法访问 api.stratz.com');
  }
  console.log('');
}

async function testSteam() {
  console.log('====== 测试 2: STEAM_API_KEY 本地直连 ======');
  console.log('Key:', STEAM_KEY.slice(0, 8) + '...(共 ' + STEAM_KEY.length + ' 字符)');
  console.log('');

  if (STEAM_KEY === '在此粘贴你的 Steam key' || !STEAM_KEY) {
    console.log('⚠️ 请先在脚本顶部填入 Steam key');
    return;
  }

  // 检查 key 格式
  if (!/^[A-F0-9]{32}$/i.test(STEAM_KEY)) {
    console.log('❌ Key 格式错误：Steam key 应为 32 位十六进制字符串');
    console.log('   当前长度:', STEAM_KEY.length);
    console.log('   可能原因：复制时带入空格/换行 / 误复制了域名');
    return;
  }
  console.log('✅ Key 格式正确（32 位十六进制）');
  console.log('');

  // 测试 GetTopLiveGame 接口（真实存在的接口，用 league_id 做参数测试鉴权）
  // 也可用 GetMatchDetails，但需要 match_id，这里用 GetTopLiveGame 只为验证 key 有效性
  console.log('--- 发送 Steam Web API 请求 ---');
  // 改用 GetMatchHistory 接口测试（真实存在，只需 key 即可返回数据）
  const steamBase = 'https://api.steampowered.com/IDOTA2Match_570';
  const url = steamBase + '/GetMatchHistory/v1/?key=' + STEAM_KEY + '&matches_requested=1';
  try {
    const res = await httpsGet(url);
    console.log('HTTP 状态码:', res.statusCode);
    if (res.statusCode === 200) {
      const j = JSON.parse(res.data);
      if (j.result) {
        console.log('✅ Steam key 有效！');
        console.log('   匹配数量:', j.result.num_results);
        console.log('   返回样例:', JSON.stringify(j.result).slice(0, 300));
      } else {
        console.log('⚠️ 响应无 result 字段:', res.data.slice(0, 300));
      }
    } else if (res.statusCode === 401 || res.statusCode === 403) {
      console.log('❌ ' + res.statusCode + '：key 无效');
      console.log('   响应内容:', res.data.slice(0, 500));
    } else {
      console.log('❌ 异常状态码:', res.statusCode);
      console.log('   响应内容:', res.data.slice(0, 500));
    }
  } catch (e) {
    console.log('❌ 请求异常:', e.message);
    console.log('   可能原因：本地网络无法访问 api.steampowered.com');
  }
  console.log('');
}

async function main() {
  console.log('========================================');
  console.log('  STRATZ + Steam API 本地 key 诊断');
  console.log('  测试时间:', new Date().toLocaleString());
  console.log('========================================\n');

  await testStratz();
  await testSteam();

  console.log('====== 诊断结论 ======');
  console.log('若本地测试成功 + 云函数测试失败 → 云函数 IP 被外部服务屏蔽');
  console.log('若本地测试失败 → key 本身无效，需重新申请');
  console.log('若本地测试成功 + 云函数测试成功 → 配置全部正确，可正常使用');
}

main().catch(e => console.log('异常:', e.message));
