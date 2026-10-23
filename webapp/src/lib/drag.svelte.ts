import type { Action } from "svelte/action"
import type { Status } from "./types"

/**
 * Pointer 拖拽控制器（Svelte 5 runes 模块状态）。
 * 偏离计划说明：计划冻结的 getState() 改为导出响应式 drag 状态——组件可直接 $derived 消费，
 * 省去手动桥接；onDrop 由 App 经 initDrag 注入。
 *
 * 语义：悬停只表达「目标泳道」（overStatus，整道虚线描边），不做列内精确插入指示——
 * store 无排序 API，drop 只提交 status，落位由 updatedAt 排序决定（假指示已删）。
 */

export const drag = $state({
  draggingId: null as string | null,
  overStatus: null as Status | null,
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
  // 指针捕获：拖出窗口后 pointerup 仍派发给页面，避免拖拽态卡死
  try {
    el.setPointerCapture(e.pointerId)
  } catch {
    /* 某些合成事件无 pointerId */
  }
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

  // 落点定位先算：指针下的泳道，后续自动滚屏与悬停态都依赖它
  const stack = document.elementsFromPoint(e.clientX, e.clientY) as HTMLElement[]
  const col = stack.find((n) => n.dataset?.status && n.classList.contains("lane"))

  // 视口上下缘自动纵滚（竖直滚动走 html 文档原生页面滚动条，window 即可）
  const EDGE = 80
  if (e.clientY < EDGE) window.scrollBy(0, -14)
  else if (e.clientY > window.innerHeight - EDGE) window.scrollBy(0, 14)

  // 单行卡片流：拖到泳道左右缘时横向滚该泳道的卡片（卡片溢出泳道后仍可达）。
  // 仅在确有横向溢出时滚（换行列 flex-wrap 无横滚，scrollBy 是无效但省掉的功）
  if (col) {
    const rect = col.getBoundingClientRect()
    const cards = col.querySelector(".cards") as HTMLElement | null
    const ZONE = 40
    if (cards && cards.scrollWidth > cards.clientWidth) {
      if (e.clientX < rect.left + ZONE) cards.scrollBy(-12, 0)
      else if (e.clientX > rect.right - ZONE) cards.scrollBy(12, 0)
    }
  }

  if (!col) {
    drag.overStatus = null
    return
  }
  drag.overStatus = col.dataset.status as Status
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
