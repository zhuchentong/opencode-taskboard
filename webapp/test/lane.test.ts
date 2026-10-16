import { describe, expect, test } from "bun:test"
import { insertIndex } from "../src/lib/lane"

// 模拟横向排列的卡片矩形：每张宽 100、间隔 10，从 x=0 起
const rects = (n: number) => (i: number) => {
  if (i < 0 || i >= n) throw new RangeError(`index ${i} 越界`)
  const left = i * 110
  return { left, right: left + 100, top: 0, bottom: 100, width: 100 } as DOMRect
}

describe("insertIndex（泳道内横向插入判定）", () => {
  test("空序列 → 0", () => {
    expect(insertIndex(0, 500, rects(0))).toBe(0)
  })

  test("指针在卡片左半 → 插其前；右半 → 插其后", () => {
    expect(insertIndex(3, 30, rects(3))).toBe(0) // 第 0 张中线 50，30 < 50 → 前
    expect(insertIndex(3, 70, rects(3))).toBe(1) // 第 0 张右半 → 1
    expect(insertIndex(3, 140, rects(3))).toBe(1) // 第 1 张左半（110..210，中线 160）→ 前
    expect(insertIndex(3, 180, rects(3))).toBe(2) // 第 1 张右半
  })

  test("首尾边界：最左得 0，越过末尾得 count", () => {
    expect(insertIndex(3, -50, rects(3))).toBe(0)
    expect(insertIndex(3, 10_000, rects(3))).toBe(3)
  })
})
