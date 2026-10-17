// Toast 通知与确认弹层的共享状态（纯 TS，不 import .svelte）
// - notify：toast 走 svelte-sonner（展示、堆叠、自动消失由它接管）
// - confirmDialog：替代 window.confirm 的单例确认弹层（Promise<boolean>），
//   经 confirmState store 供 ConfirmDialog 组件（shadcn AlertDialog）响应式消费
import { get, writable } from "svelte/store"
import { toast } from "svelte-sonner"
import type { Writable } from "svelte/store"

export type ToastKind = "success" | "error"

const TOAST_DURATION = 4000

/** 右下角 toast；同类同文案由 sonner 自行去重堆叠 */
export function notify(kind: ToastKind, text: string): void {
  if (kind === "success") toast.success(text, { duration: TOAST_DURATION })
  else toast.error(text, { duration: TOAST_DURATION })
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
