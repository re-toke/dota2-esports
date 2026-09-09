// pages/privacy/privacy.js
// 隐私协议页：微信小程序审核要求所有小程序声明隐私协议，
// 即使不使用隐私 API（本小程序未使用 getUserInfo/getLocation 等敏感 API）。

Page({
  data: {
    version: '2.0.0',
    updatedAt: '2026-09-09'
  },

  onShareAppMessage() {
    return { title: 'DOTA2赛事 · 隐私协议', path: '/subpackages/detail/privacy/privacy' };
  }
});
