#!/usr/bin/env node
/**
 * Curation 一致性自动校验脚本
 *
 * 用途：对 utils/curation.js 中 CURATED_EVENTS 每条赛事进行一致性校验：
 *   1. canonical 与 community 规则（tiers.js communityTierFromName）的 grade 是否一致
 *   2. start/end 日期是否合理（start < end，年份与 year 字段一致）
 *   3. tier 字段完整性（grade/rank/label 是否齐全）
 *   4. aliases 是否有重复（同事件内重复 + 跨事件碰撞）
 *   5. status 与日期是否一致（status='即将到来' 但 start 已过 → 疑似取消，调 detectCancelledEvents）
 *   6. liquipediaSlug 是否存在（有 slug 才能从 Liquipedia 获取元数据）
 *
 * 运行方式：node scripts/verify-curation.js
 * 输出：scripts/output/verify-curation.md（markdown 报告）
 * 退出码：始终 0（即使发现问题也不阻断，仅报告）
 *
 * 依赖：仅 Node.js 内置模块 + 项目内 utils/curation.js、utils/tiers.js、utils/consensus.js
 *       （无 wx/cloud 依赖，纯 Node 运行）
 */
'use strict';

const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const curation = require(path.join(ROOT, 'utils', 'curation.js'));
const tiers = require(path.join(ROOT, 'utils', 'tiers.js'));
const consensus = require(path.join(ROOT, 'utils', 'consensus.js'));

const EVENTS = curation.CURATED_EVENTS || [];
const OUTPUT_DIR = path.join(__dirname, 'output');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'verify-curation.md');

// ===== 工具函数 =====

// Unix 秒 → 'YYYY-MM-DD'（UTC）
function fmtDate(sec) {
  if (sec == null) return '-';
  const d = new Date(sec * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

// Unix 秒 → 年份（UTC）
function yearOf(sec) {
  return new Date(sec * 1000).getUTCFullYear();
}

// 当前时间字符串 'YYYY-MM-DD HH:mm:ss'（本地时区）
function nowStr() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

// 别名归一（与 consensus.normName 一致口径，buildLookups 实际索引用此归一）
function normAlias(a) {
  return consensus.normName(String(a == null ? '' : a));
}

// markdown 单元格转义（管道符 / 换行）
function cell(v) {
  return String(v == null ? '' : v).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

// ===== 校验逻辑 =====

// 1. 等级不一致（community 规则 vs curation tier）
//    仅当 communityTierFromName 返回非 null 且 grade 与 curation tier.grade 不同时报告。
//    community 返回 null（规则未覆盖）不视为等级不一致——curation 是权威源。
function checkTierGrade() {
  const issues = [];
  EVENTS.forEach((ev) => {
    if (!ev || !ev.canonical || !ev.tier || !ev.tier.grade) return;
    const comm = tiers.communityTierFromName(ev.canonical);
    if (!comm) return;
    if (comm.grade !== ev.tier.grade) {
      issues.push({
        canonical: ev.canonical,
        curationGrade: ev.tier.grade,
        communityGrade: comm.grade,
        suggestion: '核实并更新（curation 或 community 规则其一）'
      });
    }
  });
  return issues;
}

// 2. 日期不合理
function checkDates() {
  const issues = [];
  EVENTS.forEach((ev) => {
    if (!ev || !ev.canonical) return;
    // start < end
    if (ev.start != null && ev.end != null && ev.start >= ev.end) {
      issues.push({
        canonical: ev.canonical,
        problem: 'start >= end',
        detail: 'start=' + fmtDate(ev.start) + ', end=' + fmtDate(ev.end)
      });
    }
    // start 年份与 year 一致
    if (ev.start != null && ev.year != null && yearOf(ev.start) !== ev.year) {
      issues.push({
        canonical: ev.canonical,
        problem: 'start 年份与 year 不一致',
        detail: 'start=' + fmtDate(ev.start) + ' (年 ' + yearOf(ev.start) + '), year=' + ev.year
      });
    }
    // end 年份与 year 一致（允许跨年赛事：end 年份 = year 或 year+1）
    if (ev.end != null && ev.year != null) {
      const ey = yearOf(ev.end);
      if (ey !== ev.year && ey !== ev.year + 1) {
        issues.push({
          canonical: ev.canonical,
          problem: 'end 年份与 year 不一致',
          detail: 'end=' + fmtDate(ev.end) + ' (年 ' + ey + '), year=' + ev.year
        });
      }
    }
  });
  return issues;
}

// 3. tier 字段完整性
function checkTierComplete() {
  const issues = [];
  EVENTS.forEach((ev) => {
    if (!ev || !ev.canonical) return;
    const t = ev.tier;
    if (!t) {
      issues.push({ canonical: ev.canonical, missing: 'tier (整个字段缺失)' });
      return;
    }
    const missing = [];
    if (t.grade == null) missing.push('grade');
    if (t.rank == null) missing.push('rank');
    if (t.label == null || t.label === '') missing.push('label');
    if (missing.length > 0) {
      issues.push({ canonical: ev.canonical, missing: missing.join(' / ') });
    }
  });
  return issues;
}

// 4. aliases 重复（同事件内 + 跨事件碰撞）
function checkAliasDup() {
  const issues = [];
  // 4a. 同事件内重复（归一后相同）
  EVENTS.forEach((ev) => {
    if (!ev || !ev.canonical || !Array.isArray(ev.aliases)) return;
    const seen = {};
    ev.aliases.forEach((a) => {
      const k = normAlias(a);
      if (!k) return;
      if (seen[k]) {
        issues.push({
          canonical: ev.canonical,
          type: '事件内重复',
          alias: a,
          detail: '别名 "' + a + '" 归一后重复'
        });
      } else {
        seen[k] = true;
      }
    });
  });
  // 4b. 跨事件碰撞（同一归一名被多个事件共用 → buildLookups 中后写覆盖前写，查询歧义）
  const globalMap = {}; // normAlias -> { alias, events: [canonical,...] }
  EVENTS.forEach((ev) => {
    if (!ev || !ev.canonical || !Array.isArray(ev.aliases)) return;
    ev.aliases.forEach((a) => {
      const k = normAlias(a);
      if (!k) return;
      if (!globalMap[k]) globalMap[k] = { alias: a, events: [] };
      if (globalMap[k].events.indexOf(ev.canonical) === -1) {
        globalMap[k].events.push(ev.canonical);
      }
    });
  });
  Object.keys(globalMap).forEach((k) => {
    const g = globalMap[k];
    if (g.events.length > 1) {
      issues.push({
        canonical: g.events.join(' / '),
        type: '跨事件碰撞',
        alias: g.alias,
        detail: '别名 "' + g.alias + '" 被 ' + g.events.length + ' 个事件共用'
      });
    }
  });
  return issues;
}

// 5. 疑似取消的赛事（status 与日期不一致）—— 直接复用 curation.detectCancelledEvents
function checkCancelled() {
  if (typeof curation.detectCancelledEvents !== 'function') return [];
  return curation.detectCancelledEvents();
}

// 6. 缺少 liquipediaSlug
function checkSlug() {
  const issues = [];
  EVENTS.forEach((ev) => {
    if (!ev || !ev.canonical) return;
    if (!ev.liquipediaSlug || String(ev.liquipediaSlug).trim() === '') {
      issues.push({ canonical: ev.canonical, suggestion: '补充 liquipediaSlug 以获取元数据' });
    }
  });
  return issues;
}

// ===== 报告生成 =====

function buildMarkdown(r) {
  const total = r.tierGrade.length + r.dates.length + r.tierComplete.length +
    r.aliasDup.length + r.cancelled.length + r.slug.length;
  const lines = [];

  lines.push('# Curation 一致性校验报告');
  lines.push('> 生成时间：' + nowStr());
  lines.push('> 总赛事数：' + EVENTS.length + '，问题数：' + total);
  lines.push('');

  // 1. 等级不一致
  lines.push('## 1. 等级不一致（community 规则 vs curation tier）');
  if (r.tierGrade.length === 0) {
    lines.push('> 无问题');
  } else {
    lines.push('| 赛事名 | curation 等级 | community 等级 | 建议 |');
    lines.push('|---|---|---|---|');
    r.tierGrade.forEach((i) => {
      lines.push('| ' + cell(i.canonical) + ' | ' + cell(i.curationGrade) +
        ' | ' + cell(i.communityGrade) + ' | ' + cell(i.suggestion) + ' |');
    });
  }
  lines.push('');

  // 2. 日期不合理
  lines.push('## 2. 日期不合理');
  if (r.dates.length === 0) {
    lines.push('> 无问题');
  } else {
    lines.push('| 赛事名 | 问题 | 详情 |');
    lines.push('|---|---|---|');
    r.dates.forEach((i) => {
      lines.push('| ' + cell(i.canonical) + ' | ' + cell(i.problem) +
        ' | ' + cell(i.detail) + ' |');
    });
  }
  lines.push('');

  // 3. tier 字段不完整
  lines.push('## 3. tier 字段不完整');
  if (r.tierComplete.length === 0) {
    lines.push('> 无问题');
  } else {
    lines.push('| 赛事名 | 缺失字段 |');
    lines.push('|---|---|');
    r.tierComplete.forEach((i) => {
      lines.push('| ' + cell(i.canonical) + ' | ' + cell(i.missing) + ' |');
    });
  }
  lines.push('');

  // 4. aliases 重复
  lines.push('## 4. aliases 重复');
  if (r.aliasDup.length === 0) {
    lines.push('> 无问题');
  } else {
    lines.push('| 赛事名 | 类型 | 别名 | 详情 |');
    lines.push('|---|---|---|---|');
    r.aliasDup.forEach((i) => {
      lines.push('| ' + cell(i.canonical) + ' | ' + cell(i.type) +
        ' | ' + cell(i.alias) + ' | ' + cell(i.detail) + ' |');
    });
  }
  lines.push('');

  // 5. 疑似取消
  lines.push('## 5. 疑似取消的赛事（status 与日期不一致）');
  if (r.cancelled.length === 0) {
    lines.push('> 无问题');
  } else {
    lines.push('| 赛事名 | status | 开始 | 结束 | 延迟天数 | 原因 |');
    lines.push('|---|---|---|---|---|---|');
    r.cancelled.forEach((i) => {
      lines.push('| ' + cell(i.canonical) + ' | ' + cell(i.status) +
        ' | ' + cell(i.start ? fmtDate(i.start) : '-') +
        ' | ' + cell(i.end ? fmtDate(i.end) : '-') +
        ' | ' + cell(i.delayDays) + ' | ' + cell(i.reason) + ' |');
    });
  }
  lines.push('');

  // 6. 缺少 liquipediaSlug
  lines.push('## 6. 缺少 liquipediaSlug');
  if (r.slug.length === 0) {
    lines.push('> 无问题');
  } else {
    lines.push('| 赛事名 | 建议 |');
    lines.push('|---|---|');
    r.slug.forEach((i) => {
      lines.push('| ' + cell(i.canonical) + ' | ' + cell(i.suggestion) + ' |');
    });
  }
  lines.push('');

  // 汇总
  lines.push('## 汇总');
  lines.push('- 等级不一致：' + r.tierGrade.length + ' 个');
  lines.push('- 日期不合理：' + r.dates.length + ' 个');
  lines.push('- tier 不完整：' + r.tierComplete.length + ' 个');
  lines.push('- aliases 重复：' + r.aliasDup.length + ' 个');
  lines.push('- 疑似取消：' + r.cancelled.length + ' 个');
  lines.push('- 缺少 liquipediaSlug：' + r.slug.length + ' 个');
  lines.push('');

  return lines.join('\n');
}

// ===== 主入口 =====

function main() {
  const results = {
    tierGrade: checkTierGrade(),
    dates: checkDates(),
    tierComplete: checkTierComplete(),
    aliasDup: checkAliasDup(),
    cancelled: checkCancelled(),
    slug: checkSlug()
  };
  const total = results.tierGrade.length + results.dates.length +
    results.tierComplete.length + results.aliasDup.length +
    results.cancelled.length + results.slug.length;

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  fs.writeFileSync(OUTPUT_FILE, buildMarkdown(results), 'utf8');

  console.log('========== Curation 一致性校验 ==========');
  console.log('总赛事数        : ' + EVENTS.length);
  console.log('等级不一致      : ' + results.tierGrade.length);
  console.log('日期不合理      : ' + results.dates.length);
  console.log('tier 不完整     : ' + results.tierComplete.length);
  console.log('aliases 重复    : ' + results.aliasDup.length);
  console.log('疑似取消        : ' + results.cancelled.length);
  console.log('缺少 liq Slug   : ' + results.slug.length);
  console.log('问题总数        : ' + total);
  console.log('报告已生成      : ' + OUTPUT_FILE);
}

main();
