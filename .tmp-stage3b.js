const fs = require('fs');
const { execSync } = require('child_process');

/* ===== ① supabaseClient.rest()：eq 值支持操作符前缀（gte./lt. 等）===== */
const P1 = 'utils/supabaseClient.js';
let s1 = fs.readFileSync(P1, 'utf8');
if (s1.indexOf('// 支持操作符前缀') < 0) {
  const a = "        url += '&' + k + '=eq.' + encodeURIComponent(q.eq[k]);";
  if (s1.indexOf(a) < 0) throw new Error('eq anchor missing');
  s1 = s1.replace(a,
    "        // ★ 2026-09-13：值可带操作符前缀（gte./lte./gt./lt./not.）——若带则原样使用\n"
    + "        var v = String(q.eq[k]);\n"
    + "        var isOp = /^(eq|gte|lte|gt|lt|not|like|in)\\./.test(v);\n"
    + "        url += '&' + k + '=' + (isOp ? v : 'eq.' + encodeURIComponent(v));");
  fs.writeFileSync(P1, s1);
  console.log('① supabaseClient.rest() 已支持操作符前缀');
} else console.log('① 已支持，跳过');

/* ===== ② remoteCuration：渐进式加载 + 删诊断日志 ===== */
const P2 = 'utils/remoteCuration.js';
let L = fs.readFileSync(P2, 'utf8').split('\n');
const bare = (l) => l.replace(/\r$/, '');

// 2a 删诊断日志
const di = L.findIndex((l) => bare(l).indexOf('诊断 v8.69') >= 0);
if (di >= 0) { L.splice(di, 1); console.log('② 已删除临时诊断日志'); }
else console.log('② 诊断日志已不存在');

// 2b 在 `function load(force) {` 之前插入两个新函数
const loadAt = L.findIndex((l) => bare(l) === 'function load(force) {');
if (loadAt < 0) throw new Error('load anchor missing');
const impl = [
  '/**',
  ' * ★ 阶段2-③B（2026-09-13）：**首屏只拉近期子集**（year >= 2025）。',
  ' *',
  ' * 动机：全量 2414 条约 690KB，是「每日首开慢」的主因。',
  ' * 做法：先用单条件过滤（PostgREST 的 gte 操作符，避免 or= 与 json 箭头的兼容风险）',
  ' *   取近期赛事 → 首页秒开；全量由 _scheduleFullLoad 在后台补。',
  ' * 数据依据：实测 year>=2025 共 83 条（2026:27 + 2025:56），约全量的 3%。',
  ' *',
  ' * 任何失败返回 null（调用方回落全量 / 云函数）。',
  ' */',
  'function _sbLoadCurationRecent() {',
  "  var sb = require('./supabaseClient.js');",
  '  if (!sb || !sb.enabled()) return Promise.resolve(null);',
  "  return sb.rest('curation_events', {",
  "    select: 'canonical_key,league_id,data',",
  "    eq: { 'data->>year': 'gte.2025' },",
  '    limit: 1000',
  '  }).then(function (rows) {',
  '    var events = [];',
  '    (rows || []).forEach(function (r) { if (r && r.data) events.push(r.data); });',
  '    if (!events.length) return null;',
  "    return sb.rest('curation_teams', { select: 'team_id,data', limit: 1000 }).then(function (teamRows) {",
  '      var teams = {};',
  '      (teamRows || []).forEach(function (r) { if (r && r.team_id != null && r.data) teams[Number(r.team_id)] = r.data; });',
  "      return sb.rest('curation_meta', { select: 'key,value', eq: { key: 'ti_contestant_ids' }, limit: 1 }).then(function (metaRows) {",
  '        var row = metaRows && metaRows[0];',
  '        var tiIds = (row && row.value && row.value.ids) || [];',
  "        return { events: events, teams: teams, tiContestantIds: tiIds, version: 'sb-recent:' + events.length };",
  '      });',
  '    });',
  '  }).catch(function (e) {',
  "    console.warn('[remoteCuration] SB 近期子集读取失败:', e && e.message);",
  '    return null;',
  '  });',
  '}',
  '',
  '/** 后台补拉全量（不阻塞首屏；每会话仅一次） */',
  'var _bgFullDone = false;',
  'function _scheduleFullLoad() {',
  '  if (_bgFullDone) return;',
  '  _bgFullDone = true;',
  '  setTimeout(function () {',
  '    _sbLoadCuration().then(function (full) {',
  '      if (!full || !full.events || !full.events.length) return;',
  '      if (_applyRemote(full)) {',
  "        console.log('[remoteCuration] 后台已补全量, events:', full.events.length);",
  '      }',
  '    }).catch(function () { /* 静默：首屏已有数据 */ });',
  '  }, 3000);',
  '}',
  ''
];
L.splice(loadAt, 0, ...impl);

// 2c 替换 SB 分支为「近期优先 → 全量 → 云函数」三段式
const sbStart = L.findIndex((l) => bare(l).trim() === 'if (_sbOn) {');
if (sbStart < 0) throw new Error('SB 分支起点未找到');
// 终点：从起点往后，找到紧跟 `return loadingPromise;` 的那行 `}`
let sbEnd = -1;
for (let i = sbStart; i < sbStart + 20; i++) {
  if (bare(L[i]).trim() === 'return loadingPromise;') { sbEnd = i + 1; break; }
}
if (sbEnd < 0 || bare(L[sbEnd]).trim() !== '}') throw new Error('SB 分支终点未找到');
const newBlock = [
  '  if (_sbOn) {',
  '    loadingPromise = _sbLoadCurationRecent().then(function (recent) {',
  '      // ① 首屏：近期子集（快）',
  '      if (recent && recent.events && recent.events.length) {',
  "        console.log('[remoteCuration] 首屏走 Supabase 直读·近期子集, events:', recent.events.length);",
  '        if (_applyRemote(recent)) { _scheduleFullLoad(); return true; }',
  '      }',
  '      // ② 近期失败 → 全量直读',
  '      return _sbLoadCuration().then(function (sbData) {',
  '        if (sbData && sbData.events && sbData.events.length) {',
  "          console.log('[remoteCuration] 走 Supabase 直读·全量, events:', sbData.events.length);",
  '          if (_applyRemote(sbData)) return true;',
  '        }',
  '        // ③ 都失败 → 云函数兜底',
  '        return _cloudLoad(force, clientVersion, meta);',
  '      });',
  '    }).then(function (r) { loadingPromise = null; return r; });',
  '    return loadingPromise;',
  '  }'
];
L.splice(sbStart, sbEnd - sbStart + 1, ...newBlock);

fs.writeFileSync(P2, L.join('\n'));
console.log('② remoteCuration 已改为渐进式加载（近期优先 → 全量 → 云函数）');

for (const f of [P1, P2]) { execSync('node --check ' + f, { stdio: 'pipe' }); }
console.log('✅ 语法 OK');
try {
  execSync('npx eslint --rulesdir scripts/eslint-rules ' + P1 + ' ' + P2, { stdio: 'pipe' });
  console.log('✅ ESLint 无 error');
} catch (e) {
  const errs = ((e.stdout || '') + (e.stderr || '')).split('\n').filter((l) => l.indexOf('error') >= 0 && l.indexOf('warning') < 0);
  console.log(errs.length ? '❌ error:\n' + errs.slice(0, 4).join('\n') : '✅ ESLint 无 error');
}
try {
  execSync('git add -A', { stdio: 'pipe' });
  execSync('git commit -m "v8.70: 阶段2-③B 渐进式加载（首屏拉近期子集→后台补全量）+ 删诊断日志"', { stdio: 'pipe' });
  console.log('已提交: ' + execSync('git log --oneline -1', { encoding: 'utf8' }).trim());
} catch (e) { console.log('提交输出:\n' + ((e.stdout || '') + (e.stderr || '')).slice(-350)); }
