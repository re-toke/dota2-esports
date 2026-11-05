<script setup>
/**
 * 赛事编辑对话框（阶段2-② / 阶段2-③）
 *
 *   - start/end 字段在 DB 中为 Unix 秒，表单用 el-date-picker（value-format='x' 毫秒）中转。
 *   - tier.grade 变化时自动联动 rank 与 label。
 *   - 保存时仅 emit('saved', payload)，由父组件执行云函数写操作并控制关闭/loading，
 *     这样保存失败时对话框可保持打开，便于用户修改后重试。
 */
import { ref, reactive, watch, computed } from 'vue'
import { normalizeEventName } from '@/api/cloudbase'

const props = defineProps({
  // 是否可见（v-model）
  modelValue: {
    type: Boolean,
    default: false,
  },
  // 被编辑的赛事对象；null 表示新增
  event: {
    type: Object,
    default: null,
  },
  // 保存中 loading（由父组件驱动，控制保存按钮禁用 + loading 动画）
  saving: {
    type: Boolean,
    default: false,
  },
})

const emit = defineEmits(['update:modelValue', 'saved'])

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
})

// grade -> rank / label 映射
const GRADE_RANK = { S: 3, A: 2, B: 1, C: 0 }
const GRADE_LABEL = { S: 'S级', A: 'A级', B: 'B级', C: 'C级' }
const GRADE_OPTIONS = ['S', 'A', 'B', 'C']

const formRef = ref(null)

const form = reactive({
  canonical: '',
  aliases: [],
  grade: '',
  rank: 0,
  label: '',
  year: new Date().getFullYear(),
  dateRange: [], // [startMs, endMs]，毫秒
  liquipediaSlug: '',
  prizePool: '',
  organizer: '',
  region: '',
  format: '',
  participants: '',
  status: '',
  valve: false,
  topThirdParty: false,
})

const rules = {
  canonical: [{ required: true, message: '请输入规范名', trigger: 'blur' }],
  grade: [{ required: true, message: '请选择等级', trigger: 'change' }],
  // ★ 2026-11-05：LP 标题允许空格，但缓存键 `lp:w:<slug>` 区分空格/下划线 ——
  //   worker 落库时把标题空格统一转成下划线，admin 若存空格形态 → 读侧永远 miss。
  //   故提交前归一（见 normalizeSlugInput），并挡住会破坏 MediaWiki titles 参数的字符。
  liquipediaSlug: [{
    validator: (_rule, value, cb) => {
      const v = String(value || '').trim()
      if (!v) return cb()
      if (v.length > 120) return cb(new Error('Liquipedia Slug 过长（≤120 字符）'))
      if (v.indexOf('|') >= 0) return cb(new Error('不能包含 "|"：它是 MediaWiki 多标题分隔符'))
      return cb()
    },
    trigger: 'blur',
  }],
}

/** 提交前把 slug 归一成「下划线形态」（LP 请求对两种形态等价，但缓存键不等价） */
function normalizeSlugInput(v) {
  // 连续空白/下划线折叠成单个下划线：MediaWiki 本身就这样归一标题，
  // 若存成 `A__B` 而 worker 落库键是 `A_B`，读侧仍会 miss。
  return String(v || '').trim().replace(/[ \t\r\n]+/g, '_').replace(/_+/g, '_')
}

// 用 event 填充表单
function fillForm(ev) {
  const e = ev || {}
  form.canonical = e.canonical || ''
  form.aliases = Array.isArray(e.aliases) ? [...e.aliases] : []
  const tier = e.tier || {}
  form.grade = tier.grade || ''
  form.rank = tier.rank != null ? tier.rank : (GRADE_RANK[tier.grade] != null ? GRADE_RANK[tier.grade] : 0)
  form.label = tier.label || (GRADE_LABEL[tier.grade] || '')
  form.year = e.year || new Date().getFullYear()
  // DB 中 start/end 为 Unix 秒，转毫秒供 date-picker 使用
  const startMs = e.start ? e.start * 1000 : null
  const endMs = e.end ? e.end * 1000 : null
  form.dateRange = startMs && endMs ? [startMs, endMs] : []
  form.liquipediaSlug = e.liquipediaSlug || ''
  form.prizePool = e.prizePool || ''
  form.organizer = e.organizer || ''
  form.region = e.region || ''
  form.format = e.format || ''
  form.participants = e.participants != null ? String(e.participants) : ''
  form.status = e.status || ''
  form.valve = !!e.valve
  form.topThirdParty = !!e.topThirdParty
}

// 对话框打开时填充表单
watch(
  () => props.modelValue,
  (v) => {
    if (v) fillForm(props.event)
  }
)

// grade 联动 rank / label
function onGradeChange(grade) {
  if (GRADE_RANK[grade] != null) form.rank = GRADE_RANK[grade]
  if (GRADE_LABEL[grade]) form.label = GRADE_LABEL[grade]
}

const isEdit = computed(() => !!props.event)
const dialogTitle = computed(() => (isEdit.value ? '编辑赛事' : '新增赛事'))

function close() {
  visible.value = false
}

async function handleSubmit() {
  if (!formRef.value) return
  await formRef.value.validate((valid) => {
    if (!valid) return
    // 组装完整赛事对象（云函数会自动补 updatedAt，这里也带上以保证一致性）
    const start = form.dateRange && form.dateRange[0] ? Math.floor(Number(form.dateRange[0]) / 1000) : 0
    const end = form.dateRange && form.dateRange[1] ? Math.floor(Number(form.dateRange[1]) / 1000) : 0
    const payload = {
      // ★ 2026-11-05：以原事件为底再覆盖表单字段。
      //   根因：admin-write 是**整行 data upsert**，而本表单只覆盖部分字段；
      //   原实现只组装表单字段 ⇒ 编辑任一赛事都会抹掉表单未覆盖的
      //   scheduledMatchesSlug / structureSlug / bracketSlug（对阵页/淘汰赛结构页 slug），
      //   赛程随后静默回退到赛事主页面（主页面没有 {{Match}} 列表）。
      ...(isEdit.value && props.event ? props.event : {}),
      _id: isEdit.value ? props.event._id : normalizeEventName(form.canonical),
      canonical: form.canonical,
      aliases: form.aliases || [],
      tier: { grade: form.grade, rank: form.rank, label: form.label },
      year: form.year,
      start,
      end,
      liquipediaSlug: normalizeSlugInput(form.liquipediaSlug),
      prizePool: form.prizePool,
      organizer: form.organizer,
      region: form.region,
      format: form.format,
      participants: form.participants,
      status: form.status,
      valve: form.valve,
      topThirdParty: form.topThirdParty,
      updatedAt: Date.now(),
    }
    // 仅 emit，由父组件执行云函数写操作；成功后父组件关闭对话框，失败时保持打开
    emit('saved', payload)
  })
}
</script>

<template>
  <el-dialog v-model="visible" :title="dialogTitle" width="640px" destroy-on-close>
    <el-form
      ref="formRef"
      :model="form"
      :rules="rules"
      label-width="110px"
      label-position="right"
    >
      <el-form-item label="规范名" prop="canonical">
        <el-input v-model="form.canonical" placeholder="如 The International 2026" />
      </el-form-item>

      <el-form-item label="别名">
        <el-select
          v-model="form.aliases"
          multiple
          filterable
          allow-create
          default-first-option
          placeholder="输入后回车添加别名"
          style="width: 100%"
        >
          <el-option v-for="a in form.aliases" :key="a" :label="a" :value="a" />
        </el-select>
      </el-form-item>

      <el-form-item label="等级 grade" prop="grade">
        <el-select v-model="form.grade" placeholder="选择等级" @change="onGradeChange" style="width: 160px">
          <el-option v-for="g in GRADE_OPTIONS" :key="g" :label="g" :value="g" />
        </el-select>
      </el-form-item>

      <el-form-item label="等级 rank">
        <el-input-number v-model="form.rank" :min="0" :max="3" :disabled="true" />
        <span class="form-hint">S→3 / A→2 / B→1 / C→0，随 grade 自动联动</span>
      </el-form-item>

      <el-form-item label="等级 label">
        <el-input v-model="form.label" placeholder="如 S级" style="width: 200px" />
      </el-form-item>

      <el-form-item label="年份">
        <el-input-number v-model="form.year" :min="2000" :max="2100" />
      </el-form-item>

      <el-form-item label="起止日期">
        <el-date-picker
          v-model="form.dateRange"
          type="daterange"
          value-format="x"
          range-separator="至"
          start-placeholder="开始日期"
          end-placeholder="结束日期"
          style="width: 100%"
        />
      </el-form-item>

      <el-form-item label="Liquipedia Slug">
        <el-input v-model="form.liquipediaSlug" placeholder="如 The_International/2026" />
      </el-form-item>

      <el-divider content-position="left">扩展字段（可选）</el-divider>

      <el-form-item label="奖金池">
        <el-input v-model="form.prizePool" placeholder="如 $3,000,000" />
      </el-form-item>

      <el-form-item label="主办方">
        <el-input v-model="form.organizer" />
      </el-form-item>

      <el-form-item label="赛区">
        <el-input v-model="form.region" placeholder="如 WEU / CN / SEA" />
      </el-form-item>

      <el-form-item label="赛制">
        <el-input v-model="form.format" placeholder="如 双败淘汰" />
      </el-form-item>

      <el-form-item label="参赛队数">
        <el-input v-model="form.participants" placeholder="如 16" />
      </el-form-item>

      <el-form-item label="状态">
        <el-input v-model="form.status" placeholder="如 upcoming / ongoing / finished" />
      </el-form-item>

      <el-form-item label="Valve 举办">
        <el-switch v-model="form.valve" />
      </el-form-item>

      <el-form-item label="顶级第三方">
        <el-switch v-model="form.topThirdParty" />
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="close" :disabled="props.saving">取消</el-button>
      <el-button type="primary" :loading="props.saving" @click="handleSubmit">保存</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.form-hint {
  margin-left: 12px;
  color: #909399;
  font-size: 12px;
}
</style>
