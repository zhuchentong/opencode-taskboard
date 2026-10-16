/**
 * 自动派发器的纯决策层：条件判定与失败退避。
 * 接线（会话管理、定时器、storage）见同文件 Task 4 的 initDispatcher。
 */

export const DISPATCH_CAPS = {
  /** 每日派发上限（硬熔断） */
  dailyCap: 100,
  /** 两次派发之间的最小间隔 */
  minIntervalMs: 10_000,
  /** 连续失败达到该值 → 暂停派发 */
  failPause: 3,
  /** 首次失败冷却 */
  backoffBaseMs: 60_000,
  /** 冷却封顶 */
  backoffCapMs: 1_800_000,
} as const

export type DispatchState = {
  /** 是否主实例（唯一派发者） */
  primary: boolean
  /** 设置 autoDispatch 已开启 */
  enabled: boolean
  /** 连续失败触发的暂停态 */
  paused: boolean
  /** 待领取任务数 */
  pendingCount: number
  /** worker 会话名下存在非 done claim（含停在 analysis_confirm） */
  workerBusy: boolean
  /** 当前处于失败冷却窗口 */
  inCooldown: boolean
  /** 距上次派发的毫秒数（从未派发过为 null） */
  lastDispatchAgeMs: number | null
  /** 当日已派发次数 */
  todayCount: number
}

/** 依次检查守卫；不满足返回首个原因，全过返回 ok */
export function shouldDispatch(s: DispatchState): { ok: boolean; reason: string } {
  if (!s.primary) return { ok: false, reason: "secondary" }
  if (!s.enabled) return { ok: false, reason: "disabled" }
  if (s.paused) return { ok: false, reason: "paused" }
  if (s.pendingCount === 0) return { ok: false, reason: "empty" }
  if (s.workerBusy) return { ok: false, reason: "worker-busy" }
  if (s.inCooldown) return { ok: false, reason: "cooldown" }
  if (s.lastDispatchAgeMs !== null && s.lastDispatchAgeMs < DISPATCH_CAPS.minIntervalMs) {
    return { ok: false, reason: "interval" }
  }
  if (s.todayCount >= DISPATCH_CAPS.dailyCap) return { ok: false, reason: "cap" }
  return { ok: true, reason: "" }
}

/** 失败退避：60s 起指数翻倍，封顶 30 分钟；无失败为 0 */
export function nextBackoffMs(failStreak: number): number {
  if (failStreak <= 0) return 0
  const exp = DISPATCH_CAPS.backoffBaseMs * 2 ** (failStreak - 1)
  return Math.min(exp, DISPATCH_CAPS.backoffCapMs)
}
