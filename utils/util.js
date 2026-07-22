const TIER_RANK = require('./api.js').TIER_RANK;
const tiers = require('./tiers.js');

// 统一赛事分级：优先社区精选规则（tiers.js），否则回退 OpenDota 的 tier 枚举。
// 返回 { grade:'SSS'|'S'|'A'|'B'|'C', rank:0..4, label, source:'community'|'opendota' }
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
function formatTime(unix) {
  if (!unix) return '';
  const d = new Date(unix * 1000);
  const y = d.getFullYear();
  const mo = ('0' + (d.getMonth() + 1)).slice(-2);
  const da = ('0' + d.getDate()).slice(-2);
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

// 赛事是否正在进行：已开赛且最近 N 秒内仍有比赛，或 startDate<=now<=endDate
// win 可包含 OpenDota 的 earliest/latest，以及外部源的 startDate/endDate
function isOngoing(win, now) {
  if (!win) return false;
  now = now || nowSec();
  const buf = require('./config.js').leagueWindow.ongoingBufferSec;
  if (win.earliest && win.earliest <= now && win.latest && win.latest >= now - buf) return true;
  if (win.startDate && win.endDate && win.startDate <= now && now <= win.endDate + 86400) return true;
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
function statusOf(win, now) {
  now = now || nowSec();
  if (isOngoing(win, now)) return 'ongoing';
  if (isUpcoming(win, now)) return 'upcoming';
  return 'ended';
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
  formatDateRange,
  formatAgo
};
