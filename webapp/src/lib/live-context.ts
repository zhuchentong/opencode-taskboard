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
import type { ContextMessage, ContextPart } from "./context"

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

/**
 * 任务可连实时的会话 ID；拿不到就返回空串（调用方据此不开 EventSource）。
 *
 * 硬规则（规格 §6「任务无会话 → 前端不重试」）：无会话的任务（未领取 / 人工执行）
 * 根本不开 EventSource——服务端那条路由会「一帧 message-end 即关流」，
 * 客户端若去连就会陷入「关流 → 退避重连 → 再关流」的重试风暴。
 * 前端从任务快照已知会话 ID（task.claim.sessionID），为空即零请求。
 */
export function liveSessionID(task: { claim?: { sessionID?: string } }): string {
  const id = task.claim?.sessionID
  return typeof id === "string" ? id : ""
}

/**
 * 收敛快照与实时消息（审查重点 3）：按消息 id 整组替换，不重复不丢失。
 *
 * 两侧的数据形态：
 * - 快照是服务端分页读出的完整消息，时间倒序（最新在前，src/context.ts 的 ORDER BY time_created DESC）；
 * - 实时是状态机自持的增量累积结果，同为倒序，只含本条实时流见过的消息。
 *
 * 合并规则（结果恒为「最新在前」）：
 * - 快照里有的 live 消息 → 按 id 原位替换（live 版优先：实时是更新的权威内容），位置不变；
 * - 快照里没有的 live 消息 → 按其 time 插入到全局「最新在前」序中的正确位置
 *   （不能一律前置到头部：长会话里实时侧会累出比快照首页更旧的消息，一律前置会把最旧的顶到最前）；
 * - 只存在于快照的消息 → 保留；
 * - live 为空 → 原样返回快照。
 *
 * role 以快照侧为准：帧协议不带 role，实时侧新建的消息恒为 assistant——
 * 直接拿实时版替换会把快照里的 user 消息（worker 指令）显示成 🤖 worker。
 *
 * 前提：两侧各自按 time 倒序（快照页倒序拼接、实时侧新消息 unshift 到头部），
 * 故用两路归并即可得到有序结果；同 id 只有一条（实时独有的那条不会同时出现在快照里）。
 *
 * 纯函数：不改入参、返回新数组；重复合并幂等（无副作用），
 * 因此「重拉快照」与「收到新帧」两条路径都能安全地反复调用。
 */
export function mergeLive(snapshot: ContextMessage[], live: ContextMessage[]): ContextMessage[] {
  if (live.length === 0) return snapshot
  // 同 id 的 live 消息只认首个（状态机内部不会产生重复，这里只是防御）
  const liveById = new Map<string, ContextMessage>()
  for (const m of live) {
    if (!liveById.has(m.id)) liveById.set(m.id, m)
  }
  const snapshotIDs = new Set<string>()
  for (const m of snapshot) snapshotIDs.add(m.id)
  // 实时独有（快照里没有）的消息：保持 live 的倒序，作为归并的第二路
  const liveOnly: ContextMessage[] = []
  for (const m of live) {
    if (snapshotIDs.has(m.id)) continue
    if (liveById.get(m.id) !== m) continue // 同 id 重复项只取首个
    liveOnly.push(m)
  }
  /** 同 id 替换：取实时版内容，但 role 以快照侧为准（实时侧 role 不可信） */
  const pick = (snapMsg: ContextMessage): ContextMessage => {
    const liveMsg = liveById.get(snapMsg.id)
    if (!liveMsg) return snapMsg
    return liveMsg.role === snapMsg.role ? liveMsg : { ...liveMsg, role: snapMsg.role }
  }
  // 两路归并：快照侧是骨架（相对顺序不变，只把同 id 的换成 live 版）
  const out: ContextMessage[] = []
  let si = 0
  let li = 0
  while (si < snapshot.length || li < liveOnly.length) {
    if (li >= liveOnly.length) {
      out.push(pick(snapshot[si]!))
      si++
      continue
    }
    if (si >= snapshot.length) {
      out.push(liveOnly[li]!)
      li++
      continue
    }
    const snapMsg = pick(snapshot[si]!)
    const liveMsg = liveOnly[li]!
    // 全局「最新在前」：时间更晚的在前（相等时实时在前——它更可能是刚产生的）
    if (liveMsg.time >= snapMsg.time) {
      out.push(liveMsg)
      li++
    } else {
      out.push(snapMsg)
      si++
    }
  }
  return out
}

// —— 快照播种（seed）——
//
// 问题：实时流的首帧常常是「增量片段」（用户中途打开标签页，状态机没见过这条消息），
// mergeLive 同 id 整体替换 → 快照里已有的正文被片段顶掉（正文被抹）。
//
// 方案：把快照播种进状态机自持的消息数组，让实时侧的每条消息一开始就带着快照正文，
// 之后到达的增量往它上面追加（applyTextAppend 追加到最后一个同 kind part，口径一致）。
//
// 播种语义（同一 id 已有实时消息时）：
// - 实时文本以快照文本开头 → 保留实时版（总线领先于 DB，实时版是快照的超集）；
// - 实时片段已含在快照正文里 → 用快照正文（DB 领先且已含该片段，不重复追加）；
// - 其余 → 快照文本在前、实时片段在后（DB 领先于总线，主导场景）。
//
// 幂等：重复播种同一快照不产生变化（首播后实时文本已以快照文本开头，前缀检查自然命中保留分支）。

/** 取 part 数组里最后一个指定 kind 的下标（增量追加落在最后一个同 kind part 上，合并口径与之对齐） */
function lastIndexOfKind(parts: ContextPart[], kind: "text" | "reasoning"): number {
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i]!.type === kind) return i
  }
  return -1
}

/** 同 kind 正文合并（见上方播种语义） */
function mergeKindText(snapText: string, liveText: string): string {
  if (!snapText) return liveText // 快照没有正文：实时版原样
  if (!liveText) return snapText // 实时还没有正文：用快照正文
  if (liveText.startsWith(snapText)) return liveText // 总线领先于 DB：保留实时版
  if (snapText.includes(liveText)) return snapText // DB 已含该片段：不重复追加
  return snapText + liveText // DB 领先于总线：快照文本在前、实时片段在后
}

/**
 * 播种合并：把一条快照消息与实时侧同 id 的消息合并成一条。
 * role / time 以快照侧为准（DB 才是消息的权威来源）；正文按 mergeKindText 合并。
 * 没变化时原样返回（幂等：重复播种不产新对象、不惊动消费方）。
 */
export function mergeSeededMessage(snap: ContextMessage, live: ContextMessage): ContextMessage {
  const parts = [...live.parts]
  let changed = false
  for (const kind of ["text", "reasoning"] as const) {
    const si = lastIndexOfKind(snap.parts, kind)
    if (si === -1) continue // 快照没有该 kind：实时版原样
    const snapPart = snap.parts[si]!
    const li = lastIndexOfKind(parts, kind)
    if (li === -1) {
      // 实时版没有该 kind：补上快照的 part（快照正文更完整）
      parts.push({ ...snapPart })
      changed = true
      continue
    }
    const merged = mergeKindText(snapPart.text ?? "", parts[li]!.text ?? "")
    if (merged !== (parts[li]!.text ?? "")) {
      parts[li] = { ...parts[li]!, text: merged }
      changed = true
    }
  }
  if (!changed && snap.role === live.role && snap.time === live.time) return live // 无变化 → 原对象（幂等）
  return { ...live, role: snap.role, time: snap.time, parts }
}

/** 按 time 插入到倒序列表（最新在前）；同 time 时插在已有同 time 消息之后 */
function insertByTime(list: ContextMessage[], msg: ContextMessage): ContextMessage[] {
  const idx = list.findIndex((m) => m.time < msg.time)
  if (idx === -1) return [...list, msg]
  return [...list.slice(0, idx), msg, ...list.slice(idx)]
}

/**
 * 把快照播种进实时侧消息数组（纯函数、幂等）：
 * - 快照里状态机没有的消息 → 按 time 插入（倒序）；
 * - 同 id 已有实时消息 → 按 mergeSeededMessage 合并（快照正文在前或保留实时版）；
 * - 只在实时侧的消息 → 原样保留（播种不该动它们）。
 */
export function seedMessages(live: ContextMessage[], snapshot: ContextMessage[]): ContextMessage[] {
  if (snapshot.length === 0) return live
  let out = live
  for (const snap of snapshot) {
    const idx = out.findIndex((m) => m.id === snap.id)
    if (idx === -1) {
      out = insertByTime(out, snap)
      continue
    }
    const merged = mergeSeededMessage(snap, out[idx]!)
    if (merged === out[idx]) continue // 无变化（幂等）
    const next = [...out]
    next[idx] = merged
    out = next
  }
  return out
}

// —— 订阅状态机（connectLiveContext）——

/** 实时订阅的连接态：live=实时中；reconnecting=断线退避重连中；off=连续三败降级（终态） */
export type LiveStatus = "live" | "reconnecting" | "off"

/** 实时订阅句柄：播种快照（seed）与收尾（dispose） */
export interface LiveContextHandle {
  /** 把快照播种进状态机自持的消息数组（幂等；无变化时不回调 onMessages） */
  seed(messages: ContextMessage[]): void
  /** 关闭连接并清空全部定时器 */
  dispose(): void
}

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

/** 退避档位（毫秒）：1s → 2s → 4s，再往后封顶 10s */
const BACKOFF_MS = [1000, 2000, 4000]
/** 退避封顶：超出档位表一律 10s */
const MAX_BACKOFF_MS = 10000
/** 连续失败达此数即降级 off（终态，不再重连） */
const FAILURE_THRESHOLD = 3

/**
 * 第 failures 次失败后的重连等待时长（failures 从 1 起）：1s → 2s → 4s，再往后封顶 10s。
 * failures < 1 表示「还没失败过」，无等待可言，返回 0。
 * 单独导出便于钉住退避档位；状态机里当前阈值 3 只会用到前两档，4s 及封顶档是防御性分支
 * （真要放宽失败阈值时档位表直接可用，不必改实现）。
 */
export function liveBackoffDelay(failures: number): number {
  if (failures < 1) return 0
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
 *   出错的连接立即作废：其迟到的 error/open 回调一律拒收（不重复累加失败计数、
 *   不把已死连接复活成 live、不取消待触发的重连）。
 * - onmessage → JSON.parse 后 applyFrame，每帧回调 onMessages（内部自持消息数组，初始 []）。
 * - message-end 不是终态：它只定格消息，连接保持打开接下一回合。
 *
 * 快照播种（seed）：把快照并进状态机自持的数组，让实时侧的消息一开始就有完整正文——
 * 没有它，实时流首帧（增量片段）会把快照正文整体顶掉（正文被抹）。
 *
 * @param taskID 任务 ID（进 URL 前做 encodeURIComponent）
 * @param handlers 帧应用结果与连接态回调
 * @param deps 可注入的依赖（与内置默认合并，测试只覆盖需要替换的部分）
 * @returns 句柄：seed（播种快照）与 dispose（关连接、清定时器）
 */
export function connectLiveContext(
  taskID: string,
  handlers: {
    onMessages(messages: ContextMessage[]): void
    onStatus(s: LiveStatus): void
  },
  deps?: Partial<LiveConnectDeps>,
): LiveContextHandle {
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
    // 本连接一旦出错即作废：close 之后浏览器仍可能派发迟到的 error/open 回调——
    // 收下会重复累加失败计数（或把已死连接复活成 live 并取消待触发的重连），
    // 故用 failed 标记把该实例后续一切回调拒收
    let failed = false

    s.onopen = () => {
      // 过期连接（已被重建取代）、已失败连接或已降级终态的回调不参与状态机
      if (stopped || dead || failed || es !== s) return
      failures = 0
      clearRetry()
      handlers.onStatus("live")
    }

    s.onerror = () => {
      if (stopped || dead || failed || es !== s) return
      failed = true
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
      // 先排退避再上报状态：消费方的 onStatus 若抛错，也不能连带把重连排程吃掉
      scheduleReconnect()
      handlers.onStatus("reconnecting")
    }

    s.onmessage = (e) => {
      if (stopped || dead || failed || es !== s) return
      try {
        const frame = JSON.parse(e.data) as LiveFrame
        messages = applyFrame(messages, frame)
      } catch {
        // 非 JSON 帧（心跳注释不会进 onmessage）或形状非法的帧（applyFrame 抛错）：
        // 忽略——一条坏帧不得打断整条流，也不得从事件回调里冒出未捕获异常
        return
      }
      handlers.onMessages(messages)
    }
  }

  open()

  return {
    seed(snapshot) {
      if (stopped) return // 订阅已收尾：播种无人消费
      const next = seedMessages(messages, snapshot)
      if (next === messages) return // 无变化（幂等）：不必惊动消费方
      messages = next
      handlers.onMessages(messages)
    },
    dispose() {
      stopped = true
      clearRetry()
      es?.close()
    },
  }
}

/**
 * 收到某连接态时要不要重拉快照（规格 §4.3 / §6：断线 → 关流 → 重拉快照 → 退避重连）。
 *
 * 断线窗口内产生的消息永远不上屏——不重拉就永远缺那一段。
 * off 是连续三败的终态：同样重拉一次（此后只保留快照与手动刷新）。
 */
export function shouldReloadSnapshot(status: LiveStatus): boolean {
  return status === "reconnecting" || status === "off"
}
