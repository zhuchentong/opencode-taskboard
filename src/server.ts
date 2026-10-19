import { dirname, isAbsolute, join, resolve } from "node:path"
import { statSync } from "node:fs"
import { readdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { StoreError } from "./types"
import type { BoardSettings, Project, Store, Task } from "./types"
import type { ContextPage, ContextReadInput } from "./context"

export type ServerEvent = { type: "hello" } | { type: "snapshot"; tasks: Task[]; settings: BoardSettings; projects: Project[] }

export interface ServerHandle {
  server: Bun.Server
  actualPort: number
  stop(): void
  emit(event: ServerEvent): void
}

const SSE_HEARTBEAT_MS = 25_000
const MAX_SSE_SUBSCRIBERS = 32
/** 目录列表条目上限：超大目录（如 /usr）只回前 N 项，防选择器渲染卡死 */
const FS_LIST_CAP = 500

type Subscriber = {
  controller: ReadableStreamDefaultController<Uint8Array>
  heartbeat: ReturnType<typeof setInterval>
}

const STATUS_BY_CODE: Record<string, number> = {
  not_found: 404,
  invalid_transition: 400,
  conflict: 400,
  not_claimer: 400,
  comment_required: 400,
  no_pending: 400,
  invalid_input: 400,
  unreachable: 503,
  forbidden: 403,
  model_not_configured: 409,
}

function errorResponse(e: unknown): Response {
  if (e instanceof StoreError) {
    return Response.json({ error: { code: e.code, message: e.message } }, { status: STATUS_BY_CODE[e.code] ?? 400 })
  }
  return Response.json({ error: { code: "internal", message: String(e) } }, { status: 500 })
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
}

export function createServer(
  store: Store,
  opts: {
    port: number
    token: string
    webDir: string
    primary: boolean
    projectID: string
    logs?: () => readonly string[]
    /** 可用模型清单(阶段模型下拉数据源;index 注入 opencode models CLI + 缓存) */
    listModels?: () => Promise<string[]>
    /** 任务上下文分页读取(worker 会话消息;index 注入 context reader,测试可 mock);缺省路由返回空页 */
    readContext?: (input: ContextReadInput) => Promise<ContextPage>
    /** 每次写广播快照后异步触发（自动派发器等观察者）；携带快照任务列表（沿驱动实时消费），不影响响应 */
    onWrite?: (tasks: Task[]) => void
  },
): ServerHandle {
  const { token, webDir } = opts

  const guard = (req: Request, json = true): Response | undefined => {
    if (req.headers.get("X-Taskboard-Token") !== token) {
      return Response.json({ error: { code: "forbidden", message: "缺少或错误的访问令牌" } }, { status: 403 })
    }
    const ct = req.headers.get("Content-Type") ?? ""
    if (json && !ct.includes("application/json")) {
      return Response.json({ error: { code: "unsupported_media_type", message: "Content-Type 必须为 application/json" } }, { status: 415 })
    }
    return undefined
  }

  async function readJson(req: Request): Promise<Record<string, unknown>> {
    try {
      return (await req.json()) as Record<string, unknown>
    } catch {
      throw new StoreError("invalid_input", "请求体不是合法 JSON")
    }
  }

  /** 项目工作区校验(路由层职责,store 保持纯数据层):绝对路径 + 存在且为目录;错误文案含路径 */
  function validWorkspaceOrThrow(workspace: unknown): string {
    if (typeof workspace !== "string" || workspace.trim() === "") {
      throw new StoreError("invalid_input", "工作区不能为空")
    }
    if (!isAbsolute(workspace)) throw new StoreError("invalid_input", `工作区必须是绝对路径：${workspace}`)
    let isDir = false
    try {
      isDir = statSync(workspace).isDirectory()
    } catch {
      throw new StoreError("invalid_input", `工作区目录不存在：${workspace}`)
    }
    if (!isDir) throw new StoreError("invalid_input", `工作区不是目录：${workspace}`)
    return workspace
  }

  /**
   * 目录浏览：项目工作区选路径的数据源，只读列目录。
   * - 无鉴权：这比既有读路径多暴露了本机目录名枚举（含其他用户 home 是否存在）；
   *   与 tasks/logs/SSE 同姿态（127.0.0.1 绑定 + 本机单用户），且只列目录名、不读文件内容；
   * - 有意不做路径沙箱：本机开发工具，用户需浏览任意绝对路径。若日后要收紧，
   *   最小成本是单独给本路由加 guard（前端 listDir 走统一 request，已自带 token）；
   * - 次要实例各自本地处理（文件系统全机共享，无需代理主实例）。
   */
  async function handleFsList(url: URL): Promise<Response> {
    const raw = url.searchParams.has("path") ? url.searchParams.get("path") ?? "" : homedir()
    if (raw.trim() === "" || !isAbsolute(raw)) {
      return Response.json({ error: { code: "invalid_path", message: `目录必须是绝对路径：${raw}` } }, { status: 400 })
    }
    const target = resolve(raw)
    let dirents: Awaited<ReturnType<typeof readdir>>
    try {
      dirents = (await readdir(target, { withFileTypes: true })) as Awaited<ReturnType<typeof readdir>>
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === "EACCES" || code === "EPERM") {
        return Response.json({ error: { code: "forbidden", message: `无权限读取目录：${target}` } }, { status: 403 })
      }
      return Response.json({ error: { code: "not_found", message: `目录不存在：${target}` } }, { status: 404 })
    }
    const entries: Array<{ name: string; path: string; type: "dir" }> = []
    for (const d of dirents) {
      const full = join(target, d.name)
      // readdir 已给出多数条目类型，只对 symlink 才 stat（跟随符号链接）；
      // 单条 stat 失败（/proc 下 EPERM/EIO、断链 symlink）跳过该条目，不让整次列举失败
      let isDir = d.isDirectory()
      if (!isDir && d.isSymbolicLink()) {
        try {
          isDir = (await stat(full)).isDirectory()
        } catch {
          continue
        }
      }
      if (isDir) entries.push({ name: d.name, path: full, type: "dir" })
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    const parent = dirname(target)
    return Response.json({
      path: target,
      parent: parent === target ? null : parent,
      home: homedir(),
      entries: entries.slice(0, FS_LIST_CAP),
    })
  }

  const encoder = new TextEncoder()
  const subscribers = new Set<Subscriber>()

  const sseFrame = (event: ServerEvent): Uint8Array => encoder.encode(`data: ${JSON.stringify(event)}\n\n`)

  function removeSubscriber(sub: Subscriber): void {
    if (!subscribers.delete(sub)) return
    clearInterval(sub.heartbeat)
    try {
      sub.controller.close()
    } catch {
      // 流已被客户端取消
    }
  }

  function emit(event: ServerEvent): void {
    for (const sub of subscribers) {
      try {
        sub.controller.enqueue(sseFrame(event))
      } catch {
        removeSubscriber(sub)
      }
    }
  }

  async function emitSnapshot(): Promise<void> {
    const tasks = await store.list()
    emit({
      type: "snapshot",
      tasks,
      settings: await store.getSettings(),
      projects: await store.listProjects(),
    })
    if (opts.onWrite) setTimeout(() => opts.onWrite(tasks), 0)
  }

  function handleEvents(req: Request): Response {
    if (subscribers.size >= MAX_SSE_SUBSCRIBERS) {
      return Response.json(
        { error: { code: "too_many_subscribers", message: "事件流订阅已达上限，请稍后重试" } },
        { status: 503 },
      )
    }
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c
      },
      cancel() {
        removeSubscriber(sub)
      },
    })
    const sub: Subscriber = {
      controller,
      heartbeat: setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"))
        } catch {
          removeSubscriber(sub)
        }
      }, SSE_HEARTBEAT_MS),
    }
    subscribers.add(sub)
    req.signal.addEventListener("abort", () => removeSubscriber(sub))
    void (async () => {
      try {
        controller.enqueue(sseFrame({ type: "hello" }))
        await emitSnapshot()
      } catch {
        removeSubscriber(sub)
      }
    })()
    if (req.signal.aborted) removeSubscriber(sub)
    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
    })
  }

  async function serveStatic(pathname: string): Promise<Response> {
    const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "")
    const file = join(webDir, rel)
    if (!file.startsWith(webDir)) {
      return Response.json({ error: { code: "not_found", message: "文件不存在" } }, { status: 404 })
    }
    const f = Bun.file(file)
    if (!(await f.exists())) {
      return Response.json({ error: { code: "not_found", message: "文件不存在" } }, { status: 404 })
    }
    if (rel === "index.html") {
      const html = (await f.text()).replaceAll("__TASKBOARD_TOKEN_VALUE__", token)
      return new Response(html, { headers: { "Content-Type": MIME[".html"], "Cache-Control": "no-cache" } })
    }
    const ext = rel.slice(rel.lastIndexOf(".")).toLowerCase()
    return new Response(f, {
      headers: { "Content-Type": MIME[ext] ?? "application/octet-stream", "Cache-Control": "no-cache" },
    })
  }

  async function api(req: Request, pathname: string): Promise<Response> {
    const method = req.method
    if (pathname === "/api/health") {
      return Response.json({ ok: true, primary: opts.primary, projectID: opts.projectID })
    }
    if (pathname === "/api/logs") {
      return Response.json({ logs: opts.logs?.() ?? [] })
    }
    // 模型列表(读路径无鉴权):worker 阶段模型下拉的数据源;未注入(如测试)返回空列表
    if (pathname === "/api/models" && method === "GET") {
      return Response.json({ models: (await opts.listModels?.()) ?? [] })
    }
    if (pathname === "/api/events" && method === "GET") {
      return handleEvents(req)
    }
    if (pathname === "/api/settings") {
      if (method === "GET") return Response.json(await store.getSettings())
      if (method === "PUT") {
        const bad = guard(req)
        if (bad) return bad
        await store.setSettings((await readJson(req)) as never)
        await emitSnapshot()
        return Response.json(await store.getSettings())
      }
    }
    if (pathname === "/api/projects") {
      if (method === "GET") return Response.json({ projects: await store.listProjects() })
      if (method === "POST") {
        const bad = guard(req)
        if (bad) return bad
        const body = await readJson(req)
        const project = await store.createProject({
          name: String(body.name ?? ""),
          workspace: validWorkspaceOrThrow(body.workspace),
          description: typeof body.description === "string" ? body.description : undefined,
        })
        await emitSnapshot()
        return Response.json(project, { status: 201 })
      }
    }
    const projMatch = pathname.match(/^\/api\/projects\/([^/]+)$/)
    if (projMatch) {
      const pid = decodeURIComponent(projMatch[1])
      if (method === "GET") return Response.json(await store.getProject(pid))
      if (method === "PATCH") {
        const bad = guard(req)
        if (bad) return bad
        const body = await readJson(req)
        const project = await store.updateProject(pid, {
          name: typeof body.name === "string" ? body.name : undefined,
          workspace: body.workspace !== undefined ? validWorkspaceOrThrow(body.workspace) : undefined,
          description: typeof body.description === "string" ? body.description : undefined,
        })
        await emitSnapshot()
        return Response.json(project)
      }
      if (method === "DELETE") {
        const bad = guard(req, false)
        if (bad) return bad
        await store.deleteProject(pid)
        await emitSnapshot()
        return Response.json({ ok: true })
      }
    }
    if (pathname === "/api/fs/ls" && method === "GET") return handleFsList(new URL(req.url))
    if (pathname === "/api/tasks") {
      if (method === "GET") return Response.json(await store.list())
      if (method === "POST") {
        const bad = guard(req)
        if (bad) return bad
        const body = await readJson(req)
        // 建任务门禁:阶段模型未配齐一律拒绝(与网页门禁同语义,防绕过前端直调 API)
        const settings = await store.getSettings()
        if (!settings.modelAnalyze || !settings.modelExecute) {
          throw new StoreError("model_not_configured", "请先在网页页头选择分析模型与执行模型,再创建任务")
        }
        const task = await store.create({
          title: String(body.title ?? ""),
          description: body.description as string | undefined,
          projectId: typeof body.projectId === "string" ? body.projectId : undefined,
        })
        await emitSnapshot()
        return Response.json(task, { status: 201 })
      }
    }
    /**
     * 任务上下文：worker 会话消息分页（任务详情「上下文」标签数据源）。
     * - 读路径无鉴权：与会话内容同等敏感度，沿用 tasks/logs/SSE 既有姿态（127.0.0.1 绑定 + 写凭 token）；
     * - 会话数据源是 opencode 自身 SQLite，各实例同机只读即可，无需代理主实例；
     * - reader 未注入（如 dev 未接）或任务无会话（未领取/human claim）返回空页而非报错。
     */
    const ctxMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/context$/)
    if (ctxMatch && method === "GET") {
      const task = await store.get(decodeURIComponent(ctxMatch[1]))
      const sessionID = task.claim?.sessionID || null
      if (!sessionID || !opts.readContext) {
        return Response.json({ sessionID, total: 0, page: [], nextCursor: null, hasMore: false })
      }
      const url = new URL(req.url)
      const rawLimit = Number(url.searchParams.get("limit"))
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 200) : 50
      const cursor = url.searchParams.get("cursor") ?? undefined
      return Response.json(await opts.readContext({ sessionID, cursor, limit }))
    }
    if (pathname === "/api/claim" && method === "POST") {
      const bad = guard(req)
      if (bad) return bad
      const body = await readJson(req)
      const claimed = await store.claim({
        id: typeof body.id === "string" ? body.id : undefined,
        sessionID: String(body.sessionID ?? ""),
        agent: typeof body.agent === "string" ? body.agent : "agent",
      })
      await emitSnapshot()
      return Response.json(claimed)
    }
    const opMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/(analyze|complete|release|notes|usage)$/)
    if (opMatch && method === "POST") {
      const bad = guard(req)
      if (bad) return bad
      const body = await readJson(req)
      const id = decodeURIComponent(opMatch[1])
      const sessionID = String(body.sessionID ?? "")
      let task: Task
      switch (opMatch[2]) {
        case "analyze":
          task = await store.analyze({ id, sessionID, analysis: String(body.analysis ?? "") })
          break
        case "complete":
          task = await store.complete({
            id,
            sessionID,
            result: typeof body.result === "string" ? body.result : undefined,
          })
          break
        case "release":
          task = await store.release({ id, sessionID })
          break
        case "usage":
          // 消耗统计：主实例由派发器直连 store 回写（不经本路由），
          // 此处只为次要实例的代理链保持 Store 接口完整
          task = await store.recordUsage({ id, usage: body.usage as Task["usage"] })
          break
        default:
          task = await store.updateNotes({
            id,
            sessionID,
            analysis: typeof body.analysis === "string" ? body.analysis : undefined,
            result: typeof body.result === "string" ? body.result : undefined,
          })
      }
      await emitSnapshot()
      return Response.json(task)
    }
    const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/)
    if (taskMatch) {
      const id = decodeURIComponent(taskMatch[1])
      if (method === "GET") return Response.json(await store.get(id))
      if (method === "PATCH") {
        const bad = guard(req)
        if (bad) return bad
        const task = await store.patch(id, (await readJson(req)) as never)
        await emitSnapshot()
        return Response.json(task)
      }
      if (method === "DELETE") {
        const bad = guard(req, false)
        if (bad) return bad
        await store.remove(id)
        await emitSnapshot()
        return Response.json({ ok: true })
      }
    }
    return Response.json({ error: { code: "not_found", message: `未知 API 路径：${pathname}` } }, { status: 404 })
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port,
    // SSE 长连接守护：Bun 默认 idleTimeout=10s（无数据即断），而 SSE 心跳间隔 25s——
    // 每次空闲超 10s 连接就被服务端掐掉，浏览器表现为「重连中/实时」反复切换 + 点击无反应。
    // 255s 为 Bun 允许的最大值；心跳 25s < 255s，保活充分（终审后真实验收发现的根因）。
    idleTimeout: 255,
    async fetch(req) {
      const url = new URL(req.url)
      try {
        if (url.pathname.startsWith("/api/")) return await api(req, url.pathname)
        if (req.method === "GET") return await serveStatic(url.pathname)
        return Response.json({ error: { code: "not_found", message: "未知路径" } }, { status: 404 })
      } catch (e) {
        return errorResponse(e)
      }
    },
  })

  return {
    server,
    actualPort: server.port,
    stop: () => server.stop(true),
    emit,
  }
}
