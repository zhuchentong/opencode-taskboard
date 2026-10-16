import type { ConnState } from "./api"
import { fetchBoard } from "./api"
import type { BoardSettings, Task } from "./types"

/**
 * SSE 订阅 + 轮询兜底。
 * - EventSource /api/events（自带重连）：onopen→live；连续 3 次失败降级 5s 轮询（polling）
 * - 重连成功回 live 并停止轮询；30s 对账轮询恒开（live 时兜底防漏事件）
 * - 依赖可注入（EventSource/定时器/fetchBoard），测试用假件确定性驱动
 */
export interface EventsDeps {
  EventSource: new (url: string) => {
    onopen: (() => void) | null
    onerror: (() => void) | null
    onmessage: ((e: { data: string }) => void) | null
    close(): void
  }
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  fetchBoard(): Promise<{ tasks: Task[]; settings: BoardSettings }>
}

const realDeps: EventsDeps = {
  EventSource: globalThis.EventSource as never,
  setInterval,
  clearInterval,
  setTimeout,
  clearTimeout,
  fetchBoard,
}

const RECON_SEC = 5
const RECONCILE_SEC = 30
const FAILURE_THRESHOLD = 3

export function connectEvents(
  handlers: {
    onSnapshot(tasks: Task[], settings: BoardSettings): void
    onStatus(s: ConnState): void
  },
  deps: EventsDeps = realDeps,
): () => void {
  const es = new deps.EventSource("/api/events")
  let failures = 0
  let degraded = false
  let pollTimer: unknown = null
  const timers: unknown[] = []

  const pull = async () => {
    try {
      const snap = await deps.fetchBoard()
      handlers.onSnapshot(snap.tasks, snap.settings)
    } catch {
      /* 拉取失败保留下次重试 */
    }
  }

  const stopDegraded = () => {
    if (!degraded) return
    degraded = false
    if (pollTimer !== null) {
      deps.clearInterval(pollTimer)
      pollTimer = null
    }
  }

  es.onopen = () => {
    failures = 0
    stopDegraded()
    handlers.onStatus("live")
  }

  es.onerror = () => {
    failures++
    handlers.onStatus("reconnecting")
    if (failures >= FAILURE_THRESHOLD && !degraded) {
      degraded = true
      handlers.onStatus("polling")
      pollTimer = deps.setInterval(pull, RECON_SEC * 1000)
    }
  }

  es.onmessage = (e) => {
    try {
      const evt = JSON.parse(e.data) as { type: string; tasks?: Task[]; settings?: BoardSettings }
      if (evt.type === "snapshot" && evt.tasks && evt.settings) {
        handlers.onSnapshot(evt.tasks, evt.settings)
      }
    } catch {
      /* 非 JSON 帧（心跳注释不会进 onmessage）忽略 */
    }
  }

  // 30s 对账轮询恒开
  timers.push(deps.setInterval(pull, RECONCILE_SEC * 1000))

  return () => {
    es.close()
    for (const t of timers) deps.clearInterval(t)
  }
}
