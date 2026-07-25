// subpackages/data/item/item.js
// 物品列表：搜索 + 按价格排序（默认/由低到高/由高到低）+ 仅看配方。
const items = require('../../../utils/items.js');

const SORTS = [
  { key: 'default', label: '默认' },
  { key: 'asc', label: '价低→高' },
  { key: 'desc', label: '价高→低' }
];

Page({
  data: {
    loading: true,
    error: '',
    keyword: '',
    sort: 'default',
    recipeOnly: false,
    all: [],
    list: [],
    sortChips: SORTS
  },

  onLoad() {
    this.load();
  },

  load() {
    this.setData({ loading: true, error: '' });
    items.getItems()
      .then((list) => {
        this._all = list;
        this.setData({ all: list, loading: false });
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
    const recipeOnly = this.data.recipeOnly;

    let out = all.filter((it) => {
      if (recipeOnly && !it.recipe) return false;
      if (kw) {
        const hay = (it.localizedName + ' ' + (it.name || '')).toLowerCase();
        if (hay.indexOf(kw) === -1) return false;
      }
      return true;
    });

    if (sort === 'asc') out = out.slice().sort((a, b) => a.cost - b.cost);
    else if (sort === 'desc') out = out.slice().sort((a, b) => b.cost - a.cost);

    this.setData({ list: out });
  },

  onSearch(e) {
    this.setData({ keyword: e.detail.value || '' });
    this.applyFilter();
  },

  onSort(e) {
    this.setData({ sort: e.currentTarget.dataset.key });
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
