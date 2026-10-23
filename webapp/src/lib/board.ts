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

/**
 * 七状态视觉令牌单一来源（Card 色带/状态签圆点与 Lane 泳道头圆点共用）。
 * 色彩语义：planning 草稿（note 紫）、pending 活跃排队（info 天蓝+脉冲）、
 * analyzing 主色、executing 健康推进（success 绿）、两 confirm 列有意同色
 * （warning 琥珀=等人工裁决，强化「同一类动作」）、done 归档灰。
 * pending 脉冲带 motion-reduce 关停，尊重系统减弱动效偏好。
 */
export const STATUS_TOKEN: Record<Status, { dot: string; band: string }> = {
  planning: { dot: "bg-note", band: "border-l-note" },
  pending: {
    dot: "bg-info animate-pulse motion-reduce:animate-none",
    band: "border-l-info",
  },
  analyzing: { dot: "bg-primary", band: "border-l-primary" },
  executing: { dot: "bg-success", band: "border-l-success" },
  analysis_confirm: { dot: "bg-warning", band: "border-l-warning" },
  completion_confirm: { dot: "bg-warning", band: "border-l-warning" },
  done: { dot: "bg-muted-foreground/60", band: "border-l-muted-foreground/40" },
}

/** 空泳道引导文案：解释该阶段「谁在做什么、等谁」（单一来源，Board 消费） */
export const STATUS_HINTS: Record<Status, string> = {
  planning: "看板空空如也——点击右上「＋新建任务」创建第一张卡片",
  pending: "等待 Agent 领取（开启自动领取会自动派发）",
  analyzing: "Agent 正在阅读代码、产出分析",
  analysis_confirm: "分析已提交，等你放行",
  executing: "已放行，Agent 正在执行",
  completion_confirm: "Agent 已提交成果，等你验收",
  done: "已完结的任务在这里归档",
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
