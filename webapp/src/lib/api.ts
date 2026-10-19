// 全前端唯一 API 入口：统一 token 头、JSON 体与错误解析。
// 非 2xx 一律抛 BoardApiError（code 取服务端 error.code，缺省 "unknown"）。
import type { BoardSettings, Project, Task } from "./types"
import type { FsListing } from "./fsbrowse"
import type { ContextPage } from "./context"

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

export async function fetchBoard(): Promise<{
  tasks: Task[]
  settings: BoardSettings
  projects: Project[]
}> {
  // projects 拉取失败(旧服务端无此路由)按空清单容错,不拖垮整帧
  const [tasks, settings, projects] = await Promise.all([
    request<Task[]>("/api/tasks"),
    request<BoardSettings>("/api/settings"),
    request<{ projects: Project[] }>("/api/projects")
      .then((r) => r.projects)
      .catch(() => [] as Project[]),
  ])
  return { tasks, settings, projects }
}

export async function fetchProjects(): Promise<Project[]> {
  const r = await request<{ projects: Project[] }>("/api/projects")
  return r.projects
}

export function createProject(input: { name: string; workspace: string; description?: string }): Promise<Project> {
  return request<Project>("/api/projects", { method: "POST", body: JSON.stringify(input) })
}

export function updateProject(id: string, patch: { name?: string; workspace?: string; description?: string }): Promise<Project> {
  return request<Project>(`/api/projects/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) })
}

export function deleteProject(id: string): Promise<void> {
  return request<void>(`/api/projects/${encodeURIComponent(id)}`, { method: "DELETE" })
}

/** 列目录（项目工作区选路径的数据源）；不传 path 则服务端列用户 HOME */
export function listDir(path?: string): Promise<FsListing> {
  const q = new URLSearchParams()
  if (path !== undefined) q.set("path", path)
  const qs = q.toString()
  return request<FsListing>(`/api/fs/ls${qs ? `?${qs}` : ""}`)
}

/** 任务上下文分页（worker 会话消息）；cursor 缺省取最新一页 */
export function fetchTaskContext(taskId: string, cursor?: string): Promise<ContextPage> {
  const q = new URLSearchParams()
  if (cursor !== undefined) q.set("cursor", cursor)
  const qs = q.toString()
  return request<ContextPage>(`/api/tasks/${encodeURIComponent(taskId)}/context${qs ? `?${qs}` : ""}`)
}

/** 可用模型清单(worker 阶段模型下拉数据源);服务端不可用时返回空,组件退化提示 */
export async function fetchModels(): Promise<string[]> {
  const r = await request<{ models: string[] }>("/api/models")
  return r.models
}

export function createTask(title: string, description?: string, projectId?: string): Promise<Task> {
  return request<Task>("/api/tasks", { method: "POST", body: JSON.stringify({ title, description, projectId }) })
}

export function patchTask(id: string, patch: Record<string, unknown>): Promise<Task> {
  return request<Task>(`/api/tasks/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) })
}

export function deleteTask(id: string): Promise<void> {
  return request<void>(`/api/tasks/${encodeURIComponent(id)}`, { method: "DELETE" })
}

export function putSettings(patch: Partial<{ requireAnalysisConfirm: boolean; autoDispatch: boolean; modelAnalyze?: string; modelExecute?: string }>): Promise<BoardSettings> {
  return request<BoardSettings>("/api/settings", { method: "PUT", body: JSON.stringify(patch) })
}

export type ConnState = "live" | "reconnecting" | "polling"
