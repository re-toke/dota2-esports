// components/match-flow/match-flow.js
// 批次2（2026-08-30）· PRD §4.2 全量比赛流
// 纯展示组件：状态筛选 chips + 比赛卡片列表（LIVE 红脉冲 / 倒计时 / 终局比分）+ 空态。
// 数据/筛选/轮询均由页面负责；组件只渲染并回传 filter/cardtap 事件。
// 比分闪光：卡片 flash 字段由页面在轮询比分变化时置位，400ms 后页面清除（keyframe 渐隐）。
Component({
  options: {
    // 允许页面样式类穿透（统一 token）
    addGlobalClass: true
  },

  properties: {
    // 展示卡片数组（页面已按选中日期 + chip 过滤/排序）：
    // [{ key, matchId, leagueId, leagueName, tierLabel, tierClass, boLabel,
    //    teamA: {tag, logo}, teamB: {tag, logo},
    //    scoreA, scoreB, winA, winB,
    //    status: 'live'|'upcoming'|'ended', timeText, countdownText, isFollow, flash }]
    cards: { type: Array, value: [] },
    // 骨架屏
    loading: { type: Boolean, value: false },
    // 当前筛选：'all' | 'live' | 'upcoming' | 'ended'
    activeFilter: { type: String, value: 'all' },
    // 各状态数量：{ live: n, upcoming: n, ended: n }
    counts: { type: Object, value: { live: 0, upcoming: 0, ended: 0 } },
    // 空态文案（无比赛的日期）
    emptyText: { type: String, value: '该日暂无对局，看看其他日期吧' },
    // 数据源降级提示（subReady=false 时 OpenDota 不可用，仅有本地数据）
    degraded: { type: Boolean, value: false }
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
