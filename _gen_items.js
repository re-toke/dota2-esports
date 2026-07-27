// 一次性生成脚本：基于 dota2.com.cn 官方 JSON 生成 itemZh.js（商店物品中文）与 neutralItems.js（中立物品权威数据）。
// 数据源（合规参考，非运行时抓取）：
//   https://www.dota2.com.cn/itemscategory/json  -> result.basic / upgrade / neutral（每项含 name=内部名, name_loc=官方中文, item_id, cost, img_url）
// 关键：dota2.com.cn 线上 items_new.js 的 Tab2 中立渲染，实际只读取 res.result.neutral（neutralitems/json 已被注释废弃）。
// 因此「中立物品的权威集合 + 层级 + 中文」全部来自 itemscategory/json 的 result.neutral：
//   - 每个一级分类名为「第1级」..「第5级」，分类下标 i 即层级 tier = i+1；
//   - 每个物品自带官方中文 name_loc。
const fs = require('fs');

const cat = JSON.parse(fs.readFileSync('_d2_itemscategory_json.json', 'utf8')).result;

// ===== 1) 商店物品中文名映射（basic + upgrade + neutral 全部内部名 -> 官方中文）=====
// 注意：basic/upgrade/neutral 均为「分类对象数组」[{ name, items:[...] }]，必须下钻 .items[]。
const zhRaw = {};
function addItem(it) {
  if (it && it.name && it.name_loc) zhRaw[it.name] = it.name_loc;
}
(cat.basic || []).forEach((c) => (c.items || []).forEach(addItem));
(cat.upgrade || []).forEach((c) => (c.items || []).forEach(addItem));
(cat.neutral || []).forEach((c) => (c.items || []).forEach(addItem));

// ===== 2) 中立物品权威数据（层级来自 result.neutral 的分类下标，与线上 Tab2 一致）=====
const TIER_NAME = { 1: '第1级', 2: '第2级', 3: '第3级', 4: '第4级', 5: '第5级' };
const neutralLookup = {};   // name -> { id, nameZh, tier, tierName }
(cat.neutral || []).forEach((c, idx) => {
  const tier = idx + 1;     // 分类顺序即层级：第1级=1 ... 第5级=5
  const tierName = TIER_NAME[tier] || c.name;
  (c.items || []).forEach((it) => {
    if (!it || !it.name) return;
    neutralLookup[it.name] = {
      id: it.item_id,
      nameZh: it.name_loc || '',
      tier: tier,
      tierName: tierName
    };
  });
});

// ===== 3) 覆盖率校验（与 OpenDota 501 内部名对比）=====
const odKeys = fs.readFileSync('_od_keys.txt', 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
const odSet = new Set(odKeys);
const zhKeys = Object.keys(zhRaw);
const covered = zhKeys.filter((k) => odSet.has(k));
const missing = odKeys.filter((k) => !zhRaw[k]);
const neutralNames = Object.keys(neutralLookup);
const neutralInOd = neutralNames.filter((n) => odSet.has(n));
const neutralMissingZh = neutralNames.filter((n) => !zhRaw[n]);
console.log('--- 商店物品中文覆盖 ---');
console.log('OpenDota 常规/全量内部名总数:', odKeys.length);
console.log('dota2 提供中文的商店物品:', zhKeys.length, '| 与 OpenDota 匹配(覆盖):', covered.length);
console.log('OpenDota 有但 dota2 商店未收录(回退英文, 预期为非商店类):', missing.length);
if (missing.length) console.log('   缺口样例:', missing.slice(0, 30).join(', '));
console.log('--- 中立物品权威数据 ---');
console.log('中立物品总数:', neutralNames.length, '| 在 OpenDota 命中:', neutralInOd.length);
console.log('中立物品中文缺失(应为0):', neutralMissingZh.length, neutralMissingZh);
const tierCounts = {};
neutralNames.forEach((n) => { const t = neutralLookup[n].tier; tierCounts[t] = (tierCounts[t] || 0) + 1; });
console.log('层级分布:', JSON.stringify(tierCounts));

// ===== 4) 写出 utils/itemZh.js =====
const sortedZh = Object.keys(zhRaw).sort();
let out = '';
out += '// utils/itemZh.js\n';
out += '// 物品中文名映射（数据源自 dota2.com.cn 官方 itemscategory/json，合规参考、本地策展）。\n';
out += '// 键为 OpenDota /constants/items 内部名（it.name），值为官方中文名（name_loc）。\n';
out += '// 覆盖全部商店物品（basic + upgrade + neutral）；未收录项（非商店/已下架/特殊）由 utils/items.js 回退英文。\n';
out += '// 由 _gen_items.js 从官方 JSON 生成；如需人工修正，直接编辑下方映射即可。\n\n';
out += 'const ZH = {\n';
sortedZh.forEach((k, i) => {
  out += '  ' + JSON.stringify(k) + ': ' + JSON.stringify(zhRaw[k]) + (i < sortedZh.length - 1 ? ',' : '') + '\n';
});
out += '};\n\n';
out += 'module.exports = ZH;\n';
fs.writeFileSync('utils/itemZh.js', out);
console.log('-> 写出 utils/itemZh.js 条目数:', sortedZh.length);

// ===== 5) 写出 utils/neutralItems.js（作为内部名 -> 层级 的查询表）=====
const sortedNeu = Object.keys(neutralLookup).sort();
let nout = '';
nout += '// utils/neutralItems.js\n';
nout += '// 中立物品（Neutral Items）权威数据集：数据源自 dota2.com.cn 官方 itemscategory/json 的 result.neutral（线上 Tab2 实际渲染源）。\n';
nout += '// 以内部名(name)为键，值含：id(官方 item_id) / nameZh(官方中文) / tier(1-5) / tierName(第N级)。\n';
nout += '// 层级 tier 取自 result.neutral 的分类下标（第1级=1 ... 第5级=5），与官网最新 Tab2 完全一致。\n';
nout += '// 注意：OpenDota /constants/items 已包含中立物品（同 id），故 utils/items.js 直接「合并」而非「追加」，避免重复条目与 id 冲突。\n';
nout += '// 由 _gen_items.js 从官方 JSON 生成。\n\n';
nout += 'const NEUTRAL_ITEMS = {\n';
sortedNeu.forEach((k, i) => {
  nout += '  ' + JSON.stringify(k) + ': ' + JSON.stringify(neutralLookup[k]) + (i < sortedNeu.length - 1 ? ',' : '') + '\n';
});
nout += '};\n\n';
nout += 'module.exports = NEUTRAL_ITEMS;\n';
fs.writeFileSync('utils/neutralItems.js', nout);
console.log('-> 写出 utils/neutralItems.js 条目数:', sortedNeu.length);
