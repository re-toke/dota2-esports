// 图片预热（P2-E）
// 在 enrich 解析完成后，用 wx.preDownloadFile 把已解析的 logo 预下载进微信文件缓存，
// 使下次进入相关页面 / 切换到其他含该队的页面时直接命中缓存、零等待。
//
// 依赖（均门控，默认不触发）：
// - config.images.proxyBase 已填（预热才有意义：代理域已是单一 downloadFile 白名单域）
// - config.images.predownloadEnabled === true
// - 运行环境支持 wx.preDownloadFile（低版本基础库无此 API，特性检测）
// 任一不满足则本模块整体 no-op，绝不抛错或阻塞主流程。

const config = require('./config');

function warmLogos(urls) {
  if (!urls || !urls.length) return;
  const images = (config && config.images) || {};
  if (!images.predownloadEnabled || !images.proxyBase) return; // 门控：P0 未落地不预热
  if (typeof wx === 'undefined' || typeof wx.preDownloadFile !== 'function') return; // 特性检测

  const max = images.predownloadMax || 20;
  const list = urls.filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u)).slice(0, max);

  list.forEach((url) => {
    try {
      wx.preDownloadFile({
        url: url,
        success: () => {},
        fail: () => {} // 预热失败不致命，静默忽略
      });
    } catch (e) { /* 极端情况下 API 抛同步异常也隔离 */ }
  });
}

module.exports = { warmLogos };
