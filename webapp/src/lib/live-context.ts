// 实时上下文流：服务端 SSE 推来的「帧」在前端消息列表上的应用（纯函数 + 订阅状态机）。
//
// 设计要点：
// - 前端与服务端是两棵独立的树，不能 import 服务端 src/；此处的 LiveFrame 是
//   服务端 src/live.ts 的镜像（字段逐字对齐），任一侧改动必须同步。
// - 不可变：始终返回新数组与新消息对象，不改入参——前端用 Svelte 5 的 $state 持有列表，
//   就地改会漏掉响应式更新。
// - 顺序：快照消息是时间倒序（最新在前），实时新建的消息也插到头部，两侧顺序一致。
// - 流式态统一模型：任何实时帧触及某消息即置 streaming=true（渲染层据此用纯文本而非
//   markdown），只有 message-end 才定格。服务端保证 text-append 排在 message-end 之前
//   （见 src/live.ts 收尾时先冲刷 delta 缓冲），帧序倒了消息会卡在流式态。
//
// 本文件后半段是订阅状态机 connectLiveContext（与 events.ts 同款结构）：
// - 终态信号是「连接关闭」而不是 message-end：message-end 只表示一个回合结束
//   （消息定格），连接保持打开接下一回合；连接出错/关闭才是实时流终止 → 退避重连。
//   把 message-end 当终态会让 worker 的第二回合收不到帧。
// - 连续 3 次失败降级 off（终态，不再重连），只保留快照与手动刷新。
import type { ContextMessage } from "./context"

/** 看板消费的实时帧：文本增量 / 整段内容 / 消息结束（与服务端 src/live.ts 逐字对齐） */
export type LiveFrame =
  | { type: "text-append"; kind: "text" | "reasoning"; messageID: string; text: string }
  | { type: "content"; messageID: string; parts: ContextMessage["parts"] }
  | { type: "message-end"; messageID: string | null }

/**
 * 不可变应用一帧：返回新数组；新消息 unshift 头部（快照时间倒序），既有消息按 id 原位替换。
 * @param now 新建消息的时间戳来源（默认本地时钟；注入后函数对同一入参结果确定）
 */
export function applyFrame(messages: ContextMessage[], frame: LiveFrame, now: number = Date.now()): ContextMessage[] {
  switch (frame.type) {
    case "text-append":
      return applyTextAppend(messages, frame, now)
    case "content":
      return applyContent(messages, frame, now)
    case "message-end":
      return applyMessageEnd(messages, frame.messageID)
    default:
      // 帧来自 JSON 解析：镜像类型一旦与服务端脱节（服务端加了新帧型），此处不产变化，
      // 免得下游拿到非数组把 $state 弄崩
      return messages
  }
}

/** 文本增量：追加到消息最后一个同 kind 的 part；无则新建占位 part 放到末尾 */
function applyTextAppend(
  messages: ContextMessage[],
  frame: Extract<LiveFrame, { type: "text-append" }>,
  now: number,
): ContextMessage[] {
  const idx = messages.findIndex((m) => m.id === frame.messageID)
  if (idx === -1) {
    // 消息还没进过列表（首帧即增量）：新建 assistant 消息插到头部
    return [
      {
        id: frame.messageID,
        role: "assistant",
        time: now,
        parts: [{ type: frame.kind, text: frame.text }],
        streaming: true,
      },
      ...messages,
    ]
  }
  const msg = messages[idx]
  const parts = [...msg.parts]
  let target = -1
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].type === frame.kind) {
      target = i
      break
    }
  }
  if (target === -1) parts.push({ type: frame.kind, text: frame.text })
  else parts[target] = { ...parts[target], text: (parts[target].text ?? "") + frame.text }
  const next = [...messages]
  // 收到增量即说明该消息正在流式输出：打标记，渲染层据此走纯文本而非 markdown
  next[idx] = { ...msg, parts, streaming: true }
  return next
}

/** 整段内容：服务端给的 parts 是该消息的权威快照，整体替换而非合并 */
function applyContent(
  messages: ContextMessage[],
  frame: Extract<LiveFrame, { type: "content" }>,
  now: number,
): ContextMessage[] {
  const idx = messages.findIndex((m) => m.id === frame.messageID)
  if (idx === -1) {
    // 只有实时帧见过的新消息：必然是在途输出，先按流式态渲染，等 message-end 再切 markdown
    return [
      {
        id: frame.messageID,
        role: "assistant",
        time: now,
        parts: [...frame.parts],
        streaming: true,
      },
      ...messages,
    ]
  }
  const next = [...messages]
  // 实时帧触及即在途输出：与 text-append 同一模型，统一置流式态，等 message-end 才定格
  next[idx] = { ...next[idx], parts: [...frame.parts], streaming: true }
  return next
}

/** 消息结束：messageID 为 null 表示回合收尾（所有消息定格），否则只定格该消息 */
function applyMessageEnd(messages: ContextMessage[], messageID: string | null): ContextMessage[] {
  if (messageID === null) {
    return messages.map((m) => (m.streaming === false ? m : { ...m, streaming: false }))
  }
  const idx = messages.findIndex((m) => m.id === messageID)
  if (idx === -1) return [...messages]
  const next = [...messages]
  next[idx] = { ...next[idx], streaming: false }
  return next
}

// —— 订阅状态机（connectLiveContext）——

/** 实时订阅的连接态：live=实时中；reconnecting=断线退避重连中；off=连续三败降级（终态） */
export type LiveStatus = "live" | "reconnecting" | "off"

/** 订阅依赖：EventSource 与定时器可注入，测试用假件确定性驱动 */
export interface LiveConnectDeps {
  EventSource: new (url: string) => {
    onopen: (() => void) | null
    onerror: (() => void) | null
    onmessage: ((e: { data: string }) => void) | null
    close(): void
  }
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

// 宿主方法（setTimeout 等）要求 this 为 globalThis：作为 deps 对象的属性被调用时
// 接收者变成 deps，会抛 Illegal invocation——必须显式绑定
const realLiveDeps: LiveConnectDeps = {
  EventSource: globalThis.EventSource as never,
  setTimeout: setTimeout.bind(globalThis),
  clearTimeout: clearTimeout.bind(globalThis),
}

/** 退避档位（毫秒）：1s → 2s → 4s → 8s */
const BACKOFF_MS = [1000, 2000, 4000, 8000]
/** 退避封顶：再往后一律 10s */
const MAX_BACKOFF_MS = 10000
/** 连续失败达此数即降级 off（终态，不再重连） */
const FAILURE_THRESHOLD = 3

/**
 * 第 failures 次失败后的重连等待时长（failures 从 1 起）：1s → 2s → 4s → 8s，再往后封顶 10s。
 * 单独导出便于钉住退避档位；状态机里当前阈值 3 只会用到前两档，后几档是防御性分支
 * （真要放宽失败阈值时档位表直接可用，不必改实现）。
 */
export function liveBackoffDelay(failures: number): number {
  if (failures <= 1) return BACKOFF_MS[0]!
  if (failures > BACKOFF_MS.length) return MAX_BACKOFF_MS
  return Math.min(BACKOFF_MS[failures - 1]!, MAX_BACKOFF_MS)
}

/**
 * 订阅任务实时上下文流（SSE），把帧经 applyFrame 应用到消息列表。
 *
 * 状态机：
 * - onopen → onStatus("live")，失败计数清零（重连成功即恢复）。
 * - onerror → 关闭本连接（EventSource 自带重连，会与手动退避打架），按 1s/2s 退避重建；
 *   连续 3 次失败 → onStatus("off") 终态：不再重连，只剩快照与手动刷新。
 * - onmessage → JSON.parse 后 applyFrame，每帧回调 onMessages（内部自持消息数组，初始 []）。
 * - message-end 不是终态：它只定格消息，连接保持打开接下一回合。
 *
 * @param taskID 任务 ID（进 URL 前做 encodeURIComponent）
 * @param handlers 帧应用结果与连接态回调
 * @param deps 可注入的依赖（与内置默认合并，测试只覆盖需要替换的部分）
 * @returns cleanup：关闭连接并清空全部定时器
 */
export function connectLiveContext(
  taskID: string,
  handlers: {
    onMessages(messages: ContextMessage[]): void
    onStatus(s: LiveStatus): void
  },
  deps?: Partial<LiveConnectDeps>,
): () => void {
  const d: LiveConnectDeps = { ...realLiveDeps, ...deps }
  const url = `/api/tasks/${encodeURIComponent(taskID)}/context/live`

  let messages: ContextMessage[] = []
  let failures = 0
  let es: InstanceType<LiveConnectDeps["EventSource"]> | null = null
  let retryTimer: unknown = null
  let stopped = false
  /** 已降级 off（终态）：此后一切回调都不再改变状态机 */
  let dead = false

  const clearRetry = () => {
    if (retryTimer === null) return
    d.clearTimeout(retryTimer)
    retryTimer = null
  }

  const scheduleReconnect = () => {
    clearRetry()
    retryTimer = d.setTimeout(() => {
      retryTimer = null
      if (stopped || dead) return
      open()
    }, liveBackoffDelay(failures))
  }

  const open = () => {
    if (stopped || dead) return
    const s = new d.EventSource(url)
    es = s

    s.onopen = () => {
      // 过期连接（已被重建取代）或已降级终态的回调不参与状态机
      if (stopped || dead || es !== s) return
      failures = 0
      clearRetry()
      handlers.onStatus("live")
    }

    s.onerror = () => {
      if (stopped || dead || es !== s) return
      failures++
      // EventSource 自带重连：手动退避前先关掉，否则两个重连源打架
      s.close()
      if (failures >= FAILURE_THRESHOLD) {
        // 连续三败 → 降级 off（终态）：不再重连，也不再上报 reconnecting
        dead = true
        clearRetry()
        handlers.onStatus("off")
        return
      }
      handlers.onStatus("reconnecting")
      scheduleReconnect()
    }

    s.onmessage = (e) => {
      if (stopped || dead || es !== s) return
      let frame: LiveFrame
      try {
        frame = JSON.parse(e.data) as LiveFrame
      } catch {
        // 非 JSON 帧（心跳注释不会进 onmessage）忽略：不得让一条坏帧打断整条流
        return
      }
      messages = applyFrame(messages, frame)
      handlers.onMessages(messages)
    }
  }

  open()

  return () => {
    stopped = true
    clearRetry()
    es?.close()
  }
}
