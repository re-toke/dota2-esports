// utils/leagues-local-data.js
// leagues-local.json 的 JS 包装模块（由 scripts/sync/fetch-leagues-snapshot.js 自动生成，请勿手动修改）
//
// 背景：微信小程序分包直接 require 主包 JSON 存在兼容性问题（返回 null），
//   改为 JS 模块导出，在主包/分包中 require 均稳定可靠（同 upcoming-local-data.js 模式）。
// 用途：列表页 loadLeagues 快照秒开（P2-2）—— 网络数据到达后全量替换。
// 刷新：npm run fetch:leagues

module.exports = {
  "generatedAt": 1788201720,
  "source": "opendota",
  "note": "build-time leagues snapshot (active 90d + curated 60d), refresh via scripts/sync/fetch-leagues-snapshot.js",
  "stats": {
    "total": 10132,
    "kept": 17,
    "windows": 17
  },
  "leagues": [
    {
      "leagueid": 20169,
      "tier": "professional",
      "name": "BLAST Slam VII China Qualifier"
    },
    {
      "leagueid": 19719,
      "tier": "premium",
      "name": "The International 2026"
    },
    {
      "leagueid": 19891,
      "tier": "professional",
      "name": "The International 2026 - Regional Qualifier South America"
    },
    {
      "leagueid": 19892,
      "tier": "professional",
      "name": "The International 2026 - Regional Qualifier Europe"
    },
    {
      "leagueid": 19785,
      "tier": "professional",
      "name": "Esports World Cup 2026"
    },
    {
      "leagueid": 19890,
      "tier": "professional",
      "name": "The International 2026 - Regional Qualifier North America"
    },
    {
      "leagueid": 19885,
      "tier": "professional",
      "name": "Road to ENC 2026 Regional Qualifiers"
    },
    {
      "leagueid": 19699,
      "tier": "professional",
      "name": "Road To EWC 2026 Regional Qualifiers"
    },
    {
      "leagueid": 19893,
      "tier": "professional",
      "name": "The International 2026 - Regional Qualifier China"
    },
    {
      "leagueid": 19894,
      "tier": "professional",
      "name": "The International 2026 - Regional Qualifier Southeast Asia"
    },
    {
      "leagueid": 19101,
      "tier": "professional",
      "name": "BLAST SLAM VII"
    },
    {
      "leagueid": 20009,
      "tier": "professional",
      "name": "1win Essence II"
    },
    {
      "leagueid": 19917,
      "tier": "professional",
      "name": "The Games of the Future 2026"
    },
    {
      "leagueid": 19944,
      "tier": "professional",
      "name": "EPL Masters 2026 "
    },
    {
      "leagueid": 20134,
      "tier": "professional",
      "name": "ExitLag ChampZ: Dota 2"
    },
    {
      "leagueid": 20142,
      "tier": "professional",
      "name": "RES Unchained - A Blast Dota Slam VIII Qualifier EU"
    },
    {
      "leagueid": 20143,
      "tier": "professional",
      "name": "RES Unchained - A Blast Dota Slam VIII Qualifier SEA"
    }
  ],
  "windows": {
    "19101": {
      "earliest": 1779782231,
      "latest": 1780857145,
      "lastEnd": 1780859033,
      "count": 102
    },
    "19699": {
      "earliest": 1780024252,
      "latest": 1780665010,
      "lastEnd": 1780667453,
      "count": 262
    },
    "19719": {
      "earliest": 1786590206,
      "latest": 1787486918,
      "lastEnd": 1787490780,
      "count": 147
    },
    "19785": {
      "earliest": 1783416279,
      "latest": 1784483341,
      "lastEnd": 1784485548,
      "count": 157
    },
    "19885": {
      "earliest": 1782742010,
      "latest": 1782955139,
      "lastEnd": 1782957578,
      "count": 246
    },
    "19890": {
      "earliest": 1782333177,
      "latest": 1782522531,
      "lastEnd": 1782524116,
      "count": 13
    },
    "19891": {
      "earliest": 1781532603,
      "latest": 1781902332,
      "lastEnd": 1781905832,
      "count": 39
    },
    "19892": {
      "earliest": 1782028936,
      "latest": 1782667298,
      "lastEnd": 1782671188,
      "count": 63
    },
    "19893": {
      "earliest": 1781496220,
      "latest": 1781781307,
      "lastEnd": 1781786883,
      "count": 29
    },
    "19894": {
      "earliest": 1781834897,
      "latest": 1782214039,
      "lastEnd": 1782218150,
      "count": 44
    },
    "19917": {
      "earliest": 1785476004,
      "latest": 1785941722,
      "lastEnd": 1785944377,
      "count": 72
    },
    "19944": {
      "earliest": 1784531358,
      "latest": 1788197469,
      "lastEnd": 1788198649,
      "count": 250
    },
    "20009": {
      "earliest": 1785402206,
      "latest": 1785959626,
      "lastEnd": 1785963447,
      "count": 60
    },
    "20134": {
      "earliest": 1787937114,
      "latest": 1788136364,
      "lastEnd": 1788139334,
      "count": 192
    },
    "20142": {
      "earliest": 1787990429,
      "latest": 1788094404,
      "lastEnd": 1788096747,
      "count": 15
    },
    "20143": {
      "earliest": 1787968954,
      "latest": 1788083854,
      "lastEnd": 1788087674,
      "count": 16
    },
    "20169": {
      "earliest": 1787969202,
      "latest": 1788084589,
      "lastEnd": 1788087073,
      "count": 15
    }
  }
};
