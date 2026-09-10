#!/usr/bin/env node
/**
 * scripts/ops/audit-privacy-apis.js
 *
 * 审计小程序实际调用的「微信隐私接口」，用于核对小程序后台
 * 「设置 → 服务内容声明 → 用户隐私保护指引」的「收集的信息类型」勾选项。
 *
 * 为什么需要脚本：
 *   微信要求勾选项与实际调用一致（声明缺失或多余都可能被驳）。手核容易漏
 *   （尤其 chooseAvatar / button open-type 这类非 wx.* 形式的写法）。
 *
 * 用法：
 *   node scripts/ops/audit-privacy-apis.js            # 打印命中清单
 *   node scripts/ops/audit-privacy-apis.js --json     # 机器可读
 *
 * 扫描范围：小程序代码（utils/ pages/ components/ subpackages/ app.js 及全局配置）
 * 排除：admin/（独立 Web 后台）、node_modules/、miniprogram_npm/、deliverables/
 * 注释中的命中会被标记为「仅注释」，不计入结论。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const SCAN_DIRS = ['utils', 'pages', 'components', 'subpackages'];
const SCAN_FILES = ['app.js', 'app.json', 'app.wxss'];
const SKIP_DIR = /(^|[\\/])(node_modules|miniprogram_npm|admin|deliverables|\.git|dist)([\\/]|$)/;
const EXT = new Set(['.js', '.wxml', '.json']);
// ★ 必须排除隐私政策页自身——页面正文里写着「不调用 wx.getUserInfo / wx.getLocation」
//   这类**否定式描述**，若纳入扫描会把「声明没调用」误报成「调用了」（实测踩过此坑）。
const SKIP_FILE = /subpackages[\\/]detail[\\/]privacy[\\/]/;

/** 需要按「整词」匹配的模式（防 platemail 命中 email 这类子串误报） */
const WORD_BOUNDARY = new Set(['email', 'idCard', 'idcard']);

/**
 * 隐私接口 → 后台「收集的信息类型」
 * key = 后台勾选项名称；patterns = 代码特征（原样匹配子串）
 */
const MAP = [
  { type: '微信昵称、头像', patterns: ['wx.getUserProfile', 'wx.getUserInfo', 'getUserProfile(', 'open-type="chooseAvatar"', "open-type='chooseAvatar'", 'chooseAvatar', 'type="nickname"', "type='nickname'", 'wx.getNickname'] },
  { type: '位置信息', patterns: ['wx.getLocation', 'wx.onLocationChange', 'wx.startLocationUpdate', 'wx.getFuzzyLocation'] },
  { type: '选择的位置信息', patterns: ['wx.chooseLocation', 'wx.choosePoi'] },
  { type: '地址', patterns: ['wx.chooseAddress'] },
  { type: '发票信息', patterns: ['wx.chooseInvoiceTitle', 'wx.chooseInvoice'] },
  { type: '微信运动数据', patterns: ['wx.getWeRunData'] },
  { type: '麦克风', patterns: ['wx.startRecord', 'wx.getRecorderManager', 'wx.joinVoIPChat', 'RecorderManager'] },
  { type: '选中的照片或视频信息', patterns: ['wx.chooseMedia', 'wx.chooseImage', 'wx.chooseVideo'] },
  { type: '摄像头', patterns: ['wx.createCameraContext', '<camera', 'cameraContext'] },
  { type: '手机号', patterns: ['getPhoneNumber', 'open-type="getPhoneNumber"', "open-type='getPhoneNumber'"] },
  { type: '通讯录（仅写入）权限', patterns: ['wx.addPhoneContact'] },
  { type: '设备信息', patterns: ['wx.getSystemInfoSync', 'wx.getSystemInfo', 'wx.getDeviceInfo', 'wx.getWindowInfo', 'wx.getAppBaseInfo', 'wx.getAppAuthorizeSetting', 'wx.getSystemSetting'] },
  { type: '身份证号码', patterns: ['idCard', 'idcard', '身份证'] },
  { type: '订单信息', patterns: ['wx.requestPayment', 'wx.chooseInvoice'] },
  { type: '发布内容', patterns: [] },
  { type: '所关注账号', patterns: [] },
  { type: '操作日志', patterns: [] },
  { type: '相册（仅写入）权限', patterns: ['wx.saveImageToPhotosAlbum', 'wx.saveVideoToPhotosAlbum'] },
  { type: '日历（仅写入）权限', patterns: ['wx.addPhoneCalendar'] },
  { type: '邮箱', patterns: ['email', '@qq.com'] },
  { type: '选中的文件', patterns: ['wx.chooseMessageFile', 'wx.chooseFile'] },
  { type: '剪切板', patterns: ['wx.setClipboardData', 'wx.getClipboardData'] },
  { type: '蓝牙', patterns: ['wx.openBluetoothAdapter', 'wx.startBluetoothDevicesDiscovery', 'wx.getBluetoothDevices', 'wx.onBluetoothDeviceFound', 'wx.writeBLECharacteristicValue'] },
  { type: '加速传感器', patterns: ['wx.startAccelerometer', 'wx.onAccelerometerChange'] },
  { type: '磁场传感器', patterns: ['wx.startCompass', 'wx.onCompassChange'] },
  { type: '方向传感器', patterns: ['wx.startDeviceMotionListening', 'wx.onDeviceMotionChange'] },
  { type: '陀螺仪传感器', patterns: ['wx.startGyroscope', 'wx.onGyroscopeChange'] }
];

function walk(dir, out) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (SKIP_DIR.test(p)) continue;
    if (e.isDirectory()) walk(p, out);
    else if (EXT.has(path.extname(e.name)) && !SKIP_FILE.test(p)) out.push(p);
  }
}

function collect() {
  const files = [];
  for (const d of SCAN_DIRS) walk(path.join(ROOT, d), files);
  for (const f of SCAN_FILES) {
    const p = path.join(ROOT, f);
    if (fs.existsSync(p) && !SKIP_FILE.test(p)) files.push(p);
  }
  return files;
}

/** 对需整词匹配的模式加边界（中英文/下划线均视为词内字符） */
function findOccurrences(src, pat) {
  const out = [];
  if (WORD_BOUNDARY.has(pat)) {
    const re = new RegExp('(?<![A-Za-z0-9_])' + pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z0-9_])', 'g');
    let m;
    while ((m = re.exec(src)) !== null) out.push(m.index);
  } else {
    let idx = -1;
    while ((idx = src.indexOf(pat, idx + 1)) !== -1) out.push(idx);
  }
  return out;
}

/** 判断命中行是否为注释（粗略但够用：行内 // 之前为空白或行首为 //、*、<!--） */
function isCommentLine(line) {
  const t = line.trim();
  if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('<!--')) return true;
  const i = line.indexOf('//');
  if (i >= 0) {
    const before = line.slice(0, i);
    // 排除 http:// 这类
    if (!/:\s*$/.test(before) && !/https?:$/.test(before.trim())) {
      // 命中的标识若出现在 // 之后，视为注释
      return true;
    }
  }
  return false;
}

function audit() {
  const files = collect();
  const results = [];

  for (const entry of MAP) {
    if (!entry.patterns.length) { results.push({ type: entry.type, used: false, hits: [] }); continue; }
    const hits = [];
    for (const f of files) {
      let src;
      try { src = fs.readFileSync(f, 'utf8'); } catch (e) { continue; }
      const lines = src.split('\n');
      for (const pat of entry.patterns) {
        for (const idx of findOccurrences(src, pat)) {
          const lineNo = src.slice(0, idx).split('\n').length;
          const raw = lines[lineNo - 1] || '';
          hits.push({
            file: path.relative(ROOT, f).replace(/\\/g, '/'),
            line: lineNo,
            api: pat,
            comment: isCommentLine(raw),
            text: raw.trim().slice(0, 100)
          });
        }
      }
    }
    const real = hits.filter((h) => !h.comment);
    results.push({ type: entry.type, used: real.length > 0, hits: real, commentOnly: hits.length > 0 && real.length === 0 });
  }
  return results;
}

function main() {
  const res = audit();
  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify(res, null, 2) + '\n');
    return;
  }

  console.log('=== 微信隐私接口审计（小程序代码） ===\n');
  const usedList = res.filter((r) => r.used);
  const commentOnly = res.filter((r) => r.commentOnly);

  console.log('★ 实际调用（后台需勾选）: ' + (usedList.length ? '' : '无'));
  for (const r of usedList) {
    console.log('\n  ✅ ' + r.type);
    const seen = new Set();
    for (const h of r.hits) {
      const k = h.file + ':' + h.line;
      if (seen.has(k)) continue;
      seen.add(k);
      console.log('     ' + h.file + ':' + h.line + '  [' + h.api + ']');
    }
  }

  if (commentOnly.length) {
    console.log('\n--- 仅出现在注释中的提及（不代表调用）---');
    for (const r of commentOnly) console.log('  · ' + r.type);
  }

  console.log('\n=== 汇总（可勾选项）===');
  const names = usedList.map((r) => r.type);
  console.log(names.length ? names.join(' / ') : '（无）');
}

main();
