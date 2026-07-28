// 图片 CDN 缩略图优化
// 仅对「已知支持 query 尺寸缩放」的 CDN 追加 ?w=&h= 参数，避免未知 CDN 因未知 query 返回 404。
// 说明：OpenDota 的 cdn.opendota.com 官方支持按尺寸裁剪；STRATZ / Steam CDN 缩放行为未经验证，
// 故暂不纳入白名单，待确认后扩展，避免破坏既有图片加载。

const SAFE_HOSTS = ['cdn.opendota.com', 'opendota.com'];
const config = require('./config');

// 对支持的 CDN 追加方形缩略图参数；不支持或已带尺寸则原样返回。
function optimizeImageUrl(url, size) {
  if (!url || typeof url !== 'string') return url;
  const m = url.match(/^https?:\/\/([^/]+)\//i);
  if (!m) return url;
  const host = m[1].toLowerCase();
  if (!SAFE_HOSTS.includes(host)) return url;
  // 已带尺寸参数则跳过，避免重复
  if (/[?&](w|h)=/i.test(url)) return url;
  const s = size || 128;
  const sep = url.indexOf('?') >= 0 ? '&' : '?';
  return url + sep + 'w=' + s + '&h=' + s;
}

// 统一出口：业务侧一律调用 toLogoUrl 获取最终展示 URL。
// - 若 config.images.proxyBase 已配置（P0 图片层落地），所有 URL 统一改写为代理地址，
//   由图片层负责回源、按 proxyWidth 裁剪、转 WebP、长缓存（根治 LOGO 加载慢）。
// - 若未配置，则回退 optimizeImageUrl（仅 OpenDota 直连缩放），与原行为完全一致（零回归）。
function toLogoUrl(url, size) {
  if (!url || typeof url !== 'string') return url;
  const images = (config && config.images) || {};
  const base = images.proxyBase || '';
  if (base) {
    const w = images.proxyWidth || 160;
    const sep = base.indexOf('?') >= 0 ? '&' : '?';
    return base + sep + 'u=' + encodeURIComponent(url) + '&w=' + w + '&fmt=webp';
  }
  return optimizeImageUrl(url, size);
}

module.exports = { optimizeImageUrl, toLogoUrl, SAFE_HOSTS };
