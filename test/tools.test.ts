import { describe, expect, test } from "bun:test"
import { describeError, renderTask } from "../src/tools"
import { StoreError, type Task } from "../src/types"

describe("describeError", () => {
  test("not_found 含放弃指引原文", () => {
    const text = describeError(new StoreError("not_found", "任务不存在：task_x"))
    expect(text).toContain("任务已不存在（可能已被删除），请放弃该任务")
  })

  test("各错误码输出含关键词的中文文案", () => {
    const cases: [Parameters<typeof describeError>[0], string][] = [
      [new StoreError("invalid_transition", "任务状态为 executing，仅待领取任务可认领"), "状态"],
      [new StoreError("conflict", "冲突"), "冲突"],
      [new StoreError("not_claimer", "任务由 build 领取"), "领取"],
      [new StoreError("comment_required", "打回必须附评论"), "评论"],
      [new StoreError("no_pending", "当前没有待领取的任务"), "没有待领取"],
      [new StoreError("invalid_input", "参数不合法"), "参数"],
    ]
    for (const [err, keyword] of cases) {
      expect(describeError(err)).toContain(keyword)
    }
  })

  test("未知错误兜底文案", () => {
    const text = describeError(new Error("boom"))
    expect(text).toContain("看板操作失败")
    expect(text).toContain("boom")
  })

  test("describeError：unreachable 与 forbidden 给出可操作文案", () => {
    expect(describeError(new StoreError("unreachable", "连不上"))).toContain("不可达")
    expect(describeError(new StoreError("forbidden", "令牌错"))).toContain("令牌不匹配")
  })
})

describe("renderTask", () => {
  const t: Task = {
    id: "task_abc",
    title: "修复登录",
    description: "描述",
    status: "analyzing",
    comments: [{ author: "user", text: "返工", createdAt: 1 }],
    claim: { sessionID: "s1", agent: "build", claimedAt: 2 },
    createdAt: 3,
    updatedAt: 4,
  }
  test("含 id/状态/标题/领取信息/评论数", () => {
    const text = renderTask(t)
    expect(text).toContain("task_abc")
    expect(text).toContain("修复登录")
    expect(text).toContain("analyzing")
    expect(text).toContain("build")
    expect(text).toContain("1 条")
  })
  test("confirm 状态提示等待用户确认", () => {
    expect(renderTask({ ...t, status: "analysis_confirm" })).toContain("等待用户")
  })
})
