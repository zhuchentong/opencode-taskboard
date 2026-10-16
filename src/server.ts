import { join } from "node:path"
import { StoreError } from "./types"
import type { Store } from "./types"

export interface ServerHandle {
  server: Bun.Server
  actualPort: number
  stop(): void
}

const STATUS_BY_CODE: Record<string, number> = {
  not_found: 404,
  invalid_transition: 400,
  conflict: 400,
  not_claimer: 400,
  comment_required: 400,
  no_pending: 400,
  invalid_input: 400,
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
  opts: { port: number; token: string; webDir: string; primary: boolean; logs?: () => readonly string[] },
): ServerHandle {
  const { token, webDir } = opts

  const guard = (req: Request): Response | undefined => {
    if (req.headers.get("X-Taskboard-Token") !== token) {
      return Response.json({ error: { code: "forbidden", message: "缺少或错误的访问令牌" } }, { status: 403 })
    }
    const ct = req.headers.get("Content-Type") ?? ""
    if (!ct.includes("application/json")) {
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
      const html = (await f.text()).replaceAll("__TASKBOARD_TOKEN__", token)
      return new Response(html, { headers: { "Content-Type": MIME[".html"] } })
    }
    const ext = rel.slice(rel.lastIndexOf(".")).toLowerCase()
    return new Response(f, { headers: { "Content-Type": MIME[ext] ?? "application/octet-stream" } })
  }

  async function api(req: Request, pathname: string): Promise<Response> {
    const method = req.method
    if (pathname === "/api/health") {
      return Response.json({ ok: true, primary: opts.primary })
    }
    if (pathname === "/api/logs") {
      return Response.json({ logs: opts.logs?.() ?? [] })
    }
    if (pathname === "/api/settings") {
      if (method === "GET") return Response.json(await store.getSettings())
      if (method === "PUT") {
        const bad = guard(req)
        if (bad) return bad
        await store.setSettings((await readJson(req)) as never)
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
        return Response.json(task, { status: 201 })
      }
    }
    if (pathname === "/api/claim" && method === "POST") {
      const bad = guard(req)
      if (bad) return bad
      const body = await readJson(req)
      return Response.json(
        await store.claim({
          id: typeof body.id === "string" ? body.id : undefined,
          sessionID: String(body.sessionID ?? ""),
          agent: typeof body.agent === "string" ? body.agent : "agent",
        }),
      )
    }
    const opMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/(analyze|complete|release|notes)$/)
    if (opMatch && method === "POST") {
      const bad = guard(req)
      if (bad) return bad
      const body = await readJson(req)
      const id = decodeURIComponent(opMatch[1])
      const sessionID = String(body.sessionID ?? "")
      switch (opMatch[2]) {
        case "analyze":
          return Response.json(await store.analyze({ id, sessionID, analysis: String(body.analysis ?? "") }))
        case "complete":
          return Response.json(
            await store.complete({ id, sessionID, result: typeof body.result === "string" ? body.result : undefined }),
          )
        case "release":
          return Response.json(await store.release({ id, sessionID }))
        case "notes":
          return Response.json(
            await store.updateNotes({
              id,
              sessionID,
              analysis: typeof body.analysis === "string" ? body.analysis : undefined,
              result: typeof body.result === "string" ? body.result : undefined,
            }),
          )
      }
    }
    const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/)
    if (taskMatch) {
      const id = decodeURIComponent(taskMatch[1])
      if (method === "PATCH") {
        const bad = guard(req)
        if (bad) return bad
        return Response.json(await store.patch(id, (await readJson(req)) as never))
      }
      if (method === "DELETE") {
        const bad = guard(req)
        if (bad) return bad
        await store.remove(id)
        return Response.json({ ok: true })
      }
    }
    return Response.json({ error: { code: "not_found", message: `未知 API 路径：${pathname}` } }, { status: 404 })
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port,
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
  }
}
