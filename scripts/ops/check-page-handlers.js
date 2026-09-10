#!/usr/bin/env node
/**
 * scripts/ops/check-page-handlers.js
 *
 * 校验页面的 WXML 事件绑定在 JS 中都有对应方法定义。
 * 作用：防止「改了 wxml 但忘了加 handler」导致用户点击无反应（静默失败）。
 *
 * 用法：
 *   node scripts/ops/check-page-handlers.js pages/follow/follow
 *   node scripts/ops/check-page-handlers.js            # 扫描 pages/ 与 subpackages/ 下全部页面
 *
 * 退出码：0 = 全部有定义；1 = 存在缺失绑定
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

// WXML 里的事件绑定属性
const BIND_RE = /\b(?:bind|catch)(?::)?([a-z]+)\s*=\s*"([^"{}]+)"/g;

function collectPairs(mode) {
  const pairs = [];
  if (mode) {
    pairs.push({ wxml: path.join(ROOT, mode + '.wxml'), js: path.join(ROOT, mode + '.js') });
  } else {
    const dirs = ['pages', 'subpackages', 'components'];
    for (const d of dirs) {
      const base = path.join(ROOT, d);
      if (!fs.existsSync(base)) continue;
      const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) walk(p);
          else if (e.name.endsWith('.wxml')) {
            const js = p.replace(/\.wxml$/, '.js');
            pairs.push({ wxml: p, js, isComponent: p.includes(path.sep + 'components' + path.sep) });
          }
        }
      };
      walk(base);
    }
  }
  return pairs;
}

function main() {
  const mode = process.argv[2];
  const pairs = collectPairs(mode);
  let totalMissing = 0;
  let checked = 0;

  for (const { wxml, js } of pairs) {
    if (!fs.existsSync(wxml) || !fs.existsSync(js)) continue;
    checked++;
    const wxmlSrc = fs.readFileSync(wxml, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    const jsSrc = fs.readFileSync(js, 'utf8');

    const names = new Set();
    let m;
    BIND_RE.lastIndex = 0;
    while ((m = BIND_RE.exec(wxmlSrc)) !== null) {
      const name = m[2].trim();
      if (name) names.add(name);
    }

    const missing = [...names].filter((name) => {
      // 匹配 `name(` 或 `name:` （方法简写）
      const re = new RegExp('(^|[\\s,{])' + name.replace(/[$]/g, '\\$') + '\\s*[(:]', 'm');
      return !re.test(jsSrc);
    });

    if (missing.length) {
      totalMissing += missing.length;
      console.log('❌ ' + path.relative(ROOT, wxml).replace(/\\/g, '/'));
      missing.forEach((n) => console.log('     缺少 handler: ' + n));
    }
  }

  console.log('---');
  console.log('检查页面 ' + checked + ' 个');
  if (totalMissing === 0) {
    console.log('✅ 所有 WXML 事件绑定均有对应方法定义');
  } else {
    console.log('⚠️ ' + totalMissing + ' 个绑定缺少定义（用户点击将无反应）');
    process.exit(1);
  }
}

main();
