import { describe, expect, test } from "bun:test"
import {
  emptyHint,
  loadReasoningPref,
  roleMeta,
  saveReasoningPref,
  splitParts,
  toolStateIcon,
  toolSummary,
  type ContextPart,
} from "../src/lib/context"
import type { Task } from "../src/lib/types"

const T = (over: Partial<Task> = {}): Task => ({
  id: "t1",
  title: "标题",
  description: "",
  status: "executing",
  comments: [],
  createdAt: 1,
  updatedAt: 1,
  ...over,
})

describe("toolSummary", () => {
  test("read 取 path 字段", () => {
    expect(toolSummary({ type: "tool", tool: "read", input: JSON.stringify({ path: "src/a.ts" }) })).toBe("read src/a.ts")
  })

  test("bash 取 command 字段", () => {
    expect(toolSummary({ type: "tool", tool: "bash", input: JSON.stringify({ command: "bun test" }) })).toBe("bash bun test")
  })

  test("edit/write 取 file_path", () => {
    expect(toolSummary({ type: "tool", tool: "edit", input: JSON.stringify({ file_path: "src/b.ts" }) })).toBe("edit src/b.ts")
    expect(toolSummary({ type: "tool", tool: "write", input: JSON.stringify({ file_path: "src/c.ts" }) })).toBe("write src/c.ts")
  })

  test("grep 取 pattern；glob 取 pattern", () => {
    expect(toolSummary({ type: "tool", tool: "grep", input: JSON.stringify({ pattern: "foo" }) })).toBe("grep foo")
    expect(toolSummary({ type: "tool", tool: "glob", input: JSON.stringify({ pattern: "**/*.ts" }) })).toBe("glob **/*.ts")
  })

  test("taskboard_claim 取 id", () => {
    expect(toolSummary({ type: "tool", tool: "taskboard_claim", input: JSON.stringify({ id: "task_x" }) })).toBe("taskboard_claim task_x")
  })

  test("未知工具：input 解析失败回退原串截断", () => {
    expect(toolSummary({ type: "tool", tool: "weird", input: "不是 JSON".repeat(50) })).toHaveLength(20)
  })

  test("无 input 只有工具名", () => {
    expect(toolSummary({ type: "tool", tool: "read" })).toBe("read")
  })
})

describe("roleMeta", () => {
  test("user 是派发的指令，assistant 是 worker 回复", () => {
    expect(roleMeta("user")).toEqual({ label: "worker 指令", icon: "▶" })
    expect(roleMeta("assistant")).toEqual({ label: "worker", icon: "🤖" })
  })

  test("未知角色兜底", () => {
    expect(roleMeta("system").label).toBe("system")
  })
})

describe("emptyHint", () => {
  test("未领取 → 尚未开工", () => {
    expect(emptyHint(T({ status: "pending" }))).toContain("尚未开工")
  })

  test("human claim → 用户手动执行", () => {
    expect(emptyHint(T({ status: "executing", claim: { sessionID: "", agent: "human", claimedAt: 1 } }))).toContain("手动执行")
  })

  test("worker claim 但服务端无消息 → 会话暂无消息", () => {
    expect(emptyHint(T({ status: "executing", claim: { sessionID: "ses_a", agent: "build", claimedAt: 1 } }))).toContain("暂无消息")
  })
})

describe("part 展示辅助", () => {
  test("toolStateIcon：completed 绿勾、error 红叉、running 转圈", () => {
    expect(toolStateIcon({ type: "tool", tool: "read", state: "completed" } as ContextPart)).toBe("✓")
    expect(toolStateIcon({ type: "tool", tool: "read", state: "error" } as ContextPart)).toBe("✗")
    expect(toolStateIcon({ type: "tool", tool: "read", state: "running" } as ContextPart)).toBe("⏳")
    expect(toolStateIcon({ type: "tool", tool: "read" } as ContextPart)).toBe("·")
  })
})

describe("splitParts · 思考过程显隐", () => {
  const text: ContextPart = { type: "text", text: "正文" }
  const think1: ContextPart = { type: "reasoning", text: "思考一" }
  const think2: ContextPart = { type: "reasoning", text: "思考二" }
  const tool: ContextPart = { type: "tool", tool: "read" }

  test("开关开：原样返回（引用相等）且计数为 0", () => {
    const parts = [think1, text, think2, tool]
    const r = splitParts(parts, true)
    expect(r.visible).toBe(parts)
    expect(r.reasoningCount).toBe(0)
  })

  test("开关关：reasoning 全部滤掉，非 reasoning 保持原顺序", () => {
    const r = splitParts([think1, text, think2, tool], false)
    expect(r.visible).toEqual([text, tool])
    expect(r.reasoningCount).toBe(2)
  })

  test("无 reasoning：visible 即原列表，计数 0", () => {
    const r = splitParts([text, tool], false)
    expect(r.visible).toEqual([text, tool])
    expect(r.reasoningCount).toBe(0)
  })

  test("纯 reasoning：visible 为空数组，计数齐全", () => {
    const r = splitParts([think1, think2], false)
    expect(r.visible).toEqual([])
    expect(r.reasoningCount).toBe(2)
  })
})

describe("思考过程偏好读写（无 localStorage 环境静默容错）", () => {
  test("bun 测试环境无 localStorage：默认关、写不抛、读仍为关", () => {
    // 本仓库 bun 测试环境实测 globalThis.localStorage === undefined，
    // 函数内部必须走可选链 + try/catch 静默回落——这里把该契约钉住
    expect(globalThis.localStorage).toBeUndefined()
    expect(loadReasoningPref()).toBe(false)
    expect(() => saveReasoningPref(true)).not.toThrow()
    expect(loadReasoningPref()).toBe(false)
  })
})
