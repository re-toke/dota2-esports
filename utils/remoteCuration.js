// utils/remoteCuration.js
// curation（精选权威库）的远程覆盖层：在不发版的前提下热更新赛事/战队数据。
//
// 策略（与 api.cachedFresh 一致的「本地兜底 + 远程优先」）：
//   - 始终内置 curation.js 本地数据作为兜底（离线/首启/拉取失败可用）；
//   - 若 config.remoteCuration.url 配置，则在启动时(或强制)拉取远程 JSON，
//     覆盖/追加到本地集合，并缓存到 Storage（带 TTL），下次启动直接读缓存、后台再刷新；
//   - 远程 JSON 形状 = { events: [同 CURATED_EVENTS 条目], teams:{ <id>:同 CURATED_TEAMS 条目 } }。
//   - 对外导出 curatedEventFor / curatedTeamFor，与 curation.js 同名函数接口完全兼容。

const curation = require('./curation.js');
const consensus = require('./consensus.js');
const cache = require('./cache.js');
const config = require('./config.js');

const CACHE_KEY = 'remote_curation';

let lookups = null;          // 当前生效的查找器（null = 尚未初始化）
let effectiveEvents = null;
let effectiveTeams = null;
let loadingPromise = null;

// 同步初始化：读缓存（若新鲜）否则用本地兜底。保证 curated* 同步可用。
function ensure() {
  if (lookups) return lookups;
  const meta = cache.getStale(CACHE_KEY, config.remoteCuration.ttlSec, config.remoteCuration.ttlSec);
  if (meta.value && meta.value.events && meta.value.teams) {
    effectiveEvents = meta.value.events;
    effectiveTeams = meta.value.teams;
  } else {
    effectiveEvents = curation.CURATED_EVENTS;
    effectiveTeams = curation.CURATED_TEAMS;
  }
  lookups = curation.buildLookups(effectiveEvents, effectiveTeams);
  return lookups;
}

// 用远程数据覆盖本地，得到「生效集合」：
//   - events 以归一规范名为键，远程覆盖本地同键条目并追加新条目；
//   - teams 以 id 为键，远程覆盖本地同 id 并追加新 id。
function buildEffective(remote) {
  const evMap = {};
  curation.CURATED_EVENTS.forEach((e) => { if (e && e.canonical) evMap[consensus.normName(e.canonical)] = e; });
  (remote.events || []).forEach((e) => { if (e && e.canonical) evMap[consensus.normName(e.canonical)] = e; });
  const events = Object.keys(evMap).map((k) => evMap[k]);

  const tmMap = {};
  Object.keys(curation.CURATED_TEAMS).forEach((id) => { tmMap[Number(id)] = curation.CURATED_TEAMS[id]; });
  Object.keys(remote.teams || {}).forEach((id) => { tmMap[Number(id)] = remote.teams[id]; });

  return { events: events, teams: tmMap };
}

function curatedEventFor(name) { return ensure().eventFor(name); }
function curatedTeamFor(nameOrId) { return ensure().teamFor(nameOrId); }

// 拉取远程配置（异步、幂等、失败静默回退）。
//   - url 为空 → 仅用本地，返回 false（无网络）；
//   - 缓存新鲜且非强制 → 直接读缓存，返回 false；
//   - 否则发起请求，成功则覆盖并缓存，失败则回退（本地/旧缓存）。
function load(force) {
  if (!config.remoteCuration.url) { ensure(); return Promise.resolve(false); }
  const meta = cache.getStale(CACHE_KEY, config.remoteCuration.ttlSec, config.remoteCuration.ttlSec);
  if (!force && meta.value) { ensure(); return Promise.resolve(false); }
  if (loadingPromise) return loadingPromise;

  loadingPromise = new Promise((resolve) => {
    wx.request({
      url: config.remoteCuration.url,
      method: 'GET',
      header: { 'content-type': 'application/json' },
      success: function (res) {
        if (res.statusCode >= 200 && res.statusCode < 300 && res.data && res.data.events && res.data.teams) {
          const eff = buildEffective(res.data);
          effectiveEvents = eff.events;
          effectiveTeams = eff.teams;
          lookups = curation.buildLookups(eff.events, eff.teams);
          cache.set(CACHE_KEY, { events: eff.events, teams: eff.teams }, config.remoteCuration.ttlSec);
          resolve(true);
        } else {
          ensure(); // 数据不合法，回退到本地/旧缓存
          resolve(false);
        }
      },
      fail: function () { ensure(); resolve(false); }
    });
  }).then(function (r) { loadingPromise = null; return r; });
  return loadingPromise;
}

module.exports = {
  curatedEventFor: curatedEventFor,
  curatedTeamFor: curatedTeamFor,
  buildEffective: buildEffective,
  load: load
};
