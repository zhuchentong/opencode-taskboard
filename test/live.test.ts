import { describe, expect, test } from "bun:test"
import {
  createDeltaBuffer,
  createLiveHub,
  contentUpdatedFrame,
  type LiveHubDeps,
  type LiveEvent,
  type LiveFrame,
} from "../src/live"

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

// —— createLiveHub ——
// 注：hub 经 AsyncIterable 消费事件，push/fail 触发的处理续体在微任务里跑；
// 因此用例为 async，并在每次 push/fail 后先 await tick() 排空微任务再断言/触发 flush
// （断言取值与事件序列和任务简报逐字一致）。

/** 可控假事件源：手动 emit / fail；hub 的 subscribe() 每次调用登记一个新流 */
function fakeSource() {
  const streams: {
    push: (e: LiveEvent) => void
    fail: (e: unknown) => void
    ended: boolean
  }[] = []
  const logs: string[] = []
  const timers: { fn: () => void; ms: number }[] = []
  let cleared = 0
  const deps: LiveHubDeps = {
    subscribe: () =>
      ({
        [Symbol.asyncIterator]() {
          const pending: ((r: IteratorResult<LiveEvent>) => void)[] = []
          const s = {
            ended: false,
            push: (e: LiveEvent) => {
              for (const r of pending.splice(0)) r({ value: e, done: false })
            },
            fail: (err: unknown) => {
              s.ended = true
              for (const r of pending.splice(0)) r({ value: undefined, done: true })
              void err // 迭代器以结束代替抛错：hub 视为「订阅死亡」路径
            },
          }
          streams.push(s)
          return {
            next: () =>
              new Promise<IteratorResult<LiveEvent>>((resolve) => {
                pending.push(resolve)
              }),
          }
        },
      }) as unknown as AsyncIterable<LiveEvent>,
    log: (m: string) => logs.push(m),
    setInterval: ((fn: () => void, ms: number) => {
      timers.push({ fn, ms })
      return timers.length
    }) as unknown as LiveHubDeps["setInterval"],
    clearInterval: (() => {
      cleared++
    }) as unknown as LiveHubDeps["clearInterval"],
  }
  return {
    deps,
    logs,
    timers,
    last: () => streams[streams.length - 1]!,
    count: () => streams.length,
    cleared: () => cleared, // dispose 应清理定时器：记录 clearInterval 调用次数供断言
  }
}

const DELTA = (sessionID: string, messageID: string, text: string): LiveEvent => ({
  type: "session.text.delta",
  data: { sessionID, assistantMessageID: messageID, ordinal: 0, delta: text },
})

function flushTimers(timers: { fn: () => void; ms: number }[], ms: number): void {
  for (const t of timers) if (t.ms === ms) t.fn()
}

/** 排空微任务队列：让 pump 消费 AsyncIterable 的续体跑完 */
async function tick(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe("createLiveHub", () => {
  test("attach 后同会话 text.delta 合成 text-append 帧到达；两个观看者同会话都收到", async () => {
    const src = fakeSource()
    const hub = createLiveHub(src.deps)
    const got1: LiveFrame[] = []
    const got2: LiveFrame[] = []
    hub.attach("s1", (f) => got1.push(f))
    hub.attach("s1", (f) => got2.push(f))
    src.last().push(DELTA("s1", "m1", "hi"))
    await tick()
    flushTimers(src.timers, 150)
    expect(got1).toEqual([{ type: "text-append", kind: "text", messageID: "m1", text: "hi" }])
    expect(got2).toEqual(got1)
    hub.dispose()
  })

  test("非观看会话的事件被丢弃", async () => {
    const src = fakeSource()
    const hub = createLiveHub(src.deps)
    const got: LiveFrame[] = []
    hub.attach("s1", (f) => got.push(f))
    src.last().push(DELTA("other", "m1", "x"))
    await tick()
    flushTimers(src.timers, 150)
    expect(got).toEqual([])
    hub.dispose()
  })

  test("message.content.updated → content 帧即时到达（不等 flush）", async () => {
    const src = fakeSource()
    const hub = createLiveHub(src.deps)
    const got: LiveFrame[] = []
    hub.attach("s1", (f) => got.push(f))
    src.last().push({
      type: "session.message.content.updated",
      data: { sessionID: "s1", messageID: "m1", content: [{ type: "text", text: "x" }] },
    })
    await tick()
    expect(got).toEqual([{ type: "content", messageID: "m1", parts: [{ type: "text", text: "x" }] }])
    hub.dispose()
  })

  test("execution.succeeded/failed → message-end(null) 广播给该会话观看者", async () => {
    const src = fakeSource()
    const hub = createLiveHub(src.deps)
    const got: LiveFrame[] = []
    hub.attach("s1", (f) => got.push(f))
    src.last().push({ type: "session.execution.succeeded", data: { sessionID: "s1" } })
    await tick()
    expect(got).toEqual([{ type: "message-end", messageID: null }])
    hub.dispose()
  })

  test("回合收尾先冲刷 delta 缓冲：text-append 排在 message-end 之前", async () => {
    const src = fakeSource()
    const hub = createLiveHub(src.deps)
    const got: LiveFrame[] = []
    hub.attach("s1", (f) => got.push(f))
    src.last().push(DELTA("s1", "m1", "hi"))
    await tick()
    expect(got).toEqual([]) // 增量还在缓冲里：未到 150ms tick，不该出帧
    src.last().push({ type: "session.execution.succeeded", data: { sessionID: "s1" } })
    await tick()
    expect(got).toEqual([
      { type: "text-append", kind: "text", messageID: "m1", text: "hi" },
      { type: "message-end", messageID: null },
    ])
    flushTimers(src.timers, 150) // 缓冲已冲空：定时器不得再补发同一段文本
    expect(got).toEqual([
      { type: "text-append", kind: "text", messageID: "m1", text: "hi" },
      { type: "message-end", messageID: null },
    ])
    hub.dispose()
  })

  test("execution.failed 收尾同样先冲刷 delta 缓冲再广播 message-end", async () => {
    const src = fakeSource()
    const hub = createLiveHub(src.deps)
    const got: LiveFrame[] = []
    hub.attach("s1", (f) => got.push(f))
    src.last().push(DELTA("s1", "m1", "半句"))
    await tick()
    src.last().push({ type: "session.execution.failed", data: { sessionID: "s1" } })
    await tick()
    expect(got).toEqual([
      { type: "text-append", kind: "text", messageID: "m1", text: "半句" },
      { type: "message-end", messageID: null },
    ])
    hub.dispose()
  })

  test("detach 全部观看者后 emit 不产生帧；重新 attach 不残留旧缓冲且复用订阅", async () => {
    const src = fakeSource()
    const hub = createLiveHub(src.deps)
    const got: LiveFrame[] = []
    const detach = hub.attach("s1", (f) => got.push(f))
    src.last().push(DELTA("s1", "m1", "old"))
    await tick()
    detach()
    src.last().push(DELTA("s1", "m1", "new"))
    await tick()
    flushTimers(src.timers, 150)
    expect(got).toEqual([])
    hub.attach("s1", (f) => got.push(f))
    src.last().push(DELTA("s1", "m1", "fresh"))
    await tick()
    flushTimers(src.timers, 150)
    expect(got).toEqual([{ type: "text-append", kind: "text", messageID: "m1", text: "fresh" }])
    expect(src.count()).toBe(1) // 订阅未重建（规格 §4.1：观看者归零不关订阅）
    hub.dispose()
  })

  test("订阅流结束 → log 记录；重新 attach 走重订阅且帧可达", async () => {
    const src = fakeSource()
    const hub = createLiveHub(src.deps)
    const got: LiveFrame[] = []
    hub.attach("s1", (f) => got.push(f))
    expect(src.logs.length).toBe(0)
    src.last().fail(new Error("断连"))
    await tick()
    expect(src.logs.length).toBeGreaterThan(0)
    hub.attach("s2", (f) => got.push(f)) // 触发重订阅
    src.last().push(DELTA("s2", "m2", "ok"))
    await tick()
    flushTimers(src.timers, 150)
    expect(got).toEqual([{ type: "text-append", kind: "text", messageID: "m2", text: "ok" }]) // s2 观看者确实收到帧
    expect(src.count()).toBe(2)
    hub.dispose()
  })

  test("dispose 后 emit 不产生帧、定时器已清理", async () => {
    const src = fakeSource()
    const hub = createLiveHub(src.deps)
    const got: LiveFrame[] = []
    hub.attach("s1", (f) => got.push(f))
    hub.dispose()
    expect(src.cleared()).toBe(1) // 定时器确已清理（fake 记录 clearInterval 调用）
    src.last().push(DELTA("s1", "m1", "x"))
    await tick()
    flushTimers(src.timers, 150)
    expect(got).toEqual([])
  })

  test("subscribe 同步抛错 → 不上抛、log 记录且不变僵尸；下次 attach 自愈并收到帧", async () => {
    const src = fakeSource()
    const realSubscribe = src.deps.subscribe
    let calls = 0
    src.deps.subscribe = () => {
      calls++
      if (calls === 1) throw new Error("总线瞬断")
      return realSubscribe()
    }
    const hub = createLiveHub(src.deps)
    const got1: LiveFrame[] = []
    const got2: LiveFrame[] = []
    expect(() => hub.attach("s1", (f) => got1.push(f))).not.toThrow() // 同步抛错不上抛给 attach 调用方
    expect(src.logs.length).toBeGreaterThan(0) // 有日志线索，不是静默失效
    hub.attach("s1", (f) => got2.push(f)) // 未僵尸化：这次 attach 重建订阅
    src.last().push(DELTA("s1", "m1", "ok"))
    await tick()
    flushTimers(src.timers, 150)
    expect(got1).toEqual([{ type: "text-append", kind: "text", messageID: "m1", text: "ok" }])
    expect(got2).toEqual(got1)
    expect(src.count()).toBe(1) // 抛错那次未登记流，成功的这次登记 1 条
    hub.dispose()
  })

  test("next() reject（订阅流真抛错）→ log 记录并标记死亡；下次 attach 重订阅且帧可达", async () => {
    const src = fakeSource()
    const realSubscribe = src.deps.subscribe
    let calls = 0
    src.deps.subscribe = () => {
      calls++
      if (calls === 1) {
        // 首个流 next() 直接 reject：走 pump 的 catch 分支（区别于 fail 的「以结束代替抛错」）
        return {
          [Symbol.asyncIterator]: () => ({
            next: () => Promise.reject(new Error("总线崩溃")),
          }),
        } as unknown as AsyncIterable<LiveEvent>
      }
      return realSubscribe()
    }
    const hub = createLiveHub(src.deps)
    const got: LiveFrame[] = []
    hub.attach("s1", (f) => got.push(f))
    await tick()
    expect(src.logs.length).toBeGreaterThan(0) // catch 分支有日志
    hub.attach("s2", (f) => got.push(f)) // 已标记死亡 → 这次 attach 重订阅
    src.last().push(DELTA("s2", "m2", "ok"))
    await tick()
    flushTimers(src.timers, 150)
    expect(got).toEqual([{ type: "text-append", kind: "text", messageID: "m2", text: "ok" }])
    expect(src.count()).toBe(1) // 重订阅发生在第二个流上
    hub.dispose()
  })

  test("形态不全的 delta 与归一化为 null 的 content 不产帧（hub 层契约）", async () => {
    const src = fakeSource()
    const hub = createLiveHub(src.deps)
    const got: LiveFrame[] = []
    hub.attach("s1", (f) => got.push(f))
    // assistantMessageID 缺失：形态不全，进缓冲前丢弃
    src.last().push({ type: "session.text.delta", data: { sessionID: "s1", ordinal: 0, delta: "x" } })
    // delta 非字符串：同样丢弃
    src.last().push({
      type: "session.text.delta",
      data: { sessionID: "s1", assistantMessageID: "m1", ordinal: 0, delta: 42 },
    })
    // content 归一化后为 null（空 parts）：null 不是帧，hub 不得发出（跨任务契约）
    src.last().push({ type: "session.message.content.updated", data: { sessionID: "s1", messageID: "m1", content: [] } })
    await tick()
    flushTimers(src.timers, 150)
    expect(got).toEqual([])
    hub.dispose()
  })

  test("reasoning delta 映射为 reasoning kind 的 text-append 帧", async () => {
    const src = fakeSource()
    const hub = createLiveHub(src.deps)
    const got: LiveFrame[] = []
    hub.attach("s1", (f) => got.push(f))
    src.last().push({
      type: "session.reasoning.delta",
      data: { sessionID: "s1", assistantMessageID: "m1", ordinal: 0, delta: "思考" },
    })
    await tick()
    flushTimers(src.timers, 150)
    expect(got).toEqual([{ type: "text-append", kind: "reasoning", messageID: "m1", text: "思考" }])
    hub.dispose()
  })
})
