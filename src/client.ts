import { StoreError, type StoreErrorErrorCode, type Task, type TaskPatch } from "./types"
import type { Store } from "./store"

/**
 * Store 的 HTTP 客户端实现：次要实例用它把包括工具在内的全部写操作
 * 代理到持有基准端口的主实例（spec §9 写者唯一原则）。
 */
export function clientStore(base: string, token: string): Store {
  const call = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const res = await fetch(base + path, {
      ...init,
      headers: {
        "X-Taskboard-Token": token,
        "Content-Type": "application/json",
        ...(init?.headers as Record<string, string> | undefined),
      },
    })
    const body = (await res.json().catch(() => undefined)) as
      | T
      | { error?: { code?: string; message?: string } }
      | undefined
    if (!res.ok) {
      const err = (body as { error?: { code?: string; message?: string } } | undefined)?.error
      throw new StoreError(
        (err?.code as StoreErrorErrorCode) ?? "conflict",
        err?.message ?? `看板服务返回 ${res.status}`,
      )
    }
    return body as T
  }

  const post = (path: string, body: unknown) => call<Task>(path, { method: "POST", body: JSON.stringify(body) })

  return {
    async list() {
      return call<Task[]>("/api/tasks")
    },
    async get(id) {
      const list = await call<Task[]>("/api/tasks")
      const hit = list.find((t) => t.id === id)
      if (!hit) throw new StoreError("not_found", `任务不存在：${id}`)
      return hit
    },
    async create(input) {
      return call<Task>("/api/tasks", { method: "POST", body: JSON.stringify(input) })
    },
    async remove(id) {
      await call<{ ok: boolean }>(`/api/tasks/${encodeURIComponent(id)}`, { method: "DELETE" })
    },
    async patch(id, p: TaskPatch) {
      return call<Task>(`/api/tasks/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(p) })
    },
    async getSettings() {
      return call<import("./types").BoardSettings>("/api/settings")
    },
    async setSettings(s) {
      await call("/api/settings", { method: "PUT", body: JSON.stringify(s) })
    },
    async claim(input) {
      return post("/api/claim", input)
    },
    async analyze(input) {
      return post(`/api/tasks/${encodeURIComponent(input.id)}/analyze`, {
        sessionID: input.sessionID,
        analysis: input.analysis,
      })
    },
    async complete(input) {
      return post(`/api/tasks/${encodeURIComponent(input.id)}/complete`, {
        sessionID: input.sessionID,
        result: input.result,
      })
    },
    async release(input) {
      return post(`/api/tasks/${encodeURIComponent(input.id)}/release`, { sessionID: input.sessionID })
    },
    async updateNotes(input) {
      return post(`/api/tasks/${encodeURIComponent(input.id)}/notes`, {
        sessionID: input.sessionID,
        analysis: input.analysis,
        result: input.result,
      })
    },
  }
}
