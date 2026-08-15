// 完整诊断测试：验证 parseScheduledMatches 在真实 wikitext 上的解析能力
// 用法：node scripts/test-scheduled-full.js
//
// 本脚本绕过 wx.request（Node.js 不可用），直接用 https 模块拉取 Liquipedia wikitext，
// 验证：重定向跟随 → {{Match}} 模板解析 → phase 分类 → 数据完整性

const https = require('https');
const zlib = require('zlib');
const LiquiParse = require('../../utils/liquipedia-parse.js');

let pass = 0, fail = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => { pass++; console.log('  ✓ ' + name); })
    .catch((e) => { fail++; console.log('  ✗ ' + name + ' -- ' + (e && e.message || e)); });
}

// 直接用 Node.js https 拉取 Liquipedia wikitext（绕过 wx.request）
function fetchWikitext(pageName) {
  return new Promise((resolve) => {
    const params = new URLSearchParams({
      action: 'query',
      prop: 'revisions',
      rvprop: 'content',
      rvslots: 'main',
      titles: pageName,
      format: 'json',
      formatversion: '2',
      redirects: '1'  // 跟随重定向
    });
    const url = 'https://liquipedia.net/dota2/api.php?' + params.toString();
    const options = {
      headers: {
        'User-Agent': 'DOTA2-Esports-Hub/1.0 (test; contact: dev@local)',
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip'  // ★ Liquipedia 强制要求 gzip（否则返回 406）
      }
    };
    https.get(url, options, (res) => {
      let data = '';
      // 处理 gzip 响应（即使没请求 gzip，某些服务器可能强制返回）
      const encoding = res.headers['content-encoding'] || '';
      if (encoding.indexOf('gzip') >= 0) {
        const gunzip = zlib.createGunzip();
        res.pipe(gunzip);
        gunzip.on('data', (chunk) => { data += chunk.toString(); });
        gunzip.on('end', () => {
          tryParse(data, resolve);
        });
      } else {
        res.on('data', (chunk) => { data += chunk.toString(); });
        res.on('end', () => {
          tryParse(data, resolve);
        });
      }
    }).on('error', (e) => { console.log('    网络错误:', e.message); resolve(null); });
  });
}

function tryParse(data, resolve) {
  try {
    const json = JSON.parse(data);
    if (!json.query || !json.query.pages) { resolve(null); return; }
    const page = json.query.pages[0];
    if (page.missing) { resolve(null); return; }
    if (!page.revisions || !page.revisions.length) { resolve(null); return; }
    const rev = page.revisions[0];
    const content = (rev.slots && rev.slots.main && rev.slots.main.content) || rev['*'];
    resolve({ content: content, redirects: json.query.redirects || [] });
  } catch (e) {
    console.log('    JSON 解析失败，data 前 200 字符:', data.substring(0, 200));
    resolve(null);
  }
}

console.log('--- 完整诊断测试：parseScheduledMatches 真实数据验证 ---\n');

// 测试 1：重定向跟随验证
check('重定向跟随：ESL One Birmingham 2024 → ESL One/Birmingham/2024', () => {
  return fetchWikitext('ESL One Birmingham 2024').then((res) => {
    if (!res || !res.content) throw new Error('未拿到 wikitext');
    if (res.content.length < 10000) throw new Error('wikitext 过短（' + res.content.length + ' 字节），可能未跟随重定向');
    if (res.redirects && res.redirects.length > 0) {
      console.log('    重定向:', res.redirects[0].from, '→', res.redirects[0].to);
    }
    console.log('    wikitext 长度:', res.content.length, '字节');
  });
});

// 测试 2：解析 ESL One Birmingham 2024 的赛程
check('parseScheduledMatches 解析 ESL One Birmingham 2024', () => {
  return fetchWikitext('ESL One Birmingham 2024').then((res) => {
    if (!res || !res.content) throw new Error('未拿到 wikitext');
    const matches = LiquiParse.parseScheduledMatches(res.content);
    console.log('    总对阵数:', matches.length);
    if (matches.length === 0) throw new Error('未解析到任何对阵');
    const live = matches.filter(m => m.phase === 'live');
    const upcoming = matches.filter(m => m.phase === 'upcoming');
    const recent = matches.filter(m => m.phase === 'recent');
    console.log('    LIVE:', live.length, 'UPCOMING:', upcoming.length, 'RECENT:', recent.length);
    // 验证首场数据完整性
    const m = matches[0];
    if (!m.team1Name) throw new Error('team1Name 为空');
    if (!m.team2Name) throw new Error('team2Name 为空');
    if (!m.startTime || m.startTime <= 0) throw new Error('startTime 无效: ' + m.startTime);
    if (!m.boType) throw new Error('boType 为空');
    console.log('    首场:', JSON.stringify(m));
  });
});

// 测试 3：解析 The International 2024
check('parseScheduledMatches 解析 The International 2024', () => {
  return fetchWikitext('The International 2024').then((res) => {
    if (!res || !res.content) throw new Error('未拿到 wikitext');
    const matches = LiquiParse.parseScheduledMatches(res.content);
    console.log('    TI 2024 总对阵数:', matches.length);
    if (matches.length === 0) throw new Error('未解析到任何对阵');
    const recent = matches.filter(m => m.phase === 'recent');
    console.log('    RECENT:', recent.length);
  });
});

// 测试 4：验证 BO 类型解析
check('BO 类型解析验证', () => {
  return fetchWikitext('ESL One Birmingham 2024').then((res) => {
    if (!res || !res.content) throw new Error('未拿到 wikitext');
    const matches = LiquiParse.parseScheduledMatches(res.content);
    const boTypes = {};
    matches.forEach(m => { boTypes[m.boType] = (boTypes[m.boType] || 0) + 1; });
    console.log('    BO 类型分布:', JSON.stringify(boTypes));
    if (Object.keys(boTypes).length === 0) throw new Error('无 BO 类型');
  });
});

// 测试 5：验证日期解析
check('日期解析验证', () => {
  return fetchWikitext('ESL One Birmingham 2024').then((res) => {
    if (!res || !res.content) throw new Error('未拿到 wikitext');
    const matches = LiquiParse.parseScheduledMatches(res.content);
    const invalid = matches.filter(m => !m.startTime || m.startTime <= 0);
    if (invalid.length > 0) {
      console.log('    无效日期的对阵:', invalid.length);
      throw new Error(invalid.length + ' 场对阵日期解析失败');
    }
    console.log('    所有 ' + matches.length + ' 场对阵日期解析成功');
  });
});

Promise.resolve()
    .then(() => check('重定向跟随：ESL One Birmingham 2024', () => {
      return fetchWikitext('ESL One Birmingham 2024').then((res) => {
        if (!res || !res.content) throw new Error('未拿到 wikitext');
        if (res.content.length < 10000) throw new Error('wikitext 过短（' + res.content.length + ' 字节）');
        console.log('    wikitext:', res.content.length, '字节');
      });
    }))
    .then(() => check('parseScheduledMatches 解析 ESL One Birmingham 2024', () => {
      return fetchWikitext('ESL One Birmingham 2024').then((res) => {
        if (!res || !res.content) throw new Error('未拿到 wikitext');
        const matches = LiquiParse.parseScheduledMatches(res.content);
        console.log('    总对阵数:', matches.length,
          'LIVE:', matches.filter(x=>x.phase==='live').length,
          'UPCOMING:', matches.filter(x=>x.phase==='upcoming').length,
          'RECENT:', matches.filter(x=>x.phase==='recent').length);
        if (matches.length === 0) throw new Error('未解析到任何对阵');
      });
    }))
    .then(() => check('parseScheduledMatches 解析 The International 2024', () => {
      return fetchWikitext('The International 2024').then((res) => {
        if (!res || !res.content) throw new Error('未拿到 wikitext');
        const matches = LiquiParse.parseScheduledMatches(res.content);
        console.log('    TI 2024 总对阵数:', matches.length);
        if (matches.length === 0) throw new Error('未解析到任何对阵');
      });
    }))
    .then(() => {
      console.log('\n--- 测试结果 ---');
      console.log('通过: ' + pass + ', 失败: ' + fail);
      process.exit(fail > 0 ? 1 : 0);
    });
