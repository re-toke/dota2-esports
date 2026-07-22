// utils/config.js
// 集中管理可配置项：订阅消息模板、缓存 TTL、分页大小、限流参数。

module.exports = {
  // 订阅消息模板 id：在微信公众平台「功能 → 订阅消息 → 我的模板」中申请后填入。
  // 留空时，关注功能仅做本地收藏，不会弹出微信订阅授权（避免无模板时崩溃）。
  subscribeTemplateId: '',

  // 缓存 TTL（秒）。调大可减少 OpenDota 请求，调小可获取更实时数据。
  // 注意：本项目的「新鲜窗口(freshSec)」由 api.cachedFresh 使用，硬 TTL 仅作为最终兜底。
  cacheTTL: {
    leagues: 6 * 3600,        // 全部赛事列表（变化慢，缓存久）
    leagueWindows: 2 * 3600,  // explorer 聚合的赛事时间窗口（earliest/latest/count）
    leagueMatches: 30 * 60,   // 单赛事比赛（cachedFresh 新鲜窗口 10min，硬 TTL 30min）
    team: 6 * 3600,           // 战队详情（新鲜窗口 1h）
    teamPlayers: 3 * 3600,    // 战队成员（新鲜窗口 1h）
    teamMatches: 30 * 60,     // 战队比赛历史（新鲜窗口 10min）
    player: 6 * 3600,         // 选手详情（新鲜窗口 1h）
    playerMatches: 30 * 60,   // 选手比赛历史（新鲜窗口 10min）
    heroes: 24 * 3600         // 英雄表（几乎不变）
  },

  // 赛事时间窗口判定（用于「正在进行 / 即将到来」筛选）
  leagueWindow: {
    ongoingBufferSec: 7 * 86400,   // 「正在进行」：最近 N 秒内仍有比赛视为进行中
    upcomingRangeSec: 60 * 86400,  // 「即将到来」：未来两个月内开赛视为即将到来
    // 即将到来 tab 懒加载时，最多查询的赛事数量
    upcomingQueryLimit: 60
  },

  // 列表分页每页条数
  pageSize: 20,

  // OpenDota 限流（约 60 次/分钟）。采用最小间隔策略串行保留槽位。
  rateLimit: {
    minGapMs: 1050,   // 两次请求最小间隔，略大于 1000ms 以保证不破 60/min
    maxRetries: 2,    // 遇到 429 时的最大重试次数
    retryBaseMs: 1500 // 重试退避基数（指数增长）
  },

  // 第二网络数据源：STRATZ（GraphQL，免费 API key，申请见 https://stratz.com/api）。
  // 启用后，sources 将其作为 OpenDota 之外的真实第二来源参与分级与赛程聚合。
  //
  // 配置步骤：
  //   1. enabled: false → true
  //   2. apiKey: '' → 填入申请到的 Key（保持单引号包裹）
  //   3. 保存后点微信开发者工具「编译」（Ctrl+B）重新加载
  //   4. Console 顶部查看 [stratz] ✅ ENABLED: true 确认生效
  // 常见错误：未重新编译不生效、Key 无效 → Console 看 [stratz] HTTP 401
  stratz: {
    enabled: true,
    apiKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJTdWJqZWN0IjoiZDlkZjAzNGQtMDdlYy00ZGUzLTkzYTktZGJhYmFhYTc3OWFhIiwiU3RlYW1JZCI6IjE3NzUzNzU0MCIsIkFQSVVzZXIiOiJ0cnVlIiwibmJmIjoxNzg0NjMxMDA2LCJleHAiOjE4MTYxNjcwMDYsImlhdCI6MTc4NDYzMTAwNiwiaXNzIjoiaHR0cHM6Ly9hcGkuc3RyYXR6LmNvbSJ9.ic7GBS5tAVm0VCgYP_1ZUSskpj5piSyaDwZLq2pbE3g',
    base: 'https://api.stratz.com/graphql'
  },

  // 多数据源：分级/名称/时间/成员 走 consensus 交叉验证（sources.js 显式构建候选列表），
  // logo/头像 仍按优先级回退；直播 从所有启用的源收集后去重合并。
  sources: {
    livePriority: ['steam', 'stratz']  // 直播/进行中比赛来源（多源合并去重时保留原序）
  },

  // 第三网络数据源：Steam Web API（Valve 官方，免费 key，申请见 https://steamcommunity.com/dev/apikey）。
  // 提供 GetLiveLeagueGames（正在直播的职业赛）等官方接口，作为 OpenDota/STRATZ 的交叉补充。
  steam: {
    enabled: false,
    apiKey: '',
    base: 'https://api.steampowered.com/IDOTA2Match_570'
  },

  // 远程 curation 配置（可选）：填入 url 后，小程序启动时自动拉取远端 JSON
  // 覆盖/追加本地 CURATED_EVENTS / CURATED_TEAMS，实现不发版热更新。
  // url 为空时仅用本地，不做任何网络请求。
  remoteCuration: {
    url: '',
    ttlSec: 6 * 3600
  },

  // CloudBase 云函数代理（可选）。启用后优先走云函数（加速 + 共享缓存），
  // 云函数不可用时自动回退直连 OpenDota。需要先开通云开发并部署云函数。
  cloudProxy: {
    enabled: false
  }
};
