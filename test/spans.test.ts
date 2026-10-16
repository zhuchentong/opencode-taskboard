import { describe, expect, test } from "bun:test"
import { transitionSpans } from "../src/spans"
import type { Status, Task } from "../src/types"

const T = (status: Status, spans?: Task["spans"]): Task => ({
  id: "task_x",
  title: "t",
  description: "",
  status,
  comments: [],
  createdAt: 1,
  updatedAt: 1,
  ...(spans ? { spans } : {}),
})

/** 走一次迁移：prev → next（浅拷贝模拟 store 行为），返回 next */
const move = (prev: Task, status: Status, now: number): Task => {
  const next: Task = { ...prev, status }
  transitionSpans(prev, next, now)
  return next
}

describe("transitionSpans 开启与封口", () => {
  test("领取（pending→analyzing）开启分析段", () => {
    const r = move(T("pending"), "analyzing", 1000)
    expect(r.spans?.analyzing).toEqual({ startedAt: 1000 })
    expect(r.spans?.executing).toBeUndefined()
  })

  test("提交分析（analyzing→executing）封口分析段并开启执行段", () => {
    const prev = T("analyzing", { analyzing: { startedAt: 1000 } })
    const r = move(prev, "executing", 4000)
    expect(r.spans?.analyzing).toEqual({ startedAt: 1000, endedAt: 4000 })
    expect(r.spans?.executing).toEqual({ startedAt: 4000 })
  })

  test("需确认的提交分析（analyzing→analysis_confirm）只封口不开启", () => {
    const prev = T("analyzing", { analyzing: { startedAt: 1000 } })
    const r = move(prev, "analysis_confirm", 4000)
    expect(r.spans?.analyzing).toEqual({ startedAt: 1000, endedAt: 4000 })
    expect(r.spans?.executing).toBeUndefined()
  })

  test("提交完成（executing→completion_confirm）封口执行段，等确认不再计时", () => {
    const prev = T("executing", {
      analyzing: { startedAt: 1000, endedAt: 4000 },
      executing: { startedAt: 4000 },
    })
    const r = move(prev, "completion_confirm", 9000)
    expect(r.spans?.executing).toEqual({ startedAt: 4000, endedAt: 9000 })
    expect(r.spans?.analyzing).toEqual({ startedAt: 1000, endedAt: 4000 })
  })

  test("进行中的段未被 already 封口时不覆写既有 endedAt", () => {
    const prev = T("executing", { executing: { startedAt: 1000, endedAt: 2000 } })
    const r = move(prev, "done", 9999)
    expect(r.spans?.executing?.endedAt).toBe(2000)
  })

  test("拖拽 analyzing→done 只封口分析段，不凭空开启执行段", () => {
    const prev = T("analyzing", { analyzing: { startedAt: 1000 } })
    const r = move(prev, "done", 4000)
    expect(r.spans).toEqual({ analyzing: { startedAt: 1000, endedAt: 4000 } })
  })

  test("人工拖入 analyzing（无 claim）同样开启分析段", () => {
    const r = move(T("pending"), "analyzing", 1000)
    expect(r.spans?.analyzing).toEqual({ startedAt: 1000 })
  })

  test("同段内迁移与只改标题都不动 spans", () => {
    const prev = T("analyzing", { analyzing: { startedAt: 1000 } })
    expect(move(prev, "analyzing", 5000).spans?.analyzing).toEqual({ startedAt: 1000 })
    // 非计时状态之间的迁移原样透传
    expect(move(T("planning"), "pending", 5000).spans).toBeUndefined()
  })

  test("不入参 spans 的老任务进入执行段后也能正常记录", () => {
    const r = move(T("executing"), "completion_confirm", 9000)
    expect(r.spans?.executing).toBeUndefined() // 无 startedAt 就不伪造区间
  })
})

describe("transitionSpans 新一轮重置", () => {
  test("放弃（analyzing→pending）整体清空，旧轮时长不串进新一轮", () => {
    const prev = T("analyzing", { analyzing: { startedAt: 1000 } })
    expect(move(prev, "pending", 4000).spans).toBeUndefined()
  })

  test("打回（completion_confirm→pending）整体清空", () => {
    const prev = T("completion_confirm", {
      analyzing: { startedAt: 1000, endedAt: 2000 },
      executing: { startedAt: 2000, endedAt: 3000 },
    })
    expect(move(prev, "pending", 4000).spans).toBeUndefined()
  })

  test("清空后重新领取开启全新一轮", () => {
    const prev = T("analyzing", { analyzing: { startedAt: 1000, endedAt: 2000 } })
    const released = move(prev, "pending", 3000)
    const claimed = move(released, "analyzing", 8000)
    expect(claimed.spans).toEqual({ analyzing: { startedAt: 8000 } })
  })

  test("拖出再拖回同一段：重开一轮而非续计", () => {
    const prev = T("analyzing", { analyzing: { startedAt: 1000 } })
    const out = move(prev, "planning", 2000)
    expect(out.spans?.analyzing).toEqual({ startedAt: 1000, endedAt: 2000 })
    const back = move(out, "analyzing", 9000)
    expect(back.spans).toEqual({ analyzing: { startedAt: 9000 } })
  })
})

describe("transitionSpans 不污染 prev", () => {
  test("封口写进 next 的独立副本，prev.spans 保持未封口", () => {
    const prev = T("analyzing", { analyzing: { startedAt: 1000 } })
    const next: Task = { ...prev, status: "executing" }
    transitionSpans(prev, next, 4000)
    expect(prev.spans?.analyzing).toEqual({ startedAt: 1000 })
    expect(next.spans?.analyzing?.endedAt).toBe(4000)
  })
})
