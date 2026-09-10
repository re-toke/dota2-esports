// pages/privacy/privacy.js
// 隐私协议页：微信小程序审核要求所有小程序声明隐私协议，
// 即使不使用隐私 API（本小程序未使用 getUserInfo/getLocation 等敏感 API）。

Page({
  data: {
    // ★ 2026-09-10 v2.1.0（提审前合规修正）：原 v2.0.0 三处表述与实际行为不符——
    //   ① 误称「第三方 API 均由小程序直接发起（不经过自有服务器）」：实际 cloudProxy/
    //      supabase 均启用，请求经微信云函数 / Supabase EF 代理；
    //   ② 误称 OpenID「开启赛前通知时」才获取：实际 app.js onLaunch 即 ensureLogin；
    //   ③ 误称关注列表仅在赛前通知后上传：实际关注页操作即上传（follow.js syncProfile）。
    //   另补 haglund.dev 数据源。修正后须同步后台「用户隐私保护指引」文案（须字节一致）。
    version: '2.1.0',
    updatedAt: '2026-09-10'
  },

  onShareAppMessage() {
    return { title: 'DOTA2赛事 · 隐私协议', path: '/subpackages/detail/privacy/privacy' };
  }
});
