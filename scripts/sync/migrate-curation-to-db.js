#!/usr/bin/env node
/**
 * 阶段1-①：curation 数据迁移脚本（本地 → 云数据库）
 *
 * 用途：把 utils/curation.js 的 CURATED_EVENTS / CURATED_TEAMS / TI_CONTESTANT_TEAM_IDS
 *       迁移到微信云开发数据库的 curation_events / curation_teams / curation_meta collection，
 *       作为方案B（云端动态 curation）的数据基础。
 *
 * 运行方式：
 *   1. 本地预览（不写入云数据库）：node scripts/migrate-curation-to-db.js --dry-run
 *   2. 实际写入云数据库：node scripts/migrate-curation-to-db.js
 *
 * 前置条件：
 *   - 已开通微信云开发环境（config.cloudProxy.envId）
 *   - 本机已安装 wx-server-sdk（云函数本地调试时会自动安装）
 *   - 或通过云函数本地调试环境运行（依赖 wx-server-sdk）
 *
 * 数据结构：
 *   curation_events collection:
 *     - _id: 规范名归一化（consensus.normName(canonical)）
 *     - canonical, aliases, tier, year, start, end, liquipediaSlug, ...
 *     - updatedAt: 最后更新时间戳
 *   curation_teams collection:
 *     - _id: team_id（字符串形式）
 *     - name, tag, country, tier, aliases
 *     - updatedAt: 最后更新时间戳
 *   curation_meta collection:
 *     - _id: 'ti_contestant_ids'
 *     - ids: [team_id 数组]
 *     - updatedAt
 *     - 另含 version 字段（用于客户端增量更新）
 */

const path = require('path');

// 加载本地 curation 数据（数据源）
const curation = require(path.join(__dirname, '..', '..', 'utils', 'curation.js'));
const consensus = require(path.join(__dirname, '..', '..', 'utils', 'consensus.js'));

// 命令行参数
//   --dry-run  : 预览数据（不写入、不导出）
//   --export   : 导出 JSONL 文件到 scripts/export/（供微信开发者工具控制台手动导入）
//   无参数      : 直接写入云数据库（需要 wx-server-sdk + 云函数环境凭证，本地通常不可用）
const isDryRun = process.argv.includes('--dry-run');
const isExport = process.argv.includes('--export');
const modeLabel = isDryRun ? '🔍 预览（dry-run）' : (isExport ? '📦 导出 JSONL' : '写入云数据库（需云函数环境）');

async function main() {
  console.log('========== curation 数据迁移 ==========');
  console.log('模式:', modeLabel);
  console.log('');

  // 准备 events 数据
  const events = curation.CURATED_EVENTS || [];
  const eventsDocs = events.map((e) => {
    const id = consensus.normName(e.canonical || '');
    return Object.assign({}, e, {
      _id: id,
      aliases: e.aliases || [],
      tier: e.tier || null,
      updatedAt: Date.now()
    });
  });

  // 准备 teams 数据
  const teams = curation.CURATED_TEAMS || {};
  const teamsDocs = Object.keys(teams).map((tid) => {
    const t = teams[tid];
    return Object.assign({}, t, {
      _id: String(tid),  // 云数据库 _id 必须是字符串
      tier: t.tier || null,
      aliases: t.aliases || [],
      updatedAt: Date.now()
    });
  });

  // 准备 meta 数据（TI 参赛队 ID 集合 + version）
  const tiIds = curation.TI_CONTESTANT_TEAM_IDS || [];
  const metaDoc = {
    _id: 'ti_contestant_ids',
    ids: tiIds,
    count: tiIds.length,
    updatedAt: Date.now(),
    version: computeVersion(events, teams, tiIds)  // 数据指纹，用于客户端增量更新判断
  };

  // 输出统计
  console.log('数据统计:');
  console.log('  CURATED_EVENTS:', events.length, '条');
  console.log('  CURATED_TEAMS:', teamsDocs.length, '条');
  console.log('  TI_CONTESTANT_TEAM_IDS:', tiIds.length, '个');
  console.log('  version:', metaDoc.version);
  console.log('');

  // 输出前 3 条样例
  console.log('events 样例（前 3 条）:');
  eventsDocs.slice(0, 3).forEach((e) => console.log('  -', JSON.stringify({ _id: e._id, canonical: e.canonical, tier: e.tier, start: e.start, end: e.end })));
  console.log('');
  console.log('teams 样例（前 3 条）:');
  teamsDocs.slice(0, 3).forEach((t) => console.log('  -', JSON.stringify({ _id: t._id, name: t.name, tag: t.tag, tier: t.tier })));
  console.log('');

  if (isDryRun) {
    console.log('🔍 dry-run 模式：不写入云数据库');
    console.log('如需导出 JSONL 文件供控制台导入，请使用: npm run migrate:curation:export');
    console.log('如需实际写入，请去掉 --dry-run 参数重新运行');
    console.log('');
    console.log('写入计划:');
    console.log('  curation_events collection:', eventsDocs.length, '条记录（_id = 规范名归一化）');
    console.log('  curation_teams collection:', teamsDocs.length, '条记录（_id = team_id 字符串）');
    console.log('  curation_meta collection: 1 条记录（_id = "ti_contestant_ids"，含 version 字段）');
    return;
  }

  // ===== 导出 JSONL 模式 =====
  // 生成 3 个 JSONL 文件（每行一个 JSON 对象），供微信开发者工具云开发控制台手动导入。
  // 微信云开发数据库导入格式要求：文件扩展名 .json，每行一个完整 JSON 对象。
  // 本方案无需 wx-server-sdk / 腾讯云 API 密钥，是最可靠的迁移路径。
  if (isExport) {
    const fs = require('fs');
    const exportDir = path.join(__dirname, 'export');

    // 创建导出目录
    if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir, { recursive: true });

    // JSONL 序列化：每行一个 JSON 对象（不含 _id，由控制台导入时自动生成或用 _id 字段）
    // 注意：微信控制台导入时需勾选「冲突处理」为「upsert」以保留 _id
    function toJsonl(docs) {
      return docs.map((d) => JSON.stringify(d)).join('\n') + '\n';
    }

    const eventsFile = path.join(exportDir, 'curation_events.json');
    const teamsFile = path.join(exportDir, 'curation_teams.json');
    const metaFile = path.join(exportDir, 'curation_meta.json');

    fs.writeFileSync(eventsFile, toJsonl(eventsDocs), 'utf8');
    fs.writeFileSync(teamsFile, toJsonl(teamsDocs), 'utf8');
    fs.writeFileSync(metaFile, toJsonl([metaDoc]), 'utf8');

    console.log('📦 JSONL 文件已导出到 scripts/export/ 目录:');
    console.log('  ', eventsFile, '(', eventsDocs.length, '条 )');
    console.log('  ', teamsFile, '(', teamsDocs.length, '条 )');
    console.log('  ', metaFile, '( 1 条 )');
    console.log('');
    console.log('导入步骤：');
    console.log('  1. 打开微信开发者工具 → 云开发 → 数据库');
    console.log('  2. 分别创建 3 个 collection：curation_events / curation_teams / curation_meta');
    console.log('     （或直接在导入时让系统自动创建）');
    console.log('  3. 逐个 collection 点击「导入」→ 选择对应 JSONL 文件');
    console.log('     - 冲突处理：选择「upsert」（保留 _id）');
    console.log('     - 文件格式：JSON');
    console.log('  4. 导入完成后验证记录数：');
    console.log('     - curation_events: ' + eventsDocs.length + ' 条');
    console.log('     - curation_teams: ' + teamsDocs.length + ' 条');
    console.log('     - curation_meta: 1 条（_id = ti_contestant_ids，version = ' + metaDoc.version + '）');
    return;
  }

  // 实际写入云数据库
  console.log('正在连接云数据库...');

  let cloud;
  try {
    cloud = require('wx-server-sdk');
  } catch (e) {
    // 根目录未安装 wx-server-sdk，尝试从 cloudfunctions/aggregation/node_modules 复用
    // 避免在根目录重复安装依赖（wx-server-sdk 仅云函数侧需要）
    try {
      cloud = require(path.join(__dirname, '..', '..', 'cloudfunctions', 'aggregation', 'node_modules', 'wx-server-sdk'));
      console.log('ℹ️  从 cloudfunctions/aggregation/node_modules 复用 wx-server-sdk');
    } catch (e2) {
      console.error('❌ 缺少 wx-server-sdk 依赖');
      console.error('   请运行: cd cloudfunctions/aggregation && npm install');
      console.error('');
      console.error('替代方案：先用 --dry-run 预览数据，然后通过云开发控制台手动导入');
      process.exit(1);
    }
  }

  // 读取 envId
  const config = require(path.join(__dirname, '..', '..', 'utils', 'config.js'));
  const envId = config.cloudProxy && config.cloudProxy.envId;
  if (!envId) {
    console.error('❌ 未配置 cloudProxy.envId');
    console.error('   请在 utils/config.js 中设置 cloudProxy.envId');
    process.exit(1);
  }

  cloud.init({ env: envId });
  const db = cloud.database();

  // 批量写入（upsert 语义：存在则覆盖，不存在则新增）
  // 注意：set({ data }) 的 data 不能包含 _id 字段（云数据库限制：_id 由 doc(id) 指定，不能在 data 中重复）
  // 因此写入前需从 data 中移除 _id
  function stripId(doc) {
    const data = Object.assign({}, doc);
    delete data._id;
    return data;
  }

  console.log('写入 curation_events collection (' + eventsDocs.length + ' 条)...');
  let eventsOk = 0, eventsFail = 0;
  for (const doc of eventsDocs) {
    try {
      await db.collection('curation_events').doc(doc._id).set({ data: stripId(doc) });
      eventsOk++;
    } catch (e) {
      eventsFail++;
      if (eventsFail <= 3) console.error('  失败:', doc._id, e.message);
    }
  }
  console.log('  成功:', eventsOk, '失败:', eventsFail);

  console.log('写入 curation_teams collection (' + teamsDocs.length + ' 条)...');
  let teamsOk = 0, teamsFail = 0;
  for (const doc of teamsDocs) {
    try {
      await db.collection('curation_teams').doc(doc._id).set({ data: stripId(doc) });
      teamsOk++;
    } catch (e) {
      teamsFail++;
      if (teamsFail <= 3) console.error('  失败:', doc._id, e.message);
    }
  }
  console.log('  成功:', teamsOk, '失败:', teamsFail);

  console.log('写入 curation_meta collection (1 条)...');
  try {
    await db.collection('curation_meta').doc(metaDoc._id).set({ data: stripId(metaDoc) });
    console.log('  成功: 1');
  } catch (e) {
    console.error('  失败:', e.message);
  }

  console.log('');
  console.log('✅ 迁移完成');
  console.log('');
  console.log('下一步:');
  console.log('  1. 在云开发控制台查看 curation_events / curation_teams / curation_meta collection');
  console.log('  2. 部署云函数 aggregation（含新增 getCuration action）');
  console.log('  3. 客户端改造 remoteCuration.js 调用云函数 getCuration');
}

// 计算数据指纹（用于客户端判断是否需要增量更新）
function computeVersion(events, teams, tiIds) {
  const crypto = require('crypto');
  const hash = crypto.createHash('md5');
  hash.update(JSON.stringify({
    eventsCount: events.length,
    teamsCount: Object.keys(teams).length,
    tiIdsCount: tiIds.length,
    eventsCanonical: events.map(e => e.canonical).sort().join(','),
    teamsIds: Object.keys(teams).sort().join(',')
  }));
  return hash.digest('hex').slice(0, 8);
}

main().catch((e) => { console.error('FAILED:', e.message, e.stack); process.exit(1); });
