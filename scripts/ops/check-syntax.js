// scripts/check-syntax.js
// G7 — 全量语法校验：对关键目录下的所有 .js 跑 `node --check`，任一解析失败即非零退出。
// 用于 CI（与 lint/test 并列）拦截「能 require 但解析失败」「合并冲突残留」等低级错误。

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
// ★ 2026-09-22：cloudfunctions 已随微信云开发退役移除
const DIRS = ['utils', 'pages', 'subpackages', 'scripts'];
const SKIP = new Set(['node_modules', 'miniprogram_npm', '.git']);

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) { return; }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile() && e.name.endsWith('.js')) out.push(full);
  }
}

function main() {
  const files = [];
  DIRS.forEach((d) => walk(path.join(ROOT, d), files));
  let failed = 0;
  for (const f of files) {
    try {
      execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    } catch (e) {
      failed++;
      console.log('SYNTAX FAIL  ' + path.relative(ROOT, f));
      const msg = (e.stderr && e.stderr.toString()) || (e.stdout && e.stdout.toString()) || e.message;
      console.log('   ' + msg.trim().split('\n').slice(0, 3).join('\n   '));
    }
  }
  console.log('\n=== 语法校验 ===');
  console.log('检查文件: ' + files.length + '  失败: ' + failed);
  console.log(failed === 0 ? '语法全部通过 ✅' : '存在语法错误 ❌');
  process.exit(failed === 0 ? 0 : 1);
}

main();
