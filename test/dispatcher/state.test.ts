import { describe, expect, test } from "bun:test"
import type { Status, Task } from "../../src/types"
import {
  extractTransitions,
  loadAlongState,
  markActed,
  serializeAlongState,
  shouldAct,
} from "../../src/dispatcher/state"
import type { AlongMaps } from "../../src/dispatcher/state"

const t = (id: string, status: Task["status"]): Task => ({
  id,
  title: `任务${id}`,
  description: "",
  status,
  comments: [],
  createdAt: 1,
  updatedAt: 1,
})

const newMaps = (): AlongMaps => ({
  lastSeen: new Map(),
  lastActedSeq: new Map(),
  rounds: new Map(),
  taskBackoff: new Map(),
  seqCounter: 0,
})

const counter = (maps: AlongMaps) => () => ++maps.seqCounter

describe("extractTransitions(沿提取)", () => {
  test("首次观测的新任务:只记录 lastSeen,不提沿(防重启/新任务误触发)", () => {
    const maps = newMaps()
    const along = extractTransitions(maps.lastSeen, [t("t1", "executing")], counter(maps))
    expect(along).toEqual([])
    expect(maps.lastSeen.get("t1")).toBe("executing")
  })

  test("单步沿:lastSeen=pending → 本轮 analysis_confirm,提 1 条沿并推进 lastSeen", () => {
    const maps = newMaps()
    maps.lastSeen.set("t1", "pending")
    const along = extractTransitions(maps.lastSeen, [t("t1", "analysis_confirm")], counter(maps))
    expect(along).toEqual([{ taskID: "t1", from: "pending", to: "analysis_confirm", seq: 1 }])
    expect(maps.lastSeen.get("t1")).toBe("analysis_confirm")
  })

  test("链式多轮:analysis_confirm→analyzing→analysis_confirm 分两轮观测,各提一条沿", () => {
    const maps = newMaps()
    maps.lastSeen.set("t1", "analysis_confirm")
    const first = extractTransitions(maps.lastSeen, [t("t1", "analyzing")], counter(maps))
    expect(first).toEqual([{ taskID: "t1", from: "analysis_confirm", to: "analyzing", seq: 1 }])
    const second = extractTransitions(maps.lastSeen, [t("t1", "analysis_confirm")], counter(maps))
    expect(second).toEqual([{ taskID: "t1", from: "analyzing", to: "analysis_confirm", seq: 2 }])
  })

  test("seq 严格递增:同一批多任务各自提沿,seq 单调不重复", () => {
    const maps = newMaps()
    maps.lastSeen.set("t1", "pending")
    maps.lastSeen.set("t2", "pending")
    const along = extractTransitions(
      maps.lastSeen,
      [t("t1", "analyzing"), t("t2", "analyzing")],
      counter(maps),
    )
    expect(along.map((x) => x.seq)).toEqual([1, 2])
  })

  test("同状态无沿:lastSeen==status → 零沿、lastSeen 原值保留", () => {
    const maps = newMaps()
    maps.lastSeen.set("t1", "analyzing")
    const along = extractTransitions(maps.lastSeen, [t("t1", "analyzing")], counter(maps))
    expect(along).toEqual([])
    expect(maps.lastSeen.get("t1")).toBe("analyzing")
  })
})

describe("沿幂等(lastActedSeq)", () => {
  test("shouldAct:seq > 已记录时 true,否则 false;未知任务视为 0", () => {
    const lastActed = new Map<string, number>([["t1", 5]])
    // 测试故意用非枚举值:shouldAct 只比较 taskID 与 seq,不校验 Status 合法性
    expect(shouldAct(lastActed, { taskID: "t1", from: "a" as Status, to: "b" as Status, seq: 6 })).toBe(true)
    expect(shouldAct(lastActed, { taskID: "t1", from: "a" as Status, to: "b" as Status, seq: 5 })).toBe(false)
    expect(shouldAct(lastActed, { taskID: "t2", from: "a" as Status, to: "b" as Status, seq: 1 })).toBe(true)
  })

  test("markActed 后同沿 shouldAct 为 false", () => {
    const lastActed = new Map<string, number>()
    // 测试故意用非枚举值:沿对象只承载 taskID/seq 比较,from/to 不做 Status 合法性校验
    const along = { taskID: "t1", from: "a" as Status, to: "b" as Status, seq: 3 }
    expect(shouldAct(lastActed, along)).toBe(true)
    markActed(lastActed, along)
    expect(shouldAct(lastActed, along)).toBe(false)
  })
})

describe("沿状态 blob 序列化", () => {
  test("serialize → load 往返一致:含 lastSeen/lastActedSeq/rounds/taskBackoff/seqCounter", () => {
    const maps = newMaps()
    maps.lastSeen.set("t1", "analyzing")
    maps.lastActedSeq.set("t1", 7)
    maps.rounds.set("t1", 2)
    maps.taskBackoff.set("t1", { timeoutStreak: 1, cooldownUntil: 1234 })
    maps.seqCounter = 9
    const raw = serializeAlongState(maps)
    const restored = loadAlongState(JSON.parse(raw))
    expect(restored.lastSeen).toEqual({ t1: "analyzing" })
    expect(restored.lastActedSeq).toEqual({ t1: 7 })
    expect(restored.rounds).toEqual({ t1: 2 })
    expect(restored.taskBackoff).toEqual({ t1: { timeoutStreak: 1, cooldownUntil: 1234 } })
    expect(restored.seqCounter).toBe(9)
  })

  test("loadAlongState 容错:结构不认得返回空态(宁可重学,不可用假数据)", () => {
    for (const bad of [undefined, null, 42, "x", { lastSeen: "not-an-object" }]) {
      const s = loadAlongState(bad)
      expect(s.lastSeen).toEqual({})
      expect(s.lastActedSeq).toEqual({})
      expect(s.rounds).toEqual({})
      expect(s.taskBackoff).toEqual({})
      expect(s.seqCounter).toBe(0)
    }
  })

  test("round 与 taskBackoff 记录可随 blob 恢复(重启后不误触发)", () => {
    const maps = newMaps()
    maps.rounds.set("t1", 3)
    maps.taskBackoff.set("t1", { timeoutStreak: 2, cooldownUntil: Date.now() + 60_000 })
    const restored = loadAlongState(JSON.parse(serializeAlongState(maps)))
    expect(restored.rounds.t1).toBe(3)
    expect(restored.taskBackoff.t1.timeoutStreak).toBe(2)
  })
})
