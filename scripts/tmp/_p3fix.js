const fs = require('fs');
const P = 'utils/curation.js';
const NL = String.fromCharCode(10);
let s = fs.readFileSync(P, 'utf8');
const BLANK = "   // ★ 2026-09-25 P3：LP 无此页（--find 前缀/搜索实测）⇒ 留空，不保留死值";
const FIX = "   // ★ 2026-09-25 P3：原值为死链，真身经 --find 实测";
const EDITS = [
  // ── 有真身：修 ──
  ["    liquipediaSlug: 'Dota_2_World_Invitational' },",
   "    liquipediaSlug: 'Portal Dota 2 World Invitationals/2024' }," + FIX + "（14 场）"],
  ["    aliases: ['dotaworldinvitational', 'd2wi'], year: 2024,",
   "    aliases: ['dotaworldinvitational', 'd2wi', 'portaldota2worldinvitationals'], year: 2024," + NL +
   "   // ↑ 2026-09-25 P3 补：OpenDota 的**真实 league 名**是 'Portal Dota2 World Invitationals'（16527），" + NL +
   "   //   原别名集里没有它 ⇒ 名字匹配必 MISS（只能靠 leagueId 或新别名）"],
  ["    liquipediaSlug: 'EPL_World_Series:_Southeast_Asia_Season_17' },",
   "    liquipediaSlug: 'EPL/World Series/Southeast Asia/17' }," + FIX + "（36 场）"],
  ["    liquipediaSlug: 'European_Pro_League_Season_40' },",
   "    liquipediaSlug: 'European Pro League/40' }," + FIX + "（44 场）"],
  // ── 确无页面：留空（保留键、置 ''，与 DPC 2022-23 的处理一致）──
  ["    liquipediaSlug: 'Triton_League' },", "    liquipediaSlug: ''," + BLANK],
  ["    liquipediaSlug: 'Mega_Arena' },", "    liquipediaSlug: ''," + BLANK + "（year=2025，LP 只有 X5/Brasil Mega Arena 等**别的品牌**）"],
  ["    participants: 16, status: '已结束', liquipediaSlug: 'CCT/2024',",
   "    participants: 16, status: '已结束', liquipediaSlug: ''," + BLANK + "（LP 只有 CCT/Season N/M 子页，无年度页）"],
  ["    participants: 16, status: '已结束', liquipediaSlug: 'CCT/2025',",
   "    participants: 16, status: '已结束', liquipediaSlug: ''," + BLANK + "（同上）"],
  ["    participants: 16, status: '已结束', liquipediaSlug: 'Pinnacle/2024',",
   "    participants: 16, status: '已结束', liquipediaSlug: ''," + BLANK + "（LP 只有 Pinnacle Cup/… 子页）"],
  ["    participants: 16, status: '已结束', liquipediaSlug: 'Pinnacle/2025',",
   "    participants: 16, status: '已结束', liquipediaSlug: ''," + BLANK + "（同上）"],
  ["    liquipediaSlug: 'WINLINE_Star_Series_Season_4' },",
   "    liquipediaSlug: ''," + BLANK + "（LP 只有 Winline/Super Mixer Cup 与 Winline Insight/N，无 Star Series）"],
  ["    liquipediaSlug: 'Sber_Tournament_2026' },",
   "    liquipediaSlug: ''," + BLANK + "（2026 届 LP 拆成 /2026/Amateur 与 /2026/Pro，无单一主页）"]
];
let bad = 0;
EDITS.forEach(([o, n], i) => {
  const c = s.split(o).length - 1;
  if (c !== 1) { console.log('❌ 锚点 ' + (i + 1) + ' 命中 ' + c + ' 次（须为 1）：' + o.trim().slice(0, 46)); bad++; return; }
  s = s.replace(o, n);
});
if (bad) { console.log('中止：有锚点不唯一，未写盘'); process.exit(1); }
fs.writeFileSync(P, s, 'utf8');
console.log('✅ 12 处全部替换成功（每处锚点均唯一命中）');
