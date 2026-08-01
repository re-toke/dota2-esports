// subpackages/data/item/item.js
// 物品列表：搜索 + 分类(全部/常规/配方/中立) + 价格排序（默认/由低到高/由高到低）。
const items = require('../../../utils/items.js');
const config = require('../../../utils/config.js');   // P2-A：分页 pageSize（5 列表页既有惯例）

const SORTS = [
  { key: 'default', label: '默认' },
  { key: 'asc', label: '价低→高' },
  { key: 'desc', label: '价高→低' }
];

const CATS = [
  { key: 'all', label: '全部' },
  { key: 'basic', label: '常规' },
  { key: 'recipe', label: '配方' },
  { key: 'neutral', label: '中立' }
];

Page({
  data: {
    loading: true,
    error: '',
    keyword: '',
    sort: 'default',
    category: 'all',
    recipeOnly: false,
    all: [],          // 保留字段声明（结构兼容），不再承载全量数据（P2-A）
    list: [],
    sortChips: SORTS,
    catChips: CATS
    // ★P2-A：分页游标/标志用实例属性（_page/_hasMore），data 结构零变化
  },

  onReachBottom() {
    if (this._hasMore && !this.data.loading) this.appendPage();
  },

  onHide() { this._clearSearchTimer(); },
  onUnload() { this._clearSearchTimer(); },

  _clearSearchTimer() {
    if (this._searchTimer) { clearTimeout(this._searchTimer); this._searchTimer = null; }
  },

  onLoad() {
    this.load();
  },

  load() {
    this.setData({ loading: true, error: '' });
    items.getItems()
      .then((list) => {
        this._all = list;
        this.setData({ loading: false });   // ★P2-A：不再下发全量 all（wxml 不渲染）
        this.applyFilter();
      })
      .catch(() => {
        this.setData({ loading: false, error: '物品数据加载失败，请检查网络或域名配置' });
      });
  },

  applyFilter() {
    const all = this._all || [];
    const kw = (this.data.keyword || '').trim().toLowerCase();
    const sort = this.data.sort;
    const category = this.data.category;
    const recipeOnly = this.data.recipeOnly;

    let out = all.filter((it) => {
      // 分类筛选
      if (category === 'basic' && it.category !== 'basic') return false;
      if (category === 'neutral' && it.category !== 'neutral') return false;
      if (category === 'recipe' && !it.recipe) return false;
      // 仅看配方（与分类「配方」等价，保留以兼容旧交互）
      if (recipeOnly && !it.recipe) return false;
      // 关键词：中文名 + 英文名均可搜
      if (kw) {
        const hay = ((it.name || '') + ' ' + (it.nameEn || '')).toLowerCase();
        if (hay.indexOf(kw) === -1) return false;
      }
      return true;
    });

    // 排序：以金币价(cost)为主键；但中立装备在 Dota2 中无法购买、cost 恒为 0，
    // 若仅按 cost 排序所有中立项比较值均为 0 → 数组顺序不变（即「排序无效果」）。
    // 故以层级(tier)作为兜底主键：商店物品仍按价格排序，中立分类则退化为按第1~5级排序，
    // 这对玩家是有意义的序（高级中立 > 低级中立），不会再有「点了没反应」的错觉。
    if (sort === 'asc') out = out.slice().sort((a, b) => (a.cost - b.cost) || ((a.tier || 0) - (b.tier || 0)));
    else if (sort === 'desc') out = out.slice().sort((a, b) => (b.cost - a.cost) || ((b.tier || 0) - (a.tier || 0)));

    // ★P2-A 分页：全量过滤结果存内存，页面只渲染当前页（修复 500+ 条一次渲染）
    this._page = 0;                        // 筛选/排序/搜索变化 → 回到第一页
    this._filteredAll = out;
    const pageSize = config.pageSize;
    const slice = out.slice(0, pageSize);
    this._hasMore = out.length > slice.length;
    this.setData({ list: slice });
  },

  appendPage() {
    const pageSize = config.pageSize;
    const all = this._filteredAll || [];
    this._page = (this._page || 0) + 1;
    const slice = all.slice(0, (this._page + 1) * pageSize);
    this._hasMore = all.length > slice.length;
    this.setData({ list: slice });
  },

  onSearch(e) {
    const kw = e.detail.value || '';
    this.setData({ keyword: kw });
    // 优化：300ms 防抖，避免逐字触发全量过滤（物品列表 filter + sort）
    if (this._searchTimer) { clearTimeout(this._searchTimer); this._searchTimer = null; }
    this._searchTimer = setTimeout(() => {
      this._searchTimer = null;
      this.applyFilter();
    }, 300);
  },

  onSort(e) {
    this.setData({ sort: e.currentTarget.dataset.key });
    this.applyFilter();
  },

  onCategory(e) {
    this.setData({ category: e.currentTarget.dataset.key });
    this.applyFilter();
  },

  onRecipeToggle() {
    this.setData({ recipeOnly: !this.data.recipeOnly });
    this.applyFilter();
  },

  openItem(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: '/subpackages/data/item-detail/item-detail?id=' + id });
  },

  onRetry() {
    this.load();
  }
});
