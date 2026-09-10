// utils/storageReset.js
// ============================================================
// 本机存储的分类清理（v1.2 · 2026-09-10）
//
// ## 为什么需要它
// 原实现用 `wx.clearStorageSync()` 一刀切，带来两个问题（复核已确认）：
//   ① **连 `dota2_cloud_sync` 开关状态一起清掉**，却完全不动云端
//      → 造出「云端孤儿」：本地显示「未开启」，云端画像仍在，
//        而删除入口依赖开关状态 → **用户永远删不掉**（复核漏洞 1）
//   ② 「清除缓存」的语义被撑大成「清空一切」，用户无法只清缓存
//
// 现按**用途分三类**管理，并提供三种粒度操作：
//   clearCacheOnly()  只清缓存 —— 保留关注/资料/凭证/同步开关
//   clearAllLocal()   清本机全部（缓存 + 用户数据 + 凭证）—— 保留同步开关？
//                     → 不保留：调用方须先处理云端（见 resetAll）
//   resetAll()        先删云端、**成功才**清本机（顺序不可颠倒，否则又造孤儿）
//
// ## 新增 storage key 时请归入下表对应类别
// ============================================================

/** 前缀匹配（key 可能是 `xxx_<id>` 形式） */
var CACHE_PREFIXES = [
  'dota2_cache_',          // 通用缓存（api 层）
  'dota2_meta_enriched_',  // 赛事元数据增强缓存
  'dota2_meta_persisted_v',// 赛事元数据持久化
  'dota2_search_hist_'     // 搜索历史（按分类）
];

/** 精确匹配：纯缓存类 */
var CACHE_EXACT = [
  'search_history',
  'dota2_logo_cache_v1',
  'stratz_leagues',
  'teams_hot',
  'teams_search',
  'search_index',
  'haglund_circuit_v1',
  'haglund_upcoming_v1',
  'remote_curation_v3',
  'remote_curation_version',
  'dota2_cloud_cb'         // cloudProxy 熔断器状态
];

/** 用户数据（关注/提醒/资料/偏好）—— 属「用户内容」，不是缓存 */
var USER_DATA_EXACT = [
  'dota2_follow',                  // 关注列表
  'dota2_reminder_strategy',       // 提醒策略（提前量/级别）
  'dota2_sub_status',              // 订阅授权状态
  'dota2_sub_send_log',            // 推送记录
  'user_profile',                  // 头像/昵称
  'dota2_follow_fakeid_migrated',  // 迁移标记
  'onboarded',                     // 新手引导完成标记
  'ab_events'                      // A/B 实验事件
];

/** 账号态（清缓存时**必须保留** —— 否则云端孤儿） */
var ACCOUNT_STATE_EXACT = [
  'dota2_cloud_sync'
];

/** 凭证（登录态） */
var CREDENTIAL_EXACT = [
  'dota2_openid',
  'dota2_jwt'
];

function _allKeys() {
  try {
    var info = wx.getStorageInfoSync();
    return (info && info.keys) || [];
  } catch (e) { return []; }
}

function _pick(prefixes, exacts) {
  return _allKeys().filter(function (k) {
    if (exacts.indexOf(k) >= 0) return true;
    for (var i = 0; i < prefixes.length; i++) {
      if (k.indexOf(prefixes[i]) === 0) return true;
    }
    return false;
  });
}

function _remove(keys) {
  var removed = 0;
  keys.forEach(function (k) {
    try { wx.removeStorageSync(k); removed++; } catch (e) {}
  });
  return removed;
}

/**
 * 只清缓存：不动关注、资料、提醒策略、凭证、同步开关。
 * @returns {{removed:number}}
 */
function clearCacheOnly() {
  return { removed: _remove(_pick(CACHE_PREFIXES, CACHE_EXACT)) };
}

/**
 * 清空本机全部数据（缓存 + 用户数据 + 凭证），**含同步开关**。
 * ⚠️ 调用前必须已处理云端（否则会造出孤儿）。外部请优先用 resetAll()。
 * @returns {{removed:number}}
 */
function clearAllLocal() {
  var keys = _pick(CACHE_PREFIXES, CACHE_EXACT.concat(USER_DATA_EXACT, ACCOUNT_STATE_EXACT, CREDENTIAL_EXACT));
  return { removed: _remove(keys) };
}

/**
 * 重置全部 = ① 删云端 → ② **成功才**清本机。
 *
 * ★ 顺序不可颠倒：若先清本机，凭证被删 → 云端删不掉 → 又造孤儿（复核漏洞 4）。
 * ★ 云端删除失败时**中止**，不做半吊子清理，避免制造新的不一致状态。
 *
 * @param {(stage:string)=>void} [onStage] 阶段回调（'cloud' / 'local'）
 * @returns {Promise<{ok:boolean, reason?:string, removed?:number}>}
 */
function resetAll(onStage) {
  var cloudSync = require('./cloudSync.js');
  if (onStage) onStage('cloud');
  return cloudSync.deleteCloudData().then(function (r) {
    if (!r || !r.ok) {
      // 中止：不清理本机，保持状态一致（用户可重试）
      return { ok: false, reason: (r && r.reason) || 'cloud_delete_failed' };
    }
    if (onStage) onStage('local');
    var res = clearAllLocal();
    return { ok: true, removed: res.removed };
  }).catch(function () {
    return { ok: false, reason: 'error' };
  });
}

/** 调试/测试用：导出分类结果，便于核对清单是否漏 key */
function _inspect() {
  return {
    cache: _pick(CACHE_PREFIXES, CACHE_EXACT),
    userData: _pick([], USER_DATA_EXACT),
    accountState: _pick([], ACCOUNT_STATE_EXACT),
    credential: _pick([], CREDENTIAL_EXACT)
  };
}

module.exports = {
  clearCacheOnly: clearCacheOnly,
  clearAllLocal: clearAllLocal,
  resetAll: resetAll,
  _inspect: _inspect,
  // 供新增 key 时对照
  CATEGORIES: {
    CACHE_PREFIXES: CACHE_PREFIXES,
    CACHE_EXACT: CACHE_EXACT,
    USER_DATA_EXACT: USER_DATA_EXACT,
    ACCOUNT_STATE_EXACT: ACCOUNT_STATE_EXACT,
    CREDENTIAL_EXACT: CREDENTIAL_EXACT
  }
};
