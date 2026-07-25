// pages/stratz-test/stratz-test.js
// STRATZ API 连通性诊断页面
// 验证微信小程序 wx.request 是否能绕过 Cloudflare 访问 STRATZ GraphQL
const config = require('../../utils/config.js');

Page({
  data: {
    results: [],
    testing: false,
    enabled: config.stratz.enabled,
    base: config.stratz.base,
    apiKeyLen: (config.stratz.apiKey || '').length
  },

  // 测试 1: STRATZ leagues 查询
  testLeagues() {
    return this._gql('query { leagues(request: { take: 5 }) { id name tier displayName } }', {});
  },

  // 测试 2: STRATZ 单个联赛查询
  testLeague() {
    return this._gql('query ($id: Int!) { league(id: $id) { id name startDateTime endDateTime } }', { id: 15437 });
  },

  // 测试 3: STRATZ introspect（查看 League 字段）
  testIntrospect() {
    return this._gql('{ __type(name: "League") { fields { name type { name kind } } } }', {});
  },

  // 通用 GraphQL 请求
  _gql(query, variables) {
    return new Promise((resolve) => {
      const start = Date.now();
      wx.request({
        url: config.stratz.base,
        method: 'POST',
        header: {
          'content-type': 'application/json',
          'Accept': 'application/json',
          'Authorization': 'Bearer ' + config.stratz.apiKey
        },
        data: JSON.stringify({ query: query, variables: variables || {} }),
        success: (res) => {
          const elapsed = Date.now() - start;
          let summary = '';
          let isCloudflare = false;
          if (typeof res.data === 'string') {
            isCloudflare = res.data.indexOf('Just a moment') >= 0 || res.data.indexOf('cloudflare') >= 0;
            summary = isCloudflare ? 'Cloudflare 拦截' : '非 JSON: ' + res.data.slice(0, 200);
          } else if (res.data && res.data.errors) {
            summary = 'GraphQL errors: ' + JSON.stringify(res.data.errors).slice(0, 200);
          } else if (res.data && res.data.data) {
            summary = '成功: ' + JSON.stringify(res.data.data).slice(0, 300);
          } else {
            summary = '未知响应: ' + JSON.stringify(res.data).slice(0, 200);
          }
          resolve({
            statusCode: res.statusCode,
            elapsed: elapsed + 'ms',
            isCloudflare: isCloudflare,
            summary: summary
          });
        },
        fail: (err) => {
          resolve({
            statusCode: -1,
            elapsed: (Date.now() - start) + 'ms',
            isCloudflare: false,
            summary: '请求失败: ' + (err.errMsg || JSON.stringify(err))
          });
        }
      });
    });
  },

  // 一键运行全部测试
  runAll() {
    if (this.data.testing) return;
    this.setData({ testing: true, results: [] });

    const tests = [
      { name: 'STRATZ leagues 查询', fn: () => this.testLeagues() },
      { name: 'STRATZ league(id) 赛程查询', fn: () => this.testLeague() },
      { name: 'STRATZ introspect League 字段', fn: () => this.testIntrospect() }
    ];

    const results = [];
    let i = 0;
    const runNext = () => {
      if (i >= tests.length) {
        this.setData({ testing: false, results: results });
        return;
      }
      const t = tests[i];
      i++;
      t.fn().then((r) => {
        results.push({
          name: t.name,
          statusCode: r.statusCode,
          elapsed: r.elapsed,
          isCloudflare: r.isCloudflare,
          summary: r.summary,
          status: r.statusCode === 200 && !r.isCloudflare ? 'pass' : 'fail'
        });
        this.setData({ results: results });
        runNext();
      });
    };
    runNext();
  }
});
