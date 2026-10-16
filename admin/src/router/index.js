import { createRouter, createWebHashHistory } from 'vue-router'

const routes = [
  {
    path: '/',
    component: () => import('@/layouts/MainLayout.vue'),
    redirect: '/events',
    children: [
      {
        path: 'events',
        name: 'Events',
        component: () => import('@/views/Events.vue'),
        meta: { title: '赛事管理' },
      },
      {
        path: 'teams',
        name: 'Teams',
        component: () => import('@/views/Teams.vue'),
        meta: { title: '战队管理' },
      },
      {
        path: 'meta',
        name: 'Meta',
        component: () => import('@/views/Meta.vue'),
        meta: { title: 'TI 名单管理' },
      },
    ],
  },
]

const router = createRouter({
  // ★ P2-15（2026-10-16）：改用**哈希路由**。原 `createWebHistory()` 在 GitHub Pages
  //   （纯静态、**无服务端 rewrite**）下，刷新/收藏深链（如 `/events`）会 **404**；
  //   哈希路由（`/#/events`）**零 404、无需 404.html**，对内部工具足够。
  //   入参用 `import.meta.env.BASE_URL`（= vite `base`）⇒ 与项目页子路径一致。
  history: createWebHashHistory(import.meta.env.BASE_URL),
  routes,
})

// 设置页面标题
router.afterEach((to) => {
  const baseTitle = 'DOTA2 Curation 管理后台'
  document.title = to.meta.title ? `${to.meta.title} - ${baseTitle}` : baseTitle
})

export default router
