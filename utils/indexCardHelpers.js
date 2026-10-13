// utils/indexCardHelpers.js
// ★★ 2026-10-13（P1-20 子项 2）：从 `pages/index/index.js` **整段搬出**的纯函数（逐字未改逻辑），目的：
//   ① 让「首页卡片队名/缩写整形」「Steam LIVE 局 → groupSeries 输入归一」这类**承载正确性**
//      的页面私有逻辑**可被单测**（本项目「页面层零测试」是最大盲区）；
//   ② 与项目约定一致 —— 页面层逻辑尽量抽纯函数（先例：`utils/homeDedupe.js`、`utils/followBatch.js`）。
//   ⚠️ 本模块**只做纯计算**：不碰 wx / this / setData。
'use strict';

// ===== v4.2（2026-08-23）：比赛卡队名展示整形 =====
// 根因：旧 tagOf = name.slice(0,4).toUpperCase() ⇒
//   Team Spirit / Team Liquid / Team Falcons 全塌成 "TEAM"、Xtreme Gaming → "XTRE"（无法分辨队伍）。
//   ⇒ 卡面改用**完整队名**；缩写只保留给「队徽加载失败时的占位文字」（圆框里最多 5 字符）。
const TEAM_NAME_FALLBACK = '待定';

function teamFullName(name) {
  const s = (name == null ? '' : String(name)).trim();
  return s || TEAM_NAME_FALLBACK;
}

function teamShortTag(name) {
  const s = (name == null ? '' : String(name)).replace(/\s+/g, '');
  return s ? s.slice(0, 5).toUpperCase() : '?';
}

// ===== Steam /live 局 → groupSeries 可消费的 match 形状 =====
// 说明（原 index.js 注释）：Steam LIVE 局的「当前局 activate_time」与 proMatches 的真实开赛时间不同
//   ⇒ start_time 依次取 m.activate_time → m.start_time → (now - duration)。
//   ⚠️ `radiant_win: null` 是**刻意**的：LIVE 局尚未结算，置 null 才不会把进行中局计入系列胜场。
//   透传 `series_id`/`series_type` 后，groupSeries 才能按 series_id 聚合（配合首页 ⑥ 段覆盖去重）。
function normalizeLiveMatch(m, now) {
  return {
    match_id: m.match_id,
    start_time: m.activate_time || m.start_time || (now - (m.duration || 0)),
    radiant_win: null,
    leagueid: m.league_id,
    league_name: m.league_name || '',
    radiant_team_id: m.team_id_radiant,
    dire_team_id: m.team_id_dire,
    radiant_name: m.team_name_radiant,
    dire_name: m.team_name_dire,
    series_id: m.series_id || null,      // ★ 2026-09-01：透传 Steam 原生 series_id
    series_type: m.series_type,
    radiant_score: m.radiant_score,
    dire_score: m.dire_score,
    duration: m.duration,
    spectators: m.spectators,
    _isLiveSource: true
  };
}

module.exports = {
  TEAM_NAME_FALLBACK: TEAM_NAME_FALLBACK,
  teamFullName: teamFullName,
  teamShortTag: teamShortTag,
  normalizeLiveMatch: normalizeLiveMatch
};
