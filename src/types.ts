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

/**
 * 分段计时记录（只追加账本，回 pending 不作废历史段）：
 * 问答循环/打回重做的每一段时长都独立留存，由 transitionSpans 双写维护。
 * usage 为封口时刻从 task.usage 拷贝的累计快照，段间消耗由展示层做差（二期）。
 */
export interface SpanRecord {
  phase: "pending" | "analyzing" | "executing" | "analysis_confirm"
  /** 第几轮（进 pending 次数，首轮为 1；打回重做递增，问答往复不计入） */
  round: number
  /** 归因到会话；人工操作段（human claim）缺省 */
  sessionID?: string
  startedAt: number
  endedAt?: number
  usage?: TaskUsage
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

export const DEFAULT_PROJECT_ID = "project_default"

/**
 * 看板「项目」:用户可管理的任务分组,自带 worker 工作区目录。
 * 默认项目是合成实体(不占存储键),由 store 按 opts.directory 动态提供。
 */
export interface Project {
  id: string // `project_<8位hex>`
  /** 唯一,非空;允许改名(外键是 id,不断链) */
  name: string
  /** worker 会话的工作目录(绝对路径) */
  workspace: string
  description?: string
  /** 仅合成的默认项目为 true */
  builtin?: boolean
  createdAt: number
  updatedAt: number
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
  /** 分段计时账本（只追加；问答循环/打回重做的每段独立留存） */
  spanLog?: SpanRecord[]
  /** 轮次 = 进 pending 的次数（首轮 1；打回重做递增，问答往复不计入）；由 transitionSpans 维护 */
  round?: number
  /** 所属看板项目;缺省(老任务)读取时归一化为默认项目 */
  projectId?: string
  createdAt: number
  updatedAt: number
}

export interface BoardSettings {
  requireAnalysisConfirm: boolean
  /** 自动派发：待领取出现任务时自动驱动 worker 会话领取（默认开，已持久化的值尊重原设置） */
  autoDispatch: boolean
  /** 分析阶段模型("provider/model";空串=跟随 opencode 默认;未设置=用运维兜底) */
  modelAnalyze?: string
  /** 执行阶段模型(同上;一任务一会话,执行回合经 prompt per-call model 切换) */
  modelExecute?: string
}

export const STORE_ERROR_CODES = [
  "not_found",
  "invalid_transition",
  "conflict",
  "not_claimer",
  "comment_required",
  "no_pending",
  "invalid_input",
  "unreachable",
  "forbidden",
  "model_not_configured",
] as const

export type StoreErrorCode = (typeof STORE_ERROR_CODES)[number]

export function isStoreErrorCode(c: unknown): c is StoreErrorCode {
  return typeof c === "string" && (STORE_ERROR_CODES as readonly string[]).includes(c)
}

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
  /** 挪项目;空串归一到默认项目;目标项目必须存在 */
  projectId?: string
  action?: "confirm" | "reject" | "comment"
  comment?: string
}
