// 分析用户导出的 3 个云开发集合 JSON
const fs = require('fs');

const FILES = {
  a: 'D:/Users/ZH/Downloads/database_export-ysXXdhaGk0WF.json',
  b: 'D:/Users/ZH/Downloads/database_export-oudXsxmOGUHd.json',
  c: 'D:/Users/ZH/Downloads/database_export-VkOpCLYxmc_o.json'
};

function load(p) {
  const raw = fs.readFileSync(p, 'utf8');
  let j = null;
  try { j = JSON.parse(raw); } catch (e) { return { err: e.message, raw: raw.slice(0, 200), size: raw.length }; }
  return { json: j, size: raw.length };
}

// 云开发导出的常见形态：{ } 单对象 / [ ] 数组 / JSONL（每行一个对象）
function toArray(j) {
  if (Array.isArray(j)) return j;
  if (j && typeof j === 'object') {
    if (Array.isArray(j.data)) return j.data;
    if (Array.isArray(j.records)) return j.records;
    return [j];  // 单条
  }
  return [];
}

for (const k of Object.keys(FILES)) {
  const p = FILES[k];
  console.log('════ ' + k + ' ｜ ' + p.split('/').pop() + ' ════');
  let r;
  try { r = load(p); } catch (e) { console.log('  读取失败: ' + e.message); console.log(''); continue; }
  if (r.err) {
    // 可能是 JSONL
    const lines = fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim());
    console.log('  JSON.parse 失败（' + r.err + '）｜文件 ' + (r.size / 1024).toFixed(1) + 'KB ｜非空行 ' + lines.length);
    console.log('  首行预览: ' + lines[0].slice(0, 180));
    console.log('');
    continue;
  }
  const arr = toArray(r.json);
  console.log('  文件 ' + (r.size / 1024).toFixed(1) + 'KB ｜记录数 ' + arr.length);
  if (arr.length) {
    const keys = new Set();
    arr.forEach((o) => { if (o && typeof o === 'object') Object.keys(o).forEach((x) => keys.add(x)); });
    console.log('  字段集合(' + keys.size + '): ' + Array.from(keys).join(', '));
    console.log('  _id 样例: ' + JSON.stringify(arr[0]._id));
    console.log('  首条完整 JSON（截断 700 字）:');
    console.log('    ' + JSON.stringify(arr[0]).slice(0, 700));
  }
  console.log('');
}
