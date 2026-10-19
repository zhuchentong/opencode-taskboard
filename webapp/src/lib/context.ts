// 「上下文」标签的展示辅助纯函数：工具摘要、角色元数据、空态文案。
// 服务端（src/context.ts）已做分页与截断，这里只管渲染形态。
import type { Task } from "./types"

export interface ContextPart {
  type: "text" | "reasoning" | "tool" | "patch" | "file" | "other"
  text?: string
  tool?: string
  state?: string
  input?: string
  output?: string
  files?: string[]
  filename?: string
  truncated?: boolean
}

export interface ContextMessage {
  id: string
  role: string
  time: number
  parts: ContextPart[]
}

export interface ContextPage {
  sessionID: string | null
  total: number
  page: ContextMessage[]
  nextCursor: string | null
  hasMore: boolean
}

/** 工具折叠条的一行摘要：`工具名 关键参数`；参数按工具名挑关键字段，未知工具回退原串截断 */
export function toolSummary(part: ContextPart): string {
  const name = part.tool ?? "?"
  if (!part.input) return name
  let obj: Record<string, unknown> | undefined
  try {
    obj = JSON.parse(part.input) as Record<string, unknown>
  } catch {
    return (name + " " + part.input).slice(0, 20)
  }
  const pick = (keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = obj?.[k]
      if (typeof v === "string" && v) return v
    }
    return undefined
  }
  const KEY_FIELDS: Record<string, string[]> = {
    read: ["path", "file_path"],
    write: ["file_path"],
    edit: ["file_path"],
    bash: ["command"],
    grep: ["pattern"],
    glob: ["pattern"],
    taskboard_claim: ["id"],
    task: ["description", "prompt"],
  }
  const key = pick(KEY_FIELDS[name] ?? [])
  const fallback = key ?? (obj ? JSON.stringify(obj) : part.input)
  return (name + " " + fallback).slice(0, 80)
}

/** 工具执行状态图标 */
export function toolStateIcon(part: ContextPart): string {
  switch (part.state) {
    case "completed":
      return "✓"
    case "error":
      return "✗"
    case "running":
    case "pending":
      return "⏳"
    default:
      return "·"
  }
}

/** 角色元数据：worker 会话里 user 是派发下去的指令，assistant 是 worker 的回复 */
export function roleMeta(role: string): { label: string; icon: string } {
  if (role === "user") return { label: "worker 指令", icon: "▶" }
  if (role === "assistant") return { label: "worker", icon: "🤖" }
  return { label: role, icon: "·" }
}

/** 空态文案：区分「未开工」「人工执行」「会话无消息」三种情况 */
export function emptyHint(task: Task): string {
  if (!task.claim) return "任务尚未开工，还没有会话上下文"
  if (!task.claim.sessionID) return "本任务由用户手动执行，无会话上下文"
  return "会话暂无消息"
}
