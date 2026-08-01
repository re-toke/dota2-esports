/**
 * 数据访问层（阶段2-② / 阶段2-③）
 *
 * 封装对 curation_events / curation_teams / curation_meta 的查询与写操作。
 *
 * 约束：
 *   - 微信云开发数据库在 Web 端只能查询（读取），写操作需走云函数中转（阶段2-③ 实现）。
 *   - CloudBase JS SDK 单次 get() 最多返回 100 条，数据量小（61 + 23 条），用 limit(100) 显式声明。
 *   - 查询失败时抛出 Error，由调用方捕获处理。
 *   - 写操作统一经 aggregation 云函数的 adminWriteCuration action 中转，返回 { success, version, source }。
 */
import { app, db } from '@/cloudbase'

// ===== 查询操作（读，可直接用 CloudBase JS SDK）=====

/**
 * 查询全部赛事
 * @returns {Promise<Array>} 赛事数组
 */
export async function fetchEvents() {
  const res = await db.collection('curation_events').limit(100).get()
  return res.data || []
}

/**
 * 查询全部战队
 * @returns {Promise<Array>} 战队数组
 */
export async function fetchTeams() {
  const res = await db.collection('curation_teams').limit(100).get()
  return res.data || []
}

/**
 * 查询 curation_meta 单条记录（_id = 'ti_contestant_ids'）
 * @returns {Promise<Object|null>} meta 记录，无记录时返回 null
 */
export async function fetchMeta() {
  const res = await db
    .collection('curation_meta')
    .where({ _id: 'ti_contestant_ids' })
    .limit(1)
    .get()
  return (res.data && res.data[0]) || null
}

// ===== 写操作（阶段2-③：经云函数中转）=====
// Web 端无法直写云开发数据库，所有写操作统一调用 aggregation 云函数的
// adminWriteCuration action，由云函数完成 DB 写入 + version 重算 + admin-logs + L1 清空。

/**
 * 通用云函数写操作封装
 * @param {string} operation upsertEvent/upsertTeam/deleteEvent/deleteTeam/updateMeta
 * @param {object} params { data?, docId? }
 * @returns {Promise<{success:boolean, version:string, source:string}>}
 * @throws {Error} 云函数返回 error 或格式异常时抛错，message 为人类可读描述
 */
async function callAdminWrite(operation, params) {
  const res = await app.callFunction({
    name: 'aggregation',
    data: { action: 'adminWriteCuration', params: { operation, ...params } },
  })
  const r = res && res.result
  if (r && r.success) return r
  if (r && r.error) throw new Error(r.error.message || r.error.code || '写操作失败')
  throw new Error('写操作返回格式异常')
}

/**
 * 写赛事（新增/编辑）
 * @param {object} eventData 完整赛事对象（canonical 必填）
 * @returns {Promise<{success:boolean, version:string, source:string}>}
 */
export async function writeEvent(eventData) {
  return callAdminWrite('upsertEvent', { data: eventData })
}

/**
 * 删除赛事
 * @param {string} docId 归一化后的 _id
 * @returns {Promise<{success:boolean, version:string, source:string}>}
 */
export async function deleteEvent(docId) {
  return callAdminWrite('deleteEvent', { docId })
}

/**
 * 写战队（新增/编辑）
 * @param {object} teamData 完整战队对象（team_id 必填且为正整数）
 * @returns {Promise<{success:boolean, version:string, source:string}>}
 */
export async function writeTeam(teamData) {
  return callAdminWrite('upsertTeam', { data: teamData })
}

/**
 * 删除战队
 * @param {string} docId team_id 的字符串形式
 * @returns {Promise<{success:boolean, version:string, source:string}>}
 */
export async function deleteTeam(docId) {
  return callAdminWrite('deleteTeam', { docId })
}

/**
 * 更新 meta（TI 名单）
 * @param {number[]} ids 完整的 TI 参赛队 ID 数组（全量覆盖）
 * @returns {Promise<{success:boolean, version:string, source:string}>}
 */
export async function updateMeta(ids) {
  return callAdminWrite('updateMeta', { data: { ids } })
}

// ===== 工具函数 =====

/**
 * 规范名归一化（与 utils/consensus.js 的 normName 逻辑一致）
 * 转小写，仅保留 [a-z0-9 中文一-鿿 西里尔字母а-яё]，去掉一切分隔符与标点。
 * 例：'The International 2025' -> 'theinternational2025'
 * @param {string} name 原始名称
 * @returns {string} 归一化后的字符串
 */
export function normalizeEventName(name) {
  if (!name) return ''
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿а-яё]/g, '')
    .replace(/^the/, '')
}

/**
 * 计算数据指纹（MD5 前 8 位）
 * 与 scripts/migrate-curation-to-db.js 的 computeVersion 逻辑一致，
 * 用于客户端判断是否需要增量更新。
 *
 * @param {Array} events 赛事数组（来自 DB 查询）
 * @param {Array} teams 战队数组（来自 DB 查询）
 * @param {Array<number>} tiIds TI 参赛队 ID 数组
 * @returns {string} 8 位十六进制指纹
 */
export function versionFromData(events, teams, tiIds) {
  const safeEvents = events || []
  const safeTeams = teams || []
  const safeTiIds = tiIds || []
  // migrate 脚本中 teams 是对象（按 team_id 索引），这里 teams 是数组（来自 DB）。
  // 取 _id 字段作为 team_id 集合，与 Object.keys(teams) 等价。
  const teamIds = safeTeams.map((t) => t._id).filter(Boolean).sort()
  const payload = {
    eventsCount: safeEvents.length,
    teamsCount: safeTeams.length,
    tiIdsCount: safeTiIds.length,
    eventsCanonical: safeEvents.map((e) => e.canonical).filter(Boolean).sort().join(','),
    teamsIds: teamIds.join(','),
  }
  return md5(JSON.stringify(payload)).slice(0, 8)
}

// ===== 浏览器端 MD5 实现 =====
// Web 端无 Node crypto 模块，需自实现以与 migrate 脚本（Node crypto.createHash('md5')）结果一致。
// 采用 Paul Johnston 的 RFC 1321 实现（BSD License），广泛使用且与 Node crypto 输出一致。

/*
 * A JavaScript implementation of the RSA Data Security, Inc. MD5 Message
 * Digest Algorithm, as defined in RFC 1321.
 * Version 2.2 Copyright (C) Paul Johnston 1999 - 2009
 * Other contributors: Greg Holt, Andrew Kepert, Ydnar, Lostinet
 * Distributed under the BSD License
 * See http://pajhome.org.uk/crypt/md5 for more info.
 */
function safeAdd(x, y) {
  const lsw = (x & 0xffff) + (y & 0xffff)
  const msw = (x >> 16) + (y >> 16) + (lsw >> 16)
  return (msw << 16) | (lsw & 0xffff)
}

function bitRol(num, cnt) {
  return (num << cnt) | (num >>> (32 - cnt))
}

function md5cmn(q, a, b, x, s, t) {
  return safeAdd(bitRol(safeAdd(safeAdd(a, q), safeAdd(x, t)), s), b)
}

function md5ff(a, b, c, d, x, s, t) {
  return md5cmn((b & c) | (~b & d), a, b, x, s, t)
}

function md5gg(a, b, c, d, x, s, t) {
  return md5cmn((b & d) | (c & ~d), a, b, x, s, t)
}

function md5hh(a, b, c, d, x, s, t) {
  return md5cmn(b ^ c ^ d, a, b, x, s, t)
}

function md5ii(a, b, c, d, x, s, t) {
  return md5cmn(c ^ (b | ~d), a, b, x, s, t)
}

function binlMD5(x, len) {
  x[len >> 5] |= 0x80 << len % 32
  x[(((len + 64) >>> 9) << 4) + 14] = len

  let i
  let olda
  let oldb
  let oldc
  let oldd
  let a = 1732584193
  let b = -271733879
  let c = -1732584194
  let d = 271733878

  for (i = 0; i < x.length; i += 16) {
    olda = a
    oldb = b
    oldc = c
    oldd = d

    a = md5ff(a, b, c, d, x[i], 7, -680876936)
    d = md5ff(d, a, b, c, x[i + 1], 12, -389564586)
    c = md5ff(c, d, a, b, x[i + 2], 17, 606105819)
    b = md5ff(b, c, d, a, x[i + 3], 22, -1044525330)
    a = md5ff(a, b, c, d, x[i + 4], 7, -176418897)
    d = md5ff(d, a, b, c, x[i + 5], 12, 1200080426)
    c = md5ff(c, d, a, b, x[i + 6], 17, -1473231341)
    b = md5ff(b, c, d, a, x[i + 7], 22, -45705983)
    a = md5ff(a, b, c, d, x[i + 8], 7, 1770035416)
    d = md5ff(d, a, b, c, x[i + 9], 12, -1958414417)
    c = md5ff(c, d, a, b, x[i + 10], 17, -42063)
    b = md5ff(b, c, d, a, x[i + 11], 22, -1990404162)
    a = md5ff(a, b, c, d, x[i + 12], 7, 1804603682)
    d = md5ff(d, a, b, c, x[i + 13], 12, -40341101)
    c = md5ff(c, d, a, b, x[i + 14], 17, -1502002290)
    b = md5ff(b, c, d, a, x[i + 15], 22, 1236535329)

    a = md5gg(a, b, c, d, x[i + 1], 5, -165796510)
    d = md5gg(d, a, b, c, x[i + 6], 9, -1069501632)
    c = md5gg(c, d, a, b, x[i + 11], 14, 643717713)
    b = md5gg(b, c, d, a, x[i], 20, -373897302)
    a = md5gg(a, b, c, d, x[i + 5], 5, -701558691)
    d = md5gg(d, a, b, c, x[i + 10], 9, 38016083)
    c = md5gg(c, d, a, b, x[i + 15], 14, -660478335)
    b = md5gg(b, c, d, a, x[i + 4], 20, -405537848)
    a = md5gg(a, b, c, d, x[i + 9], 5, 568446438)
    d = md5gg(d, a, b, c, x[i + 14], 9, -1019803690)
    c = md5gg(c, d, a, b, x[i + 3], 14, -187363961)
    b = md5gg(b, c, d, a, x[i + 8], 20, 1163531501)
    a = md5gg(a, b, c, d, x[i + 13], 5, -1444681467)
    d = md5gg(d, a, b, c, x[i + 2], 9, -51403784)
    c = md5gg(c, d, a, b, x[i + 7], 14, 1735328473)
    b = md5gg(b, c, d, a, x[i + 12], 20, -1926607734)

    a = md5hh(a, b, c, d, x[i + 5], 4, -378558)
    d = md5hh(d, a, b, c, x[i + 8], 11, -2022574463)
    c = md5hh(c, d, a, b, x[i + 11], 16, 1839030562)
    b = md5hh(b, c, d, a, x[i + 14], 23, -35309556)
    a = md5hh(a, b, c, d, x[i + 1], 4, -1530992060)
    d = md5hh(d, a, b, c, x[i + 4], 11, 1272893353)
    c = md5hh(c, d, a, b, x[i + 7], 16, -155497632)
    b = md5hh(b, c, d, a, x[i + 10], 23, -1094730640)
    a = md5hh(a, b, c, d, x[i + 13], 4, 681279174)
    d = md5hh(d, a, b, c, x[i], 11, -358537222)
    c = md5hh(c, d, a, b, x[i + 3], 16, -722521979)
    b = md5hh(b, c, d, a, x[i + 6], 23, 76029189)
    a = md5hh(a, b, c, d, x[i + 9], 4, -640364487)
    d = md5hh(d, a, b, c, x[i + 12], 11, -421815835)
    c = md5hh(c, d, a, b, x[i + 15], 16, 530742520)
    b = md5hh(b, c, d, a, x[i + 2], 23, -995338651)

    a = md5ii(a, b, c, d, x[i], 6, -198630844)
    d = md5ii(d, a, b, c, x[i + 7], 10, 1126891415)
    c = md5ii(c, d, a, b, x[i + 14], 15, -1416354905)
    b = md5ii(b, c, d, a, x[i + 5], 21, -57434055)
    a = md5ii(a, b, c, d, x[i + 12], 6, 1700485571)
    d = md5ii(d, a, b, c, x[i + 3], 10, -1894986606)
    c = md5ii(c, d, a, b, x[i + 10], 15, -1051523)
    b = md5ii(b, c, d, a, x[i + 1], 21, -2054922799)
    a = md5ii(a, b, c, d, x[i + 8], 6, 1873313359)
    d = md5ii(d, a, b, c, x[i + 15], 10, -30611744)
    c = md5ii(c, d, a, b, x[i + 6], 15, -1560198380)
    b = md5ii(b, c, d, a, x[i + 13], 21, 1309151649)
    a = md5ii(a, b, c, d, x[i + 4], 6, -145523070)
    d = md5ii(d, a, b, c, x[i + 11], 10, -1120210379)
    c = md5ii(c, d, a, b, x[i + 2], 15, 718787259)
    b = md5ii(b, c, d, a, x[i + 9], 21, -343485551)

    a = safeAdd(a, olda)
    b = safeAdd(b, oldb)
    c = safeAdd(c, oldc)
    d = safeAdd(d, oldd)
  }
  return [a, b, c, d]
}

function binl2rstr(input) {
  let i
  let output = ''
  const length32 = input.length * 32
  for (i = 0; i < length32; i += 8) {
    output += String.fromCharCode((input[i >> 5] >>> i % 32) & 0xff)
  }
  return output
}

function rstr2binl(input) {
  let i
  const output = []
  output[(input.length >> 2) - 1] = undefined
  for (i = 0; i < output.length; i += 1) {
    output[i] = 0
  }
  const length8 = input.length * 8
  for (i = 0; i < length8; i += 8) {
    output[i >> 5] |= (input.charCodeAt(i % input.length) & 0xff) << i % 32
  }
  return output
}

function rstrMD5(s) {
  return binl2rstr(binlMD5(rstr2binl(s), s.length * 8))
}

function rstr2hex(input) {
  const hexTab = '0123456789abcdef'
  let i
  let output = ''
  for (i = 0; i < input.length; i += 1) {
    const x = input.charCodeAt(i)
    output += hexTab.charAt((x >>> 4) & 0x0f) + hexTab.charAt(x & 0x0f)
  }
  return output
}

function str2rstrUTF8(input) {
  return unescape(encodeURIComponent(input))
}

/**
 * 计算字符串的 MD5 哈希（十六进制小写），与 Node crypto.createHash('md5') 输出一致。
 * @param {string} str 输入字符串（UTF-8）
 * @returns {string} 32 位十六进制 MD5
 */
function md5(str) {
  return rstr2hex(rstrMD5(str2rstrUTF8(String(str))))
}
