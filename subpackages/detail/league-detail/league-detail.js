const api = require('../../../utils/api.js');
const util = require('../../../utils/util.js');
const sources = require('../../../utils/sources.js');
const follow = require('../../../utils/follow.js');
const subscribe = require('../../../utils/subscribe.js');
// ★ 2026-08-07（审核 R2）：账号登录态（订阅授权手势红线——缓存命中才同步弹授权）
const auth = require('../../../utils/auth.js');
const config = require('../../../utils/config.js');
const liveSources = require('../../../utils/liveSources.js');
const remoteCuration = require('../../../utils/remoteCuration.js');
const liquipedia = require('../../../utils/liquipedia.js');
const cloudProxy = require('../../../utils/cloudProxy.js');   // ★ 2026-09-01 P0-3③：详情页 bundle 聚合
const heroes = require('../../../utils/heroes.js');
const logoCache = require('../../../utils/logoCache.js'); // Phase 1-⑦：persistNow onUnload
// ★ 2026-08-11 长期架构改进落地：数据源健康检查（数据为空时区分「数据源暂不可用」与「确实无数据」）
const dataHealth = require('../dataHealth.js');
// 2026-07-30 修复赛期截断：详情页回退读取 upcoming-local.json 的日期窗口，
// 覆盖不在 curation 中且无 OpenDota 比赛的赛事（如 1win Essence II，leagueId 为负数占位）。
// ★ 通过主包 sources 模块间接获取 upcoming-local 快照，避免分包直接 require JSON 的兼容性问题。
function getUpcomingLocalSnapshot() {
  if (sources && sources.getUpcomingLocalSnapshot) return sources.getUpcomingLocalSnapshot();
  return null;
}

// Steam CDN 英雄头像基址（_sb.png = 小横幅图，约 59x33，aspectFill 裁切填满方形框）
const HERO_IMG_BASE = 'https://cdn.cloudflare.steamstatic.com/apps/dota2/images/heroes/';

// 可信度数值化，取两者中最保守者作为整体可信度
const CONF_RANK = { low: 1, medium: 2, high: 3 };
const CONF_TEXT = { low: '待核实', medium: '较可信', high: '可信' };

// TBD / 待定 队名识别（模块级，供多个方法共享，避免跨方法作用域 no-undef）
const TBD_RE = /^(tbd|待定|待公布|unknown|tba|to\s+be\s+(determined|announced))$/i;
// ★ 2026-08-05（v1.1，审核 R1）：空字符串（LP 未确认方占位 {{TeamOpponent|}} 归一为 'TBD' 前/后的兜底）也视为 TBD
function isTBD(name) {
  var s = String(name || '').trim();
  if (!s) return true;
  return TBD_RE.test(s);
}

// ★ v3 优化项25（2026-08-22 提升为模块级）：队名归一化 —— 小写 + 去常见后缀（esports/gaming/team/club）+ 去空格标点。
//   原实现位于 §9 局部 if 块内（原 L738），8-22 新增的 refresh logo 队名兜底（oldByTeamPair 双保险，L1332 起）
//   在块外调用导致 no-undef（ESLint error）+ 运行时 ReferenceError。纯函数无外部依赖，提升后两处共用同一口径。
function normalizeTeamNameForDedup(name) {
  if (!name) return '';
  var n = String(name).toLowerCase().trim();
  n = n.replace(/\s*(esports|e-sports|gaming|team|club)\s*$/g, '');
  n = n.replace(/[^a-z0-9一-鿿а-яё]/g, '');
  return n;
}

// B4 定时刷新（2026-08-03）：series 指纹 —— 稳定 key + 关键状态字段。
// refreshSchedule 用它做逐项 diff，仅路径 setData 变化的项，保留用户翻页/折叠态。
// key：OpenDota series 用 series_id/match_id（groupSeries 生成，稳定）；
//      Liquipedia 用 'liq-' + 归一化队名 + startTime（2026-08-03 起不再含不稳定 idx）。
function fingerprintSeries(s) {
  var key = s.key || '';
  return key + '|' + (s.phase || '') + '|' + (s.scoreA || 0) + ':' + (s.scoreB || 0) +
    '|' + (s.radiantName || '') + ':' + (s.direName || '') + '|' + (s.lastTime || 0) +
    '|' + (s.boType || '') + '|' + (s.scheduledTimeText || '');
}
function worstConfidence(a, b) {
  if (!a && !b) return 'low';
  const ra = CONF_RANK[a || 'low'];
  const rb = CONF_RANK[b || 'low'];
  const min = Math.min(ra, rb);
  return min >= 3 ? 'high' : (min === 2 ? 'medium' : 'low');
}

// 来源 key -> 中文标签
const SOURCE_BADGES = {
  opendota: 'OpenDota',
  stratz: 'STRATZ',
  steam: 'Steam',
  liquipedia: 'Liquipedia',
  curation: '本地策展',
  community: '社区规则'
};

// 把 sources 返回的 source 标签数组转成统一徽标对象
function buildSourceBadges(srcArr) {
  if (!srcArr || !srcArr.length) return [];
  const seen = {};
  const out = [];
  for (let i = 0; i < srcArr.length; i++) {
    const k = (srcArr[i] || '').toLowerCase();
    if (!k || seen[k]) continue;
    seen[k] = true;
    out.push({ key: k, label: SOURCE_BADGES[k] || srcArr[i] });
  }
  return out;
}

// 状态 -> 中文标签 + 颜色（与赛事列表页 leagues.js 的 statusBadgeOf 保持一致）
// 批次1 §9.2：LIVE/进行中统一红 --status-live
function statusBadgeOf(status) {
  if (status === 'ongoing') return { text: '进行中', color: '#EF4444' };
  if (status === 'upcoming') return { text: '即将到来', color: '#ffcf5c' };
  return { text: '已结束', color: '#6b7280' };
}

// 生成 metadata 骨架：确保 KPI Strip 每个字段都有 key，无数据时统一展示 '--'。
function buildMetadataSkeleton() {
  return {
    canonical: null,
    prizePool: null,
    prizePoolCurrency: null,
    location: null,
    format: null,
    organizer: null,
    startDate: null,
    endDate: null,
    participants: null,
    status: null,
    liquipediaSlug: null,
    sources: []
  };
}

// 当 Liquipedia / Steam 元数据缺失（禁用或拉取失败）时，用 curation 本地策展字段兜底，
// 拼成与 kpi-strip 兼容的 metadata 结构（奖金池/地点/赛制/主办方/赛期/参赛队/状态/Liquipedia slug）。
function buildCurationFallback(cur) {
  if (!cur) return null;
  const fmt = function (sec) { return sec ? util.formatTime(sec) : null; };
  return {
    source: 'curation',
    sources: ['curation'],
    canonical: cur.canonical || '',
    prizePool: cur.prizePool != null ? String(cur.prizePool) : null,
    prizePoolCurrency: cur.prizePoolCurrency || null,
    location: cur.region || null,            // curation 用 region，kpi-strip 用 location
    format: cur.format || null,
    organizer: cur.organizer || null,
    startDate: fmt(cur.start) || cur.startDate || null,   // curation 历史字段为 unix 秒
    endDate: fmt(cur.end) || cur.endDate || null,
    participants: cur.participants != null ? cur.participants : null,
    status: cur.status || null,
    liquipediaSlug: cur.liquipediaSlug || null
  };
}

// 合并已有网络元数据与 curation 兜底，确保返回完整骨架。
// 2026-07-27：传入 leagueId + game 上下文，让 curation 引擎走精确 pin + 跨游戏隔离，
// 防止 CS2 同名联赛（如「ESL Pro League S24」）的元数据污染 DOTA2 详情页。
// 2026-08-11 方案 B/L2 修复：participants 字段特殊处理（数组优先于非数组）。
//   背景：Object.assign({}, fb, meta) 让 meta（Liquipedia 返回）覆盖 fb（curation 兜底）。
//   一旦 meta.participants 是非数组（数字或空数组），会覆盖 fb.participants 数组，
//   导致 curation 人工策展的参赛队伍列表丢失，详情页退回「待定队伍 1..N」占位。
function mergeMetadataWithFallback(meta, name, leagueId) {
  const cur = remoteCuration.curatedEventFor(name, { leagueId: leagueId, game: 'dota2' });
  const fb = cur ? buildCurationFallback(cur) : buildMetadataSkeleton();
  const merged = Object.assign({}, fb, meta || {});
  // L2 修复：fb.participants 是数组（高可信度人工策展）+ merged.participants 不是数组（被 meta 数字/空覆盖）
  //   → 恢复 fb.participants。两个都是数组时仍让 meta 覆盖（Liquipedia 数组可能更实时）。
  if (Array.isArray(fb && fb.participants) && !Array.isArray(merged.participants)) {
    merged.participants = fb.participants;
  }
  return merged;
}

Page({
  data: {
    leagueId: '',
    name: '',           // OpenDota 原始联赛名（导航参数传入）
    displayName: '',    // 展示用名称：优先取多源共识名/curation canonical，回退 raw name
    series: [],
    totalSeries: 0,
    loading: true,
    error: '',
    // ★ 2026-08-11：数据源健康提示（Liquipedia/OpenDota 链路异常时显示，非「暂无数据」）
    sourceDownHint: '',
    page: 0,
    pageSize: config.pageSize,
    hasMore: false,
    liqTier: null,     // 分级（多源交叉验证：community / curation / OpenDota / STRATZ）
    nameInfo: null,    // 规范赛事名（多源交叉验证：OpenDota / curation / STRATZ）
    quality: null,     // 整体数据可信度徽标
    updatedAt: 0,      // 数据最后采集时间戳（新鲜度）
    updatedLabel: '',
    followed: false,
    metadata: buildMetadataSkeleton(),  // 赛事元数据（Liquipedia + Steam + curation 兜底）
    sourcesText: '',                    // 元数据来源中文名拼接（如 'Liquipedia / Steam'）
    sourceBadges: [],                   // 数据来源徽标列表（统一展示）
    // F1 直播聚合入口
    liveSources: [],   // 各平台直播搜索入口
    isLive: false,     // 赛事是否正在进行（卡片高亮置顶）
    // ===== 三段式分段计数（2026-07-28 新增） =====
    // series[] 按 phase 分段：live(desc) → upcoming(asc) → recent(desc)
    // liveCount/upcomingCount/recentCount 供 wxml 渲染分段分隔符与计数
    liveCount: 0,
    upcomingCount: 0,
    recentCount: 0,
    // 已结束段默认折叠（聚焦 LIVE/UPCOMING），点击分隔符展开
    recentCollapsed: false,
    // ===== 三 Tab 状态（C 风格 Tournament Center） =====
    tab: 'matches',          // matches | teams | standings
    expandedGame: '',        // 当前展开的小场 "seriesIdx-gameIdx"（A 风格就地展开英雄阵容）
    // 赛事排名
    standings: [],
    standingsLoading: false,
    standingsLoaded: false,
    // 参赛队伍（从比赛数据推导）
    participantsList: [],
    // ===== P3（2026-08-31）：Liquipedia 小组积分表 + 淘汰赛对阵（排名 Tab 内懒加载） =====
    lpGroups: [],            // [{ name, teams: [{rank,name,placement}] }]
    lpBrackets: [],          // [{ id, type, section, rounds: [{label, matches}] }]
    lpStructureLoading: false,
    lpStructureLoaded: false
  },

  onLoad(options) {
    const name = decodeURIComponent(options.name || '');
    const leagueId = Number(options.leagueId);
    // 2026-07-27 防复发：若传入的 leagueId 不是该赛事在 curation 中 pin 的权威 leagueId，
    // 而 curation 中确有对应精确 pin，尝试重定向到 pin 的 leagueId，避免深层链接/缓存落入次级/低级别 id。
    // （例如：openLeague/data-name 传入的 name 可能与 pin 的 canonical 匹配，但 id 是旧缓存的 19080，
    //   需纠正回 19944）
    const cur = remoteCuration.curatedEventFor(name, { leagueId: leagueId, game: 'dota2' });
    const effectiveId = (cur && cur.leagueId != null && cur.leagueId !== leagueId) ? cur.leagueId : leagueId;
    if (effectiveId !== leagueId) {
      wx.redirectTo({
        url: '/subpackages/detail/league-detail/league-detail?leagueId=' + effectiveId + '&name=' + encodeURIComponent(name)
      });
      return;
    }
    const lid = String(effectiveId);
    // ★ 2026-08-11 方案 A+R1 修复：兼容查 legacyFakeId。
    //   场景：用户在方案 A 实施前用 fakeId（如 -1653808）关注过 TI 2026，重定向到真实 id（19719）后
    //   查 isFollowed('leagues', '19719') 返回 false，导致老用户关注状态丢失。
    //   兼容查法：同时查真实 id 和 curation 提供的 legacyFakeId，任一命中都视为已关注。
    //   注意：此处的 cur 是 L186 已查到的 curation 条目（含 legacyFakeId 字段），无需重新查询。
    const legacyFake = (cur && cur.legacyFakeId != null) ? cur.legacyFakeId : null;
    const followedNow = follow.isFollowed('leagues', lid) ||
      (legacyFake != null && follow.isFollowed('leagues', String(legacyFake)));
    // F1 修复：合并为单次 setData（减少 1 次 Virtual DOM diff，约省 5ms）
    this.setData({
      leagueId: lid,
      name: name,
      displayName: name,
      followed: followedNow,
      _legacyFakeId: legacyFake,  // 缓存供 toggleFollow 使用
      liveSources: liveSources.buildSources(name)
    });
    wx.setNavigationBarTitle({ title: name || '赛事详情' });
    this.load();

    // 分级 / 名称 / 元数据：3 个异步源用计数器统一收口，避免级联 setData。
    // 每个源返回后暂存到 this._pending，3 个全部完成后（或超时 8s）统一 refreshQuality + refreshSourceBadges 一次。
    this._pending = { tier: null, name: null, meta: null };
    this._pendingCount = 0;
    this._pendingTotal = 3;
    const finalize = () => {
      this._pendingCount++;
      if (this._pendingCount < this._pendingTotal) return;
      // 所有源返回，清理超时 timer 并统一刷新一次
      if (this._pendingTimer) {
        clearTimeout(this._pendingTimer);
        this._pendingTimer = null;
      }
      const p = this._pending || {};
      const patch = {};
      if (p.tier) patch.liqTier = p.tier;
      if (p.name) patch.nameInfo = p.name;
      // 展示名优先级：curation canonical（人工校正，最高）> 多源共识名 > 原始 OpenDota 名
      // 理由：curation 条目是人工核实的权威名称（如 "EPL Masters 2026" 实为 "EPL Masters I"），
      //       consensus 投票在名称归一化后分组的票数相同时可能选错（如选了更长的原始名）
      // G5：p.name 来自 voteLeagueNameForMatch（共识投票名），仅在本分支②作为兜底，
      //     展示首选恒为 curation canonical（分支①），绝不直接以共识名作主展示。
      const raw = this.data.name;
      // 2026-07-27：传入 leagueId + game，启用精确 pin + 跨游戏隔离
      const cur2 = remoteCuration.curatedEventFor(raw, { leagueId: this.data.leagueId, game: 'dota2' });
      let display = raw;
      if (cur2 && cur2.canonical && cur2.canonical !== raw) {
        display = cur2.canonical;                           // ① curation 显式校正
      } else if (p.name && p.name.value && p.name.value !== raw) {
        display = p.name.value;                             // ② 多源共识名与原始名不同
      }
      if (display !== raw) {
        patch.displayName = display;
        // 异步更新导航栏标题（避免在 setData 之前调用）
        setTimeout(() => wx.setNavigationBarTitle({ title: display }), 0);
      }
      // 元数据：Liquipedia/Steam 结果 与 curation 兜底合并，确保所有赛事都有完整 KPI 结构
      const mergedMeta = mergeMetadataWithFallback(p.meta, this.data.name, this.data.leagueId);
      // 2026-07-30 修复赛期竞态：load() 已用 eventWindow（curation > 真实比赛窗口 > upcoming-local 快照）
      // 构建了权威赛期；finalize 的 mergedMeta 来自 Liquipedia 原始 tpl.edate（可能不完整/被截断为开始日期）。
      // 若 eventWindow 已存在且有效，保留其日期，避免异步合并时用 Liquipedia 脏数据覆盖正确赛期。
      const ew = this.data.eventWindow;
      if (ew && ew.start && ew.end) {
        mergedMeta.startDate = util.formatTime(ew.start);
        mergedMeta.endDate = util.formatTime(ew.end);
      }
      // 2026-07-28 修复 BUG 3：统一 KPI 名称与头部名称的取值来源。
      // 此前 meta.canonical 来自 Liquipedia（tpl.name），patch.displayName 来自 curation canonical，
      // 两者走不同路径，可能产生「头部显示 EPL Masters I 而 KPI 显示 EPL Masters 2026」的不一致。
      // 修复：以已计算的 display（curation canonical 优先）覆盖 meta.canonical，
      // 保证 KPI 概述卡与头部展示名完全一致。
      if (display && display !== mergedMeta.canonical) {
        mergedMeta.canonical = display;
      }
      patch.metadata = mergedMeta;
      patch.sourcesText = (mergedMeta.sources || []).map((s) => sources.SOURCE_LABEL[s] || s).join(' / ');
      // 合并 quality + sourceBadges 计算
      const t = p.tier, n = p.name, m = p.meta;
      const level = worstConfidence(t && t.confidence, n && n.confidence);
      patch.quality = {
        level: level,
        text: CONF_TEXT[level],
        sources: (t && t.agreement) || 0
      };
      const arr = [];
      if (t && t.sources) t.sources.forEach((s) => arr.push(s));
      if (n && n.sources) n.sources.forEach((s) => arr.push(s));
      if (m && m.sources) m.sources.forEach((s) => arr.push(s));
      patch.sourceBadges = buildSourceBadges(arr);
      this.setData(patch);
      // 元数据兜底后再用比赛窗口/参赛队伍推导一次，保证与 load() 结果最终一致
      this.refreshMetadataDerived();
    };
    // 8s 超时兜底，避免某个源 hang 住导致永远不刷新
    this._pendingTimer = setTimeout(finalize, 8000);

    sources.getLeagueTier({ name: name, leagueid: leagueId }).then((t) => {
      if (t && t.grade) {
        this._pending.tier = {
          label: t.label,
          grade: t.grade,
          cls: 'tag-' + t.grade.toLowerCase(),
          confidence: t.confidence,
          agreement: t.agreement,
          sources: t.sources,
          sourceLabel: t.sourceLabel || ''
        };
      }
      finalize();
    }).catch(finalize);

    // G5：voteLeagueNameForMatch 是共识投票名，仅作「无 curation canonical 时的兜底」，
    // 展示首选由 finalize() 的 curation canonical 优先级①保证，切勿直接当主展示名。
    sources.voteLeagueNameForMatch({ name: name, leagueid: leagueId }).then((n) => {
      if (n && n.value) {
        this._pending.name = {
          value: n.value,
          confidence: n.confidence,
          agreement: n.agreement,
          sources: n.sources,
          sourceLabel: n.sourceLabel || '',
          differs: n.value !== name && n.confidence !== 'low'
        };
      }
      finalize();
    }).catch(finalize);

    sources.getLeagueMetadata({ name: name, leagueid: leagueId })
      .then((meta) => {
        if (meta) {
          this._pending.meta = meta;
        } else {
          // Liquipedia 禁用/失败：用 curation 本地策展字段兜底，保证 KPI 仍有数据
          // 2026-07-27：传入 leagueId + game 上下文，启用精确 pin + 跨游戏隔离
          const fb = buildCurationFallback(remoteCuration.curatedEventFor(name, { leagueId: this.data.leagueId, game: 'dota2' }));
          if (fb) this._pending.meta = fb;
        }
        finalize();
      })
      .catch(() => {
        // 2026-07-27：传入 leagueId + game 上下文，启用精确 pin + 跨游戏隔离
        const fb = buildCurationFallback(remoteCuration.curatedEventFor(name, { leagueId: this.data.leagueId, game: 'dota2' }));
        if (fb) this._pending.meta = fb;
        finalize();
      });
  },

  // B4 定时刷新（2026-08-03）：页面可见时启动轮询（onLoad 后自动触发），
  // 隐藏时停止 —— 避免页面压栈后继续每 30-60s 拉取赛程（复用 8/1 match-detail 三态模式）。
  onShow() {
    this.startSchedulePolling();
  },

  onHide() {
    this.stopSchedulePolling();
  },

  onUnload() {
    // 清理超时 timer，避免离开页面后 setData 触发「Page not exist」错误
    if (this._pendingTimer) {
      clearTimeout(this._pendingTimer);
      this._pendingTimer = null;
    }
    // B4 定时刷新：销毁页面前停止轮询
    this.stopSchedulePolling();
    // Phase 1-⑦：离开页面前强制刷新 logoCache（确保防抖期间的数据落盘）
    try { logoCache.persistNow(); } catch (e) { /* 隔离 */ }
  },

  // refreshQuality / refreshSourceBadges 已内联到 onLoad 的 finalize，
  // 保留空壳避免外部调用报错。
  refreshQuality() {},
  refreshSourceBadges() {},

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh());
  },

  retry() {
    this.load();
  },

  // ★ 2026-08-13（首页推荐位跳转优化 · 修正版方案1）：本地 curation 骨架——零网络秒出。
  // 只渲染「不依赖网络数据」的字段：curation 权威赛期/状态/奖金池/地点 + 赛事名。
  // 不触碰 series（等网络数据到后由 F3 步骤2 增量渲染），避免与既有渲染链竞态。
  // hasValidId=false（fakeId 赛事）时同样渲染（curation 兜底已有，此处补骨架）。
  _renderLocalSkeleton(hasValidId) {
    try {
      const cur = remoteCuration.curatedEventFor(this.data.name, { leagueId: Number(this.data.leagueId), game: 'dota2' });
      const nowSec = Math.floor(Date.now() / 1000);
      const start = (cur && cur.start) || 0;
      const end = (cur && cur.end) || (start + 10 * 86400);
      // 状态判定（与 load() 内 statusOf 口径一致）：curation 赛期窗口 + 显式状态覆盖
      // ★ 2026-08-14 方案 B：加时间窗口守卫，防 curation status 过期导致僵尸状态。
      //   骨架阶段无 OpenDota 真实数据，mixed 仅含 curation 赛期；判定口径与 leagues.js
      //   normalize / load() 保持一致（已结束永远信任；进行中/即将到来须时间窗口支持）。
      const _mixed = util.validateLeagueWindow({
        earliest: 0, latest: 0, lastEnd: 0,
        startDate: (cur && cur.start) || null,
        endDate: (cur && cur.end) || null
      });
      let status = 'upcoming';
      if (cur && cur.status === '已结束') {
        status = 'ended';
      } else if (cur && cur.status === '进行中') {
        if (util.isOngoing(_mixed)) status = 'ongoing';
        else if (start && end && nowSec > end + 86400) status = 'ended';
      } else if (cur && cur.status === '即将到来') {
        if (util.isUpcoming(_mixed)) status = 'upcoming';
        else if (start && end && nowSec >= start && nowSec <= end + 86400) status = 'ongoing';
        else if (start && end && nowSec > end + 86400) status = 'ended';
      } else {
        // 无 curation 显式 status，按时间窗口自动判定
        if (start && end && nowSec >= start && nowSec <= end + 86400) status = 'ongoing';
        else if (start && start > nowSec) status = 'upcoming';
        else if (start && end && nowSec > end + 86400) status = 'ended';
      }
      const badge = statusBadgeOf(status);
      const patch = {
        loading: false,          // 骨架阶段即视为"首屏可见"，网络数据到达后 F3 增量更新
        error: '',
        scheduleLoading: true,   // 赛程尚未到达：wxml 显示"赛程加载中…"而非"暂无数据"
        status: status,
        statusText: badge.text,
        statusColor: badge.color,
        prizePool: (cur && cur.prizePool) ? String(cur.prizePool) : this.data.prizePool || '',
        location: (cur && cur.region) || this.data.location || '',
        eventWindow: (start && end) ? { start: start, end: end } : (this.data.eventWindow || null)
      };
      this.setData(patch);
    } catch (e) {
      // curation 异常：保持 loading（网络数据兜底），不阻塞 load()
      // eslint-disable-next-line no-console
      console.warn('[league-detail] _renderLocalSkeleton curation miss', e && e.message);
    }
  },

  // ★ 2026-09-01（v8.4 Fix-A）：一 ID 多届的届次窗口解析（供 raw 比赛过滤）。
  //   优先 curation leagueIdWindow（v8.3 引入的判届窗口，如 19944 的 EPL Masters I/II）；
  //   无 leagueIdWindow 但有 start/end 的赛事用 start/end ±48h 宽窗（容忍加赛/顺延）；
  //   均无（未收录赛事）→ null 不过滤（保持旧行为，防误伤）。
  _editionWindowOf() {
    try {
      const cur = remoteCuration.curatedEventFor(this.data.name, {
        leagueId: Number(this.data.leagueId) || null,
        game: 'dota2'
      });
      if (cur && cur.leagueIdWindow && cur.leagueIdWindow.from && cur.leagueIdWindow.to) {
        return cur.leagueIdWindow;
      }
      if (cur && cur.start && cur.end) {
        return { from: cur.start - 48 * 3600, to: cur.end + 48 * 3600 };
      }
    } catch (e) { /* curation 异常 → 不过滤 */ }
    return null;
  },

  load() {
    // B4 定时刷新（2026-08-03）：重载前停止旧轮询（下拉刷新/重试时避免与重建并发）
    this.stopSchedulePolling();
    const lid = Number(this.data.leagueId);
    const hasValidId = !!(lid && lid > 0 && !isNaN(lid));
    if (!hasValidId) {
      this.allMatches = [];
      this.allSeries = [];
    }
    this.setData({ loading: true, error: '' });
    this._perfLoadStart = Date.now();   // ★ 2026-09-01（第0步埋点）：load 全链路计时起点
    // ★ 2026-08-13（首页推荐位跳转优化 · 修正版方案1）：骨架提前——先用本地 curation 渲染
    //   基础信息（名称/赛期/状态/奖金池/地点）并置 loading:false，用户立即看到赛事框架，
    //   不再被最慢网络任务（Liquipedia 赛程云函数现抓 2-4s）阻塞首屏。
    //   复用既有 F3 分步渲染：本函数只渲染「纯 curation 骨架」（不依赖网络数据），
    //   网络数据（OD+LP）到达后 F3 步骤1/2 增量更新 eventWindow/计数/series。
    this._renderLocalSkeleton(hasValidId);
    // 并行拉取 OpenDota 比赛数据 + Liquipedia 赛程数据：
    // - OpenDota 只返回已结束的比赛（需有效 leagueId），Liquipedia 赛程进行中/未开赛用名称为准。
    // - Liquipedia 请求失败时静默降级，仅显示 OpenDota 数据；若两者均无，显示「暂无比赛数据」。
    // ★ 2026-09-01（P0-3③）：OD matches + teamNames 优先走云端聚合 bundle（一次 callFunction，
    //   消除原「raw 到达后才能发起的 explorer 直连」串行段）；失败/超时/旧版云函数未部署
    //   → 回退旧链 api.getLeagueMatches（bundle 失败时 teamNames 由下方 direct 兜底补）。
    // ★ 2026-09-01（详情页 13s 修复 v2）：OD 数据链路改「缓存优先，bundle 后台刷新」。
    //   原实现：bundle（8s 超时）→ 失败才回退 getLeagueMatches —— 冷缓存时 bundle 现抓
    //   OpenDota 慢（5-10s+），详情页内容 13s 才到。
    //   现实现：odTask 直接走 api.getLeagueMatches（cachedFreshIncremental：10min 新鲜 /
    //   30min 硬 TTL stale 秒回 / 游标增量），**本地有缓存（含 stale）立即上屏**；
    //   bundle 降级为「后台刷新」（见下方 odTask.then 内触发）——不阻塞主渲染，仅补 teamNames。
    const odTask = hasValidId
      ? api.getLeagueMatches(this.data.leagueId)
      : Promise.resolve([]);
    const lpTask = liquipedia.getScheduledMatches(this.data.name, { leagueId: hasValidId ? this.data.leagueId : null });
    const tasks = [
      odTask,
      lpTask
    ];
    // ★ 2026-09-01（P1-2）：OD 先到先渲染 —— 仅 RECENT 段（复核修正版）。
    //   触发条件（全部满足，防双卡/占位名回归）：
    //     ① OD（bundle）已到（不论 _teamIdNameMap 是否备齐 —— 见下 P1 放宽说明）；
    //     ② LP 1.5s 宽限期后仍未到达（两源都快时不做双份渲染）；
    //     ③ 本轮 load 未被新一轮取代（token 代际守卫）。
    //   快渲染内容：仅 RECENT 段（纯 OD 已结算数据，不涉 LIVE/UPCOMING——
    //   跨源合并 + absorbSettledGames + Fix-D 去重均需 LP 输入，先渲染会复发「LIVE 双卡」）。
    //   ★ 2026-09-03（加载优化 P1）：放宽守卫①——原要求 _teamIdNameMap 非空（bundle 命中），
    //     现允许为空（direct 兜底路径）。resolveTeamIdName 三级回退（teamIdNameMap → curation →
    //     raw _rawIdMap），OpenDota 比赛自带 radiant/dire_team_name → 真实队名照常显示；
    //     raw 无队名 → 「天辉/夜魇」占位名（LP 到达后主链路全量覆盖，无半状态残留）。
    const loadToken = this._loadToken = (this._loadToken || 0) + 1;
    this._lpResolved = false;
    this._fastRendered = false;
    // LP 到达（成功或失败）即取消快渲染：成功 → 主链路马上全量渲染；失败 → 走 catch 错误态
    lpTask.then(() => { this._lpResolved = true; }, () => { this._lpResolved = true; });
    odTask.then((list) => {
      // ★ 2026-09-01（详情页 13s 修复 v2）：bundle 后台刷新（不阻塞主渲染）——
      //   命中后仅补 _teamIdNameMap（吸收方向解析用，getLeagueMatches 数据已足够渲染）。
      //   token 已定义，闭包捕获本轮代际；bundle 8s 超时静默，不影响主流程。
      const bundleToken = loadToken;
      cloudProxy.leagueDetailBundle(this.data.leagueId).then((bundle) => {
        const names = (bundle && bundle.teamNames) || {};
        if (Object.keys(names).length && bundleToken === this._loadToken) {
          this._teamIdNameMap = Object.assign({}, this._teamIdNameMap, names);
        }
      }).catch(() => { /* bundle 失败静默——getLeagueMatches 数据已足够 */ });
      setTimeout(() => {
        if (loadToken !== this._loadToken) return;          // 新一轮 load 取代
        if (this._lpResolved || this._fastRendered) return; // LP 已到 / 已快渲染
        // ★ 2026-09-03（加载优化 P1）：放宽快渲染守卫——不再硬要求 _teamIdNameMap 非空。
        //   resolveTeamIdName 三级回退（teamIdNameMap → curation → raw _rawIdMap）中，
        //   OpenDota 比赛记录自带 radiant/dire_team_name，所以即便 _teamIdNameMap 为空
        //   （bundle 未命中 / direct explorer 尚未返回），只要 raw 自带队名仍能渲染真实队名。
        //   raw 也无队名时回退为「天辉/夜魇」占位名（LP 到达后主链路全量覆盖，无半状态残留）。
        this._renderRecentOnly(list);
      }, 1500);
    });
    return Promise.all(tasks)
      .then(([list, scheduled]) => {
        // ★ 2026-09-01（第0步埋点）：OD/LP 并行段耗时（网络瓶颈定位）
        const _t0 = Date.now();
        console.info('[detail][perf] od+lp 并行段 ' + (Date.now() - this._perfLoadStart || 0) + 'ms（od ' + ((list || []).length) + ' 场 / lp ' + (((scheduled && scheduled.matches) || []).length) + ' 场）');
        const raw = sources.filterMatchesByWindow(list || [], this._editionWindowOf());
        // ★ 2026-08-04（v3.1，R1/R2）：串行预取 team_id→名（explorer teams 表，6h 缓存）——
        //   吸收方向解析的可靠源（curation 覆盖不全 + OpenDota 比赛端点队名恒空）。
        //   不能与 raw 并行（team_id 集合来自 raw）；失败 catch 降级不阻塞 load（R2）。
        // ★ 2026-09-01（P0-3③）：bundle 已带回 teamNames（_teamIdNameMap 非空）时跳过
        //   本段 direct explorer（省一次跨网 RTT + 客户端 60req/min 配额）；
        //   bundle 失败（旧版云函数未部署 / 超时）→ 走原 direct 兜底，行为与旧版一致。
        const _idSet = new Set();
        (raw || []).forEach(function (m) {
          if (m && m.radiant_team_id && m.radiant_team_id > 0) _idSet.add(Number(m.radiant_team_id));
          if (m && m.dire_team_id && m.dire_team_id > 0) _idSet.add(Number(m.dire_team_id));
        });
        if (this._teamIdNameMap && Object.keys(this._teamIdNameMap).length) {
          console.info('[detail][perf] teamNames 由 bundle 提供（跳过 direct explorer，' +
            Object.keys(this._teamIdNameMap).length + ' 队）');
          return [raw, scheduled];
        }
        return api.getTeamNames(Array.from(_idSet))
          .catch(function () { return {}; })   // explorer 失败 → map 空 → resolver 回退 curation（现状行为）
          .then((nameMap) => {
            // ★ 2026-09-01（第0步埋点）：explorer teamNames 串行段耗时（D1 瓶颈量化）
            console.info('[detail][perf] teamNames 串行段 ' + (Date.now() - _t0) + 'ms（' + Object.keys(nameMap || {}).length + ' 队）');
            this._teamIdNameMap = nameMap || {};
            return [raw, scheduled];
          });
      })
      .then(([list, scheduled]) => {
        const raw = list || [];
        // ★ 2026-08-04：getScheduledMatches 统一返回 { matches, boFormat }（BO 判定引擎 S2 信号）。
        //   兼容旧形状（数组）归一化，保证旧云函数/旧缓存下不崩。
        const scheduledObj = (scheduled && !Array.isArray(scheduled)) ? scheduled : { matches: scheduled || [], boFormat: null };
        const liqScheduled = scheduledObj.matches || [];
        const liqBoFormat = scheduledObj.boFormat || null;
        this.allMatches = raw;  // 保留原始（供系列赛聚合用）
        this._rawMatches = raw;  // B4 定时刷新（2026-08-03）：供 refreshSchedule 复用 OpenDota 侧数据
        // ★ 2026-08-04（v1.1，R4）：load 成功拉到 OpenDota → 记重拉时间戳（首轮轮询不立即触发低频重拉）
        this._lastOdRefresh = Math.floor(Date.now() / 1000);
        // ★ v3 优化项26：cancelled 赛事赛程过滤 — 取消的赛事不显示赛程
        const _cur = remoteCuration.curatedEventFor(this.data.name, { leagueId: Number(this.data.leagueId), game: 'dota2' });
        if (_cur && _cur.status === '已取消') {
          this.allSeries = [];
          this.setData({
            loading: false,
            series: [],
            totalSeries: 0,
            cancelledNotice: '该赛事已取消'
          });
          return;
        }
        // 系列赛聚合：按 series_id 归组 BO3/BO5，同一系列多场聚到一张卡
        // 2026-07-28 修复小圆点颜色 BUG：传入 series 的 A/B 队 team_id 锚点给 fmt，
        // 让每场 game 计算 aWin（A 队是否赢该场），WXML 据此着色。
        // 此前 fmt 只赋值 radiantWin（=radiant_win 原始值），WXML 用 g.radiantWin 判定颜色，
        // 但 radiant_win 只代表「天辉是否赢」，不等于「A 队（首场 radiant 方）是否赢」。
        const _tBuild = Date.now();
        const built = this.buildSeriesFromSources(raw, liqScheduled, liqBoFormat);
        // ★ 2026-09-01（第0步埋点）：build+渲染段耗时（CPU 瓶颈量化）
        console.info('[detail][perf] build 段 ' + (Date.now() - _tBuild) + 'ms（' + (built.allSeries || []).length + ' 系列）；load 全链路 ' + (Date.now() - this._perfLoadStart) + 'ms');
        this.allSeries = built.allSeries;
        const liveList = built.liveList, upcomingList = built.upcomingList, recentList = built.recentList;
        const upcomingGroups = built.upcomingGroups, farFutureCount = built.farFutureCount;
        const isLive = built.isLive;

        const pageSize = this.data.pageSize;
        const slice = this.allSeries.slice(0, pageSize);
        const at = api.fetchedAtOf('leagueMatches', this.data.leagueId);
        // 统一赛事窗口（与列表页 leagues.js loadLeagueEntry 完全一致）：
        // 构建 mixed 对象同时包含真实比赛数据（earliest/latest/lastEnd）和 curation 权威赛期
        //（startDate/endDate），让 util.statusOf 走 isOngoing 全部三条判定路径：
        //   ① 真实 lastEnd 在缓冲期内 → 精确匹配
        //   ② curation 赛期窗口内 → 覆盖 DOTA2 比赛已结束但赛事仍在进行（如 EWC 嘉年华）
        //   ③ 未结算比赛兜底
        // 并应用 cur.status 显式覆盖（与列表页 leagues.js 第 362-364 行一致），
        // 防止「赛事仍在进行但 DOTA2 比赛已结束」被误判为「已结束」。
        // 2026-07-28 修复：此前详情页仅用真实比赛窗口，导致与列表页赛期/状态显示不一致。
        const mList = raw || [];
        let mStart = 0, mEnd = 0, mLatestStart = 0;
        mList.forEach((m) => {
          const st = m.start_time || 0;
          const en = st + (m.duration || 0);
          if (st && (!mStart || st < mStart)) mStart = st;       // 最早开赛
          if (st > mLatestStart) mLatestStart = st;               // 最晚开赛（供 isOngoing 路径③）
          if (en > mEnd) mEnd = en;                               // 最晚结束
        });
        // 数据校验：真实比赛窗口完整性（start>0 且 end>=start）
        const hasRealWindow = mStart > 0 && mEnd >= mStart;
        // 2026-07-27：传入 leagueId + game 上下文，启用 curation 精确 pin + 跨游戏隔离
        const cur = remoteCuration.curatedEventFor(this.data.name, { leagueId: Number(this.data.leagueId), game: 'dota2' });
        // 2026-07-28：统一使用 util.validateLeagueWindow 校验，与列表页 leagues.js 共用同一函数，
        // 确保两页对赛期/状态的数据源完全一致，防止同类不一致 BUG 复发。
        const mixed = util.validateLeagueWindow({
          earliest: mStart,
          latest: mLatestStart,
          lastEnd: mEnd,
          startDate: (cur && cur.start) || null,
          endDate: (cur && cur.end) || null
        }, { leagueid: Number(this.data.leagueId), curated: !!cur });
        // 状态判定：statusOf(mixed) + curation 显式状态覆盖（与列表页完全一致）
        // ★ 2026-08-14 方案 B：加时间窗口守卫，防 curation status 过期导致僵尸状态。
        //   与 leagues.js normalize / 本文件 _renderLocalSkeleton 保持字节级一致：
        //   「已结束」永远信任；「进行中」须 isOngoing 支持；「即将到来」须 isUpcoming 支持。
        let status = util.statusOf(mixed);
        if (cur && cur.status === '已结束') {
          status = 'ended';
        } else if (cur && cur.status === '进行中') {
          if (util.isOngoing(mixed)) status = 'ongoing';
        } else if (cur && cur.status === '即将到来') {
          if (util.isUpcoming(mixed)) status = 'upcoming';
        }
        const badge = statusBadgeOf(status);
        // 赛期显示优先级（与列表页 leagues.js loadLeagueEntry 完全一致）：
        //   ① curation 完整周期（mixed.startDate/endDate）—— 覆盖嘉年华全周期
        //   ② 真实比赛窗口（mStart/mEnd）—— 非策展赛事兜底
        //   ③ upcoming-local.json 快照（2026-07-30 新增）—— 不在 curation 中且无 OpenDota 比赛的赛事
        //      （如 Liquipedia 即将到来/进行中赛事，leagueId 为负数占位，无真实比赛窗口）
        // 赛期优先级（与列表页 leagues.js loadLeagueEntry 完全一致，2026-07-30 修正）：
        //   ① curation 完整周期（人工策展，最高权威）
        //   ② upcoming-local.json 官方赛期（Liquipedia 正确时间，主力）
        //   ③ OpenDota 真实比赛窗口（仅当 curation/upcoming-local 均无对应赛事时兜底）
        // ★ 修复 BUG：原优先级为 curation → OpenDota → upcoming-local，导致 OpenDota 已收录部分比赛
        //   但比赛集中在同一天（如 1win Essence II 3 场均在 7/30）时，winStart/winEnd 均非空，
        //   不触发 upcoming-local 回退，赛期显示 "7/30 ~ 7/30" 而非完整 "7/30 ~ 8/5"。
        //   现修正为与列表页一致：upcoming-local 优先于 OpenDota 真实窗口，保证官方赛期不被截断。
        // ★ 2026-09-19 ⑤ 跨源赛期合并落地（口径经用户确认）：
        //   官方赛期（curation / LP 快照）优先，缺口**按字段**回退 OpenDota 真实比赛窗口。
        //   修复：原快照回退要求 start&&end **同时存在**（all-or-nothing）——
        //   LP「endDate 不完整」（只给 start）时整条官方赛期被丢弃 → start 也被 OpenDota
        //   比赛窗口覆盖（OpenDota 窗口常截断为已打场次）→ 赛期显示错误甚至为空。
        //   现统一走 `sources.mergeEventPeriod()`（与列表页 dateRange 同一实现，防止两页口径漂移）。
        var snapEntry = null;
        var _snap = getUpcomingLocalSnapshot();
        if (_snap && _snap.events && _snap.events.length) {
          // 名称归一化匹配：★ 2026-09-19 改用 `sources.leagueKey`（跨源赛事名归一统一出口），
          //   与列表页快照匹配同口径；原"小写+去符号"内联实现与去重键各自演化，曾发生漏匹配
          //   （leagues.js 同位置已先改，本处对齐 —— 凡跨源按名比对都应走统一归一化）。
          var _nameKey = sources.leagueKey(this.data.name || '');
          for (var _si = 0; _si < _snap.events.length; _si++) {
            var _evKey = sources.leagueKey(_snap.events[_si].name || '');
            if (_evKey && _nameKey && (_evKey === _nameKey || _nameKey.indexOf(_evKey) >= 0 || _evKey.indexOf(_nameKey) >= 0)) {
              snapEntry = _snap.events[_si]; break;
            }
          }
        }
        var _period = sources.mergeEventPeriod([
          { name: 'curation',   start: mixed.startDate, end: mixed.endDate },
          { name: 'liquipedia', start: (snapEntry && snapEntry.start) || 0, end: (snapEntry && snapEntry.end) || 0 },
          { name: 'opendota',   start: hasRealWindow ? mStart : 0, end: hasRealWindow ? mEnd : 0 }
        ]);
        var winStart = _period ? _period.start : 0;
        var winEnd = _period ? _period.end : 0;
        let eventWindow = null;
        if (winStart > 0 && winEnd >= winStart) {
          eventWindow = {
            start: winStart,
            end: winEnd,
            range: util.formatDateRange(winStart, winEnd),                        // M/D，与列表页一致
            fullRange: util.formatTime(winStart) + ' ~ ' + util.formatTime(winEnd), // KPI 全日期
            status: status,
            statusText: badge.text,
            statusColor: badge.color
          };
        }
        this._matchWindow = hasRealWindow ? { start: mStart, end: mEnd } : null;
        // F3 分步渲染（2026-07-29）：将原单次大 payload setData 拆为两步。
        //   - 步骤1（骨架）：loading:false + eventWindow + 计数 + 分页元数据，用户立即看到赛事框架
        //   - 步骤2（明细）：series 数组（50-200KB），独立 setData 避免阻塞骨架渲染
        // 收益：首屏可交互时间提前；用户先看到赛事状态/窗口，再看到对阵列表。
        // 步骤1：骨架（标量 + 锚点，体积小，渲染快）
        this.setData({
          totalSeries: this.allSeries.length,
          page: 0,
          hasMore: this.allSeries.length > slice.length,
          loading: false,
          scheduleLoading: false,   // 2026-08-13：网络赛程已到达，关闭"赛程加载中"（若骨架提前则此处收尾）
          updatedAt: at,
          updatedLabel: util.formatAgo(at),
          isLive: isLive,
          eventWindow: eventWindow,
          // D1 数据时间戳（2026-08-03）：Liquipedia 赛程最后更新时刻，refreshSchedule 刷新时更新
          scheduleUpdatedAt: Math.floor(Date.now() / 1000),
          scheduleUpdatedLabel: util.formatAgo(Math.floor(Date.now() / 1000)),
          // ★ 三段式分段计数（供 wxml 渲染分隔符与计数）
          liveCount: liveList.length,
          upcomingCount: upcomingList.length,
          recentCount: recentList.length,
          recentCollapsed: false,   // 每次重新加载时重置折叠状态
          // ★ v3 优化项21：UPCOMING 按日期分组 + 远期折叠
          upcomingGroups: upcomingGroups,
          farFutureCount: farFutureCount,
          hasFarFuture: farFutureCount > 0,
          showFarFuture: false   // 默认折叠远期赛程
        });
        // 步骤2：明细（series 数组体积大，独立 setData 避免阻塞骨架渲染）
        this.setData({ series: slice });
        this.refreshMetadataDerived();
        // ★ 2026-08-11 长期架构改进落地：数据源健康检查。
        //   对阵为空时异步探测 Liquipedia / OpenDota 可达性——若链路异常，将「暂无数据」
        //   空态替换为「数据源暂不可用」显式提示（避免静默降级让用户误以为赛事真没数据）。
        if (!built.allSeries.length && !this._healthCheckedOnce) {
          this._healthCheckedOnce = true;
          dataHealth.check().then((status) => {
            const st = status && status.sources;
            if (!st) return;  // unknown：不打扰用户
            const down = [];
            if (st.liquipedia && st.liquipedia.status === 'down') down.push('Liquipedia');
            if (st.opendota && st.opendota.status === 'down') down.push('OpenDota');
            if (down.length) {
              this.setData({ sourceDownHint: down.join('/') + ' 数据源暂不可用，请稍后重试' });
            }
          }).catch(function () { /* 健康探测失败静默 */ });
        }
        // F2 修复：enrichTeamNames 与 enrichTeamLogos 并行执行，省去串行等待（慢网平均省 300-800ms）
        Promise.all([this.enrichTeamNames(), this.enrichTeamLogos()]);
        // B4 定时刷新（2026-08-03）：load 完成（骨架+明细已渲染）后启动轮询。
        // 纯 recent 赛事内部会自动停止；有 live 则 30s、仅 upcoming 则 60s。
        this.startSchedulePolling();
      })
      .catch((err) => {
        console.error('[league-detail] 加载失败:', err);
        this.setData({ loading: false, error: '加载失败，请检查网络或域名配置', scheduleLoading: false });
      });
  },

  // ★ 2026-09-01（P1-2）：OD 先到先渲染 —— LP 迟到时仅渲染 RECENT 段（纯 OD 已结算数据）。
  //   约束（防 v8.4 修复回归）：
  //     - 不渲染 LIVE/UPCOMING：跨源合并（absorbSettledGames）与 Fix-D 去重均需 LP 输入；
  //     - 仅在 _teamIdNameMap 已备（bundle 命中）时被调用：RECENT 卡显示真实队名，无占位名闪现；
  //     - 不写 _rawMatches/allSeries 等主链路状态：纯视觉层，LP 到达后主链路全量覆盖；
  //     - LP 主链路步骤1 会重置 scheduleLoading:false / 全部计数 / series —— 最终态与无快渲染一致。
  _renderRecentOnly(list) {
    try {
      const raw = sources.filterMatchesByWindow(list || [], this._editionWindowOf());
      if (!raw || !raw.length) return;
      // 复用 series 构建全链路（liqScheduled 传空数组 → 跳过 LP 合并/吸收/去重段，纯 OD 构建）
      const built = this.buildSeriesFromSources(raw, [], null);
      const recent = built.recentList || [];
      if (!recent.length) return;   // 未开赛/进行中赛事不快渲染（核心段依赖 LP）
      const pageSize = this.data.pageSize || 20;
      const slice = recent.slice(0, pageSize);
      this._fastRendered = true;
      this.setData({
        loading: false,
        scheduleLoading: true,      // LP 赛程未到：LIVE/UPCOMING 待补（主链路到达后关闭）
        page: 0,
        hasMore: recent.length > slice.length,
        totalSeries: recent.length,
        series: slice,
        liveCount: 0,
        upcomingCount: 0,
        recentCount: recent.length,
        recentCollapsed: false
      });
      console.info('[detail][perf] P1-2 快渲染：RECENT ' + recent.length + ' 卡先上（LP 未到，' +
        (Date.now() - this._perfLoadStart) + 'ms）');
    } catch (e) {
      // 快渲染失败静默：主链路（LP 到达后）全量渲染兜底，无半状态残留
      console.info('[detail][perf] P1-2 快渲染跳过：', (e && e.message) || e);
    }
  },

  // 队名补全：收集队名为空或是 UI 占位（天辉/夜魇）的 team_id，一次 /explorer SQL 批量查 teams.name 回填。
  // 补全后用路径更新仅刷新受影响行（series[i].games[j] + series 头部队名）。

  // ★ 2026-08-03 抽取：series 构建全链路（OpenDota groupSeries → Liquipedia 合并去重 →
  // 时间窗口过滤 → 分段排序 → 字段计算 → decorate）。
  // load() 与 refreshSchedule()（B4 定时刷新）共用，防止双份逻辑漂移。
  buildSeriesFromSources(raw, liqScheduled, liqBoFormat) {
    // ★ 2026-08-04：liqBoFormat = 云函数 parseBoFormat 的 Format 段赛制映射（S2 信号），可为 null
        // BO3/BO5 中双方会换边，第 2/3 场 radiant 可能是首场的 dire（B 队），
        // 此时 radiant_win=true 反而代表 B 队赢，小圆点会显示错误颜色。
        // 此外 radiant_win=null（未结束）会走 else 分支显示红色，未结束比赛不应着色。
        const seriesAnchor = { teamAId: 0, teamBId: 0 };
        // nowSec 用于 upcoming 倒计时格式化（与 groupSeries 内部判定保持一致）
        const fmtNowSec = Math.floor(Date.now() / 1000);
        var allSeries = sources.groupSeries(raw).map((s) => {
          seriesAnchor.teamAId = s.radiantTeamId;
          seriesAnchor.teamBId = s.direTeamId;
          s.games = s.games.map((m) => this.fmt(m, seriesAnchor));
          // ★ 为 upcoming series 补全展示字段（2026-07-28 新增）
          // scheduledTimeText：开赛时间紧凑格式 'M/D HH:MM'，替代比分位显示
          // countdownText：距开赛时长，如 '2小时后' / '3天后' / '即将开始'（<5分钟）
          if (s.isUpcoming) {
            const st = s.lastTime;  // upcoming 段 lastTime 即开赛时间
            const d = new Date(st * 1000);
            const md = (d.getMonth() + 1) + '/' + d.getDate();
            const hh = ('0' + d.getHours()).slice(-2);
            const mm = ('0' + d.getMinutes()).slice(-2);
            s.scheduledTimeText = md + ' ' + hh + ':' + mm;
            const diffSec = st - fmtNowSec;
            if (diffSec <= 300) {
              s.countdownText = '即将开始';
            } else if (diffSec < 3600) {
              s.countdownText = Math.floor(diffSec / 60) + '分钟后';
            } else if (diffSec < 86400) {
              s.countdownText = Math.floor(diffSec / 3600) + '小时后';
            } else {
              s.countdownText = Math.floor(diffSec / 86400) + '天后';
            }
          }
          return s;
        });
        // ★ 合并 Liquipedia 赛程数据（2026-07-28 新增）
        // OpenDota 只返回已结束比赛，进行中/未开赛的对阵需要从 Liquipedia {{Match}} 模板补充。
        // 转换为与 groupSeries 返回值兼容的 series 对象，去重后合并到 allSeries。
        // ★ 2026-08-20：先按 series 聚合 Liquipedia match（同 BO 系列多局合并为一项，
        //   修复「一场 BO3 被拆成多张 BO1 卡」——此前直接 .map 每场独立成卡，缺聚合步骤）。
        const liqGrouped = sources.groupLiquipediaMatches(liqScheduled);
        if (liqGrouped && liqGrouped.length) {
          // §9 P0-D2（2026-07-30）：TBD 占位隔离
          // 痛点：TBD（待定/待公布）队伍参与队名归一化键构建，会导致多个 TBD 对阵被误判为同一对阵而合并，
          //   如 "TBD vs Team A" 与 "TBD vs Team B" 因 TBD 相同而被误去重。
          // 修复：TBD 队伍不参与去重键构建（包含 TBD 的对阵视为独立对阵，不做合并）。
          //   - 构建 openDotaKeys 时跳过含 TBD 的对阵（避免污染键集）
          //   - 过滤 Liquipedia 赛程时，含 TBD 的对阵直接保留（不查去重键）
          // ★ v3 优化项25：队名归一化增强 — 去掉常见后缀（esports/gaming/team）+ 去空格标点
          //   2026-08-22：实现已提升至模块级（文件顶部 isTBD 之后），此处与 refresh 队名兜底共用同一口径。
          // 模糊匹配：队名 A 包含队名 B 或反之（长度 >= 3）
          function fuzzyMatchName(a, b) {
            var na = normalizeTeamNameForDedup(a);
            var nb = normalizeTeamNameForDedup(b);
            if (!na || !nb || na.length < 3 || nb.length < 3) return false;
            if (na === nb) return true;
            return na.indexOf(nb) >= 0 || nb.indexOf(na) >= 0;
          }
          // 构建去重键（仅双方均为确定队名时才生成键）
          function dedupeKey(n1, n2) {
            if (isTBD(n1) || isTBD(n2)) return null;  // TBD 不参与合并
            return normalizeTeamNameForDedup(n1) + '__' + normalizeTeamNameForDedup(n2);
          }
          // 构建 OpenDota 已有对阵的去重键（队名归一化：小写+去空格+去后缀）
          // 用于剔除 Liquipedia 中已被 OpenDota 返回的已结束对阵
          const openDotaKeys = new Map();   // key -> 该系列首场开赛时间（D2 时间窗去重用）
          const openDotaNames = [];  // ★ v3 优化项25：存储归一化名供模糊匹配
          // ★ v3 优化项33（2026-08-03）：OpenDota match_id 集合（P0b 硬关联去重）。
          // Liquipedia {{Match}} 顶层的 matchid1/matchid2 与 OpenDota match_id 直接对应，
          // 比队名归一化（受 OpenDota 队名 null → 占位"天辉/夜魇"影响而失效）可靠得多。
          // 该对局的全部 matchid 都已被 OpenDota 收录 → Liquipedia 项剔除（OpenDota 数据更全）。
          const openDotaMatchIds = new Set();
          (raw || []).forEach(function (m) {
            if (m && m.match_id) openDotaMatchIds.add(String(m.match_id));
          });
          // ★ 2026-08-05（RECENT 同对局双卡修复，R1）：解名兜底【上移】至 openDotaKeys 构造前（原定义在吸收块，
          //   时序上够不到此处；同一作用域重复 const 声明会 SyntaxError，故上移单一定义供两处共用）。
          //   OpenDota 比赛端点队名恒 null → groupSeries 兜底 '天辉'/'夜魇' → 队名去重键恒失效；
          //   用 explorer 预取 _teamIdNameMap 解真实名 → 精确去重路径恢复（R5：去后缀 + k/kRev 顺序无关）。
          const _curTeamTable = (function () {
            try { const _c = require('../../utils/curation.js'); return (_c && _c.CURATED_TEAMS) || null; }
            catch (e) { return null; }
          })();
          const _rawIdMap = {};
          (raw || []).forEach(function (m) {
            if (m && m.radiant_team_id && m.radiant_team_name) _rawIdMap[m.radiant_team_id] = m.radiant_team_name;
            if (m && m.dire_team_id && m.dire_team_name) _rawIdMap[m.dire_team_id] = m.dire_team_name;
          });
          // ⚠️ 必须为箭头函数（捕获外层 this = Page）；allSeries.forEach 内只调用它，不直接碰 this
          const _resolveName = (id) => sources.resolveTeamIdName(id, this._teamIdNameMap, _curTeamTable, _rawIdMap);
          allSeries.forEach(function (s) {
            const _g0 = s.games && s.games[0];
            const _rn = (s.radiantName === '天辉' && _g0) ? (_resolveName(_g0.radiantTeamId || _g0.radiant_team_id) || s.radiantName) : s.radiantName;
            const _dn = (s.direName === '夜魇' && _g0) ? (_resolveName(_g0.direTeamId || _g0.dire_team_id) || s.direName) : s.direName;
            // ★ 2026-09-01（v8.4 Fix-C）：解出的真实队名写回系列卡显示字段。
            //   此前 _rn/_dn 仅用于构建去重键，卡片本身仍显示占位「天辉 vs 夜魇」——
            //   OpenDota /leagues/{id}/matches 队名恒 null 的联赛（如 20142/19944）RECENT 段
            //   全部显示占位名，且 LIVE 段同对局卡无法按队名关联（双卡根因之一）。
            if (_rn) s.radiantName = _rn;
            if (_dn) s.direName = _dn;
            if (_rn && _dn) {
              const k1 = dedupeKey(_rn, _dn);
              if (k1) {
                openDotaKeys.set(k1, _g0 ? (_g0.start_time || 0) : 0);
                openDotaKeys.set(k1.split('__').reverse().join('__'), _g0 ? (_g0.start_time || 0) : 0);
              }
              openDotaNames.push({
                n1: normalizeTeamNameForDedup(_rn),
                n2: normalizeTeamNameForDedup(_dn),
                startTime: _g0 ? (_g0.start_time || 0) : 0   // D2 模糊匹配时间窗基准
              });
            }
          });
          // 将 Liquipedia 赛程转换为 series 对象
          let liqSeries = liqGrouped
            .filter(function (m) {
              // ★ 2026-08-04（v1.1 实施，审核 R1）：LP live/upcoming 永不剔除 —— 它是 OpenDota 进行中系列唯一的 live 状态来源。
              //   原实现（v3 优化项33）matchIds.every 全命中即剔，把「仅第一局被 OpenDota 收录」的 live BO3 剔掉 →
              //   OpenDota 单局已结算被误判 recent/BO1。
              //   ⚠️ 必须【替换】原 matchIds 分支（filter 回调最前端）而非追加：追加在其后 live 卡先被 every() 剔除、
              //      早退行永远执行不到；本行位于最前端 → live/upcoming 卡在下方队名精确/模糊去重之前提前返回，
              //      完整跳过两条路径（OpenDota 该场队名正常 + 时间窗<2h 的赛事仍被队名去重剔除的隐患一并消除）。
              //   仅对 LP recent 场次保留 matchIds/队名去重（防双源重复）。
              if (m.phase !== 'recent') return true;
              // ★ 2026-08-05（RECENT 同对局双卡修复，审核 R2）：恢复 v3 优化项33 matchIds 硬关联去重
              //   （v1.1 R1 实施时误删）。判定抽纯函数 sources.allMatchIdsInSet。
              //   recent 卡的全部 match_id 都被 OpenDota 收录 → LP 项剔除（OpenDota 数据更全，含比分）。
              //   ⚠️ 必须放在早退行【之后】：仅 recent 卡走此分支，live/upcoming 不受影响（R1 零回归）。
              if (m.matchIds && m.matchIds.length && sources.allMatchIdsInSet(m.matchIds, openDotaMatchIds)) {
                return false;
              }
              // 去重：剔除 OpenDota 已返回的对阵（队名归一化后匹配）
              if (!m.team1Name || !m.team2Name) return false;
              const k = dedupeKey(m.team1Name, m.team2Name);
              if (!k) return true;  // §9 P0-D2：含 TBD 的对阵直接保留，不参与去重
              const kRev = k.split('__').reverse().join('__');
              if (openDotaKeys.has(k) || openDotaKeys.has(kRev)) {
              var _t0 = openDotaKeys.get(k) || openDotaKeys.get(kRev) || 0;
              // D2 时间窗：队名匹配且开赛时间差 < 2h 才判定为同一场（消重复）；
              // 时间差大 → 同一两队的不同场次（如小组赛双循环），保留
              if (_t0 && m.startTime && Math.abs(m.startTime - _t0) < 2 * 3600) return false;
              return true;
            }
              // ★ v3 优化项25：模糊匹配去重（如 "Team Falcons" vs "Falcons"）
              var ln1 = normalizeTeamNameForDedup(m.team1Name);
              var ln2 = normalizeTeamNameForDedup(m.team2Name);
              for (var i = 0; i < openDotaNames.length; i++) {
                if ((fuzzyMatchName(ln1, openDotaNames[i].n1) && fuzzyMatchName(ln2, openDotaNames[i].n2)) ||
                    (fuzzyMatchName(ln1, openDotaNames[i].n2) && fuzzyMatchName(ln2, openDotaNames[i].n1))) {
                  // D2 时间窗（与精确匹配一致）：队名模糊匹配 + 开赛时间差 < 2h 才算同一场；
                  // 时间差大 → 同一两队的不同场次（如小组赛双循环），保留
                  var _tf = openDotaNames[i].startTime || 0;
                  if (_tf && m.startTime && Math.abs(m.startTime - _tf) < 2 * 3600) return false;
                  return true;
                }
              }
              return true;
            })
            .map(function (m, idx) {
              // 为 upcoming series 补全展示字段
              var scheduledTimeText = '', countdownText = '';
              if (m.startTime) {
                var d = new Date(m.startTime * 1000);
                var md = (d.getMonth() + 1) + '/' + d.getDate();
                var hh = ('0' + d.getHours()).slice(-2);
                var mm = ('0' + d.getMinutes()).slice(-2);
                scheduledTimeText = md + ' ' + hh + ':' + mm;
                var diffSec = m.startTime - fmtNowSec;
                if (diffSec <= 300) countdownText = '即将开始';
                else if (diffSec < 3600) countdownText = Math.floor(diffSec / 60) + '分钟后';
                else if (diffSec < 86400) countdownText = Math.floor(diffSec / 3600) + '小时后';
                else countdownText = Math.floor(diffSec / 86400) + '天后';
              }
              // ★ v3 优化项22：从 Liquipedia 提取比分（TeamOpponent|score=N）
              var liqScoreA = m.score1 || 0;
              var liqScoreB = m.score2 || 0;
              var bForfeit = m.walkover > 0;
              var forfeitSide = m.walkover === 1 ? 'A' : (m.walkover === 2 ? 'B' : '');
              // ★ v3 优化项19：isRecent 语义修复 — 基于 startTime + 4h 窗口估算（Liquipedia 无 duration）
              var liqIsRecent = false;
              if (m.phase === 'recent' && m.startTime > 0) {
                var elapsedSec = fmtNowSec - m.startTime;
                liqIsRecent = elapsedSec > 0 && elapsedSec < 4 * 3600;
              }
              // ★ v3 优化项30：Liquipedia LIVE elapsedSec 估算
              var liqElapsedSec = m.phase === 'live' ? Math.max(0, fmtNowSec - m.startTime) : 0;
              // ★ v3 优化项⑭：UPCOMING 确定性标识
              var confirmed = !isTBD(m.team1Name) && !isTBD(m.team2Name);
              // ★ v3 优化项⑭：section 阶段标签
              var stageLabel = m.section || '';
              // 比分样式
              var liqIsDraw = liqScoreA === liqScoreB && m.phase === 'recent';
              var liqScoreACls = liqIsDraw ? 'draw' : (liqScoreA > liqScoreB ? 'win' : (m.phase === 'recent' ? 'lose' : ''));
              var liqScoreBCls = liqIsDraw ? 'draw' : (liqScoreB > liqScoreA ? 'win' : (m.phase === 'recent' ? 'lose' : ''));
              var liqTeamACls = liqIsDraw ? 'draw' : (liqScoreA > liqScoreB ? 'win' : '');
              var liqTeamBCls = liqIsDraw ? 'draw' : (liqScoreB > liqScoreA ? 'win' : '');
              return {
                // ★ 2026-08-22 修复 LOGO 间歇性消失：startTime 改分钟级时间桶（降敏感）。
                //   原因：进行中比赛的数据源会在轮询间切换（Steam LIVE 用 Date.now() 秒级变化，
                //   LPDB/haglund 用真实开赛时间），同一对局 key 不同 → refreshSchedule 的
                //   oldByKey 回填匹配失败 → 轮询重建的空 logo 覆盖已 enrich 的 logo。
                //   分钟级时间桶让同一对局在 ±60s 内的 startTime 差异归一为同一 key。
                key: 'liq-' + normalizeTeamNameForDedup(m.team1Name) + '__' + normalizeTeamNameForDedup(m.team2Name) + '-' + Math.floor((m.startTime || 0) / 60),  // B4 稳定 key（分钟桶）
                games: [],               // Liquipedia 赛程无小场数据
                scoreA: liqScoreA,
                scoreB: liqScoreB,
                boType: m.boType,
                boLabel: m.boType === 'BO1' ? '单局制' : (m.boType === 'BO2' ? '双局积分' : (m.boType === 'BO3' ? '三局两胜' : '五局三胜')),
                boTagCls: m.boType === 'BO2' ? 'bo-bo2' : (m.boType === 'BO3' ? 'bo-bo3' : (m.boType === 'BO5' ? 'bo-bo5' : '')),
                // ★ 2026-08-04：BO 判定引擎信号 —— declaredBo=S1 每场声明（仅 bestof 显式时）；
                //   seriesType：LPDB v3 路径有 series_type（云函数 normalizeV3Match 已映射，
                //     OpenDota series_type 0/1/2/3），供 resolveBoType S3 信号判定 BO（如 series_type=1 → BO3）；
                //     wikitext 路径无 series_type → null（由 S4.5 mapSlots 或 S5 比分约束兜底）。
                //   最终 boType 由 buildSeriesFromSources 末尾的 sources.applyBo 统一覆盖。
                declaredBo: m.boDeclared ? m.boType : null,
                seriesType: (m.series_type != null ? m.series_type : null),
                // ★ 2026-08-12 方案 A：map 槽数（字段存在计数，含空壳）从 LP parseMatchFields 透传，
                //   供 resolveBoType S4.5 信号推断 BO（如 3 槽→BO3、5 槽→BO5）。
                //   LP upcoming/recent 场次无 OpenDota 比分反推路径，mapSlots 是关键 BO 信号。
                mapSlots: m.mapSlots || 0,
                isDraw: liqIsDraw,
                isLive: m.phase === 'live',
                isRecent: liqIsRecent,
                isUpcoming: m.phase === 'upcoming',
                phase: m.phase,
                isMulti: m.boType !== 'BO1',
                // ★ 2026-08-04（v1.1 二次修复）：透传吸收所需字段 —— 此前缺失导致 absorbSettledGames 恒跳过、
                //   LIVE 比分永远显示 LP score 0:0（模拟脚本手工补了字段掩盖了此断点，真机 0:0 实证）
                matchIds: m.matchIds || [],
                // ★ 2026-08-22：透传 series_id —— absorbSettledGames S0.5 跨源关联键（修复 Steam live ↔ OpenDota recent 双卡）
                series_id: m.series_id != null ? m.series_id : null,
                team1Name: m.team1Name,
                team2Name: m.team2Name,
                radiantName: m.team1Name,
                direName: m.team2Name,
                radiantTeamId: 0,        // Liquipedia 赛程无 team_id
                direTeamId: 0,
                radiantWin: !liqIsDraw && liqScoreA > liqScoreB,
                direWin: !liqIsDraw && liqScoreB > liqScoreA,
                scoreACls: liqScoreACls,
                scoreBCls: liqScoreBCls,
                teamACls: liqTeamACls,
                teamBCls: liqTeamBCls,
                teamALogoCls: !liqIsDraw && liqScoreA > liqScoreB ? 'team-win' : '',
                teamBLogoCls: !liqIsDraw && liqScoreB > liqScoreA ? 'team-win' : '',
                radiantLogo: '',
                direLogo: '',
                radiantLogoSource: '',
                direLogoSource: '',
                scheduledTimeText: scheduledTimeText,
                countdownText: countdownText,
                // ★ v3 新增字段
                liveProgress: '',     // Liquipedia 无小场数据，不显示系列进度
                elapsedSec: liqElapsedSec,
                elapsedText: '',
                confirmed: confirmed,
                stageLabel: stageLabel,
                bForfeit: bForfeit,
                forfeitSide: forfeitSide,
                section: m.section || '',
                lastTime: m.startTime
              };
            });
          // 时间窗口过滤：Liquipedia 覆盖了整个赛期的全部赛程，
          // 但用户只需要看近3天的实时对阵。按时间窗口重新归类：
          //   LIVE:   24h 内开赛的未结束比赛（★ v3 优化项⑯：增加 24h 上界二次校验）
          //   UPCOMING: 3天内（北京时间）内开始的未结束比赛（★ v3 优化项⑤：从2天扩展到3天）
          //   RECENT:  已结束（全部保留）
          // 2026-07-31 修复：使用北京时间（UTC+8）计算当天零点
          // O-7（2026-08-15）：魔数收敛 config.time.bjOffsetSec（值保持 8*3600 不变）
          const _BJ_OFFSET = config.time.bjOffsetSec;
          const _bjNow = fmtNowSec + _BJ_OFFSET;
          const _todayStart = Math.floor(_bjNow / 86400) * 86400 - _BJ_OFFSET;
          const _todayEnd = _todayStart + 86400;
          const _threeDaysEnd = _todayStart + 3 * 86400;  // ★ v3：2天→3天
          const _tsize = liqSeries.length;
          liqSeries = liqSeries.filter(function(s) {
            var st = s.lastTime || 0;
            // ★ 2026-08-22 收紧 LIVE 判定（修复「未开赛对局误判进行中」+「已结束卡在进行中」）：
            //   原「(fmtNowSec - st) < 24h」会放过未到开赛时间的卡（如服务器时钟漂移、上游 phase 推早）。
            //   新规则四条件全部满足才算 LIVE：
            //     ① 已开赛（st <= nowSec + 60s 容差）
            //     ② 开赛不超过 6h（绝大多数比赛时长上限，超 6h 基本已结束）
            //     ③ 不在「即将到来 5min 内」（防 phase=live 但 startTime 仍在未来的边界场景）
            //     ④ 系列比分未达 BO 上限（防 Steam LIVE 残留：比分 2:0 的 BO3 已结束）
            if (s.phase === 'live') {
              if (!st) return false;
              var elapsedLive = fmtNowSec - st;
              if (!(elapsedLive >= -60 && elapsedLive < 6 * 3600)) return false;
              // ★ 2026-08-22 根因 J（顺延误判修复·方案 A：实际开赛证据守卫）：
              //   顺延场景：前场 BO3 未结束，后场规划时间到但实际未开赛。原规则只看时间不验证实际进度
              //   → 后场被误判 LIVE。守卫：必须有「实际开赛证据」才允许进入 LIVE 段。
              //   证据链（满足任一即放行）：
              //     E1 系列比分非 0:0（至少一局已结算）—— 适用 LPDB/OpenDota 已返回比分
              //     E2 matchIds 含真实 OpenDota match（数组非空且首元素数字 > 0）—— 适用已吸收局
              //     E3 games 数组含已开赛局（radiant_win!=null 或 start_time<=now+60s）—— 适用 OpenDota 直连
              //     E4 兜底：规划时间已过 15min（PROVISIONAL_GRACE_SEC）—— 准点开赛但数据延迟的容忍窗
              //   防误伤：守卫只在「无任何证据」时生效，已有真实比分的对局天然通过。
              var _hasKickoffProof = false;
              var _s1 = typeof s.score1 === 'number' ? s.score1 : 0;
              var _s2 = typeof s.score2 === 'number' ? s.score2 : 0;
              var _scoreA = typeof s.scoreA === 'number' ? s.scoreA : 0;
              var _scoreB = typeof s.scoreB === 'number' ? s.scoreB : 0;
              // E1：系列比分非 0:0（兼容 liqSeries.score1/2 与 openDota series.scoreA/B 双字段）
              if ((_s1 + _s2) > 0 || (_scoreA + _scoreB) > 0) _hasKickoffProof = true;
              // E2：matchIds 含真实 OpenDota match（数字格式）
              if (!_hasKickoffProof && Array.isArray(s.matchIds) && s.matchIds.length > 0) {
                var _firstMid = s.matchIds[0];
                if (typeof _firstMid === 'number' && _firstMid > 0) _hasKickoffProof = true;
              }
              // E3：games 含已开赛局（OpenDota 直连路径才有 games 数组）
              if (!_hasKickoffProof && Array.isArray(s.games) && s.games.length > 0) {
                for (var gi = 0; gi < s.games.length; gi++) {
                  var _g = s.games[gi];
                  if (_g && (_g.radiant_win != null || (_g.start_time && _g.start_time <= fmtNowSec + 60))) {
                    _hasKickoffProof = true;
                    break;
                  }
                }
              }
              // E4 兜底：规划时间已过 PROVISIONAL_GRACE_SEC（默认 15min），容忍数据延迟
              var PROVISIONAL_GRACE_SEC = 15 * 60;
              if (!_hasKickoffProof && (fmtNowSec - st) >= PROVISIONAL_GRACE_SEC) {
                _hasKickoffProof = true;
              }
              // 无任何实际开赛证据 → 降级回 UPCOMING（顺延等待中）
              if (!_hasKickoffProof) return false;
              // ★ 比分结束判定：若系列比分已达到 BO 上限则归为已结束，不进 LIVE 段
              //   ★ 2026-09-17（P1-5 修复）—— 原实现有两个缺陷：
              //     ① 字段名错：原读 s.score1 / s.score2，但本 filter 作用于 liqSeries
              //        （上方 .map() 的产物，见 L1028）——该对象只有 scoreA / scoreB，
              //        从未产出 score1 / score2 → _s1/_s2 恒 0 → 整段是**死代码**，
              //        注释宣称的「防 Steam LIVE 残留」从未生效（僵尸卡可长期挂 LIVE 段）。
              //     ② BO2 口径不一致：原 Math.ceil(2/2)=1 会把 1:0 进行中的 BO2 判为已结束。
              //        本处以 utils/sources.js（BO 引擎权威实现）为准：
              //        「BO2 双局积分制必须打满 2 局才算结束」。
              if (_scoreA + _scoreB > 0) {
                var _boNum = 0;
                if (s.boType && /^BO\s*([1-9])$/i.test(s.boType)) {
                  _boNum = parseInt(RegExp.$1, 10);
                } else if (s.seriesType != null && s.seriesType >= 0) {
                  _boNum = [1, 3, 5, 2, 7][s.seriesType] || 0;
                }
                if (_boNum > 0) {
                  var _seriesEnded = (_boNum === 2)
                    ? ((_scoreA + _scoreB) >= 2)                        // BO2：打满 2 局
                    : (Math.max(_scoreA, _scoreB) >= Math.ceil(_boNum / 2));
                  if (_seriesEnded) return false;                       // 系列已结束
                }
              }
              return true;
            }
            // UPCOMING：3天内（北京时间）内开始的比赛
            if (s.phase === 'upcoming') return st >= _todayStart && st < _threeDaysEnd;
            return true; // RECENT 全部保留
          });
          // ★ 2026-08-04（v1.1 实施，审核 R3/R4/R5/R6）：LP live/upcoming 卡吸收 OpenDota 已结算局（matchIds 硬关联）
          //   - 方向映射优先级链：curation team_id→名 → league 内 idMap（raw 收集）→ null；单点命中即定方向（补集原理）
          //   - 方向失败：不注入 games（跨 tab 双卡为已文档化边界，R6）
          //   - 被吸收的 OpenDota 单局卡从 allSeries 移除（防 RECENT 重复）
          // ★ 2026-08-05：_curTeamTable/_rawIdMap 已上移至 openDotaKeys 构造处（单一定义，防重复 const 声明）
          const _teamIdName = (id) => {
            if (!id) return null;
            // ★ 2026-08-04（v3.1，R1）：load 预取 explorer 队名（可靠源）优先 → curation → raw idMap 兜底
            if (this._teamIdNameMap && this._teamIdNameMap[id]) return this._teamIdNameMap[id];
            if (_curTeamTable && _curTeamTable[id] && _curTeamTable[id].name) return _curTeamTable[id].name;
            return _rawIdMap[id] || null;
          };
          const _absorb = sources.absorbSettledGames(allSeries, liqSeries, _teamIdName);
          liqSeries = _absorb.liqSeries;
          if (_absorb.absorbedKeys && _absorb.absorbedKeys.length) {
            const _removed = new Set(_absorb.absorbedKeys);
            allSeries = allSeries.filter(function (s) { return !(s.key && _removed.has(s.key)); });
          }
          allSeries = allSeries.concat(liqSeries);
        }

        // ★ BO 判定引擎后处理（2026-08-04，审核 R1-R6 落地）
        // 统一对 OpenDota + Liquipedia 合并后的全部系列执行多信号 BO 判定：
        //   S1 每场声明（LP bestof）→ S2 赛制文本（云 Format 段 liqBoFormat + infobox meta.format 关键词）
        //   → S3 series_type 映射（3=BO2）→ S4 同赛事自证（阶段内 1:1→BO2）→ S5 约束 → S6 默认
        // 修复：① 进行中/即将开始不再因 0:0 比分被反推为 BO1；
        //       ② 已结束 BO2 2:0 不再被误判 BO3（series_type=3 与段内自证双保险）；
        //       ③ BO1/BO2/BO3/BO5 由阶段+局数+声明综合推导，与权威赛制一致。
        // buildBoContext 内部预计算阶段自证表（R3）并给系列打 stageKey（R4 时间簇/LP section）。
        var _boCtx = sources.buildBoContext(allSeries, {
          leagueId: this.data.leagueId,
          leagueName: this.data.name,
          boFormat: liqBoFormat || null,
          metaFormat: (this.data.metadata && this.data.metadata.format) || null,
          // v2.1：LP section 锚点（liqScheduled 带 section 场次 → 阶段识别优先级 1，R2 时间窗守卫在引擎内）
          liqStages: (liqGrouped || []).map(function (m) {
            return { section: m.section || '', startTime: m.startTime || 0 };
          })
        });
        allSeries = allSeries.map(function (s) {
          var _r = sources.applyBo(s, _boCtx);
          // R2（2026-08-04 v1.1）：liveProgress 统一在 applyBo 后计算 —— 依赖最终 boType（吸收发生在 concat 前，当时 BO 未定）
          _r.liveProgress = sources.liveProgressOf(_r);
          return _r;
        });

        // ★ 2026-08-05（v1.1，审核 R1）：UPCOMING 显示门槛 = 至少一方队伍确定。
        //   落点：allSeries 合并（OpenDota 系列 concat liqSeries）之后、三段分派之前 ——
        //   单点过滤覆盖双源（OpenDota 侧 radiantName/direName 占位 + LP 侧 TBD 归一）。
        //   双方均 TBD（含空串归一）→ 不显示，等至少一方确定且符合时间窗后再显示。
        allSeries = allSeries.filter(function (s) {
          if (s.phase === 'upcoming') {
            if (isTBD(s.radiantName) && isTBD(s.direName)) return false;
          }
          return true;
        });

        // ★ 2026-09-01（v8.4 Fix-D）：LIVE 段同对局双卡兜底去重（absorbSettledGames 的最后防线）。
        //   absorb 方向解析失败（explorer 队名 resolver 空）时 OpenDota live 系列卡不被吸收，
        //   与 LP/Steam live 卡并存 → 「对阵正在进行中」同一对局两张卡重叠。
        //   证据链：归一化队名对 / matchIds 交集 / series_id，保留信息量最大的卡。
        allSeries = sources.dedupeLiveSeries(allSeries);

        // ★ 2026-09-02（v8.8 A'）：RECENT 段「OpenDota 拆裂 BO3」合并修复。
        //   现象：EPL Masters II 等赛事部分 BO3 被 OpenDota 拆成多个独立 series_id
        //   （同一真实 BO3 三局各带不同 sid，甚至同队多 team_id），详情页显示为多张 BO1。
        //   判定仅基于「已解名的真实队名 + 时间窗」，不受 series_id / team_id 分裂影响。
        //   守卫（防误并）：
        //     ① 仅 phase='recent'（已结束）且 games=1（单局卡）参与
        //     ② 同归一化队名对 + start_time 链式间隔 ≤6h → 聚簇
        //     ③ 完整终局守卫：簇内 A/B 累计胜局 max≥2（BO3 终局 2:0/2:1；1:1 中断/双 BO1 不并）
        //     ④ 单局卡已含 sid 且 phase=recent（正常聚合的 BO3 games=3 不受影响）
        //   v8.8b：逻辑已上移 sources.mergeSplittedBo3Series（首页共用），此处仅调用。
        allSeries = sources.mergeSplittedBo3Series(allSeries);

        // ★ 2026-09-02（v8.8c）：参赛队白名单过滤 —— 剔除「跨联赛误标」对局。
        //   实证：EPL World Series: SEA（leagueid=18865）的 BO3 前两局被 OpenDota 误标到
        //   league 19944（EPL Masters 2026），Yangon Galacticos / Team Kinetix 并非本赛事
        //   参赛队，却被窗口过滤收进详情页 RECENT（用户核实 Liquipedia 无此对局）。
        //   v8.8c：逻辑已上移 sources.filterMisattributedRecentSeries（首页共用），此处仅调用。
        allSeries = sources.filterMisattributedRecentSeries(allSeries, this.data.leagueId);

        // ★ 三段式分段排序（2026-07-28 新增，v3 增强）
        //   LIVE：进行中，按 lastTime desc —— 最近开赛的在前
        //   UPCOMING：未开赛，按 dateGroup asc → lastTime asc —— 最早开赛的在前，按日期分组
        //   RECENT：已结束，按 lastTime desc —— 最近结束的在前
        // 合并顺序：live → upcoming → recent
        // ★ v3 优化项⑬：LIVE 进度增强 — 为 OpenDota series 计算 liveProgress/elapsedSec
        // ★ v3 优化项⑭：UPCOMING 确定性标识 + 焦点战标记
        // ★ v3 优化项⑮：RECENT 时间分层 — 刚刚结束(2h内)/今天/更早
        // ★ v3 优化项21：UPCOMING dateGroup 字段 + 按日期分组排序
        // ★ v3 优化项28：懒计算 — 只对当前页可见 series 计算新字段（在 setData 前计算）
        const liveList = [], upcomingList = [], recentList = [];
        allSeries.forEach(function (s) {
          if (s.phase === 'live') liveList.push(s);
          else if (s.phase === 'upcoming') upcomingList.push(s);
          else recentList.push(s);
        });
        liveList.sort(function (a, b) { return b.lastTime - a.lastTime; });
        // ★ v3 优化项21：UPCOMING 按 dateGroup 分组排序
        // 先计算 dateGroup（北京时间日期偏移）
        var _bjNowSec = fmtNowSec + config.time.bjOffsetSec;
        var _nowBjDay = Math.floor(_bjNowSec / 86400);
        upcomingList.forEach(function (s) {
          if (s.lastTime > 0) {
            var bjTime = s.lastTime + config.time.bjOffsetSec;
            var bjDay = Math.floor(bjTime / 86400);
            s.dateGroup = bjDay - _nowBjDay;  // 0=今天, 1=明天, 2=后天, ...
          } else {
            s.dateGroup = 0;
          }
          // ★ v3 优化项⑭：UPCOMING 确定性标识
          if (s.confirmed === undefined) {
            s.confirmed = !isTBD(s.radiantName) && !isTBD(s.direName);
          }
          // ★ 2026-08-05（v1.1，审核 R3）：队名位 TBD 标记（供 WXML 斜体样式判定，预计算避免 WXML 依赖函数）
          if (s.radiantTbd === undefined) s.radiantTbd = isTBD(s.radiantName);
          if (s.direTbd === undefined) s.direTbd = isTBD(s.direName);
          // ★ v3 优化项⑭：焦点战标记（双方均为 S-Tier 战队）
          if (s.matchupQuality === undefined) {
            var aHigh = sources.getTeamPriority(s.radiantName) >= 2;
            var bHigh = sources.getTeamPriority(s.direName) >= 2;
            s.matchupQuality = (aHigh && bHigh) ? 'focus' : '';
          }
        });
        upcomingList.sort(function (a, b) {
          var dayDiff = (a.dateGroup || 0) - (b.dateGroup || 0);
          if (dayDiff !== 0) return dayDiff;
          return a.lastTime - b.lastTime;
        });
        recentList.sort(function (a, b) { return b.lastTime - a.lastTime; });
        // ★ v3 优化项⑮：RECENT 时间分层 — 刚刚结束(2h内)/今天/更早
        // 为每个 series 设置 timeLayer + showTimeLayerHeader + timeLayerLabel，
        // 供 WXML 渲染三层子标题（与 UPCOMING date-sep 类似）
        var _nowSec = Math.floor(Date.now() / 1000);
        var _prevLayer = '';
        var TIME_LAYER_LABELS = { just_ended: '刚刚结束', today: '今天', earlier: '更早' };
        recentList.forEach(function (s) {
          if (s.lastTime > 0) {
            var elapsed = _nowSec - s.lastTime;
            if (elapsed < 2 * 3600) {
              s.timeLayer = 'just_ended';  // 刚刚结束（2h内）
            } else {
              var bjTime = s.lastTime + config.time.bjOffsetSec;
              var bjDay = Math.floor(bjTime / 86400);
              var nowBjDay = Math.floor((_nowSec + config.time.bjOffsetSec) / 86400);
              s.timeLayer = (bjDay === nowBjDay) ? 'today' : 'earlier';
            }
          } else {
            s.timeLayer = 'earlier';
          }
          // ★ v3 优化项⑮：三层子标题 — 每个时间层首条 series 显示子标题
          s.showTimeLayerHeader = (s.timeLayer !== _prevLayer);
          s.timeLayerLabel = TIME_LAYER_LABELS[s.timeLayer] || '更早';
          _prevLayer = s.timeLayer;
        });
        // ★ v3 优化项⑬：LIVE 进度增强 — 为 OpenDota series 计算 liveProgress/elapsedSec
        liveList.forEach(function (s) {
          if (s.games && s.games.length > 0) {
            s.liveProgress = 'Game ' + s.games.length + '/' + (s.boType.replace('BO', '') || '1');
            var firstStart = s.games[0].start_time || 0;
            s.elapsedSec = firstStart > 0 ? Math.max(0, _nowSec - firstStart) : 0;
          } else {
            s.liveProgress = s.liveProgress || '';
            s.elapsedSec = s.elapsedSec || 0;
          }
          // 格式化已进行时长
          if (s.elapsedSec > 0) {
            var es = s.elapsedSec;
            if (es < 60) s.elapsedText = es + 's';
            else if (es < 3600) s.elapsedText = Math.floor(es / 60) + 'm';
            else s.elapsedText = Math.floor(es / 3600) + 'h ' + Math.floor((es % 3600) / 60) + 'm';
          } else {
            s.elapsedText = '';
          }
        });
        // ★ v3 优化项⑬：RECENT totalDuration 计算（仅 OpenDota series 有 games 数据）
        // ★ v3 优化项⑮：格式化为 totalDurationText（⏱ Xh Ym）供 WXML 显示
        recentList.forEach(function (s) {
          if (s.games && s.games.length > 0 && !s.totalDuration) {
            var firstStart = s.games[0].start_time || 0;
            var lastEnd = s.games[s.games.length - 1].start_time || 0;
            if (firstStart > 0 && lastEnd > 0) {
              s.totalDuration = lastEnd - firstStart;
            }
          }
          // 格式化总耗时
          if (s.totalDuration > 0) {
            var dh = Math.floor(s.totalDuration / 3600);
            var dm = Math.floor((s.totalDuration % 3600) / 60);
            if (dh > 0) s.totalDurationText = dh + 'h ' + dm + 'm';
            else s.totalDurationText = dm + 'm';
          } else {
            s.totalDurationText = '';
          }
        });
        // UPCOMING 按日期分组数据（供 WXML 渲染分组分隔线）
        // ★ v3 优化项21：为每个 upcoming series 设置 dateLabel + showDateHeader + farFuture 字段，
        //   供 WXML 在扁平 series 列表中渲染日期子标题 + 折叠远期赛程
        var upcomingGroups = [];
        var currentGroup = null;
        var farFutureCount = 0;
        var _prevDay = -1;
        upcomingList.forEach(function (s) {
          var day = s.dateGroup || 0;
          var label;
          if (day === 0) label = '今天';
          else if (day === 1) label = '明天';
          else if (day === 2) label = '后天';
          else label = (day + 1) + '天后';
          s.dateLabel = label;
          // 3天以内的默认展示，3天以上折叠
          if (day <= 2) {
            // 每个日期组的第一条 series 显示日期子标题
            s.showDateHeader = (day !== _prevDay);
            _prevDay = day;
            s.farFuture = false;
            if (!currentGroup || currentGroup.day !== day) {
              currentGroup = { day: day, label: label, series: [] };
              upcomingGroups.push(currentGroup);
            }
            currentGroup.series.push(s);
          } else {
            s.farFuture = true;
            s.showDateHeader = (day !== _prevDay);
            _prevDay = day;
            farFutureCount++;
          }
        });
        allSeries = liveList.concat(upcomingList, recentList);
        // ★ 已结束对阵胜负标识：金色多层级强调（仅 recent），详见 decorateSeriesWinner
        allSeries = allSeries.map((s) => this.decorateSeriesWinner(s));


    // F1：赛事进行中判定 —— 存在「未分胜负 + 近 12h 开赛」的比赛即视为直播中（raw 真实比赛）
    var nowSec = Math.floor(Date.now() / 1000);
    var isLive = (raw || []).some(function (m) {
      return (m.radiant_win == null) && m.start_time && (nowSec - m.start_time) > 0 && (nowSec - m.start_time) < 12 * 3600;
    });
    return {
      allSeries: allSeries,
      liveList: liveList,
      upcomingList: upcomingList,
      recentList: recentList,
      upcomingGroups: upcomingGroups,
      farFutureCount: farFutureCount,
      hasFarFuture: farFutureCount > 0,
      isLive: isLive
    };
  },


  // B4 定时刷新（2026-08-03）：详情页对阵 LIVE/UPCOMING 近实时。
  // 只重拉 Liquipedia 赛程（force 跳过缓存；云函数有 30s 最小间隔节流），
  // OpenDota 侧用 load() 缓存的 _rawMatches（比赛收录滞后 5-30min 是上游延迟，
  // 且 OpenDota 有 60req/min 限制，不应参与 30-60s 轮询）。
  // 复用 buildSeriesFromSources 完整重建（与 load 同源不漂移），
  // 再按 series key 指纹 diff，仅路径 setData 变化的项 —— 保留用户翻页/折叠态。
  // 返回 { live, upcoming } 供轮询自适应间隔（live→30s / 仅 upcoming→60s / 纯 recent→停）。
  refreshSchedule() {
    if (!this.data.name || !this._rawMatches) return Promise.resolve({ live: 0, upcoming: 0 });
    // ★ 2026-08-05：并发锁 —— 弱网下 refreshSchedule 单次执行可能超过轮询间隔（30s），
    // setInterval 到点不等待完成 → 叠加并发（表现：build 链日志 3-5 次/分钟）。
    // 叠加时短路返回当前已知状态（live/upcoming 计数不变 → 调用方保持原间隔，不误停轮询）。
    if (this._refreshing) {
      return Promise.resolve({ live: this.data.liveCount || 0, upcoming: this.data.upcomingCount || 0 });
    }
    this._refreshing = true;
    var self = this;
    return liquipedia.getScheduledMatches(this.data.name, { force: true, leagueId: this.data.leagueId })
      .then(function (scheduled) {
        // ★ 2026-08-04：新契约 { matches, boFormat }（兼容旧数组）
        if (!scheduled || !Array.isArray(scheduled.matches)) return { live: 0, upcoming: 0 };
        // ★ 2026-08-04（v1.1，R2/R3/R4）：有 live 卡时低频（≥5min）重拉 OpenDota，更新 _rawMatches 后 rebuild。
        //   修复：进行中 BO3 的新局在 load 后被 OpenDota 收录（滞后 5-30min）时，轮询也能吸收到新局 →
        //   LIVE 比分随局更新（fingerprint 已含 scoreA:scoreB，diff 自动 patch）。
        //   - R2：负 leagueId（Liquipedia 新增赛事）无 OpenDota 数据，跳过重拉
        //   - R3：force 走云函数路径（云函数 leagueMatches TTL 已降 5min）；直连兜底不 force（防 NAT 429）
        //   - R4：仅第二次 rebuild 的 built 用于 setData；失败静默降级不阻塞 LP 刷新
        var hasValidLid = !!(Number(self.data.leagueId) > 0);
        var nowSec = Math.floor(Date.now() / 1000);
        var built = self.buildSeriesFromSources(self._rawMatches, scheduled.matches, scheduled.boFormat || null);
        var needOd = hasValidLid && sources.shouldRefreshOpenDota(built.liveList.length, self._lastOdRefresh || 0, nowSec);
        // P2（2026-08-05）：_lastOdRefresh 置位从"完成后"改"发起时" ——
        // 原在 odTask.then 里置位，弱网时 OD 请求慢（5-15s）期间每 30s 轮询 needOd 仍 true，
        // 会重复发起 force OD 请求（每个都绕过缓存现抓）→ 请求风暴 + OpenDota 限流风险。
        // 发起时置位保留 R4"无论成败"语义（成功/失败均 5min 内不重发）。
        if (needOd) self._lastOdRefresh = nowSec;
        var odTask = needOd
          ? api.getLeagueMatches(self.data.leagueId, true).catch(function () { return null; })
          : Promise.resolve(null);
        return odTask.then(function (fresh) {
          if (fresh && Array.isArray(fresh) && fresh.length) {
            // ★ 2026-09-01（v8.4 Fix-A）：轮询重拉的 OpenDota 数据同样过届次窗口
            //   （与 load 同口径，防 _rawMatches 被两届混杂数据回填）
            fresh = sources.filterMatchesByWindow(fresh, self._editionWindowOf());
            self._rawMatches = fresh;
            // ★ 2026-08-04（v3.1，R4）：增量补查新 team_id → 合并 map（下一轮 build 自然生效）
            var _newIds = [];
            fresh.forEach(function (m) {
              if (m && m.radiant_team_id && m.radiant_team_id > 0 && !(self._teamIdNameMap && self._teamIdNameMap[m.radiant_team_id])) _newIds.push(m.radiant_team_id);
              if (m && m.dire_team_id && m.dire_team_id > 0 && !(self._teamIdNameMap && self._teamIdNameMap[m.dire_team_id])) _newIds.push(m.dire_team_id);
            });
            if (_newIds.length) {
              api.getTeamNames(Array.from(new Set(_newIds.map(Number))))
                .catch(function () { return {}; })
                .then(function (extra) {
                  if (extra && Object.keys(extra).length) self._teamIdNameMap = Object.assign({}, self._teamIdNameMap, extra);
                });
            }
            built = self.buildSeriesFromSources(fresh, scheduled.matches, scheduled.boFormat || null);  // 仅第二次 built 用于 setData（R4）
          }
          var all = built.allSeries;
        // ★ 2026-08-04 优化：refresh 重建的 series 来自 _rawMatches（logo 全空、队名可能占位），
        // 直接替换会让 enrichTeamLogos 每次轮询（30-60s）全量重查 logo + 队名回退占位。
        // 按稳定 key 回填旧 series 已 enrich 的 logo/队名 → enrichTeamLogos 的 skip 生效，
        // 只处理新增/变化的 series；队名也不再回退占位。
        var oldByKey = {};
        // ★ 2026-08-22 双保险：同步建一份「归一化队名对」索引，供 key 不匹配时按队名兜底回填 logo。
        //   场景：进行中比赛数据源切换导致 key 变化（Steam LIVE Date.now() vs LPDB 真实时间），
        //   按 key 回填失败 → 按队名匹配兜底，确保 logo 不因数据源切换而丢失。
        var oldByTeamPair = {};
        (self.allSeries || []).forEach(function (o) {
          if (!o) return;
          if (o.key) oldByKey[o.key] = o;
          if (o.radiantName && o.direName) {
            var _normA = normalizeTeamNameForDedup(o.radiantName);
            var _normB = normalizeTeamNameForDedup(o.direName);
            if (_normA && _normB) oldByTeamPair[_normA + '|' + _normB] = o;
          }
        });
        all.forEach(function (s) {
          var old = oldByKey[s.key];
          // ★ 队名兜底：key 不匹配时按归一化队名对查找（同一场比赛即便 key 变了队名也不变）
          if (!old && s.radiantName && s.direName) {
            var _na = normalizeTeamNameForDedup(s.radiantName);
            var _nb = normalizeTeamNameForDedup(s.direName);
            if (_na && _nb) old = oldByTeamPair[_na + '|' + _nb];
          }
          if (!old) return;
          if (!s.radiantLogo && old.radiantLogo) s.radiantLogo = old.radiantLogo;
          if (!s.direLogo && old.direLogo) s.direLogo = old.direLogo;
          if (!s.radiantLogoSource && old.radiantLogoSource) s.radiantLogoSource = old.radiantLogoSource;
          if (!s.direLogoSource && old.direLogoSource) s.direLogoSource = old.direLogoSource;
          if ((!s.radiantName || s.radiantName === '天辉') && old.radiantName && old.radiantName !== '天辉') s.radiantName = old.radiantName;
          if ((!s.direName || s.direName === '夜魇') && old.direName && old.direName !== '夜魇') s.direName = old.direName;
        });
        var pageSize = self.data.pageSize;
        // ★ 2026-09-17（P1-6 修复）：保留用户已翻页的渲染量。
        //   原实现固定 slice(0, pageSize) —— 用户 appendPage 后 oldSeries.length 已增长到
        //   (page+1)*pageSize，两者恒不等 → structureChanged 恒 true → 每次轮询把列表
        //   打回第一页（与下方「保留用户翻页态」的设计目标相悖）。
        var oldSeries = self.data.series || [];
        var renderedLen = Math.max(pageSize, oldSeries.length);
        var slice = all.slice(0, Math.min(renderedLen, all.length));
        var patch = {};
        // 结构变化（段计数/长度变化）→ 全量替换 series（低频：段间移动/新增/删除）
        var structureChanged =
          built.liveList.length !== self.data.liveCount ||
          built.upcomingList.length !== self.data.upcomingCount ||
          built.recentList.length !== self.data.recentCount ||
          slice.length !== oldSeries.length;
        if (structureChanged) {
          patch.series = slice;
        } else {
          // 同结构 → 逐项指纹 diff（高频：比分/状态变化）
          slice.forEach(function (s, i) {
            var old = oldSeries[i];
            if (!old || fingerprintSeries(s) !== fingerprintSeries(old)) {
              patch['series[' + i + ']'] = s;
            }
          });
        }
        // 标量更新（计数/分页/时间戳）
        patch.totalSeries = all.length;
        // ★ 2026-09-17（P1-6 修复）：回写 page 使其与本次渲染长度保持一致。
        //   原 patch 不含 page → data.page 停留在翻页后的旧值，而 series 可能已被替换/截短，
        //   后续 onReachBottom → appendPage 以 `data.page * pageSize` 作起点写入
        //   会落到越界下标（稀疏空洞）。此处按渲染长度反推页索引。
        patch.page = Math.max(0, Math.ceil(slice.length / pageSize) - 1);
        patch.liveCount = built.liveList.length;
        patch.upcomingCount = built.upcomingList.length;
        patch.recentCount = built.recentList.length;
        patch.hasMore = all.length > slice.length;
        patch.upcomingGroups = built.upcomingGroups;
        patch.farFutureCount = built.farFutureCount;
        patch.hasFarFuture = built.hasFarFuture;
        patch.isLive = built.isLive;
        patch.scheduleUpdatedAt = Math.floor(Date.now() / 1000);   // D1 数据时间戳
        patch.scheduleUpdatedLabel = util.formatAgo(patch.scheduleUpdatedAt);
        self.setData(patch);
        self.allSeries = all;   // 供后续 enrichTeamNames/Logos 与下一次 diff 使用
        // refresh 重建的 series 来自未 enrich 的 _rawMatches，队名/logo 可能回退为占位
        //（'天辉'/'夜魇'/空 logo），且 diff 命中整项替换会覆盖首次 enrich 的结果。
        // 重新注入（幂等、getTeamNames/logoCache 有缓存，仅补占位）。
        try { self.enrichTeamNames(); self.enrichTeamLogos(); } catch (e) { /* 隔离 */ }
        return { live: built.liveList.length, upcoming: built.upcomingList.length };
        });
      })
      .catch(function () { return { live: 0, upcoming: 0 }; })
      .then(function (result) { self._refreshing = false; return result; });   // 释放并发锁（成败均释放）
  },

  // B4 轮询三态：onShow 启动 / onHide 停止 / onUnload 清理。
  // 自适应间隔：有 live → 30s；仅 upcoming → 60s；纯 recent → 停止（省资源）。
  // 启动时先静默刷一次（SWR：先渲染缓存，后台拉最新替换）。
  startSchedulePolling() {
    this.stopSchedulePolling();
    var self = this;
    // load() 尚未完成（loading）→ 延迟重试，避免与 load 的首次拉取并发重复请求
    if (this.data.loading) {
      this._pollStartDelay = setTimeout(function () { self.startSchedulePolling(); }, 3000);
      return;
    }
    if (!this.data.name) return;
    this._pollActive = true;
    this.refreshSchedule().then(function (r) {
      if (!self._pollActive) return;
      var interval = (r && r.live > 0) ? 30000 : ((r && r.upcoming > 0) ? 60000 : 0);
      if (interval <= 0) { self.stopSchedulePolling(); return; }   // 纯 recent → 停
      self._pollInterval = interval;
      self._pollTimer = setInterval(function () {
        self.refreshSchedule().then(function (r2) {
          if (!self._pollActive) { self.stopSchedulePolling(); return; }
          var next = (r2 && r2.live > 0) ? 30000 : ((r2 && r2.upcoming > 0) ? 60000 : 0);
          if (next !== self._pollInterval) {
            self.stopSchedulePolling();
            if (next > 0) self.startSchedulePolling();   // 提速（live 出现）或降速/停止
          }
        }).catch(function () {});
      }, interval);
    }).catch(function () {});
  },

  stopSchedulePolling() {
    this._pollActive = false;
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    if (this._pollStartDelay) {
      clearTimeout(this._pollStartDelay);
      this._pollStartDelay = null;
    }
  },
  enrichTeamNames() {
    if (!this.allSeries || !this.allSeries.length) return;
    const need = {};
    this.allSeries.forEach((s) => {
      // 小场：队名为空或兜底占位都需要补全
      s.games.forEach((m) => {
        if (m.radiantTeamId != null && (!m.radiantName || m.radiantName === '天辉')) need[m.radiantTeamId] = true;
        if (m.direTeamId != null && (!m.direName || m.direName === '夜魇')) need[m.direTeamId] = true;
      });
      // 系列头部同样处理（OpenDota 返回 radiant_team_name 为空时 groupSeries 会兜底成'天辉'/'夜魇'）
      if (s.radiantTeamId != null && (!s.radiantName || s.radiantName === '天辉')) need[s.radiantTeamId] = true;
      if (s.direTeamId != null && (!s.direName || s.direName === '夜魇')) need[s.direTeamId] = true;
    });
    // 参赛队伍（participantsList）中"Team {id}"占位名的 id 一并加入查询，避免漏网。
    // 仅占位被命中，真名（如"Team Secret"）不会被误匹配（/^Team \d+$/ 要求纯数字 id）。
    (this.data.participantsList || []).forEach((t) => {
      if (t && /^Team \d+$/.test(t.name) && t.id != null) need[t.id] = true;
    });
    const ids = Object.keys(need).filter((x) => x !== 'null' && x !== '');
    if (!ids.length) return;
    return api.getTeamNames(ids)
      .then((nameMap) => {
        const patch = {};
        const visible = this.data.series;
        visible.forEach((s, si) => {
          s.games.forEach((m, gi) => {
            if ((!m.radiantName || m.radiantName === '天辉') && m.radiantTeamId != null && nameMap[m.radiantTeamId]) {
              patch['series[' + si + '].games[' + gi + '].radiantName'] = nameMap[m.radiantTeamId];
            }
            if ((!m.direName || m.direName === '夜魇') && m.direTeamId != null && nameMap[m.direTeamId]) {
              patch['series[' + si + '].games[' + gi + '].direName'] = nameMap[m.direTeamId];
            }
          });
          // 系列头部队名若为占位（天辉/夜魇）则用自身 team_id 或第一场补全
          const fg = s.games[0];
          if ((!s.radiantName || s.radiantName === '天辉') && nameMap[s.radiantTeamId || (fg && fg.radiantTeamId)]) {
            patch['series[' + si + '].radiantName'] = nameMap[s.radiantTeamId || (fg && fg.radiantTeamId)];
          }
          if ((!s.direName || s.direName === '夜魇') && nameMap[s.direTeamId || (fg && fg.direTeamId)]) {
            patch['series[' + si + '].direName'] = nameMap[s.direTeamId || (fg && fg.direTeamId)];
          }
        });
        // 同步更新 allSeries 内存缓存
        this.allSeries.forEach((s) => {
          s.games.forEach((m) => {
            if ((!m.radiantName || m.radiantName === '天辉') && m.radiantTeamId != null && nameMap[m.radiantTeamId]) m.radiantName = nameMap[m.radiantTeamId];
            if ((!m.direName || m.direName === '夜魇') && m.direTeamId != null && nameMap[m.direTeamId]) m.direName = nameMap[m.direTeamId];
          });
          const fg = s.games[0];
          if ((!s.radiantName || s.radiantName === '天辉') && nameMap[s.radiantTeamId || (fg && fg.radiantTeamId)]) s.radiantName = nameMap[s.radiantTeamId || (fg && fg.radiantTeamId)];
          if ((!s.direName || s.direName === '夜魇') && nameMap[s.direTeamId || (fg && fg.direTeamId)]) s.direName = nameMap[s.direTeamId || (fg && fg.direTeamId)];
        });
        // 参赛队伍（participantsList）占位名补全：同步覆盖"Team {id}"为真实队名
        const curParticipants = this.data.participantsList || [];
        if (curParticipants.length) {
          const patchedParticipants = curParticipants.map((t) => {
            if (t && /^Team \d+$/.test(t.name) && nameMap[t.id]) {
              return Object.assign({}, t, { name: nameMap[t.id] });
            }
            return t;
          });
          const participantsChanged = patchedParticipants.some((t, i) => t.name !== curParticipants[i].name);
          if (participantsChanged) patch.participantsList = patchedParticipants;
        }
        if (Object.keys(patch).length) this.setData(patch);
      })
      .catch((err) => {
        // 2026-07-27：队名补全失败日志（非静默吞错），方便排查「队伍名显示为占位」的根因。
        console.warn('[league-detail] enrichTeamNames 失败，队伍将保留为 "Team {id}" 占位:', err);
      });
  },

  // 异步批量补全 series 头部战队 logo
  // 设计要点：
  //   ① 全段去重：所有 series 的 radiantTeamId/direTeamId 汇总去重，跨 LIVE/UPCOMING/RECENT 段复用
  //   ② 并行查询：用 Promise.all 并发，每个内部 .catch 隔离，任一失败不影响其他
  //   ③ 跳过已有 logo：allSeries 内存缓存中已有 http logo 字段的队伍跳过，避免重复请求
  //   ④ 路径更新：用 series[i].radiantLogo 形式批量 setData，不重建整个 series 数组
  //   ⑤ 失败静默：logo 非关键信息，加载失败时 wxml 走 fallback 显示首字母圆
  //   ⑥ 同步更新 participantsList：参赛队伍 Tab 的 logo 也一并补全
  enrichTeamLogos() {
    if (!this.allSeries || !this.allSeries.length) return;

    // ★ inflight 去重守卫（2026-07-28 步骤 5 新增）
    // 用户快速滚动触发多次 appendPage → enrichTeamLogos 时，避免并发重复请求同一批 team_id。
    // 复用 _enrichLogosInflight Promise，并发调用方都 await 同一个 Promise，结果共享。
    if (this._enrichLogosInflight) return this._enrichLogosInflight;

    this._enrichLogosInflight = this._doEnrichTeamLogos().then((done) => {
      this._enrichLogosInflight = null;  // 清理 inflight 标记
      return done;
    }).catch(() => {
      this._enrichLogosInflight = null;
    });
    return this._enrichLogosInflight;
  },

  // 实际执行 logo 批量补全（由 enrichTeamLogos 调用，含 inflight 去重）
  _doEnrichTeamLogos() {
    // 1) 收集所有 team_id（去重）
    //    同时收集 participantsList 中的占位 id（与 enrichTeamNames 一致）
    const teamIds = {};
    this.allSeries.forEach((s) => {
      const aids = [s.radiantTeamId, s.direTeamId];
      aids.forEach((tid) => {
        if (tid != null && tid > 0 && !teamIds[tid]) {
          // allSeries 中已有 logo 的直接跳过，避免重复请求
          if (s.radiantLogo && /^https?:\/\//i.test(s.radiantLogo) && tid === s.radiantTeamId) {
            teamIds[tid] = { id: tid, name: s.radiantName || '', skip: true };
          } else if (s.direLogo && /^https?:\/\//i.test(s.direLogo) && tid === s.direTeamId) {
            teamIds[tid] = { id: tid, name: s.direName || '', skip: true };
          } else {
            // ★ 2026-07-28 修复 name 归属 BUG：
            //   原 name: s.radiantName || s.direName 会把 dire 队名误赋给 radiant team_id
            //   修复：按 tid 归属取对应队名
            const teamName = (tid === s.radiantTeamId) ? (s.radiantName || '')
                          : (tid === s.direTeamId) ? (s.direName || '')
                          : '';
            teamIds[tid] = { id: tid, name: teamName };
          }
        }
      });
    });
    (this.data.participantsList || []).forEach((t) => {
      if (t && t.id > 0 && !teamIds[t.id]) {
        teamIds[t.id] = { id: t.id, name: t.name || '' };
      }
    });

    // ★ 2026-09-01（v8.6 Fix-G2）：归一化规则统一为「去非字母数字」——
    //   与快照 team-logo-local-data.js byName 键（fetch-team-logos.js normName：
    //   replace(/[^a-z0-9]/g,'')）完全一致，消除「两边规则不同 → 精确键永远 miss」。
    //   原实现 replace(/\s+/g,'') 保留 + 号（"Pipsqueak+4"→pipsqueak+4），
    //   快照键是 pipsqueak4 → 永远不匹配（P0，实测 Level UP/Pipsqueak+4 等全 miss）。
    function normName(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

    // ★ §8.3 名称兜底（2026-07-29）：Liquipedia 赛程补充的 upcoming/live 对阵
    //   team_id=0（{{Match}} 模板不提供 OpenDota team_id），按队名走 name 三级链路
    //   （快照 byName → findTeamByName → 负缓存）。
    //   ⚠️ 2026-09-02 修复：不可因「同队在 recent 段有 team_id」就设 skip=true。
    //      写 series logo 时 upcoming 段 team_id=0 只查 nameLogoMap[norm]（L2056-2073），
    //      不走 logoMap[team_id] → skip=true 的队 logo 永远空白（曾致 8/9 队 upcoming 不显示）。
    //      skip 仅保留单条件：该队 series 自身已带有效 logo URL（避免覆盖已有）。
    const nameTeams = {};  // 归一化队名 → { name, skip }
    this.allSeries.forEach((s) => {
      if ((!s.radiantTeamId || s.radiantTeamId <= 0) && s.radiantName) {
        const norm = normName(s.radiantName);
        if (norm && !nameTeams[norm]) {
          nameTeams[norm] = { name: s.radiantName, skip: !!(s.radiantLogo && /^https?:\/\//i.test(s.radiantLogo)) };
        }
      }
      if ((!s.direTeamId || s.direTeamId <= 0) && s.direName) {
        const norm = normName(s.direName);
        if (norm && !nameTeams[norm]) {
          nameTeams[norm] = { name: s.direName, skip: !!(s.direLogo && /^https?:\/\//i.test(s.direLogo)) };
        }
      }
    });

    // ★ 2026-08-11 修复：参赛队伍 Tab 的 logo（TI 2026 BUG）
    //   根因：未开赛赛事走 refreshMetadataDerived 分支④重建 participantsList 时，
    //        队伍 id 为负数占位（-1-i，无 OpenDota team_id）。enrichTeamLogos 的
    //        participantsList 收集分支（上方）只收 id>0，负数 id 被全部跳过，
    //        导致参赛队伍 Tab 16 支队伍 logo 永远不查询、永不显示。
    //   修复：负数 id 队伍按队名走 nameTeams 路径（findTeamByName → OpenDota CDN logo），
    //        与 allSeries 中 team_id=0 的 Liquipedia 对阵共用同一名称兜底链路。
    //   守卫：跳过占位名（"待定队伍 N"/"待公布"）、已有 logo 的、已在 allSeries 收集过的、
    //        30min 内失败的（复用 _logoFailNames 负缓存，避免轮询空跑）。
    //   ⚠️ 2026-09-02 修复：移除「已在 teamIds → skip 已生效」守卫——占位队 id 是负数，
    //      写 participantsList 时（L2134+）不命中 logoMap[team_id]，必须走 nameLogoMap。
    //      同 §8.3 upcoming series BUG：skip 该队会让它永远不进 nameLogoMap → logo 空白。
    (this.data.participantsList || []).forEach((t) => {
      if (!t || t.id > 0) return;                // 仅处理负数占位 id
      if (t.logo && /^https?:\/\//i.test(t.logo)) return; // 已有 logo 跳过
      const nm = t.name || '';
      if (!nm || /^待(定|公布)/.test(nm) || /^Team \d+$/.test(nm)) return; // 占位名跳过
      const norm = normName(nm);
      if (!norm) return;
      if (nameTeams[norm]) return;               // allSeries 已收集 → 不覆盖
      if (this._logoFailNames && this._logoFailNames[norm] &&
          (Date.now() - this._logoFailNames[norm]) < 30 * 60 * 1000) return; // 30min 负缓存
      nameTeams[norm] = { name: nm, skip: false };
    });

    // 过滤出需要查询的 team_id（skip=true 的跳过）
    let needQueryIds = Object.keys(teamIds).filter((tid) => !teamIds[tid].skip);
    // ★ 2026-08-04 优化：name 路径失败负缓存（页面级，30min）—— findTeamByName 未找到/
    // 无 logo 的队伍在轮询中反复重查，缓存后 30min 内跳过（Liquipedia 新增队伍概率低）。
    let needQueryNames = Object.keys(nameTeams).filter((norm) => {
      if (nameTeams[norm].skip) return false;
      if (this._logoFailNames && this._logoFailNames[norm] &&
          (Date.now() - this._logoFailNames[norm]) < 30 * 60 * 1000) return false;
      return true;
    });

    // ★ 2026-09-01（P1-3）：build-time logo 快照命中 —— 零网络直填。
    //   快照（utils/team-logo-local-data.js，npm run fetch:logos 产出）覆盖
    //   「活跃赛事参赛队 + rating 前 400」：命中 byId/byName 的队伍转为合成结果
    //   （走既有 logoMap/nameLogoMap/_logoQueryCache/路径更新管线），不再发网络请求；
    //   未命中队伍仍走下方原查询链（增量兜底）。快照未生成（require 失败）→ 全量走原链路。
    if (!this._logoSnapChecked) {
      this._logoSnapChecked = true;   // 只 require 一次（成功或失败均不重试）
      try { this._logoSnap = require('../../../utils/team-logo-local-data.js'); }
      catch (e) { this._logoSnap = null; }
    }
    const snap = this._logoSnap;
    const snapResults = [];
    // ★ 2026-09-01（v8.5 Fix-G）：快照 URL 规范化 —— 快照由 fetch-team-logos.js 生成时
    //   存的是 OpenDota 原始 logo_url（含 steamcdn-a.akamaihd.net / steamusercontent-a 死域 /
    //   http:// 等）。toLogoUrl 出口已统一规范化（image.js normalizeLogoUrl），但快照命中
    //   路径绕过 toLogoUrl 直接取 hit.logo → 死域/http URL 仍会进视图被微信拦截/加载失败。
    //   修复：命中时先 normalizeLogoUrl，规范化为空（死域剔除）则该队视为未命中，回落到
    //   网络查询链（findTeamByName → OpenDota CDN logo）。快照文件本身也随 fetch:logos 规范化。
    const imageUtil2 = require('../../../utils/image.js');
    const _normSnapLogo = function (logo) { return imageUtil2.normalizeLogoUrl(logo); };
    // ★ 2026-09-01（v8.6 Fix-G2）：快照 byName 模糊匹配 —— LP 队名是简称（"Level UP"），
    //   快照 byName 键基于 OpenDota 全名（"Level UP esports" → levelupesports）。
    //   精确键 miss 时按「前缀包含」兜底（levelup 命中 levelupesports）：
    //   短键在前缀命中时取最长全名键对应的 logo（同队多 id 时 OpenDota 全名最全）。
    //   守卫：候选键长度 ≥ 键长 + 3（防 "mouz" 命中 "mouzesports" 之类过度扩展误配）。
    // ★ 2026-09-01（v8.7 C 补强）：反向前缀匹配 —— LP 队名可能带修饰后缀，归一化后比
    //   快照键更长（"DYNASTY (stack)" → dynastystack vs 快照键 dynasty）。
    //   此时 norm 以快照键开头且剩余部分为常见修饰词（stack/academy/gg…）才命中，
    //   取最长键（最接近全名）。守卫修饰词集合防误配（如 Team Spirit Academy 精确键
    //   teamspiritacademy 存在时优先，不触发 teamspirit 反向匹配）。
    const _NAME_MODIFIERS = ['stack', 'academy', 'esports', 'esport', 'gaming', 'team', 'club', 'gg', 'division', 'x'];
    const _snapByNameFuzzy = function (norm) {
      if (!snap || !snap.byName || !norm) return null;
      const exact = snap.byName[norm];
      if (exact && /^https?:\/\//i.test(exact.logo)) return exact;
      // 前缀包含匹配：快照键以 norm 开头（简称→全名），取最短键（最接近原队名）
      let bestKey = null;
      Object.keys(snap.byName).forEach((k) => {
        if (k.length >= norm.length + 3 && k.indexOf(norm) === 0) {
          if (!bestKey || k.length < bestKey.length) bestKey = k;
        }
      });
      if (bestKey && /^https?:\/\//i.test(snap.byName[bestKey].logo)) return snap.byName[bestKey];
      // 反向前缀匹配：norm 以快照键开头且更长，剩余部分为修饰词（全名→简称，LP 加后缀场景）
      let revKey = null;
      Object.keys(snap.byName).forEach((k) => {
        if (k.length < 4 || k.length >= norm.length) return;
        if (norm.indexOf(k) === 0) {
          const rest = norm.slice(k.length);
          if (rest && _NAME_MODIFIERS.indexOf(rest) >= 0) {
            if (!revKey || k.length > revKey.length) revKey = k;  // 取最长键（最接近全名）
          }
        }
      });
      if (revKey && /^https?:\/\//i.test(snap.byName[revKey].logo)) return snap.byName[revKey];
      return null;
    };
    if (snap && (snap.byId || snap.byName)) {
      needQueryIds = needQueryIds.filter((tid) => {
        const hit = snap.byId && snap.byId[tid];
        if (hit && /^https?:\/\//i.test(hit.logo)) {
          const nlogo = _normSnapLogo(hit.logo);
          if (nlogo) {
            snapResults.push({ id: Number(tid), logo: nlogo, source: 'snapshot' });
            return false;
          }
        }
        return true;
      });
      needQueryNames = needQueryNames.filter((norm) => {
        const hit = _snapByNameFuzzy(norm);
        if (hit && /^https?:\/\//i.test(hit.logo)) {
          const nlogo = _normSnapLogo(hit.logo);
          if (nlogo) {
            snapResults.push({ normName: norm, logo: nlogo, source: 'snapshot' });
            return false;
          }
        }
        return true;
      });
      if (snapResults.length) {
        console.info('[detail][perf] P1-3 快照命中 logo ' + snapResults.length + ' 队（剩余网络查询 ' +
          (needQueryIds.length + needQueryNames.length) + '）');
      }
    }

    // ★ 2026-09-01（P1-3）：可视域优先查询上限 —— 每次调用最多 QUERY_CAP 个网络查询，
    //   当前页可见 series 的队伍优先（次优先 name 路径——参赛队伍 Tab 负 id 占位队）。
    //   被延后的队伍（未查询、未负缓存）由下一次调用增量补齐：
    //   loadMore 翻页 / refreshSchedule 轮询（30-60s）均会重入 enrichTeamLogos。
    // ★ 2026-09-01（v8.7 A+ 修复）：QUERY_CAP **只对 ID 查询限流**（needQueryIds，
    //   api.getTeam 每个 team_id 1 次 OpenDota 请求，确实需要限流防 60req/min 触发）；
    //   name 查询（needQueryNames，findTeamByName）**全量放行** —— 内部共享
    //   cached('/teams', 24h) 单一缓存槽，N 个队名只发 1 次网络请求，无限流需求。
    //   原实现把两者捆进同一 QUERY_CAP：进行中/已结束段 ID ≥12 时 name 被砍到 0，
    //   upcoming 段（team_id=0 只能走 name 路径）队徽一轮都不查 → 详情页「即将到来」
    //   队标大范围空白（首页无此配额所以正常）。A+ 修复该饿死问题。
    const QUERY_CAP = 12;
    if (needQueryIds.length > QUERY_CAP) {
      const visibleIds = {};
      (this.data.series || []).forEach((s) => {
        if (s && s.radiantTeamId > 0) visibleIds[s.radiantTeamId] = 1;
        if (s && s.direTeamId > 0) visibleIds[s.direTeamId] = 1;
      });
      const visIds = needQueryIds.filter((tid) => visibleIds[Number(tid)]);
      const otherIds = needQueryIds.filter((tid) => !visibleIds[Number(tid)]);
      const cappedIds = visIds.length >= QUERY_CAP
        ? visIds.slice(0, QUERY_CAP)
        : visIds.concat(otherIds).slice(0, QUERY_CAP);
      const deferred = (needQueryIds.length - cappedIds.length) + needQueryNames.length;
      console.info('[detail][perf] P1-3 查询上限：本次 ' + cappedIds.length + ' id（name ' +
        needQueryNames.length + ' 全量放行，延后 ' + deferred + ' 由下次调用补齐）');
      needQueryIds = cappedIds;
    }
    if (!needQueryIds.length && !needQueryNames.length) {
      // 快照全命中（无网络任务）：仍需走结果管线把快照结果写入缓存/视图
      if (!snapResults.length) return Promise.resolve(false);
    }

    // 2) 并行批量查询（每个 .catch 隔离，任一失败不影响其他）
    //    ★ 2026-07-28 修复 LOGO 不显示 BUG：
    //    原 BUG：直接传 { id, name } 给 enrichTeamLogo，但 enrichTeamLogo 依赖 team.logo 字段
    //           OpenDota /leagues/{id}/matches 不返回 team.logo_url，导致 existing='' → 走 STRATZ
    //           STRATZ 限流/失败时返回 null，logo 永远为空
    //    修复：先调 api.getTeam(id) 获取 logo_url，再传给 enrichTeamLogo
    //         enrichTeamLogo 内部 existing 命中 → 直接返回，不走 STRATZ
    //    参考：team-detail.js L250 也是先获取 team.logo 再传给 enrichTeamLogo
    //    缓存：api.getTeam 内部有 15min 新鲜 + team TTL 缓存，跨赛事复用
    const tasks = needQueryIds.map((tid) => {
      const team = teamIds[tid];
      // 先调 api.getTeam 拿 logo_url（OpenDota /teams/{id} 端点返回 logo_url 字段）
      return api.getTeam(team.id)
        .then((teamInfo) => {
          const logoUrl = (teamInfo && teamInfo.logo_url) || '';
          // 方案C：OpenDota 有 logo_url 时走 enrichTeamLogo（仅第②步 existing 命中即返回），
          // 无 logo_url 时不降级 Liquipedia（CDN 域名不在微信白名单，无法渲染），直接返回 null。
          if (!logoUrl) {
            // ★ 2026-08-04 优化：OpenDota 无 logo_url → 写负缓存（24h），
            // 否则每次 refresh 轮询都重查该 id（api.getTeam 缓存命中但逻辑仍跑，
            // 日志反复出现"失败ids=10207961"）。logoCache.markNegative 后
            // sources.enrichTeamLogo 的 hasNegative 短路，不再重复查询。
            try { logoCache.markNegative(team.id); } catch (e) { /* 隔离 */ }
            return { id: team.id, logo: null, source: '' };
          }
          return sources.enrichTeamLogo({ id: team.id, name: team.name, logo: logoUrl });
        })
        .then((r) => ({ id: team.id, logo: r && r.logo, source: r && r.source }))
        .catch(() => {
          // ★ 2026-08-04 优化：查询异常也写负缓存（防轮询反复重试同一失败 id）
          try { logoCache.markNegative(team.id); } catch (e) { /* 隔离 */ }
          return { id: team.id, logo: null, source: '' };
        });
    });
    // ★ 方案C Step B：名称兜底任务（2026-08-01 修复）
    //   使用 api.findTeamByName（基于 /api/teams 全量列表，24h 缓存）替代已失效的 api.searchTeams，
    //   直接获取 OpenDota team_id 和 logo_url，优先走 OpenDota CDN（cdn.opendota.com 已在微信白名单）。
    //   不再降级 Liquipedia（CDN 域名 94.23.144.183 不在微信白名单，无法渲染）。
    function searchThenLiquipedia(norm, team) {
      // ★ 2026-08-01 修复：改用 api.findTeamByName（基于 /api/teams 全量列表，24h 缓存）
      //   替代已失效的 api.searchTeams（/api/search 接口常返回空结果）。
      //   findTeamByName 返回 { team_id, name, logo_url }，可直接使用 logo_url，
      //   无需再调 api.getTeam。同时移除 Liquipedia 降级（CDN 域名不在微信白名单）。
      return api.findTeamByName(team.name)
        .then(function (found) {
          if (found && found.team_id) {
            // 直接使用 findTeamByName 返回的 logo_url（/api/teams 包含 logo_url 字段）
            var logoUrl = found.logo_url || '';
            console.warn('[searchThenLiquipedia] findTeamByName norm=' + norm + ' team_id=' + found.team_id + ' logo_url=' + (logoUrl ? logoUrl.substring(0, 60) : '空'));
            if (logoUrl) {
              // 有 logo_url，走 enrichTeamLogo 处理（缓存 + CDN 优化）
              return sources.enrichTeamLogo({ id: found.team_id, name: team.name, logo: logoUrl })
                .then(function (r) {
                  if (r && r.logo) return { normName: norm, logo: r.logo, source: r.source };
                  // enrichTeamLogo 返回 null（罕见），检查 logoCache 兜底
                  var cached = logoCache.get(found.team_id);
                  if (cached && cached.logo) return { normName: norm, logo: cached.logo, source: cached.source };
                  return { normName: norm, logo: null, source: '' };
                });
            }
            // logo_url 为空，检查 logoCache 是否有历史缓存
            var cached = logoCache.get(found.team_id);
            if (cached && cached.logo) {
              console.warn('[searchThenLiquipedia] logoCache 命中 norm=' + norm + ' team_id=' + found.team_id);
              return { normName: norm, logo: cached.logo, source: cached.source };
            }
            console.warn('[searchThenLiquipedia] findTeamByName 无 logo_url norm=' + norm + ' team_id=' + found.team_id);
          } else {
            console.warn('[searchThenLiquipedia] findTeamByName 未找到 norm=' + norm + ' team.name=' + team.name);
          }
          return { normName: norm, logo: null, source: '' };
        })
        .catch(function (err) {
          console.warn('[searchThenLiquipedia] findTeamByName异常 norm=' + norm + ' err=' + (err && (err.message || err.errMsg || err)));
          return { normName: norm, logo: null, source: '' };
        });
    }
    const nameTasks = needQueryNames.map(function (norm) {
      return searchThenLiquipedia(norm, nameTeams[norm]);
    });

    // ★ 2026-09-01（P1-3）：快照合成结果与网络结果合并进同一管线
    //   （logoMap/nameLogoMap/_logoQueryCache/路径更新/负缓存全部复用既有逻辑）
    return Promise.all(tasks.concat(nameTasks)).then((results) => {
      if (snapResults.length) results = snapResults.concat(results);
      // 3) 构建 team_id → logo 映射 + 归一化队名 → logo 映射（仅保留有效 http URL）
      const logoMap = {};
      const nameLogoMap = {};  // 归一化队名 → { logo, source }（team_id=0 的 Liquipedia 赛程专用）
      const failedIds = [];
      // ★ 2026-08-11 关键修复：把查询结果缓存到页面级 _logoQueryCache，
      //   供 refreshMetadataDerived 重建 participantsList 时回填 logo（解决时序竞态）。
      //   根因：enrichTeamLogos 异步查询完成前，finalize 会触发 refreshMetadataDerived
      //   重建 participantsList（无 logo），之后 enrichTeamLogos 回填的 logo 会被下一次
      //   refresh 覆盖。把查询结果缓存后，无论 refresh 何时触发都能从缓存回填。
      if (!this._logoQueryCache) this._logoQueryCache = { byId: {}, byNormName: {} };
      results.forEach((r) => {
        if (r.normName) {
          // 名称兜底结果
          if (r.logo && /^https?:\/\//i.test(r.logo)) {
            nameLogoMap[r.normName] = { logo: r.logo, source: r.source };
            this._logoQueryCache.byNormName[r.normName] = { logo: r.logo, source: r.source };
          } else {
            failedIds.push('name:' + r.normName);
            // ★ 2026-08-04 优化：name 路径失败负缓存（30min），轮询不再反复 findTeamByName
            if (!this._logoFailNames) this._logoFailNames = {};
            this._logoFailNames[r.normName] = Date.now();
          }
        } else if (r.logo && /^https?:\/\//i.test(r.logo)) {
          logoMap[r.id] = { logo: r.logo, source: r.source };
          this._logoQueryCache.byId[r.id] = { logo: r.logo, source: r.source };
        } else {
          failedIds.push(r.id);
        }
      });
      // §8.3 诊断日志（2026-07-29）：汇总 logo 获取结果，便于定位缺失源
      const total = results.length;
      const ok = Object.keys(logoMap).length + Object.keys(nameLogoMap).length;
      if (!Object.keys(logoMap).length && !Object.keys(nameLogoMap).length) return false;

      // 4) 路径更新：仅更新当前可见的 series 头部 logo
      //    （不可见 series 不更新，避免无谓 setData；allSeries 内存缓存同步更新，
      //     loadMore 加载新页时 enrichTeamLogos 会从内存读取并路径更新）
      //    ★ team_id=0 的 Liquipedia 赛程对阵按归一化队名匹配 nameLogoMap
      const patch = {};
      const visible = this.data.series;
      visible.forEach((s, si) => {
        if (s.radiantTeamId && logoMap[s.radiantTeamId] &&
            (!s.radiantLogo || !/^https?:\/\//i.test(s.radiantLogo))) {
          patch['series[' + si + '].radiantLogo'] = logoMap[s.radiantTeamId].logo;
          patch['series[' + si + '].radiantLogoSource'] = logoMap[s.radiantTeamId].source;
        } else if ((!s.radiantTeamId || s.radiantTeamId <= 0) && s.radiantName) {
          const norm = normName(s.radiantName);
          if (nameLogoMap[norm] && (!s.radiantLogo || !/^https?:\/\//i.test(s.radiantLogo))) {
            patch['series[' + si + '].radiantLogo'] = nameLogoMap[norm].logo;
            patch['series[' + si + '].radiantLogoSource'] = nameLogoMap[norm].source;
          }
        }
        if (s.direTeamId && logoMap[s.direTeamId] &&
            (!s.direLogo || !/^https?:\/\//i.test(s.direLogo))) {
          patch['series[' + si + '].direLogo'] = logoMap[s.direTeamId].logo;
          patch['series[' + si + '].direLogoSource'] = logoMap[s.direTeamId].source;
        } else if ((!s.direTeamId || s.direTeamId <= 0) && s.direName) {
          const norm = normName(s.direName);
          if (nameLogoMap[norm] && (!s.direLogo || !/^https?:\/\//i.test(s.direLogo))) {
            patch['series[' + si + '].direLogo'] = nameLogoMap[norm].logo;
            patch['series[' + si + '].direLogoSource'] = nameLogoMap[norm].source;
          }
        }
      });

      // 5) 同步更新 allSeries 内存缓存（loadMore 加载新页时可直接用）
      this.allSeries.forEach((s) => {
        if (s.radiantTeamId && logoMap[s.radiantTeamId] &&
            (!s.radiantLogo || !/^https?:\/\//i.test(s.radiantLogo))) {
          s.radiantLogo = logoMap[s.radiantTeamId].logo;
          s.radiantLogoSource = logoMap[s.radiantTeamId].source;
        } else if ((!s.radiantTeamId || s.radiantTeamId <= 0) && s.radiantName) {
          const norm = normName(s.radiantName);
          if (nameLogoMap[norm] && (!s.radiantLogo || !/^https?:\/\//i.test(s.radiantLogo))) {
            s.radiantLogo = nameLogoMap[norm].logo;
            s.radiantLogoSource = nameLogoMap[norm].source;
          }
        }
        if (s.direTeamId && logoMap[s.direTeamId] &&
            (!s.direLogo || !/^https?:\/\//i.test(s.direLogo))) {
          s.direLogo = logoMap[s.direTeamId].logo;
          s.direLogoSource = logoMap[s.direTeamId].source;
        } else if ((!s.direTeamId || s.direTeamId <= 0) && s.direName) {
          const norm = normName(s.direName);
          if (nameLogoMap[norm] && (!s.direLogo || !/^https?:\/\//i.test(s.direLogo))) {
            s.direLogo = nameLogoMap[norm].logo;
            s.direLogoSource = nameLogoMap[norm].source;
          }
        }
      });

      // 6) 参赛队伍 Tab 的 participantsList logo 同步更新
      //    ★ 2026-08-11 修复：负 id 占位队伍按队名匹配 nameLogoMap（与 allSeries 的
      //    team_id=0 对阵共用同一名称兜底链路），正 id 走 logoMap。
      //    ★ 2026-08-11 二次修复：curation 队名与 Liquipedia 对阵队名可能不完全一致
      //    （如 "Aurora Gaming" vs "Aurora"），精确 normName 匹配会漏。加模糊匹配：
      //    去 esports/gaming/team 后缀 + 非字母数字后比较（和分支②的 normalize 一致）。
      const curParticipants = this.data.participantsList || [];
      // 预构建 nameLogoMap 的模糊索引（一次构建，多次匹配）
      let fuzzyNameKeys = null;
      if (Object.keys(nameLogoMap).length) {
        fuzzyNameKeys = Object.keys(nameLogoMap).map((k) => ({
          raw: k,
          fuzzy: k.replace(/(?:esports|eports?|gaming|team|dota)/gi, '').replace(/[^a-z0-9]/g, '')
        })).filter((it) => it.fuzzy.length >= 3);
      }
      const fuzzyMatch = function (name) {
        if (!fuzzyNameKeys) return null;
        const fuzzy = name.replace(/(?:esports|eports?|gaming|team|dota)/gi, '').replace(/[^a-z0-9]/g, '');
        if (!fuzzy || fuzzy.length < 3) return null;
        for (let i = 0; i < fuzzyNameKeys.length; i++) {
          const it = fuzzyNameKeys[i];
          if (it.fuzzy === fuzzy ||
              (it.fuzzy.length >= 3 && (it.fuzzy.indexOf(fuzzy) >= 0 || fuzzy.indexOf(it.fuzzy) >= 0))) {
            return nameLogoMap[it.raw];
          }
        }
        return null;
      };
      if (curParticipants.length) {
        let _matched = 0, _fuzzyHit = 0, _missed = 0;
        const patched = curParticipants.map((t) => {
          if (!t) return t;
          if (t.id > 0 && logoMap[t.id] && (!t.logo || !/^https?:\/\//i.test(t.logo))) {
            _matched++;
            return Object.assign({}, t, { logo: logoMap[t.id].logo });
          }
          // 负 id 或 id 缺失：按归一化队名匹配 nameLogoMap
          if ((!t.logo || !/^https?:\/\//i.test(t.logo)) && t.name) {
            const lcName = t.name.toLowerCase();
            const norm = normName(t.name);
            // ① 精确匹配
            if (norm && nameLogoMap[norm]) {
              _matched++;
              return Object.assign({}, t, { logo: nameLogoMap[norm].logo });
            }
            // ② 模糊匹配（去后缀 + 包含关系）
            const fuzzy = fuzzyMatch(lcName);
            if (fuzzy) {
              _fuzzyHit++;
              return Object.assign({}, t, { logo: fuzzy.logo });
            }
            _missed++;
          }
          return t;
        });
        const changed = patched.some((t, i) => t.logo !== curParticipants[i].logo);
        if (changed) patch.participantsList = patched;
      }

      if (Object.keys(patch).length) this.setData(patch);
      return true;
    });
  },

  // 参赛队伍 Tab 的 logo <image> 加载失败时回退到首字母圆
  // 路径更新 participantsList[idx].logo = ''，触发 wxml 走 wx:else 分支
  onParticipantLogoError(e) {
    const { idx } = e.currentTarget.dataset;
    if (idx == null) return;
    this.setData({
      ['participantsList[' + idx + '].logo']: ''
    });
  },

  // ★ 已结束对阵胜负标识（2026-07-29）：金色多层级强调，区别于全站 .win/.lose 阵营语义
  // 仅对「已结束」（phase==='recent'）应用；进行中/未开赛保持 groupSeries 原判定。
  // 产出 is-win / is-lose / is-draw 类（替代原有 win/lose，避免与天辉绿阵营色混淆），
  // 并暴露 seriesWinner(A/B/draw/''), seriesMissing(数据缺失), 供 WXML 渲染徽章/缺失态。
  decorateSeriesWinner(s) {
    if (s.phase !== 'recent') return s; // 非已结束：保持原样（live 当前领先者 / upcoming 无比分）
    const sa = Number(s.scoreA) || 0, sb = Number(s.scoreB) || 0;
    let winner = '';
    if (s.isDraw) winner = 'draw';
    else if (sa > sb) winner = 'A';
    else if (sb > sa) winner = 'B';
    // 数据缺失：已结束但双方比分均为 0，不强制标识胜负，仅显示「已结束」
    const missing = (sa === 0 && sb === 0);
    const sideCls = function (side) {
      if (missing) return '';
      if (winner === 'draw') return 'is-draw';
      return winner === side ? 'is-win' : 'is-lose';
    };
    return Object.assign({}, s, {
      seriesWinner: missing ? '' : winner,
      seriesMissing: missing,
      teamACls: sideCls('A'),
      teamBCls: sideCls('B'),
      scoreACls: sideCls('A'),
      scoreBCls: sideCls('B'),
      teamALogoCls: (!missing && winner === 'A') ? 'team-win' : '',
      teamBLogoCls: (!missing && winner === 'B') ? 'team-win' : ''
    });
  },

  fmt(m, anchor) {
    // 2026-07-28 修复小圆点颜色 BUG：新增 aWin/bWin 字段，表示该场 A 队/B 队是否赢。
    // A 队 = 系列赛首场的 radiant 方（anchor.teamAId）；B 队 = 首场的 dire 方。
    // 必须按 team_id 归属，不能直接用 radiant_win：
    //   ① BO3/BO5 换边：第 2/3 场 radiant 可能是 B 队，radiant_win=true 反而代表 B 队赢；
    //   ② 未结束：radiant_win=null，不应显示任何颜色（aWin/bWin 均为 false）；
    //   ③ 数据异常：team_id 缺失时回退到 radiant_win，与 groupSeries 的回退逻辑一致。
    const aId = anchor && anchor.teamAId > 0 ? anchor.teamAId : 0;
    const bId = anchor && anchor.teamBId > 0 ? anchor.teamBId : 0;
    let aWin = false, bWin = false;
    if (m.radiant_win === true || m.radiant_win === false) {
      const winnerId = m.radiant_win ? m.radiant_team_id : m.dire_team_id;
      if (aId > 0 && bId > 0 && winnerId > 0) {
        // 有有效锚点：按 team_id 归属
        if (winnerId === aId) aWin = true;
        else if (winnerId === bId) bWin = true;
      } else {
        // 无有效锚点：回退到按边归属（A=radiant, B=dire）
        if (m.radiant_win) aWin = true; else bWin = true;
      }
    }
    // 未结束（radiant_win=null）→ aWin/bWin 均为 false，WXML 显示灰色（未着色）
    return {
      match_id: m.match_id,
      // 队名兜底用 '天辉'/'夜魇'，与 groupSeries 保持一致，
      // 避免 enrichTeamNames 中 !m.radiantName 对空字符串和 '天辉' 行为不一致。
      radiantName: m.radiant_team_name || '天辉',
      direName: m.dire_team_name || '夜魇',
      radiantTeamId: m.radiant_team_id,
      direTeamId: m.dire_team_id,
      // 比分兜底 0，防止 null/undefined 在 wxml 算术运算中产生 NaN
      radiantScore: Number(m.radiant_score) || 0,
      direScore: Number(m.dire_score) || 0,
      radiantWin: m.radiant_win,
      // 小圆点颜色用 aWin/bWin（按 A/B 队归属），不用 radiantWin（按天辉/夜魇边）
      aWin: aWin,
      bWin: bWin,
      time: util.formatTime(m.start_time),
      duration: m.duration ? util.formatDuration(m.duration) : ''
    };
  },

  // 从比赛数据推导参赛队伍，并补充 metadata 中缺失的字段（状态/日期/参赛队数）。
  // 在 load() 和 finalize() 都会调用，保证无论网络源快慢最终状态一致。
  refreshMetadataDerived() {
    const meta = Object.assign({}, buildMetadataSkeleton(), this.data.metadata || {});
    const raw = this.allMatches || [];

    // 1) 参赛队伍列表：按 team_id 去重，优先用已有队名，占位名后续 enrichTeamNames 会回填
    const teamMap = {};
    raw.forEach((m) => {
      if (m.radiant_team_id != null) teamMap[m.radiant_team_id] = m.radiant_team_name || null;
      if (m.dire_team_id != null) teamMap[m.dire_team_id] = m.dire_team_name || null;
    });
    // 防 finalize 后调用覆盖 enrichTeamNames 的真实名：
    // 仅当 t.id 在 raw 中出现过（teamMap 已有该 key）时，才用 prev 的真名填补 raw 缺的 name。
    // "待定队伍 N"（id 为负，不在 teamMap 中）会被正确丢弃，避免混入真实参赛队列表。
    (this.data.participantsList || []).forEach((t) => {
      if (!t || t.id == null || !(t.id in teamMap)) return;
      if (!teamMap[t.id] && t.name && !/^Team \d+$/.test(t.name)) {
        teamMap[t.id] = t.name;
      }
    });
    // 占位兜底：仍无名的用 "Team {id}"，等 enrichTeamNames 回填
    Object.keys(teamMap).forEach((k) => { if (!teamMap[k]) teamMap[k] = 'Team ' + k; });
    // ★ 2026-09-01（v8.4 Fix-E）：同名多 id 去重 —— 同一战队跨届/重注册持有多个 team_id
    //   （实证：19944 Zero Tenacity 9600141/10208035、Team Syntax 10213108/10232570），
    //   按 team_id 去重会让同一队伍在参赛队伍列表出现两条（「相同数据重叠」）。
    //   按「归一化队名聚合 + 保留出场次数多的 id」丢弃重复条目。
    const _teamCount = {};
    raw.forEach((m) => {
      if (m && m.radiant_team_id != null) _teamCount[m.radiant_team_id] = (_teamCount[m.radiant_team_id] || 0) + 1;
      if (m && m.dire_team_id != null) _teamCount[m.dire_team_id] = (_teamCount[m.dire_team_id] || 0) + 1;
    });
    const _dropIds = sources.dropDuplicateNameIds(teamMap, _teamCount);
    if (_dropIds && _dropIds.length) {
      _dropIds.forEach((id) => { delete teamMap[id]; });
    }
    let participantsList = Object.keys(teamMap).map((id) => ({ id: Number(id), name: teamMap[id] }));

    // ===== 参赛队数一致性策略（2026-07-28 重构，修复 EWC 2026 显示 16 实际 24 的 BUG） =====
    // metadata.participants 来源：curation 硬编码 / Liquipedia 人工策展。
    // 实际参赛队数：从 OpenDota /leagues/{id}/matches 的 team_id 去重得到。
    // 两者不一致时的优先级（按可信度从高到低）：
    //   ① 实际 > meta  → curation 过时，以实际为准（覆盖 meta.participants，并告警）
    //   ② meta > 实际  → 赛事进行中尚有未登场队伍（常见于 BO3 小组赛未全部开打），
    //                    补「待定队伍 N」占位至 meta 一致（保留 2026-07-27 的 Roster 完成逻辑）
    //   ③ meta == 实际 → 一致，无需处理
    //   ④ 无比赛数据   → 仅用 meta 生成纯占位列表（保留旧行为）
    // 设计原则：硬编码 curation 永远不可信过实际比赛数据；占位仅用于"已知未登场"场景。
    // 2026-07-28：meta.participants 可能是数字（curation）或数组（Liquipedia parseParticipants）。
    //   - 数字：直接用作品数判定
    //   - 数组：用长度作 meta 参赛队数，数组本身保留供分支④兜底使用
    //   Liquipedia 数组优先于 curation 数字（mergeMetadataWithFallback 中 Object.assign 已覆盖）。
    //   2026-07-28 增强：curation 的 participants 也可为数组（含 name/region/group），
    //   当 Liquipedia 被 CAPTCHA 拦截时，curation 数组作为同等数据源参与重建。
    //   ★ 2026-08-11 修复回归：本函数末尾 L1946 会把数组 participants 转为数字写回
    //     this.data.metadata（KPI Strip 需要数字显示）。第二次 refresh 进入时读到的
    //     meta.participants 已是数字 → Array.isArray 失效 → 分支④走 else "待定队伍 N"。
    //     修复：每次 refresh 都重新从 curation 取一份原始数组作为兜底源，
    //     不依赖 this.data.metadata.participants 的类型保持。
    var curParticipantsArr = Array.isArray(meta.participants) ? meta.participants : null;
    if (!curParticipantsArr) {
      try {
        const cur = remoteCuration.curatedEventFor(this.data.name, { leagueId: this.data.leagueId, game: 'dota2' });
        if (cur && Array.isArray(cur.participants) && cur.participants.length) {
          curParticipantsArr = cur.participants;
        }
      } catch (e) { /* 隔离 */ }
    }
    const liqParticipantsArr = curParticipantsArr;
    const metaParticipants = liqParticipantsArr ? liqParticipantsArr.length : (Number(meta.participants) || 0);
    const actualCount = participantsList.length;

    // ★ 2026-09-01（v8.4 Fix-F）：策展数组优先重建 —— 一 ID 多届场景的参赛队「权威源」修正。
    //   根因（用户实测 EPL Masters II 显示 19 / 实际 16）：leagueid 19944 被 Masters I/II 两届复用，
    //   OpenDota /leagues/19944/matches 返回两届混合的 254 场比赛（Masters I 季后赛拖到 8/29 +
    //   Masters II 预选赛 8/24~29 + Masters II 正赛）。即使 filterMatchesByWindow 按 curation 判届
    //   窗口（8/13~9/12）过滤后仍剩 19 个 team_id：含 Masters I 残留（Nemiga/RE ARISE/Syntax）、
    //   Masters II 预选赛队（FTS/Summer Bear）、跨届同名双 id（Zero Tenacity 9600141/10208035）。
    //   原一致性策略分支①（actual 19 > meta 16 → 以实际为准覆盖 meta）误判 curation 过时，
    //   把 19 当权威 → 重复显示 + 错误显示。
    //   修复：curation/Liquipedia 提供了人工策展的 participants 数组（本赛事 16 队）时，
    //   它比「OpenDota 推导 team_id 集合」更权威（后者混入跨届杂质无法用时间窗干净切分）——
    //   只要 liqParticipantsArr 非空，一律以策展数组为基础重建 participantsList（关联真实
    //   team_id 保留跳转/统计），不再让推导的 actualCount 覆盖。数组为空时走旧分支①~④。
    if (liqParticipantsArr && liqParticipantsArr.length) {
      // —— 以策展数组为基础重建（复用 2026-07-28 分支②的匹配逻辑）——
      const nameToId = {};
      const normList = [];
      participantsList.forEach((t) => {
        if (!t || !t.name || t.id == null || t.id < 0) return;
        if (/^Team \d+$/.test(t.name)) return;
        nameToId[t.name.toLowerCase()] = t.id;
        normList.push({ name: t.name, id: t.id });
      });
      const normalize = function (s) {
        return (s || '').toLowerCase()
          .replace(/\s*(esports|eports?|gaming|team|dota)\s*/gi, '')
          .replace(/[^a-z0-9]/g, '');
      };
      const normIndexed = normList.map((it) => ({ norm: normalize(it.name), id: it.id, name: it.name }));
      participantsList = liqParticipantsArr.map((t, i) => {
        const liqName = (t && t.name) || '';
        const isTBD = !liqName || liqName === 'TBD';
        let matchedId = null;
        if (!isTBD) {
          matchedId = nameToId[liqName.toLowerCase()];
          if (matchedId == null) {
            const liqNorm = normalize(liqName);
            if (liqNorm) {
              for (let j = 0; j < normIndexed.length; j++) {
                const it = normIndexed[j];
                if (!it.norm) continue;
                if (it.norm === liqNorm ||
                    (it.norm.length >= 3 && (it.norm.indexOf(liqNorm) >= 0 || liqNorm.indexOf(it.norm) >= 0))) {
                  matchedId = it.id;
                  break;
                }
              }
            }
          }
        }
        return {
          id: matchedId != null ? matchedId : -1 - i,
          name: isTBD ? '待公布' : liqName,
          status: (t && t.status) || 'TBD',
          liquipediaSlug: (t && t.liquipediaSlug) || null,
          region: (t && t.region) || null,
          group: (t && t.group) || null
        };
      });
      // 策展数组为准 → meta 计数与列表长度对齐（KPI Strip 显示 16 而非 19）
      meta.participants = participantsList.length;
      // 诊断日志：捕获「策展重建后仍比 meta 少」的场景（策展数组覆盖不全时提示）
      if (typeof console !== 'undefined' && console.info) {
        console.info('[league-detail] 参赛队伍以策展数组为准重建：' + participantsList.length +
          ' 队（推导实际 ' + actualCount + '，含跨届/预选赛杂质被排除）');
      }
    } else if (actualCount > 0 && actualCount > metaParticipants && metaParticipants > 0) {
      // ① 实际 > meta（且 meta > 0）：curation/Liquipedia 过时，以实际为准
      // 2026-07-28：增加 metaParticipants > 0 守卫，避免 meta=0（Liquipedia 尚未返回）
      //   的加载中间态误报"curation 过时"。meta=0 时仅静默更新 meta.participants，
      //   不输出警告，等 finalize 后 Liquipedia 返回再做一致性校验。
      meta.participants = actualCount;
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[league-detail] 参赛队数实际 > metadata：curation 可能过时',
          'actual=' + actualCount, 'meta=' + metaParticipants,
          '— 已以实际数据为准更新 KPI');
      }
    } else if (actualCount > 0 && metaParticipants === 0) {
      // ①-bis meta=0：Liquipedia/curation 尚未加载，静默用实际数填充，不警告
      meta.participants = actualCount;
    } else if (metaParticipants > 0 && metaParticipants > actualCount) {
      // ② meta > 实际：赛事进行中尚有未登场队伍
      // 2026-07-28 修复 EPL Masters I BUG：Liquipedia 已公布 16 支队伍但比赛数据只有 7 支时，
      // 此前用「待定队伍 N」占位，丢失真实队名（如 Team Jenz / Level UP）。
      // 修复：Liquipedia 提供完整队伍列表时，以该列表为基础重建 participantsList，
      //   并通过队名匹配关联实际比赛数据中的 team_id（保留已参赛队伍的真实 id 用于跳转/统计）。
      //   未参赛队伍用负数占位 id，未公布队伍（TBD）显示「待公布」。
      if (liqParticipantsArr && liqParticipantsArr.length) {
        // 1) 构建实际队名(lower) -> team_id 映射（仅真实队名，排除 "Team {id}" 占位）
        const nameToId = {};
        const normList = [];
        participantsList.forEach((t) => {
          if (!t || !t.name || t.id == null || t.id < 0) return;
          if (/^Team \d+$/.test(t.name)) return;
          nameToId[t.name.toLowerCase()] = t.id;
          normList.push({ name: t.name, id: t.id });
        });
        // 2) 模糊匹配规范化：去 esports/gaming/team 等后缀 + 非字母数字字符
        const normalize = function (s) {
          return (s || '').toLowerCase()
            .replace(/\s*(esports|eports?|gaming|team|dota)\s*/gi, '')
            .replace(/[^a-z0-9]/g, '');
        };
        const normIndexed = normList.map((it) => ({ norm: normalize(it.name), id: it.id, name: it.name }));
        // 3) 以 Liquipedia 列表为基础重建，关联 team_id
        participantsList = liqParticipantsArr.map((t, i) => {
          const liqName = (t && t.name) || '';
          const isTBD = !liqName || liqName === 'TBD';
          let matchedId = null;
          if (!isTBD) {
            // 精确匹配（忽略大小写）
            matchedId = nameToId[liqName.toLowerCase()];
            // 模糊匹配（去后缀 + 包含关系）
            if (matchedId == null) {
              const liqNorm = normalize(liqName);
              if (liqNorm) {
                for (let j = 0; j < normIndexed.length; j++) {
                  const it = normIndexed[j];
                  if (!it.norm) continue;
                  if (it.norm === liqNorm ||
                      (it.norm.length >= 3 && (it.norm.indexOf(liqNorm) >= 0 || liqNorm.indexOf(it.norm) >= 0))) {
                    matchedId = it.id;
                    break;
                  }
                }
              }
            }
          }
          return {
            id: matchedId != null ? matchedId : -1 - i,
            name: isTBD ? '待公布' : liqName,
            status: (t && t.status) || 'TBD',
            liquipediaSlug: (t && t.liquipediaSlug) || null,
            // 2026-07-28 透传扩展字段：curation/Liquipedia 数据源可能提供 region/group 等信息，
            // 统一拷贝到 participantsList 供 WXML 渲染赛区标签与分组徽标。
            region: (t && t.region) || null,
            group: (t && t.group) || null
          };
        });
      } else {
        // 无 Liquipedia 列表（meta.participants 是数字，来自 curation 兜底）：
        // 保留原「待定队伍 N」占位逻辑，但不再输出 warn（这是预期场景）。
        // 2026-07-28：Liquipedia API 失败/限流时，mergeMetadataWithFallback 会用 curation
        //   的数字 participants 兜底（如 EPL Masters I = 16），此时分支②走此 else 分支，
        //   补占位是预期行为，不是 BUG。改为 console.log 避免海量 warn 污染控制台。
        const need = metaParticipants - actualCount;
        const existingIds = new Set(participantsList.map((t) => t && t.id));
        const fillers = [];
        for (let i = 0; i < need; i++) {
          const fakeId = -1 - i;
          if (!existingIds.has(fakeId)) {
            fillers.push({ id: fakeId, name: '待定队伍 ' + (i + 1) });
          }
        }
        if (fillers.length) {
          participantsList = participantsList.concat(fillers);
        }
      }
    } else if (metaParticipants > 0 && metaParticipants !== actualCount && actualCount === 0) {
      // ④ 无比赛数据：赛事未开赛场景
      // 2026-07-28 新增 Liquipedia 兜底：若 meta.participants 是数组（来自 Liquipedia
      //   getLeagueMetadata 的 parseParticipants 解析），优先使用已公布的参赛队伍，
      //   而非纯「待定队伍 N」占位。与 Liquipedia 公示保持一致。
      //   - 已公布的队伍（name !== 'TBD'）显示真实队名，id 用负数占位（无 OpenDota team_id）
      //   - 未公布的队伍（name === 'TBD'）仍显示「待公布」，区分已公布与未公布
      //   - 若 Liquipedia 无 participants 数据，回退到原纯占位逻辑
      // ★ 2026-08-11 修复回归：分支④必须用 liqParticipantsArr（从 curation 重新取的原始数组），
      //   而非 meta.participants（已被前次 refresh 转成数字）。否则第二次 refresh 会走 else 分支
      //   生成"待定队伍 N"，丢失真实队名。
      const liqParticipants = liqParticipantsArr;
      if (liqParticipants && liqParticipants.length) {
        participantsList = liqParticipants.map((t, i) => ({
          id: -1 - i,
          name: (t.name && t.name !== 'TBD') ? t.name : '待公布',
          status: t.status || 'TBD',
          liquipediaSlug: t.liquipediaSlug || null,
          region: t.region || null,
          group: t.group || null
        }));
        // 更新 meta.participants 为实际解析到的队伍数
        meta.participants = participantsList.length;
      } else {
        participantsList = Array.from({ length: metaParticipants }, (_, i) => ({ id: -1 - i, name: '待定队伍 ' + (i + 1) }));
      }
    }

    // 2) 用统一赛事窗口补齐 metadata（与列表页 leagues.js loadLeagueEntry 完全一致）
    // 优先级（与列表页完全一致）：
    //   - status：eventWindow.statusText（已用 mixed + cur.status 覆盖计算）
    //   - 赛期：eventWindow.start/end（已优先 curation 宽窗口，回退真实比赛窗口）
    // 数据校验：eventWindow 存在时直接覆盖 meta 的 status/startDate/endDate，
    //   保证 KPI Strip 与头部徽标完全一致；eventWindow 为 null（无 curation 也无真实比赛）
    //   时保留 mergeMetadataWithFallback 注入的 Liquipedia/curation 兜底值，避免 KPI 空白。
    // 2026-07-28 修复：此前详情页仅用真实比赛窗口覆盖 meta，导致：
    //   ① KPI 赛期（真实窗口 7/15-7/25）与列表页赛期（curation 宽窗口 7/6-8/23）不一致；
    //   ② 状态评定缺少 curation 路径②，DOTA2 比赛已结束但赛事仍在进行时误判为「已结束」。
    const ew = this.data.eventWindow;
    if (ew) {
      meta.status = ew.statusText;
      meta.startDate = util.formatTime(ew.start);
      meta.endDate = util.formatTime(ew.end);
    }
    // 3) 参赛队数兜底：若 meta.participants 仍为空（curation/Liquipedia 均无数据），
    //    用实际比赛数据推导的参赛队数填入。
    //    注意：实际 > meta 的覆盖已在上方「参赛队数一致性策略①」处理，
    //    这里仅处理 meta 为空的边缘场景，避免重复赋值。
    if ((meta.participants == null || meta.participants === '') && participantsList.length) {
      meta.participants = participantsList.length;
    }
    // 2026-07-28：归一化 participants 为数字（KPI Strip 显示用）。
    //   meta.participants 可能是数组（Liquipedia parseParticipants）或数字（curation/推导）。
    //   WXML 直接显示 metadata.participants，若为数组会渲染为 [object Object]。
    //   保留 liqParticipantsArr 供分支④兜底使用，最终 setData 前统一转为数字。
    if (Array.isArray(meta.participants)) {
      meta.participants = meta.participants.length;
    }

    // 2026-07-29 修复 logo 丢失 BUG：refreshMetadataDerived 重建 participantsList 时
    // 丢失了 enrichTeamLogos 已填充的 logo 字段（竞态：finalize 后重建覆盖 logo）。
    // 修复：从 this.data.participantsList 构建 id→logo 映射，重建后统一回填。
    // 覆盖所有重建分支（①实际>meta / ②Liquipedia重建 / ②占位补齐 / ④无比赛数据）。
    // ★ 2026-08-11 关键修复：叠加从 _logoQueryCache（enrichTeamLogos 查询结果缓存）
    //   兜底回填，解决 enrichTeamLogos 异步查询未完成时 finalize 触发 refresh 导致
    //   logo 丢失的时序竞态。
    const oldLogoMap = {};
    (this.data.participantsList || []).forEach((t) => {
      if (t && t.id != null && t.logo && /^https?:\/\//i.test(t.logo)) {
        oldLogoMap[t.id] = t.logo;
      }
    });
    // ★ 2026-08-11 新增：从查询结果缓存补充 oldLogoMap（按 id 和 归一化队名两路）
    const queryCache = this._logoQueryCache || { byId: {}, byNormName: {} };
    const normForCache = function (s) { return String(s || '').toLowerCase().replace(/\s+/g, ''); };
    participantsList.forEach((t) => {
      if (!t || t.logo) return;
      // 按 id 查缓存
      if (t.id != null && queryCache.byId[t.id]) {
        oldLogoMap[t.id] = queryCache.byId[t.id].logo;
        return;
      }
      // 按归一化队名查缓存（精确）
      if (t.name) {
        const norm = normForCache(t.name);
        if (norm && queryCache.byNormName[norm]) {
          oldLogoMap['$name:' + norm] = queryCache.byNormName[norm].logo;
        }
      }
    });
    // ★ 2026-08-11 诊断日志（定位 logo 不显示根因）
    const _beforeCount = Object.keys(oldLogoMap).length;
    const _newIds = participantsList.map((t) => t && t.id).filter((x) => x != null);
    // 回填：优先按 id 匹配，id 未命中时按归一化队名匹配（含模糊匹配）
    let fuzzyNameKeysRefresh = null;
    if (Object.keys(queryCache.byNormName).length) {
      fuzzyNameKeysRefresh = Object.keys(queryCache.byNormName).map((k) => ({
        raw: k,
        fuzzy: k.replace(/(?:esports|eports?|gaming|team|dota)/gi, '').replace(/[^a-z0-9]/g, '')
      })).filter((it) => it.fuzzy.length >= 3);
    }
    participantsList = participantsList.map((t) => {
      if (!t || (t.logo && /^https?:\/\//i.test(t.logo))) return t;
      // ① 按 id
      if (t.id != null && oldLogoMap[t.id]) {
        return Object.assign({}, t, { logo: oldLogoMap[t.id] });
      }
      // ② 按归一化队名（精确）
      if (t.name) {
        const norm = normForCache(t.name);
        if (norm && oldLogoMap['$name:' + norm]) {
          return Object.assign({}, t, { logo: oldLogoMap['$name:' + norm] });
        }
        // ③ 按归一化队名（模糊）
        if (norm && fuzzyNameKeysRefresh) {
          const fuzzy = norm.replace(/(?:esports|eports?|gaming|team|dota)/gi, '').replace(/[^a-z0-9]/g, '');
          if (fuzzy && fuzzy.length >= 3) {
            for (let i = 0; i < fuzzyNameKeysRefresh.length; i++) {
              const it = fuzzyNameKeysRefresh[i];
              if (it.fuzzy === fuzzy ||
                  (it.fuzzy.length >= 3 && (it.fuzzy.indexOf(fuzzy) >= 0 || fuzzy.indexOf(it.fuzzy) >= 0))) {
                return Object.assign({}, t, { logo: queryCache.byNormName[it.raw].logo });
              }
            }
          }
        }
      }
      return t;
    });

    this.setData({ metadata: meta, participantsList: participantsList });
  },

  slicePage(reset) {
    const pageSize = this.data.pageSize;
    const page = reset ? 0 : this.data.page;
    const slice = this.allSeries.slice(0, (page + 1) * pageSize);
    this.setData({ series: slice, page: page, hasMore: this.allSeries.length > slice.length });
  },

  appendPage() {
    const page = this.data.page + 1;
    const pageSize = this.data.pageSize;
    const slice = this.allSeries.slice(0, (page + 1) * pageSize);
    // O-14（2026-08-15）：路径式 patch —— 只追加新页的 series 项，不重传已渲染部分。
    // 旧实现全量 setData({ series: slice })，数据量随页码线性增长，后续页触底时传输量变大。
    const patch = { page: page, hasMore: this.allSeries.length > slice.length };
    const start = this.data.page * pageSize;  // 已渲染的起始偏移（slice 基于 page 累进）
    for (let i = start; i < slice.length; i++) {
      patch['series[' + i + ']'] = slice[i];
    }
    this.setData(patch, () => {
      // ★ 新页加载后补全可见 series 的 logo（allSeries 内存已有则路径更新直接命中）
      this.enrichTeamLogos();
    });
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) this.appendPage();
  },

  toggleFollow() {
    // ★ 2026-08-11 方案 A+R1：兼容 legacyFakeId 的关注切换。
    //   场景：老用户用 fakeId 关注过，重定向到真实 id 后真实 id 无记录但 fakeId 有。
    //   取消关注时必须同时清除两个 key，否则关注列表会出现两条记录或无法取消。
    const lid = this.data.leagueId;
    const legacyFake = this.data._legacyFakeId;
    const wasFollowed = this.data.followed;
    let nowFollowed;
    if (wasFollowed) {
      // 用户意图：取消关注。清除真实 id 记录（若存在）+ legacyFake 记录（若存在）
      follow.unfollow('leagues', lid);
      if (legacyFake != null) follow.unfollow('leagues', String(legacyFake));
      nowFollowed = false;
    } else {
      // 用户意图：关注。写入真实 id 记录
      follow.follow('leagues', { id: lid, name: this.data.name });
      nowFollowed = true;
    }
    this.setData({ followed: nowFollowed });
    wx.showToast({ title: nowFollowed ? '已关注' : '已取消关注', icon: 'none' });
    // ★ 2026-08-07（R2 预登录前置，手势红线）：关注联赛触发订阅授权——缓存命中才同步弹，
    //   未命中 toast 引导 + 后台补登录（绝不在网络回调后弹授权，会被微信手势校验拒绝）
    if (nowFollowed) {
      if (auth.isLoggedIn()) {
        subscribe.requestSubscribe();
      } else {
        wx.showToast({ title: '正在登录…请稍后重试', icon: 'none' });
        auth.ensureLogin().catch(() => {});
      }
    }
  },

  openTeam(e) {
    const id = e.currentTarget.dataset.id;
    // 2026-07-28：id < 0 是待公布/占位队伍（无 OpenDota team_id），不跳转
    if (!id || id < 0) return;
    wx.navigateTo({ url: '/subpackages/detail/team-detail/team-detail?teamId=' + id });
  },

  // 复制 Liquipedia 赛事页链接（小程序 web-view 需业务域名白名单，故采用复制兜底）
  openLiquipedia(e) {
    const slug = e.currentTarget.dataset.slug;
    if (!slug) return;
    const url = 'https://liquipedia.net/dota2/' + encodeURIComponent(slug);
    wx.setClipboardData({ data: url, success: () => wx.showToast({ title: '链接已复制', icon: 'none' }) });
  },

  // ===== 两 Tab 切换（C 风格） =====
  switchTab(e) {
    const key = e.currentTarget.dataset.key;
    if (key === this.data.tab) return;
    this.setData({ tab: key, expandedGame: '' });
    // 懒加载赛事排名
    if (key === 'standings' && !this.data.standingsLoaded) {
      this.loadStandings();
    }
    // P3（2026-08-31）：懒加载 Liquipedia 小组积分/淘汰赛对阵（与 OpenDota 聚合排名互补）
    if (key === 'standings' && !this.data.lpStructureLoaded && !this.data.lpStructureLoading) {
      this.loadStructure();
    }
  },

  // P3：拉取 Liquipedia 结构页（小组积分 + 淘汰赛对阵），失败静默（排名 Tab 仍有 OpenDota 聚合）
  loadStructure() {
    this.setData({ lpStructureLoading: true });
    liquipedia.getLeagueStructure(this.data.name).then((structure) => {
      const groups = (structure && structure.groups) || [];
      const brackets = (structure && structure.brackets) || [];
      // 淘汰赛 match 预格式化时间（formatTime → 'YYYY-MM-DD'，UTC 口径与赛程页一致）
      brackets.forEach((b) => {
        (b.rounds || []).forEach((r) => {
          (r.matches || []).forEach((m) => {
            m.timeLabel = m.startTime ? util.formatTime(m.startTime) : '';
            m.hasScore = (m.score1 > 0 || m.score2 > 0 || m.finished);
          });
        });
      });
      this.setData({
        lpGroups: groups,
        lpBrackets: brackets,
        lpStructureLoading: false,
        lpStructureLoaded: true
      });
    }).catch(() => {
      this.setData({ lpStructureLoading: false, lpStructureLoaded: true });
    });
  },

  // Tab 2: 赛事排名（按已结束比赛聚合队伍胜负）
  loadStandings() {
    this.setData({ standingsLoading: true });
    sources.getLeagueStandings(this.data.leagueId).then((list) => {
      const standings = list || [];
      // 队名补全：OpenDota /api/matches 返回的 radiant_team_name / dire_team_name
      // 可能为空，导致 getLeagueStandings 回退为 "Team {id}" 占位符。
      // 收集所有占位名称的 team_id，一次 explorer SQL 批量查 teams.name 回填（与 enrichTeamNames 同模式）。
      const need = {};
      standings.forEach((row) => {
        if (row.name && /^Team \d+$/.test(row.name) && row.team_id) {
          need[row.team_id] = true;
        }
      });
      const ids = Object.keys(need).filter((x) => x !== 'null' && x !== '');
      if (ids.length) {
        api.getTeamNames(ids).then((nameMap) => {
          const patched = standings.map((row) => {
            if (row.team_id != null && nameMap[row.team_id]) {
              return Object.assign({}, row, { name: nameMap[row.team_id], tag: (nameMap[row.team_id] || '').slice(0, 4).toUpperCase() });
            }
            return row;
          });
          this.setData({ standings: patched, standingsLoading: false, standingsLoaded: true });
        }).catch(() => {
          this.setData({ standings: standings, standingsLoading: false, standingsLoaded: true });
        });
      } else {
        this.setData({ standings: standings, standingsLoading: false, standingsLoaded: true });
      }
    }).catch(() => {
      this.setData({ standingsLoading: false, standingsLoaded: true });
    });
  },

  // ===== 三段式：已结束段折叠/展开（2026-07-28 新增） =====
  // 点击 RECENT 分隔符切换折叠态。折叠时隐藏 RECENT 段所有 series-card，
  // 让用户聚焦 LIVE/UPCOMING。展开时恢复显示。
  // 注意：仅切换 recentCollapsed 布尔，不重建 series 数组（wxml 用 wx:if 控制可见性）
  toggleRecentCollapse() {
    this.setData({ recentCollapsed: !this.data.recentCollapsed });
  },

  // ★ v3 优化项21：远期赛程折叠/展开
  toggleFarFuture() {
    this.setData({ showFarFuture: !this.data.showFarFuture });
  },

  // ===== A 风格就地展开小场英雄阵容（双索引 seriesIdx-gameIdx） =====
  toggleGame(e) {
    const idx = e.currentTarget.dataset.idx;  // "si-gi" 格式
    if (this.data.expandedGame === idx) {
      this.setData({ expandedGame: '' });
      return;
    }
    this.setData({ expandedGame: idx });
    const parts = idx.split('-');
    const si = Number(parts[0]);
    const gi = Number(parts[1]);
    const s = this.data.series[si];
    if (!s) return;
    const m = s.games[gi];
    if (!m || m.detail) return;
    const path = 'series[' + si + '].games[' + gi + ']';
    this.setData({ [path + '.loadingDetail']: true });

    // 并行取比赛详情 + 英雄库（英雄库已内存缓存，二次调用零网络）。
    // 注意：OpenDota /matches/{id} 的 player 仅含 hero_id（数字），不含 hero 对象，
    // 故头像 URL 必须靠 hero_id → 英雄内部名（antimage/luna）映射，再拼 Steam CDN。
    const detailP = api.getMatch(m.match_id);
    const heroesP = heroes.getHeroes().catch(() => []);
    Promise.all([detailP, heroesP]).then((res) => {
      const detail = res[0];
      const heroList = res[1] || [];
      if (!detail || !detail.players) {
        this.setData({ [path + '.loadingDetail']: false, [path + '.detail']: null });
        return;
      }
      // id -> 内部名（拼 CDN 头像 URL）
      // 注意：OpenDota /heroes 的 name 带 npc_dota_hero_ 前缀（如 npc_dota_hero_antimage），
      // Steam CDN 路径不需要此前缀（只需 antimage），故需 strip。
      const NPC_PREFIX = 'npc_dota_hero_';
      const internalMap = {};
      heroList.forEach((h) => {
        if (h && h.id != null) {
          let n = h.name || '';
          if (n.indexOf(NPC_PREFIX) === 0) n = n.slice(NPC_PREFIX.length);
          internalMap[h.id] = n;
        }
      });
      const heroMap = (getApp().globalData && getApp().globalData.heroMap) || {};
      const radiantHeroes = [];
      const direHeroes = [];
      let mvp = null;
      let mvpScore = -1;
      detail.players.forEach((p) => {
        const isRadiant = (p.isRadiant != null) ? p.isRadiant : (p.player_slot < 128);
        const kda = p.deaths > 0 ? (p.kills + p.assists) / p.deaths : (p.kills + p.assists);
        const heroName = heroMap[p.hero_id] || ('H' + p.hero_id);
        // Steam CDN 英雄头像：hero_id → 内部名（已 strip npc_dota_hero_ 前缀，如 antimage/luna）
        const heroInternalName = internalMap[p.hero_id] || '';
        const heroImg = heroInternalName
          ? (HERO_IMG_BASE + encodeURIComponent(heroInternalName) + '_sb.png')
          : '';
        const item = {
          hero_id: p.hero_id,
          name: heroName,
          short: (heroName || '?').slice(0, 4),
          img: heroImg,
          kda: (p.kills || 0) + '/' + (p.deaths || 0) + '/' + (p.assists || 0),
          kdaScore: Math.round(kda * 100) / 100,
          gpm: p.gold_per_min || 0,
          playerName: p.name || p.personaname || ''
        };
        if (isRadiant) radiantHeroes.push(item);
        else direHeroes.push(item);
        const score = kda * 2 + (p.gold_per_min || 0) / 100;
        if (score > mvpScore) {
          mvpScore = score;
          mvp = {
            name: item.playerName,
            kda: item.kda,
            kdaScore: item.kdaScore,
            gpm: item.gpm,
            hero: item.name
          };
        }
      });
      // 路径更新：仅设置该小场的 detail
      this.setData({
        [path + '.loadingDetail']: false,
        [path + '.detail']: { radiantHeroes: radiantHeroes, direHeroes: direHeroes, mvp: mvp }
      });
    }).catch(() => {
      this.setData({ [path + '.loadingDetail']: false, [path + '.detail']: null });
    });
  },

  // 跳转战报二级页（B 风格 match-detail）
  openMatch(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: '/subpackages/detail/match-detail/match-detail?matchId=' + id });
  }
});

