import { describe, expect, test } from "bun:test"
import { shouldEmit } from "../src/lib/throttle"

describe("固定窗口节流判定 shouldEmit", () => {
  test("首次调用返回 true 并记录时间", () => {
    const last = new Map<string, number>()
    expect(shouldEmit(last, "t1", 1000)).toBe(true)
    expect(last.get("t1")).toBe(1000)
  })

  test("窗口内第二次返回 false", () => {
    const last = new Map<string, number>()
    shouldEmit(last, "t1", 1000)
    expect(shouldEmit(last, "t1", 1000 + 4999)).toBe(false)
  })

  test("窗口内第三次仍返回 false（不刷新窗口）", () => {
    const last = new Map<string, number>()
    shouldEmit(last, "t1", 1000)
    expect(shouldEmit(last, "t1", 3000)).toBe(false)
    // 若第二次刷新了窗口，这里会误判为 false 之后又挡一波；固定窗口下 6000 已过期
    expect(shouldEmit(last, "t1", 6000)).toBe(true)
  })

  test("窗口过期后返回 true 并刷新记录", () => {
    const last = new Map<string, number>()
    shouldEmit(last, "t1", 1000)
    expect(shouldEmit(last, "t1", 1000 + 5000)).toBe(true)
    expect(last.get("t1")).toBe(6000)
  })

  test("自定义窗口宽度生效", () => {
    const last = new Map<string, number>()
    shouldEmit(last, "t1", 1000, 500)
    expect(shouldEmit(last, "t1", 1400, 500)).toBe(false)
    expect(shouldEmit(last, "t1", 1500, 500)).toBe(true)
  })

  test("多 key 互不影响", () => {
    const last = new Map<string, number>()
    shouldEmit(last, "t1", 1000)
    expect(shouldEmit(last, "t2", 2000)).toBe(true)
    expect(shouldEmit(last, "t1", 2000)).toBe(false)
    expect(shouldEmit(last, "t2", 3000)).toBe(false)
  })
})
