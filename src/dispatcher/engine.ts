/**
 * 沿驱动引擎:全部模块的装配点(initDispatcher 的实现)。
 *
 * 主循环(trigger.evaluate,每轮至多派发一个任务,由 trigger 排空续接):
 *   设置复位 → 日计数 → list → 终结消耗 → 沿 diff(实时语义的兜底点)
 *   → metrics/advance 逐沿消费 → sweep 收敛兜底 → 派发决策(守卫链)
 *
 * 写事件路径:server 载荷 tasks 到达 → processAlong 实时做(沿 diff/唤醒不防抖)
 * → requestExternal 走防抖做派发评估;载荷缺省(任务 8 之前的接线缝隙)则只评估,
 * 沿处理留给 evaluate 兜底。
 *
 * 状态分层(账本 Task 4/6 裁决):退避/连败的真源在本引擎(maps.taskBackoff + 全局
 * 观测计数),pool 只管时序,round 真源在 task.round(store 写路径维护);
 * along-state blob 持久化(lastSeen/lastActedSeq/taskBackoff/seqCounter)。
 */

import type { Store } from "../store"
import { StoreError } from "../types"
import type { Task } from "../types"
import { makeBuiltinRules, runAdvance } from "./advance"
import { createMetrics } from "./metrics"
import {
  countActive,
  DISPATCH_CAPS,
  nextBackoffMs,
  nextCreateFailBackoffMs,
  nextTimeoutBackoffMs,
  shouldDispatch,
  shouldPauseGlobal,
} from "./policy"
import { buildDispatchPrompt } from "./prompt"
import { createSessionPool } from "./session-pool"
import {
  extractTransitions,
  loadAlongState,
  markActed,
  serializeAlongState,
  shouldAct as alongShouldAct,
  toMaps,
  type AlongMaps,
} from "./state"
import { createTrigger } from "./trigger"
import type {
  DispatcherSession,
  DispatcherStorage,
  DispatcherStatus,
  GlobalPhase,
} from "./types"

const ALONG_KEY_SUFFIX = "/dispatcher/along-state"

export function initDispatcher(
  ctx: {
    session: DispatcherSession
    storage: DispatcherStorage
    projectID: string
    /** worker 会话的工作目录:必须显式传,否则回退到服务进程 cwd */
    directory: string
  },
  deps: {
    store: Store
    log(m: string): void
    onWrite(fn: (tasks?: Task[]) => void): void
    /** store 层写入(不经 HTTP 路由)广播到前端 SSE */
    broadcast?: () => Promise<void> | void
    /** 仅测试注入:写事件后的评估防抖(默认 500ms) */
    evaluateMs?: number
    /** 仅测试注入:派发后等待领取的时限(默认 180s) */
    claimWaitMs?: number
    /** 仅测试注入:失败退避基数(默认 60s) */
    backoffBaseMs?: number
    /** 仅测试注入:最小派发间隔(默认 500ms) */
    minIntervalMs?: number
    /** 仅测试注入:消耗刷新间隔(默认 120s;传极大值可关闭) */
    usagePollMs?: number
    /** 仅测试注入:兜底评估周期(默认 30s;传 0 关闭兜底定时器) */
    evaluateTickMs?: number
  },
): { notifyWrite(): void; dispose(): void; status(): DispatcherStatus } {
  const claimWaitMs = deps.claimWaitMs ?? DISPATCH_CAPS.claimWaitMs
  const usagePollMs = deps.usagePollMs ?? DISPATCH_CAPS.usagePollMs
  const backoffBaseMs = deps.backoffBaseMs ?? DISPATCH_CAPS.backoffBaseMs

  /* ---- 沿状态:装载(签名保持同步;evaluate/沿处理入口 await 装载完成,规格 §3.3 约束 2) ---- */
  const alongKey = `${ctx.projectID}${ALONG_KEY_SUFFIX}`
  let maps: AlongMaps = toMaps(loadAlongState(undefined))
  const loaded = (async () => {
    maps = toMaps(loadAlongState(await loadRaw(alongKey)))
  })()

  /* ---- 全局态(显式三态)与观测计数 ---- */
  let globalPhase: GlobalPhase = { kind: "running" }
  let failStreak = 0 // 全局:派发异常连败(观测 + 熔断依据)
  let timeoutStreak = 0 // 全局:超时观测口径(任务级退避在 maps.taskBackoff)
  let createFailStreak = 0 // 建会话失败独立计数(内存即可:瞬态故障,重启归零)
  let lastDispatchAt = 0
  let lastEnabled = false
  let workerSeq = 0
  let lastSkipReason = ""
  let todayKey = ""
  let todayCount = 0
  let disposed = false

  const dailyKey = () => `${ctx.projectID}/dispatcher/${todayKey}`

  async function loadRaw(key: string): Promise<unknown> {
    try {
      const raw = await ctx.storage.get(key)
      if (typeof raw === "string") return JSON.parse(raw)
      return raw
    } catch {
      return undefined
    }
  }

  /** 落盘(fire-and-forget;失败记账,下轮写事件重试) */
  const persist = (): void => {
    void ctx.storage
      .set(alongKey, serializeAlongState(maps))
      .catch((e) => deps.log(`沿状态落盘失败:${e instanceof Error ? e.message : String(e)}`))
  }

  /** 上次评估缓存的活跃槽位(status() 不做 IO) */
  let lastKnownActive = 0

  const inCooldown = (): boolean =>
    globalPhase.kind === "cooldown" && globalPhase.until > Date.now()
  const isPaused = (): boolean => globalPhase.kind === "paused"

  /* ---- 模块装配 ---- */
  const metrics = createMetrics({
    store: deps.store,
    session: ctx.session,
    broadcast: deps.broadcast,
    usagePollMs,
    log: deps.log,
  })

  const advanceCtx = {
    shouldAct: (t: TaskTransition) => alongShouldAct(maps.lastActedSeq, t),
    markActed: (t: TaskTransition) => markActed(maps.lastActedSeq, t),
    log: deps.log,
  }
  const rules: ReturnType<typeof makeBuiltinRules> = makeBuiltinRules({
    session: ctx.session,
    log: deps.log,
  })

  const loadDailyCount = async (): Promise<void> => {
    todayCount = Number(await ctx.storage.get(dailyKey())) || 0
  }

  const pool = createSessionPool({
    session: ctx.session,
    directory: ctx.directory,
    claimWaitMs,
    patchTask: async (id, patch) => {
      // 契约(账本 Task 4 裁决):仅当任务仍在 pending 时撤回;否则视为已被领取。
      // store.patch 的拖拽分支对任意流转合法,必须在此守卫,防超时删掉 worker 正用的会话。
      const cur = await deps.store.get(id)
      if (cur.status !== "pending") {
        throw new StoreError("invalid_transition", `任务状态为 ${cur.status},仅待领取任务可超时撤回`)
      }
      return deps.store.patch(id, patch)
    },
    onSettled: () => {
      timeoutStreak = 0 // 领取成功:全局超时观测归零(任务级 streak 不受影响)
      trigger.requestInternal("settled") // 名额回收,立即补评估
    },
    onTimeout: (taskID) => {
      const prev = maps.taskBackoff.get(taskID) ?? { timeoutStreak: 0, cooldownUntil: 0 }
      const streak = prev.timeoutStreak + 1
      const ms = nextTimeoutBackoffMs(streak, backoffBaseMs)
      maps.taskBackoff.set(taskID, { timeoutStreak: streak, cooldownUntil: Date.now() + ms })
      timeoutStreak++ // 全局观测口径
      const pause =
        streak >= DISPATCH_CAPS.timeoutPause ? ";超时连败达上限,延长冷却" : ""
      deps.log(
        `派发超时未见领取（该任务第 ${streak} 连败）task=${taskID}；任务冷却 ${Math.round(ms / 1000)}s${pause}`,
      )
      persist()
      trigger.requestInternal("timeout-released")
    },
    onCreateFail: () => {
      createFailStreak++
      const ms = nextCreateFailBackoffMs(createFailStreak, backoffBaseMs)
      globalPhase = { kind: "cooldown", until: Date.now() + ms, cause: "create-fail" }
      deps.log(
        `建会话失败(第 ${createFailStreak} 连败);独立冷却 ${Math.round(ms / 1000)}s(不置全局暂停)`,
      )
    },
    onTaskGone: (taskID) => {
      maps.lastSeen.delete(taskID)
      maps.lastActedSeq.delete(taskID)
      maps.rounds.delete(taskID)
      maps.taskBackoff.delete(taskID)
      persist()
      deps.log(`任务已删除,沿状态键已清理 task=${taskID}`)
    },
    log: deps.log,
  })

  const takeSeq = (): number => ++maps.seqCounter

  /** act 失败的沿:每轮 processAlong 重放,成功出队(审查 I-3:失败下轮自动重发) */
  let retryAlong: TaskTransition[] = []

  /** 沿处理(实时,不防抖):重放失败队列 → 沿 diff → metrics → advance */
  const processAlong = async (tasks: Task[]): Promise<void> => {
    await loaded
    // 1. 重放失败队列:任务已删除的沿直接弃;仍失败的留在队列
    if (retryAlong.length > 0) {
      const still: TaskTransition[] = []
      let acted = false
      for (const t of retryAlong) {
        const task = tasks.find((x) => x.id === t.taskID)
        if (!task) continue
        const outcome = await runAdvance(rules, t, task, advanceCtx)
        if (outcome === "failed") still.push(t)
        else acted = true // 水位推进(或已处理/无会话),出队
      }
      retryAlong = still
      if (acted) persist()
    }
    // 2. 新沿
    const along = extractTransitions(maps.lastSeen, tasks, takeSeq)
    if (along.length === 0) return
    for (const t of along) {
      const task = tasks.find((x) => x.id === t.taskID)
      if (!task) continue
      await metrics.applyTransition(t, task)
      // 沿到达即时结算:to ≠ pending 的沿意味着任务离开待领取,在途名额零延迟释放
      if (t.to !== "pending") pool.settleByTask(t.taskID)
      const outcome = await runAdvance(rules, t, task, advanceCtx)
      if (outcome === "failed") retryAlong.push(t)
    }
    persist()
  }

  const dispatchFrontier = async (task: Task): Promise<void> => {
    if (disposed) return // 排空循环卡在 await 期间卸载:不再新建会话(终审 M-3)
    const workerName = `w${++workerSeq}`
    const result = await pool.dispatch(task, workerName, buildDispatchPrompt(task))
    if (result === "ok") {
      lastDispatchAt = Date.now()
      todayCount++
      createFailStreak = 0 // 连败语义:成功即断链,孤立失败不吃历史翻倍退避(审查 M-5)
      await ctx.storage.set(dailyKey(), todayCount)
      deps.log(`派发完成（当日第 ${todayCount} 次）task=${task.id}`)
      trigger.requestInternal("dispatched")
      return
    }
    if (result === "prompt-fail") {
      // 派发异常是会话 API 层面的故障,全局退避
      failStreak++
      const ms = nextBackoffMs(failStreak, backoffBaseMs)
      globalPhase = { kind: "cooldown", until: Date.now() + ms, cause: "dispatch-fail" }
      deps.log(`派发失败（第 ${failStreak} 连败）；冷却 ${Math.round(ms / 1000)}s`)
      if (shouldPauseGlobal(failStreak)) {
        globalPhase = { kind: "paused", cause: `连续失败 ${failStreak} 次` }
        deps.log(`连续失败 ${failStreak} 次,自动派发已暂停(在网页设置中关闭再开启可复位)`)
      }
      return
    }
    // create-fail:pool 已通知 onCreateFail(独立退避),这里不重复计败
  }

  const evaluate = async (): Promise<void> => {
    await loaded
    // 设置复位:关开 autoDispatch 清全部失败状态并落盘
    const settings = await deps.store.getSettings()
    if (settings.autoDispatch && !lastEnabled) {
      if (isPaused() || failStreak > 0 || timeoutStreak > 0 || maps.taskBackoff.size > 0) {
        deps.log("自动领取重新开启,失败状态复位")
      }
      globalPhase = { kind: "running" }
      failStreak = 0
      timeoutStreak = 0
      createFailStreak = 0
      maps.taskBackoff.clear()
      lastSkipReason = ""
      persist()
    }
    lastEnabled = settings.autoDispatch

    // 日计数翻转
    const now = Date.now()
    const key = new Date().toISOString().slice(0, 10)
    if (key !== todayKey) {
      todayKey = key
      await loadDailyCount()
    }

    const tasks = await deps.store.list()

    // 差集清理:沿状态里已不在看板上的任务 = 已删除(审查 I-2:非在途任务删除
    // 不经 pool 的 onTaskGone,必须在此兜底,否则 blob 随历史任务单调膨胀)
    const liveIDs = new Set(tasks.map((t) => t.id))
    let goneAny = false
    for (const id of [...maps.lastSeen.keys()]) {
      if (!liveIDs.has(id)) {
        maps.lastSeen.delete(id)
        maps.lastActedSeq.delete(id)
        maps.rounds.delete(id)
        maps.taskBackoff.delete(id)
        goneAny = true
        deps.log(`任务已删除,沿状态键已清理 task=${id}`)
      }
    }
    if (goneAny) persist()

    // 终结任务补一次消耗:此刻读数才是完整的
    await metrics.flushTerminal(tasks)

    // 沿处理(写事件路径已实时做过一次;此处幂等兜底)
    await processAlong(tasks)

    // 收敛兜底:按任务快照核对在途条目(含拖拽盲区按 taskID 结算、任务删除清键)
    pool.sweep(tasks)

    // 派发决策:并发槽 = 状态计数(含 claim 为空的人工放行)+ 在途派发
    const inFlightIDs = pool.inFlightTaskIDs()
    const active = countActive(tasks) + pool.inFlightCount()
    lastKnownActive = active
    const pendingTotal = tasks.filter((t) => t.status === "pending").length
    const nowMs = Date.now()
    const pending = tasks
      .filter(
        (t) =>
          t.status === "pending" &&
          !inFlightIDs.has(t.id) &&
          (maps.taskBackoff.get(t.id)?.cooldownUntil ?? 0) <= nowMs,
      )
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))

    const v = shouldDispatch(
      {
        primary: true,
        enabled: settings.autoDispatch,
        paused: isPaused(),
        pendingCount: pending.length,
        activeCount: active,
        inCooldown: inCooldown(),
        lastDispatchAgeMs: lastDispatchAt ? nowMs - lastDispatchAt : null,
        todayCount,
      },
      { minIntervalMs: deps.minIntervalMs ?? DISPATCH_CAPS.minIntervalMs },
    )
    if (!v.ok) {
      if (v.reason !== lastSkipReason && v.reason !== "disabled") {
        const extra = v.reason === "concurrency-full" ? `，${pendingTotal} 个任务排队` : ""
        deps.log(`派发跳过：${v.reason}${extra}`)
      }
      lastSkipReason = v.reason
      return
    }
    lastSkipReason = ""
    // 一轮至多派发一个;还剩空槽由 dispatch 完成的 requestInternal 排空续接
    await dispatchFrontier(pending[0])
  }

  const trigger = createTrigger({
    evaluate,
    externalDebounceMs: deps.evaluateMs ?? DISPATCH_CAPS.evaluateMs,
    tickMs: deps.evaluateTickMs ?? DISPATCH_CAPS.evaluateTickMs,
    log: deps.log,
  })

  // 写事件:带载荷则沿处理实时做(唤醒不防抖),派发评估走防抖
  deps.onWrite((tasks?: Task[]) => {
    if (disposed) return
    if (tasks) {
      void processAlong(tasks).catch((e) =>
        deps.log(`沿处理失败:${e instanceof Error ? e.message : String(e)}`),
      )
    }
    trigger.requestExternal()
  })

  metrics.startPoll()

  return {
    notifyWrite: () => trigger.requestExternal(),
    dispose: () => {
      disposed = true
      trigger.dispose()
      pool.dispose()
      metrics.dispose()
    },
    status: () => {
      const now = Date.now()
      const remainMs =
        globalPhase.kind === "cooldown" ? Math.max(0, globalPhase.until - now) : 0
      const taskCooldowns: Record<string, number> = {}
      for (const [id, b] of maps.taskBackoff.entries()) {
        const remain = b.cooldownUntil - now
        if (remain > 0) taskCooldowns[id] = remain
      }
      return {
        state: !lastEnabled
          ? "disabled"
          : isPaused()
            ? "paused"
            : globalPhase.kind === "cooldown" && remainMs > 0
              ? "cooldown"
              : "idle",
        failStreak,
        todayCount,
        cooldownRemainMs: remainMs,
        activeCount: lastKnownActive,
        inFlight: pool.inFlightCount(),
        timeoutStreak,
        queuedCooldownCount: Object.values(taskCooldowns).length,
        lastSkipReason,
        taskCooldowns,
      }
    },
  }
}
