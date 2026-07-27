// utils/teamSearch.js
// 战队本地搜索语料 + 模糊匹配（供 pages/teams 与 pages/search 复用）。
// 修复 TEAM_SEARCH_BUG 的 B/A：让全局搜索页与战队页共用同一套本地兜底，
// 覆盖 OpenDota /search 因「按活跃度建索引」而漏掉的历史 S 级及以上战队。
//
// 语料 = ① curation.CURATED_TEAMS（当前活跃 S/SSS 队，已核验当前 id）
//       + ② HISTORICAL_S_TEAMS（历史 S 级及以上队，经 OpenDota /teams 核验当前 id）
// navigable:false 的条目 id 为占位负数，仅搜索可见、点击不跳转（避免指向错误队伍）。
const curation = require('./curation.js');

// 历史 S 级及以上战队（曾参加 TI / S-Tier 赛事，现已沉寂或非活跃）。
// team_id 来自 OpenDota /teams 全量列表（2026-07 核验的当前真实 id，非复用旧 id）。
//   - Wings Gaming 1836806 / EHOME 4 / Invictus Gaming 5 / LGD.Forever Young(LFY) 3331948：
//     均为当前有效 id（来自 /teams 实时列表），可安全跳转详情。
//   - CDEC / LGD.FY：当前 /teams 窗口未核验到当前 id（列表被截断/已不存在），先标
//     navigable:false（占位负数 id），仅搜索可见、点击不跳转；待 Fix D（由赛事/TI 名单
//     派生参赛队全集）补全正确 id 后再开放跳转。
const HISTORICAL_S_TEAMS = {
  1836806: { name: 'Wings Gaming', tag: 'WG', country: 'CN', tier: { grade: 'SSS', label: 'TI 参赛' },
             aliases: ['wings', 'wingsgaming', 'the wings gaming'], navigable: true },
  4:       { name: 'EHOME', tag: 'EH', country: 'CN', tier: { grade: 'S', label: 'S-Tier' },
             aliases: ['ehome'], navigable: true },
  5:       { name: 'Invictus Gaming', tag: 'iG', country: 'CN', tier: { grade: 'SSS', label: 'TI 参赛' },
             aliases: ['invictus gaming', 'ig', 'igaming'], navigable: true },
  3331948: { name: 'LGD.Forever Young', tag: 'LFY', country: 'CN', tier: { grade: 'S', label: 'S-Tier' },
             aliases: ['lgd.forever young', 'lfy'], navigable: true },
  // 非可跳转历史队：占位负数 id，仅搜索可见、不跳转。
  '-1':    { name: 'CDEC', tag: 'CDEC', country: 'CN', tier: { grade: 'S', label: 'S-Tier' },
             aliases: ['cdec'], navigable: false },
  '-2':    { name: 'LGD.FY', tag: 'LGD.FY', country: 'CN', tier: { grade: 'S', label: 'S-Tier' },
             aliases: ['lgd.fy', 'lgdfy'], navigable: false }
};

// 构建合并语料索引（memoize 一次）。
let _localTeamIndex = null;
function buildLocalTeamIndex() {
  if (_localTeamIndex) return _localTeamIndex;
  const out = [];
  // ① 当前活跃 S/SSS 队（curation 已核验当前 id）
  const map = (curation && curation.CURATED_TEAMS) || {};
  Object.keys(map).forEach((id) => {
    const t = map[id] || {};
    if (t.name) out.push({ id: Number(id), name: t.name, tag: t.tag || '', aliases: t.aliases || [], navigable: true });
  });
  // ② 历史 S 级及以上队
  Object.keys(HISTORICAL_S_TEAMS).forEach((id) => {
    const t = HISTORICAL_S_TEAMS[id] || {};
    if (t.name) out.push({ id: Number(id), name: t.name, tag: t.tag || '', aliases: t.aliases || [], navigable: t.navigable !== false });
  });
  _localTeamIndex = out;
  return _localTeamIndex;
}

// 本地模糊匹配：name/tag/别名 子串命中（大小写不敏感），返回前 limit 条。
// 仅作兜底与联想，不替代 OpenDota 主源；纯本地、零网络、不会抛错。
function matchLocalTeams(kw, limit) {
  const k = (kw || '').trim().toLowerCase();
  if (!k) return [];
  const idx = buildLocalTeamIndex();
  const out = [];
  for (let i = 0; i < idx.length; i++) {
    const t = idx[i];
    const hay = (t.name + ' ' + t.tag + ' ' + (t.aliases || []).join(' ')).toLowerCase();
    if (hay.indexOf(k) >= 0) out.push(t);
    if (out.length >= (limit || 10)) break;
  }
  return out;
}

module.exports = {
  buildLocalTeamIndex: buildLocalTeamIndex,
  matchLocalTeams: matchLocalTeams,
  HISTORICAL_S_TEAMS: HISTORICAL_S_TEAMS
};
