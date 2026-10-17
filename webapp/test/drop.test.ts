import { describe, expect, test } from "bun:test"
import { dropTask } from "../src/lib/drop"

describe("dropTask——拖拽落点判定", () => {
  test("同泳道返回 null（弹回，不发热请求）", () => {
    expect(dropTask("pending", "pending")).toBeNull()
  })
  test("跨泳道返回目标状态", () => {
    expect(dropTask("pending", "analyzing")).toEqual({ status: "analyzing" })
  })
  test("相邻泳道 planning → pending", () => {
    expect(dropTask("planning", "pending")).toEqual({ status: "pending" })
  })
})
