import { createApp } from 'vue'
import { createPinia } from 'pinia'
import * as ElementPlusIconsVue from '@element-plus/icons-vue'
import App from './App.vue'
import router from './router'

const app = createApp(App)
const pinia = createPinia()

// 注册所有 Element Plus 图标为全局组件
// （Element Plus 业务组件通过 unplugin-vue-components 按需自动注册，
//   但图标需手动全局注册，以便在模板中直接使用 <el-icon><Trophy /></el-icon>）
for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, component)
}

app.use(pinia)
app.use(router)

// 当前阶段暂不做认证，直接挂载应用
app.mount('#app')
