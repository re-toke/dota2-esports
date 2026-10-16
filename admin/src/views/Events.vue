<script setup>
/**
 * 赛事列表页（阶段2-② / 阶段2-③）
 *
 * - 查询操作直接用 CloudBase JS SDK（读）。
 * - 写操作（新增/编辑/删除）经 aggregation 云函数 adminWriteCuration 中转。
 */
import { ref, watch, onMounted } from 'vue'
import { fetchEventsPage, writeEvent, deleteEvent } from '@/api/cloudbase'
import EventFormDialog from '@/components/EventFormDialog.vue'

// ===== 数据状态（★ 2026-10-16：**服务端分页**，不再把 3683 行全量拉回前端）=====
const rows = ref([])        // 当前页数据（元素形状 { _id, ...业务字段 }）
const total = ref(0)        // 服务端返回的总数（Content-Range）
const loading = ref(false)
const keyword = ref('')     // 搜索关键词（服务端按规范化名称 ilike 匹配）
const currentPage = ref(1)
const pageSize = ref(20)
let kwTimer = null

// ===== 对话框状态 =====
const dialogVisible = ref(false)
const editingEvent = ref(null)
const saving = ref(false)

// ===== 工具函数 =====
// Unix 秒 → YYYY-MM-DD
function formatUnix(seconds) {
  if (!seconds) return '-'
  const d = new Date(seconds * 1000)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// ★ 2026-10-16：过滤与分页**全部下沉到服务端**（原为本文件内的 computed 客户端过滤/切片）。
//   原因：全量 3683 行 ≈1.3MB，经中转冷缓存 ~24s；改服务端分页后每页仅 20 行 ≈6.6KB / ~1.9s。
//   搜索**同时覆盖规范名与别名**（`or` 两条件，见 api/supabase.js 的 `eventSearchFilter`），
//   ⇒ 与原先的客户端搜索口径一致（规范名 + aliases），**无能力回退**。

// ===== 查询（服务端分页 + 服务端搜索）=====
async function loadEvents() {
  loading.value = true
  try {
    const { rows: r, total: t } = await fetchEventsPage({
      limit: pageSize.value,
      offset: (currentPage.value - 1) * pageSize.value,
      keyword: keyword.value,
    })
    rows.value = r
    total.value = t
  } catch (e) {
    ElMessage.error('查询赛事失败：' + (e.message || e))
    rows.value = []
    total.value = 0
  } finally {
    loading.value = false
  }
}

// 页码 / 每页条数变化 ⇒ 重新取该页
watch([currentPage, pageSize], () => loadEvents())
// 关键词变化 ⇒ 防抖 300ms + 回到第 1 页（页码变则交由上面的 watch 触发加载）
watch(keyword, () => {
  if (kwTimer) clearTimeout(kwTimer)
  kwTimer = setTimeout(() => {
    if (currentPage.value !== 1) { currentPage.value = 1; return }
    loadEvents()
  }, 300)
})

// ===== 写操作（经云函数中转）=====
function handleAdd() {
  editingEvent.value = null
  dialogVisible.value = true
}

function handleEdit(row) {
  editingEvent.value = row
  dialogVisible.value = true
}

// 对话框保存：调用 writeEvent 写入云数据库
async function handleSaved(payload) {
  saving.value = true
  try {
    await writeEvent(payload)
    ElMessage.success(editingEvent.value ? '赛事已更新' : '赛事已新增')
    dialogVisible.value = false
    editingEvent.value = null
    await loadEvents()
  } catch (e) {
    ElMessage.error('保存赛事失败：' + (e.message || e))
  } finally {
    saving.value = false
  }
}

// 删除：el-popconfirm 确认后调用
async function handleDelete(row) {
  try {
    await deleteEvent(row._id)
    ElMessage.success('赛事已删除')
    await loadEvents()
  } catch (e) {
    ElMessage.error('删除赛事失败：' + (e.message || e))
  }
}

onMounted(loadEvents)
</script>

<template>
  <div class="page">
    <div class="page-header">
      <h2 class="page-title">赛事管理</h2>
      <div class="page-actions">
        <el-input
          v-model="keyword"
          placeholder="搜索赛事名称 / 别名"
          clearable
          class="search-input"
        >
          <template #prefix>
            <el-icon><Search /></el-icon>
          </template>
        </el-input>
        <el-button type="primary" @click="handleAdd">
          <el-icon><Plus /></el-icon>
          新增赛事
        </el-button>
        <el-button @click="loadEvents" :loading="loading">
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
      description="新增 / 编辑 / 删除 经 EF admin-write 中转写入 Supabase，每次写操作后自动重算 version 并记录 admin-logs。"
      show-icon
    />

    <el-table
      v-loading="loading"
      :data="rows"
      border
      stripe
      empty-text="暂无赛事数据"
      style="width: 100%"
    >
      <el-table-column type="index" label="#" width="50" />
      <el-table-column prop="canonical" label="规范名" min-width="200" show-overflow-tooltip />
      <el-table-column prop="year" label="年份" width="80" />
      <el-table-column label="等级" width="90">
        <template #default="{ row }">
          <el-tag v-if="row.tier && row.tier.grade" :type="row.tier.grade === 'S' ? 'danger' : 'info'" size="small">
            {{ row.tier.grade }}
          </el-tag>
          <span v-else>-</span>
        </template>
      </el-table-column>
      <el-table-column label="起止日期" min-width="180">
        <template #default="{ row }">
          <span>{{ formatUnix(row.start) }}</span>
          <span style="margin: 0 4px; color: #909399">~</span>
          <span>{{ formatUnix(row.end) }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="status" label="状态" width="100">
        <template #default="{ row }">
          {{ row.status || '-' }}
        </template>
      </el-table-column>
      <el-table-column label="操作" width="150" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" size="small" @click="handleEdit(row)">编辑</el-button>
          <el-popconfirm
            title="确认删除该赛事？"
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
        :total="total"
        :page-sizes="[20, 50, 100]"
        layout="total, sizes, prev, pager, next, jumper"
        background
      />
    </div>

    <EventFormDialog
      v-model="dialogVisible"
      :event="editingEvent"
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
