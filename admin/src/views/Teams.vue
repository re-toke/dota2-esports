<script setup>
/**
 * 战队列表页（阶段2-② / 阶段2-③）
 *
 * - 查询操作直接用 CloudBase JS SDK（读）。
 * - 写操作（新增/编辑/删除）经 aggregation 云函数 adminWriteCuration 中转。
 */
import { ref, computed, onMounted } from 'vue'
import { fetchTeams, writeTeam, deleteTeam } from '@/api/cloudbase'
import TeamFormDialog from '@/components/TeamFormDialog.vue'

// ===== 数据状态 =====
const allTeams = ref([])
const loading = ref(false)
const keyword = ref('')

// ===== 分页（前端分页）=====
const currentPage = ref(1)
const pageSize = ref(20)

// ===== 对话框状态 =====
const dialogVisible = ref(false)
const editingTeam = ref(null)
const saving = ref(false)

// ===== 过滤 + 分页 =====
const filteredTeams = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  if (!kw) return allTeams.value
  return allTeams.value.filter((t) => {
    const name = (t.name || '').toLowerCase()
    const tag = (t.tag || '').toLowerCase()
    const aliases = Array.isArray(t.aliases) ? t.aliases.join(' ').toLowerCase() : ''
    return name.includes(kw) || tag.includes(kw) || aliases.includes(kw)
  })
})

const pagedTeams = computed(() => {
  const start = (currentPage.value - 1) * pageSize.value
  return filteredTeams.value.slice(start, start + pageSize.value)
})

// ===== 查询 =====
async function loadTeams() {
  loading.value = true
  try {
    allTeams.value = await fetchTeams()
  } catch (e) {
    ElMessage.error('查询战队失败：' + (e.message || e))
    allTeams.value = []
  } finally {
    loading.value = false
  }
}

// ===== 写操作（经云函数中转）=====
function handleAdd() {
  editingTeam.value = null
  dialogVisible.value = true
}

function handleEdit(row) {
  editingTeam.value = row
  dialogVisible.value = true
}

// 对话框保存：调用 writeTeam 写入云数据库
async function handleSaved(payload) {
  saving.value = true
  try {
    await writeTeam(payload)
    ElMessage.success(editingTeam.value ? '战队已更新' : '战队已新增')
    dialogVisible.value = false
    editingTeam.value = null
    await loadTeams()
  } catch (e) {
    ElMessage.error('保存战队失败：' + (e.message || e))
  } finally {
    saving.value = false
  }
}

// 删除：el-popconfirm 确认后调用
async function handleDelete(row) {
  try {
    await deleteTeam(row._id)
    ElMessage.success('战队已删除')
    await loadTeams()
  } catch (e) {
    ElMessage.error('删除战队失败：' + (e.message || e))
  }
}

onMounted(loadTeams)
</script>

<template>
  <div class="page">
    <div class="page-header">
      <h2 class="page-title">战队管理</h2>
      <div class="page-actions">
        <el-input
          v-model="keyword"
          placeholder="搜索战队名称 / 缩写"
          clearable
          class="search-input"
        >
          <template #prefix>
            <el-icon><Search /></el-icon>
          </template>
        </el-input>
        <el-button type="primary" @click="handleAdd">
          <el-icon><Plus /></el-icon>
          新增战队
        </el-button>
        <el-button @click="loadTeams" :loading="loading">
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
      description="新增 / 编辑 / 删除 经云函数 adminWriteCuration 中转写入云数据库，每次写操作后自动重算 version 并记录 admin-logs。"
      show-icon
    />

    <el-table
      v-loading="loading"
      :data="pagedTeams"
      border
      stripe
      empty-text="暂无战队数据"
      style="width: 100%"
    >
      <el-table-column prop="_id" label="ID" width="70" />
      <el-table-column prop="name" label="战队名" min-width="180" show-overflow-tooltip />
      <el-table-column prop="tag" label="缩写" width="100" />
      <el-table-column prop="country" label="国家/地区" width="100">
        <template #default="{ row }">
          {{ row.country || '-' }}
        </template>
      </el-table-column>
      <el-table-column label="等级" width="90">
        <template #default="{ row }">
          <el-tag v-if="row.tier && row.tier.label" size="small">{{ row.tier.label }}</el-tag>
          <span v-else-if="row.tier && row.tier.grade">{{ row.tier.grade }}</span>
          <span v-else>-</span>
        </template>
      </el-table-column>
      <el-table-column label="别名" min-width="180">
        <template #default="{ row }">
          <span v-if="Array.isArray(row.aliases) && row.aliases.length">
            {{ row.aliases.join(' / ') }}
          </span>
          <span v-else>-</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="150" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" size="small" @click="handleEdit(row)">编辑</el-button>
          <el-popconfirm
            title="确认删除该战队？"
            @confirm="handleDelete(row)"
          >
            <template #reference>
              <el-button link type="danger" size="small">删除</el-button>
            </template>
          </el-popconfirm>
        </template>
      </el-table-column>
    </el-table>

    <div class="pager">
      <el-pagination
        v-model:current-page="currentPage"
        v-model:page-size="pageSize"
        :total="filteredTeams.length"
        :page-sizes="[20, 50, 100]"
        layout="total, sizes, prev, pager, next, jumper"
        background
      />
    </div>

    <TeamFormDialog
      v-model="dialogVisible"
      :team="editingTeam"
      :saving="saving"
      @saved="handleSaved"
    />
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

.search-input {
  width: 260px;
}

.write-tip {
  margin-bottom: 16px;
}

.pager {
  margin-top: 16px;
  display: flex;
  justify-content: flex-end;
}
</style>
