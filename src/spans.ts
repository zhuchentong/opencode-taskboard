import type { PhaseSpan, Status, Task } from "./types"

/** 计时阶段：只有这两个状态占用 worker，会累计执行时长 */
export const PHASES = ["analyzing", "executing"] as const
export type Phase = (typeof PHASES)[number]

export function phaseOf(status: Status): Phase | undefined {
  return (PHASES as readonly Status[]).includes(status) ? (status as Phase) : undefined
}

function cloneSpans(spans: Task["spans"]): Partial<Record<Phase, PhaseSpan>> {
  const out: Partial<Record<Phase, PhaseSpan>> = {}
  for (const p of PHASES) {
    const s = spans?.[p]
    if (s) out[p] = { ...s }
  }
  return out
}

/**
 * 状态迁移时维护两段计时（纯函数，原地改 next，不碰 prev）：
 * 1. 回到「待领取」= 新一轮（打回/放弃），旧区间整体作废，不封口，避免上一轮时长串进新一轮
 * 2. 离开计时阶段 → 封口该段（已有 endedAt 不覆写）
 * 3. 进入计时阶段 → 开启新段（拖出再拖回算重开一轮，不续计）
 * 4. 同段内迁移、只改标题描述 → 原样保留，进行中的段不被误封口
 */
export function transitionSpans(prev: Task, next: Task, now: number): void {
  if (next.status === "pending") {
    next.spans = undefined
    return
  }
  const prevPhase = phaseOf(prev.status)
  const nextPhase = phaseOf(next.status)
  if (prevPhase === nextPhase) return

  const spans = cloneSpans(next.spans)
  if (prevPhase && spans[prevPhase]) spans[prevPhase].endedAt ??= now
  if (nextPhase) spans[nextPhase] = { startedAt: now }
  next.spans = spans
}
