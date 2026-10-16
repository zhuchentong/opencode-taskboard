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

/** 依次检查守卫；不满足返回首个原因，全过返回 ok。opts 供测试/接线注入时间常数覆盖 */
export function shouldDispatch(
  s: DispatchState,
  opts?: { minIntervalMs?: number; dailyCap?: number },
): { ok: boolean; reason: string } {
  const minIntervalMs = opts?.minIntervalMs ?? DISPATCH_CAPS.minIntervalMs
  const dailyCap = opts?.dailyCap ?? DISPATCH_CAPS.dailyCap
  if (!s.primary) return { ok: false, reason: "secondary" }
  if (!s.enabled) return { ok: false, reason: "disabled" }
  if (s.paused) return { ok: false, reason: "paused" }
  if (s.pendingCount === 0) return { ok: false, reason: "empty" }
  if (s.workerBusy) return { ok: false, reason: "worker-busy" }
  if (s.inCooldown) return { ok: false, reason: "cooldown" }
  if (s.lastDispatchAgeMs !== null && s.lastDispatchAgeMs < minIntervalMs) {
    return { ok: false, reason: "interval" }
  }
  if (s.todayCount >= dailyCap) return { ok: false, reason: "cap" }
  return { ok: true, reason: "" }
}

/** 失败退避：baseMs 起指数翻倍，封顶 30 分钟；无失败为 0 */
export function nextBackoffMs(failStreak: number, baseMs: number = DISPATCH_CAPS.backoffBaseMs): number {
  if (failStreak <= 0) return 0
  return Math.min(baseMs * 2 ** (failStreak - 1), DISPATCH_CAPS.backoffCapMs)
}

/* ============ 接线层 ============ */

import { buildClaimPrompt } from "./commands"
import type { Store } from "./store"

/** ctx.session 的结构化子集（避免绑定具体 SDK 类型） */
export interface DispatcherSession {
  create(input?: { title?: string }): Promise<{ id: string }>
  get(input: { sessionID: string }): Promise<unknown>
  prompt(input: { sessionID: string; text: string }): Promise<unknown>
}

/** ctx.storage 的结构化子集 */
export interface DispatcherStorage {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
}

export type DispatcherStatus = {
  state: "idle" | "cooldown" | "paused"
  failStreak: number
  todayCount: number
  cooldownRemainMs: number
}

/** 派发提示词：复用 claim 闭环骨架，限定一次一个 */
export function buildDispatchPrompt(): string {
  return [
    "【自动派发】这是任务看板插件的后台自动派发，不是用户提问。",
    "只领取并处理一个任务，完成提交后立即停止，不要继续领取下一个任务。",
    "",
    buildClaimPrompt(),
  ].join("\n")
}

export function initDispatcher(
  ctx: { session: DispatcherSession; storage: DispatcherStorage; projectID: string },
  deps: {
    store: Store
    log(m: string): void
    onWrite(fn: () => void): void
    /** 仅测试注入：写事件后的评估节流（默认 2000ms） */
    evaluateMs?: number
    /** 仅测试注入：派发后检查领取结果的延迟（默认 60s） */
    claimCheckMs?: number
    /** 仅测试注入：失败退避基数（默认 60s） */
    backoffBaseMs?: number
    /** 仅测试注入：最小派发间隔（默认 10s） */
    minIntervalMs?: number
  },
): { notifyWrite(): void; dispose(): void; status(): DispatcherStatus } {
  const SESSION_KEY = `${ctx.projectID}/settings/dispatcher-session`
  const claimCheckMs = deps.claimCheckMs ?? 60_000
  const evaluateMs = deps.evaluateMs ?? 2000

  let cooldownUntil = 0
  let failStreak = 0
  let lastDispatchAt = 0
  let paused = false
  let lastEnabled = false
  let todayKey = ""
  let todayCount = 0
  let workerID: string | null = null
  let evaluateTimer: ReturnType<typeof setTimeout> | null = null
  let claimTimer: ReturnType<typeof setTimeout> | null = null
  let evaluating = false
  let lastSkipReason = ""

  const dailyKey = () => `${ctx.projectID}/dispatcher/${todayKey}`
  const loadDailyCount = async (): Promise<void> => {
    todayCount = Number(await ctx.storage.get(dailyKey())) || 0
  }

  async function ensureWorker(): Promise<string> {
    if (workerID) return workerID
    const saved = (await ctx.storage.get(SESSION_KEY)) as string | undefined
    if (saved) {
      try {
        await ctx.session.get({ sessionID: saved })
        workerID = saved
        return workerID
      } catch {
        deps.log(`持久 worker 会话 ${saved} 已失效，重建`)
      }
    }
    const info = await ctx.session.create({ title: "Taskboard 自动派发" })
    workerID = info.id
    await ctx.storage.set(SESSION_KEY, info.id)
    deps.log(`创建 worker 会话 ${info.id}`)
    return workerID
  }

  async function dispatch(): Promise<void> {
    const id = await ensureWorker()
    await ctx.session.prompt({ sessionID: id, text: buildDispatchPrompt() })
    lastDispatchAt = Date.now()
    todayCount++
    await ctx.storage.set(dailyKey(), todayCount)
    deps.log(`派发 → worker=${id}（当日第 ${todayCount} 次）`)
    if (claimTimer) clearTimeout(claimTimer)
    claimTimer = setTimeout(() => void checkClaim().catch((e) => deps.log(`领取检查失败：${e.message}`)), claimCheckMs)
  }

  async function checkClaim(): Promise<void> {
    const tasks = await deps.store.list()
    const claimed = workerID ? tasks.some((t) => t.claim?.sessionID === workerID) : false
    if (claimed) {
      if (failStreak > 0) deps.log("worker 已领取任务，失败计数清零")
      failStreak = 0
      cooldownUntil = 0
      return
    }
    failStreak++
    const ms = nextBackoffMs(failStreak, deps.backoffBaseMs ?? DISPATCH_CAPS.backoffBaseMs)
    cooldownUntil = Date.now() + ms
    deps.log(`派发后未见领取（第 ${failStreak} 连败），冷却 ${Math.round(ms / 1000)}s`)
    if (failStreak >= DISPATCH_CAPS.failPause) {
      paused = true
      deps.log(`连续失败 ${failStreak} 次，自动派发已暂停（在网页设置中关闭再开启可复位）`)
    }
  }

  async function runEvaluate(): Promise<void> {
    if (evaluating) return // 单飞：正在评估时跳过（后续写事件会再触发）
    evaluating = true
    try {
      const settings = await deps.store.getSettings()
      if (settings.autoDispatch && !lastEnabled && (paused || failStreak > 0)) {
        deps.log("自动领取重新开启，失败状态复位")
      }
      if (settings.autoDispatch && !lastEnabled) {
        paused = false
        failStreak = 0
        cooldownUntil = 0
      }
      lastEnabled = settings.autoDispatch

      const now = Date.now()
      const key = new Date().toISOString().slice(0, 10)
      if (key !== todayKey) {
        todayKey = key
        await loadDailyCount()
      }

      const tasks = await deps.store.list()
      const pendingCount = tasks.filter((t) => t.status === "pending").length
      const workerBusy = workerID ? tasks.some((t) => t.status !== "done" && t.claim?.sessionID === workerID) : false

      const v = shouldDispatch(
        {
          primary: true,
          enabled: settings.autoDispatch,
          paused,
          pendingCount,
          workerBusy,
          inCooldown: now < cooldownUntil,
          lastDispatchAgeMs: lastDispatchAt ? now - lastDispatchAt : null,
          todayCount,
        },
        { minIntervalMs: deps.minIntervalMs ?? DISPATCH_CAPS.minIntervalMs },
      )
      if (!v.ok) {
        // skip 原因变化才记日志，避免每次写广播刷屏
        if (v.reason !== lastSkipReason && v.reason !== "disabled" && v.reason !== "secondary") {
          deps.log(`派发跳过：${v.reason}`)
        }
        lastSkipReason = v.reason
        return
      }
      lastSkipReason = ""
      await dispatch()
    } finally {
      evaluating = false
    }
  }

  const notifyWrite = (): void => {
    if (evaluateTimer) clearTimeout(evaluateTimer)
    evaluateTimer = setTimeout(() => void runEvaluate().catch((e) => deps.log(`派发评估失败：${e.message}`)), evaluateMs)
  }
  deps.onWrite(notifyWrite)

  return {
    notifyWrite,
    dispose: () => {
      if (evaluateTimer) clearTimeout(evaluateTimer)
      if (claimTimer) clearTimeout(claimTimer)
    },
    status: () => ({
      state: paused ? "paused" : Date.now() < cooldownUntil ? "cooldown" : "idle",
      failStreak,
      todayCount,
      cooldownRemainMs: Math.max(0, cooldownUntil - Date.now()),
    }),
  }
}
