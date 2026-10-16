// 全前端唯一 API 入口：统一 token 头、JSON 体与错误解析。
// 非 2xx 一律抛 BoardApiError（code 取服务端 error.code，缺省 "unknown"）。
import type { BoardSettings, Task } from "./types"

declare global {
  interface Window {
    __TASKBOARD_TOKEN__: string
  }
}

export class BoardApiError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

function headers(): Record<string, string> {
  // 惰性取值：模块加载期不碰 window（bun 测试环境无 DOM）
  return {
    "Content-Type": "application/json",
    "X-Taskboard-Token": window.__TASKBOARD_TOKEN__,
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { ...headers(), ...(init?.headers ?? {}) } })
  if (!res.ok) {
    let code = "unknown"
    let message = `HTTP ${res.status}`
    try {
      const body = await res.json()
      if (body?.error?.code) code = body.error.code
      if (body?.error?.message) message = body.error.message
    } catch {
      /* 非 JSON 错误体，保留 HTTP 状态信息 */
    }
    throw new BoardApiError(code, message)
  }
  return res.json() as Promise<T>
}

export async function fetchBoard(): Promise<{ tasks: Task[]; settings: BoardSettings }> {
  const [tasks, settings] = await Promise.all([
    request<Task[]>("/api/tasks"),
    request<BoardSettings>("/api/settings"),
  ])
  return { tasks, settings }
}

export function createTask(title: string, description?: string): Promise<Task> {
  return request<Task>("/api/tasks", { method: "POST", body: JSON.stringify({ title, description }) })
}

export function patchTask(id: string, patch: Record<string, unknown>): Promise<Task> {
  return request<Task>(`/api/tasks/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) })
}

export function deleteTask(id: string): Promise<void> {
  return request<void>(`/api/tasks/${encodeURIComponent(id)}`, { method: "DELETE" })
}

export function putSettings(requireAnalysisConfirm: boolean): Promise<BoardSettings> {
  return request<BoardSettings>("/api/settings", { method: "PUT", body: JSON.stringify({ requireAnalysisConfirm }) })
}

export type ConnState = "live" | "reconnecting" | "polling"
