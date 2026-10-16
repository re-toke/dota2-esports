/**
 * 数据访问层（阶段2-⑤：云开发 → Supabase）
 *
 * 由 api/cloudbase.js 直接 re-export（文件名保留以兼容 3 个视图的既有 import）。
 *
 * ## 读：PostgREST 直连（anon key）
 *   · curation_* 三表已有 anon 读策略
 *   · ★ 用 Range 头分页 —— PostgREST 单次有 max-rows 上限（默认 1000），
 *     超过会**静默截断**（CloudBase 是单次 100 条，同类问题）
 *   · 形状适配：Supabase 返回 { canonical_key, league_id, data }
 *     → 统一转成 { _id, ...业务字段 }，与视图原有期望一致
 *
 * ## 写：经 EF admin-write 中转（管理令牌鉴权）
 *   · **不能**用 service key（浏览器会暴露 + 绕过 RLS）
 *   · 令牌放 admin/.env.local 的 VITE_ADMIN_TOKEN；EF 侧用 ADMIN_TOKEN secret
 *   · 返回 { success, version, source }，与云函数时期契约一致
 */
const BASE = import.meta.env.VITE_SUPABASE_URL
const ANON = import.meta.env.VITE_SUPABASE_ANON_KEY
const TOKEN = import.meta.env.VITE_ADMIN_TOKEN

if (!BASE || !ANON) {
  // 不抛错（避免整页白屏），仅在控制台提示配置方式
  console.warn('[admin] 缺少 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY，数据将无法加载。')
}

const authHeaders = () => ({
  apikey: ANON,
  Authorization: `Bearer ${ANON}`,
})

/** 分页读全量（绕过 PostgREST 单次上限） */
async function restAll(table, select, extraQuery = '') {
  const PAGE = 1000
  const q = `${BASE}/rest/v1/${table}?select=${encodeURIComponent(select)}${extraQuery}`
  const pageUrl = (off) => `${q}&limit=${PAGE}&offset=${off}`

  // ★ 2026-10-16：分页由 **`Range` 请求头** 改为 **`limit`/`offset` 查询参数**。
  //   原因：admin 可经**中转** `/sb` 读取（国内可用），而实测中转 **不转发 `Range` 头**
  //   （送 `Range: 1000-1001` 仍回 `content-range: 0-999/3683`）⇒ 用 Range 会拿到重复/错误页。
  //   ✓ `limit`/`offset` 是 query 参数，中转按 `url.search` 原样转发（已验证）。
  //
  // ★★ 2026-10-16（**并行化**，修「Events 首屏 ~30s」）：原实现**串行**翻页，
  //   实测经中转 4 页各 2.4~13.6s ⇒ 合计 ~30s，用户会先看到「Total 0」（promise 未 resolve）。
  //   改为：**第 1 页带 `Prefer: count=exact`** 拿总数（`Content-Range: 0-999/3683`，
  //   中转会转发 `Prefer` 且 `Content-Range` 已在 CORS 暴露头里）⇒ 剩余页**并行**取，
  //   总耗时 ≈ 单页最慢者（~14s 冷 / 缓存后 <1s），而非各页之和。
  const first = await fetch(pageUrl(0), { headers: { ...authHeaders(), Prefer: 'count=exact' } })
  if (!first.ok) throw new Error(`REST ${table} HTTP ${first.status}: ${(await first.text()).slice(0, 200)}`)
  const firstRows = (await first.json()) || []
  const out = [...firstRows]
  // 总数未知（`*`）或首页未满 ⇒ 只有一页
  const total = Number(((first.headers.get('Content-Range') || '').split('/')[1] || '').trim()) || 0
  if (firstRows.length < PAGE || total <= PAGE) return out

  const rest = []
  for (let off = PAGE; off < Math.min(total, 50000); off += PAGE) {
    rest.push(
      fetch(pageUrl(off), { headers: authHeaders() }).then(async (res) => {
        if (!res.ok) throw new Error(`REST ${table} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
        return (await res.json()) || []
      })
    )
  }
  const pages = await Promise.all(rest)   // 保持顺序（Promise.all 按入参序）
  pages.forEach((rows) => out.push(...rows))
  return out
}

// ===== 查询操作（读）=====

/**
 * ★ 2026-10-16：**赛事列表服务端分页**（修「Events 首屏 ~24s」）。
 *   原实现把**全部 3683 行**（含完整 `data`，≈1.3MB / 4 页）拉回前端再客户端搜索+分页
 *   ⇒ 经中转冷缓存 ~24s。改为**服务端分页**：每次只取当前页（20 行 ≈6.6KB / ~1.9s）。
 *
 *   关键词搜索**在服务端做**，且**同时覆盖规范名与别名**（`or` 两条件）：
 *     · 规范名：`canonical_key.ilike.*<规范化关键词>*`（与键同口径，走 `normalizeEventName`）；
 *     · 别名：  `data->>aliases.ilike.*<原词小写>*` —— `aliases` 是 jsonb 数组，`->>` 取其 **JSON 文本**
 *       （保留原始写法如 `["EPL Masters 2026"]`）⇒ 用**保留空格的原词**匹配（大小写不敏感）。
 *
 *   ★★ 关键坑（曾误判为「PostgREST 不支持 jsonb 路径」）：`->>` 中的 `>` **必须 URL 编码成 `%3E%3E`**；
 *      裸 `>>` 会被 shell / URL 层吞掉 ⇒ 服务端报 400 或匹配不到。实测 `%3E%3E` 形式**完全可用**。
 *   ⚠️ `or=(...)` 内不得出现 `,` `(` `)` `*`（`*` 是 PostgREST 通配符）⇒ 关键词统一剔除这些字符。
 *   · `order=canonical_key.asc` **必需**：无序分页会漏行/重复行。
 *
 * @returns {Promise<{rows: Array, total: number}>} rows 形状同 fetchEvents（{ _id, ...业务字段 }）
 */
// 关键词 → PostgREST `or` 过滤串（规范名 + 别名两种口径）
function eventSearchFilter(keyword) {
  const raw = String(keyword || '').trim()
  if (!raw) return ''
  // 剔除 `or` 语法字符与通配符，再按 URL 编码（中文等会被编码，PostgREST 侧自动解码）
  const esc = (s) => encodeURIComponent(String(s).replace(/[,()*]/g, '').trim())
  const parts = []
  const norm = normalizeEventName(raw)
  if (norm) parts.push(`canonical_key.ilike.*${esc(norm)}*`)
  const rawLower = raw.toLowerCase()
  if (rawLower) parts.push(`data-%3E%3Ealiases.ilike.*${esc(rawLower)}*`)
  return parts.length ? `&or=(${parts.join(',')})` : ''
}

export async function fetchEventsPage({ limit = 20, offset = 0, keyword = '' } = {}) {
  const filter = eventSearchFilter(keyword)
  const url = `${BASE}/rest/v1/curation_events?select=canonical_key,data&limit=${limit}&offset=${offset}&order=canonical_key.asc${filter}`
  const res = await fetch(url, { headers: { ...authHeaders(), Prefer: 'count=exact' } })
  if (!res.ok) throw new Error(`REST curation_events HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const rows = (await res.json()) || []
  // 总数取自 `Content-Range`（如 `0-19/3683` 的 3683）；`*` 时回 0（前端据此显示未知）
  const total = Number(((res.headers.get('Content-Range') || '').split('/')[1] || '').trim()) || 0
  return { rows: rows.map((r) => ({ _id: r.canonical_key, ...(r.data || {}) })), total }
}

/**
 * 查询全部赛事
 * @returns {Promise<Array>} 赛事数组（形状 { _id, ...业务字段 }）
 */
export async function fetchEvents() {
  const rows = await restAll('curation_events', 'canonical_key,league_id,data')
  return rows.map((r) => ({ _id: r.canonical_key, ...(r.data || {}) }))
}

/**
 * 查询全部战队
 * @returns {Promise<Array>} 战队数组（形状 { _id, team_id, ...业务字段 }）
 */
export async function fetchTeams() {
  const rows = await restAll('curation_teams', 'team_id,data')
  return rows.map((r) => ({ _id: String(r.team_id), team_id: r.team_id, ...(r.data || {}) }))
}

/**
 * 查询 curation_meta 单条记录（key = 'ti_contestant_ids'）
 * @returns {Promise<Object|null>} { _id, ...value } 或 null
 */
export async function fetchMeta() {
  const url = `${BASE}/rest/v1/curation_meta?select=key,value&key=eq.ti_contestant_ids&limit=1`
  const res = await fetch(url, { headers: authHeaders() })
  if (!res.ok) throw new Error(`REST curation_meta HTTP ${res.status}`)
  const rows = await res.json()
  const row = rows && rows[0]
  if (!row) return null
  return { _id: row.key, ...(row.value || {}) }
}

/**
 * ★ 2026-10-16：**version 改由服务端/CI 计算，前端只读展示**
 *
 * 数据源：`curation_meta` 的 `key = 'version'` 行 —— EF `admin-write` 在**每次成功写入**后
 * upsert `{ v: Date.now() }`（覆盖 upsertEvent / deleteEvent / upsertTeam / deleteTeam / updateMeta
 * 全部变更类型）；CI 侧批量导入（`scripts/sync/migrate-curation-to-db.js`）会写 `data.updatedAt`，
 * 由客户端「廉价探针」的 events-max-updatedAt 兜底覆盖。
 *
 * ⚠️ 历史：本页原先有「重新计算 version」按钮，需先 `fetchEvents()`（全量 3683 行 ≈1.3MB / 经中转 ~10-14s）
 *   再本地 MD5 求指纹（`versionFromData`）。该 fingerprint **无任何消费方**（小程序 `remoteCuration`
 *   自算内容指纹，不读该字段）⇒ 为避免这个纯派生值的全量拉取，**已彻底移除客户端计算与 MD5 实现**。
 *
 * @returns {Promise<number|null>} 服务端版本时间戳（ms）；该行不存在时返回 null
 */
export async function fetchCurationVersion() {
  const url = `${BASE}/rest/v1/curation_meta?select=key,value&key=eq.version&limit=1`
  const res = await fetch(url, { headers: authHeaders() })
  if (!res.ok) throw new Error(`REST curation_meta(version) HTTP ${res.status}`)
  const rows = await res.json()
  const row = rows && rows[0]
  const v = row && row.value && row.value.v
  return v != null ? Number(v) : null
}

// ===== 写操作（经 EF 中转）=====
// Web 端无写权限（RLS 只给了读），统一 POST 到 EF admin-write，
// 由 EF 用服务端 service key 完成写入 + 写 admin_logs。

/**
 * 调 EF admin-write
 * @param {string} operation upsertEvent / deleteEvent / upsertTeam / deleteTeam / updateMeta
 * @param {object} params { data?, docId? }
 * @returns {Promise<{success:boolean, version:string, source:string}>}
 */
async function callAdminWrite(operation, params) {
  if (!TOKEN) throw new Error('缺少 VITE_ADMIN_TOKEN（管理令牌）。请在 admin/.env.local 配置后重启 dev server。')
  const res = await fetch(`${BASE}/functions/v1/admin-write`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json', 'x-admin-token': TOKEN },
    body: JSON.stringify({ operation, params }),
  })
  if (res.status === 401) throw new Error('管理令牌无效（EF 侧 ADMIN_TOKEN 与前端 VITE_ADMIN_TOKEN 不一致）')
  let r = null
  try { r = await res.json() } catch { /* 非 JSON */ }
  if (r && r.success) return r
  if (r && r.error) throw new Error(r.error.message || r.error.code || '写操作失败')
  throw new Error(`写操作失败 HTTP ${res.status}`)
}

/** 写赛事（新增/编辑） */
export async function writeEvent(eventData) {
  return callAdminWrite('upsertEvent', { data: eventData })
}

/** 删除赛事（docId = 归一化后的 canonical_key） */
export async function deleteEvent(docId) {
  return callAdminWrite('deleteEvent', { docId })
}

/** 写战队（新增/编辑） */
export async function writeTeam(teamData) {
  return callAdminWrite('upsertTeam', { data: teamData })
}

/** 删除战队（docId = team_id 的字符串形式） */
export async function deleteTeam(docId) {
  return callAdminWrite('deleteTeam', { docId })
}

/**
 * 更新 meta（TI 参赛队 id 列表等）
 * ★ 2026-10-12（P1-12）：EF 侧 key 已**参数化**（原先硬编码 ti_contestant_ids ⇒ 传其它 key 会静默写坏该行）。
 *   key 默认值放在**调用层**（视图用的就是这个 key），EF 不再隐式兜底。
 * @param {*} value 要写入的 meta 值（TI 参赛队 id 列表）
 * @param {string} [key] curation_meta 主键
 */
export async function updateMeta(value, key = 'ti_contestant_ids') {
  return callAdminWrite('updateMeta', { key, value })
}

// ===== 纯函数工具（从原 api/cloudbase.js 原样沿用，供视图直接使用）=====
// 说明：这两个函数原本就在 api 层导出，Events/Meta 的视图/弹窗在用，故一并迁移。

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
