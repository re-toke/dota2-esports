<script setup>
/**
 * TI 名单管理页（阶段2-② / 阶段2-③）
 *
 * - 展示 curation_meta 的 version / count / updatedAt。
 * - 展示 tiContestantIds 列表（可搜索、可删除单个 ID）。
 * - 添加 / 删除 team_id 经云函数 updateMeta（全量覆盖 ids）写入，version 由云函数自动重算。
 * - 「重新计算 version」按钮仅做本地校验计算（与云端比对），不写入。
 */
import { ref, computed, onMounted } from 'vue'
import { fetchMeta, fetchEvents, fetchTeams, versionFromData, updateMeta } from '@/api/cloudbase'

// ===== 数据状态 =====
const meta = ref(null)
const events = ref([])
const teams = ref([])
const loading = ref(false)
// ID 写操作进行中（控制添加按钮 loading，与页面 loading 区分）
const idSaving = ref(false)

// 搜索与新增
const idKeyword = ref('')
const newId = ref('')

// 重新计算得到的 version（仅展示，用于与云端 version 比对）
const computedVersion = ref('')

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

// ===== 查询 =====
async function loadAll() {
  loading.value = true
  try {
    const [m, ev, tm] = await Promise.all([fetchMeta(), fetchEvents(), fetchTeams()])
    meta.value = m
    events.value = ev
    teams.value = tm
  } catch (e) {
    ElMessage.error('查询 meta 数据失败：' + (e.message || e))
    meta.value = null
  } finally {
    loading.value = false
  }
}

// ===== 写操作（经云函数中转）=====
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
    await updateMeta(nextIds)
    ElMessage.success('已添加 team_id：' + num)
    newId.value = ''
    await loadAll()
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
    await updateMeta(nextIds)
    ElMessage.success('已删除 team_id：' + id)
    await loadAll()
  } catch (e) {
    ElMessage.error('删除 team_id 失败：' + (e.message || e))
  } finally {
    idSaving.value = false
  }
}

// 本地重算 version（仅用于与云端 version 比对，不写入）
function handleRecompute() {
  const v = versionFromData(events.value, teams.value, tiIds.value)
  computedVersion.value = v
  ElMessage.success('本地重算 version：' + v + '（云端 version 由写操作自动重算）')
}

onMounted(loadAll)
</script>

<template>
  <div class="page" v-loading="loading">
    <div class="page-header">
      <h2 class="page-title">TI 名单管理</h2>
      <div class="page-actions">
        <el-button @click="loadAll" :loading="loading">
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
      description="新增 / 删除 team_id 经云函数 updateMeta 全量覆盖写入，version 由云函数自动重算并记录 admin-logs。"
      show-icon
    />

    <!-- meta 概览 -->
    <el-descriptions :column="3" border title="curation_meta 概览" class="meta-desc">
      <el-descriptions-item label="_id">
        {{ meta && meta._id ? meta._id : 'ti_contestant_ids' }}
      </el-descriptions-item>
      <el-descriptions-item label="version">
        <el-tag v-if="meta && meta.version" type="success">{{ meta.version }}</el-tag>
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
      <el-descriptions-item label="本地重算 version">
        <el-tag v-if="computedVersion" type="warning">{{ computedVersion }}</el-tag>
        <span v-else style="color: #909399">点击下方按钮计算</span>
      </el-descriptions-item>
    </el-descriptions>

    <div class="action-bar">
      <el-button type="primary" @click="handleRecompute">
        <el-icon><Refresh /></el-icon>
        重新计算 version
      </el-button>
    </div>

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
  margin-bottom: 16px;
}

.action-bar {
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
