/**
 * 派发器纯决策层:守卫链、失败退避、并发计数 —— 无 IO,同步可测。
 * 行为从旧 src/dispatcher.ts(已删除前)逐字迁移,唯一结构变化:
 * shouldDispatch 由 if 链改为 GUARDS 守卫链遍历(架构冗余点:未来加
 * 「时段窗口」「成本预算」等守卫只插链尾,零改核心)。
 *
 * 会话模型:**一任务一会话**。派发时为任务新建专属会话,任务终结后不复用——
 * 长任务跑在同一会话里会持续累积上下文(实测复用会话 39 轮即耗 51 万 cache token),
 * 既拖慢响应又让后续任务被污染。
 */

import type { Claim, Status } from "../types"
import type { DispatchContext, Guard } from "./types"

export type { DispatchContext, DispatchState } from "./types"

export const DISPATCH_CAPS = {
  // 日派发上限(dailyCap)已按产品决策移除(2026-10-18):派发不再受日配额拒绝,todayCount 仅作观测。
  /**
   * 两次派发之间的最小间隔(**全局节流**,不是每 worker 各自节流)。
   * 主要作用是错峰:填满 6 个槽位时每隔 0.5s 出一个会话,避免同时抢 API。
   * 取值要小:槽位释放后靠它保证不会同一瞬间打出一批会话,但也不能稀释填槽速度。
   */
  minIntervalMs: 500,
  /** 并发上限:同时被处理的阶段数(analyzing + executing)达到该值就不再派发 */
  maxConcurrent: 6,
  /** 派发后等待 worker 领取的时限;超时回收会话与名额(不熔断,见 timeoutPause) */
  claimWaitMs: 180_000,
  /** 活跃任务的消耗刷新间隔:长任务执行中也看得到 token 在涨 */
  usagePollMs: 120_000,
  /** 派发异常导致的全局熔断:连败达该值 → 暂停派发 */
  failPause: 3,
  /** 未领取超时:按任务独立计数与冷却(全局 timeoutStreak 仅作观测口径) */
  timeoutPause: 3,
  /** 兜底评估周期:评估由写事件驱动,空闲(无写事件)时靠它自行恢复派发(冷却到期等) */
  evaluateTickMs: 30_000,
  /** 首次失败冷却 */
  backoffBaseMs: 60_000,
  /** 冷却封顶 */
  backoffCapMs: 1_800_000,
  /** 外部写事件的评估防抖(修死代码配套:2s → 500ms;写风暴由排空循环合并) */
  evaluateMs: 500,
  /** 建会话失败独立退避:连败达该值 → 进入 create-fail 冷却(不置全局 paused) */
  createFailPause: 3,
  /** 建会话失败退避封顶(5 分钟,远低于派发异常的 30 分钟) */
  createFailCapMs: 300_000,
} as const

/**
 * 派发守卫链:顺序即判定优先级(与旧 if 链逐条对应)。
 * 每个 guard 返回拒绝原因,或 null 放行。
 */
export const GUARDS: Guard[] = [
  { name: "secondary", check: (ctx) => (ctx.primary ? null : "secondary") },
  { name: "disabled", check: (ctx) => (ctx.enabled ? null : "disabled") },
  { name: "paused", check: (ctx) => (ctx.paused ? "paused" : null) },
  {
    name: "empty",
    check: (ctx) => (ctx.pendingCount === 0 ? "empty" : null),
  },
  {
    name: "concurrency-full",
    check: (ctx, caps) => (ctx.activeCount >= caps.maxConcurrent ? "concurrency-full" : null),
  },
  { name: "cooldown", check: (ctx) => (ctx.inCooldown ? "cooldown" : null) },
  {
    name: "interval",
    check: (ctx, caps) =>
      ctx.lastDispatchAgeMs !== null && ctx.lastDispatchAgeMs < caps.minIntervalMs
        ? "interval"
        : null,
  },
]

/**
 * 依次执行守卫链;首个拒绝原因即返回,全过返回 ok。
 * opts 供测试/接线注入时间常数覆盖(行为与旧 if 链完全一致)。
 * 判定顺序:primary → enabled → paused → empty → concurrency-full → cooldown → interval。
 * 日派发上限(cap)已按产品决策移除:派发不受日配额拒绝,todayCount 仅作观测展示。
 * 并发维度用 concurrency-full 取代原「worker 是否忙」判定:多 worker 下只有槽位是硬约束,
 * 若继续按 worker 名下 claim 判忙,单 worker 名下一有未完成 claim 就会把并发锁死为 1。
 */
export function shouldDispatch(
  s: DispatchContext,
  opts?: { minIntervalMs?: number; maxConcurrent?: number },
): { ok: boolean; reason: string } {
  const caps = {
    minIntervalMs: opts?.minIntervalMs ?? DISPATCH_CAPS.minIntervalMs,
    maxConcurrent: opts?.maxConcurrent ?? DISPATCH_CAPS.maxConcurrent,
  }
  for (const guard of GUARDS) {
    const reason = guard.check(s, caps)
    if (reason !== null) return { ok: false, reason }
  }
  return { ok: true, reason: "" }
}

/**
 * 失败退避:baseMs 起指数翻倍,封顶 30 分钟;无失败为 0。
 * streak 泛指「任一连败计数」:全局派发异常 streak 或任务级超时 streak 都走这条曲线。
 */
export function nextBackoffMs(streak: number, baseMs: number = DISPATCH_CAPS.backoffBaseMs): number {
  if (streak <= 0) return 0
  return Math.min(baseMs * 2 ** (streak - 1), DISPATCH_CAPS.backoffCapMs)
}

/**
 * 未领取超时的退避:调用方(engine 的 onTimeout)直接用 nextBackoffMs —— 曲线唯一,
 * 「按任务独立计数」的语义由调用处的 streak 来源保证,不再维护纯别名函数。
 */

/** 建会话失败的独立退避:曲线同源,封顶 createFailCapMs(5 分钟),不拖累全局熔断 */
export function nextCreateFailBackoffMs(streak: number, baseMs: number = DISPATCH_CAPS.backoffBaseMs): number {
  if (streak <= 0) return 0
  return Math.min(baseMs * 2 ** (streak - 1), DISPATCH_CAPS.createFailCapMs)
}

/**
 * 全局熔断判定:只有**派发异常**(会话 API 抛错等)连败达 failPause 才暂停全局派发。
 * 单任务的未领取超时不得走这里——一个慢任务超时不影响其他任务,也不该把整个派发器停掉。
 */
export function shouldPauseGlobal(failStreak: number): boolean {
  return failStreak >= DISPATCH_CAPS.failPause
}

/**
 * 任务级熔断判定:未领取超时连败达 timeoutPause → 只延长该任务的冷却。
 * 明确边界:不置全局 paused,不影响其他任务的派发。
 */
export function shouldPauseWorker(timeoutStreak: number): boolean {
  return timeoutStreak >= DISPATCH_CAPS.timeoutPause
}

/**
 * 并发计数:处于 analyzing / executing 的任务各占一个并发槽。
 *
 * 按状态计数而非按 claim 计数,因为 store 的 patch() 在 action: "confirm" 分支
 * 不走 applyDragClaim——而 CLAIM_STATES 只含 analyzing/executing,于是「人工拖到
 * analysis_confirm」会清空 claim,随后「用户点通过」把状态改成 executing,
 * 就产生 claim 为 undefined 的 executing 任务。按 claim 计数会漏掉它,
 * 实际并发会超出 maxConcurrent(超限 = 真并行失控)。
 */
export function countActive(tasks: { status: Status; claim?: Claim }[]): number {
  return tasks.filter((t) => t.status === "analyzing" || t.status === "executing").length
}
