import { expect, test } from "bun:test"
import { applyFrame, type LiveFrame } from "../src/lib/live-context"
import type { ContextMessage } from "../src/lib/context"

const M = (id: string, parts: ContextMessage["parts"]): ContextMessage => ({ id, role: "assistant", time: 1, parts })

test("text-append 追加到最后一个 text part；无则创建占位并标记 streaming", () => {
  const msgs = applyFrame([M("m1", [{ type: "text", text: "a" }])], { type: "text-append", kind: "text", messageID: "m1", text: "b" })
  expect(msgs[0]!.parts).toEqual([{ type: "text", text: "ab" }])
  expect(msgs[0]!.streaming).toBe(true)
  const created = applyFrame([], { type: "text-append", kind: "reasoning", messageID: "m2", text: "思" })
  expect(created[0]!.id).toBe("m2")
  expect(created[0]!.role).toBe("assistant")
  expect(created[0]!.streaming).toBe(true)
  expect(created[0]!.parts).toEqual([{ type: "reasoning", text: "思" }])
})

test("text-append 追加到最后一个同 kind part，而不是末尾的其他 kind part", () => {
  const msgs = applyFrame(
    [M("m1", [{ type: "text", text: "一" }, { type: "tool", tool: "bash" }])],
    { type: "text-append", kind: "text", messageID: "m1", text: "二" },
  )
  expect(msgs[0]!.parts).toEqual([{ type: "text", text: "一二" }, { type: "tool", tool: "bash" }])
})

test("text-append 命中多个同 kind part 时追加到最后一个", () => {
  const msgs = applyFrame(
    [M("m1", [{ type: "text", text: "一" }, { type: "tool", tool: "bash" }, { type: "text", text: "二" }])],
    { type: "text-append", kind: "text", messageID: "m1", text: "三" },
  )
  expect(msgs[0]!.parts).toEqual([
    { type: "text", text: "一" },
    { type: "tool", tool: "bash" },
    { type: "text", text: "二三" },
  ])
})

test("content 帧整体替换该消息 parts（权威快照）并置 streaming", () => {
  const msgs = applyFrame(
    [M("m1", [{ type: "text", text: "旧" }])],
    { type: "content", messageID: "m1", parts: [{ type: "tool", tool: "bash", state: "completed", output: "ok" }] },
  )
  expect(msgs[0]!.parts).toEqual([{ type: "tool", tool: "bash", state: "completed", output: "ok" }])
  expect(msgs[0]!.streaming).toBe(true) // 实时帧触及即置流式态，等 message-end 才定格
})

test("message-end(null) 全部定格；message-end(id) 仅该消息", () => {
  const two = [M("m1", []), M("m2", [])]
  expect(applyFrame(two, { type: "message-end", messageID: null }).every((m) => m.streaming === false)).toBe(true)
  const one = applyFrame([{ ...M("m1", []), streaming: true }, M("m2", [])], { type: "message-end", messageID: "m1" })
  expect(one[0]!.streaming).toBe(false)
  expect(one[1]!.streaming).toBeUndefined()
})

test("未知消息的 content 帧创建消息并插到头部（最新在前，与快照倒序一致）", () => {
  const msgs = applyFrame([M("old", [])], { type: "content", messageID: "new", parts: [{ type: "text", text: "x" }] })
  expect(msgs.map((m) => m.id)).toEqual(["new", "old"])
  expect(msgs[0]!.streaming).toBe(true)
})

test("未知帧类型不产变化：返回原数组（镜像类型与服务端脱节时的兜底）", () => {
  const input = [M("m1", [])]
  expect(applyFrame(input, { type: "未知帧" } as unknown as LiveFrame)).toBe(input)
})

test("now 参数可注入：新消息时间戳用它（纯函数可测）", () => {
  const created = applyFrame([], { type: "text-append", kind: "text", messageID: "m2", text: "x" }, 12345)
  expect(created[0]!.time).toBe(12345)
})

test("applyFrame 返回新数组不改入参（Svelte $state 兼容）", () => {
  const input = [M("m1", [{ type: "text", text: "a" }])]
  const before = JSON.stringify(input)
  const out = applyFrame(input, { type: "text-append", kind: "text", messageID: "m1", text: "b" })
  expect(out).not.toBe(input) // 返回新数组
  expect(out[0]!.parts[0]!.text).toBe("ab")
  expect(JSON.stringify(input)).toBe(before) // 入参数组与其 parts 均未被改写
  expect(input[0]!.streaming).toBeUndefined()
  applyFrame(input, { type: "message-end", messageID: null })
  expect(input[0]!.streaming).toBeUndefined() // 定格也不写回入参
})
