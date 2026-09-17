// utils/sources.js
// 多数据源编排层：把「比赛内容来源」做多元化，并让任一源失败都能平滑降级。
//
// 设计升级（本次）：在原有「优先级回退（第一个可用源胜出）」之外，新增
// 「并行采集 + 多源交叉验证（consensus）」能力，针对关键字段做投票/比对：
//   - 赛事名称 getLeagueName        ：OpenDota / 本地精选(curation) / STRATZ 归一投票
//   - 赛事分级 getLeagueTier         ：community / curation / OpenDota / STRATZ 计票
//   - 赛事时间 getLeagueWindow       ：curation / STRATZ / Steam 时间中位数比对
//   - 队伍成员 crossTeamMembers      ：OpenDota / STRATZ 名册按 account_id 交叉比对
//   - 战队扩展 enrichTeamInfo        ：curation(永远可用) / Steam(官方,需 key)
//   - 选手ID  validatePlayerId       ：consensus 提供校验
//
// 参与的来源：
//   - community ：本地精选规则（utils/tiers.js），零网络、永远可用，作为兜底与首选快速分级
//   - curation  ：本地权威库（utils/curation.js），零网络、永远可用，提供规范名/等级/日期提示
//   - opendota  ：OpenDota（主网络源，无需 key）
//   - stratz    ：STRATZ GraphQL（第二网络源，需 apiKey 启用；未启用自动跳过）
//   - steam     ：Steam Web API（Valve 官方，需 apiKey 启用；未启用自动跳过）
//
// 所有源都是「尽力而为」，任一抛错被隔离，绝不影响其它源或页面渲染。

// ★ 2026-08-12 强化版方案（patchNullSeriesId）：series_id 缺失兜底。
//   OpenDota 偶发数据缺陷：BO3 中某局 series_id 漏填为 null（实测 league 19944 出现过），
//   导致 groupSeries 把一场 BO3 拆成两个系列卡。
//   客户端兜底策略：用「队ID对 + 时间夹在邻居系列实际跨度内 + 邻居≥2局 + 邻居 series_type≥1」
//   四重约束借用邻居 series_id，并通过比分越界后校验自动回滚（第五道保险）。
//   紧急情况下可关闭此开关回退到原行为（一行配置，不需回滚代码）。
//   ⚠️ 用 let（非 const）声明：约束⑤回滚时需要临时关闭再恢复（防无限递归）。
let PATCH_NULL_SERIES_ENABLED = true;

const config = require('./config.js');
const tiers = require('./tiers.js');
const util = require('./util.js');
const api = require('./api.js');
const stratz = require('./stratz.js');
const steam = require('./steam.js');
const liquipedia = require('./liquipedia.js');
const consensus = require('./consensus.js');
const curation = require('./remoteCuration.js');
const imageUtil = require('./image.js');
const logoCache = require('./logoCache'); // P2-F：本地队标/头像缓存
// G4 单一数据源：与云函数共用的精确归一映射（来自 curation-shared.js 模块，非 .json）
const leagueCanon = require('./league-canon-map.js');

// upcoming-local.json 快照（在主包中 require，避免分包直接 require JSON 的兼容性问题）
// 分包（如 league-detail）通过 sources.getUpcomingLocalSnapshot() 间接获取，不直接 require JSON
// ★ 2026-07-30 修复：微信小程序对 JSON 的 require 行为不稳定，
//   改用 JS 包装模块（upcoming-local-data.js），JS 模块在主包/分包中 require 均稳定可靠
var _upcomingLocalSnapshot = null;
function loadUpcomingLocalSnapshot() {
  if (_upcomingLocalSnapshot) return _upcomingLocalSnapshot;
  // 优先用 JS 包装模块（稳定可靠），回退到 JSON（Node.js 环境兼容）
  try {
    _upcomingLocalSnapshot = require('./upcoming-local-data.js');
    console.log('[sources] upcoming-local-data.js 加载成功, events:',
      _upcomingLocalSnapshot && _upcomingLocalSnapshot.events ? _upcomingLocalSnapshot.events.length : 0);
  } catch (e) {
    console.error('[sources] upcoming-local-data.js require 失败:', e && e.message);
    try {
      _upcomingLocalSnapshot = require('./upcoming-local.json');
      console.log('[sources] upcoming-local.json 兜底加载成功, events:',
        _upcomingLocalSnapshot && _upcomingLocalSnapshot.events ? _upcomingLocalSnapshot.events.length : 0);
    } catch (e2) {
      console.error('[sources] upcoming-local.json require 也失败:', e2 && e2.message);
      _upcomingLocalSnapshot = null;
    }
  }
  return _upcomingLocalSnapshot;
}
function getUpcomingLocalSnapshot() { return loadUpcomingLocalSnapshot(); }
// G8 运行时监控（安全降级，无 wx 时不打点）
const monitor = require('./monitor.js');

// ===== §9 P3-B3 STRATZ 健康度追踪（2026-07-30）=====
// 痛点：STRATZ 可能被 Cloudflare 拦截，每次调用失败浪费一次网络请求 + 增加页面加载耗时。
//      原设计每个 .catch 隔离错误，但无法避免「明知不可用仍每次重试」的开销。
// 方案：模块级变量追踪连续失败次数，达到阈值后本会话跳过 STRATZ 调用。
//      成功一次即复位（STRATZ 恢复后自动重新启用）。
//      与 cloudBreaker.js 区别：cloudBreaker 针对云函数整体，此处针对 STRATZ 单源。
const STRATZ_FAIL_THRESHOLD = 3;  // 连续失败 3 次后跳过
let _stratzFails = 0;
let _stratzSkippedUntil = 0;     // 跳过截止时间戳（ms），0=不跳过

// STRATZ 是否可用：未启用 / 连续失败达阈值 且未过冷却期 → false
// O-10（2026-08-15）：STRATZ 调用点统一短路标注。
//   现状：config.stratz.enabled=false（2026-07-30 起，Cloudflare 反爬虫 403 拦截，
//   本地直连与云函数代理均被 "Just a moment..." 挑战页拒绝，非 key 问题）。
//   因此 stratz.ENABLED 恒为 false，本函数第一行即短路返回——下方 6 处调用点
//   （getLeagueTier/getLeagueDisplayName/getLeagueWindow/getTeamLogo/getPlayerAvatar/
//   getTeamRoster）的 `stratzHealthy() &&` 条件永假，运行时零请求零成本。
//   ⚠️ 勿仅改 config.stratz.enabled=true 恢复 STRATZ：需先验证 Cloudflare 封锁是否解除，
//   否则会重新触发逐次 403 失败（熔断器会兜底，但无谓消耗）。
function stratzHealthy() {
  if (!stratz.ENABLED) return false;
  if (_stratzFails < STRATZ_FAIL_THRESHOLD) return true;
  // 达到阈值，检查是否过了冷却期（5 分钟后允许重试一次）
  const now = Date.now();
  if (now < _stratzSkippedUntil) return false;
  return true;  // 冷却期已过，允许尝试一次
}

// STRATZ 调用结果回调：成功复位，失败累计
function markStratzResult(ok) {
  if (ok) {
    if (_stratzFails !== 0) _stratzFails = 0;  // 成功一次即复位
    _stratzSkippedUntil = 0;
  } else {
    _stratzFails++;
    if (_stratzFails >= STRATZ_FAIL_THRESHOLD) {
      _stratzSkippedUntil = Date.now() + 5 * 60 * 1000;  // 5 分钟冷却
      console.warn('[sources] STRATZ 连续失败 ' + _stratzFails + ' 次，本会话暂停 5 分钟');
    }
  }
}

// 源中文名（用于 UI 标注数据来源 / 可信度）
const SOURCE_LABEL = {
  community: '本地精选',
  curation: '权威库',
  stratz: 'STRATZ',
  opendota: 'OpenDota',
  steam: 'Steam',
  liquipedia: 'Liquipedia'
};

function labelOf(src) { return SOURCE_LABEL[src] || src; }
function joinedLabels(sources) {
  return (sources || []).map(labelOf).join('/') || labelOf('opendota');
}

// 将 Liquipedia 返回的日期文本（如 '2025-08-15' / 'August 15, 2025'）归一为 Unix 秒。
// consensus.voteTime 只接受数值候选（normNum > 0），故 Liquipedia 的字符串日期必须先转换。
// 解析失败返回 null（该候选被跳过，不影响其它源）。
function liquipediaDateToUnix(text) {
  if (!text) return null;
  const s = String(text).trim();
  // 优先匹配 yyyy-MM-dd / yyyy/M/d（Liquipedia infobox 最常见的纯数字日期）
  const m = s.match(/(\d{4})[-/](\d{1,2})(?:[-/](\d{1,2}))?/);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = m[3] ? Number(m[3]) : 1;
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      return Math.floor(Date.UTC(y, mo - 1, d) / 1000);
    }
  }
  // 回退：英文日期 'August 15, 2025'（2026-08-03 加固：原 Date.parse 按本地时区
  // 解析无时间字符串，+8 时区会把日期偏移到前一天 16:00 UTC → 赛期 startDate 偏一天。
  // 改为手工解析 + Date.UTC 固定，消除本地时区依赖）
  const em = s.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (em) {
    const MONTHS2 = {
      'january': 0, 'february': 1, 'march': 2, 'april': 3, 'may': 4, 'june': 5,
      'july': 6, 'august': 7, 'september': 8, 'october': 9, 'november': 10, 'december': 11,
      'jan': 0, 'feb': 1, 'mar': 2, 'apr': 3, 'jun': 5, 'jul': 6,
      'aug': 7, 'sep': 8, 'oct': 9, 'nov': 10, 'dec': 11
    };
    const mIdx = MONTHS2[em[1].toLowerCase()];
    const d = Number(em[2]);
    const y = Number(em[3]);
    if (mIdx != null && d >= 1 && d <= 31 && y >= 2000) {
      return Math.floor(Date.UTC(y, mIdx, d) / 1000);
    }
  }
  // 最后兜底：原生 Date.parse（含时分秒的复杂格式）
  const t = Date.parse(s);
  return isFinite(t) ? Math.floor(t / 1000) : null;
}

// ===== 赛事分级：多源计票 =====
// 候选来源：community(本地规则) -> curation(权威库) -> opendota(枚举) -> stratz(启用时) -> liquipedia(启用时)
// §9（2026-07-30）：新增 liquipedia 候选源（方案A：对齐 Liquipedia Tier 体系）
//   - Liquipedia 是人工策展的权威分级，覆盖 community 正则未覆盖的新赛事系列
//   - 复用 getLeagueMetadata 已抓取的 wikitext，零额外网络请求
//   - 映射：Tier 1→S / Tier 2→A / Tier 3→B / Tier 4→C
async function getLeagueTier(league) {
  const name = (league && league.name) || '';
  const leagueId = league && (league.leagueid || league.id);
  const candidates = [];

  const c = tiers.communityTierFromName(name);
  if (c) candidates.push({ grade: c.grade, rank: c.rank, label: c.label, source: 'community' });

  // 传入 leagueId + game 上下文，启用 curation 精确 pin + 跨游戏隔离，
  // 防止 CS2 同名联赛（如「ESL Pro League」）的分级污染 DOTA2 详情页。
  const cu = curation.curatedEventFor(name, { leagueId: leagueId, game: 'dota2' });
  if (cu && cu.tier) candidates.push({ grade: cu.tier.grade, rank: cu.tier.rank, label: cu.tier.label, source: 'curation' });

  const u = util.unifiedTier(league || {});
  candidates.push({ grade: u.grade, rank: u.rank, label: u.label, source: 'opendota' });

  // §9 并行采集 stratz + liquipedia（独立来源，各自隔离错误）
  const tasks = [];

  if (stratzHealthy() && name) {
    tasks.push(
      stratz.getLeagueTier(name)
        .then((s) => { markStratzResult(true); if (s && s.grade) candidates.push({ grade: s.grade, rank: s.rank, label: s.label, source: 'stratz' }); })
        .catch(() => { markStratzResult(false); /* 隔离 */ })
    );
  }

  // §9 Liquipedia Tier（2026-07-30，方案A）：复用 getLeagueMetadata 的 wikitext，
  // 通过 parseLeagueTier 解析 liquipediatier 字段，映射为项目 grade/rank/label。
  // 覆盖 community 正则未覆盖的新赛事系列（CCT / Pinnacle / 1win Series 等）。
  if (liquipedia.ENABLED && name) {
    tasks.push(
      liquipedia.getLeagueTier(name)
        .then((l) => { if (l && l.grade) candidates.push({ grade: l.grade, rank: l.rank, label: l.label, source: 'liquipedia' }); })
        .catch(() => { /* 隔离 */ })
    );
  }

  if (tasks.length) await Promise.all(tasks);

  const r = consensus.consensusTier(candidates);
  r.source = 'consensus';
  r.sourceLabel = joinedLabels(r.sources);
  return r;
}

// ===== 赛事名称：多源归一投票 =====
// ⚠️ G5 收敛：本函数产出的是「跨源共识投票名」，仅用于【匹配 / 索引 / 检索】，
//    **禁止**直接当作 UI 展示名。原因：consensus 的「取更长名」规则在缺乏 curation
//    覆盖时可能选回旧名/错误名（P3 风险依据③）。展示一律走 `leagueDisplayName` /
//    `displayName`（curation canonical 优先，零网络、确定性强）。
//    在 league-detail 中它仅作为「无 curation canonical 时的兜底」参与 finalize 优先级②，
//    绝不作为展示首选。如需检索用候选名，调用本函数；如需展示，调用 leagueDisplayName。
async function voteLeagueNameForMatch(league) {
  const candidates = [];
  const name = (league && league.name) || '';
  const id = league && (league.leagueid || league.id);
  if (name) candidates.push({ value: name, source: 'opendota' });

  // 传入 leagueId + game 上下文，与 getLeagueTier / getLeagueMetadata 保持一致，
  // 启用 curation 精确 pin + 跨游戏隔离（防止 CS2 同名联赛污染投票候选）。
  const cu = curation.curatedEventFor(name, { leagueId: id, game: 'dota2' });
  if (cu) candidates.push({ value: cu.canonical, source: 'curation' });

  // 优化：stratz 和 liquipedia 是独立来源，并行发起，各自隔离错误
  const tasks = [];
  if (stratzHealthy() && id) {
    tasks.push(
      stratz.getLeagueDisplayName(id)
        .then((s) => { markStratzResult(true); if (s) candidates.push({ value: s, source: 'stratz' }); })
        .catch(() => { markStratzResult(false); /* 隔离 */ })
    );
  }
  // Liquipedia：独立人工策展源，提供规范名作为第四候选（与 Valve 数据链路无关）
  if (liquipedia.ENABLED && name) {
    tasks.push(
      liquipedia.getLeagueMetadata(name)
        .then((meta) => { if (meta && meta.canonical) candidates.push({ value: meta.canonical, source: 'liquipedia' }); })
        .catch(() => { /* 隔离 */ })
    );
  }
  if (tasks.length) await Promise.all(tasks);

  const r = consensus.voteName(candidates);
  if (!r.value && name) {
    return { value: name, sources: ['opendota'], confidence: 'low', agreement: 1, total: 1 };
  }
  r.source = 'consensus';
  r.sourceLabel = joinedLabels(r.sources);
  return r;
}

// ===== 赛事时间窗口：多源时间中位数比对 =====
async function getLeagueWindow(league) {
  const name = (league && league.name) || '';
  const startC = [];
  const endC = [];
  const diag = { name: name, curation: null, stratz: null, liquipedia: null };

  const cu = curation.curatedEventFor(name);
  if (cu && cu.start) {
    startC.push({ value: cu.start, source: 'curation' });
    diag.curation = 'hit(' + cu.start + ')';
  } else {
    diag.curation = cu ? 'no-date' : 'miss';
  }
  if (cu && cu.end) endC.push({ value: cu.end, source: 'curation' });

  // 优化：stratz 和 liquipedia 独立来源，并行发起，各自隔离错误
  const tasks = [];

  // STRATZ 当前 schema 不直接提供赛事起止时间，留接口；启用且可用时补充
  if (stratzHealthy() && name) {
    tasks.push(
      stratz.getLeagueWindow(name)
        .then((s) => {
          markStratzResult(true);
          if (s && s.start) {
            startC.push({ value: s.start, source: 'stratz' });
            diag.stratz = 'hit(' + s.start + ')';
          } else {
            diag.stratz = s ? 'no-start' : 'null/fail';
          }
          if (s && s.end) endC.push({ value: s.end, source: 'stratz' });
        })
        .catch(() => { markStratzResult(false); diag.stratz = 'error'; /* 隔离 */ })
    );
  } else {
    diag.stratz = stratz.ENABLED ? (_stratzFails >= STRATZ_FAIL_THRESHOLD ? 'unhealthy' : 'skip(no-name)') : 'disabled';
  }

  // Liquipedia：返回的日期为文本字符串，需经 liquipediaDateToUnix 转为 Unix 秒
  // 才能进入 voteTime（仅接受数值候选）；解析失败的字段被跳过，不影响其它源。
  if (liquipedia.ENABLED && name) {
    tasks.push(
      liquipedia.getLeagueMetadata(name)
        .then((meta) => {
          if (meta) {
            if (meta.startDate) {
              const t = liquipediaDateToUnix(meta.startDate);
              if (t != null) {
                startC.push({ value: t, source: 'liquipedia' });
                diag.liquipedia = 'hit';
              } else {
                diag.liquipedia = 'date-parse-fail';
              }
            } else {
              diag.liquipedia = 'no-date';
            }
            if (meta.endDate) {
              const t = liquipediaDateToUnix(meta.endDate);
              if (t != null) endC.push({ value: t, source: 'liquipedia' });
            }
          } else {
            diag.liquipedia = 'null';
          }
        })
        .catch(() => { diag.liquipedia = 'error'; /* 隔离 */ })
    );
  } else {
    diag.liquipedia = 'disabled';
  }

  if (tasks.length) await Promise.all(tasks);

  // 诊断日志：一次性输出全部源的查询结果
  console.log('[sources.getLeagueWindow]', diag.name, '→',
    'curation:', diag.curation, '| stratz:', diag.stratz, '| liquipedia:', diag.liquipedia,
    '| 最终候选数:', startC.length + endC.length);

  const start = startC.length ? consensus.voteTime(startC).value : null;
  const end = endC.length ? consensus.voteTime(endC).value : null;
  if (start == null && end == null) return null;

  const sources = Array.from(new Set(
    startC.map((c) => c.source).concat(endC.map((c) => c.source))
  ));
  return {
    startDate: start,
    endDate: end,
    source: 'consensus',
    sourceLabel: joinedLabels(sources),
    confidence: sources.length >= 2 ? 'medium' : 'low'
  };
}

// ===== curation 库的「即将到来」补充 =====
// 解决痛点：OpenDota /leagues 接口只返回有比赛记录的赛事；尚未举办的重大赛事
//（如 TI 2026 主赛事）不会出现在 allLeagues 中，导致「即将到来」Tab 无数据可显。
// 本函数遍历 curation 生效事件集合，返回所有 startDate 在未来 N 秒内的赛事
//（不发网络、永远可用），作为 loadUpcomingSerial 的补充数据源。
//
// 入参（可选）：now（unix 秒），不传取当前时间
// 返回：[{ name, startDate, endDate, tier:{grade,rank,label}, year, source:'curation' }]
//       按 startDate 升序
function getUpcomingFromCuration(now) {
  now = now || Math.floor(Date.now() / 1000);
  const horizon = now + config.leagueWindow.upcomingRangeSec;
  const list = [];
  const events = curation.getEffectiveEvents ? curation.getEffectiveEvents() : [];
  (events || []).forEach((ev) => {
    if (!ev || !ev.start) return;
    // 2026-08-13（TI 2026 修复 · P2）：过滤条件与云函数（L837）/本地快照（L878）对齐——
    // 原 `ev.start > now` 严格未来过滤会把「已开赛但 OpenDota 尚未收录」的 curation 赛事
    //（如 TI 2026 开赛日）滤掉，导致「进行中」tab 补充路径（mergeCurationUpcoming）漏该赛事。
    // 改为允许已开赛但未结束（end >= now），与 2026-07-30 修复口径一致。
    // ★ v8.30（EPL II 当天消失修复）：end 比较改**日粒度**——窗口的 end 是日期语义
    //   （条目常存为当天 00:00 UTC），秒级比较会在 end 当天上午（UTC 0 点后）就把
    //   「今天还在打」的赛事判成已结束（实测 EPL Masters II end=9/10T00:00Z，
    //   北京时间 9/10 上午 10 点被滤掉 → ⑥ 段候选无 EPL II → 当天两场对局不显示）。
    const endDay = ev.end ? Math.floor(ev.end / 86400) : null;
    const todayDay = Math.floor(now / 86400);
    if (ev.start <= horizon && (!ev.end || endDay >= todayDay)) {
      // 防御守卫：已开赛（start <= now）但缺 end 的条目无法判定是否结束，跳过
      // （下游 mergeCurationUpcoming 的 cardStatus 判定要求 startDate && endDate 都存在，
      //   缺 end 会落到 'upcoming'，导致已开赛赛事误进「即将到来」tab）。
      if (ev.start <= now && !ev.end) return;
      // F4（2026-08-31）：补 region/prizePool 透传，供首页赛事级卡片渲染赛区/奖金池。
      //   ev 源自 buildEffective 返回的合并事件对象（含 CURATED_EVENTS 全字段），
      //   旧版只透传基础字段，首页无法展示赛区/奖金池。
      list.push({
        name: ev.canonical,
        startDate: ev.start,
        endDate: ev.end || null,
        tier: ev.tier || { grade: 'S', rank: 3, label: 'S级' },
        year: ev.year || null,
        leagueId: (ev.leagueId != null) ? ev.leagueId : null,  // 方案 E：透传真实 id
        region: ev.region || '',           // F4：赛区（如「中国上海」「欧洲/CIS · 线上」）
        prizePool: ev.prizePool || '',     // F4：奖金池（如「$1,600,000」）
        source: 'curation'
      });
    }
  });
  list.sort((a, b) => (a.startDate || 0) - (b.startDate || 0));
  return list;
}

// ===== 赛事元数据：Liquipedia + Steam 聚合 =====
// Liquipedia 提供完整人工策展元数据（规范名/日期/奖金池/地点/赛制/主办方），
// Steam 提供官方奖金池（OpenDota/STRATZ 均无），二者互补且可交叉校验奖金池。
// Liquipedia 优先（人工策展更可靠），Steam 兜底。
async function getLeagueMetadata(league) {
  const name = (league && league.name) || '';
  const id = league && (league.leagueid || league.id);
  const result = { sources: [] };

  // 优化：liquipedia 和 steam 独立来源，并行发起，各自隔离错误
  // 并行安全：Liquipedia 用 Object.assign 设置 prizePool（若有），Steam 仅在 prizePool==null 时兜底；
  // 无论两者完成顺序如何，最终都是 Liquipedia 优先、Steam 兜底
  const tasks = [];

  // Liquipedia: full metadata (canonical name, dates, prize pool, location, format, organizer)
  if (liquipedia.ENABLED && name) {
    tasks.push(
      liquipedia.getLeagueMetadata(name)
        .then((meta) => {
          if (meta) {
            Object.assign(result, meta);
            result.sources.push('liquipedia');
          }
        })
        .catch(() => { /* 隔离 */ })
    );
  }

  // Steam: prize pool (unique to Steam, complements/validates Liquipedia)
  if (steam.ENABLED && id) {
    tasks.push(
      steam.getTournamentPrizePool(id)
        .then((pp) => {
          if (pp && pp.prizePool != null) {
            // Liquipedia 优先（人工策展更可靠），Steam 兜底
            if (result.prizePool == null) {
              result.prizePool = pp.prizePool;
              result.prizePoolCurrency = pp.prizePoolCurrency || 'USD';
            }
            result.sources.push('steam');
          }
        })
        .catch(() => { /* 隔离 */ })
    );
  }

  if (tasks.length) await Promise.all(tasks);

  return Object.keys(result).length > 1 ? result : null;
}

// 多源增强战队 logo：优先级 [本地缓存] -> [直连 existing] -> [stratz] -> [liquipedia 兜底]
// P2-F：命中 logoCache 直接返回（秒出，跳过网络）；最终 URL 经 toLogoUrl（直连 CDN 缩放）。
// §8.3 Liquipedia 兜底（2026-07-29）：前三源均派生自 Valve 数据（同源冗余），
//   OpenDota logo_url 为空时 STRATZ 通常也无数据。Liquipedia 是独立人工策展源，
//   可覆盖 OpenDota 无 logo 的队伍（如 10201538 / 10201970 / 10207521）。
async function enrichTeamLogo(team) {
  const name = (team && team.name) || '';
  const id = (team && team.id);
  const existing = (team && team.logo) || (team && team.logo_url) || '';

  // §8.4 无效队名/无效 id 处理（2026-07-30 修复）：
  //   sources.groupSeries 对 OpenDota 返回的 null team_name 兜底设 '天辉'/'夜魇'，
  //   这些是 UI 占位而非真实战队名。但 id 有效时仍应尝试缓存/STRATZ 拿 logo，
  //   仅跳过 Liquipedia 按名兜底（占位名查 Liquipedia 无意义）。id 无效时直接返回。
  const isPlaceholderName = !name || name === '天辉' || name === '夜魇';
  if (!id) {
    return null;
  }
  if (logoCache && logoCache.hasNegative(id)) {
    return null;  // 已缓存"无 logo"标记，避免重复打 Liquipedia
  }

  // ① 本地缓存优先（仅当本次无直连 existing 时才依赖缓存，避免覆盖更权威的源 URL）
  if (!existing) {
    const cached = logoCache.get(id);
    if (cached && cached.logo) return { logo: cached.logo, source: cached.source };
  }

  if (existing && /^https?:\/\//i.test(existing)) {
    const logo = imageUtil.toLogoUrl(existing);
    logoCache.set(id, logo, 'opendota');
    return { logo, source: 'opendota' };
  }

  if (stratzHealthy()) {
    try {
      const r = await stratz.getTeamLogo(id);
      markStratzResult(!!r);
      if (r && /^https?:\/\//i.test(r)) {
        const logo = imageUtil.toLogoUrl(r);
        logoCache.set(id, logo, 'stratz');
        return { logo, source: 'stratz' };
      }
    } catch (e) {
      markStratzResult(false);
      // G7.4：STRATZ 源失败上报，便于发现 STRATZ 限流/不可用
      monitor.sourceCacheMiss('stratz', 'teamLogo', (e && e.message) || 'error');
    }
  }
  // ④ Liquipedia 兜底（仅当前三源均无 logo 且队名不是 UI 占位时才调用）
  if (liquipedia.ENABLED && !isPlaceholderName) {
    try {
      const r = await liquipedia.getTeamLogo(name);
      if (r && r.logo && /^https?:\/\//i.test(r.logo)) {
        const logo = imageUtil.toLogoUrl(r.logo);
        logoCache.set(id, logo, 'liquipedia');
        console.info('[enrichTeamLogo] liquipedia 兜底成功 id=' + id + ' name=' + name + ' logo=' + logo.substring(0, 60));
        return { logo, source: 'liquipedia' };
      }
      console.warn('[enrichTeamLogo] liquipedia 兜底无结果 id=' + id + ' name=' + name + ' r=' + JSON.stringify(r));
    } catch (e) {
      console.warn('[enrichTeamLogo] liquipedia 兜底异常 id=' + id + ' name=' + name + ' err=' + (e && e.message || e));
      monitor.sourceCacheMiss('liquipedia', 'teamLogo', (e && e.message) || 'error');
    }
  }
  // 标记负命中：避免后续同 id 重复打 Liquipedia
  if (id) logoCache.markNegative(id);
  // G7.4：所有源均未拿到 logo，上报失败（按 team_id 去重）。
  // 降级到 console.info 而非 warn：单源全失败且 Liquipedia 也无结果时属常见情况
  // （如 EWC 缺数据系列），反复 warn 会污染 Console。监控埋点仍走 monitor.logoLoadFailed。
  console.info('[enrichTeamLogo] 全源失败 id=' + id + ' name=' + name + ' existing=' + (existing ? '有但无效' : '空'));
  monitor.logoLoadFailed(id, name, existing ? 'existing_invalid' : 'no_source');
  return null;
}

// 多源增强队员头像：优先级 [本地缓存] -> [直连 existing] -> [stratz]
async function enrichPlayerAvatar(player) {
  const accountId = (player && player.accountId);
  const existing = (player && player.avatar) || '';

  if (!existing && accountId) {
    const cached = logoCache.get(accountId);
    if (cached && cached.logo) return { avatar: cached.logo, source: cached.source };
  }

  if (existing && /^https?:\/\//i.test(existing)) {
    const avatar = imageUtil.toLogoUrl(existing);
    logoCache.set(accountId, avatar, 'opendota');
    return { avatar, source: 'opendota' };
  }

  if (stratzHealthy() && accountId) {
    try {
      const r = await stratz.getPlayerAvatar(accountId);
      markStratzResult(!!r);
      if (r && /^https?:\/\//i.test(r)) {
        const avatar = imageUtil.toLogoUrl(r);
        logoCache.set(accountId, avatar, 'stratz');
        return { avatar, source: 'stratz' };
      }
    } catch (e) { markStratzResult(false); /* 隔离 */ }
  }
  return null;
}

// 多源增强战队扩展信息（规范名/标签/国家/成立时间）：
// curation(永远可用) -> steam(官方，需 key)。返回 { name, tag, country, logo, source, confidence }
async function enrichTeamInfo(team) {
  const info = {};
  const cu = curation.curatedTeamFor(team && (team.id || team.name));
  if (cu) {
    if (cu.name) info.name = cu.name;
    if (cu.tag) info.tag = cu.tag;
    if (cu.country) info.country = cu.country;
    info.source = 'curation';
    info.confidence = 'medium';
  }

  if (steam.ENABLED && team && team.id) {
    try {
      const s = await steam.getTeamInfo(team.id);
      if (s) {
        if (s.name) info.name = s.name;
        if (s.tag) info.tag = s.tag;
        if (s.country) info.country = s.country;
        if (s.logo && /^https?:\/\//i.test(s.logo)) info.logo = s.logo;
        info.source = 'steam';
        info.confidence = 'high';
      }
    } catch (e) { /* 隔离 */ }
  }

  return Object.keys(info).length ? info : null;
}

// 多源交叉验证「队伍成员」：OpenDota / STRATZ 名册按 account_id 主键合并。
// 出现在 >=2 来源的成员标记为 verified（高可信）。返回 consensus.crossMembers 结果。
async function crossTeamMembers(teamId) {
  const lists = [];

  // 优化：三个独立来源并行发起，各自隔离错误
  const tasks = [];

  // OpenDota
  tasks.push(
    api.getTeamPlayers(teamId)
      .then((ps) => {
        if (ps && ps.length) {
          lists.push({
            source: 'opendota',
            members: ps.map((p) => ({ account_id: p.account_id, name: p.name }))
          });
        }
      })
      .catch((e) => { monitor.sourceCacheMiss('opendota', 'teamMembers', (e && e.message) || 'error'); })
  );

  // STRATZ
  if (stratzHealthy() && teamId) {
    tasks.push(
      stratz.getTeamRoster(teamId)
        .then((rs) => { markStratzResult(true); if (rs && rs.length) lists.push({ source: 'stratz', members: rs }); })
        .catch((e) => { markStratzResult(false); monitor.sourceCacheMiss('stratz', 'teamMembers', (e && e.message) || 'error'); })
    );
  }

  // Liquipedia：按战队「名称」查询名册（非 id），故先用 curation 把 teamId 映射到规范队名。
  // 已知限制：Liquipedia 名册 account_id 全部为 null（HTML 不可靠），而 consensus.crossMembers
  // 以 account_id 为主键（normNum 为 null 的成员会被直接 return 丢弃），因此这些成员当前
  // 不会出现在交叉验证结果中、也不会被标记 verified。要让 Liquipedia 名册真正生效，需在
  // consensus.crossMembers 中增加基于 name 的回退匹配（属 consensus.js 改动，本次不动）。
  // 现阶段保留采集以便未来增强，且任一源失败不影响其它源。
  const cu = curation.curatedTeamFor(teamId);
  const teamName = cu && cu.name;
  if (liquipedia.ENABLED && teamName) {
    tasks.push(
      liquipedia.getTeamRoster(teamName)
        .then((rs) => { if (rs && rs.length) lists.push({ source: 'liquipedia', members: rs }); })
        .catch((e) => { monitor.sourceCacheMiss('liquipedia', 'teamMembers', (e && e.message) || 'error'); })
    );
  }

  if (tasks.length) await Promise.all(tasks);

  if (lists.length === 0) return null;
  const r = consensus.crossMembers(lists);
  r.sourceLabel = joinedLabels(r.sources);
  return r;
}

// 选手ID 校验（包装 consensus）
function validatePlayerId(id) {
  return consensus.validatePlayerId(id);
}

// ===== 战队优先级判定（用于 H2H/资料功能优先覆盖 S-Tier 与 TI 参赛队）=====
// 包装 curation.isHighPriorityTeam：返回 { isHighPriority, isTI, tier, label }
//   - tier.grade === 'SSS' → TI 参赛队
//   - tier.grade === 'S'   → S-Tier 顶级战队
//   - 否则 → 普通战队（isHighPriority=false）
function getTeamPriority(nameOrId) {
  const isTI = curation.isTIContestantTeam(nameOrId);
  const cu = curation.curatedTeamFor(nameOrId);
  const t = cu && cu.tier;
  const isHP = isTI || (t && (t.grade === 'SSS' || t.grade === 'S'));
  if (isTI) {
    return { isHighPriority: true, isTI: true, tier: { grade: 'SSS', label: 'TI 参赛' }, label: 'TI 参赛' };
  }
  if (t && t.grade === 'S') {
    return { isHighPriority: true, isTI: false, tier: t, label: t.label || 'S-Tier' };
  }
  return { isHighPriority: false, isTI: false, tier: null, label: '' };
}

// ===== 单场比赛的赛事等级判定（用于 H2H 按 S-Tier 优先聚合）=====
// 包装 tiers.communityTierFromName，返回 { grade, rank, label } 或 null。
// 不发网络，零开销，可直接在 fmtMatch 中调用。
function getMatchTier(leagueName) {
  if (!leagueName) return null;
  const t = tiers.communityTierFromName(leagueName);
  return t || null;
}

// ===== 赛事展示名：curation 规范名覆盖（同步式，零网络）=====
// 集中式覆盖入口：所有 UI 展示赛事名时统一调用本函数。命中 curation 且规范名
// 与原始名不同则返回规范名（如 OpenDota 的 "EPL Masters 2026" → 权威库 "EPL Masters I"），
// 否则原样返回原始名。避免各页面重复内联 curation 查找、降低回归风险，
// 也保证「列表/详情/搜索/关注/对局/推送」所有展示位口径一致。
function canonicalLeagueName(rawName, ctx) {
  const name = (rawName || '').trim();
  if (!name) return name;
  // 2026-07-27：当 ctx 提供 game（跨游戏隔离意图），仅信任动态 curation 引擎
  // （含 leagueId pin + game 校验）；静态映射不带 game 信息，保守跳过，避免
  // 把 CS2 联赛误用 DOTA2 canonical 覆盖。leagueDisplayName 默认传 game='dota2'，
  // 走这条路径。
  if (ctx && ctx.game) {
    const cu = curation.curatedEventFor(name, ctx);
    if (cu && cu.canonical && cu.canonical !== name) return cu.canonical;
    return name;
  }
  // 兼容旧调用（无 ctx 或无 game）：优先静态精确映射（G4），再动态模糊匹配
  const exact = leagueCanon.resolveCanonical(name);
  if (exact && exact !== name) return exact;
  const cu = curation.curatedEventFor(name, ctx);
  if (cu && cu.canonical && cu.canonical !== name) return cu.canonical;
  return name;
}

// ===== 赛事展示名：统一解析器（形状无关，单一出口）=====
// 接受任意 league 对象或原始名字符串，返回 curation 规范名覆盖后的「展示名」。
// 设计目的：把「从对象取字段 + 规范名映射」两步收敛为 1 个数据出口——
//   - 此前各展示位手写 sources.canonicalLeagueName(obj.X)，字段名在
//     .name / .league_name / .league.name / .leagueName 间漂移，正是
//     P3「漏调/错字段」的根因；
//   - 现在所有展示位统一调用 leagueDisplayName(obj)，由本函数负责字段提取，
//     新增展示位只需传入 league 对象，无需记忆字段名，从结构上消除 P3 复发。
// 与 canonicalLeagueName 的分工：canonicalLeagueName 负责「原始名→规范名」单点映射；
// leagueDisplayName 负责「从 league 对象取出原始名，再交给 canonicalLeagueName」。
function leagueDisplayName(league, ctx) {
  let raw = '';
  if (!league) raw = '';
  else if (typeof league === 'string') raw = league;
  else if (league.name) raw = league.name;
  else if (league.league_name) raw = league.league_name;
  else if (league.leagueName) raw = league.leagueName;
  else if (league.league && league.league.name) raw = league.league.name;
  // 2026-07-27：从 league 对象自动抽取 leagueId（OpenDota 联赛/比赛对象上常见字段名），
  // 与调用方传入的 ctx 合并。缺省 game='dota2'（本项目只服务 DOTA2，跨游戏隔离默认开启）。
  const mergedCtx = Object.assign({ game: 'dota2' }, ctx || {});
  if (mergedCtx.leagueId == null && league && typeof league === 'object') {
    const lid = league.leagueid != null ? league.leagueid
      : (league.league_id != null ? league.league_id
      : (league.league && (league.league.id != null ? league.league.id : league.league.leagueid)));
    if (lid != null && !isNaN(Number(lid))) mergedCtx.leagueId = Number(lid);
  }
  const display = canonicalLeagueName(raw, mergedCtx);
  // G8：若仍未命中 curation（展示名==原始名），上报以便发现「应补进 curation 的赛事」
  if (raw && display === raw) monitor.leagueNameUncovered(raw);
  return display;
}

// ===== 赛事排名聚合 =====
// 由 api.getLeagueMatches 提供的已结束比赛聚合每支队伍的胜负，
// 不依赖 Liquipedia（避免 IP 风险）。
// 入参 leagueId；返回 [{ team_id, name, tag, wins, losses, games, winRate }]
// 按 胜场降序 -> 负场升序 排序。
function getLeagueStandings(leagueId) {
  if (!leagueId) return Promise.resolve([]);
  return api.getLeagueMatches(leagueId).then(function (matches) {
    const list = matches || [];
    const stats = {};  // team_id -> { wins, losses, name }
    list.forEach(function (m) {
      const rId = m.radiant_team_id;
      const dId = m.dire_team_id;
      // 数据校验：radiant_win 为 null/undefined（比赛未结束或数据异常）时不计入胜负，
      // 否则 null 走 else 分支会错误计入败场，导致排名偏差。
      const hasResult = (m.radiant_win === true || m.radiant_win === false);
      if (rId) {
        if (!stats[rId]) stats[rId] = { wins: 0, losses: 0, name: m.radiant_team_name || ('Team ' + rId), tag: '' };
        if (hasResult) {
          if (m.radiant_win) stats[rId].wins++;
          else stats[rId].losses++;
        }
      }
      if (dId) {
        if (!stats[dId]) stats[dId] = { wins: 0, losses: 0, name: m.dire_team_name || ('Team ' + dId), tag: '' };
        if (hasResult) {
          if (m.radiant_win) stats[dId].losses++;
          else stats[dId].wins++;
        }
      }
    });
    const out = Object.keys(stats).map(function (id) {
      const s = stats[id];
      const games = s.wins + s.losses;
      return {
        team_id: Number(id),
        name: s.name,
        tag: (s.name || '').slice(0, 4).toUpperCase(),
        wins: s.wins,
        losses: s.losses,
        games: games,
        winRate: games ? Math.round(s.wins / games * 100) : 0
      };
    });
    out.sort(function (a, b) {
      if (b.wins !== a.wins) return b.wins - a.wins;
      return a.losses - b.losses;
    });
    return out;
  }).catch(function () { return []; });
}

// 系列赛聚合：把同一 series_id 的多场比赛归为一个系列卡。
// 优先用 OpenDota 的 series_id（DPC/大型赛事 BO3/BO5 必有）；无 series_id 的单场独立成组（视为 BO1）。
// 返回 series 数组，每个含 { key, games, scoreA, scoreB, boType, isLive, isRecent, isMulti, radiantName, direName, ... }
// boType：series_type 0=BO1 / 1=BO3 / 2=BO5；无 series_type 时按 games 数推断。

// ★ 2026-08-12 强化版：获取 match 的分组键。
//   优先用软关联字段 _patchedSeriesKey（patchNullSeriesId 写入，不动原 series_id），
//   无则回退到原 series_id；无 series_id 则用 match_id 独立成组。
// ★ 2026-09-01 根因 H6 修复：无 series_id 且 match_id 无效（0/null）的 upcoming 排期赛，
//   旧实现一律返回 'm0' → 所有 match_id=0 的排期赛（不同战队对）塌缩进同一组，
//   首页「即将开始」段多队 upcoming 被合并成 1 张卡（v5 series 化的回归，
//   v4.2 _cardFromTeamMatch 用 leagueid+start_time 独立成卡无此问题）。
//   改为「队ID对(升序) + start_time」合成唯一键：同一场（同队对同时刻）仍合并；
//   不同场各自独立成卡。同队对同日的 BO 多局（BO3 局1/局2 均未开赛）由
//   _orphanPairMerge 先行合并（series_type>=1 才参与），此处不重复处理。
function getSeriesKey(m) {
  if (m._patchedSeriesKey) return m._patchedSeriesKey;
  const sid = m.series_id;
  if (sid != null && sid !== 0) return 's' + sid;
  if (m.match_id && m.match_id > 0) return 'm' + m.match_id;
  const a = m.radiant_team_id, b = m.dire_team_id;
  if (a != null && a > 0 && b != null && b > 0 && m.start_time) {
    const lo = a < b ? a : b;
    const hi = a < b ? b : a;
    return 'up_' + lo + '_' + hi + '_' + m.start_time;
  }
  return 'm' + (m.match_id || 0);
}

// ★ 2026-08-22 修复根因 F：孤儿互并段提取为独立函数
//   原因：patchNullSeriesId 的 L842 `if (qualified.length === 0) return matches;`
//   在「所有局都 series_id=0/null」时直接返回，跳过孤儿互并段 → 两局各自独立成卡。
//   提取后让 qualified 为空时也能调用本函数。
//   逻辑：对 series_id 为空/null/0 且未被借邻居的局，按「同队ID对(不计顺序) + 同日」合成共享键。
//   防误并：① 仅同队ID对；② 同日粒度；③ 合成键前缀 'orphan_' 与真实 's<series_id>' 不冲突；
//          ④ series_type >= 1（BO3/BO5）才参与孤儿互并；series_type=0/null 的 BO1 不合并（它们本就是独立的）。
function _orphanPairMerge(matches) {
  var orphanList = [];
  for (var p = 0; p < matches.length; p++) {
    var pm = matches[p];
    if ((pm.series_id == null || pm.series_id === 0) && !pm._patchedSeriesKey) {
      // ★ 2026-08-22 防回归：仅 series_type>=1（BO3/BO5）的局才参与孤儿互并。
      //   series_type=0/null 的局通常是独立 BO1（如小组赛各场独立），不应被合并。
      if (pm.series_type == null || pm.series_type < 1) continue;
      var pA = pm.radiant_team_id, pB = pm.dire_team_id;
      if (pA == null || pA <= 0 || pB == null || pB <= 0) continue;
      var pStart = pm.start_time || 0;
      if (!pStart) continue;
      orphanList.push({ m: pm, A: pA, B: pB, day: Math.floor(pStart / 86400) });
    }
  }
  // ★ 2026-09-01 修复「跨 UTC 午夜的 BO3 被拆成两张卡」：
  //   原分桶键是「队ID对@UTC自然日」，跨午夜的两局（如 23:53Z / 次日 00:23Z）落到
  //   不同桶 → 不合并 → 同一场 BO3 在首页显示成两张独立卡（正是「单局而非整场 BO3」的成因）。
  //   改为：同队ID对的局先按开赛时间排序，再做「相邻局间隔 ≤6h」链式聚类，
  //   与 groupLiquipediaMatches 的跨午夜缝合同口径，彻底摆脱 UTC 日边界。
  var byPair = {};
  orphanList.forEach(function (it) {
    var pk = it.A < it.B ? (it.A + '_' + it.B) : (it.B + '_' + it.A);
    (byPair[pk] || (byPair[pk] = [])).push(it);
  });
  var CHAIN_WINDOW = 6 * 3600;   // 相邻局最大间隔（同 groupLiquipediaMatches 的 6h 链式聚类）
  Object.keys(byPair).forEach(function (pk) {
    var arr = byPair[pk].slice().sort(function (x, y) {
      return (x.m.start_time || 0) - (y.m.start_time || 0);
    });
    if (arr.length < 2) return;
    var cluster = [arr[0]];
    var flush = function () {
      if (cluster.length < 2) return;
      var synKey = 'orphan_' + pk + '@' + Math.floor((cluster[0].m.start_time || 0) / 60);
      cluster.forEach(function (it) {
        it.m._patchedSeriesKey = synKey;
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('[patchNullSeriesId]', { matchId: it.m.match_id, toKey: synKey, reason: 'orphan_pair_chain' });
        }
      });
    };
    for (var i = 1; i < arr.length; i++) {
      var prevStart = cluster[cluster.length - 1].m.start_time || 0;
      var curStart = arr[i].m.start_time || 0;
      if (curStart - prevStart <= CHAIN_WINDOW) {
        cluster.push(arr[i]);
      } else {
        flush();
        cluster = [arr[i]];
      }
    }
    flush();
  });
  return matches;
}

// ★ 2026-08-12 强化版 / 2026-08-22 根因 G 修复：series_id 缺失兜底。
//   遍历 series_id=null 的局，找到「同队ID对（不计顺序）+ 邻居 series_type≥1
//   + 时间夹在邻居实际跨度[first-WINDOW, last+WINDOW]内 + 时间最近」的合格邻居系列，
//   借用其 series_id 写入 _patchedSeriesKey 软关联字段（不动原 series_id，便于审计回滚）。
//   ★ 2026-08-22 根因 G（Iron Wing vs Spirit）：OpenDota 可能给同一 BO3 的局 1 分配 series_id=null、
//     局 2 分配有效 series_id（如 TI 2026 主赛事 leagueid=19719 的 Iron Wing vs Spirit：
//     match_id=8955197224 sid=null（02:36），match_id=8955247801 sid=1132142（04:12）→ null 局在有效局之前 1.6h）。
//     原约束 count>=2 + 前后容差 30min 双重失败：① 单局邻居 count=1 被排除；② null 局早于有效局 1.6h 超出前侧 30min。
//     修复：① series_type>=1 即视为合格（即使 count=1）；② 前后窗口对称放宽到 6h（BO3 局间最长 5h+缓冲）。
//     防误并：① 必须同队ID 对（不计顺序）；② 必须有 series_type≥1（BO3/BO5）；③ 时间窗 6h 上限；
//            ④ 队ID 对不计顺序匹配（BO3 会换边）。
function patchNullSeriesId(matches) {
  if (!PATCH_NULL_SERIES_ENABLED || !matches || matches.length === 0) return matches;
  // ★ 2026-08-22 根因 G：前后对称 6h 窗口（覆盖 BO3 局间最长 5h + 数据延迟）
  const WINDOW_SEC = 6 * 3600;

  // 1. 按 series_id 聚合：统计每个非 null 系列的「首末时间 / 局数 / series_type」
  const seriesStats = {};  // 's1129613' -> { first, last, count, seriesType, teamAId, teamBId }
  for (var i = 0; i < matches.length; i++) {
    var m = matches[i];
    var sid = m.series_id;
    if (sid == null || sid === 0) continue;
    var key = 's' + sid;
    var st = seriesStats[key];
    var t = m.start_time || 0;
    if (!st) {
      seriesStats[key] = {
        first: t, last: t, count: 1, seriesType: m.series_type,
        teamAId: m.radiant_team_id, teamBId: m.dire_team_id
      };
    } else {
      if (t < st.first) st.first = t;
      if (t > st.last) st.last = t;
      st.count++;
    }
  }

  // 2. 构造合格邻居候选清单（约束①②：series_type≥1；★ 2026-08-22 根因 G：count≥1 即可）
  //   原约束 count>=2 在「单局邻居」场景下失效（如 Iron Wing vs Spirit：局 2 有效 sid 但 count=1）。
  //   series_type>=1 已经足够区分 BO1（独立）与 BO3/BO5（需合并）；count 仅用于审计，不再做硬约束。
  var qualified = [];  // [{ key, first, last, seriesType, teamAId, teamBId, count }]
  Object.keys(seriesStats).forEach(function (k) {
    var s = seriesStats[k];
    if (s.seriesType != null && s.seriesType >= 1 && s.count >= 1 &&
        s.teamAId != null && s.teamAId > 0 && s.teamBId != null && s.teamBId > 0) {
      qualified.push({
        key: k, first: s.first, last: s.last, count: s.count,
        teamAId: s.teamAId, teamBId: s.teamBId
      });
    }
  });
  if (qualified.length === 0) {
    // ★ 2026-08-22 修复根因 F：原此处直接 return matches，跳过步骤4（孤儿互并），
    //   导致「所有局都 series_id=0/null」（如 OpenDota 对 TI 2026 BO3 两局都 series_id=0）时，
    //   孤儿互并段不执行 → 两局各自独立成卡 → 同一 BO3 显示两张 BO1。
    //   修复：跳过步骤3（借邻居），但不跳过步骤4（孤儿互并）。
    //   步骤4 只依赖 series_id 为空/null/0 的局本身，不需要 qualified 邻居。
    return _orphanPairMerge(matches);
  }

  // 3. 遍历 series_id=null 的局，找时间最近的合格邻居（约束③④⑤）
  for (var j = 0; j < matches.length; j++) {
    var nm = matches[j];
    if (nm.series_id != null && nm.series_id !== 0) continue;
    // 必须有有效 team_id 对（避免 null===null 误匹配）
    var nA = nm.radiant_team_id, nB = nm.dire_team_id;
    if (nA == null || nA <= 0 || nB == null || nB <= 0) continue;
    var nStart = nm.start_time || 0;
    if (!nStart) continue;

    var bestNbr = null;
    var bestDelta = Infinity;
    for (var k = 0; k < qualified.length; k++) {
      var q = qualified[k];
      // 约束③：null 局时间必须夹在邻居系列 [first-WINDOW, last+WINDOW] 内
      //   ★ 2026-08-22 根因 G：双向对称 6h 窗口，覆盖 null 局在有效局之前或之后的真实场景
      //     （OpenDota 的 null 局可能是 BO3 的局 1 或 局 2，顺序不固定）。
      //     6h 上限足以覆盖 BO3 局间最长 5h + 数据延迟，且能排除「跨日独立场次」（间隔 >6h）。
      if (nStart < q.first - WINDOW_SEC || nStart > q.last + WINDOW_SEC) continue;
      // 约束：队ID 对不计顺序相等（BO3 会换边）
      var sameDirect = (nA === q.teamAId && nB === q.teamBId);
      var sameReversed = (nA === q.teamBId && nB === q.teamAId);
      if (!sameDirect && !sameReversed) continue;
      // 约束④：取时间最近的合格邻居
      var delta = Math.abs(nStart - (q.first + q.last) / 2);  // 到邻居系列中心的距离
      if (delta < bestDelta) {
        bestDelta = delta;
        bestNbr = q;
      }
    }
    if (bestNbr) {
      // ★ 软关联：不动原 series_id，写入 _patchedSeriesKey；可审计 + 可回滚
      nm._patchedSeriesKey = bestNbr.key;
      // 结构化日志（开发期可观测；线上自动收集到 wx 结算日志）
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[patchNullSeriesId]', {
          matchId: nm.match_id, fromSid: null, toKey: bestNbr.key,
          nbrSpan: [bestNbr.first, bestNbr.last], nullStart: nStart,
          reason: 'qualified_neighbor_in_window'
        });
      }
    }
  }
  // 4. ★ 孤儿互并（提取为 _orphanPairMerge，2026-08-22 修复根因 F）：
  //    对 series_id 仍为空/null/0、且未被步骤3借到邻居的局，按「同队ID对(不计顺序) + 同日」合成共享键。
  return _orphanPairMerge(matches);
}

function groupSeries(matches) {
  if (!matches || !matches.length) return [];
  matches = patchNullSeriesId(matches);  // ★ 2026-08-12 强化版入口
  const groups = {};
  const order = [];
  matches.forEach(function (m) {
    const key = getSeriesKey(m);  // ★ 优先用软关联键
    if (!groups[key]) {
      groups[key] = [];
      order.push(key);
    }
    groups[key].push(m);
  });
  const now = Date.now();
  const list = order.map(function (key) {
    const games = groups[key].slice().sort(function (a, b) {
      return (a.start_time || 0) - (b.start_time || 0);
    });
    const first = games[0];
    const last = games[games.length - 1];
    const radiantName = first.radiant_team_name || '天辉';
    const direName = first.dire_team_name || '夜魇';
    // 系列比分按「队」计算，而非按「天辉/夜魇」边。
    // 原因：BO3/BO5 中双方会换边，第 2/3 场的 radiant 可能是首场的 dire。
    // 若按 radiant_win 累加 scoreA，会把换边后 radiant 的胜场错误计入首场 radiant 队，
    // 导致系列比分与胜负方颠倒。这里以首场的 radiant_team_id / dire_team_id 为锚，
    // 逐场用「该场获胜方的 team_id」归属到对应队伍。
    // 数据校验：team_id 必须 > 0 才视为有效锚点，否则 null===null 会误判归属。
    // 当首场 team_id 缺失（数据异常）时，回退到按「天辉/夜魇」边累加，保证不漏计。
    const teamAId = first.radiant_team_id;
    const teamBId = first.dire_team_id;
    const hasValidAnchors = (teamAId != null && teamAId > 0) && (teamBId != null && teamBId > 0);
    let scoreA = 0, scoreB = 0;
    let isLive = false;
    let isUpcoming = false;
    // nowMs 为毫秒，start_time 为秒级 unix；统一换算后比较
    const nowSec = Math.floor(now / 1000);
    games.forEach(function (g) {
      if (hasValidAnchors) {
        // 该场获胜方 team_id：radiant_win=true → radiant_team_id，否则 dire_team_id
        const winnerId = (g.radiant_win != null)
          ? (g.radiant_win ? g.radiant_team_id : g.dire_team_id)
          : null;
        if (winnerId != null && winnerId > 0 && winnerId === teamAId) {
          scoreA++;
        } else if (winnerId != null && winnerId > 0 && winnerId === teamBId) {
          scoreB++;
        } else {
          // team_id 缺失或属第三方（数据异常）时回退到按边累加，保证不漏计
          if (g.radiant_win) scoreA++; else if (g.radiant_win === false) scoreB++;
        }
      } else {
        // 首场 team_id 缺失：无法按队归属，直接按边累加
        if (g.radiant_win) scoreA++; else if (g.radiant_win === false) scoreB++;
      }
      // 进行中：未结算（radiant_win==null）且 start_time 在过去 24h 内
      // 2026-07-30 修复：原判定用 `(!g.duration || g.duration === 0)` 依赖 duration 值，
      //   但 OpenDota 对正在进行的比赛会返回实际持续时间（如 1200s=20min），
      //   非零 duration 导致 isLive 条件不成立，live 比赛被误分类为 recent。
      //   修复：以 radiant_win==null（未结算）为核心标志，结合 start_time 上界守卫。
      const gStartSec = g.start_time || 0;
      if (g.radiant_win == null && gStartSec &&
          gStartSec <= nowSec && (nowSec - gStartSec) < 24 * 3600) {
        isLive = true;
      }
      // 未开赛：未结算（radiant_win=null）且 start_time 在未来
      // 仅当整场都未结算且未开赛时标记，避免与 isLive 冲突
      if (g.radiant_win == null && gStartSec > nowSec) {
        isUpcoming = true;
      }
    });
    // 统一 phase：优先级 live > upcoming > recent
    // 一场未结束的系列赛（isLive）不可能同时有未来场，二者互斥
    // ★ v3 优化项20：精确僵死检测 — 第一层：时间阈值（适用所有 BO 类型，特别是 BO1）
    //   最后一场开赛超 6h 且仍未结算 → 数据异常，降级为 recent
    //   基准：last.start_time（不依赖 duration，因为 live 比赛的 duration 不稳定）
    if (isLive) {
      const lastStartSec = last.start_time || 0;
      if (lastStartSec > 0 && (nowSec - lastStartSec) > 6 * 3600) {
        // 检查倒数第二场是否在 6h 内（如 BO5 中第4场6h前开赛但第5场刚开赛）
        var prevStartSec = games.length > 1 ? games[games.length - 2].start_time || 0 : 0;
        if (!(prevStartSec > 0 && (nowSec - prevStartSec) <= 6 * 3600)) {
          isLive = false;
        }
      }
    }
    let boType = 'BO1';
    const st = first.series_type;
    // ★ 2026-08-22 根因 H（修复 BO3 中途单局独立成 BO1 卡）：
    //   OpenDota 对进行中的 BO3，可能只收录到已结算的第 1 局（局 2 进行中但 OpenDota 收录滞后）。
    //   此时所有已返回的局都已结算（radiant_win!=null）→ isLive=false；又没有未来场 → isUpcoming=false
    //   → phase='recent' → 单局被当成独立 BO1 卡显示在已结束段（比分 1:0 不达 BO3 胜场条件）。
    //   修复：当 series_type≥1（明确标记 BO3/BO5/BO2）且系列比分未达胜场条件时，强制 isLive=true。
    //   防误判：① 仅对 series_type≥1（明确系列赛标记）生效，BO1（series_type=0）不受影响；
    //          ② 必须比分未达胜场条件（已结束 BO3 2:0/2:1 不受影响 → 仍判 recent）；
    //          ③ 时间窗守卫：最后一场结算后不超过 6h（避免历史 BO3 中途异常数据被无限拉成 live）。
    if (!isLive && !isUpcoming && st != null && st >= 1) {
      var _boNumH = { 1: 3, 2: 5, 3: 2 }[st] || 0;  // series_type → BO 局数
      if (_boNumH > 1) {
        // ★ BO2 特殊：双局积分制必须打满 2 局才算结束（不论 2:0 还是 1:1 平局），
        //   不能用「比分达胜场条件」判定（BO2 的 ceil(2/2)=1 → 1:0 会误判已结束）。
        //   BO3/BO5 用「比分达胜场条件」判定（先达 BO_WIN 即结束，未必打满）。
        var _seriesStillGoing = false;
        if (st === 3) {  // BO2
          _seriesStillGoing = games.length < _boNumH;  // 局数不足 → 仍进行
        } else {          // BO3/BO5
          var _winThresholdH = Math.ceil(_boNumH / 2);
          _seriesStillGoing = Math.max(scoreA, scoreB) < _winThresholdH;
        }
        if (_seriesStillGoing) {
          // 系列仍未决出胜负 → 系列还在进行
          var _lastEndSecH = (last.start_time || 0) + ((last.duration || 0) || 0);
          if (_lastEndSecH > 0 && (nowSec - _lastEndSecH) < 6 * 3600) {
            isLive = true;
          }
        }
      }
    }
    const phase = isLive ? 'live' : (isUpcoming ? 'upcoming' : 'recent');
    const maxScore = Math.max(scoreA, scoreB);
    const minScore = Math.min(scoreA, scoreB);
    const totalGames = games.length;
    if (st === 2 || maxScore >= 3) {
      // series_type=2 明确标记 BO5，或一方赢3局（BO3 不可能出现3胜）
      boType = 'BO5';
    } else if (maxScore === 2) {
      // 一方赢2局
      // series_type=0 且恰好2场 → BO2（双局积分制全胜 2-0）
      // 否则 → BO3（三局两胜，2-0 横扫或 2-1）
      if (st === 0 && totalGames === 2) {
        boType = 'BO2';
      } else {
        boType = 'BO3';
      }
    } else if (maxScore === 1) {
      // 一方赢1局
      if (totalGames === 2 && scoreA === 1 && scoreB === 1) {
        // 1-1 平局，一定是 BO2（双局积分制）
        boType = 'BO2';
      } else {
        boType = 'BO1';
      }
    } else {
      boType = 'BO1';
    }
    // 赛制说明文案
    const boLabel = boType === 'BO1' ? '单局制'
      : boType === 'BO2' ? '双局积分'
      : boType === 'BO3' ? '三局两胜'
      : '五局三胜';
    // ★ v3 优化项20：精确僵死检测 — 第二层：BO 胜场条件（适用 BO3/BO5，BO1 已被第一层覆盖）
    //   已结算场数已达 BO 胜场条件 → 系列赛实际已结束，降级为 recent
    if (isLive) {
      var BO_WIN_THRESHOLD = { 'BO3': 2, 'BO5': 3, 'BO2': 2, 'BO1': 1 };
      var winThreshold = BO_WIN_THRESHOLD[boType] || 0;
      // winThreshold > 1 排除 BO1（BO1 靠时间检测）
      if (winThreshold > 1 && (scoreA >= winThreshold || scoreB >= winThreshold)) {
        isLive = false;
      }
    }
    // BO2 可能平局（1-1）；其他赛制必有胜负
    const isDraw = boType === 'BO2' && scoreA === scoreB;
    // 预计算 class 名（避免 WXML 嵌套三元表达式导致渲染异常）
    const scoreACls = isDraw ? 'draw' : (scoreA > scoreB ? 'win' : 'lose');
    const scoreBCls = isDraw ? 'draw' : (scoreB > scoreA ? 'win' : 'lose');
    const teamACls = isDraw ? 'draw' : (scoreA > scoreB ? 'win' : '');
    const teamBCls = isDraw ? 'draw' : (scoreB > scoreA ? 'win' : '');
    const teamALogoCls = !isDraw && scoreA > scoreB ? 'team-win' : '';
    const teamBLogoCls = !isDraw && scoreB > scoreA ? 'team-win' : '';
    const boTagCls = boType === 'BO2' ? 'bo-bo2' : (boType === 'BO5' ? 'bo-bo5' : '');
    // 最近 2h 内结束（用作 B 点缀判定）
    const lastEnd = last.start_time && last.duration ? (last.start_time + last.duration) * 1000 : 0;
    const isRecent = lastEnd && (now - lastEnd) < 2 * 3600 * 1000;
    return {
      key: key,
      games: games,
      scoreA: scoreA,
      scoreB: scoreB,
      boType: boType,
      boLabel: boLabel,
      boTagCls: boTagCls,
      // ★ 2026-08-04：透传 OpenDota series_type（0=BO1/1=BO3/2=BO5/3=BO2），
      //   供 league-detail 的 BO 判定引擎 sources.resolveBoType 使用（S3 信号）。
      //   注意：groupSeries 内部的 boType 仍是旧比分反推推断，仅为兼容保留；
      //   详情页最终以 resolveBoType 输出为准（buildSeriesFromSources 后处理覆盖）。
      seriesType: st,
      // ★ 2026-09-01（双卡修复）：透传 series_id —— 首页 ⑥ 段按 series_id 覆盖
      //   ② /live 错误卡（league_name 缺失 → 「职业赛事」）时需匹配同系列。
      //   原实现只有 seriesType 无 series_id，_cardFromSeries 读 s.series_id 恒 undefined。
      series_id: first.series_id != null ? first.series_id : null,
      isDraw: isDraw,
      isLive: isLive,
      isRecent: isRecent,
      // ★ 新增字段（2026-07-28）：未开赛判定 + 统一 phase + logo 占位
      // isUpcoming：系列赛中存在未结算且 start_time 在未来的场
      // phase：live|upcoming|recent，供详情页分段排序使用（live 优先 > upcoming > recent）
      // radiantLogo/direLogo：初始空字符串，由 league-detail.js enrichTeamLogos 异步注入
      isUpcoming: isUpcoming,
      phase: phase,
      isMulti: games.length > 1,
      radiantName: radiantName,
      direName: direName,
      radiantTeamId: first.radiant_team_id,
      direTeamId: first.dire_team_id,
      radiantWin: !isDraw && scoreA > scoreB,
      direWin: !isDraw && scoreB > scoreA,
      scoreACls: scoreACls,
      scoreBCls: scoreBCls,
      teamACls: teamACls,
      teamBCls: teamBCls,
      teamALogoCls: teamALogoCls,
      teamBLogoCls: teamBLogoCls,
      // ★ 新增 logo 字段：初始为空，league-detail.enrichTeamLogos 异步注入 URL
      // wxml 渲染时 logo 为空则 fallback 显示首字母圆
      radiantLogo: '',
      direLogo: '',
      radiantLogoSource: '',
      direLogoSource: '',
      // ★ v1.1（2026-08-05，审核 R1）：firstTime = 系列首场 start_time。
      //   absorbSettledGames S1 队名+时间窗关联的时间窗基准（fmt 后 games 无 start_time，
      //   系列对象此前只有 lastTime（最后一场）→ 原稿「系列首场.start_time」字段不存在）。
      firstTime: first.start_time || 0,
      lastTime: last.start_time || 0
    };
  });
  // ★ 2026-08-12 强化版约束⑤：比分越界后校验 + 自动回滚
  //   patch 后若某个被软关联合并的系列 boType 与比分不符（如合并错位导致一方≥3胜但被判 BO3，
  //   或 BO5 实际打了 6 局等），说明 patch 误并 → 自动剥离软关联键，重新分组（最多重试 1 次）。
  //   这是前 4 道约束都失效后的兜底保险，只在 PATCH_NULL_SERIES_ENABLED=true 时生效。
  if (PATCH_NULL_SERIES_ENABLED) {
    const BO_LIMIT = { 'BO1': 1, 'BO2': 2, 'BO3': 3, 'BO5': 5 };
    var rollbackKeys = [];
    list.forEach(function (s) {
      var maxSc = Math.max(s.scoreA, s.scoreB);
      var limit = BO_LIMIT[s.boType] || 99;
      var hasPatched = (s.games || []).some(function (g) { return !!g._patchedSeriesKey; });
      if (hasPatched && (maxSc > limit || s.games.length > limit + 1)) {
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('[patchNullSeriesId] rollback', {
            seriesKey: s.key, boType: s.boType, scoreA: s.scoreA, scoreB: s.scoreB,
            gamesLen: s.games.length, reason: 'score_overflow'
          });
        }
        rollbackKeys.push(s.key);
      }
    });
    if (rollbackKeys.length > 0) {
      var dirtyKeySet = {};
      rollbackKeys.forEach(function (k) { dirtyKeySet[k] = true; });
      matches.forEach(function (m) {
        if (m._patchedSeriesKey && dirtyKeySet[m._patchedSeriesKey]) {
          delete m._patchedSeriesKey;  // 剥离软关联 → 此局将独立成组
        }
      });
      // 重试一次：重新分组，跳过 patch（防无限循环）；二次结果不再校验
      return _groupSeriesNoPatch(matches);
    }
  }
  // 按最新比赛时间倒序
  list.sort(function (a, b) { return b.lastTime - a.lastTime; });
  return list;
}

// ★ 2026-08-12 强化版：内部辅助 —— 跳过 patchNullSeriesId 的 groupSeries 主体（回滚专用）
//   与 groupSeries 主体逻辑一致，但不调用 patch；约束⑤回滚后调用此函数重建分组。
//   维护性：groupSeries 主体逻辑变更时需同步此函数。
function _groupSeriesNoPatch(matches) {
  if (!matches || !matches.length) return [];
  const groups = {};
  const order = [];
  matches.forEach(function (m) {
    const key = getSeriesKey(m);
    if (!groups[key]) {
      groups[key] = [];
      order.push(key);
    }
    groups[key].push(m);
  });
  // 复用 groupSeries 的同款聚合逻辑（重新构造 order.map 回调太冗长，
  // 这里采用「直接调用 groupSeries 并禁用 patch」的简洁做法 —— 用开关实现）
  // 实测：这样会再次走完整聚合，但因 _patchedSeriesKey 已被剥离，
  // getSeriesKey 会回退到 match_id 独立成组（即原 null 局回到独立卡状态），不再合并。
  // 临时关闭 patch + 复用主体，避免代码重复。
  PATCH_NULL_SERIES_ENABLED = false;
  try {
    return groupSeries(matches);
  } finally {
    PATCH_NULL_SERIES_ENABLED = true;
  }
}

// ===== BO 判定引擎（2026-08-04，审核 R1-R6 落地）=====
// 多信号优先级（禁止用最终比分反推赛制）：
//   S1 每场声明 bestof（Liquipedia boDeclared）→ 精确
//   S2 赛事赛制文本（云函数 Format 段 parseBoFormat → ctx.boFormat；infobox format 关键词 → ctx.metaFormatBo）
//   S3 OpenDota series_type 完整映射（0=BO1 / 1=BO3 / 2=BO5 / 3=BO2，实测 1win 小组赛 BO2=3）
//   S4 同赛事自证（阶段内 1:1 平局 → 该段 2 局系列为 BO2；阶段内 maxPlayed>=3 → 2:0 更可能 BO3）
//   S5 局数+比分约束（仅 RECENT 已结算：1:0→BO1 / 1:1→BO2 / 2:1→BO3 / maxScore>=3→BO5 / 2:0 保守 BO3）
//   S6 阶段/联赛默认（live/upcoming 无局数：playoff→BO3 先验，其余→联赛 RECENT 模式众数→BO1）
// 阶段划分（R4）：LP section 优先（group/playoff/grandFinal）；OpenDota 用时间簇，
//   边界 = series_type 突变 或 主导局数变化(≥2)，且日期间隔 ≥ 1 天；否则保守合并。
const BO_MAX = { 'BO1': 1, 'BO2': 2, 'BO3': 3, 'BO5': 5 };
const BO_WIN = { 'BO1': 1, 'BO2': 2, 'BO3': 2, 'BO5': 3 };
const BO_LABEL = { 'BO1': '单局制', 'BO2': '双局积分', 'BO3': '三局两胜', 'BO5': '五局三胜' };

// 阶段文本 → 阶段键（LP section / 赛制文本）
function classifyStage(text) {
  if (!text) return '';
  const t = String(text).toLowerCase();
  if (/grand\s*final|决赛/.test(t)) return 'grandFinal';
  if (/group|round\s*[- ]?robin|小组|循环/.test(t)) return 'group';
  if (/playoff|淘汰|quarter\s*final|semi|round\s*of|upper\s*bracket|lower\s*bracket/.test(t)) return 'playoff';
  return '';
}

// 已结算局数（OpenDota 有 games；Liquipedia 无小场时用比分和估算）
// ★ 兼容两种字段：groupSeries 原始字段 radiant_win，以及 league-detail fmt() 变换后的 radiantWin（驼峰）
function settledCountOf(s) {
  if (s && s.games && s.games.length) {
    let n = 0;
    for (let i = 0; i < s.games.length; i++) {
      const g = s.games[i];
      if (g.radiant_win != null || g.radiantWin != null) n++;
    }
    return n;
  }
  if (s && s.phase === 'recent' && (s.scoreA || s.scoreB)) {
    return (s.scoreA || 0) + (s.scoreB || 0);
  }
  return 0;
}

// 未结算局数（LIVE「第 3 局 pending」判定用）
function pendingCountOf(s) {
  if (!s || !s.games || !s.games.length) return 0;
  let n = 0;
  for (let i = 0; i < s.games.length; i++) {
    const g = s.games[i];
    if (g.radiant_win == null && g.radiantWin == null) n++;
  }
  return n;
}

// S2a：从自由文本提取 BO 关键词（infobox format / 赛制描述，如 "Round robin (Bo2)"）
function boFromFreeText(text) {
  if (!text) return null;
  const m = String(text).match(/(?:Abbr\/)?Bo\s*(\d)|best\s*of\s*(\d)/i);
  return m ? ('BO' + (m[1] || m[2])) : null;
}

// 构建 BO 判定上下文（审核 R3：S4 自证表预计算，先于系列循环）
// ctx.stages[stageKey] = { draws, maxPlayed }；ctx.defaultBo = S6 联赛默认（RECENT 模式众数）
// ctx.dailyDraws[UTC日] = 该日是否存在 1:1 平局（同日自证粒度，审核 R4）
// ctx.uniBo = boFormat.group 与 playoff 非空且相等时的单一赛制权威（v2.1，消除 S2 default 不分阶段污染）
function buildBoContext(seriesList, league) {
  const boFormat = (league && league.boFormat) || null;
  // uniBo（审核 R3 边界）：仅 group/playoff 均非空且相等才成立；只声明单阶段 → null 退化启发式
  const gp = [boFormat && boFormat.group, boFormat && boFormat.playoff].filter(Boolean);
  const ctx = {
    leagueId: (league && league.leagueId) || null,
    leagueName: (league && league.leagueName) || '',
    boFormat: boFormat,                                                     // S2 云 Format 段（parseBoFormat 输出）
    metaFormatBo: boFromFreeText((league && league.metaFormat) || null),    // S2a infobox format 关键词（弱信号，不置 s2Auth）
    uniBo: (gp.length === 2 && gp[0] === gp[1]) ? gp[0] : null,             // 单一赛制权威
    stages: {},
    dailyDraws: {},                                                         // UTC 日 → 是否有 1:1 平局（同日自证）
    defaultBo: 'BO1'
  };
  const list = Array.isArray(seriesList) ? seriesList : [];
  // 1a) LP section 锚点（优先级 1，v2.1；R2 时间窗守卫 |ΔT|<24h）
  //     league.liqStages = league-detail 传入的 liqScheduled 带 section 场次 [{ section, startTime }]
  const anchors = (league && Array.isArray(league.liqStages)) ? league.liqStages : null;
  if (anchors && anchors.length) {
    const anchorList = anchors
      .map((a) => ({ stageKey: classifyStage(a.section || a.stageLabel || '') || 'unknown', startTime: a.startTime || 0 }))
      .filter((a) => a.stageKey !== 'unknown' && a.startTime > 0);
    if (anchorList.length) {
      list.forEach((s) => {
        if (s.stageKey || s.section || !s.lastTime) return;   // LP series 已有 section，走 1c
        let best = null, bestD = 24 * 3600;                    // 时间窗守卫：>24h 不归属
        for (let i = 0; i < anchorList.length; i++) {
          const d = Math.abs(s.lastTime - anchorList[i].startTime);
          if (d < bestD) { bestD = d; best = anchorList[i]; }
        }
        if (best) s.stageKey = best.stageKey;                 // 仅当最近锚点 |ΔT|<24h 才命中
      });
    }
  }
  // 1b) 时间簇（优先级 2，仅对仍未归属的 OpenDota 系列；R4 日历日差）
  const odList = list.filter((s) => !s.section && !s.stageKey).slice().sort((a, b) => (a.lastTime || 0) - (b.lastTime || 0));
  let prevSt = null, prevLen = null, prevDay = null, curKey = 'od0', idx = 0;
  odList.forEach((s) => {
    const st = (s.seriesType != null) ? s.seriesType : null;
    const len = (s.games && s.games.length) || 0;
    const t = s.lastTime || 0;
    // R4（2026-08-04 二次修复）：日期间隔用「日历日差」而非小时差。
    // 实测 1win 小组末场 8/2 21:00 UTC → 淘汰首场 8/3 00:30 UTC 仅隔 3.5h，
    // 小时差 < 1 天导致阶段未切分、小组 BO2 自证污染淘汰赛 2:0（误判 BO2）。
    const day = t ? Math.floor(t / 86400) : 0;
    const gapDays = prevDay != null ? (day - prevDay) : 0;
    let cut = false;
    if (prevSt != null && st !== prevSt && gapDays >= 1) cut = true;                                    // series_type 突变且跨日
    if (prevLen != null && len !== prevLen && Math.abs(len - prevLen) >= 2 && gapDays >= 1) cut = true;  // 主导局数突变且跨日
    if (cut) { idx++; curKey = 'od' + idx; }
    s.stageKey = s.stageKey || curKey;
    prevSt = st; prevLen = len; prevDay = day;
  });
  // 1c) LP series 用 section classify（现状）
  list.forEach((s) => {
    if (!s.stageKey) s.stageKey = classifyStage(s.section || s.stageLabel || '') || 'unknown';
  });
  // 2) 聚合阶段证据 + S6 联赛模式（仅 RECENT 已结算系列）
  const boModes = {};
  list.forEach((s) => {
    if (s.phase !== 'recent') return;
    const k = s.stageKey || 'unknown';
    const ev = ctx.stages[k] = ctx.stages[k] || { draws: 0, maxPlayed: 0 };
    const played = settledCountOf(s);
    if ((s.scoreA === s.scoreB) && played === 2) {
      ev.draws++;                                             // 1:1 平局 = BO2 铁证（段级）
      const day = s.lastTime ? Math.floor(s.lastTime / 86400) : 0;
      if (day) ctx.dailyDraws[day] = true;                    // 同日粒度（审核 R4）
    }
    if (played > ev.maxPlayed) ev.maxPlayed = played;
    // 联赛默认粗判（保守推导，仅供 S6 兜底）
    const maxScore = Math.max(s.scoreA || 0, s.scoreB || 0);
    let bo = 'BO1';
    if (maxScore >= 3) bo = 'BO5';
    else if (played === 2 && maxScore === 1) bo = 'BO2';
    else if (played >= 3) bo = 'BO3';
    else if (played === 2 && maxScore === 2) bo = 'BO3';
    boModes[bo] = (boModes[bo] || 0) + 1;
  });
  // 3) S6 联赛默认 = RECENT 模式众数，无样本则 BO1
  let best = 'BO1', bestN = 0;
  Object.keys(boModes).forEach((k) => { if (boModes[k] > bestN) { bestN = boModes[k]; best = k; } });
  ctx.defaultBo = best;
  return ctx;
}

// 单个系列的 BO 判定（主引擎，审核 R2 兜底规则表 + R3 一致性校验）
function resolveBoType(series, ctx) {
  const played = settledCountOf(series);
  const pending = pendingCountOf(series);
  const totalGames = (series && series.games && series.games.length) || 0;
  const scoreA = (series && series.scoreA) || 0;
  const scoreB = (series && series.scoreB) || 0;
  const maxScore = Math.max(scoreA, scoreB);
  const st = (series && series.seriesType != null) ? series.seriesType : null;
  const phase = (series && series.phase) || 'recent';
  const stageKey = (series && series.stageKey) || '';
  const c = ctx || { stages: {}, defaultBo: 'BO1' };

  // 约束校验：已打局数与比分必须容纳于该赛制。
  // 已结束（RECENT 且无 pending）系列必须是该 BO 的合法终局：
  //   胜方局数必须恰达胜场阈值（BO3 2:0/2:1、BO5 3:0/3:1/3:2），
  //   1:1 平局仅 BO2 合法（BO3/BO5 不可能以 1:1 终局 —— 这是 BO2 的铁证）。
  // 进行中/未开赛仅校验上界（局数 ≤ 上限、当前胜局 ≤ 胜场阈值），不做终局判定。
  const isDraw11 = played === 2 && scoreA === scoreB && scoreA === 1;
  const isFinished = phase === 'recent' && pending === 0 && (played > 0 || (scoreA + scoreB) > 0);
  const consistent = (bo) => {
    if (!BO_MAX[bo]) return false;
    if (played > BO_MAX[bo]) return false;
    if (maxScore > BO_WIN[bo]) return false;
    if (isFinished) {
      if (isDraw11) return bo === 'BO2';
      if (maxScore !== BO_WIN[bo]) return false;
    }
    return true;
  };
  // 结果一致性（R3 步骤 7）：局数超上限 → 抬升到可容纳赛制；maxScore>=3 → BO5
  const finalize = (bo) => {
    let b = bo || 'BO1';
    while (played > BO_MAX[b]) {
      if (b === 'BO1' || b === 'BO2') b = 'BO3';
      else if (b === 'BO3') b = 'BO5';
      else break;
    }
    if (maxScore >= 3 && BO_WIN[b] < 3) b = 'BO5';
    return b;
  };
  // S2 按阶段取赛制文本（v2.1：uniBo 替代 default 兜底，消除根因 C；s2Auth 标记权威存在）
  //   - 语义阶段（group/playoff/grandFinal）→ boFormat[stageKey]
  //   - 时间簇/未知阶段 → uniBo（仅 group 与 playoff 非空且相等，审核 R3）
  //   - 不再 fallback 到 boFormat.default（不分阶段，会污染混合赛事）
  //   - metaFormatBo（infobox 关键词）为弱信号，命中不置 s2Auth（允许自证辅助）
  let s2Auth = false, fmtBo = null;
  if (c.boFormat) {
    if (stageKey === 'grandFinal' && c.boFormat.grandFinal) fmtBo = c.boFormat.grandFinal;
    else if (stageKey === 'group' && c.boFormat.group) fmtBo = c.boFormat.group;
    else if (stageKey === 'playoff' && c.boFormat.playoff) fmtBo = c.boFormat.playoff;
    else if (c.uniBo) fmtBo = c.uniBo;
    if (fmtBo) s2Auth = true;
  }
  if (!fmtBo) fmtBo = c.metaFormatBo || null;

  // S1 每场声明（Liquipedia bestof）
  if (series && series.declaredBo && consistent(series.declaredBo)) return finalize(series.declaredBo);
  // S2 赛制文本
  if (fmtBo && consistent(fmtBo)) return finalize(fmtBo);
  // S3 series_type 完整映射（3=BO2 为 2026-08-04 实证补入）
  const dayKey = series && series.lastTime ? Math.floor(series.lastTime / 86400) : 0;
  const sameDayDraw = !!(c.dailyDraws && c.dailyDraws[dayKey]);   // 同日粒度（审核 R4）
  if (st === 3) {
    if (consistent('BO2')) return finalize('BO2');
  } else if (st === 2) {
    if (consistent('BO5')) return finalize('BO5');
  } else if (st === 1) {
    // 同日自证 BO2（v2.1：S4 收窄为同日 + 无 S2 权威）且 2 局 2:0 且无 pending 第 3 局 → 改判 BO2
    if (!s2Auth && sameDayDraw && totalGames === 2 && played === 2 && pending === 0 &&
        maxScore === 2 && consistent('BO2')) return finalize('BO2');
    if (consistent('BO3')) return finalize('BO3');
  } else if (st === 0) {
    if (consistent('BO1')) return finalize('BO1');
  }
  // ★ 2026-08-12 方案 A·S4.5：map 槽结构信号（LP {{Match}} 模板声明了几个 map 槽位）。
  //   适用：LP 数据无 OpenDota series_type（st=null），且无 S2 权威赛制时 —— 即 LP-only 系列。
  //   规则（槽位数→BO 推断）：
  //     1 槽 → BO1（单局）
  //     2 槽 → BO2（双局积分制；BO3 模板很少只占 2 槽，BO2 更严谨）
  //     3 槽 → BO3（三局两胜；最常见）
  //     4 槽 → BO3（BO5 偶占 4 槽，但 3 局已结算的场景更常见，保守 BO3）
  //     5 槽 → BO5（五局三胜）
  //   置于 S3 之后、S4 之前：因 OpenDota 路径 series.games[] 有值而无 mapSlots，
  //   此时 mapSlots=0 不触发；LP 路径 mapSlots>0 触发，但前提是无 S2 权威且 st=null，
  //   才会落到本分支 —— 与 S4 同日自证并列，互不冲突。
  //   防御：须 consistent 校验（比分约束不矛盾才采纳），且 st==null 时才生效（st 有值已被 S3 处理）。
  if (st == null && !s2Auth) {
    const slots = (series && series.mapSlots) || 0;
    if (slots > 0) {
      let slotBo = null;
      if (slots === 1) slotBo = 'BO1';
      else if (slots === 2) slotBo = 'BO2';
      else if (slots === 3 || slots === 4) slotBo = 'BO3';
      else if (slots >= 5) slotBo = 'BO5';
      if (slotBo && consistent(slotBo)) return finalize(slotBo);
    }
  }
  // S4 同日自证（无 series_type 或 st 不可用；无 S2 权威；同日粒度）+ 段内 3 局证据升 BO3
  if (!s2Auth && sameDayDraw && totalGames === 2 && maxScore === 2 && consistent('BO2')) return finalize('BO2');
  const ev = c.stages[stageKey];
  if (ev && ev.maxPlayed >= 3 && totalGames === 2 && maxScore === 2 && consistent('BO3')) return finalize('BO3');
  // S5 局数+比分约束（仅 RECENT 已结算；live/upcoming 无局数不进入，防比分反推误判）
  if (phase === 'recent' && (played > 0 || maxScore > 0)) {
    if (maxScore >= 3 && consistent('BO5')) return finalize('BO5');   // 3:0/3:1/3:2
    if (played === 3 && maxScore === 2 && consistent('BO3')) return finalize('BO3');  // 2:1
    if (played === 2 && maxScore === 2) return finalize('BO3');       // 2:0 保守默认（R2）
    if (played === 2 && maxScore === 1) return finalize('BO2');       // 1:1 铁证
    if (played === 1 && maxScore === 1) return finalize('BO1');       // 1:0
  }
  // S6 阶段/联赛默认（live/upcoming 或零信号）
  if (stageKey === 'playoff' || stageKey === 'grandFinal') return finalize('BO3');  // 淘汰赛先验
  return finalize(c.defaultBo);
}

// 应用 BO 判定结果到系列对象（覆盖 groupSeries/LP 的旧推断）
// league-detail.buildSeriesFromSources 在 OpenDota + Liquipedia 合并后统一调用
function applyBo(series, ctx) {
  if (!series) return series;
  const bo = resolveBoType(series, ctx);
  series.boType = bo;
  series.boLabel = BO_LABEL[bo] || '单局制';
  series.boTagCls = bo === 'BO2' ? 'bo-bo2' : (bo === 'BO5' ? 'bo-bo5' : '');
  series.isMulti = bo !== 'BO1';
  // ★ 2026-08-12 P0-1：resolveBoType 重定 bo 后须重算 isDraw。
  //   根因：groupSeries L942 按"旧比分反推 boType"判 isDraw，applyBo 覆盖 boType 后未同步；
  //   场景：BO3 临时 1-1（系列未结束）被 groupSeries 误标 isDraw=true，applyBo 正确定为 BO3，
  //   若不重算会残留 isDraw=true → 显示成"平局"配色 + 误判胜负方缺失。
  //   三重限定严谨：① bo==='BO2'（只有 BO2 可能平局）；② 比分相等；
  //   ③ 已结算（防 live/upcoming 临时 1-1 被误判——系列未结束不是真平局）。
  //   isFinished 与 resolveBoType L1175 定义保持一致。
  if (series.games) {
    const _settled = settledCountOf(series);
    const _pending = pendingCountOf(series);
    const _phase = series.phase || 'recent';
    const _isFinished = _phase === 'recent' && _pending === 0 &&
      (_settled > 0 || ((series.scoreA || 0) + (series.scoreB || 0)) > 0);
    series.isDraw = (bo === 'BO2' && _isFinished && (series.scoreA || 0) === (series.scoreB || 0));
    // bo 变化导致胜负方须同步重算
    if (!series.isDraw) {
      series.radiantWin = (series.scoreA || 0) > (series.scoreB || 0);
      series.direWin = (series.scoreB || 0) > (series.scoreA || 0);
    } else {
      series.radiantWin = false;
      series.direWin = false;
    }
  }
  return series;
}

// ★ 2026-08-04（v1.1 实施，审核 R3/R4/R5/R6）：LP live/upcoming 卡吸收 OpenDota 已结算局（matchIds 硬关联）
// 纯函数（不依赖 wx/Page，可单测）。series.games 兼容两种字段：fmt 后 radiantWin/radiantTeamId 与原始 radiant_win/radiant_team_id。
// 方向映射优先级链由 resolver 内部实现（页面注入 curation → league idMap → null）；单点命中即定方向（补集原理）。
// 返回 { liqSeries, absorbedKeys }：
//   - 命中且方向可定 → 注入 games（aWin/bWin 按 LP team1/team2 视角重算）/scoreA/scoreB（team1 胜局数）/radiantTeamId/direTeamId，absorbedKeys=被吸收 OpenDota series key（页面据此移除防 RECENT 重复）
//   - 方向失败 → 不注入 games，absorbedKeys=[]（跨 tab 双卡为已文档化边界 R6）
function absorbSettledGames(openSeriesList, liqSeries, teamIdNameResolver) {
  const byMatchId = new Map();
  // ★ 2026-08-22 新增 bySeriesId 索引：修复 Steam live ↔ OpenDota recent 同对局双卡 BUG。
  //   背景：同一系列 BO3 的不同局 match_id 不同（第1局=78...98，第2局=78...99），
  //   仅靠 byMatchId 关联时 Steam 当前局 match_id 在 OpenDota 已结算局中查不到 → 吸收失败 → 双卡。
  //   series_id 同系列保持一致 → 是跨源关联的更强键。
  //   仅索引 series_id > 0 的局（0/null 表示无系列，跨不了）。
  const bySeriesId = new Map();
  (Array.isArray(openSeriesList) ? openSeriesList : []).forEach(function (s) {
    (s.games || []).forEach(function (g) {
      if (g && g.match_id) byMatchId.set(String(g.match_id), { series: s, game: g });
      const sid = g && (g.series_id != null ? g.series_id : (s.series_id != null ? s.series_id : null));
      if (sid != null && sid !== 0 && String(sid) !== '') {
        const key = String(sid);
        if (!bySeriesId.has(key)) bySeriesId.set(key, []);  // 同 series_id 多局累积
        bySeriesId.get(key).push({ series: s, game: g });
      }
    });
  });
  const absorbedKeys = [];
  const norm = function (x) { return String(x || '').toLowerCase().replace(/[^a-z0-9]/g, ''); };
  // ★ 2026-08-05（审核 R2）：去通用队伍后缀后完整匹配 —— 解决短名被长度下限 3 拦截（1w vs 1w Team）。
  //   方向解析是「任一侧命中即定方向」（补集原理）：dire=1w 本可命中 team1='1wteam'（indexOf），
  //   但 dn.length=2 < 3 被拦 → 唯一命中点丢失。去后缀后 '1wteam'→'1w' === '1w'（完整匹配，非子串）。
  //   子串匹配长度下限保持 3 不动（防 'og'/'xg' 等 2 字符出现在任意队名中的误配）。
  const TEAM_SUFFIX_RE = /(team|tc|gaming|esports|club|gg)$/i;
  const stripTeamSuffix = function (x) { return String(x || '').replace(TEAM_SUFFIX_RE, ''); };
  // 队名匹配：① 精确 → ② 去后缀完整匹配（防短名被拦）→ ③ 子串包含（下限 3，双向）
  const nameMatch = function (openNorm, liqNorm) {
    if (!openNorm || !liqNorm) return false;
    if (openNorm === liqNorm) return true;
    const so = stripTeamSuffix(openNorm), sl = stripTeamSuffix(liqNorm);
    // 走到 ② 必然 openNorm!==liqNorm（① 已处理全等）；so===sl 即「差异仅在后缀」→ 安全匹配
    // （1w vs 1wteam：so='1w' 未变、sl='1w' 变了 → 命中；navi vs navijr：strip 后不等 → 不命中）
    if (so === sl && so.length >= 2) return true;
    if (openNorm.length >= 3 && liqNorm.indexOf(openNorm) >= 0) return true;
    if (liqNorm.length >= 3 && openNorm.indexOf(liqNorm) >= 0) return true;
    return false;
  };

  // 共享吸收流程（S0/S1 共用，审核 R4）：对命中系列执行方向解析 + 注入 + absorbedKeys
  // 返回是否成功吸收（S0 的 hit 来自 matchIds 命中；S1 的 hit 来自队名+时间窗关联）
  function absorbHits(card, hit) {
    if (!hit || !hit.length) return false;
    // 方向解析：取该 series 首场 radiant/dire team_id → resolver 解名 → 与 LP team1/team2 比对（单点命中即定方向）
    const first = hit[0].series.games && hit[0].series.games[0];
    const rId = first && (first.radiantTeamId || first.radiant_team_id);
    const dId = first && (first.direTeamId || first.dire_team_id);
    let radiantIsTeam1 = null;
    if (rId || dId) {
      const rn = rId ? (teamIdNameResolver ? norm(teamIdNameResolver(rId)) : '') : '';
      const dn = dId ? (teamIdNameResolver ? norm(teamIdNameResolver(dId)) : '') : '';
      // 2026-08-04（v1.1 二次修复）：team1Name/team2Name 可能缺失（页面 map 早期形状）→ 回退 radiantName/direName 兜底
      const t1 = norm(card.team1Name || card.radiantName), t2 = norm(card.team2Name || card.direName);
      // ★ 2026-08-05（审核 R2）：方向匹配升级 nameMatch（精确/去后缀/子串），修复 1w vs 1w Team 短名被拦
      if (rn && nameMatch(rn, t1)) radiantIsTeam1 = true;       // radiant=team1
      else if (rn && nameMatch(rn, t2)) radiantIsTeam1 = false;  // radiant=team2
      else if (dn && nameMatch(dn, t1)) radiantIsTeam1 = false;  // dire=team1
      else if (dn && nameMatch(dn, t2)) radiantIsTeam1 = true;   // dire=team2 → radiant=team1
    }
    if (radiantIsTeam1 === null) return false;  // 方向失败 → 不注入（R3/R4）
    // 吸收：注入 games（aWin/bWin 按 LP team1/team2 视角重算）+ 比分由 games 重算（R4）
    // ⚠️ 胜负判定必须按 team_id 归属（与 fmt 同逻辑），不能用 radiant 方向 —— BO3 换边局 radiant 可能是 team1（T22 实证）
    const aId = radiantIsTeam1 ? rId : dId;   // LP team1 的 OpenDota team_id
    const bId = radiantIsTeam1 ? dId : rId;   // LP team2 的 OpenDota team_id
    const games = [];
    let scoreA = 0, scoreB = 0;
    hit.forEach(function (h) {
      const g = Object.assign({}, h.game);
      const rw = (g.radiantWin != null) ? g.radiantWin : g.radiant_win;  // 兼容 fmt 驼峰 / 原始字段
      let aWin = false, bWin = false;
      if (rw === true || rw === false) {
        const gR = g.radiantTeamId || g.radiant_team_id;
        const gD = g.direTeamId || g.dire_team_id;
        const winnerId = rw ? gR : gD;
        if (aId && bId && winnerId) {           // 有有效锚点：按 team_id 归属（换边安全）
          if (winnerId === aId) aWin = true;
          else if (winnerId === bId) bWin = true;
        } else if (radiantIsTeam1) {            // 无锚点兜底：radiant 方向
          aWin = !!rw; bWin = !rw;
        } else {
          bWin = !!rw; aWin = !rw;
        }
        if (aWin) scoreA++; else scoreB++;
      }
      g.aWin = aWin;
      g.bWin = bWin;
      games.push(g);
    });
    card.games = games;
    card.scoreA = scoreA;
    card.scoreB = scoreB;
    card.radiantTeamId = aId;  // LP A=team1 对应的 OpenDota team_id（logo/增强用）
    card.direTeamId = bId;
    const seen = new Set();
    hit.forEach(function (h) {
      if (h.series && h.series.key && !seen.has(h.series.key)) { seen.add(h.series.key); absorbedKeys.push(h.series.key); }
    });
    return true;
  }

  (Array.isArray(liqSeries) ? liqSeries : []).forEach(function (card) {
    if (card.phase === 'recent') return;  // 仅 live/upcoming 参与吸收
    // S0：matchIds 硬关联（保留，优先；审核 R3：matchIds 有值一律走 S0，含不命中，不降级 S1）
    //   ★ 2026-08-22 S0.5 增强：match_id 不命中时回退 series_id 关联（修复 Steam live ↔ OpenDota recent 双卡）。
    //   场景：Steam live 卡的 matchIds 含「当前进行局的 match_id」，
    //         但 OpenDota 已结算局的 match_id 是「该系列上一局」——两者不同，
    //         而 series_id 在同系列内保持一致 → 回退到 bySeriesId 可正确关联。
    if (card.matchIds && card.matchIds.length) {
      const hit = [];
      const seriesIdsTried = new Set();   // 防同 series_id 多局重复加入
      card.matchIds.forEach(function (id) {
        const h = byMatchId.get(String(id));
        if (h) {
          hit.push(h);
          // 顺带记录这条命中的 series_id，后续不再用同一 series_id 二次加入
          const sid = h.game && h.game.series_id;
          if (sid != null && sid !== 0) seriesIdsTried.add(String(sid));
        }
      });
      // ★ S0.5：match_id 未全部命中 → 用 card.series_id 回退查 bySeriesId（仅对 live 卡生效，
      //   upcoming 卡的 series_id 可能尚未分配——未开赛 Valve 不分配 series_id）
      if ((!hit.length || hit.length < card.matchIds.length) && card.series_id != null && card.phase === 'live') {
        const sid = String(card.series_id);
        if (sid !== '0' && sid !== '' && !seriesIdsTried.has(sid) && bySeriesId.has(sid)) {
          const gamesInSeries = bySeriesId.get(sid);
          gamesInSeries.forEach(function (h) {
            // 过滤掉已经在 match_id 命中里的局（避免重复）
            const alreadyInHit = hit.some(function (existing) {
              return existing.game && h.game && String(existing.game.match_id) === String(h.game.match_id);
            });
            if (!alreadyInHit) hit.push(h);
          });
        }
      }
      absorbHits(card, hit);
      // ★ 2026-08-22 根因 I：S0/S0.5 全部不命中（hit 为空）时降级到 S1 队名+时间窗关联。
      //   场景：LPDB v3 路径的 LP 卡 matchIds 与 OpenDota match_id 永不匹配（不同源），
      //         series_id 也是 'lp_m...' 格式（与 OpenDota 数字格式不同）→ S0/S0.5 全失败。
      //         原「matchIds 有值即 return」（审核 R3 防 matchIds 部分命中场景降级）在此场景下
      //         会跳过 S1 → 吸收失败 → 两张 LIVE 卡共存。
      //   ★ R3 保护精细化：仅当 matchIds 含「OpenDota 同源数字 match_id」时保留 R3 保护（return）；
      //     若 matchIds 全部是非数字字符串（LPDB v3 路径 'lp_match_...' 格式），允许降级 S1。
      if (hit.length) return;
      // 检查 matchIds 是否含 OpenDota 同源格式（纯数字字符串）。
      //   含 → 上游明确知道这些 match_id（即使本次不命中，可能是数据延迟）→ 保留 R3 return 保护；
      //   全无 → matchIds 是 LPDB v3 的 'lp_match_...' 格式（不同源）→ 安全降级 S1。
      // ★ 2026-09-17（P1-8 修复）：原为 /^\\d+$/（正则字面量里 \\ 表示**字面反斜杠**），
      //   实际匹配的是「\ + d」而非数字串 → 字符串形态的数字 matchId 恒不命中
      //   → hasOdMatchId 恒 false → R3 保护失效 → 本应保留的同源卡被错误降级到 S1
      //   队名+时间窗吸收（潜在误吸收/双卡）。
      var hasOdMatchId = card.matchIds.some(function (id) {
        return typeof id === 'number' || /^\d+$/.test(String(id));
      });
      if (hasOdMatchId) return;
    }
    // ★ v1.1（2026-08-05，审核 R2/R5）：S1 第二关联键 —— matchIds 为空 + 队名 + 时间窗。
    //   R2：仅 phase==='live' 参与（upcoming 未开赛，禁队名关联 —— S0 靠 matchIds 天然隔离，
    //       队名关联会命中「同名队伍历史已结束系列」→ 未开赛卡显示历史比分 + RECENT 被误移除）。
    //   R5：时间窗 |card.lastTime − series.firstTime| ≤ 4h（保守，宁可漏吸收不误吸收）。
    if (card.phase !== 'live') return;
    const cardTime = card.lastTime || 0;
    if (!cardTime) return;
    const t1 = norm(card.team1Name || card.radiantName), t2 = norm(card.team2Name || card.direName);
    if (!t1 || !t2) return;
    let hit = [];
    (Array.isArray(openSeriesList) ? openSeriesList : []).forEach(function (s) {
      if (hit.length) return;  // 已关联到系列，不再继续（同名队伍同日多场时优先时间最近的）
      const g0 = s.games && s.games[0];
      if (!g0) return;
      const rId = g0.radiantTeamId || g0.radiant_team_id;
      const dId = g0.direTeamId || g0.dire_team_id;
      if (!rId && !dId) return;
      const rn = rId ? (teamIdNameResolver ? norm(teamIdNameResolver(rId)) : '') : '';
      const dn = dId ? (teamIdNameResolver ? norm(teamIdNameResolver(dId)) : '') : '';
      // 队名双向匹配（R4：复用方向解析同一 norm 规则 + 2026-08-05 nameMatch 升级）：radiant 或 dire 解名 分别命中 team1/team2
      const t1Hit = (rn && nameMatch(rn, t1)) || (dn && nameMatch(dn, t1));
      const t2Hit = (rn && nameMatch(rn, t2)) || (dn && nameMatch(dn, t2));
      if (!t1Hit || !t2Hit) return;
      const sTime = s.firstTime || 0;   // R1：firstTime = 系列首场 start_time（groupSeries 补字段）
      if (!sTime || Math.abs(cardTime - sTime) > 4 * 3600) return;  // R5：时间窗守卫
      // 命中：该系列全部已结算局作为 hit（absorbedKeys 移除语义与 S0 一致）
      (s.games || []).forEach(function (g) {
        if (g && g.match_id) hit.push({ series: s, game: g });
      });
    });
    absorbHits(card, hit);
  });
  return { liqSeries: liqSeries, absorbedKeys: absorbedKeys };
}

// ★ 2026-08-04（v1.1 实施，审核 R2）：liveProgress 文本 —— 必须在 applyBo 后调用（依赖最终 boType）
// BO1 不显示；BO2/3/5 显示 `Game {已结算局数}/{上限}`（第 1 局打完 → Game 1/3；B4 轮询随局数自增）
function liveProgressOf(s) {
  if (!s || s.phase !== 'live') return '';
  const bo = s.boType || 'BO1';
  if (bo === 'BO1') return '';
  const max = BO_MAX[bo] || 3;
  const played = settledCountOf(s);
  if (played <= 0) return '';
  return 'Game ' + played + '/' + max;
}

// ★ 2026-08-04（v1.1 实施，审核 R5）：LIVE 低频重拉 OpenDota 的决策纯函数（可单测）
// 触发条件：有 live 卡 且 距上次重拉 ≥5min（OpenDota 收录滞后 5-30min，5min 粒度可捕捉 BO3 新局；
//           云函数 leagueMatches TTL 已降 5min，force 调用能拿到新缓存）
function shouldRefreshOpenDota(liveCount, lastRefreshSec, nowSec) {
  if (!(liveCount > 0)) return false;
  const last = Number(lastRefreshSec) || 0;
  const now = Number(nowSec) || Math.floor(Date.now() / 1000);
  return (now - last) >= 300;
}

// ★ 2026-08-05（RECENT 同对局双卡修复，审核 R2）：LP 卡 matchIds 是否全部被 OpenDota 收录（硬关联去重判定）
//   全命中 → LP recent 卡剔除（OpenDota 数据更全，含比分）；部分/全不命中 → 保留（LP 数据不完整边界，双卡残留为可接受边界 R3）
function allMatchIdsInSet(matchIds, idSet) {
  if (!Array.isArray(matchIds) || !matchIds.length || !idSet) return false;
  return matchIds.every(function (id) { return idSet.has(String(id)); });
}

// ★ 2026-08-05（RECENT 同对局双卡修复，审核 R2）：team_id → 队名（explorer 预取 map 优先 → curation → raw idMap）
//   用于 OpenDota 比赛端点队名恒 null 时，把占位名（'天辉'/'夜魇'）解为真实名，恢复队名去重路径
function resolveTeamIdName(id, idNameMap, curatedTeams, rawIdMap) {
  if (!id) return null;
  if (idNameMap && idNameMap[id]) return idNameMap[id];
  if (curatedTeams && curatedTeams[id] && curatedTeams[id].name) return curatedTeams[id].name;
  return (rawIdMap && rawIdMap[id]) || null;
}

// ★ 2026-09-01（v8.4 Fix-A）：一 ID 多届原始比赛时间窗过滤（纯函数）。
//   根因：OpenDota league id 跨届复用（实证：19944 = EPL Masters I+II 两届 249 场混杂），
//   详情页 load() 拉全量 → RECENT 段混入旧届比赛卡 + participantsList 混入两届 31 支队伍。
//   修复：按 curation 的届次窗口（leagueIdWindow 优先，回退 start/end ±48h）裁剪 raw。
//   防御：① 无时间戳的 match 保守保留；② 过滤后为空（窗口错配）返回原数组，不清空页面。
function filterMatchesByWindow(raw, win) {
  if (!Array.isArray(raw) || !raw.length || !win || !win.from || !win.to) return raw;
  var filtered = raw.filter(function (m) {
    var st = m && m.start_time;
    if (!st) return true;
    return st >= win.from && st <= win.to;
  });
  return filtered.length ? filtered : raw;
}

// ★ 2026-09-01（v8.4 Fix-D）：LIVE 段同系列多卡兜底去重（纯函数）。
//   根因：absorbSettledGames 方向解析依赖 explorer 队名 resolver，resolver 失败（限流/未收录）
//   时吸收被跳过（R3/R4 已文档化边界）→ 同一对局同时存在 LP/Steam live 卡 + OpenDota live 系列卡，
//   LIVE 段双卡重叠（用户实测：EPL Masters II「4ikibamboni vs Inner Circle」+「天辉 vs 夜魇 1:0」并存）。
//   判定同系列证据（任一命中）：
//     ① 归一化队名对相同（双方均为真名；占位 天辉/夜魇/TBD 不参与，防全部 OD 卡撞同一键）
//     ② matchIds 有交集（LP 卡 matchIds ↔ OpenDota 卡 games 的 match_id）
//     ③ series_id 相同（非 0/null，Steam live 与 OpenDota 同系列天然同 id）
//   保留优先级：真名卡 > 占位名卡 → games 多者 → 系列比分和高者 → 先出现者。
function dedupeLiveSeries(seriesList) {
  if (!Array.isArray(seriesList) || seriesList.length < 2) return seriesList;
  var PLACEHOLDER_RE = /^(天辉|夜魇|tbd|tba|unknown|待定|待公布)$/i;
  function _norm(s) {
    var n = String(s || '').toLowerCase().trim();
    n = n.replace(/\s*(esports|e-sports|gaming|team|club)\s*$/g, '');
    n = n.replace(/[^a-z0-9一-鿿а-яё]/g, '');
    return n;
  }
  function _pairKey(s) {
    var a = _norm(s.radiantName || s.team1Name);
    var b = _norm(s.direName || s.team2Name);
    if (!a || !b || PLACEHOLDER_RE.test(a) || PLACEHOLDER_RE.test(b)) return null;
    return a < b ? (a + '|' + b) : (b + '|' + a);
  }
  function _midSet(s) {
    var set = {};
    if (Array.isArray(s.matchIds)) s.matchIds.forEach(function (id) { if (id) set[String(id)] = true; });
    (s.games || []).forEach(function (g) { if (g && g.match_id) set[String(g.match_id)] = true; });
    return set;
  }
  var live = seriesList.filter(function (s) { return s && s.phase === 'live'; });
  if (live.length < 2) return seriesList;
  var cards = live.map(function (s) {
    var sid = (s.series_id != null) ? String(s.series_id) : '';
    return {
      s: s,
      pair: _pairKey(s),
      mids: _midSet(s),
      sid: (sid && sid !== '0' && sid !== 'null') ? sid : null
    };
  });
  function _sameMatch(a, b) {
    if (a.pair && a.pair === b.pair) return true;
    if (a.sid && a.sid === b.sid) return true;
    var ka = Object.keys(a.mids);
    for (var i = 0; i < ka.length; i++) { if (b.mids[ka[i]]) return true; }
    return false;
  }
  function _keep(a, b) {
    // ① 一方占位名一方真名 → 保留真名卡（用户可见正确队伍名）
    var aReal = a.pair ? 1 : 0, bReal = b.pair ? 1 : 0;
    if (aReal !== bReal) return aReal > bReal ? a : b;
    // ② games 已注入/直连数量多者（比分可信度高）
    var ag = (a.s.games || []).length, bg = (b.s.games || []).length;
    if (ag !== bg) return ag > bg ? a : b;
    // ③ 系列比分总和更高者
    var asc = (a.s.scoreA || 0) + (a.s.scoreB || 0);
    var bsc = (b.s.scoreA || 0) + (b.s.scoreB || 0);
    if (asc !== bsc) return asc > bsc ? a : b;
    return a;  // ④ 先出现者
  }
  var drop = [];
  for (var i = 0; i < cards.length; i++) {
    if (drop.indexOf(cards[i].s) >= 0) continue;
    for (var j = i + 1; j < cards.length; j++) {
      if (drop.indexOf(cards[j].s) >= 0) continue;
      if (_sameMatch(cards[i], cards[j])) {
        var keeper = _keep(cards[i], cards[j]);
        var loser = (keeper === cards[i]) ? cards[j] : cards[i];
        drop.push(loser.s);
      }
    }
  }
  if (!drop.length) return seriesList;
  return seriesList.filter(function (s) { return drop.indexOf(s) < 0; });
}

// ★ 2026-09-02（v8.8 A'）：RECENT 段「OpenDota 拆裂 BO3」合并（纯函数，首页/详情页共用）。
//   背景：EPL Masters 2026 等赛事的部分真实 BO3 被 OpenDota 拆成多个 series_id
//   （同一 BO3 三局各带不同 sid，甚至同队双 team_id，如 Zero Tenacity=9600141/10208035），
//   groupSeries 按 sid 聚合成多张 games=1 的独立卡 → 已结束段显示成多场 BO1。
//   本函数在「队名已解（radiantName/direName 为真实名）」后执行，按队名而非 id 聚合，
//   把同队名对 + 6h 链式窗内的多张单局卡合并为一张 BO3/BO5 卡。
//   安全守卫（防误并）：
//     ① 仅 phase='recent'（已结束）+ games.length===1（单局卡，正常 BO3 games≥2 不受影响）
//     ② 双方均为真实队名（天辉/夜魇占位、TBD 不参与——无法可靠归并）
//     ③ 同归一化队名对（顺序无关）+ start_time 链式间隔 ≤6h 聚簇
//     ④ 完整终局守卫：簇内按 radiant_win 累计的胜局数 max≥2（BO3 终局 2:0/2:1 才并；
//        1:1 中断局、或同日两场独立 BO1 累计成 2:0 的歧义场景不并）
//     ⑤ 局间隔 ≥10min（防把分钟级重复注入误并）
//     ⑥ 合并后 boType 由 series_type 声明推导（stype=1→BO3 / 2→BO5；缺失时按局数 2-3→BO3）
//   key 用 `mrg_<normA>__<normB>_<首局分钟桶>` 稳定键（refresh 轮询 diff 可复用）。
//   ⚠️ 输入 series 需带 radiantName/direName（已解名）、radiantTeamId/direTeamId、games（≥1）、
//      lastTime/firstTime、phase、seriesType。games 元素保留各局原始字段即可。
function mergeSplittedBo3Series(allSeries) {
  if (!Array.isArray(allSeries) || allSeries.length < 2) return allSeries;
  var CHAIN_WINDOW = 6 * 3600;
  var MIN_GAP = 10 * 60;
  var TBD_RE = /^(tbd|tba|待定|待公布|unknown)$/i;
  function _normName(s) {
    var n = String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return n || '';
  }
  function _isRealTeamName(nm) {
    if (!nm) return false;
    if (nm === '天辉' || nm === '夜魇') return false;
    if (TBD_RE.test(nm)) return false;
    return true;
  }
  // ① 候选：recent + 单局 + 真实队名
  var cand = allSeries.filter(function (s) {
    if (!s || s.phase !== 'recent') return false;
    if (!Array.isArray(s.games) || s.games.length !== 1) return false;
    if (!_isRealTeamName(s.radiantName) || !_isRealTeamName(s.direName)) return false;
    return true;
  });
  if (cand.length < 2) return allSeries;
  // ② 同队名对分组（顺序无关）
  var groups = {};
  cand.forEach(function (s) {
    var a = _normName(s.radiantName), b = _normName(s.direName);
    if (!a || !b) return;
    var k = a < b ? (a + '__' + b) : (b + '__' + a);
    if (!groups[k]) groups[k] = [];
    groups[k].push(s);
  });
  var merges = [];
  Object.keys(groups).forEach(function (k) {
    var arr = groups[k].slice().sort(function (x, y) { return (x.lastTime || 0) - (y.lastTime || 0); });
    // ③ 链式聚类：相邻局间隔 ≤6h
    var cur = [arr[0]];
    for (var i = 1; i < arr.length; i++) {
      var gap = (arr[i].lastTime || 0) - (cur[cur.length - 1].lastTime || 0);
      if (gap <= CHAIN_WINDOW) cur.push(arr[i]);
      else { if (cur.length >= 2) merges.push({ items: cur }); cur = [arr[i]]; }
    }
    if (cur.length >= 2) merges.push({ items: cur });
  });
  if (!merges.length) return allSeries;
  var removedKeys = {};
  var added = [];
  merges.forEach(function (group) {
    var sorted = group.items.slice().sort(function (x, y) { return (x.lastTime || 0) - (y.lastTime || 0); });
    // ④ 完整终局守卫：累计 A/B 胜局
    var scoreA = 0, scoreB = 0;
    var aName = sorted[0].radiantName, bName = sorted[0].direName;
    var na = _normName(aName), nb = _normName(bName);
    if (!na || !nb) return;
    sorted.forEach(function (s) {
      var g = s.games && s.games[0];
      var radiantWon = g ? (g.radiantWin === true || g.radiant_win === true) : (s.scoreA > s.scoreB);
      var radiantIsA = _normName(s.radiantName) === na;
      if (radiantWon) { if (radiantIsA) scoreA++; else scoreB++; }
      else { if (radiantIsA) scoreB++; else scoreA++; }
    });
    if (Math.max(scoreA, scoreB) < 2) return;  // 非完整终局不并
    // ⑤ 局间隔 ≥10min 校验
    for (var j = 1; j < sorted.length; j++) {
      if ((sorted[j].lastTime || 0) - (sorted[j - 1].lastTime || 0) < MIN_GAP) return;
    }
    // ⑥ boType 推导
    var stype = sorted[0].seriesType;
    var boType = 'BO3';
    if (stype === 2) boType = 'BO5';
    else if (sorted.length >= 4 || Math.max(scoreA, scoreB) >= 3) boType = 'BO5';
    var firstT = sorted[0].lastTime || 0;
    var merged = Object.assign({}, sorted[0], {
      key: 'mrg_' + (na < nb ? na + '__' + nb : nb + '__' + na) + '_' + Math.floor(firstT / 60),
      radiantName: aName, direName: bName,
      radiantTeamId: sorted[0].radiantTeamId, direTeamId: sorted[0].direTeamId,
      radiantWin: scoreA > scoreB, direWin: scoreB > scoreA,
      scoreA: scoreA, scoreB: scoreB,
      boType: boType,
      isMulti: true,
      seriesType: stype != null ? stype : null,
      games: sorted.map(function (s) { return s.games[0]; }),
      firstTime: sorted[0].firstTime || firstT,
      lastTime: sorted[sorted.length - 1].lastTime || firstT
    });
    sorted.forEach(function (s) { if (s.key) removedKeys[s.key] = true; });
    added.push(merged);
  });
  if (!added.length) return allSeries;
  var out = allSeries.filter(function (s) { return !(s.key && removedKeys[s.key]); });
  added.forEach(function (m) { out.push(m); });
  return out;
}

// ★ 2026-09-02（v8.8c）：参赛队白名单过滤 —— 剔除「跨联赛误标」对局（首页/详情页共用）。
//   实证：EPL World Series: SEA（leagueid=18865）的 BO3 前两局被 OpenDota 误标到
//   league 19944（EPL Masters 2026），Yangon Galacticos / Team Kinetix 并非 EPL Masters II
//   参赛队，却被「按 leagueId 过滤」的视图（详情页窗口 / 首页 league 卡）收进来。
//   修复：以该 leagueId 对应 curation 赛事的 participants（人工策展参赛队）为白名单，
//   已结束系列双方队名（series 层需已解名）**均不在白名单** → 整系列剔除。
//   守卫：
//     ① 仅当 curation 能按 leagueId 命中且 participants 为非空数组才生效（缺数据不强过滤）
//     ② 仅过滤 phase='recent'（live/upcoming 由 LP/Steam 排期背书，不误伤）
//     ③ 队名缺失（占位天辉/夜魇/TBD）不判（无法可靠归并）
//   纯函数：leagueId 传 Number；内部按需 require remoteCuration（延迟避免循环依赖）。
function filterMisattributedRecentSeries(allSeries, leagueId) {
  if (!Array.isArray(allSeries) || !allSeries.length) return allSeries;
  var lid = Number(leagueId);
  if (!lid || lid <= 0) return allSeries;
  var _norm = function (s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); };
  var TBD_RE = /^(tbd|tba|待定|待公布|unknown)$/i;
  function _real(nm) {
    if (!nm || nm === '天辉' || nm === '夜魇' || TBD_RE.test(nm)) return '';
    return _norm(nm);
  }
  var wl = null;
  try {
    var rc = require('./remoteCuration.js');
    var ev = rc.curatedEventFor('', { leagueId: lid, game: 'dota2' });
    if (ev && Array.isArray(ev.participants) && ev.participants.length) {
      wl = new Set(ev.participants.map(function (p) { return _real((p && p.name) || ''); }).filter(Boolean));
    }
  } catch (e) { wl = null; }
  if (!wl || !wl.size) return allSeries;   // curation 未命中/无参赛队 → 不强过滤
  var before = allSeries.length;
  var out = allSeries.filter(function (s) {
    if (!s || s.phase !== 'recent') return true;
    var a = _real(s.radiantName), b = _real(s.direName);
    if (!a || !b) return true;                 // 队名缺失不判
    if (wl.has(a) || wl.has(b)) return true;   // 任一方是参赛队 → 保留
    return false;                              // 双方都不在 → 跨联赛误标剔除
  });
  if (out.length !== before) {
    console.info('[A-merge][filterMisattributed] leagueId=' + lid + ' 剔除跨联赛误标 ' + (before - out.length) + ' 组');
  }
  return out;
}

// ★ 2026-09-01（v8.4 Fix-E）：参赛队伍同名多 id 去重（纯函数）。
//   根因：同一战队跨届/重注册会持有多个 OpenDota team_id（实证：19944 中 Zero Tenacity
//   9600141 与 10208035、Team Syntax 10213108 与 10232570 并存），refreshMetadataDerived
//   按 team_id 去重 → 同一队伍在参赛队伍列表出现两条（「相同数据重叠」）。
//   修复：按「小写+去非字母数字」归一化队名聚合，保留出场次数多的 id（更权威的注册条目），
//   返回应丢弃的 id 数组（无重复返回 null）。
function dropDuplicateNameIds(teamMap, teamCount) {
  if (!teamMap) return null;
  function _norm(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }
  var best = {};
  Object.keys(teamMap).forEach(function (id) {
    var n = _norm(teamMap[id]);
    if (!n) return;
    if (best[n] == null || ((teamCount && teamCount[id]) || 0) > ((teamCount && teamCount[best[n]]) || 0)) {
      best[n] = id;
    }
  });
  var drop = [];
  Object.keys(teamMap).forEach(function (id) {
    var n = _norm(teamMap[id]);
    if (!n) return;
    var b = best[n];
    if (b != null && String(b) !== String(id)) drop.push(Number(id));
  });
  return drop.length ? drop : null;
}

// ★ 2026-08-20：Liquipedia 来源的系列赛聚合（修复「一场 BO3 被拆成多张 BO1 卡」）
// 根因：Liquipedia v3 / wikitext 对阵中，同一 BO 系列的每一局是独立 match 记录；
//   buildSeriesFromSources 的 Liquipedia 合并段原本直接 .map 每个 match 成一张独立 series 卡，
//   未做 series 维度聚合（OpenDota 路径走 groupSeries 正确聚合，Liquipedia 路径缺失这一步）。
//   导致 LPDB 返回的 BO3 三局 → 3 张 BO1 卡（用户实测「Team Spirit vs Iron Wing 拆成两张 BO1」）。
// 纯函数（不依赖 wx/Page），与 groupSeries 对称：按 series_id（或队名对+同日兜底）把同系列多局合并为一项。
// 返回聚合后的 Liquipedia 形状 match 列表（字段对齐 buildSeriesFromSources map 段读取需求）。
function _liqStartOf(m) { return m.startTime || m.start_time || 0; }
const PHASE_RANK = { live: 3, recent: 2, upcoming: 1 };

// ★ 2026-08-22 根因 E：跨源同对局去重（LPDB v3 ↔ wikitext/Steam LIVE 同时返回同一场 BO3）
// 诊断脚本 test-iron-wing-diagnosis.js 场景 3/6 确认：两条同队名对+同日记录因 series_id 形态
// 不同（'lp_mX' vs undefined/数字）被 keyOf 分到不同桶 → 同一 BO3 拆成两张卡。
// 本函数在进入 keyOf 聚类前先按「归一化队名对 + 同 UTC 日」分组，同组只保留信息量最大的一条。
// 信息量排序：① 有有效 series_id > 无；② phase rank 高 > 低；③ 系列比分总和 大 > 小；④ 有 boType > 无。
function _dedupCrossSourceMatches(matches) {
  if (!matches || matches.length <= 1) return matches;
  function _normTeam(s) {
    if (!s) return '';
    var n = String(s).toLowerCase().trim();
    // ★ 2026-09-01（三卡修复）：剥离「 x 赞助商」后缀（与 buildLpLiveSeries._normTeamX 同口径）
    n = n.replace(/\s*[x×]\s+\S+.*$/i, '');
    n = n.replace(/\s*(esports|e-sports|gaming|team|club)\s*$/g, '');
    n = n.replace(/[^a-z0-9一-鿿а-яё]/g, '');
    return n;
  }
  function _isTBD(n) { return !n || n === 'tbd' || n === 'tba'; }
  function _hasValidSid(m) {
    var sid = m.series_id;
    if (sid == null) return false;
    var s = String(sid).trim();
    return s !== '' && s !== '0' && s !== 'null' && s !== 'undefined' && !/^orphan_/.test(s);
  }
  function _infoScore(m) {
    var score = 0;
    if (_hasValidSid(m)) score += 1000;
    score += (PHASE_RANK[m.phase] || 0) * 100;
    score += ((m.score1 || 0) + (m.score2 || 0)) * 10;
    if (m.boType) score += 5;
    if (m.boDeclared) score += 2;
    if (m.mapSlots) score += 1;
    return score;
  }
  var groups = {};  // 'pairKey@day' -> [matches]
  var standalone = [];  // 无法归组（TBD 或缺队名）的原样保留
  matches.forEach(function (m) {
    var n1 = _normTeam(m.team1Name || m.radiant_team_name);
    var n2 = _normTeam(m.team2Name || m.dire_team_name);
    if (_isTBD(n1) || _isTBD(n2) || !n1 || !n2) {
      standalone.push(m);
      return;
    }
    var st = _liqStartOf(m);
    if (!st) { standalone.push(m); return; }
    var day = Math.floor(st / 86400);
    var pairKey = n1 < n2 ? (n1 + '|' + n2) : (n2 + '|' + n1);
    var gk = pairKey + '@' + day;
    if (!groups[gk]) groups[gk] = [];
    groups[gk].push(m);
  });
  var result = standalone.slice();
  Object.keys(groups).forEach(function (gk) {
    var grp = groups[gk];
    if (grp.length === 1) { result.push(grp[0]); return; }
    // ★ 2026-08-22 修复回归（test-bo3-split-fix T4）：同队名同日多条可能本就是独立场次
    //   （如小组赛早晚两场），不能无条件合并。按 startTime 排序后用 6h 阈值聚类成子组，
    //   每个子组只保留 infoScore 最高的一条；子组间隔 >6h 保持独立。
    grp.sort(function (a, b) { return _liqStartOf(a) - _liqStartOf(b); });
    var subGroups = [];
    var curSub = [grp[0]];
    for (var gi = 1; gi < grp.length; gi++) {
      var prevStart = _liqStartOf(curSub[curSub.length - 1]);
      var thisStart = _liqStartOf(grp[gi]);
      if (thisStart - prevStart <= 6 * 3600) {
        curSub.push(grp[gi]);  // 间隔 ≤6h → 同一子组（可能是 BO3 的各局）
      } else {
        subGroups.push(curSub);
        curSub = [grp[gi]];  // 间隔 >6h → 新子组（独立场次）
      }
    }
    subGroups.push(curSub);
    subGroups.forEach(function (sg) {
      if (sg.length === 1) { result.push(sg[0]); return; }
      sg.sort(function (a, b) { return _infoScore(b) - _infoScore(a); });
      result.push(sg[0]);
    });
  });
  return result;
}

function groupLiquipediaMatches(matches) {
  if (!Array.isArray(matches) || !matches.length) return [];
  // ★ 2026-08-22 根因 E 修复：跨源同对局去重（LPDB v3 + wikitext/Steam 同时返回同一场 BO3）
  //   诊断确认：LPDB v3 路径 series_id='lp_mR02-M001' 与 wikitext 路径 series_id=undefined
  //   进入 keyOf 后分到不同桶 → 不合并 → 同一 BO3 显示两张卡（Iron Wing vs Spirit 根因）。
  //   方案：入口先按「归一化队名对 + 同 UTC 日」去重，同组只保留信息量最大的一条
  //   （优先级：有 series_id > 无；phase=recent > live > upcoming；比分总和大的 > 小的）。
  matches = _dedupCrossSourceMatches(matches);
  // 聚合键：series_id 优先（非 0/非空/非 orphan_ 前缀）；否则用「队名对(顺序无关) + 同日桶」兜底。
  // ★ 2026-08-22 修复 BO3 被拆成两场 BO1：
  //   ① series_id === 0 视为无效（Steam Scheduled 硬编码 0、LPDB 未分配），不再返回 's_0' 把所有 0 合并；
  //   ② 兜底键的 day 维度保持「UTC 自然日」粒度（同 PatchNullSeriesId 步骤4 的 orphan 互并口径一致）；
  //   ③ 合并段二次校验「相邻局时间差 ≤ 6h」链式聚类 —— 解决跨 UTC 午夜的 BO3（23:30→00:30）
  //      落到不同 day 桶的问题：合并段会检测「同一队名对的多个桶」并按时间差跨桶缝合。
  function keyOf(m) {
    const sid = m.series_id;
    // 有效 series_id：非 null、非空串、非 0（数字或字符串'0'）、非 'null'/'undefined'、非 orphan_ 前缀
    // ★ 2026-08-22 强化：原仅检查 sid !== 0（数字），漏掉字符串 '0'（Steam LIVE JSON 反序列化后）
    var sidStr = (sid == null ? '' : String(sid)).trim();
    var sidInvalid = sid == null || sidStr === '' || sidStr === '0' ||
                     sidStr === 'null' || sidStr === 'undefined' ||
                     /^orphan_/.test(sidStr);
    if (!sidInvalid) {
      // ★ 2026-08-22：剥离 LPDB bracket id 的局号后缀（如 lp_R02-M003-001 → lp_R02-M003）
      //   防御 LPDB 给同 BO3 各局分配独立 bracketid（含局号）导致拆分。
      //   仅对 'lp_' 前缀生效；OpenDota 数字 series_id 与其他前缀原样返回。
      if (sidStr.indexOf('lp_') === 0) {
        var stripped = sidStr.replace(/[-_\s]\d{2,3}$/, '');
        if (stripped !== sidStr) return 's_' + stripped;
      }
      return 's_' + sidStr;
    }
    // ★ 2026-08-22 强化兜底键：归一化队名对（顺序无关），与 liquipedia.js 跨源去重同口径。
    //   原 toLowerCase + sort 容易被 "Team Spirit" vs "Team  Spirit" 双空格、
    //   "Nigma Galaxy" vs "Nigma" 后缀差异等切开 → 同一 BO3 各局分到不同桶。
    //   归一化：小写 + 去 esports/gaming/team/club 后缀 + 去非字母数字 + 双向排序。
    //   ★ 2026-09-01（三卡修复）：剥离「 x 赞助商」后缀（与 buildLpLiveSeries._normTeamX 同口径）
    function _normTeam(s) {
      if (!s) return '';
      var n = String(s).toLowerCase().trim();
      n = n.replace(/\s*[x×]\s+\S+.*$/i, '');
      n = n.replace(/\s*(esports|e-sports|gaming|team|club)\s*$/g, '');
      n = n.replace(/[^a-z0-9一-鿿а-яё]/g, '');
      return n;
    }
    var t1 = _normTeam(m.team1Name || m.radiant_team_name);
    var t2 = _normTeam(m.team2Name || m.dire_team_name);
    const st = _liqStartOf(m);
    if ((t1 || t2) && st > 0) {
      const day = Math.floor(st / 86400);
      // 顺序无关：归一名排序后拼接（防数据源换边）
      var pair = t1 < t2 ? (t1 + '|' + t2) : (t2 + '|' + t1);
      return 'k_' + pair + '@' + day;
    }
    return null; // 无法聚合 → 单独成行
  }
  const buckets = {};
  const order = [];
  matches.forEach(function (m) {
    const k = keyOf(m);
    if (k == null) { order.push(m); return; }
    if (!buckets[k]) { buckets[k] = []; order.push(k); }
    buckets[k].push(m);
  });
  // ★ 跨桶缝合：同一队名对可能跨 UTC 日界分到两个 day 桶（如 BO3 跨午夜），
  //   这里把队名对相同、day 相邻（差 ≤ 1）的桶合并后再做链式聚类。
  var teamPairBuckets = {};  // 'teamA|teamB' -> [{ day, key, arr }]
  Object.keys(buckets).forEach(function (k) {
    if (/^k_/.test(k) && buckets[k].length) {
      var atIdx = k.lastIndexOf('@');
      if (atIdx > 2) {
        var pair = k.substring(2, atIdx);
        if (!teamPairBuckets[pair]) teamPairBuckets[pair] = [];
        teamPairBuckets[pair].push({ key: k, arr: buckets[k] });
      }
    }
  });
  var stitchedKeys = {};  // 已被缝合消费的桶 key → true
  var stitchedGroups = [];  // 缝合后的组（每个是数组的数组）
  Object.keys(teamPairBuckets).forEach(function (pair) {
    var list = teamPairBuckets[pair];
    if (list.length <= 1) return;  // 单桶无需缝合
    // 按 day 升序排
    list.sort(function (a, b) {
      var da = a.arr.length ? (_liqStartOf(a.arr[0]) || 0) : 0;
      var db = b.arr.length ? (_liqStartOf(b.arr[0]) || 0) : 0;
      return da - db;
    });
    // 合并所有同队名对的桶（不限制 day 差，由后续链式聚类的时间差约束精确切分）
    var merged = [];
    list.forEach(function (b) { merged = merged.concat(b.arr); stitchedKeys[b.key] = true; });
    stitchedGroups.push(merged);
  });
  // 链式聚类：按 startTime 排序的数组，相邻差 >6h 切开成子组
  function chainCluster(sorted) {
    if (!sorted || sorted.length <= 1) return sorted ? [sorted] : [];
    var groups = [];
    var cur = [sorted[0]];
    for (var i = 1; i < sorted.length; i++) {
      var prevStart = _liqStartOf(cur[cur.length - 1]) || 0;
      var thisStart = _liqStartOf(sorted[i]) || 0;
      if (prevStart > 0 && thisStart > 0 && Math.abs(thisStart - prevStart) > 6 * 3600) {
        groups.push(cur);
        cur = [sorted[i]];
      } else {
        cur.push(sorted[i]);
      }
    }
    groups.push(cur);
    return groups;
  }
  var out = [];
  // ① 缝合后的组（跨 day 桶的同队名对）→ 链式聚类 → mergeLiquipediaGroup
  stitchedGroups.forEach(function (merged) {
    var sorted = merged.slice().sort(function (a, b) {
      return (_liqStartOf(a) || 0) - (_liqStartOf(b) || 0);
    });
    chainCluster(sorted).forEach(function (sg) {
      if (sg.length >= 1) out.push(mergeLiquipediaGroup(sg));
    });
  });
  // ② 原桶顺序处理（跳过已被缝合消费的）
  order.forEach(function (entry) {
    if (typeof entry === 'string' && buckets[entry]) {
      if (stitchedKeys[entry]) return;  // 已在缝合段处理
      var group = buckets[entry];
      var sorted = group.slice().sort(function (a, b) {
        return (_liqStartOf(a) || 0) - (_liqStartOf(b) || 0);
      });
      chainCluster(sorted).forEach(function (sg) {
        if (sg.length >= 1) out.push(mergeLiquipediaGroup(sg));
      });
    } else {
      out.push(entry); // 无法聚合的原始 match，原样保留
    }
  });
  return out;
}

function mergeLiquipediaGroup(group) {
  const base = group[0];
  const starts = group.map(_liqStartOf).filter(Boolean);
  const startTime = starts.length ? Math.min.apply(null, starts) : _liqStartOf(base);
  // phase：取最高优先级（live > recent > upcoming），保证系列状态正确
  const phase = group
    .map(function (m) { return m.phase || 'upcoming'; })
    .sort(function (a, b) { return (PHASE_RANK[b] || 0) - (PHASE_RANK[a] || 0); })[0] || 'upcoming';
  // 比分：取同组「总分最大」的那场作为系列最终比分（最接近真实战报）
  function total(m) { return (m.score1 || 0) + (m.score2 || 0); }
  const best = group.slice().sort(function (a, b) { return total(b) - total(a); })[0] || base;
  // matchIds 合并去重（供后续 matchIds 硬关联去重 / 吸收）
  const ids = [];
  const seen = {};
  group.forEach(function (m) {
    if (m.matchIds && m.matchIds.length) ids.push.apply(ids, m.matchIds);
    else if (m.match_id) ids.push(m.match_id);
  });
  const dedupIds = ids.filter(function (x) {
    const k = String(x);
    if (seen[k]) return false;
    seen[k] = 1;
    return true;
  });
  return {
    // —— 透传 Liquipedia 形状字段（保证 buildSeriesFromSources map 段兼容）——
    team1Name: base.team1Name || base.radiant_team_name || '',
    team2Name: base.team2Name || base.dire_team_name || '',
    team1Short: base.team1Short || '',
    team2Short: base.team2Short || '',
    // ★ 2026-09-01（进行中卡修复）：透传 Steam LIVE 原生字段 —— radiant_team_id/dire_team_id
    //   （首页 live 卡队徽按 id 查询、点击跳转依赖）与 team1Logo/team2Logo（UGC 队标直出，
    //   省一次 explorer 查询）。原实现聚合后丢失 → buildLpLiveSeries 消费侧拿不到。
    radiant_team_id: base.radiant_team_id || 0,
    dire_team_id: base.dire_team_id || 0,
    team1Logo: base.team1Logo || '',
    team2Logo: base.team2Logo || '',
    startTime: startTime,
    start_time: startTime,        // 兼容两种字段名（v3 输出 start_time，旧 wikitext 输出 startTime）
    phase: phase,
    status: best.status || base.status || '',
    boType: base.boType || best.boType || null,
    score1: best.score1 != null ? best.score1 : 0,
    score2: best.score2 != null ? best.score2 : 0,
    series_id: base.series_id || null,
    series_type: (base.series_type != null ? base.series_type : null),  // applyBo S3 据此定 BO（如 LPDB bestof=3 → BO3）
    bracketId: base.bracketId || null,
    matchIds: dedupIds,
    mapSlots: base.mapSlots || 0,
    section: base.section || '',
    walkover: base.walkover || 0,
    boDeclared: base.boDeclared || false,
    pagename: base.pagename || '',
    // ★ 2026-09-01（首页 v5.1）：聚合透传联赛名 —— buildLpUpcomingSeries 消费聚合对象时
    //   需要 leagueName 渲染首页 LP 卡头（缺省会退化「职业赛事」）。原实现聚合后丢失。
    leagueName: base.leagueName || base._leagueName || '',
    _leagueName: base.leagueName || base._leagueName || '',
    // ★ 2026-09-01 补修：聚合透传 leagueId —— 原实现只透传了 leagueName，
    //   buildLpUpcomingSeries 的 `leagueId: m.leagueId || 0` 因此恒为 0，
    //   首页 LP 卡点击跳转联赛详情丢目标（_cardFromSeries 依赖 s.leagueId）。
    leagueId: base.leagueId || 0,
    // 标记：由聚合产生，供调试 / 可选渲染小场（各局原始记录）
    _aggregated: true,
    _games: group
  };
}

// ★ 2026-09-01（首页 v5.1）：Liquipedia/Steam/haglund 排期对局 → 首页「对局级 upcoming」系列。
//   背景：首页此前无对局级 upcoming 数据源 —— OpenDota /teams/{id}/matches 实测只返回历史比赛
//   （1922 条、未来 0 条），proMatches//live 均为已开赛，curation 仅有赛事级卡（无对阵）。
//   本函数消费 liquipedia.getScheduledMatches 返回的 LP 形状 matches（team1Name/team2Name/
//   startTime/phase/boType/series_type/mapSlots），过滤出「未开赛 + 双方确定队名」的 upcoming，
//   经 groupLiquipediaMatches 聚合（防 BO3 各局拆成多张卡），映射为与 groupSeries 输出兼容的
//   系列对象（radiantName/direName/lastTime/phase/boType…），供首页 _cardFromSeries 直接消费。
//   纯函数（不依赖 wx/云），可单测。
function buildLpUpcomingSeries(lpMatches, now) {
  if (!Array.isArray(lpMatches) || !lpMatches.length) return [];
  now = now || Math.floor(Date.now() / 1000);
  var TBD_RE = /^(tbd|tba|待定|待公布|unknown)$/i;
  // ① 过滤：未开赛（start 在未来）。★ v8.29：TBD 对阵不再整卡过滤——预选赛对阵未定是
  //    常态，原过滤导致「即将开始」永远为空（RES 预选 4 场全含 TBD 被丢弃）。只丢弃
  //    双方均无名字的无信息卡；TBD 侧改写为「待定」渲染。
  //    聚合键安全核查：groupLiquipediaMatches 兜底键为「归一化队名对 + 同日桶」，
  //    「待定|nemesis」与「待定|其他」键不同不会误并；TBD vs TBD 多场合一张可接受。
  var upcoming = lpMatches.filter(function (m) {
    if (!m) return false;
    var st = m.startTime || m.start_time || 0;
    if (!st || st <= now) return false;
    var n1 = String(m.team1Name || '').trim();
    var n2 = String(m.team2Name || '').trim();
    if (!n1 && !n2) return false;
    if (TBD_RE.test(n1)) { n1 = 'TBD'; m.team1Name = n1; }
    if (TBD_RE.test(n2)) { n2 = 'TBD'; m.team2Name = n2; }
    m.team1Name = n1; m.team2Name = n2;
    return true;
  });
  if (!upcoming.length) return [];
  // ② 聚合：同队名对 + 同日（≤6h 链式聚类）合并为一项，防 BO3 各局拆卡
  var grouped = groupLiquipediaMatches(upcoming);
  // ③ 映射为 series 形状（对齐 groupSeries 输出，_cardFromSeries 兼容）
  return grouped.map(function (m, idx) {
    var st = m.startTime || m.start_time || 0;
    return {
      key: 'lpup_' + idx + '_' + Math.floor(st / 60),   // 分钟桶稳定键（数据源轮询间 startTime 抖动容忍）
      games: [],
      phase: 'upcoming',
      isUpcoming: true,
      isLive: false,
      isMulti: false,
      scoreA: 0,
      scoreB: 0,
      boType: m.boType || 'BO1',
      seriesType: (m.series_type != null ? m.series_type : null),   // applyBo S3 信号
      declaredBo: m.boDeclared ? (m.boType || null) : null,          // applyBo S1 信号
      mapSlots: m.mapSlots || 0,                                     // applyBo S4.5 信号
      radiantName: m.team1Name,
      direName: m.team2Name,
      radiantTeamId: 0,
      direTeamId: 0,
      firstTime: st,
      lastTime: st,
      leagueName: m._leagueName || m.leagueName || '',
      leagueId: m.leagueId || 0,
      matchIds: m.matchIds || [],
      series_id: m.series_id || null
    };
  });
}

// ★ 2026-09-01（进行中卡修复）：Liquipedia/Steam/haglund 排期对局 → 首页「对局级 live」系列。
//   背景：首页「进行中」段此前只有 curation 赛事级卡（无对阵/比分）——LP/Steam 排期里
//   已开赛的 LIVE 对局（phase='live'，Steam LIVE 数据含 series_id/score1/score2/队标）
//   被 buildLpUpcomingSeries 的「未开赛」过滤（start > now）丢弃 → 进行中段无对局卡。
//   本函数与 buildLpUpcomingSeries 对称：**保留已开赛且未结束的 LIVE 场**，同样经
//   groupLiquipediaMatches 聚合（防 Steam LIVE「一局=1条」的 BO3 拆卡），映射为 series。
//   输出与 groupSeries 兼容（radiantName/direName/scoreA/scoreB/phase='live'），
//   供首页 _cardFromSeries 直接消费（_applyMatchSources ⑥ 段并入）。
//   纯函数（不依赖 wx/云），可单测。
function buildLpLiveSeries(lpMatches, now) {
  if (!Array.isArray(lpMatches) || !lpMatches.length) return [];
  now = now || Math.floor(Date.now() / 1000);
  var TBD_RE = /^(tbd|tba|待定|待公布|unknown)$/i;
  // ★ 2026-09-01（多卡修复）：series 是否已结束的独立判定（不依赖上游 phase）。
  //   Steam GetLiveLeagueGames 在比赛结束后短暂残留返回该对局，normalizeSteamLiveGame
  //   的 phase 判定在 series_type 缺失时仅 `totalScore>=6` 判 recent → BO3 2:0（总分2）、
  //   BO5 3:1（总分4）等已结束残留场 phase 仍为 'live' → 首页多卡。
  //   本守卫与详情页 absorbSettledGames 的「已结算局吸收」同语义：按系列比分达上限判结束。
  //   series_type 映射（Steam 规范）：0=BO1(1胜) 1=BO3(2胜) 2=BO5(3胜) 3=BO2(2胜) 4=BO7(4胜)
  function _seriesEnded(m) {
    var s1 = (m.score1 != null ? m.score1 : 0);
    var s2 = (m.score2 != null ? m.score2 : 0);
    var total = s1 + s2;
    if (total === 0) return false;                       // 无比分 → 无法判定，按 live 处理
    var st = m.series_type;
    if (st != null && st >= 0) {
      var boNum = [1, 3, 5, 2, 7][st] || (st * 2 + 1);
      var winsToClinch = Math.ceil(boNum / 2);
      return Math.max(s1, s2) >= winsToClinch;
    }
    // series_type 缺失的兜底：
    //   ① 比分总和 >= 6（绝不可能在 BO5 内达到）→ 已结束
    //   ② max(score) >= 3 → 至少 BO5 已打完（BO3 上限 2 胜，3 胜只能是 BO5+ 且已拿下）
    //   ③ 2:0 / 0:2 → BO3 或 BO2 已结束（BO5 2:0 未完但概率低；Steam 残留场以短 BO 为主）
    //      —— 2:0 在 BO3/BO2 下必已结束；即使误杀 BO5 2:0，用户看到的是「进行中但无比分」，
    //      也远好于把已结束场当 live 展示。保守取「任一侧 >=2 且另一侧为 0」判结束。
    if (total >= 6) return true;
    if (Math.max(s1, s2) >= 3) return true;
    if ((s1 === 2 && s2 === 0) || (s2 === 2 && s1 === 0)) return true;
    return false;
  }
  // ① 过滤：已开赛（start 在过去）+ 双方均为确定队名 + 未结束（phase 与比分双守卫）
  //   注意：Steam LIVE 场 startTime 为「当前时间」占位（无固定开赛时间），
  //   故以 phase==='live' 为主判据，startTime 仅作辅助（haglund 等源有真实开赛时间）。
  var live = lpMatches.filter(function (m) {
    if (!m) return false;
    var ph = m.phase || '';
    var st = m.startTime || m.start_time || 0;
    var isLivePhase = (ph === 'live');
    var isRecentPhase = (ph === 'recent');
    // 已结束（recent 或系列比分达上限）不渲染为进行中
    if (isRecentPhase) return false;
    // ★ 比分守卫：phase 误判 live 但比分已达 BO 上限 → 已结束残留场，排除
    if (_seriesEnded(m)) return false;
    if (!isLivePhase && st && st > now) return false;   // 未来场 → 归 upcoming 函数处理
    if (!isLivePhase && st && st <= now) {
      // 无 phase 标记但已开赛：需结合「未结束」证据（无 series 比分或未达 BO 上限）
      // 保守起见：仅当同时有比分且比分总和达上限才排除，否则视为 live（首页兜底展示）
    }
    var n1 = String(m.team1Name || m.radiant_team_name || '').trim();
    var n2 = String(m.team2Name || m.dire_team_name || '').trim();
    if (!n1 || !n2 || TBD_RE.test(n1) || TBD_RE.test(n2)) return false;
    return true;
  });
  if (!live.length) return [];
  // ★ 2026-09-01（三卡修复）：跨源同对局去重（live 专用，不污染 groupLiquipediaMatches 通用逻辑）。
  //   根因：同一对局在 Steam（全名如 'Inner Circle x Insanity'）与 Liquipedia/haglund（简称
  //   'Inner Circle'）中队名写法不同 + startTime 不同（Steam 用 Date.now() 占位、真实开赛在数小时前）
  //   → 归一化键不匹配 + 「同 UTC 日」分组失效 → 同一对局拆成多张卡。
  //   方案：按「剥离 x 赞助商后缀后的队名对」去重（**时间无关**——live 场 startTime 不可靠），
  //   组内保留信息量最大的一条（有 series_id > 无；有比分 > 无；score 总和大 > 小）。
  function _normTeamX(s) {
    if (!s) return '';
    var n = String(s).toLowerCase().trim();
    // 剥离「 x 赞助商」后缀（Valve 全名 'Team x Sponsor' → 'Team'）：
    //   'Inner Circle x Insanity' → 'innercircle'；'Pipsqueak + 4' → 'pipsqueak4'
    n = n.replace(/\s*[x×]\s+\S+.*$/i, '');
    n = n.replace(/\s*(esports|e-sports|gaming|team|club)\s*$/g, '');
    n = n.replace(/[^a-z0-9一-鿿а-яё]/g, '');
    return n;
  }
  function _pairKeyX(m) {
    var a = _normTeamX(m.team1Name || m.radiant_team_name);
    var b = _normTeamX(m.team2Name || m.dire_team_name);
    if (!a || !b) return null;
    return a < b ? (a + '|' + b) : (b + '|' + a);
  }
  function _infoScoreX(m) {
    var sc = 0;
    if (m.series_id != null && m.series_id !== 0 && String(m.series_id) !== '0') sc += 1000;
    sc += ((m.score1 || 0) + (m.score2 || 0)) * 10;
    if (m.boType) sc += 5;
    if (m.radiant_team_id) sc += 2;
    return sc;
  }
  var dedupMap = {};    // pairKeyX -> best match
  var dedupOrder = [];
  live.forEach(function (m) {
    var pk = _pairKeyX(m);
    // ★ 2026-09-17（P1-9 修复）：原写法键错位 ——
    //   赋值用 `dedupOrder.length`（设为 N），而 push 用 `(dedupOrder.length - 1)`
    //   （push 尚未执行，length 仍为 N，故算出 N-1）→
    //     dedupMap 实际写的是 __standalone_N
    //     dedupOrder 记录的却是 __standalone_(N-1)
    //   → ① 该条匹配对象写入无人引用的键（数据丢失）；
    //     ② dedupOrder.map 取到 undefined → 下游 groupLiquipediaMatches 访问
    //        m.team1Name 抛 TypeError → buildLpLiveSeries 中断
    //        （被 _fetchLpUpcoming 的 .catch 吞没 → 首页 ⑥ 段对局卡静默消失）。
    //   触发条件：某场 live 的队名归一化后为空（_pairKeyX 返回 null），属数据异常场景。
    if (!pk) {
      var sk = '__standalone_' + dedupOrder.length;
      dedupMap[sk] = m;
      dedupOrder.push(sk);
      return;
    }
    var prev = dedupMap[pk];
    if (!prev) { dedupMap[pk] = m; dedupOrder.push(pk); return; }
    if (_infoScoreX(m) > _infoScoreX(prev)) dedupMap[pk] = m;
  });
  live = dedupOrder.map(function (k) { return dedupMap[k]; });
  // ② 聚合：同队名对 + ≤6h 链式聚类合并为一项（防 Steam LIVE 各局拆卡）
  var grouped = groupLiquipediaMatches(live);
  // ③ 映射为 series 形状（对齐 groupSeries 输出，_cardFromSeries 兼容）
  return grouped.map(function (m, idx) {
    var st = m.startTime || m.start_time || now;
    // 系列比分（Steam LIVE 原生提供；无则 0:0 由 phase 判定 live）
    var sc1 = (m.score1 != null ? m.score1 : 0);
    var sc2 = (m.score2 != null ? m.score2 : 0);
    var sid = m.series_id || null;
    return {
      key: 'lplive_' + (sid != null && sid !== 0 ? ('s' + sid) : (idx + '_' + Math.floor(st / 60))),
      games: [],
      phase: 'live',
      isUpcoming: false,
      isLive: true,
      isMulti: false,
      scoreA: sc1,
      scoreB: sc2,
      boType: m.boType || 'BO1',
      seriesType: (m.series_type != null ? m.series_type : null),   // applyBo S3 信号
      declaredBo: m.boDeclared ? (m.boType || null) : null,         // applyBo S1 信号
      mapSlots: m.mapSlots || 0,                                    // applyBo S4.5 信号
      radiantName: m.team1Name || m.radiant_team_name || '',
      direName: m.team2Name || m.dire_team_name || '',
      radiantTeamId: m.radiant_team_id || m.team1Id || 0,           // Steam LIVE 有真实 team_id
      direTeamId: m.dire_team_id || m.team2Id || 0,
      firstTime: st,
      lastTime: st,
      leagueName: m._leagueName || m.leagueName || '',
      leagueId: m.leagueId || 0,
      matchIds: m.matchIds || (m.match_id ? [m.match_id] : []),
      series_id: sid,
      // 队标（Steam LIVE 直接返回，_enrichMatchLogos 可优先消费）
      // ★ 2026-09-01（图片加载失败修复）：仅透传「字符串且 https」的 logo——
      //   上游（Steam normalizeSteamLiveGame）可能返回对象形态（{logo: url}），
      //   透传对象 → 下游 <image src> 收到对象 → 微信序列化成 __pageframe__ 路径报错。
      //   统一提取字符串 URL；非 https 置空（image-fallback 走首字母占位）。
      team1Logo: (typeof m.team1Logo === 'string' && /^https?:\/\//i.test(m.team1Logo)) ? m.team1Logo
        : (m.team1Logo && typeof m.team1Logo === 'object' && typeof (m.team1Logo.logo || m.team1Logo.url) === 'string' && /^https?:\/\//i.test(m.team1Logo.logo || m.team1Logo.url) ? (m.team1Logo.logo || m.team1Logo.url) : ''),
      team2Logo: (typeof m.team2Logo === 'string' && /^https?:\/\//i.test(m.team2Logo)) ? m.team2Logo
        : (m.team2Logo && typeof m.team2Logo === 'object' && typeof (m.team2Logo.logo || m.team2Logo.url) === 'string' && /^https?:\/\//i.test(m.team2Logo.logo || m.team2Logo.url) ? (m.team2Logo.logo || m.team2Logo.url) : ''),
      _source: 'lp-live'
    };
  });
}

module.exports = {
  SOURCE_LABEL: SOURCE_LABEL,
  groupLiquipediaMatches: groupLiquipediaMatches,
  buildLpUpcomingSeries: buildLpUpcomingSeries,
  buildLpLiveSeries: buildLpLiveSeries,
  getLeagueTier: getLeagueTier,
  voteLeagueNameForMatch: voteLeagueNameForMatch,
  getLeagueWindow: getLeagueWindow,
  getUpcomingFromCuration: getUpcomingFromCuration,
  getLeagueMetadata: getLeagueMetadata,
  getLeagueStandings: getLeagueStandings,
  groupSeries: groupSeries,
  // ★ 2026-08-04：BO 判定引擎（S2 赛制文本 / S3 series_type 映射 / S4 同赛事自证 / S5 约束 / S6 默认）
  buildBoContext: buildBoContext,
  resolveBoType: resolveBoType,
  applyBo: applyBo,
  // ★ 2026-08-04（v1.1 实施）：LP live/upcoming 卡吸收 OpenDota 已结算局 + liveProgress（R2/R5）
  absorbSettledGames: absorbSettledGames,
  liveProgressOf: liveProgressOf,
  // ★ 2026-08-04（v1.1 实施，审核 R5）：LIVE 低频重拉决策（有 live 卡且 ≥5min 间隔）
  shouldRefreshOpenDota: shouldRefreshOpenDota,
  allMatchIdsInSet: allMatchIdsInSet,
  resolveTeamIdName: resolveTeamIdName,
  // ★ 2026-09-01（v8.4）：赛事详情页数据重叠修复三件套（纯函数，可单测）
  filterMatchesByWindow: filterMatchesByWindow,
  dedupeLiveSeries: dedupeLiveSeries,
  mergeSplittedBo3Series: mergeSplittedBo3Series,
  filterMisattributedRecentSeries: filterMisattributedRecentSeries,
  dropDuplicateNameIds: dropDuplicateNameIds,
  classifyStage: classifyStage,
  enrichTeamLogo: enrichTeamLogo,
  enrichPlayerAvatar: enrichPlayerAvatar,
  enrichTeamInfo: enrichTeamInfo,
  crossTeamMembers: crossTeamMembers,
  validatePlayerId: validatePlayerId,
  getTeamPriority: getTeamPriority,
  getMatchTier: getMatchTier,
  canonicalLeagueName: canonicalLeagueName,
  leagueDisplayName: leagueDisplayName,
  getUpcomingLocalSnapshot: getUpcomingLocalSnapshot
};
