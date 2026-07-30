#!/usr/bin/env node
/**
 * 发现 curation 中缺失的 Liquipedia slug 映射
 * 对每个 curation canonical 赛事名，调 Liquipedia revisions API（带 redirects:1），
 * 若能返回含 Infobox league 的 wikitext，则记录该 slug。
 *
 * 用法：node scripts/discover-missing-slugs.js
 * 输出：控制台显示发现的映射，可重定向到文件补入 slugmap
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const UA = 'DOTA2-Esports-Hub/1.0 (WeChat Mini Program; contact: dev@local)';
const LIQUIPEDIA_BASE = 'https://liquipedia.net/dota2/api.php';
const RATE_LIMIT_MS = 2200;

const curation = require('../utils/curation.js');
const slugmap = JSON.parse(fs.readFileSync(path.join(__dirname, '../utils/liquipedia-slugmap.json'), 'utf8'));
const existing = slugmap.mappings || {};

// 获取所有 curation canonical 名
const events = curation.CURATED_EVENTS || [];
const canonicals = events.filter(e => e && e.canonical).map(e => e.canonical);
const missing = canonicals.filter(n => !existing[n]);

console.log('缺失总数:', missing.length);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fetchWikitext(pageName) {
  return new Promise((resolve) => {
    const url = LIQUIPEDIA_BASE + '?action=query&prop=revisions&rvprop=content&rvslots=main&titles=' +
      encodeURIComponent(pageName) + '&format=json&formatversion=2&redirects=1';
    https.get(url, {
      headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip' }
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          const pages = j && j.query && j.query.pages;
          if (!pages || !pages.length) return resolve(null);
          const page = pages[0];
          if (page.missing) return resolve(null);
          const rev = page.revisions && page.revisions[0];
          if (!rev) return resolve(null);
          const content = (rev.slots && rev.slots.main && rev.slots.main.content) || rev['*'] || rev.content;
          if (!content) return resolve(null);
          // 验证包含 Infobox league（确认是有效的赛事页面）
          if (!/Infobox league/i.test(content)) return resolve(null);
          resolve({ slug: page.title, foundName: page.title, pageid: page.pageid });
        } catch (e) { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

async function run() {
  const found = [];
  const notFound = [];

  for (let i = 0; i < missing.length; i++) {
    const name = missing[i];
    const result = await fetchWikitext(name);
    if (result && result.slug && result.slug !== name) {
      found.push({ from: name, to: result.slug });
      console.log(`FOUND: "${name}" → "${result.slug}"`);
    } else if (result && result.slug === name) {
      found.push({ from: name, to: result.slug });
      console.log(`EXACT: "${name}" → "${result.slug}"（无需映射，redirects:1 即可）`);
    } else {
      notFound.push(name);
      console.log(`MISS:  "${name}"`);
    }
    if (i < missing.length - 1) await sleep(RATE_LIMIT_MS);
  }

  console.log('\n=== 结果 ===');
  console.log('总检测:', missing.length);
  console.log('发现映射:', found.length);
  console.log('未找到:', notFound.length);

  if (found.length) {
    console.log('\n发现的新映射（可追加到 slugmap）:');
    const patch = {};
    found.forEach(f => {
      patch[f.from] = f.to;
    });
    console.log(JSON.stringify(patch, null, 2));
  }
}

run().catch(console.error);
