import { describe, expect, test } from "bun:test"
import { STATUS_LABELS, STATUSES, groupByStatus, timeAgo } from "../src/lib/board"
import type { Task } from "../src/lib/types"

const T = (over: Partial<Task>): Task => ({
  id: "task_x",
  title: "t",
  description: "",
  status: "pending",
  comments: [],
  createdAt: 1,
  updatedAt: 1,
  ...over,
})

describe("STATUSES / STATUS_LABELS", () => {
  test("七态顺序与中文列头固定", () => {
    expect([...STATUSES]).toEqual([
      "planning",
      "pending",
      "analyzing",
      "analysis_confirm",
      "executing",
      "completion_confirm",
      "done",
    ])
    expect(STATUS_LABELS.pending).toBe("待领取")
    expect(STATUS_LABELS.completion_confirm).toBe("完成确认")
  })
})

describe("groupByStatus", () => {
  test("按状态分组，七键齐全，空状态为空数组", () => {
    const g = groupByStatus([T({ id: "a", status: "pending" })])
    expect(Object.keys(g)).toHaveLength(7)
    expect(g.pending.map((t) => t.id)).toEqual(["a"])
    expect(g.done).toEqual([])
  })

  test("列内 updatedAt 倒序（新的在前）", () => {
    const g = groupByStatus([
      T({ id: "old", updatedAt: 100 }),
      T({ id: "new", updatedAt: 200 }),
      T({ id: "mid", updatedAt: 150 }),
    ])
    expect(g.pending.map((t) => t.id)).toEqual(["new", "mid", "old"])
  })
})

describe("timeAgo", () => {
  test("边界：<60s 刚刚；<60m 分钟前；<24h 小时前；更早显示日期", () => {
    const now = Date.now()
    expect(timeAgo(now - 5_000)).toBe("刚刚")
    expect(timeAgo(now - 59_000)).toBe("刚刚") // 严格 <60s 才是刚刚（留 1s 余量防毫秒抖动）
    expect(timeAgo(now - 5 * 60_000)).toBe("5 分钟前")
    expect(timeAgo(now - 59 * 60_000)).toBe("59 分钟前")
    expect(timeAgo(now - 3 * 3_600_000)).toBe("3 小时前")
    const d = new Date(now - 2 * 86_400_000)
    expect(timeAgo(now - 2 * 86_400_000)).toBe(`${d.getMonth() + 1}月${d.getDate()}日`)
  })
})
