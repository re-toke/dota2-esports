// scripts/test/load-local-secrets.js
// 读取本机密钥（.secrets.local.json，已被 .gitignore 排除，绝不入库）。
// 返回 {} 表示未配置 —— 调用方应优雅跳过，而不是报错。
'use strict';
const fs = require('fs');
const path = require('path');

function loadLocalSecrets() {
  const candidates = [
    path.resolve(__dirname, '..', '..', '.secrets.local.json'),
    path.resolve(__dirname, '.secrets.local.json')
  ];
  for (const p of candidates) {
    try {
      const raw = fs.readFileSync(p, 'utf8');
      const j = JSON.parse(raw);
      if (j && typeof j === 'object') return j;
    } catch (e) { /* 文件不存在 → 视为未配置 */ }
  }
  return {};
}

// ★ 直接导出调用结果（而非函数）—— 调用方以 `secrets.STRATZ_API_KEY` 属性访问。
module.exports = loadLocalSecrets();
