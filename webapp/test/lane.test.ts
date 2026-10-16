import { describe, expect, test } from "bun:test"
import { insertIndex } from "../src/lib/lane"

// 模拟 band 内 flex wrap 的卡片矩形：每张宽 100、间隔 10（间距 110），每行 perRow 张，行高 110
const rects = (n: number, perRow = 4) => (i: number) => {
  if (i < 0 || i >= n) throw new RangeError(`index ${i} 越界`)
  const left = (i % perRow) * 110
  const top = Math.floor(i / perRow) * 110
  return { left, top, width: 100, height: 100 } as DOMRect
}

describe("insertIndex（泳道内插入判定，支持 wrap 多行）", () => {
  test("空序列 → 0", () => {
    expect(insertIndex(0, 500, 50, rects(0))).toBe(0)
  })

  test("单行：指针在卡片左半 → 插其前；右半 → 插其后", () => {
    expect(insertIndex(3, 30, 50, rects(3))).toBe(0)
    expect(insertIndex(3, 70, 50, rects(3))).toBe(1)
    expect(insertIndex(3, 140, 50, rects(3))).toBe(1)
    expect(insertIndex(3, 180, 50, rects(3))).toBe(2)
    expect(insertIndex(3, 10_000, 50, rects(3))).toBe(3)
  })

  test("wrap 双行：判定限定在指针所在行，返回原始下标", () => {
    // 5 张卡：A B C D 在第 0 行（top 0），E 独占第 1 行（top 110，left 0）
    expect(insertIndex(5, 30, 50, rects(5))).toBe(0) // 指第 0 行 A 左半
    expect(insertIndex(5, 30, 160, rects(5))).toBe(4) // 指第 1 行 E 左半（0..100，中线 50）→ 插 E 前（原下标 4）
    expect(insertIndex(5, 100, 160, rects(5))).toBe(5) // 指第 1 行 E 右半 → 行尾之后
  })

  test("指针落在两行之间 → 归属垂直中心更近的行", () => {
    // y=105 恰在两行之间（中心 50 与 160 等距 55）→ 取先遍历到的第 0 行
    expect(insertIndex(5, 30, 105, rects(5))).toBe(0)
  })
})
