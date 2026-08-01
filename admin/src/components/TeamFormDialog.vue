<script setup>
/**
 * 战队编辑对话框（阶段2-② / 阶段2-③）
 *
 *   - team_id 在新增时可填，编辑时只读；保存时 _id = String(team_id)。
 *   - tier.grade 可选 S/A/B/C/SSS，tier.label 手动输入。
 *   - 保存时仅 emit('saved', payload)，由父组件执行云函数写操作并控制关闭/loading。
 */
import { ref, reactive, watch, computed } from 'vue'

const props = defineProps({
  // 是否可见（v-model）
  modelValue: {
    type: Boolean,
    default: false,
  },
  // 被编辑的战队对象；null 表示新增
  team: {
    type: Object,
    default: null,
  },
  // 保存中 loading（由父组件驱动）
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

const GRADE_OPTIONS = ['SSS', 'S', 'A', 'B', 'C']
const formRef = ref(null)

const form = reactive({
  team_id: '',
  name: '',
  tag: '',
  country: '',
  grade: '',
  label: '',
  aliases: [],
})

const rules = {
  name: [{ required: true, message: '请输入战队名', trigger: 'blur' }],
  team_id: [{ required: true, message: '请输入战队 ID', trigger: 'blur' }],
}

function fillForm(t) {
  const x = t || {}
  // _id 即 team_id 字符串；编辑时回填去掉字符串前缀的反转
  form.team_id = x._id != null ? String(x._id) : ''
  form.name = x.name || ''
  form.tag = x.tag || ''
  form.country = x.country || ''
  const tier = x.tier || {}
  form.grade = tier.grade || ''
  form.label = tier.label || ''
  form.aliases = Array.isArray(x.aliases) ? [...x.aliases] : []
}

watch(
  () => props.modelValue,
  (v) => {
    if (v) fillForm(props.team)
  }
)

const isEdit = computed(() => !!props.team)
const dialogTitle = computed(() => (isEdit.value ? '编辑战队' : '新增战队'))

function close() {
  visible.value = false
}

async function handleSubmit() {
  if (!formRef.value) return
  await formRef.value.validate((valid) => {
    if (!valid) return
    // team_id 保存为数字（云函数校验正整数），_id 由云函数以 String(team_id) 生成
    const tidNum = Number(form.team_id)
    const payload = {
      team_id: tidNum,
      name: form.name,
      tag: form.tag,
      country: form.country,
      tier: { grade: form.grade, label: form.label },
      aliases: form.aliases || [],
      updatedAt: Date.now(),
    }
    // 仅 emit，由父组件执行云函数写操作；成功后父组件关闭对话框，失败时保持打开
    emit('saved', payload)
  })
}
</script>

<template>
  <el-dialog v-model="visible" :title="dialogTitle" width="520px" destroy-on-close>
    <el-form
      ref="formRef"
      :model="form"
      :rules="rules"
      label-width="100px"
      label-position="right"
    >
      <el-form-item label="战队 ID" prop="team_id">
        <el-input
          v-model="form.team_id"
          placeholder="如 36"
          :disabled="isEdit"
        />
        <span v-if="isEdit" class="form-hint">编辑时 ID 只读</span>
      </el-form-item>

      <el-form-item label="战队名" prop="name">
        <el-input v-model="form.name" placeholder="如 Natus Vincere" />
      </el-form-item>

      <el-form-item label="缩写 tag">
        <el-input v-model="form.tag" placeholder="如 NAVI" />
      </el-form-item>

      <el-form-item label="国家/地区">
        <el-input v-model="form.country" placeholder="如 CN / UA" />
      </el-form-item>

      <el-form-item label="等级 grade">
        <el-select v-model="form.grade" placeholder="选择等级" style="width: 160px" allow-create filterable>
          <el-option v-for="g in GRADE_OPTIONS" :key="g" :label="g" :value="g" />
        </el-select>
      </el-form-item>

      <el-form-item label="等级 label">
        <el-input v-model="form.label" placeholder="如 S级" style="width: 200px" />
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
