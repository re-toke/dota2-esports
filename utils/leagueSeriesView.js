// utils/leagueSeriesView.js
// 赛事详情页：跨源（OpenDota × Liquipedia）合并段 + 分页视图模型
//
// ★ 2026-11-15（第三批 · 第二刀）：从 `subpackages/detail/league-detail/league-detail.js` 搬出。
//   · mergeLiquipediaSeries：Liquipedia 赛程 → series 的过滤/聚合/吸收（原内联在
//     buildSeriesFromSources 的 `if (liqGrouped.length)` 大块里，约 190 行）；
//   · pageWindow：slicePage / appendPage 共用的分页切片计算。
//   ⚠️ 纯计算：不碰 wx / 页面实例 / setData。页面相关的依赖（fmt 以外的队名映射等）
//      一律通过参数注入，保持可单测。
'use strict';

const sources = require('./sources.js');
const seriesNormalize = require('./seriesNormalize.js');
const config = require('./config.js');

/**
 * 合并 Liquipedia 赛程与 OpenDota 系列（跨源去重 + 吸收已结算局）。
 *
 * @param {Object} o
 * @param {Array}  o.allSeries     OpenDota 系列（normalizeOpenDotaSeries 输出，会被复制/替换）
 * @param {Array}  o.raw           OpenDota 原始 match 数组（构建 match_id 集合与队名兜底）
 * @param {Array}  o.liqScheduled  Liquipedia 赛程原始条目
 * @param {number} o.nowSec        当前 unix 秒
 * @param {Object} o.teamIdNameMap explorer 预取的 team_id → 队名映射
 * @returns {{ allSeries: Array, liqGrouped: Array }}
 */
function mergeLiquipediaSeries(o) {
  const opts = o || {};
  var allSeries = opts.allSeries || [];
  const raw = opts.raw || [];
  const liqScheduled = opts.liqScheduled || [];
  const nowSec = Number(opts.nowSec) || Math.floor(Date.now() / 1000);
  const teamIdNameMap = opts.teamIdNameMap || {};

  // ★ 2026-08-20：先按 series 聚合 Liquipedia match（同 BO 系列多局合并为一项，
  //   修复「一场 BO3 被拆成多张 BO1 卡」——此前直接 .map 每场独立成卡，缺聚合步骤）。
  const liqGrouped = sources.groupLiquipediaMatches(liqScheduled);
  if (liqGrouped && liqGrouped.length) {
    // §9 P0-D2（2026-07-30）：TBD 占位隔离
    // 痛点：TBD（待定/待公布）队伍参与队名归一化键构建，会导致多个 TBD 对阵被误判为同一对阵而合并，
    //   如 "TBD vs Team A" 与 "TBD vs Team B" 因 TBD 相同而被误去重。
    // 修复：TBD 队伍不参与去重键构建（包含 TBD 的对阵视为独立对阵，不做合并）。
    //   - 构建 openDotaKeys 时跳过含 TBD 的对阵（避免污染键集）
    //   - 过滤 Liquipedia 赛程时，含 TBD 的对阵直接保留（不查去重键）
    // ★ v3 优化项25：队名归一化增强 — 去掉常见后缀（esports/gaming/team）+ 去空格标点
    // 模糊匹配：队名 A 包含队名 B 或反之（长度 >= 3）
    // ★ P1b：实现已迁至 utils/seriesNormalize.js（与去重键/占位判定同源）
    const fuzzyMatchName = seriesNormalize.fuzzyMatchName;
    // 构建去重键（仅双方均为确定队名时才生成键）
    const dedupeKey = seriesNormalize.dedupeKey;
    // ★★ 2026-09-27（用户实测修复）：「**含 TBD 的占位卡**是否已被"双方已定的实际比赛"覆盖」。
    //
    // ## 背景（实测：PGL Wallachia S9 详情页）
    // 同一场对局被拆成**两张卡并存**：
    //   · `Natus Vincere vs Team Yandex`（OpenDota，双方已定，series_id=1147599）
    //   · `Team Yandex vs TBD`（Liquipedia 占位，对手未更新；计划 20:00，与上者差 52min）
    // 根因：下方 P0-D2 规则「**含 TBD 的对阵直接保留、不参与去重**」
    //   —— 该规则**本身合理**（防 "TBD vs A" 与 "TBD vs B" 因 TBD 相同被误并），
    //   但它在「已定一方**已被实际比赛覆盖**」的情形下漏了去重 ⇒ 重复卡。
    //
    // ## 判据（收紧，避免误并）
    // 仅当**同时**满足才判定"已被覆盖"：
    //   ① 该卡**恰有一方未定**（另一方已定）；双方都 TBD ⇒ 无共同方可锚定 ⇒ **不处理**；
    //   ② 已定方与某张"双方已定"的对阵**任一方归一化后严格相等**（复用同一个 normalizeTeamNameForDedup ⇒ 口径一致）；
    //   ③ 两者开赛时间差 **< 2h**（与下方既有 D2 时间窗同口径）。
    // ⇒ 调用方据此**只丢弃占位卡**，**不做双向合并** ⇒ 不引入"TBD 互相误并"（原意图完整保留）。
    //
    // @param {object} m LP 排期条目（含 team1Name/team2Name/startTime）
    // @param {Map<string,number>} keysMap 已定对阵键（`归一名A__归一名B`）→ 该系列首场开赛时间
    // ★ P1b：实现已迁至 utils/seriesNormalize.placeholderCoveredByReal（有单测）
    const placeholderCoveredByReal = seriesNormalize.placeholderCoveredByReal;
    // 构建 OpenDota 已有对阵的去重键（队名归一化：小写+去空格+去后缀）
    // 用于剔除 Liquipedia 中已被 OpenDota 返回的已结束对阵
    const openDotaKeys = new Map();   // key -> 该系列首场开赛时间（D2 时间窗去重用）
    // ★★ 2026-09-27：**键 → 该对队的多场开赛时间数组**（供占位卡覆盖判定用）。
    //   为什么是"数组"而不是单值：**同一对队在同一赛事会多次交手**（实测
    //   `natusvincere__teamyandex` 既有 9-21 那场、也有今天 20:52 那场），
    //   单值会被**后写入的场次覆盖** ⇒ 占位卡（今天 20:00）与"9-21 那场"差 5.8 天 ⇒ 判据失效。
    //   为什么另建而不改 `openDotaKeys` 的值：后者的值参与**既有 D2 时间窗去重**，
    //   改动它会改变既有去重行为；本表只服务新增的占位卡判定，**零副作用**。
    const openDotaTimeByKey = new Map();   // key -> [startTime, ...]
    const openDotaNames = [];  // ★ v3 优化项25：存储归一化名供模糊匹配
    // ★ v3 优化项33（2026-08-03）：OpenDota match_id 集合（P0b 硬关联去重）。
    // Liquipedia {{Match}} 顶层的 matchid1/matchid2 与 OpenDota match_id 直接对应，
    // 比队名归一化（受 OpenDota 队名 null → 占位"天辉/夜魇"影响而失效）可靠得多。
    // 该对局的全部 matchid 都已被 OpenDota 收录 → Liquipedia 项剔除（OpenDota 数据更全）。
    const openDotaMatchIds = new Set();
    raw.forEach(function (m) {
      if (m && m.match_id) openDotaMatchIds.add(String(m.match_id));
    });
    // ★ 2026-08-05（RECENT 同对局双卡修复，R1）：解名兜底【上移】至 openDotaKeys 构造前（原定义在吸收块，
    //   时序上够不到此处；同一作用域重复 const 声明会 SyntaxError，故上移单一定义供两处共用）。
    //   OpenDota 比赛端点队名恒 null → groupSeries 兜底 '天辉'/'夜魇' → 队名去重键恒失效；
    //   用 explorer 预取 _teamIdNameMap 解真实名 → 精确去重路径恢复（R5：去后缀 + k/kRev 顺序无关）。
    const _curTeamTable = (function () {
      try { const _c = require('./curation.js'); return (_c && _c.CURATED_TEAMS) || null; }
      catch (e) { return null; }
    })();
    const _rawIdMap = {};
    raw.forEach(function (m) {
      if (m && m.radiant_team_id && m.radiant_team_name) _rawIdMap[m.radiant_team_id] = m.radiant_team_name;
      if (m && m.dire_team_id && m.dire_team_name) _rawIdMap[m.dire_team_id] = m.dire_team_name;
    });
    const _resolveName = (id) => sources.resolveTeamIdName(id, teamIdNameMap, _curTeamTable, _rawIdMap);
    allSeries.forEach(function (s) {
      const _g0 = s.games && s.games[0];
      const _rn = (s.radiantName === '天辉' && _g0) ? (_resolveName(_g0.radiantTeamId || _g0.radiant_team_id) || s.radiantName) : s.radiantName;
      const _dn = (s.direName === '夜魇' && _g0) ? (_resolveName(_g0.direTeamId || _g0.dire_team_id) || s.direName) : s.direName;
      // ★ 2026-09-01（v8.4 Fix-C）：解出的真实队名写回系列卡显示字段。
      //   此前 _rn/_dn 仅用于构建去重键，卡片本身仍显示占位「天辉 vs 夜魇」——
      //   OpenDota /leagues/{id}/matches 队名恒 null 的联赛（如 20142/19944）RECENT 段
      //   全部显示占位名，且 LIVE 段同对局卡无法按队名关联（双卡根因之一）。
      if (_rn) s.radiantName = _rn;
      if (_dn) s.direName = _dn;
      if (_rn && _dn) {
        const k1 = dedupeKey(_rn, _dn);
        if (k1) {
          openDotaKeys.set(k1, _g0 ? (_g0.start_time || 0) : 0);
          openDotaKeys.set(k1.split('__').reverse().join('__'), _g0 ? (_g0.start_time || 0) : 0);
          // ★ 该对队的**多场**时间（同一对队可能多次交手 ⇒ 必须累计，不能覆盖）
          //   时间兜底顺序：`games[0].start_time → lastTime → firstTime`（实测 start_time 常为 0）
          const _tBest = (_g0 ? (_g0.start_time || 0) : 0) || (s.lastTime || 0) || (s.firstTime || 0);
          if (_tBest > 0) {
            [k1, k1.split('__').reverse().join('__')].forEach(function (kk) {
              const arr = openDotaTimeByKey.get(kk);
              if (arr) { if (arr.indexOf(_tBest) < 0) arr.push(_tBest); }
              else openDotaTimeByKey.set(kk, [_tBest]);
            });
          }
        }
        openDotaNames.push({
          n1: seriesNormalize.normalizeTeamNameForDedup(_rn),
          n2: seriesNormalize.normalizeTeamNameForDedup(_dn),
          startTime: _g0 ? (_g0.start_time || 0) : 0   // D2 模糊匹配时间窗基准
        });
      }
    });
    // 将 Liquipedia 赛程转换为 series 对象
    const _liqFiltered = liqGrouped
      .filter(function (m) {
        // ★★ 2026-09-27（用户实测修复）：**占位卡（含 TBD）已被实际比赛覆盖 ⇒ 剔除**。
        //   ⚠️ **必须放在下方 live/upcoming 早退之前**：那张重复卡的 phase 是 `upcoming`，
        //   而下面的早退（v1.1 R1「LP live/upcoming 永不剔除」）会让它在到达队名去重段**之前就 return true**
        //   ⇒ 首次实现把判定写在 `if (!k)` 处，**实测完全不生效**（重复卡仍在）。
        //   ★ 只对「含 TBD」的条目生效 ⇒ 正常 live/upcoming 卡**完全不受影响**（原意图保留）；
        //     且 `placeholderCoveredByReal` 内部还要求「仅一方未定 + 共同方严格相等 + 时间差<2h」。
        if ((seriesNormalize.isTbd(m.team1Name) || seriesNormalize.isTbd(m.team2Name)) &&
            placeholderCoveredByReal(m, openDotaKeys, openDotaTimeByKey)) {
          if (config.debug && config.debug.verboseLog) {
            console.log('[league-detail] 占位卡（含 TBD）已被实际比赛覆盖 → 剔除：' +
              (m.team1Name || '?') + ' vs ' + (m.team2Name || '?'));
          }
          return false;
        }
        // ★ 2026-08-04（v1.1 实施，审核 R1）：LP live/upcoming 永不剔除 —— 它是 OpenDota 进行中系列唯一的 live 状态来源。
        //   原实现（v3 优化项33）matchIds.every 全命中即剔，把「仅第一局被 OpenDota 收录」的 live BO3 剔掉 →
        //   OpenDota 单局已结算被误判 recent/BO1。
        //   ⚠️ 必须【替换】原 matchIds 分支（filter 回调最前端）而非追加：追加在其后 live 卡先被 every() 剔除、
        //      早退行永远执行不到；本行位于最前端 → live/upcoming 卡在下方队名精确/模糊去重之前提前返回，
        //      完整跳过两条路径（OpenDota 该场队名正常 + 时间窗<2h 的赛事仍被队名去重剔除的隐患一并消除）。
        //   仅对 LP recent 场次保留 matchIds/队名去重（防双源重复）。
        if (m.phase !== 'recent') return true;
        // ★ 2026-08-05（RECENT 同对局双卡修复，审核 R2）：恢复 v3 优化项33 matchIds 硬关联去重
        //   （v1.1 R1 实施时误删）。判定抽纯函数 sources.allMatchIdsInSet。
        //   recent 卡的全部 match_id 都被 OpenDota 收录 → LP 项剔除（OpenDota 数据更全，含比分）。
        //   ⚠️ 必须放在早退行【之后】：仅 recent 卡走此分支，live/upcoming 不受影响（R1 零回归）。
        if (m.matchIds && m.matchIds.length && sources.allMatchIdsInSet(m.matchIds, openDotaMatchIds)) {
          return false;
        }
        // 去重：剔除 OpenDota 已返回的对阵（队名归一化后匹配）
        if (!m.team1Name || !m.team2Name) return false;
        const k = dedupeKey(m.team1Name, m.team2Name);
        if (!k) return true;  // §9 P0-D2：含 TBD 的对阵直接保留，不参与去重
        const kRev = k.split('__').reverse().join('__');
        if (openDotaKeys.has(k) || openDotaKeys.has(kRev)) {
        var _t0 = openDotaKeys.get(k) || openDotaKeys.get(kRev) || 0;
        // D2 时间窗：队名匹配且开赛时间差 < 2h 才判定为同一场（消重复）；
        // 时间差大 → 同一两队的不同场次（如小组赛双循环），保留
        if (_t0 && m.startTime && Math.abs(m.startTime - _t0) < 2 * 3600) return false;
        return true;
      }
        // ★ v3 优化项25：模糊匹配去重（如 "Team Falcons" vs "Falcons"）
        var ln1 = seriesNormalize.normalizeTeamNameForDedup(m.team1Name);
        var ln2 = seriesNormalize.normalizeTeamNameForDedup(m.team2Name);
        for (var i = 0; i < openDotaNames.length; i++) {
          if ((fuzzyMatchName(ln1, openDotaNames[i].n1) && fuzzyMatchName(ln2, openDotaNames[i].n2)) ||
              (fuzzyMatchName(ln1, openDotaNames[i].n2) && fuzzyMatchName(ln2, openDotaNames[i].n1))) {
            // D2 时间窗（与精确匹配一致）：队名模糊匹配 + 开赛时间差 < 2h 才算同一场；
            // 时间差大 → 同一两队的不同场次（如小组赛双循环），保留
            var _tf = openDotaNames[i].startTime || 0;
            if (_tf && m.startTime && Math.abs(m.startTime - _tf) < 2 * 3600) return false;
            return true;
          }
        }
        return true;
      });
    let liqSeries = seriesNormalize.mapLiquipediaCards(_liqFiltered, { nowSec: nowSec, log: console.log });
    // 时间窗口过滤（LIVE：6h 内 + 开赛证据 + 未达 BO 上限；UPCOMING：北京时间 3 天内；RECENT：全留）
    // ★ P1b：整段已抽到 utils/seriesNormalize.filterLiquipediaCardsByWindow（有单测）
    liqSeries = seriesNormalize.filterLiquipediaCardsByWindow(liqSeries, nowSec, config.time.bjOffsetSec);
    // ★ 2026-08-04（v1.1 实施，审核 R3/R4/R5/R6）：LP live/upcoming 卡吸收 OpenDota 已结算局（matchIds 硬关联）
    //   - 方向映射优先级链：curation team_id→名 → league 内 idMap（raw 收集）→ null；单点命中即定方向（补集原理）
    //   - 方向失败：不注入 games（跨 tab 双卡为已文档化边界，R6）
    //   - 被吸收的 OpenDota 单局卡从 allSeries 移除（防 RECENT 重复）
    const _teamIdName = (id) => {
      if (!id) return null;
      // ★ 2026-08-04（v3.1，R1）：load 预取 explorer 队名（可靠源）优先 → curation → raw idMap 兜底
      if (teamIdNameMap && teamIdNameMap[id]) return teamIdNameMap[id];
      if (_curTeamTable && _curTeamTable[id] && _curTeamTable[id].name) return _curTeamTable[id].name;
      return _rawIdMap[id] || null;
    };
    const _absorb = sources.absorbSettledGames(allSeries, liqSeries, _teamIdName);
    liqSeries = _absorb.liqSeries;
    if (_absorb.absorbedKeys && _absorb.absorbedKeys.length) {
      const _removed = new Set(_absorb.absorbedKeys);
      allSeries = allSeries.filter(function (s) { return !(s.key && _removed.has(s.key)); });
    }
    allSeries = allSeries.concat(liqSeries);
  }

  return { allSeries: allSeries, liqGrouped: liqGrouped };
}

/**
 * 分页切片（slicePage / appendPage 共用）。
 * @param {Array} items
 * @param {number} page    目标页（0 基）
 * @param {number} pageSize
 * @returns {{slice:Array, page:number, hasMore:boolean, start:number}}
 *   start = 已渲染条目的起始下标（用于路径式 setData 只 patch 新增项）
 */
function pageWindow(items, page, pageSize) {
  const list = Array.isArray(items) ? items : [];
  const size = Math.max(1, Math.floor(Number(pageSize) || 1));
  const p = Math.max(0, Math.floor(Number(page) || 0));
  const slice = list.slice(0, (p + 1) * size);
  return { slice: slice, page: p, hasMore: list.length > slice.length, start: p * size };
}

module.exports = {
  mergeLiquipediaSeries,
  pageWindow
};
