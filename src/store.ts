import { StoreError, type BoardSettings, type Status, type Task, type TaskPatch } from "./types"

export interface KVBackend {
  get(key: string): Promise<unknown | undefined>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
  scan(prefix: string): Promise<{ key: string; value: unknown }[]>
}

export function memoryBackend(): KVBackend {
  const map = new Map<string, unknown>()
  return {
    async get(key) {
      return map.get(key)
    },
    async set(key, value) {
      map.set(key, value)
    },
    async remove(key) {
      map.delete(key)
    },
    async scan(prefix) {
      const out: { key: string; value: unknown }[] = []
      for (const [key, value] of map) {
        if (key.startsWith(prefix)) out.push({ key, value })
      }
      return out
    },
  }
}

/** ctx.storage 的最小结构契约（与 OpenCode 插件上下文中的 storage 域一致） */
export interface CtxStorageLike {
  get(key: string): Promise<unknown | undefined>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
  scan(opts: { prefix: string; after?: string; limit?: number }): Promise<{
    entries: readonly { key: string; value: unknown }[]
    next?: string
  }>
}

/** 把 ctx.storage 适配为 KVBackend：所有 key 前置 keyPrefix（项目隔离），scan 循环游标取全量 */
export function storageBackend(storage: CtxStorageLike, keyPrefix: string): KVBackend {
  const K = (key: string) => keyPrefix + key
  return {
    get: (key) => storage.get(K(key)),
    set: (key, value) => storage.set(K(key), value),
    remove: (key) => storage.remove(K(key)),
    async scan(prefix) {
      const out: { key: string; value: unknown }[] = []
      let after: string | undefined
      while (true) {
        const page = await storage.scan({ prefix: K(prefix), after, limit: 100 })
        out.push(...page.entries)
        if (!page.next) break
        after = page.next
      }
      return out
    },
  }
}

const TASK_PREFIX = "task/"
const SETTINGS_KEY = "settings/board"
const CLAIM_STATES: ReadonlySet<Status> = new Set(["analyzing", "executing"])
const CONFIRM_FROM: Record<"confirm" | "reject" | "comment", ReadonlySet<Status>> = {
  confirm: new Set<Status>(["analysis_confirm", "completion_confirm"]),
  reject: new Set<Status>(["analysis_confirm", "completion_confirm"]),
  comment: new Set<Status>(["planning", "pending", "analyzing", "analysis_confirm", "executing", "completion_confirm", "done"]),
}

export interface Store {
  list(): Promise<Task[]>
  get(id: string): Promise<Task>
  create(input: { title: string; description?: string }): Promise<Task>
  remove(id: string): Promise<void>
  patch(id: string, p: TaskPatch): Promise<Task>
  getSettings(): Promise<BoardSettings>
  setSettings(patch: Partial<BoardSettings>): Promise<void>
  claim(input: { id?: string; sessionID: string; agent: string }): Promise<Task>
  analyze(input: { id: string; sessionID: string; analysis: string }): Promise<Task>
  complete(input: { id: string; sessionID: string; result?: string }): Promise<Task>
  release(input: { id: string; sessionID: string }): Promise<Task>
  updateNotes(input: { id: string; sessionID: string; analysis?: string; result?: string }): Promise<Task>
}

export function createStore(
  backend: KVBackend,
  opts: { requireAnalysisConfirm: boolean },
): Store {
  // 全局写互斥：所有写操作串行化（spec"每任务锁"的超集，并使无 id claim 天然原子）
  let chain: Promise<unknown> = Promise.resolve()
  const serialized = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn)
    chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  const readTask = async (id: string): Promise<Task> => {
    const raw = await backend.get(TASK_PREFIX + id)
    if (!raw) throw new StoreError("not_found", `任务不存在：${id}`)
    return raw as Task
  }

  const requireOwned = (t: Task, sessionID: string): void => {
    if (!t.claim || t.claim.agent === "human" || t.claim.sessionID !== sessionID) {
      throw new StoreError(
        "not_claimer",
        t.claim
          ? `任务由 ${t.claim.agent} 领取，当前会话无权操作`
          : "任务当前无人领取，当前会话无权操作",
      )
    }
  }

  const readSettings = async (): Promise<BoardSettings> => {
    const raw = (await backend.get(SETTINGS_KEY)) as Partial<BoardSettings> | undefined
    return {
      requireAnalysisConfirm: raw?.requireAnalysisConfirm ?? opts.requireAnalysisConfirm,
      autoDispatch: raw?.autoDispatch ?? false,
    }
  }

  // 人工拖拽的 claim 维护（spec §5.4）；confirm/reject 动作不走此逻辑
  const applyDragClaim = (prev: Task, next: Task, now: number): void => {
    const to = CLAIM_STATES.has(next.status)
    if (!to) {
      next.claim = undefined
    } else if (!next.claim) {
      next.claim = { sessionID: "", agent: "human", claimedAt: now }
    }
  }

  const newId = () => `task_${crypto.randomUUID().slice(0, 8)}`

  const store: Store = {
    async list() {
      const entries = await backend.scan(TASK_PREFIX)
      return entries
        .map((e) => e.value as Task)
        .sort((a, b) => b.updatedAt - a.updatedAt)
    },

    async get(id) {
      return readTask(id)
    },

    create(input) {
      return serialized(async () => {
        const title = typeof input.title === "string" ? input.title.trim() : ""
        if (!title) throw new StoreError("invalid_input", "任务标题不能为空")
        const now = Date.now()
        const task: Task = {
          id: newId(),
          title,
          description: input.description ?? "",
          status: "planning",
          comments: [],
          createdAt: now,
          updatedAt: now,
        }
        await backend.set(TASK_PREFIX + task.id, task)
        return task
      })
    },

    remove(id) {
      return serialized(async () => {
        await readTask(id)
        await backend.remove(TASK_PREFIX + id)
      })
    },

    patch(id, p) {
      return serialized(async () => {
        const task = await readTask(id)
        const now = Date.now()
        const next: Task = { ...task, comments: [...task.comments] }

        if (p.action !== undefined && p.status !== undefined) {
          throw new StoreError("invalid_input", "action 与 status 不能同时提供")
        }

        if (p.action !== undefined && p.action !== "confirm" && p.action !== "reject" && p.action !== "comment") {
          throw new StoreError("invalid_input", `未知操作：${String(p.action)}`)
        }

        if (p.action === "confirm" || p.action === "reject" || p.action === "comment") {
          if (!CONFIRM_FROM[p.action].has(task.status)) {
            throw new StoreError("invalid_transition", `当前状态 ${task.status} 不能执行 ${p.action}`)
          }
          if (p.action === "confirm") {
            next.status = task.status === "analysis_confirm" ? "executing" : "done"
          } else if (p.action === "comment") {
            const comment = (p.comment ?? "").trim()
            if (!comment) throw new StoreError("comment_required", "评论内容不能为空")
            next.comments.push({ author: "user", text: comment, createdAt: now })
          } else {
            const comment = (p.comment ?? "").trim()
            if (!comment) throw new StoreError("comment_required", "打回必须附评论")
            next.status = "pending"
            next.claim = undefined
            next.comments.push({ author: "user", text: comment, createdAt: now })
          }
        } else if (p.status !== undefined) {
          next.status = p.status
          applyDragClaim(task, next, now)
        }

        if (p.title !== undefined) {
          const title = p.title.trim()
          if (!title) throw new StoreError("invalid_input", "任务标题不能为空")
          next.title = title
        }
        if (p.description !== undefined) next.description = p.description

        next.updatedAt = now
        await backend.set(TASK_PREFIX + id, next)
        return next
      })
    },

    async getSettings() {
      return readSettings()
    },

    setSettings(patch) {
      return serialized(async () => {
        // 合并写入：只更新给出的字段（旧版整体覆盖会抹掉未提交的设置项）
        const keys = ["requireAnalysisConfirm", "autoDispatch"] as const
        const provided = keys.filter((k) => patch?.[k] !== undefined)
        if (provided.length === 0) {
          throw new StoreError("invalid_input", "缺少设置字段")
        }
        for (const k of provided) {
          if (typeof patch[k] !== "boolean") {
            throw new StoreError("invalid_input", `${k} 必须为布尔值`)
          }
        }
        const cur = await readSettings()
        await backend.set(SETTINGS_KEY, { ...cur, ...patch })
      })
    },

    claim(input) {
      return serialized(async () => {
        const now = Date.now()
        let target: Task
        if (input.id !== undefined) {
          target = await readTask(input.id)
          if (target.status !== "pending") {
            throw new StoreError("invalid_transition", `任务状态为 ${target.status}，仅待领取任务可认领`)
          }
        } else {
          const entries = await backend.scan(TASK_PREFIX)
          const pendings = entries
            .map((e) => e.value as Task)
            .filter((t) => t.status === "pending")
            .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
          if (pendings.length === 0) throw new StoreError("no_pending", "当前没有待领取的任务")
          target = pendings[0]
        }
        const next: Task = {
          ...target,
          status: "analyzing",
          claim: { sessionID: input.sessionID, agent: input.agent, claimedAt: now },
          updatedAt: now,
        }
        await backend.set(TASK_PREFIX + next.id, next)
        return next
      })
    },

    analyze(input) {
      return serialized(async () => {
        const task = await readTask(input.id)
        if (task.status !== "analyzing") {
          throw new StoreError("invalid_transition", `任务状态为 ${task.status}，仅分析中任务可提交分析`)
        }
        requireOwned(task, input.sessionID)
        const settings = await readSettings()
        const next: Task = {
          ...task,
          analysis: input.analysis,
          status: settings.requireAnalysisConfirm ? "analysis_confirm" : "executing",
          updatedAt: Date.now(),
        }
        await backend.set(TASK_PREFIX + next.id, next)
        return next
      })
    },

    complete(input) {
      return serialized(async () => {
        const task = await readTask(input.id)
        if (task.status !== "executing") {
          throw new StoreError("invalid_transition", `任务状态为 ${task.status}，仅执行中任务可提交完成`)
        }
        requireOwned(task, input.sessionID)
        const next: Task = { ...task, status: "completion_confirm", updatedAt: Date.now() }
        if (input.result !== undefined) next.result = input.result
        await backend.set(TASK_PREFIX + next.id, next)
        return next
      })
    },

    release(input) {
      return serialized(async () => {
        const task = await readTask(input.id)
        if (!CLAIM_STATES.has(task.status)) {
          throw new StoreError("invalid_transition", `任务状态为 ${task.status}，仅分析中/执行中任务可放弃`)
        }
        requireOwned(task, input.sessionID)
        const next: Task = { ...task, status: "pending", claim: undefined, updatedAt: Date.now() }
        await backend.set(TASK_PREFIX + next.id, next)
        return next
      })
    },

    updateNotes(input) {
      return serialized(async () => {
        const task = await readTask(input.id)
        requireOwned(task, input.sessionID)
        const next: Task = { ...task, updatedAt: Date.now() }
        if (input.analysis !== undefined) next.analysis = input.analysis
        if (input.result !== undefined) next.result = input.result
        await backend.set(TASK_PREFIX + next.id, next)
        return next
      })
    },
  }

  return store
}
