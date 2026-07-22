// utils/tiers.js
// 社区分级规则（基于赛事名的精选规则，零网络兜底）。
//
// 等级模型：grade 用于展示，rank 用于排序/筛选（越大越高级）
// SSS(4) > S(3) > A(2) > B(1) > C(0)

const COMMUNITY_TIERS = [
  { test: /the\s+international/i, grade: 'SSS', rank: 4, label: 'TI 顶级' },
  // Major（排除 Minor）视为 S 级
  { test: /major(?!.*minor)/i, grade: 'S', rank: 3, label: 'S级' },
  { test: /premier/i, grade: 'S', rank: 3, label: 'S级' },
  // 常见 Premier/A 级职业赛
  { test: /(riyadh\s+masters|esl\s+one|dreamleague|blast\s+slam|the\s+summit|g dexter|betboom|clavision)/i,
    grade: 'A', rank: 2, label: 'A级' },
  { test: /minor/i, grade: 'B', rank: 1, label: 'B级' }
];

// 根据赛事名返回社区等级（兜底规则），未命中返回 null
function communityTierFromName(name) {
  if (!name) return null;
  for (let i = 0; i < COMMUNITY_TIERS.length; i++) {
    if (COMMUNITY_TIERS[i].test.test(name)) {
      return { grade: COMMUNITY_TIERS[i].grade, rank: COMMUNITY_TIERS[i].rank, label: COMMUNITY_TIERS[i].label };
    }
  }
  return null;
}

module.exports = {
  COMMUNITY_TIERS: COMMUNITY_TIERS,
  communityTierFromName: communityTierFromName
};
