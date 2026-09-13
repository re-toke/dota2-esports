// 深度分析：curation_events（JSONL 2414 条）+ teams + meta
const fs = require('fs');

const A = 'D:/Users/ZH/Downloads/database_export-ysXXdhaGk0WF.json'; // teams
const B = 'D:/Users/ZH/Downloads/database_export-oudXsxmOGUHd.json'; // meta
const C = 'D:/Users/ZH/Downloads/database_export-VkOpCLYxmc_o.json'; // events

function jsonl(p) {
  return fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => {
    try { return JSON.parse(l); } catch (e) { return { __parseErr: e.message }; }
  });
}

console.log('════ ① curation_events（2414 条）字段画像 ════');
const ev = jsonl(C);
console.log('  记录数: ' + ev.length + ' ｜解析失败: ' + ev.filter((e) => e.__parseErr).length);
const keyCount = {};
ev.forEach((e) => Object.keys(e).forEach((k) => { keyCount[k] = (keyCount[k] || 0) + 1; }));
console.log('  字段出现次数（降序）:');
Object.keys(keyCount).sort((a, b) => keyCount[b] - keyCount[a]).forEach((k) => {
  console.log('    ' + k.padEnd(20) + keyCount[k] + ' / ' + ev.length + (keyCount[k] < ev.length ? '  ← 非必有' : '  ← 全有'));
});
const ids = ev.map((e) => e._id).filter(Boolean);
const uniq = new Set(ids);
console.log('  _id 唯一性: ' + uniq.size + ' / ' + ids.length + (uniq.size === ids.length ? '  ✅ 无重复' : '  ⚠️ 有重复'));
console.log('  _id 形态样例: ' + JSON.stringify(ids.slice(0, 5)));
console.log('  _id 是否全为纯数字: ' + (ids.every((x) => /^\d+$/.test(String(x))) ? '是' : '否（含 slug 形态）'));
const years = {};
ev.forEach((e) => { const y = e.year == null ? '(无)' : e.year; years[y] = (years[y] || 0) + 1; });
console.log('  year 分布: ' + Object.keys(years).sort().map((y) => y + ':' + years[y]).join('  '));
const tiers = {};
ev.forEach((e) => { const g = (e.tier && e.tier.grade) || '(无)'; tiers[g] = (tiers[g] || 0) + 1; });
console.log('  tier.grade 分布: ' + Object.keys(tiers).sort().map((g) => g + ':' + tiers[g]).join('  '));
const statuses = {};
ev.forEach((e) => { const s = e.status == null ? '(无)' : e.status; statuses[s] = (statuses[s] || 0) + 1; });
console.log('  status 分布: ' + Object.keys(statuses).map((s) => s + ':' + statuses[s]).join('  '));
console.log('  样例（2 条完整）:');
ev.slice(0, 2).forEach((e) => console.log('    ' + JSON.stringify(e).slice(0, 520)));

console.log('');
console.log('════ ② curation_teams ════');
const tm = jsonl(A);
console.log('  记录数: ' + tm.length);
console.log('  _id 样例: ' + JSON.stringify(tm.map((t) => t._id).slice(0, 8)));
console.log('  字段: ' + Array.from(new Set(tm.flatMap((t) => Object.keys(t)))).join(', '));

console.log('');
console.log('════ ③ curation_meta ════');
const meta = JSON.parse(fs.readFileSync(B, 'utf8'));
console.log('  _id: ' + meta._id + ' ｜ count: ' + meta.count + ' ｜ version: ' + meta.version);
const uniqIds = new Set(meta.ids);
console.log('  ids 数组长度 ' + meta.ids.length + ' ｜唯一 ' + uniqIds.size + (uniqIds.size < meta.ids.length ? '  ⚠️ 含重复 ' + (meta.ids.length - uniqIds.size) + ' 个' : ''));

console.log('');
console.log('════ ④ admin-logs 那条记录的时间戳换算 ════');
const ts = 1785465512940;
const d = new Date(ts);
console.log('  ' + ts + ' → ' + d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC');
console.log('  = 北京时间 ' + new Date(ts + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19));
const daysAgo = Math.round((Date.now() - ts) / 86400000);
console.log('  距今 ' + daysAgo + ' 天');
