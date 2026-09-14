/**
 * ⚠️ 兼容垫片（阶段2-⑤，2026-09-14）
 *
 * 实现已迁移到 ./supabase.js（云开发 → Supabase）。
 * 本文件保留文件名，仅为兼容既有 import：
 *   import { fetchEvents, normalizeEventName } from '@/api/cloudbase'
 *   （Events.vue / Teams.vue / Meta.vue / EventFormDialog.vue 在用）
 *
 * 后续可重命名为 supabase 并同步改 import，属纯清理。
 */
export * from './supabase.js'
