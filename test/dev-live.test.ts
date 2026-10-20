// dev 假事件源（src/dev-live.ts）的帧协议测试：
// 帧字段必须与服务端协议（src/live.ts 的 LiveFrame）逐字一致——
// 漂移的后果是 dev 模式前端「看起来像装配失败」（帧对不上，什么也渲染不出来）。
import { expect, test } from "bun:test"
import { createFakeLive, FAKE_LIVE_CHUNKS } from "../src/dev-live"
import type { LiveFrame } from "../src/live"

/** 等一小会儿（毫秒） */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 快节奏：各步间隔压到 1ms，测试不靠真实时钟 */
const FAST = { startMs: 1, chunkMs: 1, toolMs: 1, endMs: 1, roundMs: 10_000 }

test("dev 假事件源：一轮的帧序是 文本增量 → 工具 running → 工具 completed → 回合收尾", async () => {
  const frames: LiveFrame[] = []
  const detach = createFakeLive((f) => frames.push(f), FAST)
  await sleep(80)
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

test("dev 假事件源：content 帧带全部 parts（文本 + 工具条），翻成 completed 时补上 output", async () => {
  const frames: LiveFrame[] = []
  const detach = createFakeLive((f) => frames.push(f), FAST)
  await sleep(80)
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

test("dev 假事件源：detach 后不再发帧、不留悬挂定时器", async () => {
  const frames: LiveFrame[] = []
  const detach = createFakeLive((f) => frames.push(f), FAST)
  await sleep(80)
  const before = frames.length
  expect(before).toBeGreaterThan(0)
  detach()
  await sleep(80)
  expect(frames).toHaveLength(before) // detach 后一帧都不再发
})
