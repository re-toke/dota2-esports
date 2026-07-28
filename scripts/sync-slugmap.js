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

const SRC = path.join(__dirname, '..', 'utils', 'liquipedia-slugmap.json');
const DST = path.join(__dirname, '..', 'cloudfunctions', 'aggregation', 'liquipedia-slugmap.json');

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

console.log('✅ slugmap 已镜像到云端: ' + sk.length + ' 条映射（防漂移校验通过）');
process.exit(0);
