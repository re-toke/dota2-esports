// utils/homeMatchFlow.js
// 首页比赛流：三源采集 + series 聚合（纯函数层）
//
// ★ 2026-11-15（第三批拆分）：从 `pages/index/index.js` 的 `_applyMatchSources` 整段搬出，
//   逻辑与关键注释逐字保留。目的：
//     ① 页面只保留「卡片构建 / 渲染编排」，取数去重与 series 归一这类承载正确性的逻辑
//        转为可单测纯函数（项目先例：utils/homeDedupe.js、utils/followBatch.js）；
//     ② 降低 index.js 2000 行文件里「改 A 影响 B」的风险。
//
// ⚠️ 纯计算：不碰 wx / 页面实例 / setData；依赖仅限 utils 内的纯模块。
'use strict';

const sources = require('./sources.js');
const indexCardHelpers = require('./indexCardHelpers.js');

// 「无 match_id 的 upcoming 排期赛」弱键：leagueid + 队ID对（不计顺序）+ start_time
function weakKeyOf(m) {
  if (!m.leagueid || !m.radiant_team_id || !m.dire_team_id || !m.start_time) return null;
  const a = Math.min(m.radiant_team_id, m.dire_team_id);
  const b = Math.max(m.radiant_team_id, m.dire_team_id);
  return m.leagueid + '|' + a + '|' + b + '|' + m.start_time;
}

/**
 * 三源原始 match 合并 + 去重（groupSeries 的输入为 OpenDota match 平铺结构）。
 *
 * 去重规则：
 *   · match_id 有值 → 按 id 去重；
 *   · 无 id（upcoming 排期赛）→ 按「leagueid|队ID对|start_time」弱键去重，
 *     防同一场被多战队列表重复注入。
 *
 * 优先级：同一 match_id 双源并存时 `/live` 版本优先（实时性 > pro 的提前结算写入）。
 * 实现：先入 /live，再入 pro ⇒ pro 的旧结算数据被去重跳过。
 *
 * @param {Object} o
 * @param {Array}  o.pro           OpenDota /proMatches
 * @param {Array}  o.live          OpenDota /live（原始字段）
 * @param {Array}  o.rows          关注战队比赛 [{ t, ms }]
 * @param {Object} o.followTeamIds { [teamId]: true }
 * @param {number} o.now           unix 秒
 * @param {number} o.liveWindowSec 关注流「已开赛但仍算进行中」窗口（秒）
 * @returns {Array} 去重后的平铺 match 数组
 */
function collectHomeRawMatches(o) {
  const opts = o || {};
  const pro = opts.pro || [];
  const live = opts.live || [];
  const rows = opts.rows || [];
  const followTeamIds = opts.followTeamIds || {};
  const now = opts.now || 0;
  const liveWindowSec = opts.liveWindowSec || 0;

  const raw = [];
  const seenId = {};
  const seenWeak = {};
  const pushUnique = (m) => {
    if (!m) return;
    if (m.match_id) {
      const k = String(m.match_id);
      if (seenId[k]) return;
      seenId[k] = true;
      raw.push(m);
      return;
    }
    const wk = weakKeyOf(m);
    if (wk) {
      if (seenWeak[wk]) return;
      seenWeak[wk] = true;
    }
    raw.push(m);
  };

  // ② /live 职业场：进行中局（league_id > 0），normalize 成 OpenDota match 结构后并入。
  //    ★ 2026-09-02：提前到 ① pro 之前（/live 版本优先，见上）。
  //    ★ 2026-09-02：league_name 空值回填 —— OpenDota /live 实测 league_name 恒为空字符串，
  //      旧实现直接透传 → 唯一数据源时卡头退化「职业赛事」。
  //      回填来源：① proMatches 同 leagueid 的 league_name；② curation canonicalLeagueName；
  //      仍无 → 保持空（_cardFromSeries 兜底）。
  const proLeagueNameById = {};
  pro.forEach((m) => {
    if (m && m.leagueid && m.league_name) {
      if (!proLeagueNameById[m.leagueid]) proLeagueNameById[m.leagueid] = m.league_name;
    }
  });
  live.forEach((m) => {
    if (!m || !m.league_id || m.league_id <= 0) return;
    // ★★ 2026-09-27 修复「已结束的对局仍显示进行中 / 比分少算一局」：
    //   OpenDota /live 在比赛结束后仍会残留该局（实测 28% 条目 deactivate_time ≠ 0）。
    //   判据用原生字段 deactivate_time（已结束残留 = 非 0；真正进行中 = 0）。
    //   ⚠️ 不能用 game_time 判（实测含 -14 等脏值）；也不宜用"最后活动时间阈值"。
    //   ⚠️ 已结束的局不在此并入，交给 pro 侧权威（含比分/胜负）。
    if (Number(m.deactivate_time) > 0) return;
    const norm = indexCardHelpers.normalizeLiveMatch(m, now);
    if (!norm.league_name) {
      norm.league_name = proLeagueNameById[m.league_id] || '';
      if (norm.league_name) norm._leagueNameFromPro = true;   // 审计标记
    }
    pushUnique(norm);
  });

  // ① proMatches：已结束局（近 ~100 场，覆盖近 2-3 天）。
  //    ★ 2026-09-02：放在 ② 之后 —— 同 match_id 时让 /live 版本优先入表。
  pro.forEach((m) => {
    if (!m || !m.start_time) return;
    pushUnique(m);
  });

  // ③ 关注战队比赛：upcoming + 窗口内的「正在交锋」（已结束由 proMatches 覆盖）
  rows.forEach((r) => {
    const ms = (r && r.ms) || [];
    ms.forEach((m) => {
      if (!m || !m.start_time) return;
      const isFollowMatch = (m.radiant_team_id != null && followTeamIds[String(m.radiant_team_id)]) ||
                            (m.dire_team_id != null && followTeamIds[String(m.dire_team_id)]);
      if (!isFollowMatch) return;
      const started = m.start_time <= now;
      const inLiveWindow = started && (now - m.start_time) < liveWindowSec;
      if (started && !inLiveWindow) return;
      pushUnique(m);
    });
  });

  return raw;
}

/**
 * series 聚合 + BO 判定 + 拆裂合并 + 参赛队白名单过滤。
 * @param {Array} raw collectHomeRawMatches 的输出
 * @returns {Array} series 列表（可直接交给页面的 _cardFromSeries）
 */
function buildHomeSeries(raw) {
  // ④ 系列聚合 + BO 判定（纯计算，失败不影响主流程）
  let allSeries = [];
  try {
    allSeries = sources.groupSeries(raw);
    const boCtx = sources.buildBoContext(allSeries, null);   // 无 Liquipedia → 走 S3 series_type / S5 / S6
    allSeries.forEach((s) => sources.applyBo(s, boCtx));
    // ★ 2026-09-02（v8.8 A'）：合并前把 game 层真实队名写回 series（OpenDota /proMatches 的
    //   radiant_name/dire_name 在 groupSeries 时被丢成「天辉/夜魇」占位——groupSeries 读
    //   radiant_team_name 字段，proMatches 提供的是 radiant_name）。mergeSplittedBo3Series
    //   要求真实队名才能可靠归并（占位名无法跨 team_id 判定同队）。
    allSeries.forEach((s) => {
      const games = s.games || [];
      const g0 = games[0] || {};
      const rn = (s.radiantName && s.radiantName !== '天辉' && s.radiantName !== '夜魇')
        ? s.radiantName : (g0.radiant_name || s.radiantName || '');
      const dn = (s.direName && s.direName !== '天辉' && s.direName !== '夜魇')
        ? s.direName : (g0.dire_name || s.direName || '');
      s.radiantName = rn; s.direName = dn;
    });
    // ★ 2026-09-02（v8.8 A'）：RECENT 段「OpenDota 拆裂 BO3」合并（与详情页共用纯函数）。
    //   OpenDota 可能把同一真实 BO3 拆成多个 series_id（甚至同队多 team_id），
    //   groupSeries 聚合成多张单局卡 → 首页「已结束」段显示多场 BO1。按解名队名合并回整场。
    allSeries = sources.mergeSplittedBo3Series(allSeries);
  } catch (e) { allSeries = []; }

  // ★ 2026-09-02（v8.8c）：参赛队白名单过滤（跨联赛误标剔除，与详情页共用）。
  //   首页是多联赛视图 → 按每个 series 的 leagueId（s.leagueId || games[0].leagueid）分组，
  //   对 leagueId>0 且 curation 能命中参赛队的组执行 filterMisattributedRecentSeries：
  //   「已结束 + 双方队名都不在该联赛参赛名单」→ 剔除。
  //   守卫（函数内）：仅 recent、仅 curation 有 participants 的 league、占位名不判。
  try {
    const byLeague = {};     // lid → [series]
    const unTagged = [];     // 无 leagueId 的系列（保持原样）
    allSeries.forEach((s) => {
      const g0 = (s.games && s.games[0]) || {};
      const lid = Number(s.leagueId || g0.leagueid);
      if (lid && lid > 0) {
        if (!byLeague[lid]) byLeague[lid] = [];
        byLeague[lid].push(s);
      } else {
        unTagged.push(s);
      }
    });
    const keptAll = unTagged.slice();
    Object.keys(byLeague).forEach((lidStr) => {
      const lid = Number(lidStr);
      const filtered = sources.filterMisattributedRecentSeries(byLeague[lidStr], lid);
      keptAll.push.apply(keptAll, filtered);
    });
    allSeries = keptAll;
  } catch (e) { /* 过滤失败不影响主流程 */ }

  return allSeries;
}

module.exports = {
  weakKeyOf,
  collectHomeRawMatches,
  buildHomeSeries
};
