import { createRouter, createWebHistory } from 'vue-router'

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
  history: createWebHistory(),
  routes,
})

// 设置页面标题
router.afterEach((to) => {
  const baseTitle = 'DOTA2 Curation 管理后台'
  document.title = to.meta.title ? `${to.meta.title} - ${baseTitle}` : baseTitle
})

export default router
