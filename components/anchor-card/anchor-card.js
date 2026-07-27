// components/anchor-card/anchor-card.js
// 关键指标锚点卡（spec 4.1）：详情页顶部大字号比分 / 胜负 / Tier / 时间。
// 设计为通用组件，match-detail / team-detail / player-detail 均可复用。
Component({
  properties: {
    title: { type: String, value: '' },          // 赛事名 / 战队名 / 选手名
    nameA: { type: String, value: '' },          // 左方名称（天辉 / 主队）
    nameB: { type: String, value: '' },          // 右方名称（夜魇 / 客队）
    scoreA: { type: Number, value: 0 },
    scoreB: { type: Number, value: 0 },
    winSide: { type: String, value: '' },        // 'A' | 'B' | ''（未分胜负/进行中）
    live: { type: Boolean, value: false },       // 进行中则比分显示为「—」、中部显示「进行中」
    tierLabel: { type: String, value: '' },      // Tier 文案，如「S-Tier」
    tierClass: { type: String, value: '' },      // tier-sss / tier-s / tier-a / tier-b
    metaList: { type: Array, value: [] },        // [{ label, value }] 时长/开赛等
    // 单体档案模式（team/player 详情页）：bigValue 存在时渲染居中大数字，而非对战比分
    bigValue: { type: String, value: '' },
    bigLabel: { type: String, value: '' }
  }
});
