// utils/leagues-local-data.js
// leagues-local.json 的 JS 包装模块（由 scripts/sync/fetch-leagues-snapshot.js 自动生成，请勿手动修改）
//
// 背景：微信小程序分包直接 require 主包 JSON 存在兼容性问题（返回 null），
//   改为 JS 模块导出，在主包/分包中 require 均稳定可靠（同 upcoming-local-data.js 模式）。
// 用途：列表页 loadLeagues 快照秒开（P2-2）—— 网络数据到达后全量替换。
// 刷新：npm run fetch:leagues

module.exports = {
  "generatedAt": 1789394694,
  "source": "opendota",
  "note": "build-time leagues snapshot (active 90d + curated 60d), refresh via scripts/sync/fetch-leagues-snapshot.js",
  "stats": {
    "total": 10205,
    "kept": 17,
    "windows": 17
  },
  "leagues": [
    {
      "leagueid": 20159,
      "tier": "excluded",
      "name": "WINLINE Star Series Season 4"
    },
    {
      "leagueid": 19885,
      "tier": "professional",
      "name": "Road to ENC 2026 Regional Qualifiers"
    },
    {
      "leagueid": 19944,
      "tier": "professional",
      "name": "EPL Masters 2026 "
    },
    {
      "leagueid": 19917,
      "tier": "professional",
      "name": "The Games of the Future 2026"
    },
    {
      "leagueid": 19890,
      "tier": "professional",
      "name": "The International 2026 - Regional Qualifier North America"
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
      "leagueid": 19785,
      "tier": "professional",
      "name": "Esports World Cup 2026"
    },
    {
      "leagueid": 19719,
      "tier": "premium",
      "name": "The International 2026"
    },
    {
      "leagueid": 20009,
      "tier": "professional",
      "name": "1win Essence II"
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
    },
    {
      "leagueid": 20144,
      "tier": "professional",
      "name": "RES Unchained - A Blast Dota Slam IX Qualifier SEA"
    },
    {
      "leagueid": 20145,
      "tier": "professional",
      "name": "RES Unchained - A Blast Dota Slam IX Qualifier EU"
    },
    {
      "leagueid": 20169,
      "tier": "professional",
      "name": "BLAST Slam VII China Qualifier"
    }
  ],
  "windows": {
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
      "earliest": 1781628375,
      "latest": 1781902332,
      "lastEnd": 1781905832,
      "count": 30
    },
    "19892": {
      "earliest": 1782028936,
      "latest": 1782667298,
      "lastEnd": 1782671188,
      "count": 63
    },
    "19893": {
      "earliest": 1781582434,
      "latest": 1781781307,
      "lastEnd": 1781786883,
      "count": 21
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
      "latest": 1789064832,
      "lastEnd": 1789066580,
      "count": 340
    },
    "20009": {
      "earliest": 1785402206,
      "latest": 1785959626,
      "lastEnd": 1785963447,
      "count": 60
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
    "20144": {
      "earliest": 1789178469,
      "latest": 1789299115,
      "lastEnd": 1789303190,
      "count": 17
    },
    "20145": {
      "earliest": 1789200532,
      "latest": 1789301470,
      "lastEnd": 1789304992,
      "count": 12
    },
    "20159": {
      "earliest": 1789043258,
      "latest": 1789324066,
      "lastEnd": 1789326041,
      "count": 27
    },
    "20169": {
      "earliest": 1787969202,
      "latest": 1788084589,
      "lastEnd": 1788087073,
      "count": 15
    }
  }
};
