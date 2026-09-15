const fs = require('fs');
const { execSync } = require('child_process');

/* ===== Fix A：rest() 超时 12s → 25s ===== */
const P1 = 'utils/supabaseClient.js';
const l1 = fs.readFileSync(P1, 'utf8').split('\n');
let a = 0;
l1.forEach((l, i) => {
  if (l.indexOf('timeout: 12000') >= 0) { l1[i] = l.replace('timeout: 12000', 'timeout: 25000'); a++; }
});
fs.writeFileSync(P1, l1.join('\n'));
console.log('Fix A：timeout 12000 → 25000（' + a + ' 处）');

/* ===== Fix B + C：remoteCuration ===== */
const P2 = 'utils/remoteCuration.js';
let s = fs.readFileSync(P2, 'utf8');

// B：分页 1000 → 400（每页更小，跨境更稳）
const beforeB = s;
s = s.split('var PAGE = 1000;').join('var PAGE = 400;');
console.log('Fix B：分页 1000 → 400（' + (s !== beforeB ? '已改' : '未找到') + '）');

// C1：调用处传 partial=true
const callOld = 'if (_applyRemote(recent)) { _scheduleFullLoad(); return true; }';
const callNew = 'if (_applyRemote(recent, true)) { _scheduleFullLoad(); return true; }   // true = partial（短 TTL，下次启动重试全量）';
if (s.indexOf(callOld) >= 0) { s = s.replace(callOld, callNew); console.log('Fix C1：调用处已传 partial=true'); }
else console.log('Fix C1：锚点未找到');

// C2：_applyRemote 增加 partial 参数 + 短 TTL
const fnOld = 'function _applyRemote(data) {';
const fnNew = [
  '/**',
  ' * 应用远端 curation（SB 与云函数两条路共用）',
  ' * @param {object} data  {events, teams, tiContestantIds, version}',
  ' * @param {boolean} [partial] 仅近期子集时为 true → 用短 TTL 缓存',
  ' *   ★ 2026-09-15：实测踩过 —— 首屏只拉到近期子集、后台补全量又 timeout 时，',
  ' *   6h 长 TTL 会把客户端卡在「只有 179 条」的状态；短 TTL 让下次启动重新尝试全量。',
  ' */',
  'function _applyRemote(data, partial) {'
].join('\n');
if (s.indexOf(fnOld) >= 0) { s = s.replace(fnOld, fnNew); console.log('Fix C2a：_applyRemote 已加 partial 参数'); }
else console.log('Fix C2a：函数签名锚点未找到');

const setOld = 'cache.set(CACHE_KEY, { events: eff.events, teams: eff.teams, tiContestantIds: eff.tiContestantIds }, config.remoteCuration.ttlSec);';
const setNew = [
  'var _ttl = partial ? 1800 : config.remoteCuration.ttlSec;   // partial: 30min；完整: 6h',
  "if (partial) console.log('[remoteCuration] 仅近期子集 → 缓存 30min（下次启动重试全量）');",
  'cache.set(CACHE_KEY, { events: eff.events, teams: eff.teams, tiContestantIds: eff.tiContestantIds }, _ttl);'
].join('\n    ');
if (s.indexOf(setOld) >= 0) { s = s.replace(setOld, setNew); console.log('Fix C2b：缓存 TTL 已按 partial 分流'); }
else console.log('Fix C2b：cache.set 锚点未找到');

fs.writeFileSync(P2, s);

for (const f of [P1, P2]) execSync('node --check ' + f, { stdio: 'pipe' });
console.log('✅ 语法 OK');

console.log('');
console.log('=== 关键点复核 ===');
[
  [P1, 'timeout: 25000'],
  [P2, 'var PAGE = 400;'],
  [P2, 'function _applyRemote(data, partial)'],
  [P2, '_applyRemote(recent, true)'],
  [P2, 'var _ttl = partial ? 1800']
].forEach(([f, k]) => {
  const c = fs.readFileSync(f, 'utf8');
  const n = c.split(k).length - 1;
  console.log((n ? '✅' : '❌') + ' ' + f.split('/').pop() + '  «' + k + '» × ' + n);
});

for (const f of [P1, P2]) {
  try { execSync('npx eslint --rulesdir scripts/eslint-rules ' + f, { stdio: 'pipe' }); console.log('✅ ESLint: ' + f.split('/').pop()); }
  catch (e) {
    const errs = ((e.stdout || '') + (e.stderr || '')).split('\n').filter((x) => x.indexOf('error') >= 0 && x.indexOf('warning') < 0);
    console.log(errs.length ? '❌ ESLint ' + f.split('/').pop() + ': ' + errs.slice(0, 2).join(' | ') : '✅ ESLint: ' + f.split('/').pop() + '（仅 warning）');
  }
}

try {
  execSync('git add -A', { stdio: 'pipe' });
  execSync('git commit -F -', { input: [
    'v8.82: 修 ③B 的两个实测缺陷（全量超时 + partial 缓存长 TTL 陷阱）',
    '',
    '## 起因（用户真机日志）',
    '  [remoteCuration] 首屏走 Supabase 直读·近期子集, events: 179',
    '  [remoteCuration] 后台补全量开始（分页拉全量）...',
    '  [remoteCuration] Supabase 直读失败，将回落云函数: request:fail timeout   ← ★',
    '→ 后台补全量超时 → 客户端只有 224 条（179+73），且 6h 缓存 TTL 会让它一直这样。',
    '',
    '## 修复',
    '1 supabaseClient.rest()：timeout 12000 → **25000**',
    '   原因：分页全量每页 1000 行 jsonb（约 250KB），跨境链路 12s 必超时',
    '2 remoteCuration 分页：PAGE 1000 → **400**（每页更小，单次更快更稳）',
    '3 ★ partial 缓存短 TTL：仅近期子集时缓存 **30min**（而非 6h）',
    '   → 后台补全量失败也不会把客户端卡在「只剩近期」状态 6 小时，下次启动重试全量',
    '',
    '## 说明',
    '这一条正是我在 ③B 时提示过的风险（「若后台补全量长期失败，需加兜底」），',
    '真机上确实发生了。当时未加兜底是判断失误：应在上线时就配套，而不是等它出问题。'
  ].join('\n'), stdio: 'pipe' });
  console.log('');
  console.log('已提交: ' + execSync('git log --oneline -1', { encoding: 'utf8' }).trim());
} catch (e) { console.log('提交输出:\n' + ((e.stdout || '') + (e.stderr || '')).slice(-300)); }
