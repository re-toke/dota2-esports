// pages/search/search.js
// 5.2 全局搜索：跨 赛事 / 战队 / 选手 / 物品 分组结果。
// 赛事与物品走本地缓存（api.getLeagues / api.getItems）即时过滤；
// 战队走 OpenDota /search（api.searchTeams，已本地缓存 5min）。
const api = require('../../utils/api.js');
const config = require('../../utils/config.js');
const cloudCache = require('../../utils/cloudCache.js');
const teamSearch = require('../../utils/teamSearch.js');
const sources = require('../../utils/sources.js');

Page({
  data: {
    keyword: '',
    searched: false,          // 是否已发起过搜索（用于区分初始态/无结果态）
    loading: false,
    leagues: [],
    teams: [],
    items: [],
    total: 0,
    error: '',                // 搜索失败时的错误提示（区分"真无结果"与"网络失败"）
    baseLoadError: '',        // 预载基础数据失败的提示
    // ===== B-3 命令面板：快捷入口 =====
    hotTerms: ['TI2026', 'ESL', 'Major', 'LGD', '幻影刺客', '蓝杖'],
    history: []               // 最近搜索词（本地存储）
  },

  onLoad() {
    // 预载赛事与物品到内存：均为长缓存，首搜即可本地过滤（无网络等待）
    // 修复 P0：预载失败不再静默吞错，设置 baseLoadError 让用户可重试
    this._loadingBase = true;
    this._searchReqId = 0;    // 搜索请求 ID（防竞态）
    Promise.all([
      api.getLeagues(),
      api.getItems()
    ]).then(([leagues, itemsMap]) => {
      this.leagues = leagues || [];
      this.itemsMap = itemsMap || {};
      this._loadingBase = false;
      this.setData({ baseLoadError: '' });
    }).catch((err) => {
      this._loadingBase = false;
      console.warn('[search] 预载基础数据失败:', err && err.message);
      this.setData({ baseLoadError: '基础数据加载失败，赛事/物品搜索可能不可用' });
      // 兜底：用空数据让搜索不至于完全不可用（战队搜索仍可工作）
      this.leagues = [];
      this.itemsMap = {};
    });
    // #23 → 5.2：优先用云端搜索索引（联赛有限集，落库缓存，降 OpenDota 限流）。
    // 云端 miss 时 buildSearchIndex 现场构建一次（6h 内复用）；失败静默忽略，本地赛事列表兜底。
    cloudCache.getSearchIndex().then((idx) => {
      if (idx && idx.leagues && idx.leagues.length) {
        this.leagues = idx.leagues.map((l) => ({ leagueid: l.id, name: l.name }));
      } else {
        cloudCache.buildSearchIndex().catch((e) => {
          console.warn('[search] 云端索引构建失败:', e && e.message);
        });
      }
    }).catch((e) => {
      console.warn('[search] 云端索引获取失败:', e && e.message);
    });
    // B-3：读取最近搜索历史
    try { this.setData({ history: wx.getStorageSync('search_history') || [] }); } catch (e) {}
  },

  onShow() {
    // 用户进入搜索页（很可能要搜物品/英雄）时，在 wifi 下预加载 data 分包
    // 移动网络下不预加载，避免消耗用户流量
    if (wx.preloadSubpackage) {
      wx.getNetworkType({
        success(res) {
          if (res.networkType === 'wifi') {
            wx.preloadSubpackage({ name: 'data', success() {}, fail() {} });
          }
        }
      });
    }
  },

  onSearch(e) {
    const kw = (e.detail.value || '').trim();
    this.setData({ keyword: kw });
    if (this._timer) clearTimeout(this._timer);
    if (!kw) {
      this.setData({ searched: false, leagues: [], teams: [], items: [], total: 0, loading: false, error: '' });
      return;
    }
    // P2 优化：最小长度限制（中文 1 字符可放宽，英文/数字 ≥2）
    // 避免单字符触发大量噪声请求，浪费 OpenDota 配额
    if (kw.length < 2 && !/[\u4e00-\u9fa5]/.test(kw)) {
      this.setData({ searched: false, leagues: [], teams: [], items: [], total: 0, loading: false, error: '' });
      return;
    }
    this._timer = setTimeout(() => this.doSearch(kw), 300);
  },

  doSearch(kw) {
    const k = kw.toLowerCase();
    this.pushHistory(kw);
    // P1 优化：请求 ID 防竞态，过期请求结果丢弃，避免慢响应覆盖快响应
    const reqId = ++this._searchReqId;
    this.setData({ loading: true, searched: true, error: '' });

    // 本地即时过滤：赛事（匹配同时覆盖原始名与 curation 规范名；展示名走规范名）
    const leagues = (this.leagues || [])
      .filter((l) => {
        const raw = (l.name || '').toLowerCase();
        const canon = sources.leagueDisplayName(l).toLowerCase();
        return raw.indexOf(k) >= 0 || canon.indexOf(k) >= 0;
      })
      .slice(0, 20)
      .map((l) => { const dn = sources.leagueDisplayName(l); return { id: l.leagueid, name: dn || ('赛事 ' + l.leagueid), displayName: dn }; });

    // 本地即时过滤：物品（按中文 dname / 内部名）
    const items = [];
    const map = this.itemsMap || {};
    Object.keys(map).forEach((id) => {
      const it = map[id];
      const dn = (it.dname || '').toLowerCase();
      const nm = (it.name || '').toLowerCase();
      if (dn.indexOf(k) >= 0 || nm.indexOf(k) >= 0) {
        items.push({ id: id, name: it.dname || it.name || id, img: it.img || '' });
      }
    });
    items.sort((a, b) => a.name.localeCompare(b.name));
    if (items.length > 30) items.length = 30;

    // 网络搜索：战队（OpenDota /search，已缓存）。
    // 修复 P0：区分"真无结果"与"网络失败"——失败时设置 error 状态，本地兜底仍可展示
    Promise.all([
      api.searchTeams(kw).catch((err) => {
        console.warn('[search] 战队搜索失败:', kw, err && err.message);
        return { __error: true, err: err };
      }),
      teamSearch.matchLocalTeams(kw, 20),
      cloudCache.getTeamsIndex().catch(() => null)
    ]).then(([teamsRes, local, cloudIdx]) => {
      // 防竞态：过期请求结果丢弃
      if (reqId !== this._searchReqId) return;

      // 区分失败与空结果：teamsRes.__error 表示 OpenDota 请求失败
      const openDotaFailed = !!(teamsRes && teamsRes.__error);
      const teams = openDotaFailed ? [] : (teamsRes || []);

      const seen = {};
      const all = [];
      // ① OpenDota 主源（含实时数据）
      teams.forEach((t) => {
        const id = t.team_id;
        if (id == null || seen[id]) return;
        seen[id] = true;
        all.push({ id: id, name: t.name, tag: (t.name || '').slice(0, 3).toUpperCase(), navigable: true });
      });
      // ② 本地 curation 兜底（零网络、离线可用）
      (local || []).forEach((t) => {
        if (seen[t.id]) return;
        seen[t.id] = true;
        all.push({ id: t.id, name: t.name, tag: t.tag, navigable: t.navigable !== false });
      });
      // ③ 云端历史 S 级语料（覆盖 OpenDota /search 漏掉的队）
      const cloudTeams = (cloudIdx && cloudIdx.teams) || [];
      cloudTeams.forEach((t) => {
        if (seen[t.id]) return;
        seen[t.id] = true;
        all.push({ id: t.id, name: t.name, tag: t.tag, navigable: t.navigable !== false });
      });

      const total = leagues.length + all.length + items.length;
      // 仅当 OpenDota 失败且本地兜底也无结果时，才显示错误提示
      const error = (openDotaFailed && all.length === 0) ? '战队搜索失败，请检查网络后重试' : '';
      this.setData({
        leagues: leagues,
        teams: all,
        items: items,
        total: total,
        loading: false,
        error: error
      });
    });
  },

  // 结果点击：按类型路由到对应详情页
  openResult(e) {
    const t = e.currentTarget.dataset.type;
    const id = e.currentTarget.dataset.id;
    const navigable = e.currentTarget.dataset.navigable;
    if (t === 'team') {
      // 历史战队占位（负数 id / navigable:false）：仅可见、无正确详情页，不跳转。
      if (navigable === false || !id || Number(id) <= 0) {
        wx.showToast({ title: '该历史战队资料暂未收录', icon: 'none' });
        return;
      }
      wx.navigateTo({ url: '/subpackages/detail/team-detail/team-detail?teamId=' + id });
      return;
    }
    if (!id) return;
    let url = '';
    if (t === 'league') url = '/subpackages/detail/league-detail/league-detail?leagueId=' + id + '&name=' + encodeURIComponent(e.currentTarget.dataset.name || '');
    else if (t === 'item') url = '/subpackages/data/item-detail/item-detail?id=' + id;
    if (url) wx.navigateTo({ url: url });
  },

  // ===== B-3 命令面板：快捷入口与历史 =====
  onQuickTap(e) {
    this.runKeyword(e.currentTarget.dataset.kw);
  },
  runKeyword(kw) {
    kw = (kw || '').trim();
    if (!kw) return;
    this.setData({ keyword: kw });
    this.doSearch(kw);
  },
  pushHistory(kw) {
    kw = (kw || '').trim();
    if (!kw) return;
    let h = (this.data.history || []).filter((x) => x !== kw);
    h.unshift(kw);
    if (h.length > 8) h = h.slice(0, 8);
    this.setData({ history: h });
    try { wx.setStorageSync('search_history', h); } catch (e) {}
  },
  clearHistory() {
    this.setData({ history: [] });
    try { wx.removeStorageSync('search_history'); } catch (e) {}
  },

  clearSearch() {
    this.setData({ keyword: '', searched: false, leagues: [], teams: [], items: [], total: 0, loading: false });
  }
});
