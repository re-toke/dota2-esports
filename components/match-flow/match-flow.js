// components/match-flow/match-flow.js
// 批次2（2026-08-30）· PRD §4.2 全量比赛流
// 纯展示组件：状态筛选 chips + 比赛卡片列表（LIVE 红脉冲 / 倒计时 / 终局比分）+ 空态。
// 数据/筛选/轮询均由页面负责；组件只渲染并回传 filter/cardtap 事件。
// 比分闪光：卡片 flash 字段由页面在轮询比分变化时置位，400ms 后页面清除（keyframe 渐隐）。

// ★ v5（2026-09-01）三段式分段标题（对齐详情页 phase-divider）：
//   「全部」视图下按 live→upcoming→ended 连续段插入分隔符（进行中/即将开始/已结束 + 段计数）。
//   单状态视图（chips 筛选）列表只有一种状态，不显示分隔符（chips 计数已表达）。
const DIVIDER_META = {
  live: { text: '进行中', cls: 'mf-divider--live' },
  upcoming: { text: '即将开始', cls: 'mf-divider--upcoming' },
  ended: { text: '已结束', cls: 'mf-divider--ended' }
};

Component({
  options: {
    // 允许页面样式类穿透（统一 token）
    addGlobalClass: true
  },

  properties: {
    // 展示卡片数组（页面已按选中日期 + chip 过滤/排序，且按 live→upcoming→ended 段序）：
    // [{ key, matchId, leagueId, leagueName, tierLabel, tierClass, boLabel, boText,
    //    teamA: {id, name, tag, logo}, teamB: {id, name, tag, logo},
    //    scoreA, scoreB, winA, winB, statusText, subScoreText,
    //    status: 'live'|'upcoming'|'ended', timeText, countdownText, liveSubText,
    //    isFollow, flash, dots: [{k, t}] }]
    cards: { type: Array, value: [] },
    // 骨架屏
    loading: { type: Boolean, value: false },
    // 当前筛选：'all' | 'live' | 'upcoming' | 'ended'
    activeFilter: { type: String, value: 'all' },
    // 各状态数量（当日全量，chips 角标）：{ live: n, upcoming: n, ended: n }
    counts: { type: Object, value: { live: 0, upcoming: 0, ended: 0 } },
    // 空态文案（无比赛的日期）
    emptyText: { type: String, value: '该日暂无对局，看看其他日期吧' },
    // 数据源降级提示（subReady=false 时 OpenDota 不可用，仅有本地数据）
    degraded: { type: Boolean, value: false }
  },

  data: {
    // 展示副本（observer 加工）：页面 cards 原样 + 段首项分隔符标记。
    //   独立于 cards 渲染，避免修改页面传入的只读数据。
    viewCards: [],
    dividerMap: {}   // { 索引: { text: '进行中 · 3 场', cls: 'mf-divider--live' } }
  },

  observers: {
    // 分段标题加工：cards 已按段序排序 → 每段首项打标记 + 段内计数。
    //   仅「全部」视图生效；单状态视图 viewCards=cards 原样、dividerMap 为空。
    'cards, activeFilter': function (cards, activeFilter) {
      if (!cards || !cards.length || activeFilter !== 'all') {
        this.setData({ viewCards: cards || [], dividerMap: {} });
        return;
      }
      const viewCards = cards.map(function (c) { return Object.assign({}, c); });
      const counts = {};
      viewCards.forEach(function (c) {
        const st = c.status || 'ended';
        counts[st] = (counts[st] || 0) + 1;
      });
      const dividerMap = {};
      const seen = {};
      viewCards.forEach(function (c, i) {
        const st = c.status || 'ended';
        if (seen[st]) return;
        seen[st] = true;
        const meta = DIVIDER_META[st] || DIVIDER_META.ended;
        dividerMap[i] = { text: meta.text + ' · ' + counts[st] + ' 场', cls: meta.cls };
      });
      this.setData({ viewCards: viewCards, dividerMap: dividerMap });
    }
  },

  methods: {
    // 切换筛选 chip → 回传页面
    onChipTap(e) {
      const f = e.currentTarget.dataset.filter;
      if (!f || f === this.data.activeFilter) return;
      this.triggerEvent('filter', { filter: f });
    },

    // 点击比赛卡 → 回传页面（页面按 matchId/leagueId 分流跳转）
    onCardTap(e) {
      const d = e.currentTarget.dataset;
      this.triggerEvent('cardtap', {
        key: d.key,
        matchId: d.matchid,
        leagueId: d.leagueid
      });
    }
  }
});
