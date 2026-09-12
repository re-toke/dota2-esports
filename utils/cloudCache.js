// utils/cloudCache.js
// #23 自建轻量数据缓存层（客户端封装）。
// 把云端 aggregation 云函数的「落库缓存」能力封装为易用接口：
//   - getCached / setCached ：任意计算结果的跨设备、跨会话缓存（个性化画像 / 预聚合数据）
//   - getSearchIndex / buildSearchIndex ：联赛搜索索引（有限集，降 OpenDota /search 限流）
// 设计要点：
//   1) 优先走云函数（cloudProxy）；云不可用 / 调用失败时静默回退到本地 cache.js，不影响主流程。
//   2) 写入采用「云端 + 本地」双写，读取优先云端、云端 miss 用本地兜底，保证弱网/离线可用。
//   3) 全部经 cloudProxy 的熔断逻辑，云异常不会打挂客户端。

const cloudProxy = require('./cloudProxy.js');
const cache = require('./cache.js');
// O-15（2026-08-15）：本地存储 key 复用 api._v() 版本前缀（curation/代码变更后旧画像自动失效），
//   与 api.js 缓存失效语义一致；禁止复制粘贴版本计算逻辑（防 key 形态漂移）。
//   ⚠️ 云端调用 key 保持裸形态（如 follow_profile_<openid>）——云函数 getCached/setCached
//   的 O-26 鉴权按 follow_profile_ 前缀白名单校验，加 _v() 前缀会被 forbidden 拦截！
const api = require('./api.js');

const LOCAL_TTL = 6 * 3600;        // 本地兜底缓存时长（秒）
const INDEX_LOCAL_KEY = 'search_index';
const TEAMS_HOT_LOCAL_KEY = 'teams_hot';
const TEAMS_INDEX_LOCAL_KEY = 'teams_search';

// 本地存储 key：加版本前缀（云端 key 保持裸，见文件头注释）
function localKey(key) {
  return api._v() + key;
}

// ===== 方案 C+：follow_profile_ 前缀走 Supabase follow-profile EF（2026-09-09）=====
// O-26 白名单里 follow_profile_ 是唯一的个人画像 key；Supabase 启用时该前缀
// 切换到 follow-profile EF（JWT 鉴权，openid 从签发凭证信任），其余 key 仍走云开发。
// 失败自动回退云开发原路径（灰度保命）。

function _sbFollowEnabled() {
  try {
    var c = require('./config.js').supabase || {};
    return !!(c.enabled && c.url && c.anonKey);
  } catch (e) { return false; }
}

/** follow_profile 读：EF {profile} 形态 → 适配成 getCached 的值语义 */
function _sbFollowGet(key) {
  var auth = require('./auth.js');
  var sb = require('./supabaseClient.js');
  var jwt = auth.getJwtSync();
  if (!jwt) return Promise.resolve(null);   // 无 JWT → 让上层回退本地/云开发
  return sb.edge('follow-profile', { op: 'get' }, { jwt: jwt })
    .then(function (r) {
      var v = (r && r.profile) || null;
      if (v) {
        try { cache.set(localKey(key), v, LOCAL_TTL); } catch (e) {}
      }
      return v;
    });
}

/** follow_profile 写：EF save；失败抛错由调用方回退云开发 */
function _sbFollowSet(key, value, ttlSec) {
  var auth = require('./auth.js');
  var sb = require('./supabaseClient.js');
  var jwt = auth.getJwtSync();
  if (!jwt) return Promise.reject(new Error('no_jwt'));
  // 注意：Supabase 侧统一 30 天过期（EF 内定死），客户端 ttlSec 参数在此路径不生效
  return sb.edge('follow-profile', { op: 'save', profile: value }, { jwt: jwt })
    .then(function () { return true; });
}

// ===== ★ 2026-09-12：通用 KV 走 Supabase 直读 =====
// 背景：通用 KV（search_index / teams_hot / teams_search）原走云函数读，是「单后端」的最后一处依赖。
//   · 客户端对通用 KV **只读不写**（实测：setCached 仅被 follow_profile 使用）→ **不需要新建 EF**；
//   · 表 aggregation_cache 已允许 anon 读公开缓存（前提是 RLS 已收敛 —— 见
//     supabase/migrations/002-fix-anon-read-cache.sql，否则 anon 会连带读到 follow_profile_*）。
//   → 直接 PostgREST 读，省掉一次云开发调用（也省掉 EF 的一跳）。
// 未命中（数据尚未入表 / 已过期）或失败 → 返回 null，调用方回落云函数原路径，**行为不变**。
function _sbKvGet(key) {
  var sb = require('./supabaseClient.js');
  if (!sb || !sb.enabled()) return Promise.resolve(null);
  return sb.rest('aggregation_cache', { select: 'payload,expire_at', eq: { key: key }, limit: 1 })
    .then(function (rows) {
      var row = rows && rows[0];
      if (!row || !row.payload) return null;
      if (row.expire_at && new Date(row.expire_at).getTime() < Date.now()) return null;  // 过期按未命中
      return row.payload;
    })
    .catch(function () { return null; });
}

// ===== 通用缓存 =====
// 返回缓存值；云端与本地均无则返回 null。
// 注意：key 透传云端（裸），本地兜底用 localKey(key)（带版本前缀）。
function getCached(key) {
  if (!key) return Promise.resolve(null);
  if (_sbFollowEnabled() && key.indexOf('follow_profile_') === 0) {
    return _sbFollowGet(key)
      .catch(() => cache.get(localKey(key), LOCAL_TTL));   // EF 失败 → 本地兜底
  }
  return cloudProxy.call('getCached', { key })
    .then((r) => {
      if (r && r.hit) {
        // 同步到本地兜底
        try { cache.set(localKey(key), r.value, LOCAL_TTL); } catch (e) {}
        return r.value;
      }
      return cache.get(localKey(key), LOCAL_TTL);
    })
    .catch(() => cache.get(localKey(key), LOCAL_TTL));
}

// 双写：云端为主、本地兜底。失败不抛（best-effort）。
function setCached(key, value, ttlSec) {
  if (!key) return Promise.resolve(false);
  try { cache.set(localKey(key), value, ttlSec || LOCAL_TTL); } catch (e) {}
  if (_sbFollowEnabled() && key.indexOf('follow_profile_') === 0) {
    return _sbFollowSet(key, value, ttlSec)
      .catch(() => cloudProxy.call('setCached', { key: key, value: value, ttlSec: ttlSec || LOCAL_TTL })
        .then(() => true).catch(() => false));   // EF 失败 → 云开发回退
  }
  return cloudProxy.call('setCached', { key: key, value: value, ttlSec: ttlSec || LOCAL_TTL })
    .then(() => true)
    .catch(() => false);
}

// ===== 搜索索引（联赛有限集）=====
// 返回 { leagues:[{id,name}], builtAt, count } 或 null。
function getSearchIndex() {
  const local = cache.get(localKey(INDEX_LOCAL_KEY), LOCAL_TTL);
  return _sbKvGet('search_index').then((d) => {
    if (d && d.leagues && d.leagues.length) {
      try { cache.set(localKey(INDEX_LOCAL_KEY), d, LOCAL_TTL); } catch (e) {}
      console.log('[cloudCache] search_index 走 Supabase 直读（零云开发）');
      return d;
    }
    return _cloudSearchIndex(local);
  }).catch(() => _cloudSearchIndex(local));
}

// 云函数原路径（数据未入表时的回落，行为与改动前一致）
function _cloudSearchIndex(local) {
  return cloudProxy.call('getSearchIndex', {})
    .then((r) => {
      const data = r && r.data;
      if (data && data.leagues && data.leagues.length) {
        try { cache.set(localKey(INDEX_LOCAL_KEY), data, LOCAL_TTL); } catch (e) {}
        return data;
      }
      return local;
    })
    .catch(() => local);
}

function buildSearchIndex() {
  return cloudProxy.call('buildSearchIndex', {})
    .then((r) => {
      const data = r && r.data;
      if (data) {
        try { cache.set(localKey(INDEX_LOCAL_KEY), data, LOCAL_TTL); } catch (e) {}
      }
      return data || null;
    })
    .catch(() => null);
}

// ===== 热门战队共享缓存（战队模块数据更新方式增强）=====
// 返回 { id: { team_id,name,tag,logo_url,country_code,rating,wins,losses,last_match_time } } 或空对象 {}。
// 云端优先、本地兜底、双写本地；云端 miss（未预热）时返回本地（可能为空），客户端据此回退逐队拉取。

function getTeamsHot() {
  const local = cache.get(localKey(TEAMS_HOT_LOCAL_KEY), LOCAL_TTL);
  return _sbKvGet('teams_hot').then((d) => {
    if (d && Object.keys(d).length) {
      try { cache.set(localKey(TEAMS_HOT_LOCAL_KEY), d, LOCAL_TTL); } catch (e) {}
      console.log('[cloudCache] teams_hot 走 Supabase 直读（零云开发）');
      return d;
    }
    return _cloudTeamsHot(local);
  }).catch(() => _cloudTeamsHot(local));
}

function _cloudTeamsHot(local) {
  return cloudProxy.call('getTeamsHot', {})
    .then((r) => {
      const data = r && r.data;
      if (data && Object.keys(data).length) {
        try { cache.set(localKey(TEAMS_HOT_LOCAL_KEY), data, LOCAL_TTL); } catch (e) {}
        return data;
      }
      return local || {};
    })
    .catch(() => local || {});
}

// ===== 战队搜索索引（修复 TEAM_SEARCH_BUG · 修复 A）=====
// 返回 { teams:[{id,name,tag,aliases,tier,navigable}], builtAt, count } 或 null。
// 云端优先、本地兜底（与 getSearchIndex 同构）。语料为历史 S 级及以上战队（OpenDota /search 漏检部分），
// 供 pages/search、pages/teams 搜索时作为兜底源，确保历史 S 级队可见。

function getTeamsIndex() {
  const local = cache.get(localKey(TEAMS_INDEX_LOCAL_KEY), LOCAL_TTL);
  return _sbKvGet('teams_search').then((d) => {
    if (d && d.teams && d.teams.length) {
      try { cache.set(localKey(TEAMS_INDEX_LOCAL_KEY), d, LOCAL_TTL); } catch (e) {}
      console.log('[cloudCache] teams_search 走 Supabase 直读（零云开发）');
      return d;
    }
    return _cloudTeamsIndex(local);
  }).catch(() => _cloudTeamsIndex(local));
}

function _cloudTeamsIndex(local) {
  return cloudProxy.call('getTeamsIndex', {})
    .then((r) => {
      const data = r && r.data;
      if (data && data.teams && data.teams.length) {
        try { cache.set(localKey(TEAMS_INDEX_LOCAL_KEY), data, LOCAL_TTL); } catch (e) {}
        return data;
      }
      return local;
    })
    .catch(() => local);
}

module.exports = {
  getCached: getCached,
  setCached: setCached,
  getSearchIndex: getSearchIndex,
  buildSearchIndex: buildSearchIndex,
  getTeamsHot: getTeamsHot,
  getTeamsIndex: getTeamsIndex
};
