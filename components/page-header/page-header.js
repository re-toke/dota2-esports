/**
 * components/page-header/page-header.js
 *
 * 2026-10-30（Batch C · C5「统一页头」）：
 * 首页 / 赛事 / 资料库此前各写一份 brand-header，战队页缺失页头。
 * 抽成本组件，样式复用 app.wxss 的 .brand-* 全局类（addGlobalClass）。
 */
Component({
  options: { addGlobalClass: true },
  properties: {
    title: { type: String, value: 'DOTA2赛事' },
    sub: { type: String, value: '' },
    small: { type: Boolean, value: false },
    logo: { type: String, value: '/assets/brand-logo.png' }
  }
});
