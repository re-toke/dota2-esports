import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'
import { fileURLToPath, URL } from 'node:url'

// https://vitejs.dev/config/
export default defineConfig({
  // ★ P2-15（2026-10-16）：GitHub Pages **项目页**部署在子路径
  //   `https://re-toke.github.io/dota2-esports/` ⇒ 资源 URL 必须以该前缀为基准，
  //   否则 index.html 里的 `/assets/*` 会 404。
  //   CI 传 `VITE_BASE=/dota2-esports/`；本地 `npm run dev` 不传 ⇒ 回落 `'/'`（本地根路径）。
  base: process.env.VITE_BASE || '/',
  plugins: [
    vue(),
    // Element Plus 按需导入：自动引入 ElMessage / ElMessageBox 等 API
    AutoImport({
      resolvers: [ElementPlusResolver()],
    }),
    // Element Plus 按需导入：自动注册组件
    Components({
      resolvers: [ElementPlusResolver()],
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // 允许局域网访问（便于在手机/小程序调试端访问）
    host: true,
  },
})
