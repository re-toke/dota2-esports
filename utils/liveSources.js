// utils/liveSources.js
// F1 直播聚合入口（P0，轻量实现，不集成直播 SDK）。
// 仅聚合主流平台 DOTA2 直播间的「搜索深链」，点击后复制链接或跳转平台小程序，
// 规避版权风险与 SDK 接入成本。数据源：B站 / 虎牙 / 斗鱼。
//
// 设计要点：
//   - 不自建直播流，不抓流，纯聚合第三方公开搜索页（合规）。
//   - 优先 wx.navigateToMiniProgram 跳转平台小程序（需在微信开放平台关联并填 appId）；
//     未配置 appId 时降级为「复制链接 + Toast」，无需配置业务域名，零门槛可用。

const PLATFORMS = [
  {
    key: 'bilibili',
    name: '哔哩哔哩',
    color: '#FB7299',
    // B站小程序 appId（可选，留空走复制链接）；如需启用请在微信开放平台关联后填入
    miniApp: null,
    webUrl: function (kw) {
      return 'https://search.bilibili.com/all?keyword=' + encodeURIComponent(kw || 'DOTA2');
    }
  },
  {
    key: 'huya',
    name: '虎牙直播',
    color: '#FFA600',
    miniApp: null,
    webUrl: function (kw) {
      return 'https://www.huya.com/search?search=' + encodeURIComponent(kw || 'DOTA2');
    }
  },
  {
    key: 'douyu',
    name: '斗鱼直播',
    color: '#FF5B00',
    miniApp: null,
    webUrl: function (kw) {
      return 'https://www.douyu.com/search/?kw=' + encodeURIComponent(kw || 'DOTA2');
    }
  }
];

// 根据赛事名生成各平台搜索链接（keyword 默认 DOTA2）
function buildSources(eventName) {
  const kw = eventName || 'DOTA2';
  return PLATFORMS.map(function (p) {
    return {
      key: p.key,
      name: p.name,
      color: p.color,
      url: typeof p.webUrl === 'function' ? p.webUrl(kw) : p.webUrl,
      miniApp: p.miniApp || null
    };
  });
}

// 点击处理：优先跳转平台小程序，否则复制链接
// source 可为 { url, miniApp } 或纯 url 字符串
function openSource(source) {
  const url = typeof source === 'string' ? source : (source && source.url);
  const miniApp = (typeof source === 'object' && source) ? source.miniApp : null;
  if (miniApp && miniApp.appId) {
    wx.navigateToMiniProgram({
      appId: miniApp.appId,
      path: miniApp.path || '',
      fail: function () { fallbackCopy(url); }
    });
    return;
  }
  fallbackCopy(url);
}

function fallbackCopy(url) {
  if (!url) return;
  wx.setClipboardData({
    data: url,
    success: function () {
      wx.showToast({ title: '直播链接已复制，去浏览器打开', icon: 'none' });
    }
  });
}

module.exports = { PLATFORMS: PLATFORMS, buildSources: buildSources, openSource: openSource };
