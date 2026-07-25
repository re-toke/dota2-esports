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
    this.load();
  },

  load() {
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

    this.setData({ list: out });
  },

  onSearch(e) {
    this.setData({ keyword: e.detail.value || '' });
    this.applyFilter();
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

  onRetry() {
    this.load();
  }
});
