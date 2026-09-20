// utils/remoteCuration.js
// curation（精选权威库）的远程覆盖层：在不发版的前提下热更新赛事/战队数据。
//
// ★ 阶段1-③ 改造（2026-07-30）：从拉取远程 URL 改为调用云函数 getCuration
//   - 旧方案：config.remoteCuration.url 拉取远程 JSON（需自建 HTTP 服务器）
//   - 新方案：通过云函数 aggregation 的 getCuration action 从云数据库读取
//   - 始终保留 curation.js 本地数据作为兜底（离线/首启/云调用失败可用）
//
// 策略（与 api.cachedFresh 一致的「本地兜底 + 远程优先」）：
//   - 同步初始化：读 Storage 缓存（若新鲜）否则用本地 curation.js 兜底
//   - 异步后台刷新：调用云函数 getCuration，带 clientVersion 增量更新
//   - 失败静默回退（本地/旧缓存），不影响业务
//
// 数据形状（与 curation.js 完全兼容）：
//   云函数返回 { events: [...], teams: { <id>: {...} }, tiContestantIds: [...], version: 'xxx' }
//   客户端构建 effectiveEvents / effectiveTeams / tiContestantSet

const curation = require('./curation.js');
const consensus = require('./consensus.js');
const cache = require('./cache.js');
const config = require('./config.js');
const cloudProxy = require('./cloudProxy.js');

const CACHE_KEY = 'remote_curation_v3';   // ★ 2026-08-11 bump v2→v3：buildEffective 改字段级合并，
                                          //   旧 v2 缓存可能已含「云端整条覆盖后的坏数据」（TI 2026 无
                                          //   leagueId/participants 数组），bump key 强制全量客户端重拉。
const VERSION_KEY = 'remote_curation_version';
// ★★ 2026-09-20：**廉价探针**的基线键（见 _probeRemoteVersion 注释）。
//   为什么要它：`load()` 的早退条件是「缓存未过期」而非「版本一致」→ curation 改动后热客户端最多滞后 6h，
//   只能靠用户清缓存（实测事故：远端已订正 PGL Wallachia S9，真机仍显示 9/17）。
const PROBE_KEY = 'remote_curation_probe_v1';

let lookups = null;          // 当前生效的查找器（null = 尚未初始化）
let effectiveEvents = null;
let effectiveTeams = null;
let effectiveTiIds = null;
let loadingPromise = null;

// 同步初始化：读缓存（若新鲜）否则用本地兜底。保证 curated* 同步可用。
function ensure() {
  if (lookups) return lookups;
  const meta = cache.getStale(CACHE_KEY, config.remoteCuration.ttlSec, config.remoteCuration.ttlSec);
  if (meta.value && meta.value.events && meta.value.teams) {
    effectiveEvents = meta.value.events;
    effectiveTeams = meta.value.teams;
    effectiveTiIds = meta.value.tiContestantIds || curation.TI_CONTESTANT_TEAM_IDS;
  } else {
    effectiveEvents = curation.CURATED_EVENTS;
    effectiveTeams = curation.CURATED_TEAMS;
    effectiveTiIds = curation.TI_CONTESTANT_TEAM_IDS;
  }
  lookups = curation.buildLookups(effectiveEvents, effectiveTeams);
  return lookups;
}

// 用远程数据覆盖本地，得到「生效集合」：
//   - events 以归一规范名为键，远程覆盖本地同键条目并追加新条目；
//   - teams 以 id 为键，远程覆盖本地同 id 并追加新 id；
//   - tiContestantIds 直接替换（远程为权威源）
//
// ★ 2026-08-11 BUG 修复：字段级合并替代整条覆盖。
//   根因：云数据库 curation_events 里 TI 2026 是旧数据（无 leagueId/legacyFakeId，
//         participants 是数字 16），原 buildEffective 用远程事件 Object.assign 整条覆盖
//         本地同 canonical 条目 → 本地新增的 leagueId=19719、participants 数组被云端旧数据
//         盖掉 → 详情页 curatedEventFor 拿不到 leagueId（不重定向，保留 fakeId -1653808）
//         + participants 数组缺失（数字兜底 → 16 个「待定队伍 N」）。
//   修复策略：
//     1) 逐字段合并：远程有值（非 null/undefined）的字段覆盖本地；远程缺失的字段保留本地。
//     2) participants 特判：本地是数组（含队名详情）而远程是数字（仅数量）时保留本地数组，
//        防止云端旧数据把「真实队名列表」退化成「数量」。（远程若也是数组则正常覆盖 = 云端热更可用）
function mergeEventFields(local, remote) {
  if (!remote) return local;
  const merged = Object.assign({}, local);
  Object.keys(remote).forEach((k) => {
    const v = remote[k];
    if (v === undefined || v === null) return;             // 远程缺失 → 保留本地
    if (k === 'participants' && Array.isArray(merged.participants) && !Array.isArray(v)) {
      return;                                              // 本地数组 > 远程数字（防退化覆盖）
    }
    merged[k] = v;
  });
  return merged;
}

function buildEffective(remote) {
  const evMap = {};
  curation.CURATED_EVENTS.forEach((e) => { if (e && e.canonical) evMap[consensus.normName(e.canonical)] = e; });
  (remote.events || []).forEach((e) => {
    if (!e || !e.canonical) return;
    const key = consensus.normName(e.canonical);
    evMap[key] = evMap[key] ? mergeEventFields(evMap[key], e) : e;  // 同键字段级合并；新键直接采用
  });
  const events = Object.keys(evMap).map((k) => evMap[k]);

  const tmMap = {};
  Object.keys(curation.CURATED_TEAMS).forEach((id) => { tmMap[Number(id)] = curation.CURATED_TEAMS[id]; });
  Object.keys(remote.teams || {}).forEach((id) => { tmMap[Number(id)] = remote.teams[id]; });

  const tiIds = remote.tiContestantIds || curation.TI_CONTESTANT_TEAM_IDS;

  return { events: events, teams: tmMap, tiContestantIds: tiIds };
}

function curatedEventFor(name, ctx) { return ensure().eventFor(name, ctx); }
function curatedTeamFor(nameOrId) { return ensure().teamFor(nameOrId); }

// 判断 team_id 是否为历届 TI 参赛队
// 优先用远程覆盖后的 effectiveTiIds，回退本地静态名单
function isTIContestantTeam(teamId) {
  ensure();
  if (effectiveTiIds && effectiveTiIds.indexOf(Number(teamId)) >= 0) return true;
  return curation.isTIContestantTeam(teamId);
}

// 判断 team_id/队名 是否为高优先级战队（S-Tier 或 TI 参赛队）。
function isHighPriorityTeam(nameOrId) {
  if (nameOrId == null) return false;
  if (isTIContestantTeam(nameOrId)) return true;
  const t = ensure().teamFor(nameOrId);
  if (t && t.tier && (t.tier.grade === 'SSS' || t.tier.grade === 'S')) return true;
  return false;
}

// 返回当前生效的事件数组
function getEffectiveEvents() {
  ensure();
  return effectiveEvents || curation.CURATED_EVENTS || [];
}

// 拉取云端 curation（异步、幂等、失败静默回退）。
//   - 云函数不可用 → 仅用本地，返回 false；
//   - 缓存新鲜且非强制 → 直接读缓存，返回 false；
//   - 否则调用云函数 getCuration，成功则覆盖并缓存，失败则回退（本地/旧缓存）。
//
// 增量更新：客户端传 clientVersion，若与云端一致 → 云函数返回 { unchanged: true }，
//   零数据传输，仅刷新缓存时间戳。
// ★★ 2026-09-20（版本号改「内容指纹」）：原实现 `version: 'sb:' + events.length` **只取条数** ——
//   「只改字段值」（如后台订正某赛事赛期 start/end、改状态/分级）**不改变条数** → 版本号不变 →
//   客户端判定「版本一致，跳过数据传输」→ 陈旧缓存要等 6h TTL 才刷新。
//   实测教训：本地与远端均已订正 PGL Wallachia Season 9 起始日为 9/19，真机仍显示 9/17。
//   现改为：`条数 + 最大 updatedAt + 关键字段滚动哈希`。
//   · 哈希覆盖 canonical/start/end/status/grade —— 捕捉最常见的后台订正，且**不依赖 updatedAt**
//     （直改数据库、或未走 admin-write 的存量行没有 updatedAt 也能被发现）；
//   · 逐条哈希后 **XOR 累积**（而非拼接排序）→ 与返回顺序无关，且 O(n) 无排序开销。
function _hash32(str) {
  var h = 2166136261;                       // FNV-1a 32-bit
  for (var i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;       // 必须用 Math.imul：直接相乘会超 2^53 丢精度
  }
  return h >>> 0;
}
// @param {Array} events 远端事件数组
// @param {string} prefix 版本号前缀 —— 全量用 'sb:'、近期子集用 'sb-recent:'（保持原有前缀语义，
//        避免与云函数返回的 version 串前缀混淆导致误判「版本一致」）
function _contentFingerprint(events, prefix) {
  var maxUpd = 0;
  var acc = 0;
  for (var i = 0; i < events.length; i++) {
    var e = events[i] || {};
    var t = Number(e.updatedAt) || 0;
    if (t > maxUpd) maxUpd = t;
    var g = (e.tier && e.tier.grade) || e.grade || '';
    acc = (acc ^ _hash32(String(e.canonical || '') + '|' + (e.start || 0) + '|' +
      (e.end || 0) + '|' + (e.status || '') + '|' + g)) >>> 0;
  }
  return (prefix || 'sb:') + events.length + ':' + maxUpd + ':' + acc.toString(36);
}

/**
 * ★ 阶段2-③A（2026-09-13）：Supabase 直读 curation（等价替换云函数 getCuration）
 *
 * 数据源三表（由 scripts/ops/backfill-curation.js 灌入）：
 *   curation_events( canonical_key, league_id, data ) → events = rows.map(r => r.data)
 *   curation_teams ( team_id, data )                  → teams = { [team_id]: data }
 *   curation_meta  ( key, value )                     → tiContestantIds = value.ids
 *
 * ⚠️ 必须分页：PostgREST 单次有 max-rows 上限（默认 1000），超限静默截断 ——
 *    与云开发 .limit(500) 是同一类坑。此处每页 1000，用 Range 头翻页。
 *
 * 返回 { events, teams, tiContestantIds, version }；任何失败返回 null（调用方回落云函数）。
 */
function _sbLoadCuration() {
  var sb = require('./supabaseClient.js');
  if (!sb || !sb.enabled()) return Promise.resolve(null);

  var PAGE = 400;
  function fetchPage(offset, acc) {
    return sb.rest('curation_events', { select: 'canonical_key,league_id,data', range: offset + '-' + (offset + PAGE - 1) })
      .then(function (rows) {
        var list = rows || [];
        list.forEach(function (r) { if (r && r.data) acc.push(r.data); });
        if (list.length < PAGE) return acc;
        if (offset > 20000) return acc;
        return fetchPage(offset + PAGE, acc);
      });
  }

  return fetchPage(0, [])
    .then(function (events) {
      if (!events.length) return null;
      return sb.rest('curation_teams', { select: 'team_id,data', limit: 1000 }).then(function (teamRows) {
        var teams = {};
        (teamRows || []).forEach(function (r) { if (r && r.team_id != null && r.data) teams[Number(r.team_id)] = r.data; });
        return sb.rest('curation_meta', { select: 'key,value', eq: { key: 'ti_contestant_ids' }, limit: 1 }).then(function (metaRows) {
          var row = metaRows && metaRows[0];
          var tiIds = (row && row.value && row.value.ids) || [];
          return { events: events, teams: teams, tiContestantIds: tiIds, version: _contentFingerprint(events) };
        });
      });
    })
    .catch(function (e) {
      console.warn('[remoteCuration] Supabase 直读失败，将回落云函数:', e && e.message);
      return null;
    });
}

/** 应用远端 curation（SB 与云函数两条路共用） */
/**
 * 应用远端 curation（SB 与云函数两条路共用）
 * @param {object} data  {events, teams, tiContestantIds, version}
 * @param {boolean} [partial] 仅近期子集时为 true → 用短 TTL 缓存
 *   ★ 2026-09-15：实测踩过 —— 首屏只拉到近期子集、后台补全量又 timeout 时，
 *   6h 长 TTL 会把客户端卡在「只有 179 条」的状态；短 TTL 让下次启动重新尝试全量。
 */
function _applyRemote(data, partial) {
  try {
    var eff = buildEffective(data);
    effectiveEvents = eff.events;
    effectiveTeams = eff.teams;
    effectiveTiIds = eff.tiContestantIds;
    lookups = curation.buildLookups(eff.events, eff.teams);
    var _ttl = partial ? 1800 : config.remoteCuration.ttlSec;   // partial: 30min；完整: 6h
    if (partial) console.log('[remoteCuration] 仅近期子集 → 缓存 30min（下次启动重试全量）');
    cache.set(CACHE_KEY, { events: eff.events, teams: eff.teams, tiContestantIds: eff.tiContestantIds }, _ttl);
    cache.set(VERSION_KEY, data.version, 365 * 24 * 3600);
    console.log('[remoteCuration] curation 加载成功, version:', data.version,
      'events:', eff.events.length, 'teams:', Object.keys(eff.teams).length);
    return true;
  } catch (e) {
    console.error('[remoteCuration] buildEffective 或缓存写入抛错:', e && e.message);
    return false;
  }
}

/**
 * ★ 阶段2-③B（2026-09-13）：**首屏只拉近期子集**（year >= 2025）。
 *
 * 动机：全量 2414 条约 690KB，是「每日首开慢」的主因。
 * 做法：先用单条件过滤（PostgREST 的 gte 操作符，避免 or= 与 json 箭头的兼容风险）
 *   取近期赛事 → 首页秒开；全量由 _scheduleFullLoad 在后台补。
 * 数据依据：实测 year>=2025 共 83 条（2026:27 + 2025:56），约全量的 3%。
 *
 * 任何失败返回 null（调用方回落全量 / 云函数）。
 */
function _sbLoadCurationRecent() {
  var sb = require('./supabaseClient.js');
  if (!sb || !sb.enabled()) return Promise.resolve(null);
  return sb.rest('curation_events', {
    select: 'canonical_key,league_id,data',
    eq: { 'data->>year': 'gte.2025' },
    limit: 1000
  }).then(function (rows) {
    var events = [];
    (rows || []).forEach(function (r) { if (r && r.data) events.push(r.data); });
    if (!events.length) return null;
    return sb.rest('curation_teams', { select: 'team_id,data', limit: 1000 }).then(function (teamRows) {
      var teams = {};
      (teamRows || []).forEach(function (r) { if (r && r.team_id != null && r.data) teams[Number(r.team_id)] = r.data; });
      return sb.rest('curation_meta', { select: 'key,value', eq: { key: 'ti_contestant_ids' }, limit: 1 }).then(function (metaRows) {
        var row = metaRows && metaRows[0];
        var tiIds = (row && row.value && row.value.ids) || [];
        return { events: events, teams: teams, tiContestantIds: tiIds, version: _contentFingerprint(events, 'sb-recent:') };
      });
    });
  }).catch(function (e) {
    console.warn('[remoteCuration] SB 近期子集读取失败:', e && e.message);
    return null;
  });
}

/** 后台补拉全量（不阻塞首屏；每会话仅一次） */
var _bgFullDone = false;
function _scheduleFullLoad() {
  if (_bgFullDone) return;
  _bgFullDone = true;
  setTimeout(function () {
    console.log('[remoteCuration] 后台补全量开始（分页拉全量）...');
    _sbLoadCuration().then(function (full) {
      if (!full || !full.events || !full.events.length) return;
      if (_applyRemote(full)) {
        console.log('[remoteCuration] 后台已补全量, events:', full.events.length);
      }
    }).catch(function (e) { console.warn('[remoteCuration] 后台补全量失败:', e && e.message); });
  }, 3000);
}

/**
 * ★★ 2026-09-20：**廉价版本探针** —— 在「缓存命中」的早退分支前先问一句「远端变了吗」。
 *
 * ## 为什么需要
 * `load()` 原先的早退条件是 `!force && meta.value`（**只看缓存是否过期，不看版本号**），
 * 且 `VERSION_KEY` 只在云函数兜底路径参与比对 → curation 改动后**热客户端最多滞后 6h**，
 * 只能让用户清缓存（实测事故：远端已订正 PGL Wallachia S9 起始日为 9/19，真机仍显示 9/17）。
 *
 * ## 探针设计（单行读，~200B）
 *   ① 优先 `curation_meta.key='version'`：由 admin-write EF 每次写库 bump，
 *      覆盖 upsertEvent / deleteEvent / upsertTeam / updateMeta **全部**变更类型。
 *      （EF 未部署该 bump 时此行不存在 → 自动走 ②，**无需先改 EF 即可生效**。）
 *   ② 回退 `curation_events` 的最大 `data->>updatedAt`：admin-write 每次 upsert 都会写 `data.updatedAt`，
 *      故覆盖**所有 upsert**（curation 编辑的绝大多数）；⚠️ 覆盖不到删除/队伍/元数据（那些靠 ① 或 TTL）。
 *   ③ 任何失败 → 返回 ''（**保守沿用缓存，绝不因探针失败而阻塞启动**）。
 *
 * 返回 { probe, source }；probe 为空串表示"无信号"。
 */
function _probeRemoteVersion() {
  var sb = null;
  try { sb = require('./supabaseClient.js'); } catch (e) { return Promise.resolve({ probe: '', source: 'no-sb' }); }
  if (!sb || !sb.enabled()) return Promise.resolve({ probe: '', source: 'disabled' });

  // ★ 两条探针**并行**（实测各自 ~400ms 稳态，串行会累加）：
  //   ① meta（EF 部署后覆盖全部变更类型）  ② events-max updatedAt（覆盖所有 upsert）
  var metaP = sb.rest('curation_meta', { select: 'key,value', eq: { key: 'version' }, limit: 1 })
    .then(function (rows) {
      var v = rows && rows[0] && rows[0].value && rows[0].value.v;
      return v != null ? { probe: 'meta:' + v, source: 'meta' } : null;
    }).catch(function () { return null; });

  var evP = sb.rest('curation_events', {
    select: 'data->>updatedAt',
    order: 'data->>updatedAt.desc.nullslast',
    limit: 1
  }).then(function (rows) {
    var u = rows && rows[0] && rows[0].updatedAt;
    return u != null ? { probe: 'ev:' + u, source: 'events-max-updatedAt' } : null;
  }).catch(function () { return null; });

  // 整体 5s 上限：探针是"尽力而为"，绝不允许长时间挂着（sb.rest 底层超时是 25s）
  var timer = null;
  var timeout = new Promise(function (resolve) {
    timer = setTimeout(function () { resolve({ probe: '', source: 'timeout' }); }, 5000);
  });
  return Promise.race([
    Promise.all([metaP, evP]).then(function (r) { return r[0] || r[1] || { probe: '', source: 'none' }; }),
    timeout
  ]).then(function (out) { if (timer) clearTimeout(timer); return out; },
    function () { if (timer) clearTimeout(timer); return { probe: '', source: 'fail' }; });
}

/** 纯函数：是否需要重新拉取（可单测）。★ 保守优先 —— 无信号一律不重载。 */
function _probeNeedsReload(remoteProbe, storedProbe) {
  if (!remoteProbe) return false;     // 探针无信号（失败/表空）→ 沿用缓存
  if (!storedProbe) return false;     // 首次建立基线 → 不重载，仅落盘基线
  return String(remoteProbe) !== String(storedProbe);
}

/** 纯函数：是否应跳过本次探针（节流）。★ 目的是限制成本 —— 探针约 400ms/次。 */
function _probeThrottled(lastProbeAt, nowMs, minIntervalSec) {
  if (!lastProbeAt) return false;     // 从未探针过 → 必须探
  return (nowMs - lastProbeAt) < minIntervalSec * 1000;
}

// 探针节流窗口：同一设备 10min 内最多探一次（冷启动通常远低于此频率，
// 既让 curation 改动 ≤10min 生效，又避免频繁重启反复付探针成本）。
const PROBE_MIN_INTERVAL_SEC = 10 * 60;

function load(force) {
  // ★ 阶段2-③A：SB 可用时也允许进入（不再依赖云开发可用性）
  var _sbOn = false;
  try { _sbOn = require('./supabaseClient.js').enabled(); } catch (e) {}
  if (!_sbOn && !(cloudProxy.isAvailable() || cloudProxy.efAvailable())) { ensure(); return Promise.resolve(false); }
  const meta = cache.getStale(CACHE_KEY, config.remoteCuration.ttlSec, config.remoteCuration.ttlSec);
  // ★ 2026-09-15：此前此处静默早退，用户两次把「没有日志」误读为「代码没跑」→ 补日志
  if (!force && meta.value) {
    // ★★ 2026-09-20：早退前先做**廉价探针**（单行读 ~400ms）——远端变了就不再早退。
    //   实测收益：curation 改动**一次启动内生效**（原需清缓存或等 6h TTL）。
    //   成本控制：① 两条探针并行（不串行累加）；② 整体 5s 上限；③ 10min 节流。
    const probeInfo = cache.peek(PROBE_KEY);
    const lastProbeAt = probeInfo && probeInfo.fetchedAt || 0;
    if (_probeThrottled(lastProbeAt, Date.now(), PROBE_MIN_INTERVAL_SEC)) {
      console.log('[remoteCuration] 缓存命中且 ' + (PROBE_MIN_INTERVAL_SEC / 60) + 'min 内已探针过，跳过');
      ensure(); return Promise.resolve(false);
    }
    const storedProbe = (probeInfo && probeInfo.value) || '';
    return _probeRemoteVersion().then(function (res) {
      const remoteProbe = res && res.probe || '';
      // 有信号 → 刷新基线；**无信号（失败/超时）→ 保留原基线、只刷新探针时间**。
      // ⚠️ 后者不能用 cache.touch：实测 `touch` 在键不存在时**直接早退**，无法建立节流标记，
      //   会导致「离线设备每次冷启动都白等探针超时（最长 5s）」。
      cache.set(PROBE_KEY, remoteProbe || storedProbe, 365 * 24 * 3600);
      if (!_probeNeedsReload(remoteProbe, storedProbe)) {
        console.log('[remoteCuration] 缓存命中且远端未变（探针 ' + (res && res.source) + '），跳过拉取');
        ensure(); return false;
      }
      console.log('★ [remoteCuration] 探针发现远端 curation 已更新（' + storedProbe + ' → ' + remoteProbe +
        '，来源 ' + (res && res.source) + '）→ 重新拉取，不等 6h TTL');
      return _doLoad(_sbOn, false, meta);
    }).catch(function () {
      console.log('[remoteCuration] 探针异常 → 沿用缓存');
      ensure(); return false;
    });
  }
  if (loadingPromise) return loadingPromise;
  return _doLoad(_sbOn, force, meta);
}

/** 实际拉取（SB 直读优先 → 云函数兜底）。从 load() 拆出，供探针判定后复用。 */
function _doLoad(_sbOn, force, meta) {
  if (loadingPromise) return loadingPromise;
  // 读取本地存储的 version（用于增量更新）
  const clientVersion = cache.getStale(VERSION_KEY, 365 * 24 * 3600, 365 * 24 * 3600).value || '';

  // ★ 阶段2-③A：**Supabase 直读优先**；未命中/失败 → 回落云函数（行为不变）
  if (_sbOn) {
    loadingPromise = _sbLoadCurationRecent().then(function (recent) {
      // ① 首屏：近期子集（快）
      if (recent && recent.events && recent.events.length) {
        console.log('[remoteCuration] 首屏走 Supabase 直读·近期子集, events:', recent.events.length);
        if (_applyRemote(recent, true)) { _scheduleFullLoad(); return true; }   // true = partial（短 TTL，下次启动重试全量）
      }
      // ② 近期失败 → 全量直读
      return _sbLoadCuration().then(function (sbData) {
        if (sbData && sbData.events && sbData.events.length) {
          console.log('[remoteCuration] 走 Supabase 直读·全量, events:', sbData.events.length);
          if (_applyRemote(sbData)) return true;
        }
        // ③ 都失败 → 云函数兜底
        return _cloudLoad(force, clientVersion, meta);
      });
    }).then(function (r) { loadingPromise = null; return r; });
    return loadingPromise;
  }

  // 云函数路径（SB 不可用时）
  return _cloudLoad(force, clientVersion, meta);
}

/** 云函数路径（原实现，拆分出来供回落/无 SB 时调用） */
function _cloudLoad(force, clientVersion, meta) {
  return new Promise((resolve) => {
    wx.cloud.callFunction({
      name: 'aggregation',
      data: { action: 'getCuration', params: { clientVersion: clientVersion }, force: !!force }
    }).then((res) => {
      const r = res && res.result;
      console.log('[remoteCuration] 云函数返回, source:', r && r.source,
        'unchanged:', r && r.unchanged, 'version:', r && r.version,
        'hasData:', !!(r && r.data), 'hasError:', !!(r && r.error));
      if (r && r.error) {
        console.warn('[remoteCuration] 云函数返回错误:', r.error);
        ensure(); resolve(false); return;
      }
      // 版本一致：仅刷新缓存时间戳，不重新构建 lookups
      if (r && r.unchanged) {
        console.log('[remoteCuration] 版本一致 (' + r.version + ')，跳过数据传输');
        // 刷新缓存时间戳（meta.value 保持不变）
        if (meta.value) cache.set(CACHE_KEY, meta.value, config.remoteCuration.ttlSec);
        resolve(true); return;
      }
      // 版本不一致或首次拉取：构建生效集合
      if (r && r.data && r.data.events && r.data.teams) {
        try {
          const eff = buildEffective(r.data);
          effectiveEvents = eff.events;
          effectiveTeams = eff.teams;
          effectiveTiIds = eff.tiContestantIds;
          lookups = curation.buildLookups(eff.events, eff.teams);
          cache.set(CACHE_KEY, { events: eff.events, teams: eff.teams, tiContestantIds: eff.tiContestantIds }, config.remoteCuration.ttlSec);
          cache.set(VERSION_KEY, r.version, 365 * 24 * 3600);
          console.log('[remoteCuration] 云端 curation 加载成功, version:', r.version,
            'events:', eff.events.length, 'teams:', Object.keys(eff.teams).length);
          resolve(true);
        } catch (e) {
          console.error('[remoteCuration] buildEffective 或缓存写入抛错:', e && e.message, e);
          ensure(); resolve(false);
        }
        return;
      }
      // 数据不合法，回退到本地/旧缓存
      console.warn('[remoteCuration] 云函数返回数据不合法, r:', r ? Object.keys(r) : 'null');
      ensure(); resolve(false);
    }).catch((err) => {
      console.warn('[remoteCuration] 云函数调用失败:', err && err.errMsg);
      ensure(); resolve(false);
    });
  }).then(function (r) { loadingPromise = null; return r; });
}

module.exports = {
  curatedEventFor: curatedEventFor,
  curatedTeamFor: curatedTeamFor,
  isTIContestantTeam: isTIContestantTeam,
  isHighPriorityTeam: isHighPriorityTeam,
  getEffectiveEvents: getEffectiveEvents,
  buildEffective: buildEffective,
  load: load,
  // ★ 2026-09-20：内容指纹（版本号）—— 导出供单测锁住「改字段值也必须变版本」这一契约。
  //   下划线前缀表示内部实现细节，业务代码勿直接调用。
  _contentFingerprint: _contentFingerprint,
  // ★ 2026-09-20：廉价探针的「是否需重载」判定（纯函数，导出供单测）
  _probeNeedsReload: _probeNeedsReload,
  _probeThrottled: _probeThrottled,
  _probeRemoteVersion: _probeRemoteVersion
};
