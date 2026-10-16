import { describe, expect, test } from "bun:test"
import { boardKey } from "../src/web/viewmodel.js"
import type { Task } from "../src/types"

const T = (over: Partial<Task>): Task => ({
  id: "task_a",
  title: "t",
  description: "",
  status: "pending",
  comments: [],
  createdAt: 1,
  updatedAt: 1,
  ...over,
})

describe("boardKey（渲染守卫：内容指纹）", () => {
  test("相同内容 → 相同 key", () => {
    const a = boardKey([T({})], { requireAnalysisConfirm: false })
    const b = boardKey([T({ updatedAt: 1 })], { requireAnalysisConfirm: false })
    expect(a).toBe(b)
  })
  test("状态/标题/评论数/领取者/设置 任一变化 → key 变化", () => {
    const base = boardKey([T({})], { requireAnalysisConfirm: false })
    expect(boardKey([T({ status: "analyzing" })], { requireAnalysisConfirm: false })).not.toBe(base)
    expect(boardKey([T({ title: "x" })], { requireAnalysisConfirm: false })).not.toBe(base)
    expect(boardKey([T({ comments: [{ author: "user", text: "c", createdAt: 1 }] })], { requireAnalysisConfirm: false })).not.toBe(base)
    expect(boardKey([T({ claim: { sessionID: "s", agent: "a", claimedAt: 1 } })], { requireAnalysisConfirm: false })).not.toBe(base)
    expect(boardKey([T({})], { requireAnalysisConfirm: true })).not.toBe(base)
  })
  test("updatedAt 变化（即使其他字段相同）→ key 变化", () => {
    expect(boardKey([T({ updatedAt: 2 })], { requireAnalysisConfirm: false })).not.toBe(
      boardKey([T({ updatedAt: 1 })], { requireAnalysisConfirm: false }),
    )
  })
})
