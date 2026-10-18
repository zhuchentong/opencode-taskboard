import { join } from "node:path"
import { StoreError } from "./types"
import type { BoardSettings, Store, Task } from "./types"

export type ServerEvent = { type: "hello" } | { type: "snapshot"; tasks: Task[]; settings: BoardSettings }

export interface ServerHandle {
  server: Bun.Server
  actualPort: number
  stop(): void
  emit(event: ServerEvent): void
}

const SSE_HEARTBEAT_MS = 25_000
const MAX_SSE_SUBSCRIBERS = 32

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
    emit({ type: "snapshot", tasks, settings: await store.getSettings() })
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
    if (pathname === "/api/tasks") {
      if (method === "GET") return Response.json(await store.list())
      if (method === "POST") {
        const bad = guard(req)
        if (bad) return bad
        const body = await readJson(req)
        const task = await store.create({ title: String(body.title ?? ""), description: body.description as string | undefined })
        await emitSnapshot()
        return Response.json(task, { status: 201 })
      }
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
