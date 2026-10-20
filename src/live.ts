// 实时上下文流：帧的数据层 + 观看枢纽层。
// 数据层把 opencode 事件总线上的流式增量与内容更新，归一化成看板前端消费的「帧」（LiveFrame），
// 纯函数、无状态；枢纽层 createLiveHub 维护观看者注册表、懒订阅事件总线并分发帧，
// 状态全部封在 hub 实例内，IO（订阅/日志/定时器）经 LiveHubDeps 注入。
//
// 设计要点：
// - delta 合帧：模型流式输出是逐 token 的小片段，直接广播会让前端渲染抖动。
//   这里按 (kind, messageID) 分桶拼串，flush 一次性产出整段文本帧。
// - 帧序：回合收尾（execution.succeeded/failed）时先冲刷该会话的 delta 缓冲再广播
//   message-end，保证 text-append 排在结束帧之前——前端按帧序定格，顺序倒了消息会卡在流式态。
// - 回合结束态：结束帧之后到达的迟到帧（delta/content）照常广播，紧跟一条 message-end 重新定格，
//   守住不变量「一个回合的最后一帧永远是 message-end」——既不丢内容，也不会卡在流式态。
// - content 与 delta 的交叉：content 帧是该消息 parts 的权威快照（已含此前的增量），
//   生成 content 帧时作废同消息的待冲 delta 桶——否则前端把同一段文本追加两次（正文翻倍）。
// - 订阅死亡收尾：订阅流中途结束/异常时（live-only 契约，规格 §6），先把缓冲里的增量冲出去，
//   再给所有活跃观看者发 message-end，最后对每个观看者关流——连接关闭是前端唯一的终态信号，
//   不关流则 SSE 不报错、前端静默冻在「实时」状态，只能手动刷新。
// - content 归一化：事件的 part 与库里的 part 形态有差异（工具名、工具输出、入参），
//   先在 toRawPart 适配层补齐，再复用 context.ts 的 normalizePart，
//   保证 live 帧的 part 形态与快照 parts 完全一致。
import { normalizePart, type ContextPart } from "./context"

/** 看板消费的实时帧：文本增量 / 整段内容 / 消息结束 */
export type LiveFrame =
  | { type: "text-append"; kind: "text" | "reasoning"; messageID: string; text: string }
  | { type: "content"; messageID: string; parts: ContextPart[] }
  | { type: "message-end"; messageID: string | null }

/** 总线事件的最小形态（V2Event 结构兼容子集，测试可造） */
export interface LiveEvent {
  type: string
  data: Record<string, unknown>
}

/** 分桶键：kind 与 messageID 组合，\u0000 分隔避免拼接歧义 */
const bucketKey = (kind: string, messageID: string): string => `${kind}\u0000${messageID}`

/**
 * delta 合帧缓冲：按 (kind, messageID) 拼串，flush 产出文本帧并清空。
 * Map 保序，flush 顺序即首次出现顺序。
 */
export function createDeltaBuffer(): {
  push(kind: "text" | "reasoning", messageID: string, text: string): void
  flush(): LiveFrame[]
  clear(): void
  /** 丢弃某消息的全部待冲桶（text 与 reasoning 两种 kind 都丢） */
  discardMessage(messageID: string): void
} {
  const buckets = new Map<string, { kind: "text" | "reasoning"; messageID: string; text: string }>()

  return {
    push(kind, messageID, text) {
      if (!text) return // 空增量不占桶
      const key = bucketKey(kind, messageID)
      const hit = buckets.get(key)
      if (hit) hit.text += text
      else buckets.set(key, { kind, messageID, text })
    },
    flush() {
      const frames: LiveFrame[] = [...buckets.values()].map((b) => ({
        type: "text-append",
        kind: b.kind,
        messageID: b.messageID,
        text: b.text,
      }))
      buckets.clear()
      return frames
    },
    clear() {
      buckets.clear()
    },
    discardMessage(messageID) {
      // 桶按 (kind, messageID) 建，同一消息可能有 text 与 reasoning 两个桶：两种 kind 一起丢
      for (const [key, b] of buckets) {
        if (b.messageID === messageID) buckets.delete(key)
      }
    },
  }
}

/**
 * session.message.content.updated 的 data → content 帧；
 * content 缺失/非数组、messageID 缺失、归一化后 parts 为空时返回 null（不产帧）。
 */
export function contentUpdatedFrame(data: Record<string, unknown>): LiveFrame | null {
  const content = data.content
  if (!Array.isArray(content)) return null
  const messageID = data.messageID
  if (typeof messageID !== "string" || !messageID) return null // 缺 id 不造假消息
  const parts: ContextPart[] = []
  for (const item of content) {
    if (!item || typeof item !== "object") continue
    const part = normalizePart(toRawPart(item as Record<string, unknown>))
    if (part) parts.push(part)
  }
  if (parts.length === 0) return null // 空 parts 会让前端整体替换时抹白已渲染内容
  return { type: "content", messageID, parts }
}

/**
 * 形态适配层：事件的 part 与库里的 part 原始 JSON 结构不同（opencode 2.0.30 实测）——
 * - 工具名：事件用 name，库里用 tool；
 * - 工具输出：事件是 state.content 数组（text/file 条目），库里是 state.output 字符串；
 * - 工具入参：streaming 状态下事件给的是字符串，库里是对象。
 * 这里把事件形态补成库里形态，交给同一个 normalizePart，
 * 保证 live 帧的 part 形态与快照 parts 完全一致（规格 §5）。
 */
function toRawPart(raw: Record<string, unknown>): Record<string, unknown> {
  if (raw.type !== "tool") return raw
  const state = (raw.state ?? {}) as Record<string, unknown>
  const nextState: Record<string, unknown> = { ...state }

  // 入参：streaming 状态下是字符串，解析成对象与快照侧同形（半截 JSON 保持原样）
  if (typeof state.input === "string") {
    const parsed = parseJsonObject(state.input)
    if (parsed) nextState.input = parsed
  }
  // 输出：事件的 state.content 数组 → 库里的 state.output 字符串
  if (nextState.output === undefined) {
    const output = joinToolContent(state.content)
    if (output !== undefined) nextState.output = output
  }

  const out: Record<string, unknown> = { ...raw, state: nextState }
  if (typeof out.tool !== "string" && typeof raw.name === "string") out.tool = raw.name
  return out
}

/** 工具输出：state.content 的 text 条目按序取正文，file 条目留一行文件引用 */
function joinToolContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  const chunks: string[] = []
  for (const item of content) {
    if (!item || typeof item !== "object") continue
    const rec = item as Record<string, unknown>
    if (rec.type === "text" && typeof rec.text === "string") chunks.push(rec.text)
    else if (rec.type === "file") chunks.push(`[文件: ${fileLabel(rec)}]`)
  }
  if (!chunks.length) return undefined
  return chunks.join("\n")
}

/** 文件条目的可读标识：优先文件名，其次 uri */
function fileLabel(rec: Record<string, unknown>): string {
  if (typeof rec.name === "string" && rec.name) return rec.name
  if (typeof rec.uri === "string" && rec.uri) return rec.uri
  return "?"
}

/** 尝试把字符串解析成普通对象（非对象/解析失败一律返回 undefined） */
function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch {
    // 半截 JSON（流式中途）：保持原字符串
  }
  return undefined
}

// —— 实时枢纽：观看者注册表 + 懒订阅事件循环 ——

/**
 * 观看者：帧接收方 + 关流回调。
 * close 是必需的契约：前端唯一的实时流终态信号是「连接关闭」——
 * 订阅死亡或建立失败时若不关流，浏览器侧会一直停在「实时」状态条上。
 */
interface LiveWatcher {
  send(frame: LiveFrame): void
  close(): void
}

/** hub 的外部依赖全注入：事件总线订阅、日志、定时器——测试用假源/假时钟，生产接 ctx.event 与全局定时器 */
export interface LiveHubDeps {
  subscribe(): AsyncIterable<LiveEvent>
  log(m: string): void
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

/**
 * 实时上下文流枢纽（规格 §4.1）：
 * - 注册表 Map<sessionID, Set<LiveWatcher>>，sessionID 即注册表键（一任务一会话，观看会话唯一）。
 * - 懒订阅：首个观看者 attach 时才订阅事件总线；订阅死亡（流结束/异常）后由下次 attach 重订阅。
 *   观看者归零不关订阅——浏览器频繁开关页面不该抖动总线。
 * - delta 走每会话独立 DeltaBuffer，flushMs 定时合帧；content 与结束类事件即时广播，不等 flush。
 * - 非观看会话的事件在进缓冲前就丢弃：不替没人看的会话攒内存，也避免旧缓冲漏给后来的观看者。
 * - content 帧作废同消息的待冲 delta：content 是该消息 parts 的权威快照（已含这些增量），
 *   再发一遍同段增量会让前端正文翻倍。content 之后新到的 delta 是新增量，桶按需重建。
 * - 回合结束态（endedTurns）：结束帧之后到达的迟到帧照常广播，紧跟一条 message-end 重新定格，
 *   守住不变量「一个回合的最后一帧永远是 message-end」；新回合由 session.execution.started 复位。
 * - 订阅死亡（live-only 契约，规格 §6）：订阅流中途结束/异常时先冲刷缓冲、给所有活跃观看者发
 *   message-end，再对每个观看者调 close() 关流；下一观看者到来时重订阅（新订阅不继承旧结束态）。
 */
export function createLiveHub(deps: LiveHubDeps, opts?: { flushMs?: number }): {
  /** 注册观看者，返回 detach（幂等）；sessionID 是注册表键（一任务一会话，观看会话唯一） */
  attach(sessionID: string, send: (frame: LiveFrame) => void, close?: () => void): () => void
  dispose(): void
} {
  const flushMs = opts?.flushMs ?? 150
  /** 观看者注册表：sessionID → 该会话的全体观看者 */
  const watchers = new Map<string, Set<LiveWatcher>>()
  /** 每会话一个 delta 合帧缓冲（懒建；末位观看者离开即连同丢弃） */
  const buffers = new Map<string, ReturnType<typeof createDeltaBuffer>>()
  /** 回合结束态：sessionID → 当前回合是否已结束。结束后的迟到帧要补 message-end 重新定格 */
  const endedTurns = new Map<string, boolean>()
  /** 待补定格的会话：回合结束后到达的 delta 已入缓冲，冲刷之后要补一条 message-end */
  const pendingRefreeze = new Set<string>()
  let subscribed = false // 订阅循环是否在跑（false = 未启动或已死亡，attach 时需重建）
  let disposed = false
  let epoch = 0 // 订阅世代：重订阅/停机即自增，旧循环迟到的续体按世代静默作废

  /** 单个观看者收帧：异常就地吞掉并记日志——一个观看者炸了不得拖垮整条广播 */
  const safeSend = (w: LiveWatcher, frame: LiveFrame): void => {
    try {
      w.send(frame)
    } catch (err) {
      deps.log(`[live] 观看者收帧失败（已跳过该观看者）：${String(err)}`)
    }
  }

  /** 单个观看者关流：同样就地吞掉异常（关流失败不影响其他观看者收尾） */
  const safeClose = (w: LiveWatcher): void => {
    try {
      w.close()
    } catch (err) {
      deps.log(`[live] 观看者关流失败：${String(err)}`)
    }
  }

  const broadcast = (sessionID: string, frame: LiveFrame): void => {
    const set = watchers.get(sessionID)
    if (!set) return
    for (const w of set) safeSend(w, frame)
  }

  /** 向所有活跃观看者广播一帧（跨会话）：订阅流死亡时用来统一收尾 */
  const broadcastAll = (frame: LiveFrame): void => {
    for (const set of watchers.values()) {
      for (const w of set) safeSend(w, frame)
    }
  }

  /** 清掉本轮结束态：新订阅建立 / 订阅死亡后，旧结束态不该跨回合残留 */
  const clearTurnStates = (): void => {
    endedTurns.clear()
    pendingRefreeze.clear()
  }

  /** 从注册表摘除一个观看者；该会话再无观看者时连同缓冲与结束态一并丢弃 */
  const detachWatcher = (sessionID: string, watcher: LiveWatcher): void => {
    const current = watchers.get(sessionID)
    if (!current?.delete(watcher)) return
    if (current.size === 0) {
      watchers.delete(sessionID)
      buffers.delete(sessionID) // 观看者归零：缓冲随之丢弃，重新 attach 从干净状态开始
      endedTurns.delete(sessionID) // 结束态与缓冲同生命周期：一并丢弃
      pendingRefreeze.delete(sessionID)
    }
  }

  /**
   * 冲刷某会话的 delta 缓冲并广播：flush 自带清空（幂等），产出帧按序发出。
   * 观看者已归零则连缓冲一起丢弃（结束态同生命周期，一并清掉）。
   */
  const flushSession = (sessionID: string): void => {
    const buf = buffers.get(sessionID)
    if (!buf) return
    const frames = buf.flush()
    const late = pendingRefreeze.delete(sessionID) // 迟到帧（回合结束后到达）：冲刷后补定格
    if (!frames.length) return
    if (!watchers.has(sessionID)) {
      buffers.delete(sessionID)
      endedTurns.delete(sessionID)
      return
    }
    for (const frame of frames) broadcast(sessionID, frame)
    // 补定格：迟到帧不能让前端停在流式态（一个回合的最后一帧永远是 message-end）
    if (late) broadcast(sessionID, { type: "message-end", messageID: null })
  }

  const handle = (ev: LiveEvent): void => {
    const sessionID = ev.data.sessionID
    if (typeof sessionID !== "string" || !watchers.has(sessionID)) return
    if (ev.type === "session.text.delta" || ev.type === "session.reasoning.delta") {
      const kind = ev.type === "session.text.delta" ? "text" : "reasoning"
      const messageID = ev.data.assistantMessageID
      const delta = ev.data.delta
      if (typeof messageID !== "string" || typeof delta !== "string") return // 形态不全的 delta 丢弃
      let buf = buffers.get(sessionID)
      if (!buf) {
        buf = createDeltaBuffer()
        buffers.set(sessionID, buf)
      }
      buf.push(kind, messageID, delta) // ordinal 是 part 索引、与 delta 顺序无关，刻意不用
      if (endedTurns.get(sessionID)) pendingRefreeze.add(sessionID) // 迟到帧：冲刷后补 message-end
      return
    }
    if (ev.type === "session.message.content.updated") {
      const frame = contentUpdatedFrame(ev.data)
      if (!frame) return // null（空 parts/缺 id）直接丢弃，不产空帧
      // content 是该消息 parts 的权威快照（已含这些增量）：作废同消息的待冲 delta 桶，
      // 否则前端会把同一段文本追加两次（正文翻倍）。content 之后新到的 delta 是新增量，桶按需重建。
      buffers.get(sessionID)?.discardMessage(frame.messageID)
      broadcast(sessionID, frame)
      if (endedTurns.get(sessionID)) {
        // 迟到帧：内容照发（不丢数据），紧跟一条 message-end 重新定格
        broadcast(sessionID, { type: "message-end", messageID: null })
      }
      return
    }
    if (ev.type === "session.execution.started") {
      // 新回合开始：结束态复位，之后的帧不再被补 message-end 提前定格
      // （pendingRefreeze 保留：已入缓冲的迟到帧仍属上一回合，冲刷后要补定格）
      endedTurns.delete(sessionID)
      return
    }
    if (ev.type === "session.execution.succeeded" || ev.type === "session.execution.failed") {
      // 结束信号必须排在文本之后：先把缓冲里的增量冲出去再广播 message-end。
      // 否则前端先定格、随后的 text-append 又把它置回流式态，消息永远卡在流式渲染。
      pendingRefreeze.delete(sessionID) // 结束分支紧跟一条 message-end，无需再补
      flushSession(sessionID)
      broadcast(sessionID, { type: "message-end", messageID: null }) // 回合收尾即消息结束
      endedTurns.set(sessionID, true) // 之后的迟到帧要补定格
      return
    }
  }

  /** 定时合帧：flush 自带清空；此刻已无观看者的会话整批帧随之丢弃，不留脏缓冲 */
  const flush = (): void => {
    if (disposed) return
    for (const sessionID of [...buffers.keys()]) flushSession(sessionID)
  }

  /**
   * 订阅流死亡收尾（规格 §6）：
   * - 先把各会话缓冲里的增量冲出去：不丢内容，且保住「text-append 排在 message-end 之前」的
   *   帧序（否则前端先定格、随后的 text-append 又把它置回流式态，消息卡在流式态）；
   * - 再给所有活跃观看者发 message-end：前端据此定格并暴露「实时已停止」，
   *   否则 SSE 连接不报错、前端静默冻在「实时」状态，只能靠用户手动刷新；
   * - 最后对每个观看者调 close() 关流：连接关闭是前端唯一的终态信号（不关流则状态条永远停在「实时」）；
   * - 最后清掉本轮结束态：订阅已死，结束态不该跨回合残留。
   */
  const onSubscriptionDead = (): void => {
    for (const sessionID of [...buffers.keys()]) flushSession(sessionID)
    broadcastAll({ type: "message-end", messageID: null })
    // 快照后再关流：关流会触发服务端的反注册（改注册表），先取快照避免边遍历边改
    const all: LiveWatcher[] = []
    for (const set of watchers.values()) all.push(...set)
    for (const w of all) safeClose(w)
    clearTurnStates()
  }

  const timer = deps.setInterval(flush, flushMs)

  async function pump(myEpoch: number, stream: AsyncIterable<LiveEvent>): Promise<void> {
    try {
      for await (const ev of stream) {
        if (disposed || myEpoch !== epoch) return // 世代不符：本次循环已被替代，迟到事件作废
        handle(ev)
      }
      if (disposed || myEpoch !== epoch) return
      subscribed = false
      deps.log("[live] 事件订阅流已结束，标记死亡，待下次 attach 重订阅")
      onSubscriptionDead() // 规格 §6：给所有活跃观看者发 message-end 并关流
    } catch (err) {
      if (disposed || myEpoch !== epoch) return
      subscribed = false
      deps.log(`[live] 事件订阅流异常，标记死亡，待下次 attach 重订阅：${String(err)}`)
      onSubscriptionDead() // 规格 §6：给所有活跃观看者发 message-end 并关流
    }
  }

  /**
   * 注册表空→非空、或原订阅已死亡时（重）建订阅循环。
   * @returns 订阅是否已在跑（false = 建立失败：调用方须给该观看者 message-end 后关流）
   */
  const ensureSubscribed = (): boolean => {
    if (disposed) return false
    if (subscribed) return true
    let stream: AsyncIterable<LiveEvent>
    try {
      stream = deps.subscribe()
    } catch (err) {
      // 同步抛错（如瞬态总线故障）：不上抛给 attach 调用方，也保持「未订阅」——
      // 若先置位再抛，会留下没有 pump 在跑的假订阅，之后任何 attach 都被挡回（僵尸化）
      deps.log(`[live] 事件订阅创建失败，保持未订阅，待下次 attach 重试：${String(err)}`)
      return false
    }
    subscribed = true
    epoch++
    clearTurnStates() // 新订阅拿到的是全新事件流，不继承上一条订阅的结束态
    void pump(epoch, stream)
    return true
  }

  return {
    attach(sessionID, send, close) {
      let set = watchers.get(sessionID)
      if (!set) {
        set = new Set()
        watchers.set(sessionID, set)
      }
      const watcher: LiveWatcher = { send, close: close ?? (() => {}) }
      set.add(watcher)
      let detached = false
      const detach = () => {
        if (detached) return // detach 幂等：重复调用不再动注册表
        detached = true
        detachWatcher(sessionID, watcher)
      }
      if (!ensureSubscribed()) {
        // 订阅建立失败：该观看者一帧 message-end 后关流（规格 §6 第 1 行）——
        // 前端唯一的终态信号是连接关闭，不关流它会一直等在「实时」上。
        safeSend(watcher, { type: "message-end", messageID: null })
        safeClose(watcher)
        detach() // 关流时服务端的 detach 还没就位，这里自己把残影摘掉
      }
      return detach
    },
    dispose() {
      if (disposed) return
      disposed = true
      deps.clearInterval(timer)
      watchers.clear()
      buffers.clear()
      endedTurns.clear()
      pendingRefreeze.clear()
      epoch++ // 在途 pump 的尾巴按世代作废，不再处理任何迟到事件
      subscribed = false
    },
  }
}
