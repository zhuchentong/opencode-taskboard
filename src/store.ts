import { transitionSpans } from "./spans"
import { DEFAULT_PROJECT_ID, StoreError, type BoardSettings, type Project, type Status, type Task, type TaskPatch, type TaskUsage } from "./types"

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
const PROJECT_PREFIX = "project/"
const SETTINGS_KEY = "settings/board"
const CLAIM_STATES: ReadonlySet<Status> = new Set(["analyzing", "executing"])
const CONFIRM_FROM: Record<"confirm" | "reject" | "comment", ReadonlySet<Status>> = {
  confirm: new Set<Status>(["analysis_confirm", "completion_confirm"]),
  reject: new Set<Status>(["analysis_confirm", "completion_confirm"]),
  comment: new Set<Status>(["planning", "pending", "analyzing", "analysis_confirm", "executing", "completion_confirm", "done"]),
}

/** 最旧优先选任务:createdAt 升序,同刻按 id 字典序稳定 tie-break(store.claim 与派发引擎共用) */
export function selectOldestPending(tasks: Task[]): Task | undefined {
  return tasks
    .filter((t) => t.status === "pending")
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))[0]
}

export interface Store {
  list(): Promise<Task[]>
  get(id: string): Promise<Task>
  create(input: { title: string; description?: string; projectId?: string }): Promise<Task>
  remove(id: string): Promise<void>
  patch(id: string, p: TaskPatch): Promise<Task>
  getSettings(): Promise<BoardSettings>
  setSettings(patch: Partial<BoardSettings>): Promise<void>
  claim(input: { id?: string; sessionID: string; agent: string }): Promise<Task>
  analyze(input: { id: string; sessionID: string; analysis: string }): Promise<Task>
  complete(input: { id: string; sessionID: string; result?: string }): Promise<Task>
  release(input: { id: string; sessionID: string }): Promise<Task>
  updateNotes(input: { id: string; sessionID: string; analysis?: string; result?: string }): Promise<Task>
  /**
   * 回写 token 消耗快照。与 patch 的根本区别：**不刷新 updatedAt** ——
   * 消耗是纯计量数据，刷新它会让正在执行的任务无端跳到看板顶部。
   */
  recordUsage(input: { id: string; usage: TaskUsage }): Promise<Task>
  /** 项目清单:合成默认项目恒打头,其余按 createdAt 升序 */
  listProjects(): Promise<Project[]>
  /** 取项目;默认项目返回合成值,不查存储 */
  getProject(id: string): Promise<Project>
  createProject(input: { name: string; workspace: string; description?: string }): Promise<Project>
  updateProject(id: string, patch: { name?: string; workspace?: string; description?: string }): Promise<Project>
  deleteProject(id: string): Promise<void>
}

export function createStore(
  backend: KVBackend,
  opts: { requireAnalysisConfirm: boolean; directory?: string },
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
      // 默认开启（产品决策：建任务即自动派发符合直觉，日上限/并发上限兜底；已持久化的值尊重原设置）
      autoDispatch: raw?.autoDispatch ?? true,
      // 阶段模型:undefined=未设置(用运维兜底);空串=显式跟随 opencode 默认;格式容错在派发侧
      modelAnalyze: raw?.modelAnalyze,
      modelExecute: raw?.modelExecute,
    }
  }

  /** 合成默认项目:不占存储键,workspace 动态取服务目录(落盘会随部署漂移,动态解析永远正确) */
  const defaultProject = (): Project => ({
    id: DEFAULT_PROJECT_ID,
    name: "默认项目",
    workspace: opts.directory ?? "(未配置)",
    description: "内置项目：未指定项目的任务；worker 在看板服务目录运行",
    builtin: true,
    createdAt: 0,
    updatedAt: 0,
  })

  const readProject = async (id: string): Promise<Project> => {
    if (id === DEFAULT_PROJECT_ID) return defaultProject()
    const raw = await backend.get(PROJECT_PREFIX + id)
    if (!raw) throw new StoreError("not_found", `项目不存在：${id}`)
    return raw as Project
  }

  const readAllProjects = async (): Promise<Project[]> => {
    const entries = await backend.scan(PROJECT_PREFIX)
    return entries.map((e) => e.value as Project).sort((a, b) => a.createdAt - b.createdAt)
  }

  const newProjectId = () => `project_${crypto.randomUUID().slice(0, 8)}`

  /** 任务项目归属归一:空串/缺省 → 默认项目;非默认须经 readProject 校验存在 */
  const resolveProjectId = async (v: string | undefined): Promise<string> => {
    const id = v && v.trim() ? v : DEFAULT_PROJECT_ID
    await readProject(id) // 不存在 → not_found
    return id
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
        .map((t) => (t.projectId ? t : { ...t, projectId: DEFAULT_PROJECT_ID }))
        .sort((a, b) => b.updatedAt - a.updatedAt)
    },

    async get(id) {
      const t = await readTask(id)
      return t.projectId ? t : { ...t, projectId: DEFAULT_PROJECT_ID }
    },

    create(input) {
      return serialized(async () => {
        const title = typeof input.title === "string" ? input.title.trim() : ""
        if (!title) throw new StoreError("invalid_input", "任务标题不能为空")
        const projectId = await resolveProjectId(input.projectId)
        const now = Date.now()
        const task: Task = {
          id: newId(),
          title,
          description: input.description ?? "",
          status: "planning",
          comments: [],
          projectId,
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
        if (p.projectId !== undefined) next.projectId = await resolveProjectId(p.projectId)

        // 人工流转（拖拽/键盘移动/确认/打回）同样驱动两段计时；只改标题描述时内部自动跳过
        transitionSpans(task, next, now)
        // 进入「待领取」即开新一轮排队计时（拖入 / 打回 / 放弃回 pending）；已在 pending 不重置
        if (next.status === "pending" && task.status !== "pending") next.pendingAt = now
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
        const boolKeys = ["requireAnalysisConfirm", "autoDispatch"] as const
        const strKeys = ["modelAnalyze", "modelExecute"] as const
        const provided = [
          ...boolKeys.filter((k) => patch?.[k] !== undefined),
          ...strKeys.filter((k) => patch?.[k] !== undefined),
        ]
        if (provided.length === 0) {
          throw new StoreError("invalid_input", "缺少设置字段")
        }
        for (const k of provided) {
          if (boolKeys.includes(k as (typeof boolKeys)[number]) && typeof patch[k] !== "boolean") {
            throw new StoreError("invalid_input", `${k} 必须为布尔值`)
          }
          if (strKeys.includes(k as (typeof strKeys)[number]) && typeof patch[k] !== "string") {
            throw new StoreError("invalid_input", `${k} 必须为字符串`)
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
          const oldest = selectOldestPending(entries.map((e) => e.value as Task))
          if (!oldest) throw new StoreError("no_pending", "当前没有待领取的任务")
          target = oldest
        }
        const next: Task = {
          ...target,
          status: "analyzing",
          claim: { sessionID: input.sessionID, agent: input.agent, claimedAt: now },
        }
        transitionSpans(target, next, now)
        next.updatedAt = now
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
        const now = Date.now()
        const next: Task = {
          ...task,
          analysis: input.analysis,
          status: settings.requireAnalysisConfirm ? "analysis_confirm" : "executing",
        }
        transitionSpans(task, next, now)
        next.updatedAt = now
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
        const now = Date.now()
        const next: Task = { ...task, status: "completion_confirm" }
        if (input.result !== undefined) next.result = input.result
        transitionSpans(task, next, now)
        next.updatedAt = now
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
        const now = Date.now()
        const next: Task = { ...task, status: "pending", claim: undefined }
        transitionSpans(task, next, now) // 回到待领取 = 新一轮，计时整体清空
        next.updatedAt = now
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

    recordUsage(input) {
      return serialized(async () => {
        const task = await readTask(input.id) // 不存在 → not_found
        // 整体替换计量快照；刻意不带 updatedAt（见 Store 接口注释）
        const next: Task = { ...task, usage: input.usage }
        await backend.set(TASK_PREFIX + input.id, next)
        return next
      })
    },

    async listProjects() {
      return [defaultProject(), ...(await readAllProjects())]
    },

    getProject(id: string) {
      return readProject(id)
    },

    createProject(input) {
      return serialized(async () => {
        const name = typeof input.name === "string" ? input.name.trim() : ""
        if (!name) throw new StoreError("invalid_input", "项目名称不能为空")
        const all = await readAllProjects()
        if (all.some((p) => p.name === name)) throw new StoreError("conflict", `项目名称已存在：${name}`)
        const now = Date.now()
        const project: Project = {
          id: newProjectId(),
          name,
          workspace: input.workspace,
          description: input.description,
          createdAt: now,
          updatedAt: now,
        }
        await backend.set(PROJECT_PREFIX + project.id, project)
        return project
      })
    },

    updateProject(id, patch) {
      return serialized(async () => {
        if (id === DEFAULT_PROJECT_ID) throw new StoreError("invalid_input", "默认项目不可修改")
        const cur = await readProject(id)
        const next: Project = { ...cur }
        if (patch.name !== undefined) {
          const name = patch.name.trim()
          if (!name) throw new StoreError("invalid_input", "项目名称不能为空")
          const all = await readAllProjects()
          if (all.some((p) => p.id !== id && p.name === name)) {
            throw new StoreError("conflict", `项目名称已存在：${name}`)
          }
          next.name = name
        }
        if (patch.workspace !== undefined) next.workspace = patch.workspace
        if (patch.description !== undefined) next.description = patch.description
        next.updatedAt = Date.now()
        await backend.set(PROJECT_PREFIX + id, next)
        return next
      })
    },

    deleteProject(id) {
      return serialized(async () => {
        if (id === DEFAULT_PROJECT_ID) throw new StoreError("invalid_input", "默认项目不可删除")
        if (!(await backend.get(PROJECT_PREFIX + id))) throw new StoreError("not_found", `项目不存在：${id}`)
        // 守卫与级联同块原子:非 done 任务存在 → 拒删;仅剩 done → 随项目级联清理
        const entries = await backend.scan(TASK_PREFIX)
        const owned = entries
          .map((e) => e.value as Task)
          .filter((t) => (t.projectId ?? DEFAULT_PROJECT_ID) === id)
        if (owned.some((t) => t.status !== "done")) {
          throw new StoreError("conflict", `项目下还有未完成任务，不能删除：${id}`)
        }
        for (const t of owned) await backend.remove(TASK_PREFIX + t.id)
        await backend.remove(PROJECT_PREFIX + id)
      })
    },
  }

  return store
}
