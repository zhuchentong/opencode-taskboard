import { describe, expect, test } from "bun:test"
import { applyFrame, connectLiveContext, liveBackoffDelay, type LiveFrame } from "../src/lib/live-context"
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

// —— connectLiveContext 订阅状态机 ——

// 可控的假 EventSource（与 events.test.ts 同款假件模式）
class FakeES {
  static instances: FakeES[] = []
  url: string
  closed = false
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null

  constructor(url: string) {
    this.url = url
    FakeES.instances.push(this)
  }
  open() {
    this.onopen?.()
  }
  fail() {
    this.onerror?.()
  }
  /** 原始数据（可传非法 JSON） */
  send(data: string) {
    this.onmessage?.({ data })
  }
  /** 合法帧（自动 JSON 序列化） */
  frame(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) })
  }
  close() {
    this.closed = true
  }
}

// 可控的假定时器：注册表手动触发（fired 与 cleared 分开记：fired=已触发，cleared=被 clearTimeout 清掉）
function fakeTimers() {
  const regs: { fn: () => void; ms: number; cleared: boolean; fired: boolean }[] = []
  return {
    regs,
    set: (fn: () => void, ms: number) => {
      const r = { fn, ms, cleared: false, fired: false }
      regs.push(r)
      return r
    },
    clear: (r: unknown) => {
      ;(r as { cleared: boolean }).cleared = true
    },
    /** 触发指定延时的全部未清未触发定时器 */
    fire(ms: number) {
      for (const r of regs) {
        if (r.cleared || r.fired || r.ms !== ms) continue
        r.fired = true
        r.fn()
      }
    },
    /** 当前待触发的定时器（已触发/已清除的不算） */
    pending() {
      return regs.filter((r) => !r.cleared && !r.fired)
    },
  }
}

function liveHandlers() {
  const messages: ContextMessage[][] = []
  const states: string[] = []
  return {
    messages,
    states,
    handlers: {
      onMessages: (ms: ContextMessage[]) => messages.push(ms),
      onStatus: (s: string) => states.push(s),
    },
  }
}

/** 起一条订阅（假件注入），返回控制器与清理函数 */
function start(taskID = "t1") {
  FakeES.instances = []
  const { handlers, messages, states } = liveHandlers()
  const timers = fakeTimers()
  const dispose = connectLiveContext(taskID, handlers, {
    EventSource: FakeES as never,
    setTimeout: timers.set,
    clearTimeout: timers.clear,
  })
  return { handlers, messages, states, timers, dispose, es: () => FakeES.instances[FakeES.instances.length - 1]! }
}

describe("connectLiveContext", () => {
  test("onopen → onStatus('live')；onmessage 解析帧并经 applyFrame 回调 onMessages", () => {
    const { messages, states, es } = start()
    expect(es().url).toBe("/api/tasks/t1/context/live")
    es().open()
    expect(states).toEqual(["live"])
    es().frame({ type: "text-append", kind: "text", messageID: "m1", text: "你" })
    es().frame({ type: "text-append", kind: "text", messageID: "m1", text: "好" })
    // 每帧回调一次；内部自持消息数组（初始 []）逐帧累积
    expect(messages).toHaveLength(2)
    expect(messages[0]![0]!.parts).toEqual([{ type: "text", text: "你" }])
    expect(messages[1]![0]!.parts).toEqual([{ type: "text", text: "你好" }])
    expect(messages[1]![0]!.streaming).toBe(true)
  })

  test("任务 ID 进 URL 前做 encodeURIComponent", () => {
    const { es } = start("a/b c")
    expect(es().url).toBe("/api/tasks/a%2Fb%20c/context/live")
  })

  test("error → onStatus('reconnecting')，按 1s/2s 退避重建 EventSource（档位表 1s/2s/4s 封顶 10s）", () => {
    const { states, timers, es } = start()
    const es1 = es()
    es1.fail()
    expect(states).toEqual(["reconnecting"])
    expect(es1.closed).toBe(true) // 手动退避前先关掉 EventSource 自带的重连
    expect(timers.pending()).toHaveLength(1)
    expect(timers.pending()[0]!.ms).toBe(1000)
    timers.fire(1000)
    expect(FakeES.instances).toHaveLength(2)
    const es2 = es()
    es2.fail()
    expect(states.at(-1)).toBe("reconnecting")
    expect(timers.pending()).toHaveLength(1)
    expect(timers.pending()[0]!.ms).toBe(2000)
    timers.fire(2000)
    expect(FakeES.instances).toHaveLength(3)
    // 退避档位表本身：1s/2s/4s/8s 封顶 10s
    expect([1, 2, 3, 4, 5, 9].map(liveBackoffDelay)).toEqual([1000, 2000, 4000, 8000, 10000, 10000])
  })

  test("连续 3 次 error → onStatus('off')，EventSource 关闭，不再重连", () => {
    const { states, timers, es } = start()
    const es1 = es()
    es1.fail()
    timers.fire(1000)
    const es2 = es()
    es2.fail()
    timers.fire(2000)
    const es3 = es()
    es3.fail()
    expect(states.at(-1)).toBe("off")
    expect(es3.closed).toBe(true)
    expect(timers.pending()).toHaveLength(0) // 降级即终态：不再排退避
    timers.fire(4000)
    timers.fire(8000)
    expect(FakeES.instances).toHaveLength(3) // 不再重连
  })

  test("收到 message-end 不关流、不重连、消息定格（终态信号是连接关闭，不是 message-end）", () => {
    const { messages, states, timers, es } = start()
    es().open()
    es().frame({ type: "text-append", kind: "text", messageID: "m1", text: "回合一" })
    es().frame({ type: "message-end", messageID: "m1" })
    expect(es().closed).toBe(false) // 不关流
    expect(timers.pending()).toHaveLength(0) // 不排重连
    expect(states.at(-1)).toBe("live") // 状态不变
    const last = messages.at(-1)!
    expect(last[0]!.streaming).toBe(false) // 消息定格
    expect(last[0]!.parts).toEqual([{ type: "text", text: "回合一" }])
  })

  test("cleanup 关掉 EventSource 并清空全部定时器（含未到点的退避定时器），之后不再重连", () => {
    const { timers, dispose, es } = start()
    const es1 = es()
    es1.fail() // 排一个未到点的退避定时器
    expect(timers.pending()).toHaveLength(1)
    dispose()
    expect(es1.closed).toBe(true)
    expect(timers.regs.every((r) => r.cleared)).toBe(true)
    timers.fire(1000)
    expect(FakeES.instances).toHaveLength(1) // cleanup 后不再重连
  })

  test("onmessage 的数据不是合法 JSON → 吞掉，不抛、不改消息数组", () => {
    const { messages, states, es } = start()
    es().open()
    es().frame({ type: "text-append", kind: "text", messageID: "m1", text: "甲" })
    const before = messages.length
    expect(() => es().send("{ 不是 JSON")).not.toThrow()
    expect(messages).toHaveLength(before) // 消息数组未被改动
    expect(states.at(-1)).toBe("live") // 坏帧不打断整条流
  })

  test("重连成功后失败计数归零：再错一次不降级（reconnecting 而非 off）", () => {
    const { states, timers, es } = start()
    es().fail()
    timers.fire(1000)
    es().fail()
    timers.fire(2000)
    es().open() // 重连成功 → 失败计数清零
    expect(states.at(-1)).toBe("live")
    es().fail()
    expect(states.at(-1)).toBe("reconnecting")
    expect(states).not.toContain("off")
  })

  test("过期连接（已被重建取代）的回调不参与状态机", () => {
    const { states, timers, es } = start()
    const es1 = es()
    es1.fail()
    timers.fire(1000)
    const es2 = es()
    es2.open()
    expect(states.at(-1)).toBe("live")
    es1.fail() // 过期连接再报错：不得把失败计数带上去
    expect(states).toEqual(["reconnecting", "live"])
    expect(timers.pending()).toHaveLength(0)
  })

  test("off 是终态：降级后连接再 error/open 都不再改变状态", () => {
    const { states, timers, es } = start()
    es().fail()
    timers.fire(1000)
    es().fail()
    timers.fire(2000)
    const es3 = es()
    es3.fail()
    expect(states.at(-1)).toBe("off")
    const snapshot = [...states]
    es3.fail()
    es3.open()
    expect(states).toEqual(snapshot) // 终态后不再重复上报
    expect(FakeES.instances).toHaveLength(3)
  })
})
