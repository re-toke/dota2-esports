const TIER_RANK = require('./api.js').TIER_RANK;
const tiers = require('./tiers.js');

// 统一赛事分级：优先社区精选规则（tiers.js），否则回退 OpenDota 的 tier 枚举。
// 返回 { grade:'S'|'A'|'B'|'C', rank:0..3, label, source:'community'|'opendota' }
// ★ v3 优化项27：修复 community 重复计权 bug — communityTierFromName 命中后 source 已正确标记为 'community'
function unifiedTier(league) {
  const odTier = league.tier || 'excluded';
  const curated = tiers.communityTierFromName(league.name);
  if (curated) {
    return { grade: curated.grade, rank: curated.rank, label: curated.label, source: 'community', odTier: odTier };
  }
  if (odTier === 'professional') return { grade: 'S', rank: 3, label: 'S级', source: 'opendota', odTier: odTier };
  if (odTier === 'premium') return { grade: 'A', rank: 2, label: 'A级', source: 'opendota', odTier: odTier };
  if (odTier === 'amateur') return { grade: 'B', rank: 1, label: 'B级', source: 'opendota', odTier: odTier };
  return { grade: 'C', rank: 0, label: '其他', source: 'opendota', odTier: odTier };
}

// 秒 -> "1h 05m" / "42:17"
function formatDuration(sec) {
  sec = sec || 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = m < 10 ? '0' + m : '' + m;
  const ss = s < 10 ? '0' + s : '' + s;
  return h > 0 ? (h + 'h ' + mm + 'm') : (mm + ':' + ss);
}

// unix 秒 -> "2024-08-03"
// 2026-07-28 修复：使用 UTC 年月日，与 curation.start/end（Date.UTC）和
// liquipediaDateToUnix（Date.UTC）保持同一时区，避免跨时区导致日期 ±1 天偏差。
// 之前的 getFullYear/getMonth/getDate 使用本地时区（如 UTC+8），
// 在 UTC 0:00~8:00 之间 unix 秒会落到「前一天」，导致赛期显示比公示早一天。
function formatTime(unix) {
  if (!unix) return '';
  const d = new Date(unix * 1000);
  const y = d.getUTCFullYear();
  const mo = ('0' + (d.getUTCMonth() + 1)).slice(-2);
  const da = ('0' + d.getUTCDate()).slice(-2);
  return y + '-' + mo + '-' + da;
}

// 赛事等级中文标签
function tierLabel(tier) {
  const map = {
    professional: 'S级',
    premium: 'A级',
    amateur: '业余',
    excluded: '其他'
  };
  return map[tier] || '未知';
}

// 等级数字（用于排序/筛选）
function tierRank(tier) {
  return TIER_RANK[tier] || 0;
}

// 判断「我方战队」是否获胜：radiant 表示我方是否处于天辉方
function didTeamWin(match) {
  return match.radiant === match.radiant_win;
}

// 胜率
function winRate(wins, total) {
  if (!total) return '0%';
  return Math.round((wins / total) * 100) + '%';
}

// 是否现役成员
function isCurrentMember(p) {
  return p.is_current_team_member === true || p.is_current_team_member === 1;
}

// 选手在某场比赛中是否获胜：player_slot < 128 表示天辉
function playerWon(match) {
  const isRadiant = match.player_slot < 128;
  return isRadiant === match.radiant_win;
}

// 解析 "2024-04-22" 为 Unix 秒（UTC）；非法返回 null
function parseISODate(s) {
  if (!s) return null;
  const m = String(s).trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return null;
  return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 1000);
}

// now（Unix 秒），不传则取当前
function nowSec() { return Math.floor(Date.now() / 1000); }

// 赛事是否正在进行：已开赛且真实结束时间仍在缓冲内，或 startDate<=now<=endDate
// win 可包含 OpenDota 的 earliest/latest/lastEnd，以及外部源的 startDate/endDate
// 注意：lastEnd = max(start_time + duration) 才是真实结束时间；latest 只是最后一场开赛时间，
// 不能直接当结束边界（否则最后一场开赛后很久仍被误判为进行中）。lastEnd 缺失时回退 latest。
//
// 三条判定路径（优先级从高到低）：
//   ① OpenDota 真实结束时间（lastEnd）在缓冲期内 → 精确匹配
//   ② Curation/外部源日期范围（startDate ~ endDate + 1天宽限）→ 覆盖 SQL 缓存陈旧场景
//   ③ 未结算比赛证据兜底：latest 在缓冲期内 且 存在 duration=0/缺失 的比赛
//      （lastEnd < latest 或 lastEnd=0 说明有正在进行的比赛未被计入真实结束时间）
//      此路径防止"当天最后几场 BO3/BO5 进行中但因 duration=0 导致 lastEnd 偏小"的场景，
//      同时避免因数据回填/修正导致 latest 变新而误判已结束赛事为进行中。
function isOngoing(win, now) {
  if (!win) return false;
  now = now || nowSec();
  const buf = require('./config.js').leagueWindow.ongoingBufferSec;
  // ① OpenDota 真实结束时间路径
  if (win.earliest && win.earliest <= now) {
    const end = win.lastEnd || win.latest;
    if (end && end >= now - buf) return true;
  }
  // ② Curation / 外部源日期范围路径
  if (win.startDate && win.endDate && win.startDate <= now && now <= win.endDate + 86400) return true;
  // ③ 未结算比赛证据兜底：最新开赛时间在缓冲期内 + 存在未结算比赛（duration=0 或缺失）
  //    条件收紧：必须同时满足 (a) latest 处于活跃窗口内 (b) lastEnd 无效或早于 latest
  //    这排除了"已结束赛事因数据回填导致 latest 变新"的误判场景
  if (win.latest && win.latest <= now && win.latest >= now - buf) {
    const end = win.lastEnd || 0;
    if (!end || end < win.latest) return true;
  }
  return false;
}

// 赛事是否即将到来：开赛时间在未来 N 秒内
function isUpcoming(win, now) {
  if (!win) return false;
  now = now || nowSec();
  const horizon = now + require('./config.js').leagueWindow.upcomingRangeSec;
  // 外部源的开赛日期在未来范围内
  if (win.startDate && win.startDate > now && win.startDate <= horizon) return true;
  // OpenDota earliest 在未来（通常为空，兜底）
  if (win.earliest && win.earliest > now && win.earliest <= horizon) return true;
  return false;
}

// 综合状态：'ongoing' | 'upcoming' | 'ended'
// ★ 覆盖规则（优先级从高到低）：
//   1. ongoing：比赛已开始（latest > 0）且未结束（lastEnd 为 0 或 lastEnd >= latest）
//   2. upcoming：startDate/earliest 在未来 upcomingRangeSec 窗口内（当前 ≤ 开赛 ≤ now+窗口）
//   3. ended：以上均不满足，视为已结束
// 注意：ongoing 优先于 upcoming。若数据异常（既有 ongoing 特征又有未来 startDate），
//   判定为 ongoing（已开赛的比赛不会被误判为 upcoming）。
function statusOf(win, now) {
  now = now || nowSec();
  if (isOngoing(win, now)) return 'ongoing';
  if (isUpcoming(win, now)) return 'upcoming';
  return 'ended';
}

// 数据校验：归一化赛事窗口数据，确保列表页与详情页使用一致的数据源。
// 检查项：
//   1. earliest/latest/lastEnd 为正数（无效值置 0）
//   2. 单调性：lastEnd >= latest >= earliest，违反则丢弃异常值（防 SQL 返回脏数据）
//   3. curation startDate/endDate 有效性：start > 0 且 end >= start，否则置 null
// 返回归一化后的 { earliest, latest, lastEnd, startDate, endDate }。
// 2026-07-28：列表页 loadLeagueEntry/loadUpcomingSerial 与详情页 load() 均应调用此函数，
//   确保两边对「赛期」与「状态判定」使用完全一致的数据源，防止同类不一致 BUG 复发。
function validateLeagueWindow(win) {
  if (!win) return { earliest: 0, latest: 0, lastEnd: 0, startDate: null, endDate: null };
  const num = function (v) { const n = Number(v); return (isFinite(n) && n > 0) ? n : 0; };
  const earliest = num(win.earliest);
  const latest = num(win.latest);
  const lastEnd = num(win.lastEnd);
  // 单调性校验：lastEnd >= latest >= earliest
  const validLatest = (latest >= earliest) ? latest : 0;
  const validLastEnd = (lastEnd >= validLatest) ? lastEnd : validLatest;
  // curation/外部源日期校验
  const curS = num(win.startDate);
  const curE = num(win.endDate);
  const startDate = (curS > 0 && curE >= curS) ? curS : null;
  const endDate = (startDate != null) ? curE : null;
  return {
    earliest: earliest,
    latest: validLatest,
    lastEnd: validLastEnd,
    startDate: startDate,
    endDate: endDate
  };
}

// 把 Unix 秒格式化为 "M/D"，用于紧凑展示日期范围
function fmtShort(t) {
  if (!t) return '';
  const d = new Date(t * 1000);
  return (d.getMonth() + 1) + '/' + d.getDate();
}

// 格式化日期范围："4/22 - 4/28" / "4/22" / ""
function formatDateRange(start, end) {
  const s = fmtShort(start);
  const e = fmtShort(end);
  if (s && e) return s + ' - ' + e;
  return s || e || '';
}

// 相对时间标签（用于「更新于 X 前」）：传入采集时间戳(unix 毫秒)或 0
function formatAgo(fetchedAt) {
  const now = Date.now();
  if (!fetchedAt) return '';
  let sec = Math.floor((now - fetchedAt) / 1000);
  if (sec < 0) sec = 0;
  if (sec < 60) return '刚刚更新';
  const min = Math.floor(sec / 60);
  if (min < 60) return min + ' 分钟前更新';
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + ' 小时前更新';
  const day = Math.floor(hr / 24);
  return day + ' 天前更新';
}

module.exports = {
  formatDuration,
  formatTime,
  tierLabel,
  tierRank,
  unifiedTier,
  didTeamWin,
  winRate,
  isCurrentMember,
  playerWon,
  parseISODate,
  isOngoing,
  isUpcoming,
  statusOf,
  validateLeagueWindow,
  formatDateRange,
  formatAgo,
  nowSec
};
