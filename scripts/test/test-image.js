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
