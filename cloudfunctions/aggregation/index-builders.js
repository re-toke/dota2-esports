// cloudfunctions/aggregation/index-builders.js
// ============================================================
// 共享索引构建器（2026-09-12）
//
// ## 为什么放在这里
//   · 微信云函数**只能 require 自己目录内的文件**（上传时只打包该目录）
//     → 共享模块必须放在 cloudfunctions/aggregation/ 内；
//   · GH Actions 同步脚本反向 require 进来（与 liquipedia-slugmap.json 同一套路）。
//
// ## 为什么要有这个模块（单一来源）
//   这三个索引原先只在云函数里构建：
//     · search_index  ← buildSearchIndex（抓 OpenDota /leagues）
//     · teams_search  ← buildTeamsIndex（历史 S 级战队语料）
//     · teams_hot     ← refreshTeams（拉 10 个热门战队详情）
//   现在要让 GH Actions 也产出同样内容写入 Supabase（客户端改走 PostgREST 直读）。
//   若在脚本里重写一遍，**两份逻辑必然漂移** —— 本项目已多次吃这个亏（LP 解析、
//   curation-shared 都靠强制镜像才压住）。故抽成本模块，双方 require 同一份。
//
// ## 设计约束
//   本模块必须是**纯函数 + 纯数据**：不依赖 wx-server-sdk / 网络 / 缓存，
//   以便在云函数（Node）与 GH Actions（Node）两种环境下都能直接 require。
// ============================================================

'use strict';

/** 热门战队预热名单（OpenDota 稳定 team_id，10 支） */
var HOT_TEAM_IDS = [10150538, 7119388, 36, 2586976, 1838315, 2163, 8291895, 8599101, 8255756, 9580444];

/** 历史 S 级及以上战队语料（搜索兜底源，LP/OpenDota 漏检部分） */
var TEAMS_SEARCH_HISTORICAL = require('./teams-search-historical.json');

/**
 * 构建赛事搜索索引。
 * @param {Array} leagues OpenDota /leagues 原始数组（已由调用方裁剪/获取）
 * @returns {{leagues:Array, builtAt:number, count:number}}
 */
function buildSearchIndex(leagues) {
  var list = Array.isArray(leagues)
    ? leagues
        .filter(function (l) { return l && (l.leagueid || l.id) && l.name; })
        .map(function (l) { return { id: Number(l.leagueid || l.id), name: String(l.name) }; })
        .sort(function (a, b) { return a.name.localeCompare(b.name); })
    : [];
  return { leagues: list, builtAt: Date.now(), count: list.length };
}

/**
 * 构建战队搜索索引。
 * @param {Array} [historical] 历史战队语料，默认取内置 TEAMS_SEARCH_HISTORICAL
 * @returns {{teams:Array, builtAt:number, count:number}}
 */
function buildTeamsIndex(historical) {
  var src = historical || TEAMS_SEARCH_HISTORICAL;
  var teams = src.map(function (t) {
    return {
      id: t.id,
      name: t.name,
      tag: t.tag,
      aliases: t.aliases || [],
      tier: t.tier || '',
      navigable: t.navigable !== false
    };
  });
  return { teams: teams, builtAt: Date.now(), count: teams.length };
}

/**
 * 单支战队详情整形（OpenDota /teams/{id} → 紧凑子集，客户端 enrichItem 所需字段）。
 * 判空口径与云函数原实现一致：team_id/name/rating/wins 任一存在即视为有效。
 * @returns {Object|null} null 表示该队数据无效（计 fail）
 */
function shapeHotTeam(id, t) {
  if (!t || (t.team_id == null && !t.name && t.rating == null && t.wins == null)) return null;
  return {
    team_id: t.team_id != null ? t.team_id : id,
    name: t.name || '',
    tag: t.tag || '',
    logo_url: t.logo_url || '',
    country_code: t.country_code || '',
    rating: t.rating || 0,
    wins: t.wins || 0,
    losses: t.losses || 0,
    last_match_time: t.last_match_time || 0
  };
}

/**
 * 热门战队索引整形。
 * @param {Array<{id:number, team:Object|null}>} pairs
 * @returns {{out:Object, ok:number, fail:number}}
 */
function buildTeamsHot(pairs) {
  var out = {};
  var ok = 0, fail = 0;
  (pairs || []).forEach(function (p) {
    if (!p) return;
    var shaped = shapeHotTeam(p.id, p.team);
    if (shaped) { out[p.id] = shaped; ok++; } else { fail++; }
  });
  return { out: out, ok: ok, fail: fail };
}

module.exports = {
  HOT_TEAM_IDS: HOT_TEAM_IDS,
  TEAMS_SEARCH_HISTORICAL: TEAMS_SEARCH_HISTORICAL,
  buildSearchIndex: buildSearchIndex,
  buildTeamsIndex: buildTeamsIndex,
  shapeHotTeam: shapeHotTeam,
  buildTeamsHot: buildTeamsHot
};
