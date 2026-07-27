// utils/config.js
// 集中管理可配置项：订阅消息模板、缓存 TTL、分页大小、限流参数。

module.exports = {
  // 订阅消息模板 id：在微信公众平台「功能 → 订阅消息 → 我的模板」中申请后填入。
  // 留空时，关注功能仅做本地收藏，不会弹出微信订阅授权（避免无模板时崩溃）。
  subscribeTemplateId: 'eLHDZtOvcGghXBZnnwcvsO3SX3fBPdB9cz9PKi_NwRQ',

  // 订阅消息相关配置
  subscribe: {
    // 授权弹窗冷却时间（秒）。用户关闭/拒绝后 N 秒内不再弹出，避免骚扰。
    cooldownSec: 86400,       // 24 小时
    // 赛前提醒窗口（秒）：开赛前 N 秒内触发推送
    remindBeforeSec: 1800,    // 30 分钟
    // 每用户每日推送上限
    dailyLimit: 5,
    // 发送记录本地存储 key 前缀
    sendLogKey: 'dota2_sub_send_log',
    // 订阅状态存储 key
    statusKey: 'dota2_sub_status'
  },

  // 缓存 TTL（秒）。调大可减少 OpenDota 请求，调小可获取更实时数据。
  // 注意：本项目的「新鲜窗口(freshSec)」由 api.cachedFresh 使用，硬 TTL 仅作为最终兜底。
  cacheTTL: {
    leagues: 6 * 3600,        // 全部赛事列表（变化慢，缓存久）
    leagueWindows: 2 * 3600,  // explorer 聚合的赛事时间窗口（earliest/latest/count）
    leagueMatches: 30 * 60,   // 单赛事比赛（cachedFresh 新鲜窗口 10min，硬 TTL 30min）
    match: 30 * 60,           // 单场比赛详情（含 players 数组：英雄/KDA/GPM/XPM）
    team: 6 * 3600,           // 战队详情（新鲜窗口 1h）
    teamPlayers: 3 * 3600,    // 战队成员（新鲜窗口 1h）
    teamMatches: 30 * 60,     // 战队比赛历史（新鲜窗口 10min）
    player: 6 * 3600,         // 选手详情（新鲜窗口 1h）
    playerMatches: 30 * 60,   // 选手比赛历史（新鲜窗口 10min）
    heroes: 24 * 3600         // 英雄表（几乎不变）
  },

  // 赛事时间窗口判定（用于「正在进行 / 即将到来」筛选）
  leagueWindow: {
    // 「正在进行」缓冲：真实结束时间(last_end)之后再保留 N 秒仍判为进行中，
    // 用于平滑数据延迟/时钟漂移。注意：仅 2 小时——此前为 7 天，会导致已结束的比赛
    // 在最后一场开赛后整整一周仍显示"进行中"。有了 last_end（真实结束时间）后无需长缓冲。
    ongoingBufferSec: 2 * 3600,   // 「正在进行」：真实结束时间后再保留 2 小时
    // 「即将到来」：未来 N 秒内开赛视为即将到来。
    // 原值 60 天过窄——未开赛的 S 级赛事在 OpenDota /leagues 中无记录，
    // 只能靠 curation 补充；而 Liquipedia 等来源的"即将到来"常覆盖下半年赛程。
    // 放宽到 180 天（约半年），让下半年已公布日期的 Tier 1 赛事都能进入即将到来 tab。
    upcomingRangeSec: 180 * 86400,
    // 即将到来 tab 懒加载时，最多查询的赛事数量（串行补充层上限）。
    // 原 60 偏低：已知 S 级赛事 >60 时，第 61+ 个不进「即将到来」（RC6）。
    // 提到 120，仍受 cloudProxy 的 OpenDota 60/min 限流保护，首查稍慢但覆盖更全。
    upcomingQueryLimit: 120
  },

  // 列表分页每页条数
  pageSize: 30,

  // OpenDota 限流（约 60 次/分钟）。采用滑动窗口并发模式：窗口内最多 maxPerMin 次请求，
  // 允许并发，仅在窗口满时排队等待（替代原串行 minGapMs 策略，让 Promise.all 真正并行）。
  rateLimit: {
    maxPerMin: 50,       // 窗口内最大请求数（OpenDota 限制 60，留 10 余量）
    timeoutMs: 12000,    // 单请求超时（ms），避免 hang 住请求阻塞队列
    maxRetries: 2,       // 遇到 429 时的最大重试次数
    retryBaseMs: 1500    // 重试退避基数（指数增长）
  },

  // 第二网络数据源：STRATZ（GraphQL，免费 API key，申请见 https://stratz.com/api）。
  // 启用后，sources 将其作为 OpenDota 之外的真实第二来源参与分级与赛程聚合。
  //
  // ★★ 安全基线（见 OPTIMIZATION_PLAN.md T1）★★
  //   apiKey 不再以明文存放在客户端！改为读取云函数环境变量 STRATZ_API_KEY。
  //   客户端只声明「需要 key」，具体密钥由 cloudfunctions/aggregation 在 Node 端注入。
  //   直连模式（开发调试 fallback）仍可在云函数不可用时回退——但此时需本地填 key，
  //   且 key 仅用于本地调试，绝不上传到仓库/生产客户端。
  //
  // 云代理模式（上线推荐，默认开启）：
  //   1. enabled: true（apiKey 留空或不填）
  //   2. cloudProxy.enabled: true（见下方 cloudProxy）
  //   3. 云函数环境变量配 STRATZ_API_KEY
  //   4. 部署云函数，Console 查看 [stratz] ✓ cloud ...
  //   → 所有 STRATZ 请求通过云函数中转，key 从环境变量读取，客户端零明文
  //
  // 常见错误：未重新编译不生效、Key 无效 → Console 看 [stratz] HTTP 401
  stratz: {
    enabled: true,
    // 客户端不持有任何密钥（小程序运行时无 process 全局变量，不能读 process.env）。
    // KEY 一律由云函数服务端环境变量 STRATZ_API_KEY 注入（见 cloudfunctions/aggregation）。
    // 客户端走 cloudProxy 中转，apiKey 留空；本地调试直连时也不应在此填明文 key。
    apiKey: '',
    base: 'https://api.stratz.com/graphql'
  },

  // 多数据源：分级/名称/时间/成员 走 consensus 交叉验证（sources.js 显式构建候选列表），
  // logo/头像 仍按优先级回退。
  sources: {},

  // 第三网络数据源：Steam Web API（Valve 官方，免费 key，申请见 https://steamcommunity.com/dev/apikey）。
  // 提供赛事奖金池/战队官方信息/比赛详情等接口，作为 OpenDota/STRATZ 的交叉补充。
  // ★ 安全：与 STRATZ 一样，Steam key 不再明文存放在客户端，改由云函数环境变量 STEAM_API_KEY 注入。
  //   steam.js 在 cloudProxy 启用时走云函数 steamProxy action；直连模式仅作本地调试 fallback。
  steam: {
    enabled: true,
    // 同上：客户端不持有密钥，KEY 由云函数环境变量 STEAM_API_KEY 注入。
    // 云代理启用时走 cloudProxy.steamProxy action；直连 fallback 仅本地调试用，不填明文 key。
    apiKey: '',
    base: 'https://api.steampowered.com/IDOTA2Match_570'
  },

  // 第四网络数据源：Liquipedia（独立人工策展电竞 wiki，MediaWiki action API）。
  // 免费、无需 key，但要求描述性 User-Agent + Accept-Encoding: gzip 并遵守速率限制。
  // 官方要求普通端点 ≤ 1 次/2 秒；action=parse 限流 1 次/30 秒（过严，已弃用）。
  // → 本模块改用 action=query&prop=revisions 取 wikitext（2 秒限流，宽松 15 倍）。
  // 提供 OpenDota/STRATZ/Steam 均无的赛事元数据（规范名/日期/奖金池/地点/赛制/主办方），
  // 作为真正独立于 Valve 比赛数据的交叉验证来源。
  liquipedia: {
    // 已恢复：通过云函数代理（cloudfunctions/aggregation）设置合规 User-Agent（微信端禁止
    // wx.request 设置 UA），规避历史 IP 封禁问题。启用后作为独立于 Valve 比赛数据的交叉来源。
    enabled: true,
    base: 'https://liquipedia.net/dota2/api.php',
    userAgent: 'DOTA2-Esports-Hub/1.0 (WeChat Mini Program; contact: dev@local)',
    rateLimitMs: 2200,   // 官方要求 ≥ 2 秒，留 200ms 余量
    cacheTTL: 6 * 3600
  },

  // 远程 curation 配置（已启用，本地兜底 + 可选热更新）：
  //   - url 为空：仅用内置 curation.js 本地库（离线/首启可用，零网络）。
  //   - 填入 url：启动时自动拉取远端 JSON 覆盖/追加本地赛事/战队，实现不发版热更新。
  // 机制始终生效（remoteCuration.curatedEventFor 与 curation.js 同名接口兼容），
  // 本优化在此启用后用于承载「奖金池/主办方/region/defunct/valve」等扩展字段的热更新。
  remoteCuration: {
    url: '',
    ttlSec: 6 * 3600
  },

  // CloudBase 云函数代理（上线推荐，默认开启）。
  // 启用后：OpenDota 请求优先走云函数（国内加速 + 共享缓存 + 不暴露数据源），
  // 云函数不可用时自动回退直连（api.js cloudFetch 已内置 .catch 回退，不会崩溃）。
  // STRATZ/Steam 的 key 统一由云函数环境变量注入，客户端零明文（见 T1）。
  // 前置条件：已开通云开发并部署 cloudfunctions/aggregation（含 STRATZ_API_KEY / STEAM_API_KEY 环境变量）。
  // 未部署时：所有云调用会快速失败并回退直连，不影响基本功能，仅首次请求多一次失败开销。
  cloudProxy: {
    enabled: true,
    // 微信云开发环境 ID（开通云开发后在「云开发控制台 → 设置 → 环境」复制）。
    // 留空时 wx.cloud.init() 走默认环境（仅当账号下只有一个云环境时有效）；
    // 若账号下有多个环境，必须显式填写，否则真机会报 "env not found"。
    // 填写后会传给 wx.cloud.init({ env })，保证真机/模拟器一致。
    envId: 'cloud1-d2g0wufv8f2ce3871',
    // 连续失败达到阈值后，本会话内暂时停用云代理（避免无云环境时的持续失败开销）。
    // 设为 0 表示不启用熔断（始终尝试云调用）。
    circuitBreakerThreshold: 3
  },

  // T4 实时比分连接配置。
  // url: 后端 WebSocket 中转地址（wss://）。为空 → 客户端自动降级为 30s 轮询 OpenDota，无需后端即可运行。
  // 部署后端后填入，并在微信公众平台配置 wss 域名白名单（见 README「实时比分后端契约」）。
  realtime: {
    url: '',
    pollInterval: 30000,   // 降级轮询间隔(ms)
    heartbeat: 25000,      // WebSocket 心跳间隔(ms)
    maxReconnect: 5        // 超过后降级轮询
  },

  // T6 A/B 实验框架配置。
  experiment: {
    action: 'getExperiments',   // 云函数 aggregation 的 action 名
    storageKey: 'ab_flags'      // 本地缓存 key
  }
};
