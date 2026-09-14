// 设置（二级页）2026-09-14
// 从「我的」页下沉：云同步说明 / 提醒策略（提前量·级别）/ 数据管理 / 关于。
//
// 设计要点：
//   · 云同步**开关**仍留在「我的」页（此处只读展示状态 + 说明）——避免两处重复实现
//     enable/disable 的复杂分支（弹窗/失败兜底/恢复关注）。
//   · 提醒策略改动后**立即上传**（若已开启云同步）：原实现在「我的」页 onShow 才
//     syncProfile，若用户改完提前量直接退出 App，服务端策略会陈旧 → 推送时机错误。
const subscribe = require('../../../utils/subscribe.js');
const cloudSync = require('../../../utils/cloudSync.js');
const storageReset = require('../../../utils/storageReset.js');
const reminderStrategy = require('../../../utils/reminderStrategy.js');
const follow = require('../../../utils/follow.js');

/** 读取小程序版本号；开发态/低版本基础库取不到时回退到 package.json 版本 */
function readAppVersion() {
  try {
    const info = wx.getAccountInfoSync && wx.getAccountInfoSync();
    const v = info && info.miniProgram && info.miniProgram.version;
    if (v) return v;
  } catch (e) { /* 忽略：取不到就用兜底值 */ }
  return '1.1.2';
}

/** 相对时间文案（与「我的」页同款） */
function formatLastSync(ts) {
  if (!ts) return '';
  const min = Math.floor((Date.now() - ts) / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return min + ' 分钟前';
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + ' 小时前';
  return Math.floor(hr / 24) + ' 天前';
}

/** 提醒级别选项：在 JS 侧预计算 selected，避免 WXML 内 indexOf 不随 setData 重算 */
function buildTierOptions(tiers) {
  const cur = tiers || [];
  return reminderStrategy.TIER_OPTIONS.map((t) => ({
    grade: t.grade,
    label: t.label,
    selected: cur.indexOf(t.grade) >= 0
  }));
}

Page({
  data: {
    sync: { enabled: false, status: 'off', lastSyncText: '' },
    reminder: { leadSec: 1800, tiers: ['S', 'A'] },
    leadOptions: reminderStrategy.LEAD_OPTIONS,
    tierOptions: buildTierOptions(['S', 'A']),
    appVersion: '1.1.2'
  },

  onLoad() {
    this.setData({ appVersion: readAppVersion() });
  },

  onShow() {
    this._refreshSyncState();
    this._applyReminder(reminderStrategy.getStrategy());
  },

  // ===== 云同步（只读展示） =====
  _refreshSyncState() {
    const s = cloudSync.getState();
    this.setData({
      sync: {
        enabled: s.enabled,
        status: s.status,
        lastSyncText: formatLastSync(s.lastSyncAt)
      }
    });
  },

  /** 把关注战队 + 当前策略上传云端（仅在已开启云同步时） */
  _syncProfile() {
    if (!cloudSync.isEnabled()) return;
    const teams = follow.list('teams') || [];
    const teamIds = teams.map((t) => String(t.id));
    const teamItems = teams.map((t) => ({ id: t.id, name: t.name, logo: t.logo }));
    subscribe.saveFollowProfile(teamIds, this.data.reminder, undefined, teamItems)
      .then(() => this._refreshSyncState())
      .catch(() => this._refreshSyncState());
  },

  // ===== 提醒策略 =====
  _applyReminder(reminder) {
    this.setData({
      reminder,
      tierOptions: buildTierOptions(reminder && reminder.tiers)
    });
  },

  onLeadChange(e) {
    const sec = Number(e.currentTarget.dataset.sec);
    const s = reminderStrategy.setStrategy(Object.assign({}, this.data.reminder, { leadSec: sec }));
    this.setData({ reminder: s });
    this._syncProfile();
  },

  onTierToggle(e) {
    const grade = e.currentTarget.dataset.grade;
    if (!grade) return;
    const cur = (this.data.reminder.tiers || []).slice();
    const idx = cur.indexOf(grade);
    if (idx >= 0) cur.splice(idx, 1); else cur.push(grade);
    if (!cur.length) cur.push(grade); // 至少保留一个级别
    const s = reminderStrategy.setStrategy(Object.assign({}, this.data.reminder, { tiers: cur }));
    this._applyReminder(s);
    this._syncProfile();
  },

  // ===== 数据管理 =====
  //   ① 只清缓存（保留关注/资料/凭证/同步开关）
  //   ② 删除云端数据（恒定可用 —— 专治「同步已关但云端仍有数据」的孤儿）
  //   ③ 重置全部：先删云端 → 成功才清本机（顺序不可颠倒）
  //   ④ 重设头像与昵称（仅本机资料）
  onClearCache() {
    wx.showModal({
      title: '清除本机缓存',
      content: '仅清除赛事数据缓存与搜索历史，不影响你的关注、资料与登录状态。',
      confirmText: '清除',
      success: (res) => {
        if (!res.confirm) return;
        const r = storageReset.clearCacheOnly();
        wx.showToast({ title: '已清除 ' + r.removed + ' 项缓存', icon: 'none' });
      }
    });
  },

  onDeleteCloud() {
    wx.showModal({
      title: '删除云端数据',
      content: '将删除云端保存的关注与提醒数据。本机数据不受影响。删除后换设备将无法恢复。',
      confirmText: '删除',
      confirmColor: '#E8443B',
      success: (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: '删除中…', mask: true });
        cloudSync.deleteCloudData().then((r) => {
          wx.hideLoading();
          this._refreshSyncState();
          wx.showToast({ title: r.ok ? '云端数据已删除' : '删除失败，请检查网络后重试', icon: 'none' });
        });
      }
    });
  },

  onResetAll() {
    const hasCloud = cloudSync.getState().enabled;
    wx.showModal({
      title: '重置全部数据',
      content: hasCloud
        ? '将删除云端数据，并清空本机的关注、资料与登录状态。此操作不可撤销。'
        : '将清空本机的关注、资料与登录状态。此操作不可撤销。',
      confirmText: '重置全部',
      confirmColor: '#E8443B',
      success: (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: '处理中…', mask: true });
        storageReset.resetAll().then((r) => {
          wx.hideLoading();
          if (!r.ok) {
            // 云端删除失败 → 中止，不清本机（避免制造新的不一致）
            wx.showModal({
              title: '未能完成',
              content: '云端数据删除失败（可能是网络问题），为避免数据状态不一致，本机数据未清除。请稍后重试。',
              showCancel: false,
              confirmText: '知道了'
            });
            return;
          }
          this._refreshSyncState();
          wx.showToast({ title: '已重置', icon: 'success' });
        });
      }
    });
  },

  onProfileReset() {
    wx.showModal({
      title: '重置头像与昵称',
      content: '将清除本机保存的头像与昵称（不影响关注与提醒）。',
      confirmText: '重置',
      success: (res) => {
        if (!res.confirm) return;
        try { wx.removeStorageSync('user_profile'); } catch (e) { /* 忽略 */ }
        wx.showToast({ title: '已重置', icon: 'success' });
      }
    });
  },

  // ===== 关于 =====
  openPrivacy() {
    wx.navigateTo({ url: '/subpackages/detail/privacy/privacy' });
  }
});
