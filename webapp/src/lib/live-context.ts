// 实时上下文流：服务端 SSE 推来的「帧」在前端消息列表上的应用（纯函数）。
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
