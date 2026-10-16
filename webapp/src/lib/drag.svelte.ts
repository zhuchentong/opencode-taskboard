import type { Action } from "svelte/action"
import type { Status } from "./types"

/**
 * Pointer 拖拽控制器（Svelte 5 runes 模块状态）。
 * 偏离计划说明：计划冻结的 getState() 改为导出响应式 drag 状态——组件可直接 $derived 消费，
 * 省去手动桥接；onDrop 由 App 经 initDrag 注入。
 *
 * 语义：overIndex 仅是视觉插入指示（store 无排序 API，drop 只提交 status）。
 */

export const drag = $state({
  draggingId: null as string | null,
  overStatus: null as Status | null,
  overIndex: null as number | null,
  x: 0,
  y: 0,
})

let opts: { onDrop(taskId: string, toStatus: Status): void } | null = null
let start: { x: number; y: number; taskId: string; el: HTMLElement; fromStatus: Status } | null = null
let active = false
let ghost: HTMLElement | null = null

const THRESHOLD = 4

function cleanup() {
  active = false
  start = null
  drag.draggingId = null
  drag.overStatus = null
  drag.overIndex = null
  ghost?.remove()
  ghost = null
  window.removeEventListener("pointermove", onPointerMove)
  window.removeEventListener("pointerup", onPointerUp)
  window.removeEventListener("keydown", onKeydown)
}

function onPointerDown(e: PointerEvent) {
  if (e.button !== 0) return
  const el = (e.currentTarget as HTMLElement).closest("[data-task-id]") as HTMLElement | null
  if (!el || el.dataset.draggable === "no") return
  const col = el.closest("[data-status]") as HTMLElement | null
  if (!col) return
  e.preventDefault()
  start = {
    x: e.clientX,
    y: e.clientY,
    taskId: el.dataset.taskId!,
    el,
    fromStatus: col.dataset.status as Status,
  }
  window.addEventListener("pointermove", onPointerMove)
  window.addEventListener("pointerup", onPointerUp)
  window.addEventListener("keydown", onKeydown)
}

function onPointerMove(e: PointerEvent) {
  if (!start) return
  if (!active) {
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < THRESHOLD) return
    active = true
    drag.draggingId = start.taskId
    const rect = start.el.getBoundingClientRect()
    ghost = start.el.cloneNode(true) as HTMLElement
    ghost.classList.add("drag-ghost")
    ghost.style.width = `${rect.width}px`
    document.body.appendChild(ghost)
    document.body.classList.add("drag-active")
  }
  drag.x = e.clientX
  drag.y = e.clientY
  ghost?.style.setProperty("transform", `translate(${e.clientX + 10}px, ${e.clientY + 10}px)`)

  const stack = document.elementsFromPoint(e.clientX, e.clientY) as HTMLElement[]
  const col = stack.find((n) => n.dataset?.status && n.classList.contains("column"))
  if (!col) {
    drag.overStatus = null
    drag.overIndex = null
    return
  }
  const status = col.dataset.status as Status
  drag.overStatus = status
  const cards = Array.from(col.querySelectorAll("[data-task-id]:not(.drag-ghost)")) as HTMLElement[]
  let idx = cards.length
  for (let i = 0; i < cards.length; i++) {
    const r = cards[i].getBoundingClientRect()
    if (e.clientY < r.top + r.height / 2) {
      idx = i
      break
    }
  }
  drag.overIndex = idx
}

function onPointerUp() {
  if (active && start && drag.overStatus && drag.overStatus !== start.fromStatus) {
    const taskId = start.taskId
    const toStatus = drag.overStatus
    cleanup()
    opts?.onDrop(taskId, toStatus)
    return
  }
  cleanup()
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape" && active) cleanup()
}

/** App 挂载时注入 drop 回调；返回清理函数 */
export function initDrag(onDrop: (taskId: string, toStatus: Status) => void): () => void {
  opts = { onDrop }
  return () => {
    opts = null
    cleanup()
  }
}

/** 卡片拖拽 action：use:cardDrag={task.id}；data-draggable="no" 的卡片不响应 */
export const cardDrag: Action<HTMLElement, string> = (el, taskId) => {
  el.dataset.taskId = taskId
  el.addEventListener("pointerdown", onPointerDown)
  return {
    update(id: string) {
      el.dataset.taskId = id
    },
    destroy() {
      el.removeEventListener("pointerdown", onPointerDown)
    },
  }
}
