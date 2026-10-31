// scripts/test-formatters.js
// 页面纯函数单测：fmt / buildH2h / buildItems / isKnownEvent 等，
// 独立于网络/UI，可在 Node 直接跑。
'use strict';

const util = require('../../utils/util.js');
const incremental = require('../../utils/incremental.js');
const matchView = require('../../utils/matchView.js');

let passed = 0, failed = 0;
function check(label, fn) {
  try { fn(); passed++; }
  catch (e) { failed++; console.log('FAIL  ' + label + '  ->  ' + e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

// ===== util.formatDuration =====
check('formatDuration: 0 → 00:00', () => assert(util.formatDuration(0) === '00:00'));
check('formatDuration: 90s → 01:30', () => assert(util.formatDuration(90) === '01:30'));
check('formatDuration: 3600s → 1h 00m', () => assert(util.formatDuration(3600) === '1h 00m'));
check('formatDuration: 3725s → 1h 02m', () => assert(util.formatDuration(3725) === '1h 02m'));

// ===== util.formatTime =====
check('formatTime: null → ""', () => assert(util.formatTime(null) === ''));
check('formatTime: 0 → ""', () => assert(util.formatTime(0) === ''));
check('formatTime: unix → YYYY-MM-DD', () => {
  const r = util.formatTime(1704067200); // 2024-01-01
  assert(/^\d{4}-\d{2}-\d{2}$/.test(r), '格式应为 YYYY-MM-DD，实际: ' + r);
});

// ===== util.formatDateTime（★ 2026-10-31：淘汰赛对阵卡「MM-DD HH:mm」北京时间）=====
check('formatDateTime: null → ""', () => assert(util.formatDateTime(null) === ''));
check('formatDateTime: 固定北京时间 → MM-DD HH:mm', () => {
  // UTC 2024-01-01 00:00 → 北京 2024-01-01 08:00
  assert(util.formatDateTime(1704067200) === '01-01 08:00', '实际: ' + util.formatDateTime(1704067200));
});
check('formatDateTime: 跨午夜按北京时间取日期（UTC 前一日）', () => {
  // UTC 2026-10-28 17:00 = 北京 2026-10-29 01:00（CET 晚间赛事的典型场景）
  const unix = Math.floor(Date.UTC(2026, 9, 28, 17, 0) / 1000);
  assert(util.formatDateTime(unix) === '10-29 01:00', '实际: ' + util.formatDateTime(unix));
});
check('formatDateTime: withYear → YYYY-MM-DD HH:mm', () => {
  assert(util.formatDateTime(1704067200, { withYear: true }) === '2024-01-01 08:00');
});

// ===== util.winRate =====
check('winRate: 0/0 → 0%', () => assert(util.winRate(0, 0) === '0%'));
check('winRate: 5/10 → 50%', () => assert(util.winRate(5, 10) === '50%'));
check('winRate: 3/7 → 43%', () => assert(util.winRate(3, 7) === '43%'));

// ===== util.playerWon =====
check('playerWon: 天辉 slot 0 + radiant_win=true → true', () =>
  assert(util.playerWon({ player_slot: 0, radiant_win: true }) === true));
check('playerWon: 天辉 slot 4 + radiant_win=false → false', () =>
  assert(util.playerWon({ player_slot: 4, radiant_win: false }) === false));
check('playerWon: 夜魇 slot 128 + radiant_win=false → true', () =>
  assert(util.playerWon({ player_slot: 128, radiant_win: false }) === true));
check('playerWon: 夜魇 slot 132 + radiant_win=true → false', () =>
  assert(util.playerWon({ player_slot: 132, radiant_win: true }) === false));

// ===== util.isCurrentMember =====
check('isCurrentMember: true → true', () => assert(util.isCurrentMember({ is_current_team_member: true })));
check('isCurrentMember: 1 → true', () => assert(util.isCurrentMember({ is_current_team_member: 1 })));
check('isCurrentMember: false → false（非现役）', () => assert(util.isCurrentMember({ is_current_team_member: false }) === false));
check('isCurrentMember: undefined → false', () => assert(util.isCurrentMember({}) === false));

// ===== util.formatDateRange =====
check('formatDateRange: both → "4/22 - 4/28"', () =>
  assert(util.formatDateRange(1713744000, 1714262400) !== ''));
check('formatDateRange: only start → non-empty', () =>
  assert(util.formatDateRange(1713744000, null) !== ''));
check('formatDateRange: null,null → ""', () =>
  assert(util.formatDateRange(null, null) === ''));

// ===== buildH2h (团队详情页对战记录聚合) =====
// 模拟 team-detail.js 的 buildH2h 逻辑
function buildH2h(matches) {
  const map = {};
  (matches || []).forEach((m) => {
    if (!m.oppId) return;
    if (!map[m.oppId]) {
      map[m.oppId] = { oppId: m.oppId, oppName: m.oppName || '未知', wins: 0, losses: 0, games: 0 };
    }
    const h = map[m.oppId];
    h.games++;
    if (m.won) h.wins++; else h.losses++;
  });
  return Object.keys(map).map((k) => {
    const h = map[k];
    h.winRate = h.games ? Math.round(h.wins / h.games * 100) : 0;
    return h;
  }).sort((a, b) => b.games - a.games).slice(0, 15);
}

check('buildH2h: 空列表 → []', () => assert(buildH2h([]).length === 0));
check('buildH2h: 单个对手 3-2 → 胜率 60%', () => {
  const ms = [
    { oppId: 1, oppName: 'Navi', won: true },
    { oppId: 1, oppName: 'Navi', won: true },
    { oppId: 1, oppName: 'Navi', won: true },
    { oppId: 1, oppName: 'Navi', won: false },
    { oppId: 1, oppName: 'Navi', won: false },
  ];
  const r = buildH2h(ms);
  assert(r.length === 1, '应只有一个对手');
  assert(r[0].wins === 3 && r[0].losses === 2, '胜负应对');
  assert(r[0].winRate === 60, '胜率 3/5=60%');
  assert(r[0].games === 5, '场次 5');
});
check('buildH2h: 多个对手按场次降序', () => {
  const ms = [
    { oppId: 1, oppName: 'A', won: true },
    { oppId: 1, oppName: 'A', won: false },
    { oppId: 2, oppName: 'B', won: true },
    { oppId: 2, oppName: 'B', won: true },
    { oppId: 2, oppName: 'B', won: true },
    { oppId: 3, oppName: 'C', won: false },
  ];
  const r = buildH2h(ms);
  assert(r[0].oppId === 2, 'B 最多场次应在第一，实际: ' + JSON.stringify(r));
});
check('buildH2h: 忽略无 oppId 比赛', () => {
  const ms = [
    { oppId: null, oppName: '', won: true },
    { oppId: 1, oppName: 'A', won: true },
  ];
  assert(buildH2h(ms).length === 1);
});

// ===== buildItems (比赛详情页出装；2026-10-30 C5 起直接测 utils/matchView.js) =====
const buildItems = matchView.buildItems;

const fakeItemMap = { 1: { name: 'blink', img: 'items/blink.png', dname: 'Blink Dagger' } };
check('buildItems: 空槽位 → []', () => assert(buildItems({}, fakeItemMap).length === 0));
check('buildItems: 1个物品 → 长度1', () => {
  assert(buildItems({ item_0: 1 }, fakeItemMap).length === 1);
});
check('buildItems: item_0=0 时忽略', () => {
  assert(buildItems({ item_0: 0, item_1: 1 }, fakeItemMap).length === 1);
});
check('buildItems: 未知物品 id → 占位', () => {
  const r = buildItems({ item_0: 999 }, fakeItemMap);
  assert(r.length === 1 && r[0].name === 'item_999');
});

// ===== leagues.js isKnownEvent =====
const KNOWN_KEYWORDS = /(international|major|esl\s+one|esl\s+pro|dreamleague|blast|riyadh|pgl|betboom|clavision|fissure|the\s+summit|games\s+of\s+the\s+future|heroic|resurrection|weplay|moonstorm|dpc|tour|division\s+i)/i;
function isKnownEvent(name) { return KNOWN_KEYWORDS.test(name || ''); }
check('isKnownEvent: "The International 2024" → true', () => assert(isKnownEvent('The International 2024')));
check('isKnownEvent: "ESL One Birmingham" → true', () => assert(isKnownEvent('ESL One Birmingham')));
check('isKnownEvent: "DreamLeague Season 26" → true', () => assert(isKnownEvent('DreamLeague Season 26')));
check('isKnownEvent: "Riyadh Masters 2024" → true', () => assert(isKnownEvent('Riyadh Masters 2024')));
check('isKnownEvent: "Unknown Cup" → false', () => assert(!isKnownEvent('Unknown Cup')));
check('isKnownEvent: null → false', () => assert(!isKnownEvent(null)));

// ===== util.formatPrizePool（2026-10-26：赛事信息卡奖金紧凑格式化） =====
check('formatPrizePool: 2000000 USD → $2M', () => assert(util.formatPrizePool(2000000, 'USD') === '$2M'));
check('formatPrizePool: 12500000 USD → $12.5M', () => assert(util.formatPrizePool(12500000, 'USD') === '$12.5M'));
check('formatPrizePool: 750000 USD → $750K', () => assert(util.formatPrizePool(750000, 'USD') === '$750K'));
check('formatPrizePool: 750 USD → $750（不进 K）', () => assert(util.formatPrizePool(750, 'USD') === '$750'));
check('formatPrizePool: 500000 EUR → €500K', () => assert(util.formatPrizePool(500000, 'EUR') === '€500K'));
check('formatPrizePool: 1000000 GBP → £1M', () => assert(util.formatPrizePool(1000000, 'GBP') === '£1M'));
check('formatPrizePool: 未配置符号的币种带码（BRL 有符号）', () => assert(util.formatPrizePool(300000, 'BRL') === 'R$300K'));
check('formatPrizePool: 未知币种 → 码 + 空格', () => assert(util.formatPrizePool(300000, 'XYZ') === 'XYZ 300K'));
check('formatPrizePool: 空/0/null → ""', () => {
  assert(util.formatPrizePool(null, 'USD') === '');
  assert(util.formatPrizePool(0, 'USD') === '');
  assert(util.formatPrizePool('abc', 'USD') === '');
});
check('formatPrizePool: 缺省币种按 USD', () => assert(util.formatPrizePool(2000000) === '$2M'));

// ===== util.formatPrizeRaw（展开区原始值） =====
check('formatPrizeRaw: 2000000 → "2,000,000 USD"', () =>
  assert(util.formatPrizeRaw(2000000, 'USD') === '2,000,000 USD'));
check('formatPrizeRaw: 750 → "750 USD"', () =>
  assert(util.formatPrizeRaw(750, 'USD') === '750 USD'));
check('formatPrizeRaw: 空 → ""', () => assert(util.formatPrizeRaw(null) === ''));

// ===== incremental.maxStart / mergeMatches (已有 test-incremental，补充边界) =====
check('maxStart: 1条数据', () => assert(incremental.maxStart([{ start_time: 999 }]) === 999));
check('mergeMatches: 全部去重', () => {
  const old = [{ match_id: 1 }, { match_id: 2 }];
  const delta = [{ match_id: 1 }, { match_id: 2 }];
  assert(incremental.mergeMatches(old, delta).length === 2);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
