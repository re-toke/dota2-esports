// subpackages/detail/h2h/h2h.js
// 双方对战历史（H2H）页：spec B 节。
// 进入方式：从战队详情「对战记录」行携带双方 team_id（teamA=当前战队, teamB=对手）。
// 数据：api.getTeamMatches(teamA) 已含每场 opposing_team_id 与胜负，按 teamB 过滤即得双方交锋；
// 无需新增接口。条形与标签为纯前端聚合（spec B.3 算法）。
const api = require('../../../utils/api.js');
const util = require('../../../utils/util.js');
const sources = require('../../../utils/sources.js');

// 标签逻辑（spec B.3，阈值假设）
//  - 连胜 N：最近连续同一方获胜且 N ≥ 3（从最近一场往前数）
//  - 压制：|X-Y|/(X+Y) ≥ 0.5 且总场 X+Y ≥ 4
//  - 平分：X === Y
function buildTags(x, y, history) {
  const tags = [];
  const total = x + y;
  // 压制
  if (total >= 4 && total > 0 && Math.abs(x - y) / total >= 0.5) {
    tags.push({ text: '压制', type: 'dominate' });
  }
  // 平分
  if (x === y) {
    tags.push({ text: '平分', type: 'even' });
  }
  // 连胜：最近连续同一方获胜（A 胜或 B 胜均计为「连胜 N」的当前势头）
  if (history.length >= 3) {
    const first = history[0].won; // history 已按 match_id 倒序（最近在前）
    let streak = 0;
    for (let i = 0; i < history.length; i++) {
      if (history[i].won === first) streak++;
      else break;
    }
    if (streak >= 3) {
      tags.push({ text: '连胜 ' + streak, type: 'streak' });
    }
  }
  return tags;
}

// 3.3 从战队全量近期赛事聚合近期状态 5 维（均归一化 0-100）
// 维度：胜率 / 场均净胜分 / 对手强度 / 近期密度 / 大赛(S级+)占比
function computeForm(matches) {
  const list = (matches || [])
    .filter((m) => m.radiant_win != null)            // 仅已完成
    .sort((p, q) => (q.match_id || 0) - (p.match_id || 0)) // 最近在前
    .slice(0, 30);                                   // 取最近 30 场
  if (!list.length) return [0, 0, 0, 0, 0];

  const nowSec = Math.floor(Date.now() / 1000);
  const WINDOW = 90 * 86400;
  let wins = 0, marginSum = 0, strengthSum = 0, strengthCount = 0, bigStage = 0, recent90 = 0;

  list.forEach((m) => {
    const won = (m.radiant === m.radiant_win);
    if (won) wins++;
    const own = m.radiant ? m.radiant_score : m.dire_score;
    const opp = m.radiant ? m.dire_score : m.radiant_score;
    marginSum += (own - opp);

    const tier = sources.getMatchTier(m.league_name || '');
    if (tier && tier.rank) {
      // rank 1(最高)→100 … rank 5(最低)→20；按 (6-rank)*20 映射对手强度
      strengthSum += (6 - tier.rank) * 20;
      strengthCount++;
      if (tier.rank >= 3) bigStage++;
    }
    if (m.start_time && (nowSec - m.start_time) < WINDOW) recent90++;
  });

  const winRate = Math.round((wins / list.length) * 100);
  const avgMargin = marginSum / list.length;
  const marginScore = Math.max(0, Math.min(100, Math.round(avgMargin / 25 * 100)));
  const strength = strengthCount ? Math.round(strengthSum / strengthCount) : 50;
  const activity = Math.min(100, Math.round((recent90 / 15) * 100));
  const bigStagePct = Math.round((bigStage / list.length) * 100);

  return [winRate, marginScore, strength, activity, bigStagePct];
}

Page({
  data: {
    teamA: null,
    teamB: null,
    loading: true,
    error: '',
    x: 0,
    y: 0,
    total: 0,
    pctA: 50,            // 主队（左）条形宽度 %
    tags: [],
    history: [],         // 历次交锋（最近在前）
    groups: [],          // 3.2 按年份分组的折叠面板数据
    activeGroups: [],    // 当前展开的年份（受控）
    matchCount: 0,
    // 3.3 双方近期状态雷达（从各自全量近期赛事聚合）
    radarIndicators: [],
    radarSeries: []
  },

  onLoad(options) {
    const a = options.teamA;
    const b = options.teamB;
    if (!a || !b) {
      this.setData({ loading: false, error: '缺少对战双方参数' });
      return;
    }
    this.teamAId = String(a);
    this.teamBId = String(b);
    this.load();
  },

  load() {
    this.setData({ loading: true, error: '' });
    Promise.all([
      api.getTeam(this.teamAId),
      api.getTeam(this.teamBId),
      api.getTeamMatches(this.teamAId),
      api.getTeamMatches(this.teamBId)
    ].map((p) => p.catch(() => null)))   // P3-4：单源失败降级 null，不拖垮整页（下游已有 ||{} / ||[] 兜底）
      .then(([ta, tb, matchesA, matchesB]) => {
        const mA = ta || {};
        const mB = tb || {};
        const teamA = {
          id: this.teamAId,
          name: mA.name || '战队 A',
          logo: mA.logo_url || '',
          tag: mA.tag || ''
        };
        const teamB = {
          id: this.teamBId,
          name: mB.name || '战队 B',
          logo: mB.logo_url || '',
          tag: mB.tag || ''
        };

        const vs = (matchesA || []).filter(
          (m) => String(m.opposing_team_id) === this.teamBId
        );

        let x = 0;
        let y = 0;
        const history = vs
          .map((m) => {
            const won = m.radiant === m.radiant_win;
            if (won) x++; else y++;
            const tier = sources.getMatchTier(m.league_name || '');
            const leagueDN = sources.leagueDisplayName(m);
            const ownScore = m.radiant ? m.radiant_score : m.dire_score;
            const oppScore = m.radiant ? m.dire_score : m.radiant_score;
            const year = m.start_time ? new Date(m.start_time * 1000).getFullYear() : 0;
            return {
              match_id: m.match_id,
              league: leagueDN,
              displayName: leagueDN,
              tierLabel: tier ? tier.label : '',
              tierClass: tier ? 'tier-' + tier.grade.toLowerCase() : '',
              date: util.formatTime(m.start_time),
              year: year,
              // 3.2 关键场次高亮：S 级以上赛事（rank≥3）标记为关键场
              isKey: !!(tier && tier.rank >= 3),
              won: won,
              score: ownScore + ':' + oppScore
            };
          })
          .sort((p, q) => (q.match_id || 0) - (p.match_id || 0)); // 最近在前

        // 3.2 按年份分组（保持最近在前），用于折叠面板
        const groupsMap = {};
        const groupOrder = [];
        history.forEach((h) => {
          const yk = h.year || '未知';
          if (!groupsMap[yk]) { groupsMap[yk] = []; groupOrder.push(yk); }
          groupsMap[yk].push(h);
        });
        const groups = groupOrder.map((yk) => ({
          year: yk,
          count: groupsMap[yk].length,
          matches: groupsMap[yk]
        }));
        // 默认仅展开最近一个年份，其余折叠，体现折叠能力
        const activeGroups = groups.length ? [String(groups[0].year)] : [];

        const total = x + y;
        const pctA = total ? Math.round((x / total) * 100) : 50;
        const tags = buildTags(x, y, history);

        // 3.3 双方近期状态雷达：基于各自全量近期赛事聚合 5 维
        const radarIndicators = [
          { name: '胜率', max: 100 },
          { name: '净胜分', max: 100 },
          { name: '对手强度', max: 100 },
          { name: '近期密度', max: 100 },
          { name: '大赛占比', max: 100 }
        ];
        const formA = computeForm(matchesA);
        const formB = computeForm(matchesB);
        const radarSeries = [
          { name: teamA.name, color: '#C8A951', data: formA },
          { name: teamB.name, color: '#58a6ff', data: formB }
        ];

        this.setData({
          teamA: teamA,
          teamB: teamB,
          x: x,
          y: y,
          total: total,
          pctA: pctA,
          tags: tags,
          history: history,
          groups: groups,
          activeGroups: activeGroups,
          matchCount: history.length,
          radarIndicators: radarIndicators,
          radarSeries: radarSeries,
          loading: false
        });

        // 3.4 异步增强队名展示：用 curation 规范名覆盖 OpenDota 原始队名
        // （如 OpenDota 的 "Team liquid" 统一显示为 curation 的 "Team Liquid"）
        this.enrichTeamDisplay(teamA, teamB);
      })
      .catch(() => {
        this.setData({ loading: false, error: '加载失败，请检查网络或域名配置' });
      });
  },

  // 点击队标跳对应战队详情
  openTeam(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: '/subpackages/detail/team-detail/team-detail?teamId=' + id });
  },

  // 3.2 折叠面板受控展开
  onCollapseChange(e) {
    this.setData({ activeGroups: e.detail.value || [] });
  },

  // 3.2 下钻：点击单场交锋跳赛事详情
  openMatch(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: '/subpackages/detail/match-detail/match-detail?matchId=' + id });
  },

  retry() {
    this.load();
  },

  // 3.4 异步增强队名/标签展示：用 curation 规范名覆盖 OpenDota 原始名
  // （如 "Team liquid" → "Team Liquid"、"Virtus.pro" → "Virtus.pro" 保持）
  // 成功后路径更新 teamA/teamB 的 name/tag/_curated，wxml 展示时附加核实标记
  enrichTeamDisplay(teamA, teamB) {
    var sources = require('../../../utils/sources.js');
    Promise.all([
      sources.enrichTeamInfo(teamA).catch(function () { return null; }),
      sources.enrichTeamInfo(teamB).catch(function () { return null; })
    ]).then(function (results) {
      var patch = {};
      var rA = results[0];
      var rB = results[1];
      if (rA && rA.name && rA.name !== teamA.name) {
        patch['teamA.name'] = rA.name;
        patch['teamA._curated'] = true;
      }
      if (rA && rA.tag && rA.tag !== teamA.tag) patch['teamA.tag'] = rA.tag;
      if (rB && rB.name && rB.name !== teamB.name) {
        patch['teamB.name'] = rB.name;
        patch['teamB._curated'] = true;
      }
      if (rB && rB.tag && rB.tag !== teamB.tag) patch['teamB.tag'] = rB.tag;
      if (Object.keys(patch).length) {
        try { this.setData(patch); } catch (e) { /* 隔离 */ }
      }
    }.bind(this)).catch(function () { /* 隔离 */ });
  }
});
