// scripts/ops/export-icons.js
// 批次0（2026-08-30）：game-icons.net SVG → PNG 导出（PRD §3.2）
// 用途：wxml 不支持内联 SVG，TabBar/快捷区图标统一转 PNG 存 assets/icons/。
// 用法：node scripts/ops/export-icons.js
// 依赖：@resvg/resvg-js（devDependency）
// 授权：game-icons.net（Delapouite、Lorc），CC BY 3.0 —— 「我的 → 关于」页需署名。

const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC_DIR = path.join(ROOT, 'mockup', 'gi');
const OUT_DIR = path.join(ROOT, 'assets', 'icons');

// 统一 512×512（game-icons 原生 viewBox 尺寸，零缩放采样损失；
// 132px 实测在微信 image 下采样后偏糊，2026-08-30 批次0 修复）
const SIZE = 512;

// [源文件, 输出名, 颜色]
const JOBS = [
  // TabBar 3 枚 × 2 态
  // 首页 castle → world：castle 含 9 个窗洞子路径，26px 逻辑尺寸下糊成灰点（浏览器实拍验证），
  // world（全球赛事语义）形体大、26px 最清晰。
  ['world.svg', 'tab-home-on.png', '#FFD15C'],
  ['world.svg', 'tab-home-off.png', '#6b6b73'],
  ['diamond-trophy.svg', 'tab-league-on.png', '#FFD15C'],
  ['diamond-trophy.svg', 'tab-league-off.png', '#6b6b73'],
  ['spiked-dragon-head.svg', 'tab-me-on.png', '#FFD15C'],
  ['spiked-dragon-head.svg', 'tab-me-off.png', '#6b6b73'],
  // 首页快捷区 3 枚（批次2 接入，先导出备好）
  ['checked-shield.svg', 'gi-shield.png', '#C8A951'],
  ['crossed-swords.svg', 'gi-swords.png', '#3FB950'],
  ['book-cover.svg', 'gi-book.png', '#58a6ff']
];

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let ok = 0;
  for (const [src, out, color] of JOBS) {
    let svg = fs.readFileSync(path.join(SRC_DIR, src), 'utf8');
    svg = svg.replace(/fill="currentColor"/g, `fill="${color}"`);
    // 关键修复（2026-08-30）：Iconify 下载的 SVG 带 width="1em" height="1em"，
    // resvg 按 em（默认 12px）计算原始尺寸导致 fitTo 失效 → 实际输出仅 12×12，
    // 微信拉伸后严重模糊。显式改写为 512×512 与 viewBox 一致后再渲染。
    svg = svg.replace(/\swidth="[^"]*"/, ` width="512"`)
             .replace(/\sheight="[^"]*"/, ` height="512"`);
    const resvg = new Resvg(svg, {
      fitTo: { mode: 'width', width: SIZE },
      background: 'rgba(0,0,0,0)' // 透明底
    });
    const png = resvg.render().asPng();
    fs.writeFileSync(path.join(OUT_DIR, out), png);
    ok++;
    console.log(`[ok] ${src} -> assets/icons/${out} (${color}) ${SIZE}px`);
  }
  console.log(`\n完成：${ok}/${JOBS.length} 张 PNG 已导出至 assets/icons/`);
}

main();
