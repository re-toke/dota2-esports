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

  var PAGE = 1000;
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
          return { events: events, teams: teams, tiContestantIds: tiIds, version: 'sb:' + events.length };
        });
      });
    })
    .catch(function (e) {
      console.warn('[remoteCuration] Supabase 直读失败，将回落云函数:', e && e.message);
      return null;
    });
}

/** 应用远端 curation（SB 与云函数两条路共用） */
function _applyRemote(data) {
  try {
    var eff = buildEffective(data);
    effectiveEvents = eff.events;
    effectiveTeams = eff.teams;
    effectiveTiIds = eff.tiContestantIds;
    lookups = curation.buildLookups(eff.events, eff.teams);
    cache.set(CACHE_KEY, { events: eff.events, teams: eff.teams, tiContestantIds: eff.tiContestantIds }, config.remoteCuration.ttlSec);
    cache.set(VERSION_KEY, data.version, 365 * 24 * 3600);
    console.log('[remoteCuration] curation 加载成功, version:', data.version,
      'events:', eff.events.length, 'teams:', Object.keys(eff.teams).length);
    return true;
  } catch (e) {
    console.error('[remoteCuration] buildEffective 或缓存写入抛错:', e && e.message);
    return false;
  }
}

function load(force) {
  // ★ 阶段2-③A：SB 可用时也允许进入（不再依赖云开发可用性）
  var _sbOn = false;
  try { _sbOn = require('./supabaseClient.js').enabled(); } catch (e) {}
  console.log('[remoteCuration] 诊断 v8.69: _sbOn=' + _sbOn);   // 临时：确认后可删
  if (!_sbOn && !(cloudProxy.isAvailable() || cloudProxy.efAvailable())) { ensure(); return Promise.resolve(false); }
  const meta = cache.getStale(CACHE_KEY, config.remoteCuration.ttlSec, config.remoteCuration.ttlSec);
  if (!force && meta.value) { ensure(); return Promise.resolve(false); }
  if (loadingPromise) return loadingPromise;

  // 读取本地存储的 version（用于增量更新）
  const clientVersion = cache.getStale(VERSION_KEY, 365 * 24 * 3600, 365 * 24 * 3600).value || '';

  // ★ 阶段2-③A：**Supabase 直读优先**；未命中/失败 → 回落云函数（行为不变）
  if (_sbOn) {
    loadingPromise = _sbLoadCuration().then(function (sbData) {
      if (sbData && sbData.events && sbData.events.length) {
        console.log('[remoteCuration] 走 Supabase 直读（零云开发）, events:', sbData.events.length);
        if (_applyRemote(sbData)) return true;
      }
      return _cloudLoad(force, clientVersion, meta);
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
  load: load
};
