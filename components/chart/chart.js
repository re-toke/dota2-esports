// components/chart/chart.js
// 轻量 Canvas 2D 图表组件：支持折线图(line)与雷达图(radar)，零第三方依赖。
// 折线图：双序列对比、零线、事件标记(肉山/推塔)、点击 tooltip。
// 雷达图：多维能力对比(如选手 KDA/GPM/XPM/参战率/伤害)。
// 适配 dpr，observer 驱动重绘，tap 命中最近数据点。

function dpr() {
  // 2026-07-28：wx.getSystemInfoSync 已废弃，pixelRatio 字段归 wx.getWindowInfo。
  //   新基础库（libVersion >= 2.20.1，本项目 libVersion 3.0.0）一定支持 getWindowInfo。
  //   极旧基础库回退到默认值 2，避免触发废弃 API 警告。
  try {
    if (wx.getWindowInfo) return wx.getWindowInfo().pixelRatio || 2;
  } catch (e) {}
  return 2;
}

function hexToRgba(hex, alpha) {
  if (!hex) return 'rgba(200,169,81,' + alpha + ')';
  let h = hex.replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

Component({
  properties: {
    type: { type: String, value: 'line' },     // 'line' | 'radar'
    height: { type: Number, value: 200 },       // 画布高度(px)
    // 折线图
    series: { type: Array, value: [] },         // [{ name, color, data:[number] }]
    categories: { type: Array, value: [] },     // [string] x 轴标签
    events: { type: Array, value: [] },         // [{ index, label, color }]
    zeroLine: { type: Boolean, value: false },  // 是否绘制零线
    yMin: { type: Number, value: null },
    yMax: { type: Number, value: null },
    // 雷达图
    indicators: { type: Array, value: [] }      // [{ name, max }]
  },

  lifetimes: {
    ready() {
      this._initCanvas();
    },
    detached() {
      this._ready = false;
      this._canvas = null;
      this._ctx = null;
    }
  },

  observers: {
    'type, series, categories, events, indicators, height, zeroLine, yMin, yMax': function () {
      if (this._ready) this._draw();
    }
  },

  methods: {
    _initCanvas() {
      const q = wx.createSelectorQuery().in(this);
      q.select('#chartCanvas').fields({ node: true, size: true, rect: true }).exec((res) => {
        if (!res || !res[0] || !res[0].node) return;
        const canvas = res[0].node;
        const ctx = canvas.getContext('2d');
        const ratio = dpr();
        const w = res[0].width;
        const h = res[0].height;
        canvas.width = w * ratio;
        canvas.height = h * ratio;
        ctx.scale(ratio, ratio);
        this._canvas = canvas;
        this._ctx = ctx;
        this._w = w;
        this._h = h;
        this._left = res[0].left || 0;
        this._top = res[0].top || 0;
        this._ready = true;
        this._draw();
      });
    },

    _draw() {
      const ctx = this._ctx;
      if (!ctx) return;
      ctx.clearRect(0, 0, this._w, this._h);
      if (this.data.type === 'radar') this._drawRadar();
      else this._drawLine();
    },

    _drawLine() {
      const ctx = this._ctx;
      const w = this._w, h = this._h;
      const { series, categories, events, zeroLine, yMin, yMax } = this.data;
      if (!series || !series.length) return;

      const padL = 40, padR = 14, padT = 18, padB = 26;
      const plotW = w - padL - padR;
      const plotH = h - padT - padB;
      const n = (categories && categories.length) || (series[0].data ? series[0].data.length : 0);
      if (n === 0) return;

      let min = (yMin != null) ? yMin : Infinity;
      let max = (yMax != null) ? yMax : -Infinity;
      if (yMin == null || yMax == null) {
        series.forEach((s) => {
          (s.data || []).forEach((v) => {
            if (v < min) min = v;
            if (v > max) max = v;
          });
        });
      }
      if (zeroLine) {
        if (min > 0) min = 0;
        if (max < 0) max = 0;
      }
      if (min === max) { min -= 1; max += 1; }
      const range = max - min;

      const xAt = (i) => padL + (n <= 1 ? plotW / 2 : plotW * i / (n - 1));
      const yAt = (v) => padT + plotH * (1 - (v - min) / range);

      // 网格 + y 轴标签
      ctx.lineWidth = 1;
      ctx.font = '10px sans-serif';
      ctx.textBaseline = 'middle';
      const ticks = 4;
      for (let t = 0; t <= ticks; t++) {
        const v = min + range * t / ticks;
        const y = yAt(v);
        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        ctx.beginPath();
        ctx.moveTo(padL, y);
        ctx.lineTo(w - padR, y);
        ctx.stroke();
        ctx.fillStyle = '#8a8f99';
        ctx.textAlign = 'right';
        ctx.fillText(String(Math.round(v)), padL - 4, y);
      }
      ctx.textAlign = 'left';

      // 零线
      if (zeroLine && min < 0 && max > 0) {
        const y0 = yAt(0);
        ctx.strokeStyle = 'rgba(255,255,255,0.28)';
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(padL, y0);
        ctx.lineTo(w - padR, y0);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // 事件标记
      (events || []).forEach((ev) => {
        const x = xAt(ev.index);
        ctx.strokeStyle = ev.color || '#C8A951';
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(x, padT);
        ctx.lineTo(x, h - padB);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = ev.color || '#C8A951';
        ctx.beginPath();
        ctx.arc(x, padT + 4, 3, 0, 2 * Math.PI);
        ctx.fill();
      });

      // 序列折线
      series.forEach((s) => {
        ctx.strokeStyle = s.color || '#C8A951';
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        ctx.beginPath();
        (s.data || []).forEach((v, i) => {
          const x = xAt(i), y = yAt(v);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();
      });

      // 点击 tooltip
      if (this._tapIndex != null && this._tapIndex >= 0 && this._tapIndex < n) {
        const idx = this._tapIndex;
        const tx = xAt(idx);
        ctx.strokeStyle = 'rgba(200,169,81,0.7)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(tx, padT);
        ctx.lineTo(tx, h - padB);
        ctx.stroke();
        series.forEach((s) => {
          const v = s.data ? s.data[idx] : null;
          if (v == null) return;
          ctx.fillStyle = s.color || '#C8A951';
          ctx.beginPath();
          ctx.arc(tx, yAt(v), 3.5, 0, 2 * Math.PI);
          ctx.fill();
        });

        const label = (categories && categories[idx] != null) ? String(categories[idx]) : ('#' + idx);
        const lines = series.map((s) => ((s.name ? s.name + '  ' : '') + (s.data && s.data[idx] != null ? String(Math.round(s.data[idx])) : '-')));
        ctx.font = '11px sans-serif';
        let bw = ctx.measureText(label).width;
        lines.forEach((l) => { bw = Math.max(bw, ctx.measureText(l).width); });
        bw += 16;
        const bh = 18 + lines.length * 15;
        let bx = tx + 10;
        if (bx + bw > w - padR) bx = tx - 10 - bw;
        const by = padT + 6;

        ctx.fillStyle = 'rgba(13,17,22,0.94)';
        roundRect(ctx, bx, by, bw, bh, 6);
        ctx.fill();
        ctx.strokeStyle = 'rgba(200,169,81,0.4)';
        ctx.lineWidth = 1;
        roundRect(ctx, bx, by, bw, bh, 6);
        ctx.stroke();

        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        ctx.fillStyle = '#C8A951';
        ctx.fillText(label, bx + 8, by + 11);
        lines.forEach((l, i) => {
          ctx.fillStyle = series[i].color || '#c9d1d9';
          ctx.fillText(l, bx + 8, by + 26 + i * 15);
        });
      }
      ctx.textBaseline = 'alphabetic';
    },

    _drawRadar() {
      const ctx = this._ctx;
      const w = this._w, h = this._h;
      const { indicators, series } = this.data;
      if (!indicators || !indicators.length) return;

      const cx = w / 2;
      const cy = h / 2 + 6;
      const radius = Math.min(w, h) / 2 - 38;
      const n = indicators.length;
      const angleAt = (i) => -Math.PI / 2 + i * 2 * Math.PI / n;

      // 网格环
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(255,255,255,0.1)';
      for (let r = 1; r <= 4; r++) {
        const rr = radius * r / 4;
        ctx.beginPath();
        for (let i = 0; i <= n; i++) {
          const a = angleAt(i % n);
          const x = cx + rr * Math.cos(a);
          const y = cy + rr * Math.sin(a);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }

      // 轴线 + 标签
      ctx.font = '10px sans-serif';
      ctx.textBaseline = 'middle';
      for (let i = 0; i < n; i++) {
        const a = angleAt(i);
        const x = cx + radius * Math.cos(a);
        const y = cy + radius * Math.sin(a);
        ctx.strokeStyle = 'rgba(255,255,255,0.1)';
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(x, y);
        ctx.stroke();

        const lx = cx + (radius + 16) * Math.cos(a);
        const ly = cy + (radius + 16) * Math.sin(a);
        const cosA = Math.cos(a);
        ctx.textAlign = Math.abs(cosA) < 0.3 ? 'center' : (cosA > 0 ? 'left' : 'right');
        ctx.fillStyle = '#c9d1d9';
        ctx.fillText(indicators[i].name, lx, ly);
      }
      ctx.textAlign = 'left';

      // 序列多边形
      (series || []).forEach((s) => {
        ctx.beginPath();
        for (let i = 0; i <= n; i++) {
          const idx = i % n;
          const max = indicators[idx].max || 1;
          const val = s.data ? s.data[idx] || 0 : 0;
          const rr = radius * Math.min(1, val / max);
          const a = angleAt(idx);
          const x = cx + rr * Math.cos(a);
          const y = cy + rr * Math.sin(a);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.fillStyle = hexToRgba(s.color || '#C8A951', 0.18);
        ctx.fill();
        ctx.strokeStyle = s.color || '#C8A951';
        ctx.lineWidth = 2;
        ctx.stroke();
      });
    },

    onTap(e) {
      if (this.data.type !== 'line') return;
      const t = e.detail;
      if (!t || t.x == null) return;
      const rx = t.x - (this._left || 0);
      const { series, categories } = this.data;
      const n = (categories && categories.length) || (series[0] && series[0].data ? series[0].data.length : 0);
      if (!n) return;
      const padL = 40, padR = 14;
      const plotW = this._w - padL - padR;
      let idx = n <= 1 ? 0 : Math.round((rx - padL) / (plotW / (n - 1)));
      idx = Math.max(0, Math.min(n - 1, idx));
      this._tapIndex = idx;
      this._draw();
    }
  }
});
