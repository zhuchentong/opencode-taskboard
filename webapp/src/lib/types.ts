// 前端类型副本：与 src/types.ts 字段保持一致（重构期间手动同步）
export type Status =
  | "planning"
  | "pending"
  | "analyzing"
  | "analysis_confirm"
  | "executing"
  | "completion_confirm"
  | "done"

export interface TaskComment {
  author: string
  text: string
  createdAt: number
}

export interface Claim {
  sessionID: string
  agent: string
  claimedAt: number
}

/** 一个执行阶段的计时区间；endedAt 缺省表示该阶段仍在进行 */
export interface PhaseSpan {
  startedAt: number
  endedAt?: number
}

/** 任务累计的 token 消耗快照（由派发器在会话结束时回写；缺字段按 0 计） */
export interface TaskUsage {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  /** 快照时间 */
  at: number
}

/**
 * 分段计时记录（只追加账本，回 pending 不作废历史段）：
 * 问答循环/打回重做的每一段时长独立留存；段间消耗由展示层做差（二期）。
 */
export interface SpanRecord {
  phase: "analyzing" | "executing" | "analysis_confirm"
  /** 第几轮（进 pending 次数，首轮为 1；打回重做递增，问答往复不计入） */
  round: number
  /** 归因到会话；人工操作段（human claim）缺省 */
  sessionID?: string
  startedAt: number
  endedAt?: number
  usage?: TaskUsage
}

export interface Task {
  id: string
  title: string
  description: string
  status: Status
  analysis?: string
  result?: string
  comments: TaskComment[]
  claim?: Claim
  /** 进入「待领取」的时刻（排队计时起点）；老任务缺省时回落 createdAt */
  pendingAt?: number
  /** token 消耗快照；无字段表示尚未记录（旧任务或消耗尚未回写） */
  usage?: TaskUsage
  /** 分析段/执行段各自的时间区间；无字段表示尚未记录（旧任务或尚未开工） */
  spans?: Partial<Record<"analyzing" | "executing", PhaseSpan>>
  /** 分段计时账本（只追加；问答循环/打回重做的每段独立留存） */
  spanLog?: SpanRecord[]
  /** 轮次 = 进 pending 的次数（首轮 1；打回重做递增，问答往复不计入） */
  round?: number
  createdAt: number
  updatedAt: number
}

export interface BoardSettings {
  requireAnalysisConfirm: boolean
  /** 自动派发：待领取出现任务时自动驱动 Agent 会话领取（默认开，已持久化的值尊重原设置） */
  autoDispatch: boolean
}
