import { describe, expect, test } from "bun:test"
import { connectEvents } from "../src/lib/events"
import type { BoardSettings, Task } from "../src/lib/types"

const T = (id: string, status: Task["status"] = "pending"): Task => ({
  id,
  title: id,
  description: "",
  status,
  comments: [],
  createdAt: 1,
  updatedAt: 1,
})

// 可控的假 EventSource
class FakeES {
  static instances: FakeES[] = []
  url: string
  closed = false
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null

  constructor(url: string) {
    this.url = url
    FakeES.instances.push(this)
  }
  open() {
    this.onopen?.()
  }
  fail() {
    this.onerror?.()
  }
  message(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) })
  }
  close() {
    this.closed = true
  }
}

// 可控的假定时器：注册表手动触发
function fakeTimers() {
  const regs: { fn: () => void; ms: number; cleared: boolean }[] = []
  return {
    regs,
    set: (fn: () => void, ms: number) => {
      const r = { fn, ms, cleared: false }
      regs.push(r)
      return r
    },
    clear: (r: unknown) => {
      ;(r as { cleared: boolean }).cleared = true
    },
    async fire(ms: number) {
      for (const r of regs) if (!r.cleared && r.ms === ms) r.fn()
      // pull 为 async：让微任务链落地（fetchBoard 已 resolve → onSnapshot 同步推入）
      await Promise.resolve()
      await Promise.resolve()
    },
  }
}

function fakeFetch(samples: { tasks: Task[]; settings: BoardSettings; projects?: { id: string; name: string }[] }[]) {
  let i = 0
  const calls = () => i
  const fn = () => Promise.resolve(samples[Math.min(i++, samples.length - 1)])
  return { fn, calls }
}

function baseHandlers() {
  const snap: { tasks: Task[]; settings: BoardSettings; projects: unknown[] }[] = []
  const states: string[] = []
  return {
    snap,
    states,
    handlers: {
      onSnapshot: (tasks: Task[], settings: BoardSettings, projects?: unknown[]) =>
        snap.push({ tasks, settings, projects: projects ?? "missing" }),
      onStatus: (s: string) => states.push(s),
    },
  }
}

describe("connectEvents", () => {
  test("连接打开 → live；snapshot 消息 → onSnapshot", () => {
    FakeES.instances = []
    const { handlers, snap, states } = baseHandlers()
    const timers = fakeTimers()
    connectEvents(handlers, { EventSource: FakeES as never, setInterval: timers.set, clearInterval: timers.clear, setTimeout: timers.set, clearTimeout: timers.clear, fetchBoard: fakeFetch([]).fn })
    const es = FakeES.instances[0]
    expect(es.url).toBe("/api/events")
    es.open()
    expect(states).toEqual(["live"])
    const proj = { id: "project_a", name: "A" }
    es.message({ type: "snapshot", tasks: [T("a")], settings: { requireAnalysisConfirm: true, autoDispatch: false }, projects: [proj] })
    expect(snap).toHaveLength(1)
    expect(snap[0].tasks[0].id).toBe("a")
    expect(snap[0].settings.requireAnalysisConfirm).toBe(true)
    expect(snap[0].projects).toEqual([proj])
  })

  test("快照缺 projects 字段(旧服务端容错)→ onSnapshot 收到空数组", () => {
    FakeES.instances = []
    const { handlers, snap } = baseHandlers()
    const timers = fakeTimers()
    connectEvents(handlers, { EventSource: FakeES as never, setInterval: timers.set, clearInterval: timers.clear, setTimeout: timers.set, clearTimeout: timers.clear, fetchBoard: fakeFetch([]).fn })
    FakeES.instances[0].message({ type: "snapshot", tasks: [T("a")], settings: { requireAnalysisConfirm: false, autoDispatch: false } })
    expect(snap).toHaveLength(1)
    expect(snap[0].projects).toEqual([])
  })

  test("连续 3 次 error → 降级 polling 并启动 5s 轮询；重连 open → 回 live 且轮询停止", async () => {
    FakeES.instances = []
    const { handlers, snap, states } = baseHandlers()
    const timers = fakeTimers()
    const f = fakeFetch([{ tasks: [T("srv")], settings: { requireAnalysisConfirm: false, autoDispatch: false } }])
    connectEvents(handlers, { EventSource: FakeES as never, setInterval: timers.set, clearInterval: timers.clear, setTimeout: timers.set, clearTimeout: timers.clear, fetchBoard: f.fn })
    const es = FakeES.instances[0]
    es.open()
    es.fail()
    es.fail()
    es.fail()
    expect(states).toContain("reconnecting")
    expect(states[states.length - 1]).toBe("polling")
    // 5s 轮询 tick 拉取快照
    await timers.fire(5000)
    expect(snap).toHaveLength(1)
    expect(snap[0].tasks[0].id).toBe("srv")
    // 重连恢复：live + 轮询定时器已清
    es.open()
    expect(states[states.length - 1]).toBe("live")
    const poll5s = timers.regs.filter((r) => r.ms === 5000)
    expect(poll5s.every((r) => r.cleared)).toBe(true)
    // Review Focus 1：恢复后收到首条快照，状态与服务器一致
    es.message({ type: "snapshot", tasks: [T("srv2", "executing")], settings: { requireAnalysisConfirm: false, autoDispatch: false } })
    expect(snap[snap.length - 1].tasks[0]).toMatchObject({ id: "srv2", status: "executing" })
  })

  test("30s 对账轮询恒开", async () => {
    FakeES.instances = []
    const { handlers, snap } = baseHandlers()
    const timers = fakeTimers()
    const f = fakeFetch([{ tasks: [], settings: { requireAnalysisConfirm: false, autoDispatch: false } }])
    connectEvents(handlers, { EventSource: FakeES as never, setInterval: timers.set, clearInterval: timers.clear, setTimeout: timers.set, clearTimeout: timers.clear, fetchBoard: f.fn })
    expect(timers.regs.some((r) => r.ms === 30_000)).toBe(true)
    await timers.fire(30_000)
    expect(snap).toHaveLength(1)
  })

  test("卸载：关闭 EventSource、清空定时器（含降级轮询）", async () => {
    FakeES.instances = []
    const { handlers } = baseHandlers()
    const timers = fakeTimers()
    const f = fakeFetch([{ tasks: [], settings: { requireAnalysisConfirm: false, autoDispatch: false } }])
    const dispose = connectEvents(handlers, { EventSource: FakeES as never, setInterval: timers.set, clearInterval: timers.clear, setTimeout: timers.set, clearTimeout: timers.clear, fetchBoard: f.fn })
    const es = FakeES.instances[0]
    es.open()
    es.fail()
    es.fail()
    es.fail() // 降级，启动 5s 轮询
    expect(timers.regs.some((r) => r.ms === 5000 && !r.cleared)).toBe(true)
    dispose()
    expect(es.closed).toBe(true)
    expect(timers.regs.every((r) => r.cleared)).toBe(true)
  })
})
