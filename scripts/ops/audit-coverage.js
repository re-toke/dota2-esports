#!/usr/bin/env node
/**
 * §9 赛事覆盖率审计脚本（2026-07-30）
 *
 * 脚本用途：
 *   扫描 monitor.leagueNameUncovered 上报的未覆盖赛事名，
 *   输出清单供人工补全 curation（utils/curation.js 的 CURATED_EVENTS）。
 *
 *   monitor.js 在小程序运行时把「展示名未被 curation 覆盖」的原始赛事名通过
 *   wx.reportAnalytics('league_name_uncovered', { name }) 上报到微信后台，
 *   每个名字同会话最多上报一次（_seen Set 去重）。由于 _seen 存在于运行时内存，
 *   脚本无法直接读取，需从微信小程序后台「自定义分析」导出事件数据，
 *   手动整理为输入文件后由本脚本审计。
 *
 *   审计流程：
 *     1. 读取 scripts/input/uncovered-events.json（人工维护的未覆盖赛事名清单）
 *     2. 若文件不存在，提示用户如何从微信小程序后台导出 leagueNameUncovered 事件数据
 *     3. 对每个未覆盖赛事名，用 communityTierFromName 预判等级
 *     4. 用 eventFingerprint 生成指纹（用于与 curation 比对）
 *     5. 与 curation CURATED_EVENTS 比对（curatedEventFor 含宽松匹配），确认确实未覆盖
 *     6. 输出按等级排序的清单到 scripts/output/audit-coverage.md（markdown 格式）
 *
 * 运行方式：
 *   node scripts/audit-coverage.js
 *
 * 输入文件：scripts/input/uncovered-events.json
 *   支持以下格式（任选其一）：
 *     1) ["ESL One Something 2026", "Random Cup"]               // 字符串数组
 *     2) { "events": ["ESL One Something 2026", ...] }          // 含 events 字段
 *     3) { "events": [{ "name": "ESL One Something 2026" }] }   // 对象数组
 *     4) [{ "name": "ESL One Something 2026" }, ...]             // 顶层对象数组
 *   若文件不存在，脚本输出提示信息并正常退出（退出码 0，不报错）。
 *
 * 输出文件：scripts/output/audit-coverage.md
 *   按 SSS / S / A / B / C 等级分组的 markdown 表格，便于人工审核。
 *
 * 依赖：仅 require utils/curation.js、utils/tiers.js、utils/consensus.js（用 try/catch）
 *       不依赖 wx，可在普通 Node 环境运行。
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..');
const INPUT_PATH = path.join(__dirname, 'input', 'uncovered-events.json');
const OUTPUT_DIR = path.join(__dirname, 'output');
const OUTPUT_PATH = path.join(OUTPUT_DIR, 'audit-coverage.md');

// 加载 utils（try/catch，避免任一模块加载失败时整脚本崩溃）
function loadUtils() {
  const out = { curation: null, tiers: null, consensus: null, errors: [] };
  try { out.curation = require(path.join(ROOT, 'utils', 'curation.js')); }
  catch (e) { out.errors.push('curation.js: ' + (e && e.message ? e.message : String(e))); }
  try { out.tiers = require(path.join(ROOT, 'utils', 'tiers.js')); }
  catch (e) { out.errors.push('tiers.js: ' + (e && e.message ? e.message : String(e))); }
  try { out.consensus = require(path.join(ROOT, 'utils', 'consensus.js')); }
  catch (e) { out.errors.push('consensus.js: ' + (e && e.message ? e.message : String(e))); }
  return out;
}

// 复用 curation 的归一口径（与 sync-canon-map.js / curation-coverage.js 一致）
// §8.3 多语言支持（2026-07-29）：与 consensus.normName 同步，保留西里尔字母
function normKey(s, consensus) {
  if (consensus && typeof consensus.normName === 'function') {
    return consensus.normName(s);
  }
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9一-鿿а-яё]/g, '');
}

// 从赛事名中提取年份（兜底实现，与 consensus.extractYear 一致）
function extractYear(s, consensus) {
  if (consensus && typeof consensus.extractYear === 'function') {
    return consensus.extractYear(s);
  }
  if (!s) return '';
  const m = String(s).match(/(20\d{2})/);
  return m ? m[1] : '';
}

// 解析输入文件，返回去空白的字符串数组
function parseInput(raw) {
  let list = [];
  if (Array.isArray(raw)) {
    list = raw;
  } else if (raw && Array.isArray(raw.events)) {
    list = raw.events;
  } else if (raw && typeof raw === 'object') {
    // 兜底：取首个数组字段
    const keys = Object.keys(raw);
    for (let i = 0; i < keys.length; i++) {
      if (Array.isArray(raw[keys[i]])) { list = raw[keys[i]]; break; }
    }
  }
  return list.map((item) => {
    if (typeof item === 'string') return item.trim();
    if (item && typeof item === 'object' && typeof item.name === 'string') return item.name.trim();
    return '';
  }).filter(Boolean);
}

// 生成 markdown 表格行
function row(cols) {
  return '| ' + cols.join(' | ') + ' |';
}

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

function nowStamp() {
  const d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
    + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}

// 按等级分组的展示顺序（与 COMMUNITY_TIERS / DISPLAY_TIERS 对齐）
const TIER_ORDER = ['SSS', 'S', 'A', 'B', 'C'];

function main() {
  // 1. 加载 utils
  const { curation, tiers, consensus, errors } = loadUtils();
  if (errors.length > 0) {
    console.error('[audit-coverage] 加载 utils 失败：');
    errors.forEach((e) => console.error('  - ' + e));
    console.error('  请在项目根目录运行：node scripts/audit-coverage.js');
    process.exit(0); // 不报错退出
  }

  // 2. 读取输入文件；不存在则提示用户如何导出，正常退出
  if (!fs.existsSync(INPUT_PATH)) {
    console.log('[audit-coverage] 未找到输入文件：' + INPUT_PATH);
    console.log('');
    console.log('请按以下步骤从微信小程序后台导出 leagueNameUncovered 事件数据：');
    console.log('  1. 登录微信公众平台 (mp.weixin.qq.com) → 进入对应小程序');
    console.log('  2. 左侧菜单「分析」→「自定义分析」→「事件管理」');
    console.log('  3. 找到事件 league_name_uncovered（小程序内 wx.reportAnalytics 上报，');
    console.log('     事件名经 monitor.js report() 转写为 league_name_uncovered）');
    console.log('  4. 选择时间范围（建议近 30 天）→ 导出数据');
    console.log('  5. 提取其中 name 字段，整理为 JSON 数组');
    console.log('  6. 保存到：' + INPUT_PATH);
    console.log('');
    console.log('输入文件支持以下格式（任选其一）：');
    console.log('  ["ESL One Something 2026", "Random Cup"]');
    console.log('  { "events": ["ESL One Something 2026", ...] }');
    console.log('  { "events": [{ "name": "ESL One Something 2026" }] }');
    console.log('  [{ "name": "ESL One Something 2026" }, ...]');
    console.log('');
    console.log('创建 input 目录与文件示例（PowerShell）：');
    console.log('  New-Item -ItemType Directory -Force -Path scripts\\input');
    console.log('  \'["ESL One Something 2026"]\' | Out-File -Encoding utf8 scripts\\input\\uncovered-events.json');
    process.exit(0); // 退出码 0，不报错
  }

  // 3. 解析输入
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(INPUT_PATH, 'utf8'));
  } catch (e) {
    console.error('[audit-coverage] 输入文件 JSON 解析失败：' + (e.message || e));
    process.exit(0);
  }

  const names = parseInput(raw);
  if (names.length === 0) {
    console.log('[audit-coverage] 输入文件为空，无可审计的未覆盖赛事名。');
    process.exit(0);
  }

  // 去重（与 monitor.js 的 _seen Set 去重口径一致）
  const uniq = Array.from(new Set(names.map((n) => n.trim()).filter(Boolean)));

  // 4. 对每个赛事名：预判等级 + 生成指纹 + 比对 curation
  const groups = {}; // grade -> [{ name, grade, label, rank, year, fingerprint, suggestion }]
  let coveredCount = 0;
  let uncoveredCount = 0;

  uniq.forEach((name) => {
    // 与 curation 比对：curatedEventFor 含宽松子串匹配（与小程序运行时同口径）
    const ev = curation.curatedEventFor ? curation.curatedEventFor(name) : null;
    if (ev) {
      coveredCount++;
      return; // 已覆盖，不输出
    }
    uncoveredCount++;

    // 预判等级（communityTierFromName）
    let tier = null;
    if (tiers && typeof tiers.communityTierFromName === 'function') {
      tier = tiers.communityTierFromName(name);
    }
    const grade = (tier && tier.grade) || 'C';
    const rank = (tier && tier.rank != null) ? tier.rank : 0;
    const label = (tier && tier.label) || '社区赛';

    // 年份（从名字提取）
    const year = extractYear(name, consensus);

    // 生成指纹（eventFingerprint，用于跨源关联与 curation 去重比对）
    let fingerprint = '';
    if (consensus && typeof consensus.eventFingerprint === 'function') {
      fingerprint = consensus.eventFingerprint({
        canonical: name,
        year: year
      });
    }

    // 建议：C 级跳过，其余建议补全 curation
    const suggestion = grade === 'C' ? 'skip' : 'add_to_curation';

    if (!groups[grade]) groups[grade] = [];
    groups[grade].push({
      name: name,
      grade: grade,
      label: label,
      rank: rank,
      year: year,
      fingerprint: fingerprint,
      suggestion: suggestion
    });
  });

  // 5. 按 rank 降序排序各组（rank 高的优先展示）
  TIER_ORDER.forEach((g) => {
    if (groups[g]) {
      groups[g].sort((a, b) => b.rank - a.rank);
    }
  });

  // 6. 生成 markdown
  const lines = [];
  lines.push('# 赛事覆盖率审计报告');
  lines.push('> 生成时间：' + nowStamp());
  lines.push('> 输入：scripts/input/uncovered-events.json');
  lines.push('> 已覆盖：' + coveredCount + ' 个，未覆盖：' + uncoveredCount + ' 个');
  lines.push('');

  if (uncoveredCount === 0) {
    lines.push('所有上报的赛事名均已被 curation 覆盖，无需补全。');
  } else {
    lines.push('## 需补全 curation 的赛事（按等级排序）');
    lines.push('');

    TIER_ORDER.forEach((g) => {
      const items = groups[g];
      if (!items || items.length === 0) return;

      if (g === 'C') {
        lines.push('### ' + g + ' 级（不收录）');
        lines.push('| 赛事名 | 预判等级 | 建议 |');
        lines.push('|---|---|---|');
        items.forEach((it) => {
          lines.push(row([it.name, it.grade, it.suggestion]));
        });
        lines.push('');
      } else {
        const heading = g + ' 级';
        lines.push('### ' + heading);
        lines.push('| 赛事名 | 预判等级 | 年份 | 指纹 | 建议 |');
        lines.push('|---|---|---|---|---|');
        items.forEach((it) => {
          lines.push(row([
            it.name,
            it.grade,
            it.year || '-',
            it.fingerprint || '-',
            it.suggestion
          ]));
        });
        lines.push('');
      }
    });

    // 审计说明
    lines.push('## 审计说明');
    lines.push('');
    lines.push('- 预判等级：由 utils/tiers.js 的 communityTierFromName(name) 根据赛事名正则推断；');
    lines.push('  未命中规则的赛事默认归为 C 级（社区赛，不收录）。');
    lines.push('- 指纹：由 utils/consensus.js 的 eventFingerprint 生成（`nameKey|year|organizer|weekBucket`），');
    lines.push('  用于跨源关联与 curation 去重；新增条目时建议保留与 curation 一致的字段。');
    lines.push('- 比对：curation CURATED_EVENTS 经 curatedEventFor(name) 匹配（含宽松子串匹配，');
    lines.push('  与小程序运行时同口径）。已覆盖的赛事不在此清单内。');
    lines.push('- 补全建议：');
    lines.push('  - SSS / S / A / B 级 → add_to_curation：在 utils/curation.js 的 CURATED_EVENTS');
    lines.push('    中补条目，字段参考：canonical / tier{grade,rank,label} / aliases / year');
    lines.push('  - C 级 → skip：社区赛/公开预选，不收录。');
  }

  // 7. 写入输出文件（output 目录不存在则创建）
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  fs.writeFileSync(OUTPUT_PATH, lines.join('\n'), 'utf8');

  console.log('[audit-coverage] 审计完成');
  console.log('  输入：' + INPUT_PATH);
  console.log('  输出：' + OUTPUT_PATH);
  console.log('  上报名总数：' + (coveredCount + uncoveredCount) + '（去重后）');
  console.log('  已覆盖：' + coveredCount);
  console.log('  未覆盖：' + uncoveredCount);
}

main();
