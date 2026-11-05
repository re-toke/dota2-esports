'use strict';
/**
 * Liquipedia 同步范围的**单一推导实现**。
 *
 * 调用方：
 *   1) `infra/proxy/lp-sync.mjs`（Deno worker）——构建时通过 `<BUILD:SCOPE>` 标记内联；
 *   2) `scripts/test/test-lp-scope.js`——node 单测。
 *
 * 输入两侧来源：
 *   - `baked`：构建期烘焙的本地常量（slugmap ∪ 本地 curation.js），见 build-lp-sync.cjs；
 *   - `events`：Supabase `curation_events` 里的事件（admin 新增/编辑即时生效）。
 *
 * 输出四组口径（刻意分开，不要合并成一组）：
 *   - `fullPages`：`full=1` 抓取的页面。**只取烘焙**——远端并入会让 full 请求数膨胀，
 *     2.2s/批的 ToS 间隔下会顶到定时器超时。
 *   - `rcSlugs`：增量差集过滤口径。烘焙 ∪ 远端全部 slug，只做集合匹配、不产生额外 LP 请求，
 *     所以可以放心并入（新赛事从下一轮增量起就能被捕获）。
 *   - `hot`：`hot=1` 轮询口径。烘焙 ∪ 远端「时间窗口内」的赛事，上限受 `maxHotEvents` 约束。
 *   - `brackets`：`brackets=1` 口径。烘焙优先，远端只补窗口内且确实带 bracket/主页面 slug 的赛事，
 *     远端新增量受 `maxBracketEvents - 烘焙条数` 约束。
 *
 * 任何形如空值、`|`（MediaWiki 多标题分隔符）、超长、控制字符的 slug 一律丢弃，计入 `dropped`。
 */

const MAX_SLUG_LEN = 160;
const BAD_CHAR_RE = /[|\u0000-\u001f]/;

const DEFAULTS = {
  maxSlugs: 5000,           // rcSlugs 上限：仅作防御（远端全量约 2-4k，正常不会触发）
  maxUrgentSlugs: 120,      // 待补抓队列上限（只收「进行中 / 4 个月内开赛」的页面）
  maxHotEvents: 8,          // 热点赛事上限（含烘焙）
  maxBracketEvents: 5,      // 淘汰赛赛事上限（含烘焙）
  hotLeadSec: 2 * 86400,    // 开赛前 2 天进入热点窗口
  hotTailSec: 86400,        // 结束后 1 天内仍在窗口
  urgentDays: 120           // 「近期」窗口：用于新赛事页面的首次补抓
};

/** slug 归一：MediaWiki 标题中空格与下划线等价，但缓存键 `lp:w:<title>` 区分两者 */
function normSlug(v) {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  if (!s || s.length > MAX_SLUG_LEN || BAD_CHAR_RE.test(s)) return '';
  // 连续空白/下划线折叠成单个下划线（与 MediaWiki 的标题归一一致）
  return s.replace(/[\s]+/g, '_').replace(/_+/g, '_');
}

function uniqSlugs(list) {
  const seen = new Set();
  const out = [];
  (list || []).forEach((v) => {
    const s = normSlug(v);
    if (!s || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  });
  return out;
}

const SLUG_FIELDS = ['scheduledMatchesSlug', 'structureSlug', 'bracketSlug', 'liquipediaSlug'];

function eventSlugs(ev) {
  const arr = [];
  if (!ev) return arr;
  SLUG_FIELDS.forEach((f) => { if (ev[f]) arr.push(ev[f]); });
  return arr;
}

/** 与 build-lp-sync.cjs 的 BRACKET_EVENTS 候选顺序保持一致 */
function bracketCandidates(ev) {
  const base = normSlug(ev && ev.liquipediaSlug);
  return uniqSlugs([
    ev && ev.bracketSlug,
    ev && ev.structureSlug,
    ev && ev.scheduledMatchesSlug,
    base ? base + '/Main Event' : '',
    base ? base + '/Playoffs' : '',
    base
  ]);
}

function num(v) {
  const n = Number(v);
  return isFinite(n) && n > 0 ? n : 0;
}

function eventKey(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function deriveScope(input) {
  const baked = (input && input.baked) || {};
  const events = (input && input.events) || [];
  const nowSec = num(input && input.nowSec) || Math.floor(Date.now() / 1000);
  const limits = Object.assign({}, DEFAULTS, (input && input.limits) || {});

  let dropped = 0;
  const drop = (n) => { dropped += (n || 0); };

  // ① 全量抓取口径：仅烘焙（宁可让远端新页面走 bootstrap，也不放大 full 的请求数）
  const fullPages = uniqSlugs(baked.slugs);

  // ② 增量差集口径：烘焙 ∪ 远端四个 slug 字段
  //    排序刻意分层：烘焙 → 「近期/在赛」事件 → 其余按开赛时间倒序，
  //    保证 maxSlugs 截断时丢的是最老的历史页面，绝不会丢掉新赛事
  //    （curation_events 没有 updated_at，按主键顺序截断会随机丢赛事，这是 v5 的实测问题）。
  const urgentCutoff = nowSec + limits.urgentDays * 86400;
  const isUrgent = (ev) => {
    const s = num(ev.start);
    const e = num(ev.end);
    if (!s || !e) return false;
    return nowSec <= e + limits.hotTailSec && s <= urgentCutoff;
  };
  const urgentEvents = events.filter(isUrgent);
  const restEvents = events.filter((ev) => !isUrgent(ev))
    .slice().sort((a, b) => num(b.start) - num(a.start));

  const rcRaw = [];
  (baked.slugs || []).forEach((s) => rcRaw.push(s));
  urgentEvents.forEach((ev) => eventSlugs(ev).forEach((s) => rcRaw.push(s)));
  restEvents.forEach((ev) => eventSlugs(ev).forEach((s) => rcRaw.push(s)));
  let rcSlugs = uniqSlugs(rcRaw);
  if (rcSlugs.length > limits.maxSlugs) {
    drop(rcSlugs.length - limits.maxSlugs);
    rcSlugs = rcSlugs.slice(0, limits.maxSlugs);
  }

  // 待补抓队列候选：只取「进行中 / 4 个月内开赛」的事件页面。
  // 历史页面不进队列——它们由 full=1 或详情页按需回源覆盖，避免为历史页面烧掉几小时的 LP 预算。
  const urgentRaw = [];
  urgentEvents.forEach((ev) => eventSlugs(ev).forEach((s) => urgentRaw.push(s)));
  let urgentSlugs = uniqSlugs(urgentRaw);
  if (urgentSlugs.length > limits.maxUrgentSlugs) {
    drop(urgentSlugs.length - limits.maxUrgentSlugs);
    urgentSlugs = urgentSlugs.slice(0, limits.maxUrgentSlugs);
  }

  // ③ 热点：烘焙（不按其窗口裁剪，窗口在 runHot 里按时间过滤）∪ 远端窗口内赛事
  const hot = [];
  const hotKeys = new Set();
  (baked.hot || []).forEach((ev) => {
    if (!ev) return;
    const slugs = uniqSlugs(ev.slugs);
    if (!slugs.length) return;
    const key = eventKey(ev.n);
    if (hotKeys.has(key)) return;
    hotKeys.add(key);
    hot.push({ n: String(ev.n || ''), s: num(ev.s), e: num(ev.e), slugs });
  });
  const hotRoom = Math.max(0, limits.maxHotEvents - hot.length);
  let hotAdded = 0;
  for (const ev of events) {
    if (hotAdded >= hotRoom) break;
    const s = num(ev.start);
    const e = num(ev.end);
    if (!s || !e) continue;
    if (s - limits.hotLeadSec > nowSec || nowSec > e + limits.hotTailSec) continue;
    const key = eventKey(ev.canonical);
    if (!key || hotKeys.has(key)) continue;
    const slugs = uniqSlugs(eventSlugs(ev));
    if (!slugs.length) continue;
    hotKeys.add(key);
    hot.push({ n: String(ev.canonical || ''), s, e, slugs });
    hotAdded += 1;
  }

  // ④ 淘汰赛：烘焙优先，远端只补窗口内的（候选页顺序与构建脚本一致）
  const brackets = [];
  const brKeys = new Set();
  (baked.brackets || []).forEach((ev) => {
    if (!ev) return;
    const slugs = uniqSlugs(ev.slugs);
    if (!slugs.length) return;
    const key = eventKey(ev.n);
    if (brKeys.has(key)) return;
    brKeys.add(key);
    brackets.push({ n: String(ev.n || ''), id: ev.id == null ? null : ev.id, slugs });
  });
  const brRoom = Math.max(0, limits.maxBracketEvents - brackets.length);
  let brAdded = 0;
  for (const ev of events) {
    if (brAdded >= brRoom) break;
    const s = num(ev.start);
    const e = num(ev.end);
    if (!s || !e) continue;
    if (s - limits.hotLeadSec > nowSec || nowSec > e + limits.hotTailSec) continue;
    if (!ev.bracketSlug && !ev.liquipediaSlug) continue;
    const key = eventKey(ev.canonical);
    if (!key || brKeys.has(key)) continue;
    const slugs = bracketCandidates(ev);
    if (!slugs.length) continue;
    brKeys.add(key);
    brackets.push({ n: String(ev.canonical || ''), id: ev.leagueId == null ? null : ev.leagueId, slugs });
    brAdded += 1;
  }

  return { rcSlugs, urgentSlugs, fullPages, hot, brackets, dropped };
}

module.exports = { deriveScope, normSlug, uniqSlugs, bracketCandidates, DEFAULTS, MAX_SLUG_LEN };
