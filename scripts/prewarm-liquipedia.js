#!/usr/bin/env node
// 近一年联赛 Liquipedia 元数据预热启动器
// 把 liquipediaLeagueMeta 从"纯懒加载"升级为"懒加载 + 预热"双轨。
//
// 两种运行模式：
//  A) 有 CloudBase 密钥（环境变量 SECRET_ID + SECRET_KEY）：直接调用云端 liquipediaPrewarm，
//     逐条调用（每条一个 pageName）以规避云函数超时，本地负责 2s 限流并打印逐条进度。
//  B) 无密钥：打印一段可直接粘贴到「云开发控制台 → cloudfunctions/aggregation → 测试」的 JSON，
//     由你在控制台点测触发（每次建议 ≤30 条分批，可多次粘贴）。
//
// 用法：
//   node scripts/prewarm-liquipedia.js                                          # 自动枚举 OpenDota 知名联赛，打印 JSON（模式 B）
//   node scripts/prewarm-liquipedia.js --limit 40                              # 限制枚举数量
//   node scripts/prewarm-liquipedia.js --pageNames "The International 2025,ESL One Birmingham 2026"
//   node scripts/prewarm-liquipedia.js --force                                 # 强制刷新（忽略已有缓存）
//   SECRET_ID=xxx SECRET_KEY=yyy node scripts/prewarm-liquipedia.js            # 直接云端跑（模式 A）
//
// 注意：自动枚举用的是 OpenDota 联赛原始名作为 Liquipedia pageName（与客户端调用路径完全一致），
//       其中部分在 Liquipedia 无对应页 → 预热结果记为 skipped，属正常（不计入失败）。

const path = require('path');
const BASE = 'https://api.opendota.com/api';

// 与云端 KNOWN_KEYWORDS 保持一致（S 级 / 职业联赛关键词）
const KNOWN_KEYWORDS = /(international|major|esl\s+one|esl\s+pro|dreamleague|blast|riyadh|pgl|betboom|clavision|fissure|the\s+summit|games\s+of\s+the\s+future|heroic|resurrection|weplay|moonstorm|dpc|\btour\b|division\s+i)/i;
let ENV_ID = process.env.ENV_ID || 'cloud1-d2g0wufv8f2ce3871';

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { pageNames: null, limit: 60, force: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit') out.limit = Number(args[++i]) || out.limit;
    else if (args[i] === '--force') out.force = true;
    else if (args[i] === '--pageNames') out.pageNames = args[++i].split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    else if (args[i] === '--env') ENV_ID = args[++i];
  }
  return out;
}

async function enumerateLeagues(limit) {
  const res = await fetch(BASE + '/leagues');
  if (!res.ok) throw new Error('OpenDota /leagues HTTP ' + res.status);
  const leagues = await res.json();
  const seen = {};
  const names = [];
  (leagues || []).forEach(function (l) {
    const nm = (l && l.name) || '';
    if (!nm || seen[nm]) return;
    // 仅筛 notable 赛事（与云端 KNOWN_KEYWORDS / 客户端 preheatUpcoming 一致），
    // 不按 tier 放宽，避免社区/业余赛事浪费 Liquipedia 2s 限流配额。
    if (KNOWN_KEYWORDS.test(nm)) {
      seen[nm] = true;
      names.push(nm);
    }
  });
  return names.slice(0, limit);
}

async function main() {
  const opt = parseArgs();
  let pageNames = opt.pageNames;
  if (!pageNames) {
    process.stderr.write('[枚举] 从 OpenDota /leagues 自动获取知名/职业联赛...\n');
    pageNames = await enumerateLeagues(opt.limit);
  }
  process.stderr.write('[候选] ' + pageNames.length + ' 个联赛待预热\n');
  if (!pageNames.length) { process.stderr.write('[跳过] 无候选\n'); return; }

  const SECRET_ID = process.env.SECRET_ID;
  const SECRET_KEY = process.env.SECRET_KEY;

  if (SECRET_ID && SECRET_KEY) {
    // 模式 A：直接云端跑（逐条调用以规避云函数超时）
    let sdk;
    try {
      sdk = require(path.join(__dirname, '..', 'cloudfunctions', 'aggregation', 'node_modules', 'wx-server-sdk'));
    } catch (e) {
      process.stderr.write('[错误] 找不到 wx-server-sdk，请先在 cloudfunctions/aggregation 安装依赖（npm install）\n');
      process.exit(1);
    }
    sdk.init({ env: ENV_ID, secretId: SECRET_ID, secretKey: SECRET_KEY });
    const cloud = sdk;
    let totalOk = 0, totalSkip = 0; const failed = [];
    for (let i = 0; i < pageNames.length; i++) {
      const name = pageNames[i];
      try {
        const r = await cloud.callFunction({
          name: 'aggregation',
          data: { action: 'liquipediaPrewarm', params: { pageNames: [name], force: opt.force } }
        });
        const res = (r && r.result) || {};
        if (res.ok) totalOk++;
        else if (res.skipped) totalSkip++;
        else failed.push(name);
        const tag = res.ok ? 'OK' : (res.skipped ? 'skip' : 'fail');
        process.stderr.write('  [' + (i + 1) + '/' + pageNames.length + '] ' + name + ' -> ' + tag + '\n');
      } catch (e) {
        failed.push(name);
        process.stderr.write('  [' + (i + 1) + '/' + pageNames.length + '] ' + name + ' -> ERR ' + (e && e.message) + '\n');
      }
      if (i < pageNames.length - 1) await sleep(2000);
    }
    process.stdout.write(JSON.stringify({ total: pageNames.length, ok: totalOk, skipped: totalSkip, failed: failed }, null, 2) + '\n');
  } else {
    // 模式 B：打印粘贴 JSON（每次建议 ≤30 条分批）
    const chunkSize = 30;
    const chunks = [];
    for (let i = 0; i < pageNames.length; i += chunkSize) chunks.push(pageNames.slice(i, i + chunkSize));
    process.stderr.write('[提示] 未检测到 SECRET_ID/SECRET_KEY，已生成 ' + chunks.length + ' 段粘贴 JSON（每段 ≤30 条）。\n');
    process.stderr.write('       到「云开发控制台 → cloudfunctions/aggregation → 测试」逐段粘贴触发：\n');
    chunks.forEach(function (c, idx) {
      process.stdout.write('// --- 批次 ' + (idx + 1) + '/' + chunks.length + ' (' + c.length + ' 条) ---\n');
      process.stdout.write(JSON.stringify({ action: 'liquipediaPrewarm', params: { pageNames: c, force: opt.force } }) + '\n');
    });
  }
}

main().catch(function (e) { process.stderr.write('[致命] ' + (e && e.stack || e) + '\n'); process.exit(1); });
