// components/skeleton/skeleton.js
// §8.3 自定义骨架屏（2026-07-29）
//
// 替代各页面零散的 loading 文字 / 通用 t-skeleton paragraph，
// 提供与实际页面布局匹配的骨架 + shimmer 动画，提升首屏体感。
//
// 支持的 type：
//   - card    卡片列表骨架（leagues/teams 列表页）
//   - detail  详情页骨架（league/match/team/hero/item detail）
//   - follow  关注卡片横向流骨架（index 首页关注流）
//   - row     简单行骨架（h2h/搜索结果/排名）
//
// 用法：
//   <skeleton type="card" count="5" />
//   <skeleton type="detail" />
//   <skeleton type="follow" />

Component({
  properties: {
    // 骨架类型：card | detail | follow | row
    type: {
      type: String,
      value: 'card'
    },
    // 骨架条目数（card/row 生效，detail/follow 固定布局）
    count: {
      type: Number,
      value: 3
    }
  },

  data: {
    // 生成 [0,1,2,...,count-1] 供 wx:for 渲染
    items: [0, 1, 2]
  },

  observers: {
    'count': function (n) {
      var arr = [];
      var c = Math.max(1, Math.min(n || 3, 20));  // 上限 20，防止异常值
      for (var i = 0; i < c; i++) arr.push(i);
      this.setData({ items: arr });
    }
  },

  lifetimes: {
    attached: function () {
      // 初始化 items
      var arr = [];
      var c = Math.max(1, Math.min(this.data.count || 3, 20));
      for (var i = 0; i < c; i++) arr.push(i);
      if (arr.length !== this.data.items.length) {
        this.setData({ items: arr });
      }
    }
  }
});
