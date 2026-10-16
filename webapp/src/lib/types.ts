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

export interface Task {
  id: string
  title: string
  description: string
  status: Status
  analysis?: string
  result?: string
  comments: TaskComment[]
  claim?: Claim
  createdAt: number
  updatedAt: number
}

export interface BoardSettings {
  requireAnalysisConfirm: boolean
  /** 自动派发：待领取出现任务时自动驱动 Agent 会话领取（默认关） */
  autoDispatch: boolean
}
