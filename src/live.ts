// 实时上下文流的数据层：把 opencode 事件总线上的流式增量与内容更新，
// 归一化成看板前端消费的「帧」（LiveFrame）。纯函数，无 IO、无全局状态。
//
// 设计要点：
// - delta 合帧：模型流式输出是逐 token 的小片段，直接广播会让前端渲染抖动。
//   这里按 (kind, messageID) 分桶拼串，flush 一次性产出整段文本帧。
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
