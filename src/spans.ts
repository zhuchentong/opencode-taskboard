import type { PhaseSpan, SpanRecord, Status, Task } from "./types"

/** 计时阶段：只有这两个状态占用 worker，会累计执行时长 */
export const PHASES = ["analyzing", "executing"] as const
export type Phase = (typeof PHASES)[number]

/** 分段账本覆盖的阶段：比旧 PHASES 多一个 analysis_confirm（等待段只记时长不记 token） */
const SPAN_PHASES = ["pending", "analyzing", "executing", "analysis_confirm"] as const
type SpanPhase = (typeof SPAN_PHASES)[number]

export function phaseOf(status: Status): Phase | undefined {
  return (PHASES as readonly Status[]).includes(status) ? (status as Phase) : undefined
}

function spanPhaseOf(status: Status): SpanPhase | undefined {
  return (SPAN_PHASES as readonly Status[]).includes(status) ? (status as SpanPhase) : undefined
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
 * 状态迁移时维护计时（纯函数，原地改 next，不碰 prev）。
 *
 * 旧两段计时的语义逐字保留（spans 结构与前端兼容）：
 * 1. 回到「待领取」= 新一轮（打回/放弃），旧区间整体作废，不封口，避免上一轮时长串进新一轮
 * 2. 离开计时阶段 → 封口该段（已有 endedAt 不覆写）
 * 3. 进入计时阶段 → 开启新段（拖出再拖回算重开一轮，不续计）
 * 4. 同段内迁移、只改标题描述 → 原样保留，进行中的段不被误封口
 *
 * spanLog 分段账本（只追加，回 pending **不作废**历史段——这正是问答循环/打回重做
 * 每段独立留存的来源；旧 spans 作废语义只作用于 spans 字段）：
 * - 覆盖 analyzing/executing/analysis_confirm 三段
 * - 封口时从 next.usage 拷贝累计快照（段间消耗由展示层做差）
 * - round 为任务真源（进 pending 次数），随段标注
 */
export function transitionSpans(prev: Task, next: Task, now: number): void {
  // round 真源：进入 pending 即新一轮（打回/放弃/拖入）；已在 pending 不重置
  if (next.status === "pending" && prev.status !== "pending") {
    next.round = (prev.round ?? 0) + 1
  }

  // —— spanLog 账本（独立于旧 PHASES：analysis_confirm 也计段）——
  const spanPrev = spanPhaseOf(prev.status)
  const spanNext = spanPhaseOf(next.status)
  if (spanPrev !== spanNext) {
    const log: SpanRecord[] = [...(next.spanLog ?? prev.spanLog ?? [])]
    if (spanPrev) {
      // 封口该 phase 的最后一条未封口记录
      for (let i = log.length - 1; i >= 0; i--) {
        if (log[i].phase === spanPrev && log[i].endedAt === undefined) {
          log[i] = {
            ...log[i],
            endedAt: now,
            ...(next.usage ? { usage: { ...next.usage } } : {}),
          }
          break
        }
      }
    }
    if (spanNext) {
      const sessionID = next.claim?.sessionID || undefined
      log.push({
        phase: spanNext,
        round: next.round ?? 1,
        ...(sessionID ? { sessionID } : {}),
        startedAt: now,
      })
    }
    next.spanLog = log.length > 0 ? log : undefined
  }

  // —— 旧两段计时（原样保留）——
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
