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

  test("空文本增量不占桶", () => {
    const buf = createDeltaBuffer()
    buf.push("text", "msg_a", "")
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

  test("tool 输出从 state.content 的 text 条目按序拼出，与快照形态一致", () => {
    const frame = contentUpdatedFrame({
      messageID: "msg_2",
      content: [
        {
          type: "tool",
          id: "c1",
          name: "bash",
          state: {
            status: "completed",
            input: { command: "ls" },
            content: [
              { type: "text", text: "a.txt" },
              { type: "text", text: "b.txt" },
            ],
          },
        },
      ],
    })
    expect(frame).toEqual({
      type: "content",
      messageID: "msg_2",
      parts: [
        { type: "tool", tool: "bash", state: "completed", input: '{"command":"ls"}', output: "a.txt\nb.txt" },
      ],
    })
  })

  test("tool 输出含 file 条目时保留文件引用，不静默丢弃", () => {
    const frame = contentUpdatedFrame({
      messageID: "msg_3",
      content: [
        {
          type: "tool",
          id: "c1",
          name: "read",
          state: {
            status: "completed",
            input: { path: "a.ts" },
            content: [{ type: "text", text: "正文" }, { type: "file", uri: "file:///a.ts", mime: "text/plain", name: "a.ts" }],
          },
        },
      ],
    })
    const part = (frame as { parts: Array<Record<string, unknown>> }).parts[0]!
    expect(part.output).toContain("正文")
    expect(part.output).toContain("a.ts")
  })

  test("库形态的 tool 字段不被 name 覆盖，output 原样保留", () => {
    const frame = contentUpdatedFrame({
      messageID: "msg_4",
      content: [
        {
          type: "tool",
          tool: "read",
          name: "bash",
          callID: "c1",
          state: { status: "completed", input: { path: "a.ts" }, output: "内容" },
        },
      ],
    })
    expect(frame).toEqual({
      type: "content",
      messageID: "msg_4",
      parts: [{ type: "tool", tool: "read", state: "completed", input: '{"path":"a.ts"}', output: "内容" }],
    })
  })

  test("streaming 状态的字符串入参解析成对象，与快照形态一致", () => {
    const frame = contentUpdatedFrame({
      messageID: "msg_5",
      content: [
        { type: "tool", id: "c1", name: "bash", state: { status: "streaming", input: '{"command":"ls"}' } },
      ],
    })
    expect(frame).toEqual({
      type: "content",
      messageID: "msg_5",
      parts: [{ type: "tool", tool: "bash", state: "streaming", input: '{"command":"ls"}' }],
    })
  })

  test("parts 为空不产帧，避免整体替换时抹白已渲染内容", () => {
    expect(contentUpdatedFrame({ messageID: "m", content: [] })).toBeNull()
    expect(contentUpdatedFrame({ messageID: "m", content: [{ type: "step-start" }] })).toBeNull()
  })

  test("messageID 缺失返回 null，不造空 id 的假消息", () => {
    expect(contentUpdatedFrame({ content: [{ type: "text", text: "hi" }] })).toBeNull()
  })

  test("content 中的非对象元素被跳过", () => {
    const frame = contentUpdatedFrame({
      messageID: "m",
      content: [null, "x", 42, { type: "text", text: "ok" }],
    })
    expect(frame).toEqual({ type: "content", messageID: "m", parts: [{ type: "text", text: "ok" }] })
  })
})
