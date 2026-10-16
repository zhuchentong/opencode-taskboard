// Toast 通知与确认弹层的共享状态（纯 TS，不 import .svelte）
// - toasts/notify：右下角堆叠通知，4s 自动消失，hover 暂停计时
// - confirmDialog：替代 window.confirm 的单例确认弹层（Promise<boolean>）
import { get, writable } from "svelte/store"
import type { Writable } from "svelte/store"

export type ToastKind = "success" | "error"

export interface ToastItem {
  id: number
  kind: ToastKind
  text: string
}

export const toasts: Writable<{ id: number; kind: "success" | "error"; text: string }[]> =
  writable([])

const TOAST_DURATION = 4000

let nextId = 1

// 每条 toast 的倒计时状态：支持 hover 暂停（pauseToast）/恢复（resumeToast）
interface ToastTimer {
  handle: ReturnType<typeof setTimeout> | null // null = 已暂停
  remaining: number
  startedAt: number
}
const toastTimers = new Map<number, ToastTimer>()

function startTimer(id: number, delay: number): void {
  cancelTimer(id)
  toastTimers.set(id, {
    handle: setTimeout(() => dismissToast(id), delay),
    remaining: delay,
    startedAt: Date.now(),
  })
}

function cancelTimer(id: number): void {
  const t = toastTimers.get(id)
  if (t) {
    if (t.handle !== null) clearTimeout(t.handle)
    toastTimers.delete(id)
  }
}

export function dismissToast(id: number): void {
  cancelTimer(id)
  toasts.update((list) => list.filter((t) => t.id !== id))
}

/** 暂停该条 toast 的自动消失倒计时（鼠标悬停时调用） */
export function pauseToast(id: number): void {
  const t = toastTimers.get(id)
  if (!t || t.handle === null) return
  clearTimeout(t.handle)
  t.remaining = Math.max(t.remaining - (Date.now() - t.startedAt), 0)
  t.handle = null
}

/** 恢复该条 toast 的剩余倒计时（鼠标移出时调用） */
export function resumeToast(id: number): void {
  const t = toastTimers.get(id)
  if (!t || t.handle !== null) return
  t.startedAt = Date.now()
  t.handle = setTimeout(() => dismissToast(id), t.remaining)
}

export function notify(kind: "success" | "error", text: string): void {
  // 同文案同类通知不叠加：仅重置该条的 4s 计时
  const existing = get(toasts).find((t) => t.kind === kind && t.text === text)
  if (existing) {
    startTimer(existing.id, TOAST_DURATION)
    return
  }
  const id = nextId++
  toasts.update((list) => [...list, { id, kind, text }])
  startTimer(id, TOAST_DURATION)
}

// ============ 确认弹层（单例） ============

export interface ConfirmState {
  open: boolean
  title: string
  body: string
  resolve: ((value: boolean) => void) | null
}

// 模块级单例状态，经 writable store 供 runes 组件响应式绑定
export const confirmState: Writable<ConfirmState> = writable({
  open: false,
  title: "",
  body: "",
  resolve: null,
})

// 连续调用策略：覆盖——前一个未 settle 的弹层立即以「取消」（false）结算，
// 新弹层取而代之。理由：后发起的确认代表最新用户意图，排队会 造成连环弹层打断操作流。
export function confirmDialog(title: string, body: string): Promise<boolean> {
  return new Promise((resolve) => {
    const prev = get(confirmState)
    if (prev.open && prev.resolve) prev.resolve(false)
    confirmState.set({ open: true, title, body, resolve })
  })
}

/** 由 ConfirmDialog 组件调用：先复位状态再结算，保证处理器内再次 confirmDialog 不被复位覆盖 */
export function settleConfirm(value: boolean): void {
  const cur = get(confirmState)
  if (!cur.resolve) return
  const resolve = cur.resolve
  confirmState.set({ open: false, title: "", body: "", resolve: null })
  resolve(value)
}
