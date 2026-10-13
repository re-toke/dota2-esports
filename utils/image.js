// 图片 CDN 缩略图优化
// 仅对「已知支持 query 尺寸缩放」的 CDN 追加 ?w=&h= 参数，避免未知 CDN 因未知 query 返回 404。
// 说明：OpenDota 的 cdn.opendota.com 官方支持按尺寸裁剪；STRATZ / Steam CDN 缩放行为未经验证，
// 故暂不纳入白名单，待确认后扩展，避免破坏既有图片加载。

const SAFE_HOSTS = ['cdn.opendota.com', 'opendota.com'];
const config = require('./config');

// ★ 2026-09-01（v8.5 Fix-G）：Logo URL 规范化 —— 修复详情页参赛队伍/即将开始对局队标加载失败。
//   根因（用户实测 EPL Masters II 队标不显示）：微信 downloadFile 合法域名白名单仅配了
//   cdn.cloudflare.steamstatic.com，但 OpenDota /teams 与快照返回的 logo_url 主要落在：
//     ① cdn.steamusercontent.com   （UGC，340/429 占比 79%，URL 有效但微信未加白名单 → 拦截）
//     ② steamcdn-a.akamaihd.net    （team_logos 静态图，47/429 占 11%，可收敛到 cloudflare 镜像）
//     ③ steamusercontent-a.akamaihd.net（41/429 占 10%，实测 100% 404 —— 死域，应剔除）
//     ④ cloud-3.steamusercontent.com   （http:// 非 https，微信强制 https 必挂）
//   修复：统一在 toLogoUrl 出口规范化：
//     - http:// → https://（微信强制 https）
//     - steamcdn-a.akamaihd.net → cdn.cloudflare.steamstatic.com（已白名单，实测 100% 同文件镜像）
//     - steamusercontent-a.akamaihd.net / cloud-3.steamusercontent.com → 空串（死数据剔除，
//       image-fallback 组件对空 src 展示首字母占位，不再尝试加载必然失败的 URL）
//   ⚠️ 微信侧待办（用户操作）：downloadFile 白名单补 https://cdn.steamusercontent.com（UGC 主力，
//      cloudflare 不镜像 /ugc/ 路径，代码无法替代），否则 UGC 队标仍被拦截。
//
// ★★ P1-22（2026-10-13）：**`avatars.steamstatic.com` 被国内网络 RST** ⇒ 选手/队员头像加载失败
//   （真机日志 10+ 条 `downloadFile:fail -101:net::ERR_CONNECTION_RESET ... avatars.steamstatic.com/<hash>`）。
//   实测（2026-10-13，本机国内网络，与真机同网络）：
//     · `avatars.steamstatic.com/fef49e..._full.jpg`        → **RST（连不通）** ❌
//     · `avatars.akamai.steamstatic.com/fef49e..._full.jpg` → **200 / 3409B** ✅ **同一张图**
//       （Steam 官方 Akamai 镜像域；路径结构相同，host 级替换即可，与上面 ② 的 cloudflare 收敛同构）
//     · `cdn.cloudflare.steamstatic.com`（队标主力）→ 200 ✅ 不受影响
//     · `cdn.steamusercontent.com`（UGC 队标）→ 404（**可达，非被墙**；仅差微信白名单）
//   ⇒ 修复：把 `avatars.steamstatic.com` 收敛到其 Akamai 镜像（**只改 host、路径不变**）。
//   ⚠️ 与 ② 的唯一差别（诚实声明）：`steamcdn-a` 那条当年做过"100% 同文件"的逐条比对；
//      本条因**原域取不到（被 RST）无法逐字节比对**，依据是「Steam 官方镜像域 + 路径同构 + 单例 200」。
//   ⚠️ 微信侧待办（用户操作）：downloadFile 白名单需补 **`https://avatars.akamai.steamstatic.com`**，
//      否则替换后的 URL 仍会被微信拦截（与本文件其它镜像域同等要求）。
const DEAD_HOSTS = ['steamusercontent-a.akamaihd.net', 'cloud-3.steamusercontent.com'];
const MIRROR_HOST_MAP = {
  'steamcdn-a.akamaihd.net': 'cdn.cloudflare.steamstatic.com',
  // ★ P1-22：被 RST ⇒ 收敛到可达的 Akamai 镜像（host 在 URL 中唯一出现，直接字面替换）
  'avatars.steamstatic.com': 'avatars.akamai.steamstatic.com'
};

function normalizeLogoUrl(url) {
  if (!url || typeof url !== 'string') return '';
  let u = url.trim();
  // 1) 强制 https（微信 image 组件不支持 http）
  if (/^http:\/\//i.test(u)) u = 'https://' + u.slice(7);
  if (!/^https?:\/\//i.test(u)) return '';
  const m = u.match(/^https?:\/\/([^/]+)/i);
  if (!m) return '';
  const host = m[1].toLowerCase();
  // 2) 死域剔除（URL 必然加载失败，不留占位机会）
  if (DEAD_HOSTS.indexOf(host) >= 0) return '';
  // 3) 白名单镜像收敛（steamcdn-a → cloudflare，已白名单且 100% 同文件）
  //    host 在 URL 中唯一出现，直接用 host 做替换（协议/路径不受影响）
  if (MIRROR_HOST_MAP[host]) {
    u = u.replace(host, MIRROR_HOST_MAP[host]);
  }
  return u;
}

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
// 先 normalizeLogoUrl（域名收敛/协议/死域剔除），再 optimizeImageUrl（OpenDota CDN 尺寸缩放）。
function toLogoUrl(url, size) {
  const n = normalizeLogoUrl(url);
  if (!n) return n;
  return optimizeImageUrl(n, size);
}

module.exports = { optimizeImageUrl, toLogoUrl, normalizeLogoUrl, SAFE_HOSTS };
