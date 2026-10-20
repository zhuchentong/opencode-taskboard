// dev 假事件源（src/dev-live.ts）的帧协议测试：
// 帧字段必须与服务端协议（src/live.ts 的 LiveFrame）逐字一致——
// 漂移的后果是 dev 模式前端「看起来像装配失败」（帧对不上，什么也渲染不出来）。
import { expect, test } from "bun:test"
import { createFakeLive, FAKE_LIVE_CHUNKS, type FakeLiveClock } from "../src/dev-live"
import type { LiveFrame } from "../src/live"

/** 可控的假定时器：注册表手动触发（cleared=被 clearTimeout 清掉，fired=已触发） */
function fakeClock() {
  const regs: { fn: () => void; ms: number; cleared: boolean; fired: boolean }[] = []
  const pending = () => regs.filter((r) => !r.cleared && !r.fired)
  /** 反复触发待触发的定时器（每次触发可能排新的），直到 stop 命中或没有待触发的 */
  const drive = (stop?: () => boolean, maxSteps = 50) => {
    for (let i = 0; i < maxSteps; i++) {
      if (stop?.()) return
      const p = pending()
      if (!p.length) return
      p[0]!.fired = true
      p[0]!.fn()
    }
  }
  const clock: FakeLiveClock = {
    setTimeout: (fn: () => void, ms: number) => {
      const r = { fn, ms, cleared: false, fired: false }
      regs.push(r)
      return r
    },
    clearTimeout: (h: unknown) => {
      ;(h as { cleared: boolean }).cleared = true
    },
  }
  return { regs, pending, drive, clock, get scheduled() { return regs.length } }
}

/** 快节奏：各步间隔压到 1ms，测试不靠真实时钟 */
const FAST = { startMs: 1, chunkMs: 1, toolMs: 1, endMs: 1, roundMs: 10_000 }

test("dev 假事件源：一轮的帧序是 文本增量 → 工具 running → 工具 completed → 回合收尾", () => {
  const clock = fakeClock()
  const frames: LiveFrame[] = []
  const detach = createFakeLive((f) => frames.push(f), FAST, clock.clock)
  clock.drive(() => frames.some((f) => f.type === "message-end")) // 只跑完第一轮
  detach()
  expect(frames.map((f) => f.type)).toEqual([
    "text-append",
    "text-append",
    "text-append",
    "content",
    "content",
    "message-end",
  ])
  // 文本增量：同一条消息、逐块吐字
  const appends = frames.filter((f) => f.type === "text-append")
  expect(new Set(appends.map((f) => (f as { messageID: string }).messageID)).size).toBe(1)
  expect(appends.map((f) => (f as { text: string }).text)).toEqual(FAKE_LIVE_CHUNKS)
  // 回合收尾：messageID 为 null（全部消息定格）
  const end = frames.at(-1)!
  expect(end).toEqual({ type: "message-end", messageID: null })
})

test("dev 假事件源：content 帧带全部 parts（文本 + 工具条），翻成 completed 时补上 output", () => {
  const clock = fakeClock()
  const frames: LiveFrame[] = []
  const detach = createFakeLive((f) => frames.push(f), FAST, clock.clock)
  clock.drive(() => frames.some((f) => f.type === "message-end")) // 只跑完第一轮
  detach()
  const contents = frames.filter((f) => f.type === "content")
  expect(contents).toHaveLength(2)
  const [running, completed] = contents as Extract<LiveFrame, { type: "content" }>[]
  // content 帧是整条消息 parts 的权威快照：必须带上已累计的文本，否则正文会被抹掉
  expect(running.parts[0]).toEqual({ type: "text", text: FAKE_LIVE_CHUNKS.join("") })
  expect(running.parts[1]).toEqual({
    type: "tool",
    tool: "bash",
    state: "running",
    input: JSON.stringify({ command: "bun test webapp/test/lane.test.ts" }),
  })
  expect(completed.parts[1]).toMatchObject({ type: "tool", tool: "bash", state: "completed" })
  expect((completed.parts[1] as { output?: string }).output).toBeTruthy()
})

test("dev 假事件源：detach 清掉待触发的定时器，之后既不再发帧也不再调度新定时器", () => {
  const clock = fakeClock()
  const frames: LiveFrame[] = []
  const detach = createFakeLive((f) => frames.push(f), FAST, clock.clock)
  clock.drive(() => frames.some((f) => f.type === "message-end")) // 只跑完第一轮
  const before = frames.length
  expect(before).toBeGreaterThan(0)
  expect(clock.pending()).toHaveLength(1) // 下一轮的定时器待触发
  detach()
  expect(clock.pending()).toHaveLength(0) // 待触发的定时器被清掉（不留悬挂定时器）
  const scheduledAfterDetach = clock.scheduled
  clock.drive()
  expect(clock.scheduled).toBe(scheduledAfterDetach) // detach 后不再调度新的定时器
  expect(frames).toHaveLength(before) // 也一帧都不再发
})
