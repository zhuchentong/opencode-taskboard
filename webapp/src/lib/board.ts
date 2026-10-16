import type { Status, Task } from "./types"

export const STATUSES = [
  "planning",
  "pending",
  "analyzing",
  "analysis_confirm",
  "executing",
  "completion_confirm",
  "done",
] as const satisfies readonly Status[]

export const STATUS_LABELS: Record<Status, string> = {
  planning: "待规划",
  pending: "待领取",
  analyzing: "分析中",
  analysis_confirm: "分析确认",
  executing: "执行中",
  completion_confirm: "完成确认",
  done: "已完成",
}

/** 按状态分组，七键齐全；列内 updatedAt 倒序（新的在前） */
export function groupByStatus(tasks: Task[]): Record<Status, Task[]> {
  const groups = Object.fromEntries(STATUSES.map((s) => [s, [] as Task[]])) as Record<Status, Task[]>
  for (const t of tasks) groups[t.status]?.push(t)
  for (const s of STATUSES) groups[s].sort((a, b) => b.updatedAt - a.updatedAt)
  return groups
}

/** 相对时间：<60s 刚刚；<60m N 分钟前；<24h N 小时前；更早显示「M月D日」 */
export function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return "刚刚"
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  const d = new Date(ts)
  return `${d.getMonth() + 1}月${d.getDate()}日`
}
