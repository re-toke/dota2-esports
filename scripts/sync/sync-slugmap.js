#!/usr/bin/env node
/**
 * Liquipedia slug 映射表同步脚本（防漂移闸门）
 * 把 utils/liquipedia-slugmap.json 镜像到 cloudfunctions/aggregation/liquipedia-slugmap.json，
 * 云端 liquipediaLeagueMeta / liquipediaPrewarm 运行时 require 该镜像。
 * 校验：源必须含 mappings 对象；镜像写入后逐条比对一致性，不一致即非零退出。
 *
 * 用法：npm run sync:slugmap
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', 'utils', 'liquipedia-slugmap.json');
// ★★ 2026-09-22（微信云开发退役）：原镜像目标为 cloudfunctions/aggregation/liquipedia-slugmap.json，
//   该目录已删除。保留 JSON 往返校验（写→读→比对），但改写到**系统临时目录**，不再触碰仓库。
const DST = path.join(require('os').tmpdir(), 'dota2-esports-liquipedia-slugmap.check.json');
// ★★ 2026-10-30（真机 Console 实证）：**小程序 require 不支持 .json** ——
//   `require('./liquipedia-slugmap.json')` 会被解析成 `liquipedia-slugmap.json.js` 并抛
//   `module '...json.js' is not defined`（微信开放社区官方答复同此），
//   而 liquipedia.js 的 catch 会静默回退 `{ mappings: {} }` ⇒ **映射表在真机上从未生效**
//   （本次 Console 9 条未命中里包含刚加的 3 条、10 条命中全部来自 curation 就是证据）。
//   解决：由本脚本从 JSON 源**生成一份 JS 镜像**（小程序可 require），
//   并在同一次运行内做「条数 + 全量键值」一致性校验，两处永不漂移。
const JS_MIRROR = path.join(__dirname, '..', '..', 'utils', 'liquipedia-slugmap.js');

function fail(msg) { console.error('❌ ' + msg); process.exit(1); }

if (!fs.existsSync(SRC)) {
  fail('源映射表不存在: ' + SRC + '\n  先跑: node scripts/generate-liquipedia-slugmap.js --all');
}

let src;
try { src = JSON.parse(fs.readFileSync(SRC, 'utf8')); }
catch (e) { fail('源映射表 JSON 解析失败: ' + e.message); }

if (!src || typeof src.mappings !== 'object' || src.mappings === null) {
  fail('源映射表缺少 mappings 对象');
}

fs.writeFileSync(DST, JSON.stringify(src, null, 2), 'utf8');

let dst;
try { dst = JSON.parse(fs.readFileSync(DST, 'utf8')); }
catch (e) { fail('云端镜像写入后无法解析: ' + e.message); }

const sk = Object.keys(src.mappings);
const dk = Object.keys(dst.mappings);
if (sk.length !== dk.length) {
  fail(`映射条数不一致: 源 ${sk.length} vs 镜像 ${dk.length}`);
}
for (const k of sk) {
  if (dst.mappings[k] !== src.mappings[k]) {
    fail(`映射不一致 key=${k}: 源=${src.mappings[k]} 镜像=${dst.mappings[k]}`);
  }
}

// ===== 生成客户端 JS 镜像（小程序 require 只能加载 .js；见上方 2026-10-30 说明）=====
const jsHead = '// 自动生成，请勿手改。源：utils/liquipedia-slugmap.json（修改后执行 npm run sync:slugmap 重新生成）\n' +
  '// 为什么要有这份拷贝：微信小程序 require 不支持 .json（会被解析成 *.json.js 并报 module is not defined），\n' +
  '// 只 require JSON 会让映射表在真机上静默失效（2026-10-30 真机 Console 定位）。\n';
const jsBody = 'module.exports = ' + JSON.stringify(src, null, 2) + ';\n';
fs.writeFileSync(JS_MIRROR, jsHead + jsBody, 'utf8');

// 校验镜像：读回后逐键比对（防止生成端写错/残留旧内容）
delete require.cache[require.resolve(JS_MIRROR)];
const mirrored = require(JS_MIRROR);
if (!mirrored || typeof mirrored.mappings !== 'object' || mirrored.mappings === null) {
  fail('JS 镜像缺少 mappings 对象: ' + JS_MIRROR);
}
const jk = Object.keys(mirrored.mappings);
if (jk.length !== sk.length) {
  fail(`JS 镜像条数不一致: JSON ${sk.length} vs JS ${jk.length}`);
}
for (const k of sk) {
  if (mirrored.mappings[k] !== src.mappings[k]) {
    fail(`JS 镜像映射不一致 key=${k}: JSON=${src.mappings[k]} JS=${mirrored.mappings[k]}`);
  }
}

console.log('✅ slugmap 防漂移校验通过（JSON 往返，写到临时目录）: ' + sk.length + ' 条映射（防漂移校验通过）');
console.log('✅ 已生成客户端 JS 镜像: utils/liquipedia-slugmap.js（' + jk.length + ' 条映射，小程序可 require）');
process.exit(0);
