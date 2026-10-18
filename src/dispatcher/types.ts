/**
 * 派发器模块的全部契约(纯类型,零实现,被所有子模块依赖)。
 * 模块间不横向 import 实现,只依赖本文件 —— 依赖方向见模块头注。
 */

import type { Status, Task } from "../types"

/* ============ 转移沿 ============ */

/**
 * 任务状态转移沿:沿驱动架构的原子事件单位。
 * `seq` 全局严格递增(持久化计数器),幂等消费的依据 —— 每条沿至多 act 一次,
 * act 失败不推进 lastActedSeq,下轮评估自动重发。
 */
export interface TaskTransition {
  taskID: string
  from: Status
  to: Status
  seq: number
}

/* ============ 分段计时 ============ */

// SpanRecord 的真源在 src/types.ts(Task.spanLog 字段需要它,避免 store→dispatcher 反向依赖)
export type { SpanRecord } from "../types"

/* ============ 状态机 ============ */

/** 全局派发态:显式三态,取代散落的 paused/cooldownUntil 布尔组合 */
export type GlobalPhase =
  | { kind: "running" }
  | { kind: "cooldown"; until: number; cause: "dispatch-fail" | "create-fail" }
  | { kind: "paused"; cause: string }

/** 任务级退避:超时连败与冷却窗口真正按任务隔离(A 的连败不再抬高 B 的退避) */
export interface TaskBackoff {
  timeoutStreak: number
  cooldownUntil: number
}

/** 沿驱动状态(blob 持久化于 `${projectID}/dispatcher/along-state`) */
export interface AlongState {
  lastSeen: Record<string, Status>
  lastActedSeq: Record<string, number>
  rounds: Record<string, number>
  taskBackoff: Record<string, TaskBackoff>
  /** 沿 seq 计数器:重启后从 max+1 续接,防新沿被误判已处理 */
  seqCounter: number
}

/* ============ 派发守卫链 ============ */

/** 派发决策入参(沿用旧 DispatchState 结构,旧测试矩阵兼容) */
export interface DispatchState {
  /** 是否主实例(唯一派发者) */
  primary: boolean
  /** 设置 autoDispatch 已开启 */
  enabled: boolean
  /** 连续派发异常触发的暂停态 */
  paused: boolean
  /** 待领取任务数(已剔除在途与冷却中) */
  pendingCount: number
  /** 当前占用并发槽的阶段数(analyzing + executing,含在途派发) */
  activeCount: number
  /** 当前处于全局失败冷却窗口 */
  inCooldown: boolean
  /** 距上次派发的毫秒数(从未派发过为 null) */
  lastDispatchAgeMs: number | null
}

/** 派发决策上下文 = 旧 DispatchState(别名保留,旧矩阵兼容) */
export type DispatchContext = DispatchState

export type GuardName =
  | "secondary"
  | "disabled"
  | "paused"
  | "empty"
  | "concurrency-full"
  | "cooldown"
  | "interval"

/** 派发守卫:返回拒绝原因字符串,或 null 放行。链序即判定优先级。 */
export interface Guard {
  name: GuardName
  check(
    ctx: DispatchContext,
    caps: { minIntervalMs: number; maxConcurrent: number },
  ): string | null
}

/* ============ 可替换策略(架构冗余点) ============ */

/** 候选选择器:现实现「最旧优先」;未来优先级/依赖排序/标签路由换实现即可 */
export interface CandidateSelector {
  select(pending: Task[], ctx: { now: number }): Task | null
}

/** 推进规则:沿驱动的唤醒动作。匹配 on 即 act;幂等由调用方(lastActedSeq)保证 */
export interface AdvanceRule {
  name: string
  on: { from?: Status | "*"; to: Status }
  act: (task: Task, log: (m: string) => void) => Promise<void>
}

/* ============ 会话与存储的结构化子集(避免绑定具体 SDK 类型) ============ */

/** 会话的消耗读数:只取 token,不取金额(成本随模型/订阅变动,token 才是可比口径) */
export interface SessionTokens {
  input?: number
  output?: number
  reasoning?: number
  cache?: { read?: number; write?: number }
}

export interface DispatcherSession {
  create(input?: {
    title?: string
    location?: { directory: string }
    model?: { providerID: string; id: string }
  }): Promise<{ id: string }>
  get(input: { sessionID: string }): Promise<unknown>
  /**
   * 触发一个会话回合。
   * ⚠️ 实现契约:必须在回合触发后立即返回,不得等待回合结束 ——
   * 否则评估排空循环(trigger.ts)会在单个 prompt 上长时间阻塞,填槽与唤醒全部停摆。
   * model 为可选的按回合模型(SDK prompt 形态 key 是 modelID;运行时不透传则被忽略,退化为会话模型)。
   */
  prompt(input: {
    sessionID: string
    text: string
    model?: { providerID: string; modelID: string }
  }): Promise<unknown>
  interrupt?(input: { sessionID: string }): Promise<unknown>
  remove?(input: { sessionID: string }): Promise<unknown>
}

/** ctx.storage 的结构化子集(仅 get/set;持久化一律整表 blob key) */
export interface DispatcherStorage {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
}

/* ============ 对外状态(只增不改) ============ */

export type DispatcherStatus = {
  /** disabled=设置未开启;其余仅在开启时出现 */
  state: "disabled" | "idle" | "cooldown" | "paused"
  /** 全局派发异常连败(观测口径,全局熔断依据) */
  failStreak: number
  todayCount: number
  cooldownRemainMs: number
  /** 当前占用的并发槽(已认领 + 在途派发) */
  activeCount: number
  /** 已派出但尚未被领取的会话数 */
  inFlight: number
  /** 全局超时观测计数(状态灯/日志口径;任务级退避见 taskCooldowns) */
  timeoutStreak: number
  /** 处于任务级未领取退避窗口内的任务数 */
  queuedCooldownCount: number
  /** 最近一次派发被跳过的守卫原因(空串表示无) */
  lastSkipReason: string
  /** 任务级冷却明细:taskID → 剩余毫秒 */
  taskCooldowns: Record<string, number>
}
