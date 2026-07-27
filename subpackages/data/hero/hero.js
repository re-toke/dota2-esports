// subpackages/data/hero/hero.js
// 英雄列表：搜索 + 主属性/攻击类型筛选 + 排序（默认/登场率/胜率）。全部数据一次性加载（约 124 个）。
const heroes = require('../../../utils/heroes.js');

const ATTRS = [
  { key: 'all', label: '全部' },
  { key: 'str', label: '力量' },
  { key: 'agi', label: '敏捷' },
  { key: 'int', label: '智力' },
  { key: 'uni', label: '全能' }
];
const ATTACKS = [
  { key: 'all', label: '全部' },
  { key: 'Melee', label: '近战' },
  { key: 'Ranged', label: '远程' }
];
const SORTS = [
  { key: 'default', label: '默认' },
  { key: 'pick', label: '登场率' },
  { key: 'win', label: '胜率' }
];

Page({
  data: {
    loading: true,
    error: '',
    keyword: '',
    attrFilter: 'all',
    attackFilter: 'all',
    sort: 'default',
    all: [],          // 全量
    list: [],         // 筛选后
    attrChips: ATTRS,
    attackChips: ATTACKS,
    sortChips: SORTS
  },

  onLoad() {
    this._avatarFailed = new Set();   // 记录头像加载失败的英雄 id（仅回退该英雄，不影响其它）
    this._pendingFails = [];
    this._failsScheduled = false;
    this.load();
  },

  load() {
    // 重试时重置头像失败标记，允许重新尝试加载（源数据 _all / 缓存中的 avatar 始终保留，不污染）
    this._avatarFailed = new Set();
    this._pendingFails = [];
    this._failsScheduled = false;
    this.setData({ loading: true, error: '' });
    heroes.getHeroes()
      .then((list) => {
        this._all = list;
        this.setData({ all: list, loading: false });
        this.applyFilter();
      })
      .catch(() => {
        this.setData({ loading: false, error: '英雄数据加载失败，请检查网络或域名配置' });
      });
  },

  applyFilter() {
    const all = this._all || [];
    const kw = (this.data.keyword || '').trim().toLowerCase();
    const af = this.data.attrFilter;
    const tf = this.data.attackFilter;
    const sort = this.data.sort;

    let out = all.filter((h) => {
      if (af !== 'all' && h.primaryAttr !== af) return false;
      if (tf !== 'all' && h.attackType !== tf) return false;
      if (kw) {
        const hay = (h.localizedName + ' ' + (h.name || '')).toLowerCase();
        if (hay.indexOf(kw) === -1) return false;
      }
      return true;
    });

    if (sort === 'pick') out = out.slice().sort((a, b) => b.proPick - a.proPick);
    else if (sort === 'win') out = out.slice().sort((a, b) => b.winRate - a.winRate);

    // 浅拷贝每一项，使「单头像失败兜底」只改 list 副本、不污染 _all / 缓存；
    // 已失败过的英雄沿用 _avatarFailed 标记，重建列表后仍显示首字母占位。
    const list = out.map((h) => {
      const c = Object.assign({}, h);
      if (this._avatarFailed && this._avatarFailed.has(h.id)) c.avatar = '';
      return c;
    });
    this.setData({ list });
  },

  onSearch(e) {
    const kw = e.detail.value || '';
    this.setData({ keyword: kw });
    // 优化：300ms 防抖，避免逐字触发全量过滤（约 124 个英雄 filter + sort + 浅拷贝）
    if (this._searchTimer) { clearTimeout(this._searchTimer); this._searchTimer = null; }
    this._searchTimer = setTimeout(() => {
      this._searchTimer = null;
      this.applyFilter();
    }, 300);
  },

  onAttr(e) {
    this.setData({ attrFilter: e.currentTarget.dataset.key });
    this.applyFilter();
  },

  onAttack(e) {
    this.setData({ attackFilter: e.currentTarget.dataset.key });
    this.applyFilter();
  },

  onSort(e) {
    this.setData({ sort: e.currentTarget.dataset.key });
    this.applyFilter();
  },

  openHero(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: '/subpackages/data/hero-detail/hero-detail?id=' + id });
  },

  // 头像加载失败兜底（两阶段、逐张、幂等、批量）：
  // 1) 第一次失败若当前 src 是 _full.png，自动切到 _lg.png 重试（兼容 Valve 用 _lg 命名的英雄，如 Dawnbreaker 破晓辰星）；
  // 2) _lg 重试仍失败（或非 _full 后缀）才回退到首字母占位（仅那张，绝不波及已正常显示的头像）；
  // 同一 tick 内的多次失败合并为一次 setData，避免 setData 风暴；
  // 不修改源数据（_all / 缓存），重试时可重新尝试加载。
  onAvatarError(e) {
    const id = e.currentTarget.dataset.id;
    if (id == null) return;
    if (!this._avatarFailed) this._avatarFailed = new Set();
    // 已彻底失败（avatar=''）的英雄忽略；同一 tick 内重复入队也忽略
    if (this._avatarFailed.has(id) || this._pendingFails.indexOf(id) >= 0) return;
    this._pendingFails.push(id);
    if (this._failsScheduled) return;
    this._failsScheduled = true;
    wx.nextTick(() => this._flushAvatarFails());
  },

  _flushAvatarFails() {
    this._failsScheduled = false;
    if (!this._pendingFails.length) return;
    const ids = this._pendingFails;
    this._pendingFails = [];
    const list = this.data.list || [];
    const updates = {};
    ids.forEach((id) => {
      const idx = list.findIndex((h) => h.id === id);
      if (idx < 0) return;
      const cur = list[idx].avatar;
      if (cur && cur.endsWith('_full.png')) {
        // 第一次失败：切到 _lg.png 重试（兼容 Valve 用 _lg 命名而无 _full 的英雄，如 Dawnbreaker 破晓辰星）
        updates['list[' + idx + '].avatar'] = cur.replace(/_full\.png$/, '_lg.png');
      } else {
        // 已重试过（当前是 _lg）或本就空：彻底回退到首字母占位，并标记为失败
        updates['list[' + idx + '].avatar'] = '';
        this._avatarFailed.add(id);
      }
    });
    if (Object.keys(updates).length) this.setData(updates);
  },

  onRetry() {
    this.load();
  }
});
