// 实时上下文流的数据层：把 opencode 事件总线上的流式增量与内容更新，
// 归一化成看板前端消费的「帧」（LiveFrame）。纯函数，无 IO、无全局状态。
//
// 设计要点：
// - delta 合帧：模型流式输出是逐 token 的小片段，直接广播会让前端渲染抖动。
//   这里按 (kind, messageID) 分桶拼串，flush 一次性产出整段文本帧。
// - content 归一化：opencode 事件的 content 数组与 part 原始 JSON 同构，
//   复用 context.ts 的 normalizePart 得到看板统一的 part 形态。
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
 * content 缺失/非数组返回 null（不是每条消息都带 content）。
 */
export function contentUpdatedFrame(data: Record<string, unknown>): LiveFrame | null {
  const content = data.content
  if (!Array.isArray(content)) return null
  const messageID = typeof data.messageID === "string" ? data.messageID : ""
  const parts: ContextPart[] = []
  for (const item of content) {
    if (!item || typeof item !== "object") continue
    const part = normalizePart(toRawPart(item as Record<string, unknown>))
    if (part) parts.push(part)
  }
  return { type: "content", messageID, parts }
}

/**
 * 事件里的 part 与库里存的 part 原始 JSON 同构，唯一差异：事件的 tool part
 * 用 name 字段记工具名，库里的用 tool 字段。这里补齐 tool，normalizePart 本体不动。
 */
function toRawPart(raw: Record<string, unknown>): Record<string, unknown> {
  if (raw.type !== "tool" || typeof raw.tool === "string") return raw
  if (typeof raw.name !== "string") return raw
  return { ...raw, tool: raw.name }
}
