// utils/subscribe.js
// 微信订阅消息脚手架。关注某对象时可申请一次订阅消息授权，用于后续赛事/战报提醒。
//
// 使用前提：在微信公众平台「功能 → 订阅消息」申请一个模板，把模板 id 填入 config.subscribeTemplateId。
// 未配置模板时，本函数直接跳过（不影响本地关注），避免无模板导致授权弹窗报错。

const config = require('./config.js');

function requestSubscribe() {
  return new Promise((resolve) => {
    if (!config.subscribeTemplateId) {
      resolve('skipped');
      return;
    }
    wx.requestSubscribeMessage({
      tmplIds: [config.subscribeTemplateId],
      success: () => resolve('ok'),
      fail: () => resolve('fail')
    });
  });
}

module.exports = { requestSubscribe: requestSubscribe };
