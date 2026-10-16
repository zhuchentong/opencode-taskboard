import { describe, expect, test } from "bun:test"
import { formatTokens, totalTokens } from "../src/lib/usage"
import type { TaskUsage } from "../src/lib/types"

const U = (over: Partial<TaskUsage> = {}): TaskUsage => ({
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
  at: 1_700_000_000_000,
  ...over,
})

describe("formatTokens", () => {
  test("千以下原样显示", () => {
    expect(formatTokens(0)).toBe("0")
    expect(formatTokens(1)).toBe("1")
    expect(formatTokens(999)).toBe("999")
  })

  test("千档向下取整，不四舍五入", () => {
    expect(formatTokens(1000)).toBe("1k")
    expect(formatTokens(1500)).toBe("1k")
    expect(formatTokens(128_000)).toBe("128k")
    expect(formatTokens(999_999)).toBe("999k")
  })

  test("百万档保留一位小数", () => {
    expect(formatTokens(1_000_000)).toBe("1.0M")
    expect(formatTokens(1_234_567)).toBe("1.2M")
    // <1e9 档的边界内：999.999999M 四舍五入后就是 1000.0M（字面规则如此）
    expect(formatTokens(999_999_999)).toBe("1000.0M")
  })

  test("十亿档保留一位小数", () => {
    expect(formatTokens(1_000_000_000)).toBe("1.0G")
    expect(formatTokens(1_234_567_890)).toBe("1.2G")
  })

  test("负数、NaN 与无穷兜底为 0，不显示异常值", () => {
    expect(formatTokens(-1)).toBe("0")
    expect(formatTokens(-1000)).toBe("0")
    expect(formatTokens(Number.NaN)).toBe("0")
    expect(formatTokens(Number.POSITIVE_INFINITY)).toBe("0")
  })
})

describe("totalTokens", () => {
  test("五个计量字段求和", () => {
    expect(totalTokens(U({ input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5 }))).toBe(15)
  })

  test("全零快照合计为 0", () => {
    expect(totalTokens(U())).toBe(0)
  })

  test("缺字段按 0 容错（旧快照只有部分字段）", () => {
    expect(totalTokens({ input: 7 } as TaskUsage)).toBe(7)
    expect(totalTokens({} as TaskUsage)).toBe(0)
  })

  test("负数/NaN 字段按 0 容错，不把合计算成负值", () => {
    expect(totalTokens(U({ input: -5, output: Number.NaN, reasoning: 10 }))).toBe(10)
  })
})
