#!/usr/bin/env node
/**
 * scripts/test/test-follow-batch.js
 * 首页关注流「三态 / 合并 / 编组 / 文案」纯逻辑守卫（2026-09-27 · P0-新增）
 *
 * ## 为什么有这组测试
 * 修的是一个**静默失败**：`pages/index/index.js` 原实现 `.catch(() => ({ t, ms: [] }))`
 * 把「取数失败」伪装成「确实没有比赛」⇒ 失败的关注战队**无卡片、无提示**地消失，
 * 而 `followLoading: false` 还会**掩盖**它（实测注入 15 队、首页只出 6~10 张且两次不一致）。
 * ⇒ 这三态判定 + 合并 + 编组**必须可测**（页面层零测试是本项目最大盲区），故抽成 `utils/followBatch.js`。
 *
 * 运行：node scripts/test/test-follow-batch.js
 */
'use strict';

const path = require('path');
const fb = require(path.join(__dirname, '..', '..', 'utils', 'followBatch.js'));

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + '  ->  ' + (detail || '')); }
}

const R = (id, ok, n) => ({ t: { id: id, name: 'T' + id }, ms: new Array(n || 0), ok: ok });

console.log('\n--- ① 三态判定：失败与成功必须可分 ---');
{
  const rows = [R(1, true, 2), R(2, false), R(3, true, 0), R(4, false), R(5, true, 1)];
  assert('failedOf 只取 ok===false', fb.failedOf(rows).map((r) => r.t.id).join(',') === '2,4',
    fb.failedOf(rows).map((r) => r.t.id).join(','));
  assert('okOf 取非 false（含 ok===undefined 的历史数据，向后兼容）',
    fb.okOf(rows).map((r) => r.t.id).join(',') === '1,3,5',
    fb.okOf(rows).map((r) => r.t.id).join(','));
  assert('★ ok===undefined 不算失败（旧数据/旧调用不误报失败）',
    fb.failedOf([{ t: { id: 9 }, ms: [] }]).length === 0);
  assert('★ 「成功但无比赛」(ok:true,ms:[]) 与「失败」可区分',
    fb.failedOf([R(1, true, 0)]).length === 0 && fb.okOf([R(1, true, 0)]).length === 1);
  assert('空/非数组入参不抛错', fb.failedOf(null).length === 0 && fb.okOf(undefined).length === 0);
}

console.log('\n--- ② mergeRetried：按 id 就地替换、保持原顺序 ---');
{
  const rows = [R(1, true, 2), R(2, false), R(3, false), R(4, true, 1)];
  const again = [R(3, true, 5)];                       // 3 重试成功
  const m = fb.mergeRetried(rows, again);
  assert('★ 原顺序保持不变（关注卡顺序不抖动）',
    m.map((r) => r.t.id).join(',') === '1,2,3,4', m.map((r) => r.t.id).join(','));
  assert('★ 长度不变（不新增/不删除条目）', m.length === rows.length);
  assert('★ 重试成功者被替换（ok/ms 都更新）',
    m[2].ok === true && m[2].ms.length === 5);
  assert('★ 未重试的失败条目保持失败（不被误清）',
    fb.failedOf(m).map((r) => r.t.id).join(',') === '2',
    fb.failedOf(m).map((r) => r.t.id).join(','));
  assert('★ 不修改入参数组（纯函数）', rows[2].ok === false && rows[2].ms.length === 0);
  assert('空重试结果 ⇒ 原样返回（数量/顺序不变）',
    fb.mergeRetried(rows, []).map((r) => r.t.id).join(',') === '1,2,3,4');
  assert('重试结果里的**未知 id** 不会新增条目',
    fb.mergeRetried(rows, [R(99, true, 1)]).length === 4);
  // ★ 敏感性证明（防"永真断言"）：失败数必须随重试结果变化
  //   ⚠️ 本组 rows 里有**两个**失败（id=2、id=3）⇒ 只重试其中一个时失败数应由 2 → 1
  assert('★ 敏感性：仅重试 id=2 成功 ⇒ 失败数 2 → 1（判据随数据变，非永真）',
    fb.failedOf(rows).length === 2 && fb.failedOf(fb.mergeRetried(rows, [R(2, true, 0)])).length === 1,
    fb.failedOf(rows).length + ' → ' + fb.failedOf(fb.mergeRetried(rows, [R(2, true, 0)])).length);
  assert('★ 敏感性：两个失败都重试成功 ⇒ 失败数 2 → 0',
    fb.failedOf(fb.mergeRetried(rows, [R(2, true, 0), R(3, true, 0)])).length === 0);
}

console.log('\n--- ③ chunkBySize / groupByConcurrency：尾批次并发编组 ---');
{
  const teams = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
  const chunks = fb.chunkBySize(teams, 5);
  assert('chunkBySize 5：14 → 3 批（5/5/4）',
    chunks.length === 3 && chunks[0].length === 5 && chunks[2].length === 4,
    JSON.stringify(chunks.map((c) => c.length)));
  const g2 = fb.groupByConcurrency(chunks, 2);
  assert('★ 并发度 2：3 批 → 2 组（[5,5] 与 [4]）⇒ 尾巴从 3×RTT 降到 2×RTT',
    g2.length === 2 && g2[0].length === 2 && g2[1].length === 1,
    JSON.stringify(g2.map((g) => g.length)));
  const g1 = fb.groupByConcurrency(chunks, 1);
  assert('★ 并发度 1 = 原严格串行行为（回归保护）',
    g1.length === 3 && g1.every((g) => g.length === 1));
  assert('非法并发度（0/负/非数）退化为 1，不产生空组',
    fb.groupByConcurrency(chunks, 0).length === 3 && fb.groupByConcurrency(chunks, 'x').length === 3);
  assert('所有元素都被保留（编组不丢批）',
    g2.reduce((a, g) => a + g.reduce((b, c) => b + c.length, 0), 0) === 14);
}

console.log('\n--- ④ failureHint 文案（可测 ⇒ 不必在 WXML 里拼） ---');
{
  assert('0 个失败 ⇒ 空串（不显示提示）', fb.failureHint(0) === '' && fb.failureHint(null) === '');
  const t = fb.failureHint(3);
  assert('有失败 ⇒ 含数量与"重试"字样（用户可据此行动）',
    t.indexOf('3') >= 0 && t.indexOf('重试') >= 0 && t.indexOf('失败') >= 0, t);
}

console.log('\n--- ⑤ 源码级守卫：页面**不得**再把失败伪装成空 ---');
{
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'pages', 'index', 'index.js'), 'utf8');
  // 关注流的取数处必须带 ok 标记（三态）
  assert('★ 关注流取数成功分支带 ok:true', src.indexOf('ok: true') >= 0 && src.indexOf('ok: false') >= 0);
  assert('★ 关注流必须声明失败可见化字段',
    src.indexOf('followFailedCount') >= 0 && src.indexOf('followHint') >= 0);
  // 反例守卫：关注流里不得再出现"catch 后返回 ms:[] 且不带 ok"的旧写法
  const FINGERPRINT = /\.catch\(\(\) => \(\{ t: t, ms: \[\] \}\)\)/;
  assert('★ 不得存在「catch → {t, ms:[]}」的旧写法（静默失败指纹）', !FINGERPRINT.test(src));
  assert('★ 敏感性：该指纹确实能命中旧写法（否则本守卫是永真断言）',
    FINGERPRINT.test('.catch(() => ({ t: t, ms: [] }))'));
  const wxml = fs.readFileSync(path.join(__dirname, '..', '..', 'pages', 'index', 'index.wxml'), 'utf8');
  assert('★ WXML 有失败提示 + 可点重试绑定',
    wxml.indexOf('followHint') >= 0 && wxml.indexOf('bindtap="retryFollowCards"') >= 0);
  assert('★ 提示文案取自纯函数（不在模板里拼字符串）',
    wxml.indexOf('{{followHint}}') >= 0);
}

console.log('\n--- ⑥ 守卫可证伪性（用"变异实现"证明判据随行为变化）---');
{
  const chunks = fb.chunkBySize([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14], 5);
  // 变异 A：退化为"原严格串行"（每批单独一组）
  const buggyGroup = (b) => b.map((x) => [x]);
  assert('变异A：正确实现 3 批 → 2 组；退化实现 → 3 组 ⇒「并发度 2」判据有效',
    fb.groupByConcurrency(chunks, 2).length === 2 && buggyGroup(chunks).length === 3);
  // 变异 B：用 concat 合并（会改变长度/顺序）
  const rows = [R(1, true, 2), R(2, false)];
  const buggyMerge = (src, again) => src.concat(again);
  assert('变异B：concat 合并会变长 ⇒「长度不变」判据有效',
    fb.mergeRetried(rows, [R(2, true, 0)]).length === 2 && buggyMerge(rows, [R(2, true, 0)]).length === 3);
  // 变异 C：failedOf 误把 ok===undefined 也算失败 ⇒「旧数据不误报」判据有效
  const buggyFailed = (rs) => rs.filter((r) => r && !r.ok);
  const legacy = [{ t: { id: 9 }, ms: [] }];
  assert('变异C：把 ok===undefined 当失败 ⇒ 旧数据会被误报 ⇒「不误报」判据有效',
    fb.failedOf(legacy).length === 0 && buggyFailed(legacy).length === 1);
  // 变异 D：chunk 退化（整表一批）⇒ 批数判据有效
  const buggyChunk = (list) => [list.slice()];
  assert('变异D：整表一批 ⇒ 批数由 3 变 1 ⇒ 批数判据有效',
    fb.chunkBySize([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14], 5).length === 3 &&
    buggyChunk([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]).length === 1);
}

// ============================================================================
// ★★ 2026-09-28 新增：渐进渲染的两个不变量（**输出恒按列表序** + **节流**）
//   背景：`Promise.all(首批)` 会等"最慢那条"才渲染（实测首卡 2.5~2.8s，而最快那条 ~1.1s 就到了）
//   ⇒ 改为"到达即渲染"后，**必须**守住顺序（否则用户可感知的卡片顺序会抖动）。
// ============================================================================
{
  // ---- ① arrivedRows：输出**恒按关注列表序**（与"到达先后"无关）----
  const arrived = new Array(6);
  // 模拟真实情形：第 5 个先到、第 0 个后到（实测首批内返回时刻相差 1.4~1.5s）
  arrived[5] = R(1055); arrived[2] = R(1022); arrived[0] = R(1000);
  const rowsOut = fb.arrivedRows(arrived);
  const ids = rowsOut.map((r) => r.t.id).join(',');
  assert('渐进① 输出恒按**关注列表序**（不是到达序）', ids === '1000,1022,1055', '实际 ' + ids);
  assert('渐进① 稀疏空洞被跳过（只输出已到达项）', rowsOut.length === 3, '实际 ' + rowsOut.length);

  // 属性测试：随机稀疏填充 ⇒ 输出下标必须**严格递增**（等价于"保持列表序"）
  let orderViolations = 0;
  for (let t = 0; t < 200; t++) {
    const n = 15, a = new Array(n);
    for (let i = 0; i < n; i++) if (Math.random() < 0.5) a[i] = R(2000 + i);
    const out = fb.arrivedRows(a);
    for (let i = 1; i < out.length; i++) if (out[i].t.id <= out[i - 1].t.id) orderViolations++;
  }
  assert('渐进① 属性测试 ×200：输出下标严格递增、零违例', orderViolations === 0, '违例 ' + orderViolations);

  // 变异证伪：把输出改成"逆序" ⇒ 顺序不变量必须判 false
  const revIds = fb.arrivedRows(arrived).reverse().map((r) => r.t.id).join(',');
  assert('变异E 确实改到了行为', revIds !== ids, 'revIds=' + revIds);
  assert('★ 变异E：逆序输出 ⇒ 顺序不变量判 false（守卫非永真）', revIds !== '1000,1022,1055', '反例 ' + revIds);

  // ---- ② shouldRender：节流（首次必渲 / 新增≥3 / 间隔>400ms / force）----
  assert('渐进② 首次（已渲染 0 张）必渲 ⇒ true', fb.shouldRender({ count: 0, at: 0 }, 1, 1000) === true);
  assert('渐进② 无新增（count 未变）⇒ false', fb.shouldRender({ count: 5, at: 1000 }, 5, 1100) === false);
  assert('★ 渐进② 仅新增 1 张且间隔短 ⇒ **false**（防"逐张渲染"的纯增量成本）',
    fb.shouldRender({ count: 5, at: 1000 }, 6, 1100) === false);
  assert('渐进② 新增 ≥3 ⇒ true', fb.shouldRender({ count: 5, at: 1000 }, 8, 1100) === true);
  assert('渐进② 距上次 >400ms（即使只 +1）⇒ true', fb.shouldRender({ count: 5, at: 1000 }, 6, 1500) === true);
  assert('渐进② force ⇒ 恒 true（每波/全部结束兜底）',
    fb.shouldRender({ count: 5, at: 1000 }, 5, 1000, { force: true }) === true);

  // 变异证伪：把 minGrow 破坏成"新增≥1 就渲" ⇒ 上面那条最关键的反向断言必须失效
  const buggyShould = (st, count, nowMs, o) => ((o && o.force) ? true
    : (count <= (st.count || 0) ? false
      : (st.count === 0 ? true : ((count - st.count) >= 1 || (nowMs - (st.at || 0)) > 400))));
  assert('变异F 确实改到了行为（grow=1 时由 false 变 true）',
    fb.shouldRender({ count: 5, at: 1000 }, 6, 1100) === false && buggyShould({ count: 5, at: 1000 }, 6, 1100) === true);
  assert('★ 变异F：minGrow 被破坏 ⇒ 反向断言失效（证明该守卫非永真）',
    buggyShould({ count: 5, at: 1000 }, 6, 1100) === true);
}

console.log('\n=== 结果 ===');
console.log('通过: ' + pass + '  失败: ' + fail);
if (fail) { console.log('存在失败 ❌'); process.exit(1); }
console.log('全部通过 ✅');
