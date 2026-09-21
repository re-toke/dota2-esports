// utils/logoLocal.js
// ============================================================================
// 队标「本地化」：用 wx.downloadFile 落地为本地文件再渲染，绕开两个真机问题
//
// ## 为什么需要它（2026-09-21 实测）
// 快照里 **89% 的队标** 来自 `cdn.steamusercontent.com`（UGC），该域实测：
//   · 可用率 96%（24/25，中位 253ms）——**服务端没问题**；
//   · 但响应头是 **`Content-Type: application/octet-stream`**（字节确是合法 PNG）。
// 社区多篇一致记录：小程序 `<image>` 遇到**非图片 MIME 的二进制流**时，
// 真机/首次加载会**偶发不显示**（建议后端改 MIME 或前端改用 downloadFile 落地）。
// ★ 本项目此前 **0 处 wx.downloadFile**（`logoCache.js` 只是 id→URL 映射缓存，不落地文件）
//   → 没有任何机制绕过它。
//
// ## 做法
//   `wx.downloadFile` **不判 MIME**，成功后拿到本地路径 → `<image src="本地路径">` 稳定可渲染；
//   同时把文件**持久化**到 `USER_DATA_PATH`，二次加载**零网络**（顺带治「队标加载慢」）。
//
// ## 使用约定（重要）
//   · `cachedPath(url)`  —— **同步**快查：已持久化则返回本地路径，否则 ''（用于首帧直出）
//   · `fetchToLocal(url)` —— **异步**兜底：仅在原生渲染失败（binderror）后调用
//   设计上**只在失败后下载**：占 11% 的 cloudflare 队标（`image/png`）本来就正常，
//   不该为它们多付一次 downloadFile（首页一屏可达 20~30 张图）。
//
// ## 可靠性
//   所有 wx API 调用都包在 try/catch 内，任何异常均返回 ''/false 或 resolve('')，
//   由调用方退回原始远程 URL —— **失败即降级，不影响原有行为**。
// ============================================================================

const DIR_NAME = 'team-logos';
// 容量上限：USER_DATA_PATH 总配额 10MB，单图约 2–57KB；取 200 张（≈6MB 上限）留足余量
const MAX_FILES = 200;
// 同一 URL 的并发下载去重（首页同一支队可能在多张卡片同时出现）
const inflight = Object.create(null);

let _fs = null;
function fs() {
  if (!_fs) _fs = wx.getFileSystemManager();
  return _fs;
}
function baseDir() {
  try { return wx.env && wx.env.USER_DATA_PATH ? wx.env.USER_DATA_PATH + '/' + DIR_NAME : ''; }
  catch (e) { return ''; }
}
function isRemote(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}
/** FNV-1a 32bit → 定长文件名（小程序无 crypto，需稳定哈希；同 URL 必得同名） */
function hash32(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16);
}
function pathOf(url) {
  const d = baseDir();
  return d ? d + '/' + hash32(url) + '.png' : '';
}
function ensureDir() {
  const d = baseDir();
  if (!d) return false;
  try { fs().mkdirSync(d, true); return true; }
  catch (e) {
    // 已存在时 mkdirSync 会抛 → 用 accessSync 复核
    try { fs().accessSync(d); return true; } catch (e2) { return false; }
  }
}

/** 同步快查：已持久化 → 返回本地路径；否则 ''（不抛错） */
function cachedPath(url) {
  if (!isRemote(url)) return '';
  const p = pathOf(url);
  if (!p) return '';
  try { fs().accessSync(p); return p; } catch (e) { return ''; }
}

/** 容量裁剪：超过 MAX_FILES 时按 mtime 删除最旧的一批（静默，失败不影响主流程） */
function pruneIfNeeded() {
  const d = baseDir();
  if (!d) return;
  try {
    const names = fs().readdirSync(d) || [];
    if (names.length <= MAX_FILES) return;
    const files = names.map(function (n) {
      let mtime = 0;
      try { mtime = fs().statSync(d + '/' + n).mtime || 0; } catch (e) { /* 忽略 */ }
      return { n: n, mtime: mtime };
    }).sort(function (a, b) { return a.mtime - b.mtime; });
    const drop = files.slice(0, files.length - MAX_FILES);
    drop.forEach(function (f) {
      try { fs().unlinkSync(d + '/' + f.n); } catch (e) { /* 忽略 */ }
    });
    console.log('[logoLocal] 容量裁剪：删除 ' + drop.length + ' 张（保留 ' + MAX_FILES + '）');
  } catch (e) { /* 静默 */ }
}

/**
 * 异步：downloadFile → 落地到 USER_DATA_PATH → resolve(本地路径)。
 * 任何失败（含 404 / 非 2xx / 文件系统失败）→ resolve('')，调用方退回远程 URL。
 * 同一 URL 并发调用会复用同一次下载。
 */
function fetchToLocal(url) {
  if (!isRemote(url)) return Promise.resolve('');
  if (inflight[url]) return inflight[url];      // 同 URL 去重

  const p = pathOf(url);
  if (!p) return Promise.resolve('');

  inflight[url] = new Promise(function (resolve) {
    wx.downloadFile({
      url: url,
      timeout: 15000,
      success: function (res) {
        if (!res || res.statusCode !== 200 || !res.tempFilePath) {
          console.warn('[logoLocal] downloadFile 非 200: ' + (res && res.statusCode) + ' ' + url.slice(0, 60));
          resolve('');
          return;
        }
        // 落地持久化；失败则退回临时文件（当次会话仍可渲染）
        try {
          if (ensureDir()) {
            fs().saveFileSync(res.tempFilePath, p);
            pruneIfNeeded();
            resolve(p);
            return;
          }
        } catch (e) {
          console.warn('[logoLocal] 落地失败，改用临时文件: ' + (e && e.message));
        }
        resolve(res.tempFilePath || '');
      },
      fail: function (err) {
        console.warn('[logoLocal] downloadFile 失败: ' + ((err && err.errMsg) || '') + ' ' + url.slice(0, 60));
        resolve('');
      }
    });
  }).then(function (r) {
    delete inflight[url];
    return r;
  });

  return inflight[url];
}

module.exports = {
  cachedPath: cachedPath,
  fetchToLocal: fetchToLocal,
  // 仅供测试/诊断
  _hash32: hash32,
  _MAX_FILES: MAX_FILES
};
