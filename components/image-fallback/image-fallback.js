// 通用图片占位/容错组件
// 解决原生 <image> 在「URL 存在但加载失败」时不显示兜底占位的问题。
// 统一处理三种状态：无图 / 加载中 / 加载失败，均展示品牌色首字母占位。
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
    loaded: false
  },
  observers: {
    // src 变化（列表项复用）时重置状态，避免旧图占位残留
    src() {
      this.setData({ failed: false, loaded: false });
    }
  },
  methods: {
    onLoad() {
      this.setData({ loaded: true, failed: false });
    },
    onError() {
      // 加载失败：回退到占位，并移除真实图片渲染（wx:if）
      this.setData({ failed: true, loaded: false });
    }
  }
});
