import { describe, expect, test } from "bun:test"
import { createDeltaBuffer, contentUpdatedFrame, type LiveFrame } from "../src/live"

describe("createDeltaBuffer", () => {
  test("text delta 按消息分桶，flush 产出 text-append 帧且清空缓冲", () => {
    const buf = createDeltaBuffer()
    buf.push("text", "msg_a", "你好")
    buf.push("text", "msg_b", "world")
    buf.push("text", "msg_a", "！")
    const frames = buf.flush()
    expect(frames).toEqual([
      { type: "text-append", kind: "text", messageID: "msg_a", text: "你好！" },
      { type: "text-append", kind: "text", messageID: "msg_b", text: "world" },
    ])
    expect(buf.flush()).toEqual([]) // 幂等：flush 后缓冲为空
  })

  test("text 与 reasoning 分桶互不串话", () => {
    const buf = createDeltaBuffer()
    buf.push("reasoning", "msg_a", "思考中")
    buf.push("text", "msg_a", "回答")
    const frames = buf.flush()
    expect(frames).toContainEqual({ type: "text-append", kind: "reasoning", messageID: "msg_a", text: "思考中" })
    expect(frames).toContainEqual({ type: "text-append", kind: "text", messageID: "msg_a", text: "回答" })
  })

  test("clear 清空全部桶", () => {
    const buf = createDeltaBuffer()
    buf.push("text", "msg_a", "x")
    buf.clear()
    expect(buf.flush()).toEqual([])
  })
})

describe("contentUpdatedFrame", () => {
  test("content.updated 归一化为 content 帧，tool part 保留名字与状态", () => {
    const frame = contentUpdatedFrame({
      messageID: "msg_1",
      content: [
        { type: "text", text: "hi" },
        { type: "tool", id: "c1", name: "bash", state: { status: "running", input: { command: "ls" } } },
        { type: "step-start" }, // normalizePart 会过滤
      ],
    })
    expect(frame).toEqual({
      type: "content",
      messageID: "msg_1",
      parts: [
        { type: "text", text: "hi" },
        { type: "tool", tool: "bash", state: "running", input: '{"command":"ls"}' },
      ],
    })
  })

  test("content 缺失或非数组返回 null", () => {
    expect(contentUpdatedFrame({ messageID: "m" })).toBeNull()
    expect(contentUpdatedFrame({ messageID: "m", content: "bad" })).toBeNull()
  })
})
