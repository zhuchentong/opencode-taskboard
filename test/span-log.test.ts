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
      spanLog: [
        { phase: "pending", round: 1, startedAt: 500, endedAt: 800 },
        { phase: "analyzing", round: 1, startedAt: 800 },
      ],
    })
    cur = move(cur, "pending", 2000)
    expect(cur.spans).toBeUndefined()
    expect(cur.spanLog).toHaveLength(3) // 历史段保留 + 开第 2 轮排队段
    expect(cur.round).toBe(2) // 进 pending 次数递增
    // 重做后新段标注新 round
    const redo = move(cur, "analyzing", 3000)
    expect(redo.spanLog![3].phase).toBe("analyzing")
    expect(redo.spanLog![3].round).toBe(2)
  })

  test("同段内迁移(prevPhase===nextPhase)spanLog 不动", () => {
    let cur = T("analyzing", { round: 1, spanLog: [{ phase: "analyzing", round: 1, startedAt: 1000 }] })
    cur = move(cur, "executing", 2000) // 离开 analyzing → 封口+开执行段
    expect(cur.spanLog).toHaveLength(2)
    const stable = move({ ...cur, status: "executing" }, "executing", 2500)
    expect(stable.spanLog).toHaveLength(2)
  })
})

describe("排队段入账(SPAN_PHASES 扩展)", () => {
  test("新建入列:planning→pending 开排队段(round 递增为 1),被领取封口并开分析段", () => {
    let cur = T("planning", { round: 0 })
    cur = move(cur, "pending", 1000)
    expect(cur.round).toBe(1)
    cur = move(cur, "analyzing", 2000)
    expect(cur.spanLog).toEqual([
      { phase: "pending", round: 1, startedAt: 1000, endedAt: 2000 },
      { phase: "analyzing", round: 1, startedAt: 2000 },
    ])
  })

  test("打回重做混合序列:每段独立留存,排队段标注新轮 round", () => {
    let cur = T("analyzing", {
      round: 1,
      claim: { sessionID: "ses_w1", agent: "build", claimedAt: 0 },
      spanLog: [
        { phase: "pending", round: 1, startedAt: 500, endedAt: 800 },
        { phase: "analyzing", round: 1, startedAt: 800 },
      ],
    })
    cur = move(cur, "pending", 1000) // 打回:封口分析段,开第 2 轮排队段
    cur = move(cur, "analyzing", 3000) // 重新领取
    cur = move(cur, "analysis_confirm", 4000) // 提交分析
    cur = move(cur, "analyzing", 5000) // 拖回:问答循环
    cur = move(cur, "analysis_confirm", 6000) // 再次提交
    const rows = cur.spanLog!.map((s) => `${s.phase}@r${s.round}:${s.startedAt}-${s.endedAt ?? "open"}`)
    expect(rows).toEqual([
      "pending@r1:500-800",
      "analyzing@r1:800-1000",
      "pending@r2:1000-3000",
      "analyzing@r2:3000-4000",
      "analysis_confirm@r2:4000-5000",
      "analyzing@r2:5000-6000",
      "analysis_confirm@r2:6000-open",
    ])
  })

  test("排队段封口拷贝领取时刻的 usage 累计快照", () => {
    let cur = T("pending", {
      round: 1,
      usage: { input: 11, output: 12, reasoning: 0, cacheRead: 13, cacheWrite: 0, at: 999 },
      spanLog: [{ phase: "pending", round: 1, startedAt: 1000 }],
    })
    cur = move(cur, "analyzing", 2000)
    expect(cur.spanLog![0].usage).toEqual({
      input: 11, output: 12, reasoning: 0, cacheRead: 13, cacheWrite: 0, at: 999,
    })
  })

  test("pending→pending(已在队列不重置):spanLog 不动、round 不变", () => {
    let cur = T("pending", {
      round: 3,
      spanLog: [{ phase: "pending", round: 3, startedAt: 1000 }],
    })
    cur = move(cur, "pending", 1500)
    expect(cur.spanLog).toHaveLength(1)
    expect(cur.round).toBe(3)
  })

  test("done→pending(人工拖回重跑):round 递增、开新排队段", () => {
    let cur = T("done", { round: 1 })
    cur = move(cur, "pending", 9000)
    expect(cur.round).toBe(2)
    expect(cur.spanLog).toEqual([{ phase: "pending", round: 2, startedAt: 9000 }])
  })
})
