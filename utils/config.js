// utils/config.js
// 集中管理可配置项：订阅消息模板、缓存 TTL、分页大小、限流参数。

// ★★ 2026-10-12（P1-2 双出口 · **唯一事实来源**）：中转候选宿主列表（主 → 备）。
//   客户端**所有**网络出口共用同一台中转（`supabase.url` = `<host>/sb`；`utils/api.js` BASE = `<host>/od/api`），
//   ⇒ 中转挂即全挂（文档 §14.6 单点）。本列表是「出口主机」的唯一声明点：
//     · 主 → 备失败切换 / 会话粘滞 / 开机通道体检 由 `utils/endpoints.js` 负责；
//     · `supabase.url` 由本列表 `[0]` 派生（改这块即改全局出口，勿在别处再写字面量）。
//   ⚠️ **备槽**：2026-10-12 已定「**两台都加**」（用户择定 C），按下面顺序填：
//        [1] = **Deno Deploy 新项目** —— ★★ **实测更正（2026-10-12）**：Deno 现行 scheme
//              **一律给 `*.deno.net`**（`*.deno.dev` 是 **Deploy Classic 的旧域名**，
//              而 Classic 已于 2026-07-20 关停 ⇒ **新项目拿不到 deno.dev**）。
//              ⇒ 它与 [0] **同 provider + 同注册域（deno.net）+ 同 IP** ⇒
//              **只防「主机名级 SNI 阻断」，防不了整域 / 整 provider 故障**。
//        [2] = **Netlify Edge Function**（`*.netlify.app`，已实测国内可达）—— 因 Render 注册被
//              风控挡在"需要银行卡"而改用本方案。⚠️ 其运行时是 **Deno**（与主出口同族）⇒
//              只能防**域名级阻断**（`*.netlify.app` ≠ `*.deno.net`），**防不了"Deno 系整体故障"**；
//              "真正的跨提供商"本轮因无卡未落地。
//      ⚠️ 顺序有讲究：`probe()` 取**第一个可达**、`failover()` 取**下一个**
//          ⇒ 响应更快的放前面（故无冷启动的 Deno 新项目排在 Render 之前）。
//      ⚠️ **加白名单必须早于发版**：每个备域名都要先加进微信后台「request 合法域名」，
//          否则主出口一旦抖动触发 failover，会切到**小程序连不上**的备域 ⇒ 那一跳全失败
//          （虽有自愈：下次请求会再切回主，但会白烧一跳）。
//      未填时 `endpoints.count()===1` ⇒ 切换/体检均为 no-op，行为与改造前等价。
//   ⛔ **绝对不要**填占位符/假域名：`endpoints.js` 只过滤**空串**，非空的假 URL 会被当真候选
//      ⇒ `failover()` 可能切到它、`probe()` 会去打它（等于自伤）。**拿不到真域名就留空串。**
//   ★ 回滚：把 `[0]` 改回 'https://gkticzdaicpdtxheyxsd.supabase.co'（并把 anonKey 填回真值）。
const PROXY_HOSTS = [
  'https://hungry-pike-9907.re-toke.deno.net',       // [0] 主出口（Deno Deploy，现网）★ 2026-10-13 替换旧 tough-ferret-3579（其 App 构建损坏、无法更新，旧项目保留可访问但已不再引用）
  'https://sparkly-gharial-1210.re-toke.deno.net',   // [1] 备①：Deno 新项目（同注册域/同 IP ⇒ 仅防主机名级）
  'https://velvety-llama-a7700e.netlify.app'         // [2] 备②：Netlify（不同注册域 ⇒ 防域名级阻断；运行时是 Deno，与主出口同族）
];

// ★★ 2026-10-13（P1-19 · 时间窗口**单一事实源**）：**跨模块共享**的时间窗口集中在此声明，
//   各消费方一律引用（**勿再在别处内联字面量**，否则阈值会漂移）。模块内**私有**常量不在此列
//   （如首页 POLL_BACKOFF_* / LIVE_WINDOW_SEC / *_FRESH_MS 仅在 pages/index/index.js 内使用，仍留在那里）。
//   ⚠️ 「同名不同义」必须**不同名**：快照年龄存在三个语义互斥的量，历史上都含 "SNAPSHOT...AGE"
//      ⇒ 极易被误改。现按下表区分命名（诊断 SLO 的 24h「目标」与列表的 7d「降权」曾同名不同义）：
//        · SNAPSHOT_TARGET_AGE_SEC（24h）= diagnostics SLO 的**目标新鲜度（尺子）**；
//        · SNAPSHOT_DECAY_AGE_SEC（7d）   = leagues 列表的**降权/提示阈值**（超此不当"主源"）；
//        · SNAPSHOT_UNUSABLE_AGE_SEC（30d）= leagues 列表的**可用性硬门限**（超此完全不用它渲染）。
const LIVE_POLL_SEC = 120;                     // 首页 LIVE 轮询基础间隔（秒）—— 同时定义 cacheTTL.liveMatches（TTL 与之对齐）
const LIVE_STALE_MAX_SEC = 3 * 3600;           // 最后活动已过去仍判「进行中」的上限（sources 降级 + diagnostics SLO 降级收敛）
const SNAPSHOT_TARGET_AGE_SEC = 24 * 3600;     // 快照目标新鲜度（diagnostics SLO 尺子）
const SNAPSHOT_DECAY_AGE_SEC = 7 * 86400;      // 快照降权/提示阈值（leagues 列表）
const SNAPSHOT_UNUSABLE_AGE_SEC = 30 * 86400;  // 快照可用性硬门限（leagues 列表）

module.exports = {
  // ★ 2026-09-25: per-item diagnostic log switch (**default false**).
  // Why: this project repeatedly hit "diagnostic logs left on per-item / hot paths"
  //      (leagueBaseName year-variant, slug hit, merge replace...) which floods the
  //      Console, buries real signals, and makes log-based debugging painful.
  // Convention: **summary logs stay on (1 line per round)**;
  //             **per-item logs must go through this switch**.
  debug: {
    verboseLog: false
  },

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
    statusKey: 'dota2_sub_status',
    // §8.3 云端推送重试（2026-07-29）：失败时的退避重试参数
    //   - retryMax: 最大重试次数（总尝试次数 = 1 + retryMax）
    //   - retryBaseMs: 退避基数（指数增长：base * 2^attempt，如 2000 → 2s/4s/8s）
    //   - retryMaxMs: 单次退避上限，避免过长等待（默认 30s）
    retryMax: 2,
    retryBaseMs: 2000,
    retryMaxMs: 30000
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
    search: 5 * 60,           // 战队搜索（O-4：与 searchTeams direct 硬编码 5min 对齐）
    heroes: 24 * 3600,        // 英雄表（几乎不变）
    proMatches: 5 * 60,       // 近 100 场职业赛（批次2 首页比赛流主体；已结束比分）
    // ★ 2026-10-13（方案 A · 口径对齐）：**60 → 120**。原注释「60s 与页面轮询同频」是**错的**——
    //   首页 `_startMatchPolling` 的基础间隔是 `POLL_BASE_MS = 120s`（`pages/index/index.js`），
    //   而 TTL 60s < 120s ⇒ 缓存**永远拦不住轮询**，每次轮询必实拉一次 `/live`（实测单次 **142KB**）。
    //   ⚠️ 对齐到 120s 后**边界仍可能 miss**（`expireAt == now`）⇒ 这一步主要是**口径正确性**；
    //   若要连「每次轮询都实拉」也省掉，需把 TTL 设到 **> 轮询间隔**（代价：比分最大陈旧度翻倍）——
    //   属产品取舍，**暂不做**（见方案文档 §5.5）。
    liveMatches: LIVE_POLL_SEC   // 全部进行中比赛（LIVE 比分；= 首页轮询间隔，单一事实源见顶 LIVE_POLL_SEC）
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
    // 2026-08-13 复核修正：120 → 40。原因——Liquipedia 限流为模块级全局串行
    // （liquipedia.js lastCall 槽位共享），并发改造无效，只能降量提速；
    // 40 已覆盖 S/A 级核心赛事（云缓存 + 本地快照 + curation 注入兜底其余）。
    // ★ 2026-09-01（P0-L1 三维护核修订）：40 → 15。理由——curation + 本地快照
    //   （upcoming-local.json）+ haglund 云代理已覆盖绝大部分 S/A 级赛事，串行查询只是
    //   最后的兜底补漏；40 个候选 × Liquipedia 2.2s 限流最坏 88s，用户不可接受。
    //   降为 15 后最坏 33s（实际本地源命中后只查 0-3 个，秒级）。配合
    //   loadUpcomingSerial 的 rank>=2 或 isKnownEvent 候选过滤，B/C 级不再串行查询。
    upcomingQueryLimit: 15,
    // 2026-08-13（「即将」加载优化 · P0）：服务端（EF）调用超时（ms）。EF 冷缓存现场预热
    // 可达 30-60s，超时后客户端降级本地快照 + curation 注入，保证 loading 必复位。
    upcomingTimeoutMs: 8000,
    // 2026-08-21 新增：赛事窗口最大合理跨度（秒）。
    // 用于拦截 OpenDota 被滥用的 leagueid（如 16251 Party To Play league，
    // 920 天里被挂 836 场杂乱对局）。当 earliest/lastEnd 跨度超过此阈值，
    // 且该赛事未在 curation 权威库中（即非人工策展赛事），视为脏数据，
    // validateLeagueWindow 会清零窗口字段让它从列表消失。
    // 阈值取 365 天：DPC 整赛季约 4 个月、最长 TI 周期约 11 天，
    // 真实职业赛事没有跨年举行的；保留 1 年余量足够覆盖任何正式赛事。
    maxSpanSec: 365 * 86400
  },

  // 列表分页每页条数
  // 2026-08-07：30 → 20，配合渲染分阶段快速路径减少首屏 setData 条数（B 层优化）。
  pageSize: 20,

  // OpenDota 限流（约 60 次/分钟）。采用滑动窗口并发模式：窗口内最多 maxPerMin 次请求，
  // 允许并发，仅在窗口满时排队等待（替代原串行 minGapMs 策略，让 Promise.all 真正并行）。
  rateLimit: {
    maxPerMin: 50,       // 窗口内最大请求数（OpenDota 限制 60，留 10 余量）
    timeoutMs: 20000,    // 单请求超时（ms），避免 hang 住请求阻塞队列
    // ★ 2026-10-10：12000 → **20000**。依据：开发者工具隔离测量显示「小程序 → 中转」有 ~10s 固定开销
    //   （连纯本地的 /healthz 都要 10.9s，而 node 侧同域名仅 0.8s），叠加真实工作后 12s 会被大量误判超时
    //   （赛事详情页数据全空即由此而来）。⚠️ 真机复测后可按实测回调。
    maxRetries: 2,       // 遇到 429 时的最大重试次数
    retryBaseMs: 1500    // 重试退避基数（指数增长）
  },

  // 第二网络数据源：STRATZ（GraphQL，免费 API key，申请见 https://stratz.com/api）。
  // 启用后，sources 将其作为 OpenDota 之外的真实第二来源参与分级与赛程聚合。
  //
  // ★★ 安全基线（见 OPTIMIZATION_PLAN.md T1）★★
  //   apiKey 不再以明文存放在客户端！改由服务端（Supabase EF）以环境变量注入 STRATZ_API_KEY。
  //   客户端只声明「需要 key」，具体密钥由 EF（supabase/functions/stratz-proxy）在服务端注入。
  //   直连模式（开发调试 fallback）仍可在 EF 不可用时回退——但此时需本地填 key，
  //   且 key 仅用于本地调试，绝不上传到仓库/生产客户端。
  //
  // 服务端代理模式（上线推荐，默认开启）：
  //   1. enabled: true（apiKey 留空或不填）
  //   2. cloudProxy.enabled: true（见下方 cloudProxy）
  //   3. EF 环境变量配 STRATZ_API_KEY
  //   4. 部署 EF，Console 查看 [stratz] ✅ ...
  //   → 所有 STRATZ 请求经 EF 中转，key 从环境变量读取，客户端零明文
  //
  // 常见错误：未重新编译不生效、Key 无效 → Console 看 [stratz] HTTP 401
  //
  // ★★ 2026-08-24 恢复启用 ★★
  //   2026-07-30 因 STRATZ Cloudflare 反爬虫挑战页拦截而停用；
  //   2026-08-24 实测 Cloudflare 拦截已解除（返回标准 Kong API Gateway 401，
  //   不再是 "Just a moment..." 挑战页）。带有效 Bearer token 实测全部查询通过。
  //   同步修复了 utils/stratz.js 与服务端（EF）的 GraphQL schema 变更：
  //     - team(id:) → team(teamId:)
  //     - team.players → team.members，personaname → name
  //     - team.logoUrl → team.logo
  //     - match.radiantWin → match.didRadiantWin，duration → durationSeconds
  //     - league.matches 必须带 request: {take, skip} 参数
  //   STRATZ 补回 Liquipedia 失效后的部分数据缺口：赛事等级、战队名册、战队 LOGO、
  //   队员头像、赛事时间窗、已结束对阵（增量补充 OpenDota）。
  stratz: {
    enabled: true,  // 2026-08-24 恢复（Cloudflare 拦截解除 + schema 适配完成）
    // 客户端不持有任何密钥（小程序运行时无 process 全局变量，不能读 process.env）。
    // KEY 一律由服务端（EF stratz-proxy）环境变量 STRATZ_API_KEY 注入。
    // 客户端走 cloudProxy 中转，apiKey 留空；本地调试直连时也不应在此填明文 key。
    apiKey: '',
    base: 'https://api.stratz.com/graphql'
  },

  // 多数据源：分级/名称/时间/成员 走 consensus 交叉验证（sources.js 显式构建候选列表），
  // logo/头像 仍按优先级回退。
  sources: {},

  // 第三网络数据源：Steam Web API（Valve 官方，免费 key，申请见 https://steamcommunity.com/dev/apikey）。
  // 提供赛事奖金池/战队官方信息/比赛详情等接口，作为 OpenDota/STRATZ 的交叉补充。
  // ★ 安全：与 STRATZ 一样，Steam key 不再明文存放在客户端，改由服务端（EF）环境变量 STEAM_API_KEY 注入。
  //   steam.js 在 cloudProxy 启用时走 EF steamProxy action；直连模式仅作本地调试 fallback。
  steam: {
    enabled: true,
    // 同上：客户端不持有密钥，KEY 由服务端（EF steam-proxy）环境变量 STEAM_API_KEY 注入。
    // 云代理启用时走 EF steamProxy action；直连 fallback 仅本地调试用，不填明文 key。
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
    // 已恢复：通过服务端代理（Supabase EF liquipedia-proxy）设置合规 User-Agent（微信端禁止
    // wx.request 设置 UA），规避历史 IP 封禁问题。启用后作为独立于 Valve 比赛数据的交叉来源。
    enabled: true,
    base: 'https://liquipedia.net/dota2/api.php',
    userAgent: require('./lp-ua.js').LP_UA,   // ★ 单点：utils/lp-ua.js（LP ToS 要求标识项目 + 联系方式）
    rateLimitMs: 2200,   // 官方要求 ≥ 2 秒，留 200ms 余量
    cacheTTL: 6 * 3600,
    // 赛程缓存 TTL（对阵 LIVE/UPCOMING/RECENT 用，2026-08-03 优化）：
    // 原 30min 双层缓存（客户端 + 服务端）叠加最坏 60min 旧数据；
    // 缩至 5min 提升及时性，配合详情页 30-60s 定时刷新（force）达到近实时。
    // 注意：EF 的 liquipediaSchedule TTL 必须与此同步缩短，否则上层白做。
    cacheTtlSchedule: 5 * 60,
    // ★ v8.12（S2）：赛程 stale 兜底窗口（写入侧硬过期 = 读取侧 stale 上限，同常量）。
    //   6h → 24h：每天第一次打开（距上次 >6h）也能秒出昨日排期快照，配合首页
    //   stale 后台 force 刷新（S3）数秒内转新。排期低频变化（对局通常提前数小时~
    //   数天排定），24h 旧数据对首页「即将开始」段仍有价值；详情页 load 后轮询
    //   首刷 force 拉新，不受影响。⚠️ cache.set 写入时 expire 按本值定死——改动
    //   仅影响新写入（存量 6h 条目过期后自动按 24h 重写），上线当天部分场景仍走网络属预期。
    cacheStaleTtlSchedule: 24 * 3600
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

  // Supabase EF 数据代理（上线推荐，默认开启）。★ 2026-09-22：微信云开发已退役，本节由 EF 承接。
  // 启用后：OpenDota 请求优先走 EF（经中转；国内加速 + 共享缓存 + 不暴露数据源），
  // EF 不可用时自动回退直连（api.js cloudFetch 已内置 .catch 回退，不会崩溃）。
  // STRATZ/Steam 的 key 统一由 EF 环境变量注入，客户端零明文（见 T1）。
  // 前置条件：已部署 supabase/functions/ 下各 EF（含 STRATZ_API_KEY / STEAM_API_KEY 环境变量）。
  // 不可用时：EF 调用快速失败并回退直连，不影响基本功能，仅首次请求多一次失败开销。
  cloudProxy: {
    enabled: true,
    // ⚠️ 历史遗留字段（微信云开发环境 ID）：**云开发已退役（2026-09-22）⇒ 已无代码读取**，
    //   保留仅为配置兼容。EF 路由由 `supabase.enabled` 决定，与本字段无关。
    envId: 'cloud1-d2g0wufv8f2ce3871',
    // ⚠️ 2026-10-12（P1-4）：原 cloudBreaker 全局熔断已删除 ⇒ 本字段**不再被任何代码读取**
    //   （保留仅为配置兼容）。EF 失败改由 supabaseClient 的 per-action 熔断负责（阈值 3 / 冷却 2min）。
    circuitBreakerThreshold: 3
  },

  // ★ Supabase 单后端（方案 C+，2026-09-04 决策 / 2026-09-09 后端就绪）。
  // ★ 2026-09-22 起：**微信云开发已退役 ⇒ Supabase EF 是唯一后端**，「云开发回退」已整体移除。
  // enabled=true（现状）：下列链路全部走 Supabase EF；失败**不再回退云开发**（由各自兜底）：
  //   ① 登录 openid      → auth.js ensureOpenId → Edge Function wechat-auth
  //   ② 订阅消息发送     → subscribe.js sendOnce → Edge Function subscribe-send
  //   ③ follow_profile   → cloudCache.js（follow_profile_ 前缀）→ Edge Function follow-profile（带 JWT）
  // 赛事数据（OpenDota/Steam/LP 代理）**同样**走 Supabase EF（opendota/steam/liquipedia-proxy 等，M2.4 已就绪）。
  supabase: {
    // ★ 开关：true=走 Supabase EF（2026-09-09 联调开启，现状）；false 仅作历史回滚位（云开发已退役 ⇒ 无意义）
    enabled: true,
    // ★★ 2026-10-10（真机「数据无法更新」修复）：`*.supabase.co` 在国内被 **SNI 阻断**
    //   （DNS 正常解析、TLS 握手被 RST ⇒ 换 IP/DoH/hosts 全无效）⇒ 客户端改走**中转**。
    //   中转部署在境外边缘（出口在境外 ⇒ 能连上 Supabase），域名国内可达（已实测 TLS OK + 业务接口 200）。
    //   中转代码与部署/自检：`infra/proxy/`（`worker.mjs` + `DEPLOY.md`）。
    //   ⚠️ **不再在此写死主机名**：改为由 `PROXY_HOSTS[0]` 派生（= 与 `utils/api.js` 的 BASE
    //      同一台宿主）。P1-2 后出口切换由 `utils/endpoints.js` 负责，运行时实际出口取其 `sbUrl()`。
    //   ★ 回滚：改 `PROXY_HOSTS[0]`（并把 anonKey 填回真值）——单一改动点。
    url: PROXY_HOSTS[0] + '/sb',
    // anon key（公开密钥，RLS 保护；service_role 绝不出现在客户端）
    // ★ 2026-10-10：**客户端不再持有真实 key** —— 中转会在**服务端注入**（见 infra/proxy/worker.mjs），
    //   顺带消除"客户端 key 写错/过期"这一整类故障（此前正是错的：`eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdrdGljemRhaWNwZHR4aGV5eHNkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg0OTI4NTIsImV4cCI6MjEwNDA2ODg1Mn0.ZzdBSKZskLI-GO-Tz3BsviNg_qNL8OhC1WV9jTJkAe8`）。
    //   ⚠️ **必须是「非空占位」**：`supabaseClient.enabled()` 的判据含 anonKey，
    //      置成空串会让「Supabase 已启用」变 false ⇒ **EF 路径根本不会被调用**。
    anonKey: 'via-proxy',
    // Edge Function 名（部署在 supabase/functions/ 下）
    functions: {
      auth: 'wechat-auth',
      subscribe: 'subscribe-send',
      followProfile: 'follow-profile'
    },
    // 业务 JWT 本地存储 key（wechat-auth 签发，30 天有效；follow-profile 用）
    jwtKey: 'dota2_jwt'
  },

  // ★ 2026-10-12（P1-2 双出口）：中转候选宿主（**单一事实来源**，见文件顶 `PROXY_HOSTS`）。
  //   消费方：`utils/endpoints.js`（失败切换 + 会话粘滞 + 开机体检）；`supabase.url` 由 [0] 派生。
  //   ⚠️ 勿在别处再写中转主机名字面量——否则「切换出口」会漏改那一处（本项目的成对改动坑）。
  endpoints: {
    proxy: PROXY_HOSTS
  },

  // 北京时间偏移（秒）。O-7（2026-08-15）：原 league-detail.js 5 处硬编码 8*3600
  // 收敛为单一常量（零行为提取，值必须保持 8*3600 不变）。
  // 用途：按北京时间计算「今天/明天/更早」的日界分组（dateGroup/timeLayer 等）。
  time: {
    bjOffsetSec: 8 * 3600
  },

  // ★ 2026-10-13（P1-19）：**跨模块共享时间窗口**的单一事实源（值见文件顶 `LIVE_*` / `SNAPSHOT_*` 常量）。
  //   消费方：`utils/sources.js`（liveStaleMaxSec）、`pages/index/index.js`（livePollSec）、
  //   `pages/leagues/leagues.js`（snapshotDecay/UnusableAgeSec）、`utils/diagnostics.js`（SLO 口径）。
  //   ⚠️ 需要时间窗口时请引用此对象，不要再在别处写字面量。
  timeWindow: {
    livePollSec: LIVE_POLL_SEC,
    liveStaleMaxSec: LIVE_STALE_MAX_SEC,
    snapshotTargetAgeSec: SNAPSHOT_TARGET_AGE_SEC,
    snapshotDecayAgeSec: SNAPSHOT_DECAY_AGE_SEC,
    snapshotUnusableAgeSec: SNAPSHOT_UNUSABLE_AGE_SEC
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
    action: 'getExperiments',   // 历史字段（原云函数 action 名）；云开发已退役 ⇒ 现无 EF 承载（见 utils/experiment.js 已移除该调用）
    storageKey: 'ab_flags'      // 本地缓存 key
  },

  // 图片优化（仅 OpenDota CDN 支持 query 尺寸缩放；其他 CDN 原样回源）。
  images: {}
};
