/**
 * 自动派发器的纯决策层：条件判定与失败退避。
 * 接线（会话管理、定时器、storage）见同文件 Task 4 的 initDispatcher。
 *
 * 会话模型：**一任务一会话**。派发时为任务新建专属会话，任务终结后不复用——
 * 长任务跑在同一会话里会持续累积上下文（实测复用会话 39 轮即耗 51 万 cache token），
 * 既拖慢响应又让后续任务被污染。
 */

import type { Claim, Status, Task } from "./types"

export const DISPATCH_CAPS = {
  /** 每日派发上限（硬熔断） */
  dailyCap: 100,
  /**
   * 两次派发之间的最小间隔（**全局节流**，不是每 worker 各自节流）。
   * 主要作用是错峰：填满 6 个槽位时每隔 0.5s 出一个会话，避免同时抢 API。
   * 取值要小：槽位释放后靠它保证不会同一瞬间打出一批会话，但也不能稀释填槽速度。
   */
  minIntervalMs: 500,
  /** 并发上限：同时被处理的阶段数（analyzing + executing）达到该值就不再派发 */
  maxConcurrent: 6,
  /** 派发后等待 worker 领取的时限；超时回收会话与名额（不熔断，见 timeoutPause） */
  claimWaitMs: 180_000,
  /** 活跃任务的消耗刷新间隔：长任务执行中也看得到 token 在涨 */
  usagePollMs: 120_000,
  /** 派发异常导致的全局熔断：连败达该值 → 暂停派发 */
  failPause: 3,
  /** 未领取超时：按 worker 独立计数，连败达该值 → 只冷却该 worker（不拖累全局） */
  timeoutPause: 3,
  /** 兜底评估周期：评估由写事件驱动，空闲（无写事件）时靠它自行恢复派发（冷却到期等） */
  evaluateTickMs: 30_000,
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
  /** 连续失败触发的暂停态（仅全局派发异常熔断会置位） */
  paused: boolean
  /** 待领取任务数 */
  pendingCount: number
  /** 当前正在被处理的阶段数（analyzing + executing），见 countActive */
  activeCount: number
  /** 当前处于失败冷却窗口 */
  inCooldown: boolean
  /** 距上次派发的毫秒数（从未派发过为 null） */
  lastDispatchAgeMs: number | null
  /** 当日已派发次数 */
  todayCount: number
}

/**
 * 并发计数：处于 analyzing / executing 的任务各占一个并发槽。
 *
 * 按状态计数而非按 claim 计数，因为 store 的 patch() 在 action: "confirm" 分支
 * 不走 applyDragClaim——而 CLAIM_STATES 只含 analyzing/executing，于是「人工拖到
 * analysis_confirm」会清空 claim，随后「用户点通过」把状态改成 executing，
 * 就产生 claim 为 undefined 的 executing 任务。按 claim 计数会漏掉它，
 * 实际并发会超出 maxConcurrent（超限 = 真并行失控）。
 */
export function countActive(tasks: { status: Status; claim?: Claim }[]): number {
  return tasks.filter((t) => t.status === "analyzing" || t.status === "executing").length
}

/**
 * 依次检查守卫；不满足返回首个原因，全过返回 ok。opts 供测试/接线注入时间常数覆盖。
 * 判定顺序：primary → enabled → paused → empty → concurrency-full → cooldown → interval → cap。
 * 并发维度用 concurrency-full 取代原「worker 是否忙」判定：多 worker 下只有槽位是硬约束，
 * 若继续按 worker 名下 claim 判忙，单 worker 名下一有未完成 claim 就会把并发锁死为 1。
 */
export function shouldDispatch(
  s: DispatchState,
  opts?: { minIntervalMs?: number; dailyCap?: number; maxConcurrent?: number },
): { ok: boolean; reason: string } {
  const minIntervalMs = opts?.minIntervalMs ?? DISPATCH_CAPS.minIntervalMs
  const dailyCap = opts?.dailyCap ?? DISPATCH_CAPS.dailyCap
  const maxConcurrent = opts?.maxConcurrent ?? DISPATCH_CAPS.maxConcurrent
  if (!s.primary) return { ok: false, reason: "secondary" }
  if (!s.enabled) return { ok: false, reason: "disabled" }
  if (s.paused) return { ok: false, reason: "paused" }
  if (s.pendingCount === 0) return { ok: false, reason: "empty" }
  if (s.activeCount >= maxConcurrent) return { ok: false, reason: "concurrency-full" }
  if (s.inCooldown) return { ok: false, reason: "cooldown" }
  if (s.lastDispatchAgeMs !== null && s.lastDispatchAgeMs < minIntervalMs) {
    return { ok: false, reason: "interval" }
  }
  if (s.todayCount >= dailyCap) return { ok: false, reason: "cap" }
  return { ok: true, reason: "" }
}

/**
 * 失败退避：baseMs 起指数翻倍，封顶 30 分钟；无失败为 0。
 * streak 泛指「任一连败计数」：全局派发异常 streak 或单 worker 未领取超时 streak 都走这条曲线。
 */
export function nextBackoffMs(streak: number, baseMs: number = DISPATCH_CAPS.backoffBaseMs): number {
  if (streak <= 0) return 0
  return Math.min(baseMs * 2 ** (streak - 1), DISPATCH_CAPS.backoffCapMs)
}

/**
 * 未领取超时的退避（语义更清楚的名字）：曲线与 nextBackoffMs 完全一致，
 * 但入参 timeoutStreak 是**按 worker 独立**的连败数，与全局派发异常 streak 互不影响。
 */
export function nextTimeoutBackoffMs(timeoutStreak: number, baseMs?: number): number {
  return nextBackoffMs(timeoutStreak, baseMs)
}

/**
 * 全局熔断判定：只有**派发异常**（会话 API 抛错等）连败达 failPause 才暂停全局派发。
 * 单 worker 的未领取超时不得走这里——一个慢 worker 超时不影响其他 worker，也不该把整个派发器停掉。
 */
export function shouldPauseGlobal(failStreak: number): boolean {
  return failStreak >= DISPATCH_CAPS.failPause
}

/**
 * 单 worker 熔断判定：未领取超时连败达 timeoutPause → 只冷却该 worker。
 * 明确边界：不置全局 paused，不影响其他 worker 的派发。
 */
export function shouldPauseWorker(timeoutStreak: number): boolean {
  return timeoutStreak >= DISPATCH_CAPS.timeoutPause
}

/* ============ 接线层 ============ */

import { StoreError } from "./types"
import type { Store } from "./store"

/** 会话的消耗读数：只取 token，不取金额（成本随模型/订阅变动，token 才是可比口径） */
export interface SessionTokens {
  input?: number
  output?: number
  reasoning?: number
  cache?: { read?: number; write?: number }
}

/** ctx.session 的结构化子集（避免绑定具体 SDK 类型） */
export interface DispatcherSession {
  create(input?: { title?: string; location?: { directory: string } }): Promise<{ id: string }>
  get(input: { sessionID: string }): Promise<unknown>
  prompt(input: { sessionID: string; text: string }): Promise<unknown>
  interrupt?(input: { sessionID: string }): Promise<unknown>
  remove?(input: { sessionID: string }): Promise<unknown>
}

/** ctx.storage 的结构化子集 */
export interface DispatcherStorage {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
}

export type DispatcherStatus = {
  /** disabled=设置未开启；其余仅在开启时出现 */
  state: "disabled" | "idle" | "cooldown" | "paused"
  failStreak: number
  todayCount: number
  cooldownRemainMs: number
  /** 当前占用的并发槽（已认领 + 在途派发） */
  activeCount: number
  /** 已派出但尚未被领取的会话数 */
  inFlight: number
  /** 单 worker 未领取超时的连败数（不触发全局暂停） */
  timeoutStreak: number
}

/**
 * 从会话信息里抽 token 读数；结构不认得时返回 null（宁可没有统计，也不要写入假数据）。
 */
export function readTokens(info: unknown): SessionTokens | null {
  const t = (info as { tokens?: unknown } | null)?.tokens
  if (!t || typeof t !== "object") return null
  const cache = (t as { cache?: unknown }).cache
  return {
    input: Number((t as { input?: unknown }).input) || 0,
    output: Number((t as { output?: unknown }).output) || 0,
    reasoning: Number((t as { reasoning?: unknown }).reasoning) || 0,
    cache: {
      read: Number((cache as { read?: unknown } | undefined)?.read) || 0,
      write: Number((cache as { write?: unknown } | undefined)?.write) || 0,
    },
  }
}

/**
 * 派发提示词：指定唯一任务，让 worker 按任务本身的需要选择工作流。
 * 历史版本曾用「不要加载或执行任何 skill / 不要创建计划文件或工作区」压制流程，
 * 为的是秒级领取小任务；代价是复杂任务被强行走最短路径。
 * 现在放开，并把 taskID 写死进提示词：并发场景下 worker 不再自己去「找一个待领取任务」，
 * 避免多个 worker 抢同一批任务、以及 pending 少于并发数时出现无任务可领的空派。
 */
export function buildDispatchPrompt(task: { id: string; title: string }): string {
  return [
    `【自动派发】这是看板插件的后台自动任务，本次只处理这一个任务：`,
    `  任务 ID：${task.id}`,
    `  任务标题：${task.title}`,
    "",
    "领取前请先读任务描述，如实评估它的复杂度与真实工作量，再动手：任务可能是简单修改，也可能是需要完整设计、实现与验证的复杂工作，请按任务本身的需要自行选择合适的工作流与做法，不要预设流程。",
    "",
    `第 1 步（立即执行）：调用 taskboard_claim 领取任务 ${task.id}（工具在代码工具目录 tools.taskboard.claim，找不到就在工具目录搜 taskboard）。`,
    "第 2 步：用 taskboard_analyze 提交分析与实施计划（复杂任务要把方案讲清楚，简单任务不必过度工程化）；若看板要求分析确认，领取返回的提示会说明，此时停下等待放行，不要继续。",
    "第 3 步：按计划完成任务。怎么做由你按任务本身的需要判断：需要设计、需要拆步骤、需要更多验证，或反之直接改完，都由你决定。",
    "第 4 步：用 taskboard_complete 提交完成结果，任务进入完成确认。",
    "",
    "完成提交后立即停止。若领取失败（invalid_transition 等），等待即可，不要重试。",
  ].join("\n")
}

export function initDispatcher(
  ctx: {
    session: DispatcherSession
    storage: DispatcherStorage
    projectID: string
    /** worker 会话的工作目录：必须显式传，否则回退到服务进程 cwd（实测曾落到 .debug/playground） */
    directory: string
  },
  deps: {
    store: Store
    log(m: string): void
    onWrite(fn: () => void): void
    /**
     * 把 store 层写入广播到前端 SSE。recordUsage 不经 HTTP 路由层，
     * 没有这条通道消耗统计推不到看板上。
     */
    broadcast?: () => Promise<void> | void
    /** 仅测试注入：写事件后的评估节流（默认 2000ms） */
    evaluateMs?: number
    /** 仅测试注入：派发后等待领取的时限（默认 180s） */
    claimWaitMs?: number
    /** 仅测试注入：失败退避基数（默认 60s） */
    backoffBaseMs?: number
    /** 仅测试注入：最小派发间隔（默认 2s） */
    minIntervalMs?: number
    /** 仅测试注入：消耗刷新间隔（默认 120s；测试里传极大值可关闭） */
    usagePollMs?: number
    /** 仅测试注入：兜底评估周期（默认 30s；传 0 关闭兜底定时器） */
    evaluateTickMs?: number
  },
): { notifyWrite(): void; dispose(): void; status(): DispatcherStatus } {
  const claimWaitMs = deps.claimWaitMs ?? DISPATCH_CAPS.claimWaitMs
  const usagePollMs = deps.usagePollMs ?? DISPATCH_CAPS.usagePollMs
  const evaluateMs = deps.evaluateMs ?? 2000
  const evaluateTickMs = deps.evaluateTickMs ?? DISPATCH_CAPS.evaluateTickMs

  let cooldownUntil = 0
  let failStreak = 0 // 全局：派发异常连败（会话 API 故障这类问题）
  let timeoutStreak = 0 // 全局：未领取超时连败（慢 worker 导致，不置 paused）
  let lastDispatchAt = 0
  let paused = false
  let lastEnabled = false
  let workerSeq = 0
  /**
   * 在途派发：sessionID → 任务。按 sessionID 建 Map 而非单个 boolean——
   * 多 worker 下「A 的回合还在跑」不能拦住「派 B」。
   */
  const awaitingClaims = new Map<string, { taskID: string; timer: ReturnType<typeof setTimeout> }>()
  const nudgedTaskIDs = new Set<string>() // 已发送「继续执行」提示的任务（防重复 nudge）
  const confirmSeen = new Set<string>() // 曾观察到停在 analysis_confirm 的任务——nudge 仅补这一缺口
  let todayKey = ""
  let todayCount = 0
  let activeCount = 0
  let evaluateTimer: ReturnType<typeof setTimeout> | null = null
  let tickTimer: ReturnType<typeof setInterval> | null = null
  let usageTimer: ReturnType<typeof setInterval> | null = null
  let evaluating = false
  let lastSkipReason = ""

  const dailyKey = () => `${ctx.projectID}/dispatcher/${todayKey}`

  /**
   * 记录一条消耗统计并广播。看板端读同一个 task 快照，故广播即可，无需 HTTP 路由。
   */
  const recordUsage = async (taskID: string, sessionID: string): Promise<void> => {
    const info = await ctx.session.get({ sessionID })
    const t = readTokens(info)
    if (!t) return
    await deps.store.recordUsage({
      id: taskID,
      usage: {
        input: t.input ?? 0,
        output: t.output ?? 0,
        reasoning: t.reasoning ?? 0,
        cacheRead: t.cache?.read ?? 0,
        cacheWrite: t.cache?.write ?? 0,
        at: Date.now(),
      },
    })
    await deps.broadcast?.()
  }

  /**
   * 任务终结（完成确认 / 已完成）时补一次消耗：此刻读数才是完整的，
   * 不必等下一个轮询周期。同时清理该任务的 nudge 记录，防止 id 复用串味。
   */
  const flushUsage = async (tasks: Task[]): Promise<void> => {
    for (const t of tasks) {
      if (t.status !== "completion_confirm" && t.status !== "done") continue
      const sessionID = t.claim?.sessionID
      if (!sessionID) continue
      nudgedTaskIDs.delete(t.id)
      confirmSeen.delete(t.id)
      try {
        await recordUsage(t.id, sessionID)
      } catch (e) {
        deps.log(`消耗统计失败 task=${t.id}：${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  /** 定时刷新活跃任务的消耗，让长任务执行中也能看到 token 在涨 */
  const pollUsage = async (): Promise<void> => {
    if (usagePollMs <= 0) return
    let tasks: Task[]
    try {
      tasks = await deps.store.list()
    } catch {
      return // 读失败下轮重试
    }
    for (const t of tasks) {
      if (t.status !== "analyzing" && t.status !== "executing") continue
      const sessionID = t.claim?.sessionID
      if (!sessionID) continue // 人工拖入执行的任务没有会话，无从统计
      try {
        await recordUsage(t.id, sessionID)
      } catch (e) {
        deps.log(`消耗刷新失败 task=${t.id}：${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  const loadDailyCount = async (): Promise<void> => {
    todayCount = Number(await ctx.storage.get(dailyKey())) || 0
  }

  /** 为任务新建专属会话。必须传 location.directory，否则回退到服务进程 cwd。 */
  const createSessionForTask = async (task: { id: string; title: string }): Promise<string> => {
    const info = await ctx.session.create({ title: `看板：${task.title}`, location: { directory: ctx.directory } })
    return info.id
  }

  /** 回收会话：派发失败、任务已完成等不再需要它的场景。删会话是破坏性操作，需用户授权后由外部统一清理。 */
  const dropSession = async (sessionID: string, why: string): Promise<void> => {
    if (!ctx.session.remove) return
    try {
      await ctx.session.remove({ sessionID })
      deps.log(`回收会话 ${sessionID.slice(0, 8)}（${why}）`)
    } catch {
      // 会话可能已被清理，忽略
    }
  }

  const nextWorkerName = (): string => `w${++workerSeq}`

  /** 任务级未领取超时退避：只锁该任务，不卡整个队列（全局冷却仅留给派发异常） */
  const taskCooldown = new Map<string, number>()

  /**
   * 零延迟补评估：槽位变化（派出/退回/释放）后立即重估，不等写事件防抖与兜底 tick。
   * 与 notifyWrite（外部写事件、2s 防抖）职责分离；评估中则跳过（在途流程结束时会再触发）。
   */
  const scheduleEvaluate = (): void => {
    if (evaluating) return
    void runEvaluate().catch((e) => deps.log(`派发评估失败：${e.message}`))
  }

  /**
   * 派发超时回收（未领取）：先撤任务再回收会话，顺序不能反。
   * 反了会留下「任务已被别人领走、会话却被删掉」的永久孤儿。
   */
  const releaseStalled = async (sessionID: string, taskID: string): Promise<void> => {
    try {
      let reclaimed = false
      try {
        await deps.store.patch(taskID, { status: "pending" })
        reclaimed = true
      } catch (e) {
        if (e instanceof StoreError && e.code === "invalid_transition") {
          // worker 抢先领取（状态已不是 pending）：会话仍在用，不能动
          timeoutStreak = 0
          deps.log(`派发超时但任务已被领取，保留会话 ${sessionID.slice(0, 8)} task=${taskID}`)
          return
        }
        if (e instanceof StoreError && e.code === "not_found") {
          // 任务已被用户删除：不是 worker 的失败，只回收会话，不计连败不设冷却
          deps.log(`派发超时但任务已删除 task=${taskID}，回收会话`)
          await dropSession(sessionID, "任务已删除")
          return
        }
        deps.log(`超时回收撤任务失败 task=${taskID}：${e instanceof Error ? e.message : String(e)}`)
      }
      if (reclaimed) {
        timeoutStreak++
        const ms = nextTimeoutBackoffMs(timeoutStreak, deps.backoffBaseMs ?? DISPATCH_CAPS.backoffBaseMs)
        taskCooldown.set(taskID, Date.now() + ms)
        const pause = shouldPauseWorker(timeoutStreak) ? `；超时连败达上限，延长冷却` : ""
        deps.log(
          `派发超时未见领取（第 ${timeoutStreak} 连败），任务已退回待领取 task=${taskID}；该任务冷却 ${Math.round(ms / 1000)}s${pause}`,
        )
        await dropSession(sessionID, "超时未领取")
        scheduleEvaluate() // 名额已释放：立即补评估，其余待领取任务不必等下一个事件
      }
    } finally {
      // 两分支都必须摘掉在途记录：漏删会让 inFlightTaskIDs 永久包含该任务，
      // 退回的任务被无限剔除候选 → 名额泄漏 + 永不重派
      const entry = awaitingClaims.get(sessionID)
      if (entry) clearTimeout(entry.timer)
      awaitingClaims.delete(sessionID)
    }
  }

  async function dispatch(task: Task, workerName: string): Promise<void> {
    let sessionID: string
    try {
      sessionID = await createSessionForTask(task)
    } catch (e) {
      // 建会话失败：任务没被派出去，不计名额也不熔断，等下一轮评估重试
      deps.log(`创建会话失败 task=${task.id}：${e instanceof Error ? e.message : String(e)}`)
      return
    }

    const entry = {
      taskID: task.id,
      sentAt: Date.now(), // 用于观测「派发→领取」耗时（放开 prompt 前实测基线 82s）
      timer: setTimeout(() => {
        void releaseStalled(sessionID, task.id).catch((e) => deps.log(`超时回收失败：${e.message}`))
      }, claimWaitMs),
    }
    awaitingClaims.set(sessionID, entry)
    activeCount++ // 在途派发也占并发槽，否则 6 个同时派出会超额

    try {
      await ctx.session.prompt({ sessionID, text: buildDispatchPrompt(task) })
    } catch (e) {
      // 派发异常是会话 API 层面的故障，全局退避
      clearTimeout(entry.timer)
      awaitingClaims.delete(sessionID)
      activeCount--
      failStreak++
      const ms = nextBackoffMs(failStreak, deps.backoffBaseMs ?? DISPATCH_CAPS.backoffBaseMs)
      cooldownUntil = Date.now() + ms
      deps.log(`派发失败（第 ${failStreak} 连败）：${e instanceof Error ? e.message : String(e)}；冷却 ${Math.round(ms / 1000)}s`)
      if (shouldPauseGlobal(failStreak)) {
        paused = true
        deps.log(`连续失败 ${failStreak} 次，自动派发已暂停（在网页设置中关闭再开启可复位）`)
      }
      await dropSession(sessionID, "派发失败")
      return
    }

    lastDispatchAt = Date.now()
    todayCount++
    await ctx.storage.set(dailyKey(), todayCount)
    deps.log(
      `派发 → ${workerName}=${sessionID.slice(0, 8)} task=${task.id}「${task.title}」（当日第 ${todayCount} 次）`,
    )
    scheduleEvaluate() // 还剩空槽时立即继续填，不等写事件与兜底 tick
  }

  async function runEvaluate(): Promise<void> {
    if (evaluating) return // 单飞：正在评估时跳过（后续写事件会再触发）
    evaluating = true
    try {
      const settings = await deps.store.getSettings()
      if (settings.autoDispatch && !lastEnabled && (paused || failStreak > 0 || timeoutStreak > 0)) {
        deps.log("自动领取重新开启，失败状态复位")
      }
      if (settings.autoDispatch && !lastEnabled) {
        paused = false
        failStreak = 0
        timeoutStreak = 0
        cooldownUntil = 0
        taskCooldown.clear() // 任务级退避一并复位，否则关开一次会让任务白等一个窗口
      }
      lastEnabled = settings.autoDispatch

      const now = Date.now()
      const key = new Date().toISOString().slice(0, 10)
      if (key !== todayKey) {
        todayKey = key
        await loadDailyCount()
      }

      const tasks = await deps.store.list()

      // 终结任务补一次消耗：此刻读数才是完整的（不依赖轮询周期）
      await flushUsage(tasks)

      // 收敛在途派发：已领取或已不是 pending 的条目即时回收名额。
      // 计时器交给超时流程处理，这里只清槽位，避免名额泄漏。
      let settled = false
      for (const [sessionID, entry] of awaitingClaims) {
        const t = tasks.find((x) => x.id === entry.taskID)
        if (t && t.claim?.sessionID === sessionID) {
          clearTimeout(entry.timer)
          awaitingClaims.delete(sessionID)
          timeoutStreak = 0
          settled = true
          // 观测口径：派发 prompt 到 worker 真正领取的间隔（放开工作流前实测基线约 82s）
          deps.log(`已领取 task=${entry.taskID}（派发→领取 ${Math.round((now - entry.sentAt) / 1000)}s）`)
        }
      }
      // 领取意味着该任务已占用一个真实槽位（analyzing/executing），净槽位未必释放；
      // 这里只在确有槽位空出时补评估，由后续判定条件把关，重复评估代价可忽略
      if (settled) scheduleEvaluate()

      // 并发槽位：analyzing + executing 各占一格（按状态计数，含 claim 为空的人工放行任务）
      // + 在途派发数（已派出还没领取的同样占槽，否则 6 个同时派出会超额）
      const active = countActive(tasks) + awaitingClaims.size
      // 在途派发的任务状态仍是 pending（worker 还没领），必须从候选里剔除，
      // 否则下一轮评估会把同一个任务再派一遍 —— 6 个并发会全部砸向同一个任务
      const inFlightTaskIDs = new Set([...awaitingClaims.values()].map((e) => e.taskID))
      const pendingTotal = tasks.filter((t) => t.status === "pending").length // 含在途派发与冷却中，仅供日志
      const pending = tasks
        // 在任务冷却窗口内的先跳过：它刚超时退回，等窗口过了再派，避免立刻重复踩同一个坑
        .filter((t) => t.status === "pending" && !inFlightTaskIDs.has(t.id) && (taskCooldown.get(t.id) ?? 0) <= now)
        .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
      const pendingCount = pending.length
      activeCount = active

      // 记录「曾停在分析确认」的任务：执行唤醒只补这个缺口
      for (const t of tasks) {
        if (t.status === "analysis_confirm" && t.claim?.sessionID) confirmSeen.add(t.id)
      }

      // 执行唤醒：曾停在分析确认、现已放行 executing 且未 nudge 过 → 提示继续。
      // 目标会话从 claim.sessionID 取，不再依赖固定 workerID（一任务一会话后没有固定 worker）
      const executing = tasks.filter(
        (t) => t.status === "executing" && t.claim?.sessionID && confirmSeen.has(t.id) && !nudgedTaskIDs.has(t.id),
      )
      if (executing.length > 0) {
        const t = executing[0]
        const sessionID = t.claim!.sessionID!
        try {
          await ctx.session.prompt({
            sessionID,
            text: `看板任务「${t.title}」已放行进入执行。请继续完成它并用 taskboard_complete 提交；完成后停止。`,
          })
          nudgedTaskIDs.add(t.id) // prompt 成功才记，失败下轮重试
          deps.log(`执行唤醒 → session=${sessionID.slice(0, 8)} task=${t.id}`)
        } catch (e) {
          deps.log(`执行唤醒失败：${e instanceof Error ? e.message : String(e)}`)
        }
      }

      const v = shouldDispatch(
        {
          primary: true,
          enabled: settings.autoDispatch,
          paused,
          pendingCount,
          activeCount: active,
          inCooldown: now < cooldownUntil,
          lastDispatchAgeMs: lastDispatchAt ? now - lastDispatchAt : null,
          todayCount,
        },
        { minIntervalMs: deps.minIntervalMs ?? DISPATCH_CAPS.minIntervalMs },
      )
      if (!v.ok) {
        if (v.reason !== lastSkipReason && v.reason !== "disabled" && v.reason !== "secondary") {
          // 并发满员额外报排队数：任务静静停在「待领取」时，这是用户唯一能分辨
          // 「在排队」与「派发出故障」的信号
          const extra = v.reason === "concurrency-full" ? `，${pendingTotal} 个任务排队` : ""
          deps.log(`派发跳过：${v.reason}${extra}`)
        }
        lastSkipReason = v.reason
        return
      }
      lastSkipReason = ""
      // 预分配最旧的待领取任务，把 id 写进 prompt：并发下不再靠 worker 自己去抢
      await dispatch(pending[0], nextWorkerName())
    } finally {
      evaluating = false
    }
  }

  const notifyWrite = (): void => {
    if (evaluateTimer) clearTimeout(evaluateTimer)
    evaluateTimer = setTimeout(() => void runEvaluate().catch((e) => deps.log(`派发评估失败：${e.message}`)), evaluateMs)
  }
  deps.onWrite(notifyWrite)

  // 消耗刷新定时器：长任务执行中也看得到 token 在涨
  if (usagePollMs > 0) {
    usageTimer = setInterval(() => void pollUsage(), usagePollMs)
  }

  // 兜底评估：评估主链路由写事件驱动，空闲（无写事件）时冷却到期/任务回池无人触发，
  // 靠这个周期性 tick 自行恢复（runEvaluate 内部有全部 gate，空转开销可忽略）
  if (evaluateTickMs > 0) {
    tickTimer = setInterval(() => void runEvaluate().catch((e) => deps.log(`派发评估失败：${e.message}`)), evaluateTickMs)
  }

  return {
    notifyWrite,
    dispose: () => {
      if (evaluateTimer) clearTimeout(evaluateTimer)
      if (tickTimer) clearInterval(tickTimer)
      if (usageTimer) clearInterval(usageTimer)
      for (const entry of awaitingClaims.values()) clearTimeout(entry.timer)
      awaitingClaims.clear()
    },
    status: () => ({
      state: !lastEnabled ? "disabled" : paused ? "paused" : Date.now() < cooldownUntil ? "cooldown" : "idle",
      failStreak,
      todayCount,
      cooldownRemainMs: Math.max(0, cooldownUntil - Date.now()),
      activeCount,
      inFlight: awaitingClaims.size,
      timeoutStreak,
      /** 处于任务级未领取退避窗口内的任务数（这些任务暂不参与派发） */
      queuedCooldownCount: [...taskCooldown.values()].filter((v) => v > Date.now()).length,
    }),
  }
}
