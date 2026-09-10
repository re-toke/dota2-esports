#!/usr/bin/env node
/**
 * scripts/sync/extract-privacy-text.js
 *
 * 从 subpackages/detail/privacy/privacy.wxml 提取纯文本，输出为可粘贴到
 * 小程序后台「用户隐私保护指引」编辑框的文案。
 *
 * 为什么需要这个脚本：
 *   微信审核会把「页内隐私协议」与「后台隐私指引文案」逐字比对。手工同步两张
 *   文案必然漂移（本项目 v2.0.0 就因此积累了 3 处与实际行为不符的表述）。
 *   本脚本让后台文案**从代码单点生成**，并提供 --check 模式做一致性校验。
 *
 * 用法：
 *   node scripts/sync/extract-privacy-text.js            # 打印全文（复制用）
 *   node scripts/sync/extract-privacy-text.js --out      # 写入 deliverables/隐私协议_后台粘贴文案.txt
 *   node scripts/sync/extract-privacy-text.js --check    # 与既有 txt 比对，不一致则退出码 1
 *
 * 提取规则（与 WXML 结构约定一致）：
 *   - <view class="title">      → 标题行（版本从 privacy.js 读）
 *   - <view class="section-title"> → 章节标题
 *   - <view class="section-body"> / <view class="para"> / <view class="list-item"> → 段落
 *   - <text class="em">…</text>  → 纯文本（去掉 em 标记）
 *   - 其余标签、HTML 实体、注释一律剥离
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const WXML = path.join(ROOT, 'subpackages/detail/privacy/privacy.wxml');
const JS = path.join(ROOT, 'subpackages/detail/privacy/privacy.js');
const OUT = path.join(ROOT, 'deliverables/隐私协议_后台粘贴文案.txt');

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** 去掉标签但保留文本；<text class="em"> 内容原样保留 */
function stripTags(s) {
  return decodeEntities(
    s
      .replace(/<!--[\s\S]*?-->/g, '')      // 注释
      .replace(/<text[^>]*>/g, '')          // em 包裹的 text 开标签
      .replace(/<\/text>/g, '')
      .replace(/<[^>]+>/g, '')              // 其余标签
  ).replace(/[ \t]+/g, ' ').trim();
}

function extract() {
  const raw = fs.readFileSync(WXML, 'utf8');
  const js = fs.readFileSync(JS, 'utf8');

  const vm = js.match(/version:\s*'([^']+)'/);
  const dm = js.match(/updatedAt:\s*'([^']+)'/);
  const version = vm ? vm[1] : '?';
  const updatedAt = dm ? dm[1] : '?';

  const titleM = raw.match(/<view class="title">([\s\S]*?)<\/view>/);
  const title = titleM ? stripTags(titleM[1]) : '隐私协议';

  // ★ 保序方案：先把「块级容器开标签」替换成行首标记（而不是去匹配配对的 </view>，
  //   因为 section-body 内含嵌套 view，非贪婪 </view> 会在第一个嵌套闭合处截断，
  //   导致裸文本段落丢失/乱序）。替换标记后统一剥标签，文档顺序天然保留。
  //   标记区分块类型，用于控制「列表项之间不留空行、段落之间留空行」。
  const T = '\u0001', P = '\u0002', I = '\u0003';
  let s = raw
    .replace(/<view class="header">[\s\S]*?<\/view>\s*<\/view>/, '')  // 头部（标题/版本，脚本自行生成）
    .replace(/<!--[\s\S]*?-->/g, '')                                    // 注释
    .replace(/<view class="section-title">/g, '\n' + T)                 // 章节标题
    .replace(/<view class="para">/g, '\n' + P)                          // 段落
    .replace(/<view class="list-item">/g, '\n' + I)                     // 列表项
    .replace(/<view class="section-body">/g, '\n' + P)                  // 裸文本段落容器
    .replace(/<text[^>]*>/g, '')                                        // em 包裹
    .replace(/<\/text>/g, '')
    .replace(/<[^>]+>/g, '');                                           // 其余标签（含闭合）

  s = decodeEntities(s);

  const out = [];
  const push = (txt, sep) => {
    txt = txt.trim();
    if (!txt) return;
    out.push(txt);
    if (sep) out.push('');
  };
  for (let line of s.split('\n')) {
    line = line.replace(/[ \t]+/g, ' ').trim();
    if (!line) continue;
    const mark = line.charAt(0);
    // ★ 仅在「本行确实带标记」时才剥掉首字符——否则会吃掉正文第一个字
    //   （裸文本行如「本协议适用于…」的「本」就被误剥过）。
    const marked = (mark === T || mark === P || mark === I);
    const body = marked ? line.slice(1).trim() : line;
    if (mark === T) {
      if (out.length && out[out.length - 1] !== '') out.push('');
      push(body, true);
    } else if (mark === I) {
      push(body, false);          // 列表项之间不留空行
    } else {
      push(body, true);           // 段落 / 裸文本
    }
  }
  if (out.length && out[out.length - 1] === '') out.pop();

  return title + '（版本 ' + version + ' · 更新于 ' + updatedAt + '）\n\n' + out.join('\n') + '\n';
}

function main() {
  const argv = process.argv.slice(2);
  const text = extract();

  if (argv.includes('--check')) {
    if (!fs.existsSync(OUT)) {
      console.error('❌ 未找到基线文件：' + path.relative(ROOT, OUT));
      console.error('   先跑一次 --out 生成基线。');
      process.exit(1);
    }
    const base = fs.readFileSync(OUT, 'utf8');
    if (base === text) {
      console.log('✅ 页内隐私协议与后台粘贴文案一致（' + text.length + ' 字符）');
      process.exit(0);
    }
    const bl = base.split('\n'), tl = text.split('\n');
    console.error('❌ 文案不一致（页内 ' + tl.length + ' 行 / 基线 ' + bl.length + ' 行）');
    const n = Math.max(bl.length, tl.length);
    for (let i = 0; i < n; i++) {
      if (bl[i] !== tl[i]) {
        console.error('   首个差异在第 ' + (i + 1) + ' 行：');
        console.error('     基线: ' + JSON.stringify(bl[i]));
        console.error('     页内: ' + JSON.stringify(tl[i]));
        break;
      }
    }
    console.error('   修复：核对 subpackages/detail/privacy/privacy.wxml 后跑 --out 重新生成基线。');
    process.exit(1);
  }

  if (argv.includes('--out')) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, text, 'utf8');
    console.log('✅ 已写入 ' + path.relative(ROOT, OUT) + '（' + text.length + ' 字符）');
    console.log('   复制该文件全部内容 → 小程序后台「设置 → 服务内容声明 → 用户隐私保护指引」。');
    return;
  }

  process.stdout.write(text);
}

main();
