#!/usr/bin/env node
/**
 * scripts/test/run-all.js —— `npm run test:all` 的 runner
 *
 * 2026-10-30（Batch C · C6）：
 *   - 原实现是 47 段 `&&` 单链：第一条失败后后面的用例不再执行，信息也被截断；
 *   - 改为 runner：并行执行（默认并发 4，`--concurrency N` 可调）、全部跑完后汇总失败项；
 *   - 失败时打印每个失败用例的输出尾部，便于 CI 定位；
 *   - 任一条失败 → exit 1。
 *
 * 各用例均为独立 Node 脚本（不占端口、不写共享文件），可安全并行。
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

// 与 package.json 的 test:all 顺序保持一致；args 为可选命令行参数
const TESTS = [
  { file: 'scripts/test/test-sources.js' },
  { file: 'scripts/test/test-discover-mirror.js' },
  { file: 'scripts/test/test-consensus.js' },
  { file: 'scripts/test/test-canonical.js' },
  { file: 'scripts/test/test-bo.js' },
  { file: 'scripts/test/test-formatters.js' },
  { file: 'scripts/test/test-incremental.js' },
  { file: 'scripts/test/test-api-inflight.js' },
  { file: 'scripts/test/test-remote-curation.js' },
  { file: 'scripts/test/test-search-history.js' },
  { file: 'scripts/test/test-bo3-merge-split.js' },
  { file: 'scripts/test/test-haglund-circuit.js' },
  { file: 'scripts/test/test-image.js' },
  { file: 'scripts/test/test-home-series.js' },
  { file: 'scripts/test/test-diagnostics.js' },
  { file: 'scripts/test/test-follow-batch.js' },
  { file: 'scripts/test/test-lp-fetch-guard.js' },
  { file: 'scripts/test/test-series.js' },
  { file: 'scripts/test/test-merge-dedup.js' },
  { file: 'scripts/test/test-phase-inference.js' },
  { file: 'scripts/test/test-postponement-guard.js' },
  { file: 'scripts/test/test-bo3-incomplete.js' },
  { file: 'scripts/test/test-bo3-split-fix.js' },
  { file: 'scripts/test/test-v3-series-id.js' },
  { file: 'scripts/test/test-steam-live-phase.js' },
  { file: 'scripts/test/test-logo-persist.js' },
  { file: 'scripts/test/test-patch-null-diagnosis.js' },
  { file: 'scripts/test/test-iron-wing-buildseries.js' },
  { file: 'scripts/test/test-iron-wing-diagnosis.js' },
  { file: 'scripts/test/test-iron-wing-real-data.js' },
  { file: 'scripts/test/test-lp-structure.js' },
  { file: 'scripts/test/test-refresh-participants.js' },
  { file: 'scripts/test/test-epl-participants.js' },
  { file: 'scripts/test/test-liquipedia-team-logo.js' },
  { file: 'scripts/test/test-liquipedia-league-tier.js' },
  { file: 'scripts/test/test-index-card-helpers.js' },
  { file: 'scripts/test/test-sources-pure.js' },
  { file: 'scripts/test/test-series-normalize.js' },
  { file: 'scripts/test/test-bracket-layout.js' },
  { file: 'scripts/test/test-bracket-golden.js' },
  { file: 'scripts/test/test-league-detail-retry.js' },
  { file: 'scripts/test/test-observability.js' },
  { file: 'infra/proxy/test.mjs' },
  { file: 'scripts/ops/check-token-overreach.js' },
  { file: 'scripts/ops/check-card-contract.js' },
  { file: 'scripts/ops/check-edge-actions.js' },
  { file: 'scripts/ops/check-ef-contract.js' },
  { file: 'scripts/ops/audit-wxss-colors.js', args: ['--fail-on-p0'] }
];

const argv = process.argv.slice(2);
function argValue(name, fallback) {
  const i = argv.indexOf(name);
  if (i >= 0 && argv[i + 1]) return parseInt(argv[i + 1], 10) || fallback;
  return fallback;
}
const CONCURRENCY = Math.max(1, argValue('--concurrency', 4));
const TAIL_LINES = 25;

function runOne(test) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(ROOT, test.file)].concat(test.args || []), {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    child.stdout.on('data', (d) => { output += d.toString(); });
    child.stderr.on('data', (d) => { output += d.toString(); });
    child.on('error', (e) => {
      resolve({ test: test, ok: false, ms: Date.now() - started, output: output + '\n' + (e && e.message) });
    });
    child.on('close', (code) => {
      resolve({ test: test, ok: code === 0, ms: Date.now() - started, output: output, code: code });
    });
  });
}

function tail(text) {
  const lines = (text || '').replace(/\s+$/, '').split('\n');
  return lines.slice(-TAIL_LINES).join('\n');
}

function label(test) {
  const args = (test.args || []).length ? ' ' + test.args.join(' ') : '';
  return test.file + args;
}

async function main() {
  const started = Date.now();
  console.log('test:all · ' + TESTS.length + ' suites · concurrency ' + CONCURRENCY + '\n');

  const results = new Array(TESTS.length);
  let next = 0;
  async function worker() {
    while (next < TESTS.length) {
      const i = next++;
      const r = await runOne(TESTS[i]);
      results[i] = r;
      const secs = (r.ms / 1000).toFixed(1);
      console.log((r.ok ? '✓ ' : '✖ ') + label(r.test) + '  ' + secs + 's');
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, TESTS.length) }, worker));

  const failed = results.filter((r) => !r.ok);
  const totalSecs = (Date.now() - started) / 1000;

  if (failed.length) {
    console.log('\n=== 失败明细（每条尾部 ' + TAIL_LINES + ' 行） ===');
    failed.forEach((r) => {
      console.log('\n--- ' + label(r.test) + ' (exit ' + r.code + ', ' + (r.ms / 1000).toFixed(1) + 's) ---');
      console.log(tail(r.output));
    });
  }

  console.log('\n=== 汇总：PASS ' + (results.length - failed.length) + ' / FAIL ' + failed.length +
    ' · 总耗时 ' + totalSecs.toFixed(1) + 's ===');
  if (failed.length) {
    console.log('失败用例：\n' + failed.map((r) => ' - ' + label(r.test)).join('\n'));
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
