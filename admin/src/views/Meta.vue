<script setup>
/**
 * TI 名单管理页（阶段2-② / 阶段2-③）
 *
 * - 展示 curation_meta 的 version / count / updatedAt。
 * - 展示 tiContestantIds 列表（可搜索、可删除单个 ID）。
 * - 添加 / 删除 team_id 经 **EF admin-write** 的 `updateMeta`（全量覆盖 ids）写入，version 由 EF 自动维护。
 *
 * ★ 2026-10-16（性能 + 架构）：**version 由服务端/CI 计算，本页只读展示** ——
 *   ① 原「重新计算 version」按钮需先 `fetchEvents()`（全量 3683 行 ≈1.3MB / 经中转 ~10-14s）+ `fetchTeams()`
 *      再本地 MD5 求指纹，**首屏被拖到十几秒**。该指纹**无任何消费方**（小程序 `remoteCuration` 自算内容指纹）
 *      ⇒ 现**彻底移除**该按钮、全量拉取与客户端 MD5 计算。
 *   ② 版本号改读 `curation_meta` 的 `key='version'` 行 —— 由 EF `admin-write` 在**每次成功写入**后
 *      upsert `{ v: Date.now() }`（服务端计算，覆盖 upsert/delete/updateMeta 全部变更类型）。
 *   ⇒ 本页只发 2 个「单行读」请求（`curation_meta` 的 `ti_contestant_ids` + `version`），**不再触碰 events/teams**。
 */
import { ref, computed, onMounted } from 'vue'
import { fetchMeta, fetchCurationVersion, updateMeta } from '@/api/cloudbase'

// ===== 数据状态 =====
const meta = ref(null)
// 服务端版本时间戳（ms，来自 curation_meta.key='version'，由 EF 每次写入后 bump）
const serverVersion = ref(null)
const loading = ref(false)
// ID 写操作进行中（控制添加按钮 loading，与页面 loading 区分）
const idSaving = ref(false)

// 搜索与新增
const idKeyword = ref('')
const newId = ref('')

// ===== 工具函数 =====
// 时间戳（ms）→ YYYY-MM-DD HH:mm
function formatMs(ms) {
  if (!ms) return '-'
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${y}-${m}-${day} ${hh}:${mm}`
}

// 当前 ids（数字数组）
const tiIds = computed(() => {
  if (!meta.value || !Array.isArray(meta.value.ids)) return []
  return meta.value.ids.map((x) => Number(x))
})

// 搜索过滤后的 ids
const filteredIds = computed(() => {
  const kw = idKeyword.value.trim().toLowerCase()
  const ids = tiIds.value
  if (!kw) return ids
  return ids.filter((x) => String(x).includes(kw))
})

// 取 meta 的「值对象」（去掉 _id 包装），用于写回时保留 version / updatedAt 等既有字段
function metaValueOf(m) {
  if (!m || typeof m !== 'object') return {}
  const v = { ...m }
  delete v._id
  return v
}

// ===== 查询 =====
// 只发 2 个单行读：ti_contestant_ids 行 + version 行（不再拉全量 events/teams）
async function loadMeta() {
  loading.value = true
  try {
    const [m, v] = await Promise.all([fetchMeta(), fetchCurationVersion()])
    meta.value = m
    serverVersion.value = v
  } catch (e) {
    ElMessage.error('查询 meta 数据失败：' + (e.message || e))
    meta.value = null
    serverVersion.value = null
  } finally {
    loading.value = false
  }
}

// ===== 写操作（经 EF admin-write 中转）=====
// 添加 team_id：将新 ID 追加到当前 ids 后整体提交（updateMeta 为全量覆盖）
async function handleAddId() {
  const v = newId.value.trim()
  if (!v) return
  if (!/^\d+$/.test(v)) {
    ElMessage.error('请输入数字 team_id')
    return
  }
  const num = Number(v)
  if (tiIds.value.includes(num)) {
    ElMessage.warning('该 team_id 已存在')
    return
  }
  const nextIds = [...tiIds.value, num]
  idSaving.value = true
  try {
    // ★ 写回「值对象」而非裸数组：保留既有字段（version 等），只覆盖 ids / count / updatedAt
    const nextValue = { ...metaValueOf(meta.value), ids: nextIds, count: nextIds.length, updatedAt: Date.now() }
    await updateMeta(nextValue)
    ElMessage.success('已添加 team_id：' + num)
    newId.value = ''
    await loadMeta()
  } catch (e) {
    ElMessage.error('添加 team_id 失败：' + (e.message || e))
  } finally {
    idSaving.value = false
  }
}

// 删除单个 ID：从 ids 中移除后整体提交
async function handleDeleteId(id) {
  const nextIds = tiIds.value.filter((x) => x !== id)
  idSaving.value = true
  try {
    const nextValue = { ...metaValueOf(meta.value), ids: nextIds, count: nextIds.length, updatedAt: Date.now() }
    await updateMeta(nextValue)
    ElMessage.success('已删除 team_id：' + id)
    await loadMeta()
  } catch (e) {
    ElMessage.error('删除 team_id 失败：' + (e.message || e))
  } finally {
    idSaving.value = false
  }
}

onMounted(loadMeta)
</script>

<template>
  <div class="page" v-loading="loading">
    <div class="page-header">
      <h2 class="page-title">TI 名单管理</h2>
      <div class="page-actions">
        <el-button @click="loadMeta" :loading="loading">
          <el-icon><Refresh /></el-icon>
          刷新
        </el-button>
      </div>
    </div>

    <el-alert
      class="write-tip"
      title="写操作提示"
      type="info"
      :closable="false"
      description="新增 / 删除 team_id 经 EF admin-write 的 updateMeta 全量覆盖写入；version 由服务端在每次写入后自动 bump，并记录 admin-logs。"
      show-icon
    />

    <!-- meta 概览 -->
    <el-descriptions :column="3" border title="curation_meta 概览" class="meta-desc">
      <el-descriptions-item label="_id">
        {{ meta && meta._id ? meta._id : 'ti_contestant_ids' }}
      </el-descriptions-item>
      <el-descriptions-item label="version（服务端）">
        <el-tag v-if="serverVersion" type="success">{{ formatMs(serverVersion) }}</el-tag>
        <span v-else>-</span>
      </el-descriptions-item>
      <el-descriptions-item label="count">
        {{ meta ? meta.count : '-' }}
      </el-descriptions-item>
      <el-descriptions-item label="updatedAt">
        {{ meta ? formatMs(meta.updatedAt) : '-' }}
      </el-descriptions-item>
      <el-descriptions-item label="ids 总数">
        {{ tiIds.length }}
      </el-descriptions-item>
    </el-descriptions>

    <!-- TI 参赛队 ID 列表 -->
    <div class="section-title">TI 参赛队 ID 列表</div>

    <div class="id-toolbar">
      <el-input
        v-model="idKeyword"
        placeholder="搜索 team_id"
        clearable
        class="id-search"
      >
        <template #prefix>
          <el-icon><Search /></el-icon>
        </template>
      </el-input>
      <el-input
        v-model="newId"
        placeholder="输入新 team_id"
        class="id-new"
        @keyup.enter="handleAddId"
      />
      <el-button type="primary" :loading="idSaving" @click="handleAddId">
        <el-icon><Plus /></el-icon>
        添加
      </el-button>
    </div>

    <div class="id-list">
      <el-empty v-if="filteredIds.length === 0" description="暂无 ID 数据" />
      <div v-else class="id-chips">
        <el-tag
          v-for="id in filteredIds"
          :key="id"
          class="id-chip"
          closable
          @close="handleDeleteId(id)"
        >
          {{ id }}
        </el-tag>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page {
  background: #fff;
  border-radius: 4px;
  padding: 20px;
  min-height: calc(100vh - 140px);
}

.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}

.page-title {
  margin: 0;
  font-size: 18px;
  color: #303133;
}

.page-actions {
  display: flex;
  gap: 12px;
}

.write-tip {
  margin-bottom: 16px;
}

.meta-desc {
  margin-bottom: 24px;
}

.section-title {
  font-size: 15px;
  font-weight: 600;
  color: #303133;
  margin-bottom: 12px;
}

.id-toolbar {
  display: flex;
  gap: 12px;
  margin-bottom: 16px;
}

.id-search {
  width: 220px;
}

.id-new {
  width: 200px;
}

.id-list {
  min-height: 120px;
}

.id-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.id-chip {
  font-size: 14px;
}
</style>
