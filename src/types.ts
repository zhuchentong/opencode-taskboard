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
  action?: "confirm" | "reject"
  comment?: string
}
