// 通用图片占位/容错组件
// 解决原生 <image> 在「URL 存在但加载失败」时不显示兜底占位的问题。
// 统一处理三种状态：无图 / 加载中 / 加载失败，均展示品牌色首字母占位。
//
// ★★ 2026-09-21 新增「本地化兜底」（见 utils/logoLocal.js）：
//   实测快照中 **89% 的队标** 来自 cdn.steamusercontent.com（UGC），其响应头是
//   `Content-Type: application/octet-stream`（字节其实是合法 PNG），而社区多篇一致记录
//   小程序 <image> 遇「非图片 MIME 的二进制流」时真机/首次加载会**偶发不显示**；
//   本项目此前无任何 downloadFile 兜底 → 现补上：
//     · 首帧：该 URL 若已持久化过本地文件 → 直接渲染本地路径（零网络）；
//     · 原生加载失败 → 走 wx.downloadFile 落地为本地文件再重渲染（绕开 MIME 判定），
//       并持久化到 USER_DATA_PATH → **二次加载零网络**（顺带治「队标加载慢」）。
//   设计上**只在失败后下载**：占 11% 的 cloudflare 队标（image/png）本来就正常，
//   不为它们多付一次 downloadFile（首页一屏可达 20~30 张图）。
const logoLocal = require('../../utils/logoLocal.js');

Component({
  options: {
    // 允许页面样式类穿透，便于外部控制尺寸/圆角
    addGlobalClass: true
  },
  properties: {
    // 图片地址；空字符串视为无图，直接展示占位
    src: { type: String, value: '' },
    // 占位文字（通常是队标缩写或姓名首字母）
    placeholder: { type: String, value: '?' },
    // 裁剪模式
    mode: { type: String, value: 'aspectFill' },
    // 是否圆形（头像）；父容器已是圆形时也可不传
    round: { type: Boolean, value: false }
  },
  data: {
    failed: false,
    loaded: false,
    // 实际渲染地址：本地文件（优先）或原始远程 URL。
    // wxml 中写作 `{{useSrc || src}}` —— useSrc 为空（例如 src 被上层误传对象）时，
    // 渲染行为与改动前**完全一致**。
    useSrc: ''
  },
  observers: {
    // src 变化（列表项复用）时重置状态，避免旧图占位残留
    src() {
      this.setData({ failed: false, loaded: false, useSrc: '' });
      this._resolve();
    }
  },
  lifetimes: {
    attached() {
      this._resolve();
    }
  },
  methods: {
    // 选择渲染地址：已有本地缓存 → 用本地；否则沿用原始远程地址（不改动原有渲染路径）
    _resolve() {
      const url = this.data.src;
      this._triedLocal = '';
      if (!url || typeof url !== 'string') {
        this.setData({ useSrc: '' });
        return;
      }
      const local = logoLocal.cachedPath(url);
      this.setData({ useSrc: local || url });
    },
    onLoad() {
      this.setData({ loaded: true, failed: false });
    },
    onError() {
      const url = this.data.src;
      // 非字符串（上层误传对象）／同一 URL 已尝试过本地化 → 不再重试，走占位
      if (!url || typeof url !== 'string' || this._triedLocal === url) {
        this.setData({ failed: true, loaded: false });
        return;
      }
      this._triedLocal = url;
      logoLocal.fetchToLocal(url).then((localPath) => {
        if (!localPath) {
          // 下载/落地失败 → 维持原行为（首字母占位）
          this.setData({ failed: true, loaded: false });
          return;
        }
        // 用本地文件重渲染（清 loaded，等新图的 bindload）
        this.setData({ useSrc: localPath, loaded: false, failed: false });
      });
    }
  }
});
