// scripts/test-image.js
// image.js 的 normalizeLogoUrl / toLogoUrl 单测（v8.5 Fix-G：logo URL 域名规范化）。
// 背景：详情页参赛队伍/即将开始对局队标加载失败，根因是 OpenDota 返回的 logo_url
//   落在微信 downloadFile 白名单外（cdn.steamusercontent.com UGC）或死域/http。
//   normalizeLogoUrl 统一收敛：http→https、steamcdn-a→cloudflare 镜像、死域剔除。
// 纯函数不联网，可随时跑：node scripts/test-image.js

'use strict';

let passed = 0;
let failed = 0;
const tests = [];
function section(title) { tests.push({ kind: 'section', title: title }); }
function check(label, fn) { tests.push({ kind: 'test', label: label, fn: fn }); }
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

const image = require('../../utils/image.js');
const { normalizeLogoUrl, toLogoUrl } = image;

section('\n--- Fix-G normalizeLogoUrl 域名规范化 ---');

check('steamcdn-a.akamaihd.net team_logos → cdn.cloudflare.steamstatic.com（已白名单镜像）', () => {
  const out = normalizeLogoUrl('https://steamcdn-a.akamaihd.net/apps/dota2/images/team_logos/55.png');
  assert(out === 'https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/55.png',
    '应收敛到 cloudflare 镜像，实际: ' + out);
});

check('steamusercontent-a.akamaihd.net（实测 100% 404 死域）→ 空串剔除', () => {
  const out = normalizeLogoUrl('https://steamusercontent-a.akamaihd.net/ugc/28466819170196410/708BB6A5590552457B6C8496BD7A28D775E9866E/');
  assert(out === '', '死域应剔除返回空，实际: ' + out);
});

check('cloud-3.steamusercontent.com（http 协议 + 死域）→ 空串剔除', () => {
  const out = normalizeLogoUrl('http://cloud-3.steamusercontent.com/ugc/860606208065606394/85EFA7A0173DA2C1095BB473335F8BED3EB6E4EF/');
  assert(out === '', 'http 死域应剔除，实际: ' + out);
});

check('cdn.steamusercontent.com（UGC 主力，URL 有效）→ 原样保留（微信白名单待补）', () => {
  const u = 'https://cdn.steamusercontent.com/ugc/14844266645370842778/47230D9640A722EAF06548C2EEB813ED4296AE3F/';
  assert(normalizeLogoUrl(u) === u, 'UGC 有效 URL 应原样保留');
});

check('http:// 升级为 https://（微信 image 强制 https）', () => {
  const out = normalizeLogoUrl('http://cdn.steamusercontent.com/ugc/706274505311787193/24FA17D5019799AF118AEB4469DDB76D69A66F63/');
  assert(out.indexOf('https://') === 0, '应升级 https，实际: ' + out);
});

check('空串/非法输入 → 空串', () => {
  assert(normalizeLogoUrl('') === '', '空串应返回空');
  assert(normalizeLogoUrl(null) === '', 'null 应返回空');
  assert(normalizeLogoUrl('not-a-url') === '', '非 URL 应返回空');
});

section('\n--- Fix-G toLogoUrl 组合（规范化 + OpenDota 尺寸缩放）---');

check('OpenDota CDN 追加尺寸参数（toLogoUrl 保留既有行为）', () => {
  const out = toLogoUrl('https://cdn.opendota.com/apps/dota2/images/team_logos/55.png');
  assert(out === 'https://cdn.opendota.com/apps/dota2/images/team_logos/55.png?w=128&h=128',
    'OpenDota CDN 应追加 w/h，实际: ' + out);
});

check('steamcdn-a 经 toLogoUrl → cloudflare 镜像（不追加尺寸，Steam CDN 不支持 query）', () => {
  const out = toLogoUrl('https://steamcdn-a.akamaihd.net/apps/dota2/images/team_logos/36.png');
  assert(out === 'https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/36.png',
    '应只做域名收敛不追加 query，实际: ' + out);
});

check('死域经 toLogoUrl → 空串（视图回退首字母占位，不再尝试必然失败 URL）', () => {
  assert(toLogoUrl('https://steamusercontent-a.akamaihd.net/ugc/x/y/') === '', '死域应返回空');
});

// ===== 2026-09-21 队标本地化 utils/logoLocal.js =====
// 背景：实测快照 89% 的队标来自 cdn.steamusercontent.com（UGC），响应头为
//   **application/octet-stream**（字节是合法 PNG），而社区多篇记录小程序 <image> 遇
//   「非图片 MIME 的二进制流」会真机/首次加载偶发不显示；本项目此前 **0 处 wx.downloadFile**
//   （logoCache 只是 id→URL 映射缓存）→ 没有任何绕过 MIME 的机制。
// 本组锁住契约：**只在失败后下载 / 同 URL 并发去重 / 任何失败一律降级为空串**（不影响原渲染路径）。
section('\n--- 队标本地化 logoLocal（2026-09-21）---');

const LOGO_UGC = 'https://cdn.steamusercontent.com/ugc/706274505311787193/24FA17D5019799AF118AEB4469DDB76D69A66F63/';
// wx 桩：可控 downloadFile + 内存文件系统
let dlCalls = [];
let dlBehavior = 'ok';            // ok | http404 | fail
let saveThrows = false;
let fsFiles = {};                 // 完整路径 → { mtime }
let savedCalls = [];
let unlinkCalls = [];
global.wx = {
  env: { USER_DATA_PATH: '/USER_DATA' },
  downloadFile(opts) {
    dlCalls.push(opts.url);
    setTimeout(function () {
      if (dlBehavior === 'ok') opts.success({ statusCode: 200, tempFilePath: '/tmp/dl.png' });
      else if (dlBehavior === 'http404') opts.success({ statusCode: 404, tempFilePath: '' });
      else opts.fail({ errMsg: 'downloadFile:fail mock' });
    }, 0);
  },
  getFileSystemManager() {
    return {
      accessSync(p) { if (!fsFiles[p]) { const e = new Error('access:fail no such file'); throw e; } },
      mkdirSync() { /* 视为成功 */ },
      saveFileSync(tmp, dest) {
        if (saveThrows) throw new Error('saveFileSync:fail mock');
        savedCalls.push(dest);
        fsFiles[dest] = { mtime: Date.now() };
      },
      unlinkSync(p) { unlinkCalls.push(p); delete fsFiles[p]; },
      readdirSync() { return Object.keys(fsFiles).map(function (p) { return p.split('/').pop(); }); },
      statSync(p) { if (!fsFiles[p]) throw new Error('stat:fail'); return { mtime: fsFiles[p].mtime }; }
    };
  }
};
function resetStub() {
  dlCalls = []; dlBehavior = 'ok'; saveThrows = false;
  fsFiles = {}; savedCalls = []; unlinkCalls = [];
}
const logoLocal = require('../../utils/logoLocal.js');

check('logoLocal：非 http(s) / 空 / 非字符串 → 一律返回空（不发起下载）', async () => {
  resetStub();
  for (const bad of ['', null, undefined, 123, {}, 'ftp://x/y.png', 'wxfile://local.png']) {
    assert(logoLocal.cachedPath(bad) === '', 'cachedPath 应返回空: ' + JSON.stringify(bad));
    assert((await logoLocal.fetchToLocal(bad)) === '', 'fetchToLocal 应返回空: ' + JSON.stringify(bad));
  }
  assert(dlCalls.length === 0, '不应发起任何 downloadFile，实际 ' + dlCalls.length + ' 次');
});

check('logoLocal：★ downloadFile 成功 → 落地持久化并返回本地路径', async () => {
  resetStub();
  const p = await logoLocal.fetchToLocal(LOGO_UGC);
  assert(p && p.indexOf('/USER_DATA/team-logos/') === 0, '应返回 USER_DATA 下的持久化路径，实际: ' + p);
  assert(savedCalls.length === 1 && savedCalls[0] === p, 'saveFileSync 应被调用且目标一致');
  assert(dlCalls.length === 1, '应下载 1 次');
});

check('logoLocal：★ 已持久化 → cachedPath 同步命中（首帧直出，零网络）', () => {
  assert(logoLocal.cachedPath(LOGO_UGC) !== '', '已落盘后 cachedPath 应命中');
  assert(logoLocal.cachedPath(LOGO_UGC) === savedCalls[0], 'cachedPath 应与落盘路径一致');
});

check('logoLocal：★ 同 URL 并发只下载一次（首页同一支队出现在多张卡片）', async () => {
  resetStub();
  const r = await Promise.all([
    logoLocal.fetchToLocal(LOGO_UGC), logoLocal.fetchToLocal(LOGO_UGC), logoLocal.fetchToLocal(LOGO_UGC)
  ]);
  assert(dlCalls.length === 1, '并发应去重为 1 次下载，实际 ' + dlCalls.length + ' 次');
  assert(r[0] === r[1] && r[1] === r[2] && r[0] !== '', '三个调用应得到同一非空路径');
});

check('logoLocal：去重表在完成后释放（后续仍可重新下载）', async () => {
  const before = dlCalls.length;
  await logoLocal.fetchToLocal(LOGO_UGC);
  assert(dlCalls.length === before + 1, '已完成的任务不应永久占用 inflight，实际新增 ' + (dlCalls.length - before));
});

check('logoLocal：★ 404 / 网络失败 → 返回空串（调用方退回原行为，不抛错）', async () => {
  resetStub(); dlBehavior = 'http404';
  assert((await logoLocal.fetchToLocal(LOGO_UGC)) === '', '404 应返回空串');
  assert(savedCalls.length === 0, '404 不应落盘');
  resetStub(); dlBehavior = 'fail';
  assert((await logoLocal.fetchToLocal(LOGO_UGC)) === '', 'fail 应返回空串');
  assert(savedCalls.length === 0, 'fail 不应落盘');
});

check('logoLocal：★ 落盘失败 → 退回临时文件路径（当次会话仍可渲染，不抛错）', async () => {
  resetStub(); saveThrows = true;
  const p = await logoLocal.fetchToLocal(LOGO_UGC);
  assert(p === '/tmp/dl.png', '落盘失败应退回 tempFilePath，实际: ' + p);
});

check('logoLocal：容量裁剪 —— 超上限时删除最旧的（静默）', async () => {
  resetStub();
  // 预填 MAX+3 = 203 张；本次落盘再 +1 → 204 → 应删 204-200 = 4 张（最旧的）
  for (let i = 0; i < logoLocal._MAX_FILES + 3; i++) {
    fsFiles['/USER_DATA/team-logos/old' + i + '.png'] = { mtime: 1000 + i };
  }
  const p = await logoLocal.fetchToLocal(LOGO_UGC);
  assert(p !== '', '应正常落盘');
  assert(unlinkCalls.length === 4, '应删除 4 个最旧文件（204-200），实际 ' + unlinkCalls.length);
  // 按 mtime 升序：old0(1000) < old1 < ... < old202 < 本次新增(now) → 删除最旧 4 个 = old0..old3
  assert(unlinkCalls.indexOf('/USER_DATA/team-logos/old0.png') >= 0, '最旧的 old0 应被删除');
  assert(unlinkCalls.indexOf('/USER_DATA/team-logos/old3.png') >= 0, 'old3 是第 4 旧，也应被删除');
  assert(unlinkCalls.indexOf('/USER_DATA/team-logos/old4.png') < 0, 'old4 应保留（只删最旧 4 个）');
});

check('logoLocal：hash 稳定（同 URL 同名、不同 URL 不同名）', () => {
  assert(logoLocal._hash32(LOGO_UGC) === logoLocal._hash32(LOGO_UGC), '同 URL 必须同 hash（否则永远重复下载）');
  assert(logoLocal._hash32('https://a/x.png') !== logoLocal._hash32('https://a/y.png'), '不同 URL 应不同 hash');
});

// ===== 运行器 =====
(async function runAll() {
  for (const t of tests) {
    if (t.kind === 'section') { console.log(t.title); continue; }
    try {
      await t.fn();
      passed++;
      console.log('PASS  ' + t.label);
    } catch (e) {
      failed++;
      console.log('FAIL  ' + t.label + ' — ' + (e && e.message));
    }
  }
  console.log('\n=== 结果 ===');
  console.log('通过: ' + passed + '  失败: ' + failed);
  process.exit(failed === 0 ? 0 : 1);
})();
