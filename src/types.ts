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

export interface Task {
  id: string
  title: string
  description: string
  status: Status
  analysis?: string
  result?: string
  comments: TaskComment[]
  claim?: Claim
  /** 进入「待领取」的时刻（排队计时起点）；打回/放弃重入 pending 会重置，老任务缺省时前端回落 createdAt */
  pendingAt?: number
  /** token 消耗快照；无字段表示尚未记录（旧任务或消耗尚未回写） */
  usage?: TaskUsage
  /** 分析段/执行段各自的时间区间；无字段表示尚未记录（旧任务或尚未开工） */
  spans?: Partial<Record<"analyzing" | "executing", PhaseSpan>>
  createdAt: number
  updatedAt: number
}

export interface BoardSettings {
  requireAnalysisConfirm: boolean
  /** 自动派发：待领取出现任务时自动驱动 worker 会话领取（默认关） */
  autoDispatch: boolean
}

export type StoreErrorCode =
  | "not_found"
  | "invalid_transition"
  | "conflict"
  | "not_claimer"
  | "comment_required"
  | "no_pending"
  | "invalid_input"

export class StoreError extends Error {
  code: StoreErrorCode

  constructor(code: StoreErrorCode, message?: string) {
    super(message ?? code)
    this.code = code
  }
}

export interface TaskPatch {
  status?: Status
  title?: string
  description?: string
  action?: "confirm" | "reject" | "comment"
  comment?: string
}
