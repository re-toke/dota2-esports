// STRATZ API 直连诊断脚本
// 验证：1) apiKey 是否有效 2) GraphQL schema 是否变更 3) 赛程查询是否返回数据

const https = require('https');

const API_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJTdWJqZWN0IjoiZDlkZjAzNGQtMDdlYy00ZGUzLTkzYTktZGJhYmFhYTc3OWFhIiwiU3RlYW1JZCI6IjE3NzUzNzU0MCIsIkFQSVVzZXIiOiJ0cnVlIiwibmJmIjoxNzg0NjMxMDA2LCJleHAiOjE4MTYxNjcwMDYsImlhdCI6MTc4NDYzMTAwNiwiaXNzIjoiaHR0cHM6Ly9hcGkuc3RyYXR6LmNvbSJ9.ic7GBS5tAVm0VCgYP_1ZUSskpj5piSyaDwZLq2pbE3g';
const BASE = 'https://api.stratz.com/graphql';

function gql(query, variables) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query, variables: variables || {} });
    const req = https.request(BASE, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Accept': 'application/json',
        'Authorization': 'Bearer ' + API_KEY
      }
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, data: data });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  console.log('=== STRATZ API 诊断 ===\n');

  // 测试 1: 查询 leagues 列表（项目用的查询）
  console.log('--- 测试 1: 项目原查询 leagues(request: {take: 200}) ---');
  const t1 = await gql('query { leagues(request: { take: 200 }) { id name tier displayName } }');
  console.log('HTTP:', t1.statusCode);
  if (t1.statusCode === 401 || t1.statusCode === 403) {
    console.log('❌ 认证失败：apiKey 无效或已过期');
  }
  try {
    const j = JSON.parse(t1.data);
    if (j.errors) {
      console.log('❌ GraphQL errors:', JSON.stringify(j.errors, null, 2));
    }
    if (j.data && j.data.leagues) {
      console.log('✅ leagues 数量:', j.data.leagues.length);
      console.log('前3条:', JSON.stringify(j.data.leagues.slice(0, 3), null, 2));
    } else {
      console.log('⚠️ 响应无 data.leagues:', t1.data.slice(0, 500));
    }
  } catch (e) {
    console.log('⚠️ 非 JSON 响应:', t1.data.slice(0, 500));
  }

  // 测试 2: 查询某联赛的赛程
  console.log('\n--- 测试 2: league(id) startDateTime/endDateTime ---');
  // 先尝试一个已知 id（从测试1结果获取）
  let leagueId = 15437;  // 默认用一个 id
  try {
    const j = JSON.parse(t1.data);
    if (j.data && j.data.leagues && j.data.leagues.length > 0) {
      leagueId = j.data.leagues[0].id;
      console.log('使用第一个联赛 id:', leagueId, 'name:', j.data.leagues[0].name);
    }
  } catch (e) {}

  const t2 = await gql('query ($id: Int!) { league(id: $id) { startDateTime endDateTime } }', { id: leagueId });
  console.log('HTTP:', t2.statusCode);
  try {
    const j = JSON.parse(t2.data);
    if (j.errors) {
      console.log('❌ GraphQL errors:', JSON.stringify(j.errors, null, 2));
      console.log('→ Schema 可能已变更，startDateTime/endDateTime 字段名不对');
    }
    if (j.data && j.data.league) {
      console.log('✅ league 赛程:', JSON.stringify(j.data.league));
    } else {
      console.log('⚠️ 响应无 data.league:', t2.data.slice(0, 500));
    }
  } catch (e) {
    console.log('⚠️ 非 JSON 响应:', t2.data.slice(0, 500));
  }

  // 测试 3: 探索 league 的可用字段（introspection）
  console.log('\n--- 测试 3: introspect league 字段 ---');
  const t3 = await gql('{ __type(name: "League") { fields { name type { name kind } } } }');
  console.log('HTTP:', t3.statusCode);
  try {
    const j = JSON.parse(t3.data);
    if (j.data && j.data.__type && j.data.__type.fields) {
      const fields = j.data.__type.fields.map(f => f.name + ':' + (f.type.name || f.type.kind));
      console.log('✅ League 类型字段:');
      fields.forEach(f => console.log('  -', f));
      const hasStart = fields.some(f => f.startsWith('startDateTime'));
      const hasEnd = fields.some(f => f.startsWith('endDateTime'));
      console.log('\n含 startDateTime:', hasStart);
      console.log('含 endDateTime:', hasEnd);
      if (!hasStart) {
        const startFields = fields.filter(f => f.toLowerCase().includes('start') || f.toLowerCase().includes('date') || f.toLowerCase().includes('time'));
        console.log('可能的替代字段:', startFields);
      }
    } else {
      console.log('⚠️ introspection 失败:', t3.data.slice(0, 500));
    }
  } catch (e) {
    console.log('⚠️ 非 JSON 响应:', t3.data.slice(0, 500));
  }

  // 测试 4: leagues 的字段
  console.log('\n--- 测试 4: introspect leagues 查询字段 ---');
  const t4 = await gql('{ __type(name: "LeagueQueryType") { fields { name args { name type { name kind ofType { name kind } } } } } }');
  try {
    const j = JSON.parse(t4.data);
    if (j.data && j.data.__type) {
      console.log('✅ LeagueQueryType 字段:');
      j.data.__type.fields.forEach(f => console.log('  -', f.name));
    }
  } catch (e) {}
}

main().catch(e => console.log('异常:', e.message));
