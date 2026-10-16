import type { Task } from "./types"

/** 计时阶段与其中文标签（顺序即展示顺序：分析 → 执行） */
export const PHASES = ["analyzing", "executing"] as const
export type Phase = (typeof PHASES)[number]
export const PHASE_LABELS: Record<Phase, string> = { analyzing: "分析", executing: "执行" }

const MIN = 60_000
const HOUR = 3_600_000

/** 毫秒 → 45s / 2m30s / 1h05m；小时级不带秒，避免每秒跳动。非法/负值兜底 0s */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s"
  const total = Math.floor(ms / 1000)
  const s = total % 60
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600)
  const pad = (n: number) => String(n).padStart(2, "0")
  if (h > 0) return `${h}h${pad(m)}m`
  if (m > 0) return `${m}m${pad(s)}s`
  return `${s}s`
}

/** 绝对时刻：同一天只显示时分，跨天补「M月D日」 */
export function formatClock(ts: number, now: number = Date.now()): string {
  const d = new Date(ts)
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
  const sameDay = new Date(now).toDateString() === d.toDateString()
  return sameDay ? time : `${d.getMonth() + 1}月${d.getDate()}日 ${time}`
}

export interface PhaseView {
  phase: Phase
  label: string
  startedAt: number
  /** 进行中为 undefined */
  endedAt?: number
  /** 进行中的段按 now - startedAt 实时算 */
  duration: number
  running: boolean
}

/** 任务已有的计时段（按分析 → 执行排序）；残缺段（无 startedAt）直接丢弃 */
export function phaseViews(task: Task, now: number): PhaseView[] {
  const out: PhaseView[] = []
  for (const phase of PHASES) {
    const span = task.spans?.[phase]
    if (!span || span.startedAt === undefined) continue
    const running = span.endedAt === undefined
    out.push({
      phase,
      label: PHASE_LABELS[phase],
      startedAt: span.startedAt,
      endedAt: span.endedAt,
      duration: running ? Math.max(0, now - span.startedAt) : span.endedAt - span.startedAt,
      running,
    })
  }
  return out
}

/** 是否存在「进行中」的计时段（endedAt 缺省）；心跳定时器的启停判据 */
export function hasRunningSpan(task: Task): boolean {
  return PHASES.some((p) => {
    const s = task.spans?.[p]
    return !!s && s.startedAt !== undefined && s.endedAt === undefined
  })
}

/** 排队时长：仅「待领取」有意义；老任务无 pendingAt 时回落 createdAt；时钟回拨归零 */
export function queueWaitMs(task: Task, now: number): number | null {
  if (task.status !== "pending") return null
  return Math.max(0, now - (task.pendingAt ?? task.createdAt))
}

/** 心跳判据：进行中的计时段，或待领取任务（排队时长需逐秒递增） */
export function needsTicker(task: Task): boolean {
  return task.status === "pending" || hasRunningSpan(task)
}

/** 卡片 meta 行的单行文案：「分析 2m30s · 执行 1m00s…」，进行中的段带省略号；无记录返回空串 */
export function formatPhaseLine(task: Task, now: number): string {
  return phaseViews(task, now)
    .map((v) => `${v.label} ${formatDuration(v.duration)}${v.running ? "…" : ""}`)
    .join(" · ")
}

/** 卡片 title 悬浮提示的绝对时刻文案 */
export function formatPhaseTooltip(task: Task, now: number): string {
  const views = phaseViews(task, now)
  if (views.length === 0) return ""
  return views
    .map((v) => {
      const start = formatClock(v.startedAt, now)
      const end = v.running ? `进行中（已 ${formatDuration(v.duration)}）` : formatClock(v.endedAt!, now)
      return `${v.label}：${start} → ${end} · 用时 ${formatDuration(v.duration)}`
    })
    .join("\n")
}
