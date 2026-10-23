import { describe, expect, test } from "bun:test"
import { STATUS_HINTS, STATUS_LABELS, STATUS_TOKEN, STATUSES, groupByStatus, timeAgo } from "../src/lib/board"
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

describe("STATUS_TOKEN 七状态色板", () => {
  test("七键齐全，每键含 dot 与 band 且均为非空字符串", () => {
    expect(Object.keys(STATUS_TOKEN)).toHaveLength(7)
    for (const s of STATUSES) {
      const t = STATUS_TOKEN[s]
      expect(t.dot.length).toBeGreaterThan(0)
      expect(t.band.length).toBeGreaterThan(0)
      // 圆点类必须是背景类、色带类必须是左边框类（消费方类名契约）
      expect(t.dot.startsWith("bg-")).toBe(true)
      expect(t.band.startsWith("border-l-")).toBe(true)
    }
  })

  test("两个确认列有意同色（琥珀=等人工裁决）", () => {
    expect(STATUS_TOKEN.analysis_confirm).toEqual(STATUS_TOKEN.completion_confirm)
  })

  test("pending 活跃排队：脉冲动画且尊重减弱动效偏好", () => {
    expect(STATUS_TOKEN.pending.dot).toContain("animate-pulse")
    expect(STATUS_TOKEN.pending.dot).toContain("motion-reduce:animate-none")
  })

  test("七状态 dot 互不雷同（done 的灰与 pending 的蓝可区分）", () => {
    const dots = STATUSES.map((s) => STATUS_TOKEN[s].dot)
    expect(new Set(dots.filter((_, i) => STATUSES[i] !== "completion_confirm")).size).toBe(6)
  })
})

describe("STATUS_HINTS 空泳道引导文案", () => {
  test("七键齐全，均为非空中文文案", () => {
    expect(Object.keys(STATUS_HINTS)).toHaveLength(7)
    for (const s of STATUSES) {
      expect(STATUS_HINTS[s].length).toBeGreaterThan(0)
      // 含中文（拒绝空串/占位符漏配）
      expect(/[\u4e00-\u9fff]/.test(STATUS_HINTS[s])).toBe(true)
    }
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
