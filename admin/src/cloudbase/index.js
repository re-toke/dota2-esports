import cloudbase from '@cloudbase/js-sdk'

// 从环境变量读取云开发 envId（与小程序共用同一环境）
const envId = import.meta.env.VITE_CLOUDBASE_ENV

// 调试日志：确认环境变量是否被正确注入
console.log('[cloudbase] VITE_CLOUDBASE_ENV =', JSON.stringify(envId), '| import.meta.env keys:', Object.keys(import.meta.env).filter(k => k.startsWith('VITE_')))

if (!envId) {
  console.error(
    '[cloudbase] 未检测到 VITE_CLOUDBASE_ENV 环境变量！请确认：\n' +
    '  1. admin/.env 文件存在且包含 VITE_CLOUDBASE_ENV=xxx\n' +
    '  2. 修改 .env 后需重启 vite dev server（npm run dev）'
  )
}

// 初始化 CloudBase 应用实例
// 错误信息 "env must not be specified" 实际意思是 "env 必须指定，不能为空"
const app = cloudbase.init({
  env: envId || 'MISSING_ENV_ID',  // 传占位值避免 init 抛错，让后续 API 调用报错更清晰
})

// 数据库实例（用于访问 curation_events / curation_teams / curation_meta 等 collection）
// 说明：当前阶段暂不做认证，仅通过 db 实例读取数据。
//   - 读取：需将 collection 权限设为「所有用户可读」
//   - 写入：前端无法直写，需走云函数中转（阶段2-③ 实现）
const db = app.database()

export { app, db }
export default app
