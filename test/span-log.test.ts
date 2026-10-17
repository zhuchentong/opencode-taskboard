import { describe, expect, test } from "bun:test"
import { transitionSpans } from "../src/spans"
import type { Status, Task } from "../src/types"

const T = (status: Status, extra: Partial<Task> = {}): Task => ({
  id: "task_x",
  title: "t",
  description: "",
  status,
  comments: [],
  createdAt: 1,
  updatedAt: 1,
  ...extra,
})

/** 走一次迁移:prev → next(浅拷贝模拟 store 行为),返回 next */
const move = (prev: Task, status: Status, now: number): Task => {
  const next: Task = { ...prev, status }
  transitionSpans(prev, next, now)
  return next
}

describe("transitionSpans 双写 spanLog(分段计时账本)", () => {
  test("多段留存不覆盖:问答循环 analyzing→analysis_confirm→analyzing 各段全部保留", () => {
    let cur = T("pending", { round: 1 })
    cur = move(cur, "analyzing", 1000)
    cur = move(cur, "analysis_confirm", 2000)
    cur = move(cur, "analyzing", 3000)
    cur = move(cur, "analysis_confirm", 4000)
    const phases = cur.spanLog!.map((s) => `${s.phase}@${s.startedAt}-${s.endedAt ?? "open"}`)
    expect(phases).toEqual([
      "analyzing@1000-2000",
      "analysis_confirm@2000-3000",
      "analyzing@3000-4000",
      "analysis_confirm@4000-open", // 第二问等待中
    ])
    // 旧 spans 结构仍是「最后一段」语义,前端两段计时不受影响
    expect(cur.spans?.analyzing).toEqual({ startedAt: 3000, endedAt: 4000 })
    expect(cur.spans?.analysis_confirm).toBeUndefined() // 旧结构不含 analysis_confirm
  })

  test("spanLog 段带 round 与 sessionID(human claim 的空 sessionID 缺省)", () => {
    let cur = T("pending", { round: 2, claim: { sessionID: "ses_w1", agent: "build", claimedAt: 0 } })
    cur = move(cur, "analyzing", 1000)
    expect(cur.spanLog).toHaveLength(1)
    expect(cur.spanLog![0].round).toBe(2)
    expect(cur.spanLog![0].sessionID).toBe("ses_w1")
    let human = T("pending", { round: 1, claim: { sessionID: "", agent: "human", claimedAt: 0 } })
    human = move(human, "executing", 1000)
    expect(human.spanLog![0].sessionID).toBeUndefined()
  })

  test("封口段从 task.usage 拷贝累计快照;无 usage 则缺省", () => {
    let cur = T("analyzing", {
      round: 1,
      spanLog: [{ phase: "analyzing", round: 1, startedAt: 1000 }],
      usage: { input: 5, output: 6, reasoning: 0, cacheRead: 7, cacheWrite: 8, at: 999 },
    })
    cur = move(cur, "executing", 4000)
    expect(cur.spanLog).toHaveLength(2)
    expect(cur.spanLog![0].endedAt).toBe(4000)
    expect(cur.spanLog![0].usage).toEqual({
      input: 5,
      output: 6,
      reasoning: 0,
      cacheRead: 7,
      cacheWrite: 8,
      at: 999,
    })
    expect(cur.spanLog![1].usage).toBeUndefined() // 新段未封口不拷
  })

  test("回 pending:旧 spans 作废语义不变;spanLog 历史段保留;round 递增", () => {
    let cur = T("analyzing", {
      round: 1,
      spanLog: [{ phase: "analyzing", round: 1, startedAt: 1000 }],
    })
    cur = move(cur, "pending", 2000)
    expect(cur.spans).toBeUndefined()
    expect(cur.spanLog).toHaveLength(1) // 历史段保留
    expect(cur.round).toBe(2) // 进 pending 次数递增
    // 重做后新段标注新 round
    const redo = move(cur, "analyzing", 3000)
    expect(redo.spanLog![1].round).toBe(2)
  })

  test("同段内迁移(prevPhase===nextPhase)spanLog 不动", () => {
    let cur = T("analyzing", { round: 1, spanLog: [{ phase: "analyzing", round: 1, startedAt: 1000 }] })
    cur = move(cur, "executing", 2000) // 离开 analyzing → 封口+开执行段
    expect(cur.spanLog).toHaveLength(2)
    const stable = move({ ...cur, status: "executing" }, "executing", 2500)
    expect(stable.spanLog).toHaveLength(2)
  })
})
