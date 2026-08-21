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
    if (ev.start <= horizon && (!ev.end || ev.end >= now)) {
      // 防御守卫：已开赛（start <= now）但缺 end 的条目无法判定是否结束，跳过
      // （下游 mergeCurationUpcoming 的 cardStatus 判定要求 startDate && endDate 都存在，
      //   缺 end 会落到 'upcoming'，导致已开赛赛事误进「即将到来」tab）。
      if (ev.start <= now && !ev.end) return;
      list.push({
        name: ev.canonical,
        startDate: ev.start,
        endDate: ev.end || null,
        tier: ev.tier || { grade: 'S', rank: 3, label: 'S级' },
        year: ev.year || null,
        leagueId: (ev.leagueId != null) ? ev.leagueId : null,  // 方案 E：透传真实 id
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
function getSeriesKey(m) {
  if (m._patchedSeriesKey) return m._patchedSeriesKey;
  const sid = m.series_id;
  return (sid != null && sid !== 0) ? ('s' + sid) : ('m' + m.match_id);
}

// ★ 2026-08-12 强化版：series_id 缺失兜底（5 重约束防误并）。
//   遍历 series_id=null 的局，找到「同队ID对（不计顺序）+ 邻居 series_type≥1 + 邻居≥2局
//   + 时间夹在邻居实际跨度[first-30min, last+30min]内 + 时间最近」的合格邻居系列，
//   借用其 series_id 写入 _patchedSeriesKey 软关联字段（不动原 series_id，便于审计回滚）。
//   OpenDota 修复后无 null 局，此函数自然空转，无副作用。
function patchNullSeriesId(matches) {
  if (!PATCH_NULL_SERIES_ENABLED || !matches || matches.length === 0) return matches;
  const TOL_SEC = 30 * 60;  // 时间容差：前后各 30min（覆盖局间休息 + 数据延迟）

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

  // 2. 构造合格邻居候选清单（约束①②：series_type≥1 + count≥2）
  var qualified = [];  // [{ key, first, last, seriesType, teamAId, teamBId }]
  Object.keys(seriesStats).forEach(function (k) {
    var s = seriesStats[k];
    if (s.seriesType != null && s.seriesType >= 1 && s.count >= 2 &&
        s.teamAId != null && s.teamAId > 0 && s.teamBId != null && s.teamBId > 0) {
      qualified.push({
        key: k, first: s.first, last: s.last,
        teamAId: s.teamAId, teamBId: s.teamBId
      });
    }
  });
  if (qualified.length === 0) return matches;  // 无合格邻居，直接返回原数组

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
      // 约束③：null 局时间必须夹在邻居系列 [first-TOL, last+TOL] 内
      if (nStart < q.first - TOL_SEC || nStart > q.last + TOL_SEC) continue;
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
  // 4. ★ 孤儿互并（补齐旧版只能借邻居、无法两孤儿彼此合并的缺口）：
  //    对 series_id 仍为空、且未被步骤3借到邻居的局，按「同队ID对(不计顺序) + 同日(UTC 自然日)」
  //    直接合成共享 series 键，使同一 BO 系列的若干局合并成一张系列卡（而非各自 BO1）。
  //    适用：LPDB v3 来源（normalizeV3Match 现已产出 series_id，此为兜底）或 OpenDota 两局都漏填 series_id。
  //    防误并：① 仅同队ID对；② 同日粒度；③ 合成键前缀 'orphan_' 与真实 's<series_id>' 不冲突；④ 步骤5 比分越界自动回滚。
  var orphanList = [];
  for (var p = 0; p < matches.length; p++) {
    var pm = matches[p];
    if ((pm.series_id == null || pm.series_id === 0) && !pm._patchedSeriesKey) {
      var pA = pm.radiant_team_id, pB = pm.dire_team_id;
      if (pA == null || pA <= 0 || pB == null || pB <= 0) continue;
      var pStart = pm.start_time || 0;
      if (!pStart) continue;
      orphanList.push({ m: pm, A: pA, B: pB, day: Math.floor(pStart / 86400) });
    }
  }
  var obuckets = {};
  orphanList.forEach(function (it) {
    var pk = it.A < it.B ? (it.A + '_' + it.B) : (it.B + '_' + it.A);
    var bk = pk + '@' + it.day;
    (obuckets[bk] || (obuckets[bk] = [])).push(it);
  });
  Object.keys(obuckets).forEach(function (bk) {
    var arr = obuckets[bk];
    if (arr.length < 2) return;
    var synKey = 'orphan_' + bk;
    arr.forEach(function (it) {
      it.m._patchedSeriesKey = synKey;
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[patchNullSeriesId]', { matchId: it.m.match_id, toKey: synKey, reason: 'orphan_pair_day_cluster' });
      }
    });
  });
  return matches;
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
    const phase = isLive ? 'live' : (isUpcoming ? 'upcoming' : 'recent');
    // 系列 BO 类型判定（基于胜负场数，比 series_type 更可靠）
    // 规则：
    //   一方赢3局 → BO5（五局三胜，BO3 不可能出现3胜）
    //   一方赢2局 → BO3（三局两胜），除非 series_type=0 且恰好2场→BO2（双局积分全胜）
    //   1-1 平局 → BO2（双局积分制，BO3 不可能平局）
    //   1场 → BO1
    let boType = 'BO1';
    const st = first.series_type;
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
  (Array.isArray(openSeriesList) ? openSeriesList : []).forEach(function (s) {
    (s.games || []).forEach(function (g) {
      if (g && g.match_id) byMatchId.set(String(g.match_id), { series: s, game: g });
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
    if (card.matchIds && card.matchIds.length) {
      const hit = [];
      card.matchIds.forEach(function (id) {
        const h = byMatchId.get(String(id));
        if (h) hit.push(h);
      });
      absorbHits(card, hit);
      return;
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

// ★ 2026-08-20：Liquipedia 来源的系列赛聚合（修复「一场 BO3 被拆成多张 BO1 卡」）
// 根因：Liquipedia v3 / wikitext 对阵中，同一 BO 系列的每一局是独立 match 记录；
//   buildSeriesFromSources 的 Liquipedia 合并段原本直接 .map 每个 match 成一张独立 series 卡，
//   未做 series 维度聚合（OpenDota 路径走 groupSeries 正确聚合，Liquipedia 路径缺失这一步）。
//   导致 LPDB 返回的 BO3 三局 → 3 张 BO1 卡（用户实测「Team Spirit vs Iron Wing 拆成两张 BO1」）。
// 纯函数（不依赖 wx/Page），与 groupSeries 对称：按 series_id（或队名对+同日兜底）把同系列多局合并为一项。
// 返回聚合后的 Liquipedia 形状 match 列表（字段对齐 buildSeriesFromSources map 段读取需求）。
function _liqStartOf(m) { return m.startTime || m.start_time || 0; }
const PHASE_RANK = { live: 3, recent: 2, upcoming: 1 };

function groupLiquipediaMatches(matches) {
  if (!Array.isArray(matches) || !matches.length) return [];
  // 聚合键：series_id 优先；缺失时用「队名对(顺序无关) + UTC 自然日」兜底（覆盖 LPDB 未返回 series_id / 旧 wikitext 路径）
  function keyOf(m) {
    const sid = m.series_id;
    if (sid != null && sid !== '' && !/^orphan_/.test(String(sid))) {
      return 's_' + sid;
    }
    const t1 = String(m.team1Name || m.radiant_team_name || '').trim().toLowerCase();
    const t2 = String(m.team2Name || m.dire_team_name || '').trim().toLowerCase();
    const st = _liqStartOf(m);
    const day = st ? Math.floor(st / 86400) : 0;
    if ((t1 || t2) && st > 0) return 'k_' + [t1, t2].sort().join('|') + '@' + day;
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
  const out = [];
  order.forEach(function (entry) {
    if (typeof entry === 'string' && buckets[entry]) {
      out.push(mergeLiquipediaGroup(buckets[entry]));
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
    // 标记：由聚合产生，供调试 / 可选渲染小场（各局原始记录）
    _aggregated: true,
    _games: group
  };
}

module.exports = {
  SOURCE_LABEL: SOURCE_LABEL,
  groupLiquipediaMatches: groupLiquipediaMatches,
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
