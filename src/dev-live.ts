// dev 假事件源：模拟 worker 的一轮实时输出，供前端在没有 OpenCode 的情况下调试实时流。
//
// 为什么单独成文件：dev.ts 有顶层副作用（起服务、占端口），没法被测试 import；
// 而这里的帧字段必须与服务端协议（src/live.ts 的 LiveFrame）逐字一致——
// 一旦漂移，dev 模式的前端会「看起来像装配失败」（帧对不上，什么也渲染不出来），
// 所以把它做成可测的纯装配件（时间参数可注入 → 测试不靠真实时钟）。
//
// 一轮的帧序：
// 1. 若干 text-append 帧（新建一条消息，逐块吐字 → 前端打字机效果）；
// 2. content 帧带一个 running 态工具条，再一帧把它翻成 completed + output（演示工具状态实时翻转）；
// 3. message-end(null) 收尾（消息定格、回落到 markdown 渲染）。
// 一轮结束后停一会儿再开下一轮，方便反复观察效果。
import type { LiveFrame } from "./live"

/** 各步的间隔（毫秒）；测试可注入更小的值，不必等真实时钟 */
export interface FakeLiveTimings {
  /** 首轮开始的延迟 */
  startMs?: number
  /** 文本块之间的间隔（打字机节奏） */
  chunkMs?: number
  /** 工具条 running → completed 的间隔 */
  toolMs?: number
  /** 工具条 completed → 回合收尾的间隔 */
  endMs?: number
  /** 两轮之间的间隔 */
  roundMs?: number
}

/**
 * 定时器依赖（测试可注入假件：确定性驱动，还能直接断言「detach 后不再调度」）。
 * 宿主方法要求 this 为 globalThis：作为对象属性被调用时接收者会变，必须显式绑定。
 */
export interface FakeLiveClock {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const realClock: FakeLiveClock = {
  setTimeout: setTimeout.bind(globalThis),
  clearTimeout: clearTimeout.bind(globalThis),
}

/** 默认节奏：慢到能看清打字机，快到不用干等 */
const DEFAULT_TIMINGS: Required<FakeLiveTimings> = {
  startMs: 300,
  chunkMs: 700,
  toolMs: 1200,
  endMs: 800,
  roundMs: 3000,
}

/** 一轮吐出的文本块（打字机内容） */
export const FAKE_LIVE_CHUNKS = ["正在定位拖拽失效的根因……", "先看 lane.ts 的命中区计算。", "方案：pointermove 里实时重算。"]

/** 工具条演示用的命令（入参/输出形态与真实 bash 工具一致） */
const FAKE_TOOL_INPUT = JSON.stringify({ command: "bun test webapp/test/lane.test.ts" })
const FAKE_TOOL_OUTPUT = "42 pass\nRan 42 tests"

/**
 * 造一个 dev 假事件源：把模拟的帧喂给 send。
 * @param send 帧接收方（生产里是 server.ts 的 SSE 转发）
 * @param timings 各步间隔（默认慢节奏；测试注入小值）
 * @param clock 定时器依赖（默认全局定时器；测试注入假件）
 * @returns detach：停掉待触发的定时器，不再发帧（不留悬挂定时器）
 */
export function createFakeLive(
  send: (frame: LiveFrame) => void,
  timings?: FakeLiveTimings,
  clock: FakeLiveClock = realClock,
): () => void {
  const t = { ...DEFAULT_TIMINGS, ...timings }
  let timer: unknown = null
  let stopped = false
  let round = 0

  /** 排一个延时动作；已 detach 则不再执行 */
  const later = (fn: () => void, ms: number): void => {
    timer = clock.setTimeout(() => {
      timer = null
      if (stopped) return
      fn()
    }, ms)
  }

  const runRound = (): void => {
    const messageID = `msg_dev_live_${++round}`
    let text = ""
    let i = 0
    const step = (): void => {
      if (i < FAKE_LIVE_CHUNKS.length) {
        const chunk = FAKE_LIVE_CHUNKS[i]!
        i++
        text += chunk
        send({ type: "text-append", kind: "text", messageID, text: chunk })
        later(step, t.chunkMs)
        return
      }
      // 工具条：先 running，再翻成 completed（演示工具状态实时翻转）。
      // content 帧是「整条消息 parts 的权威快照」，必须带上已累计的 text part，
      // 否则会把刚吐出来的正文抹掉（前端按 id 整体替换该消息的 parts）。
      send({
        type: "content",
        messageID,
        parts: [
          { type: "text", text },
          { type: "tool", tool: "bash", state: "running", input: FAKE_TOOL_INPUT },
        ],
      })
      later(() => {
        send({
          type: "content",
          messageID,
          parts: [
            { type: "text", text },
            { type: "tool", tool: "bash", state: "completed", input: FAKE_TOOL_INPUT, output: FAKE_TOOL_OUTPUT },
          ],
        })
        later(() => {
          send({ type: "message-end", messageID: null }) // 回合收尾：消息定格
          later(runRound, t.roundMs) // 停一会儿再开下一轮
        }, t.endMs)
      }, t.toolMs)
    }
    step()
  }

  later(runRound, t.startMs)

  return () => {
    stopped = true
    if (timer !== null) {
      clock.clearTimeout(timer)
      timer = null
    }
  }
}
