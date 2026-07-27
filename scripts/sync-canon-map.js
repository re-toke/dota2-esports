// scripts/sync-canon-map.js
// G4 — 消除云函数与小程序「双源漂移」：从唯一手工维护来源 utils/curation.js 的
// CURATED_EVENTS 生成「赛事名规范映射」curation-shared.json，并镜像到云函数目录，
// 保证两侧共用同一份精确归一映射。
//
// 归一规则与 consensus.normName 对齐（仅 ASCII 联赛名，等价于 [^a-z0-9]）：
//   小写 + 去除非字母数字，得到归一键；canonical 与所有 aliases 都写入同一 map。
//
// 用法：node scripts/sync-canon-map.js
// 退出码 0 = 成功且两侧一致；非 0 = 失败（CI 中据此拦截）。

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MINI_JSON = path.join(ROOT, 'utils', 'curation-shared.json');
const CLOUD_JSON = path.join(ROOT, 'cloudfunctions', 'aggregation', 'curation-shared.json');

// 复用 curation 的归一口径（与 consensus.normName 一致，ASCII 名等价）
function normKey(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function buildMap() {
  const curation = require(path.join(ROOT, 'utils', 'curation.js'));
  const events = curation.CURATED_EVENTS || [];
  const map = {};
  let count = 0;
  events.forEach((ev) => {
    if (!ev || !ev.canonical) return;
    const canonKey = normKey(ev.canonical);
    if (canonKey) { map[canonKey] = ev.canonical; count++; }
    (ev.aliases || []).forEach((a) => {
      const k = normKey(a);
      if (k) { map[k] = ev.canonical; count++; }
    });
  });
  return { map, count };
}

function serialize(map, count) {
  const payload = {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: 'utils/curation.js#CURATED_EVENTS',
    eventCount: count,
    map
  };
  return JSON.stringify(payload, null, 2) + '\n';
}

function main() {
  const { map, count } = buildMap();
  if (count === 0) {
    console.error('[sync-canon-map] 致命：生成的映射为空，请检查 utils/curation.js');
    process.exit(1);
  }
  const text = serialize(map, count);

  // 写入小程序侧
  fs.mkdirSync(path.dirname(MINI_JSON), { recursive: true });
  fs.writeFileSync(MINI_JSON, text, 'utf8');

  // 镜像到云函数侧（独立部署，无法共享小程序 utils）
  fs.mkdirSync(path.dirname(CLOUD_JSON), { recursive: true });
  fs.writeFileSync(CLOUD_JSON, text, 'utf8');

  // 断言两侧字节一致（这是 G4 的核心不变量）
  const a = fs.readFileSync(MINI_JSON, 'utf8');
  const b = fs.readFileSync(CLOUD_JSON, 'utf8');
  if (a !== b) {
    console.error('[sync-canon-map] 致命：两侧 JSON 不一致，镜像写入失败');
    process.exit(1);
  }

  // EPL 关键覆盖自检（P3 回归防护）
  const eplAliases = ['eplmasters2026', 'eplmasters', 'eplmasters1', 'epl2026', 'eplmastersi'];
  const missing = eplAliases.filter((k) => map[k] !== 'EPL Masters I');
  if (missing.length) {
    console.error('[sync-canon-map] 致命：EPL 规范映射缺失/漂移: ' + missing.join(', '));
    process.exit(1);
  }

  console.log('[sync-canon-map] OK · 事件覆盖 ' + count + ' 条 · 两侧 JSON 字节一致 · EPL 映射完整');
}

main();
