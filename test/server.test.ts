import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { createStore, memoryBackend } from "../src/store"
import { createServer, type ServerHandle } from "../src/server"
import type { Store } from "../src/types"

const FIXDIR = "test/.webroot-fixture"

const started: ServerHandle[] = []
afterEach(() => {
  while (started.length) started.pop()?.stop()
})

function setup(store: Store) {
  const handle = createServer(store, {
    port: 0,
    token: "tok123",
    webDir: FIXDIR,
    primary: true,
    logs: () => ["line-a", "line-b"],
  })
  started.push(handle)
  return `http://127.0.0.1:${handle.actualPort}`
}

const H = { "X-Taskboard-Token": "tok123", "Content-Type": "application/json" }

async function toCompletionConfirm(s: Store) {
  const t = await s.create({ title: "t" })
  await s.patch(t.id, { status: "pending" })
  await s.claim({ id: t.id, sessionID: "s1", agent: "build" })
  await s.analyze({ id: t.id, sessionID: "s1", analysis: "方案" })
  return s.complete({ id: t.id, sessionID: "s1", result: "完成" })
}

describe("REST API", () => {
  test("POST 创建 → 列表含之；PATCH 改标题", async () => {
    const s = createStore(memoryBackend(), { requireAnalysisConfirm: false })
    const base = setup(s)
    const r1 = await fetch(`${base}/api/tasks`, { method: "POST", headers: H, body: JSON.stringify({ title: "新任务" }) })
    expect(r1.status).toBe(201)
    const created = (await r1.json()) as { id: string; status: string }
    expect(created.status).toBe("planning")

    const r2 = await fetch(`${base}/api/tasks`, { method: "GET" })
    const list = (await r2.json()) as { id: string }[]
    expect(list.map((x) => x.id)).toContain(created.id)

    const r3 = await fetch(`${base}/api/tasks/${created.id}`, {
      method: "PATCH",
      headers: H,
      body: JSON.stringify({ title: "改名" }),
    })
    expect(((await r3.json()) as { title: string }).title).toBe("改名")
  })

  test("reject 无评论 → 400 comment_required；confirm 于 completion_confirm → done", async () => {
    const s = createStore(memoryBackend(), { requireAnalysisConfirm: false })
    const base = setup(s)
    const t = await toCompletionConfirm(s)

    const r1 = await fetch(`${base}/api/tasks/${t.id}`, {
      method: "PATCH",
      headers: H,
      body: JSON.stringify({ action: "reject" }),
    })
    expect(r1.status).toBe(400)
    expect(((await r1.json()) as { error: { code: string } }).error.code).toBe("comment_required")

    const r2 = await fetch(`${base}/api/tasks/${t.id}`, {
      method: "PATCH",
      headers: H,
      body: JSON.stringify({ action: "confirm" }),
    })
    expect(((await r2.json()) as { status: string }).status).toBe("done")
  })

  test("无 token → 403；token 对但非 JSON Content-Type → 415；GET 免 token", async () => {
    const s = createStore(memoryBackend(), { requireAnalysisConfirm: false })
    const base = setup(s)
    const r1 = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "x" }),
    })
    expect(r1.status).toBe(403)

    const r2 = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { "X-Taskboard-Token": "tok123", "Content-Type": "text/plain" },
      body: JSON.stringify({ title: "x" }),
    })
    expect(r2.status).toBe(415)

    const r3 = await fetch(`${base}/api/tasks`)
    expect(r3.status).toBe(200)
  })

  test("PUT settings 后 GET 返回新值且 store 行为改变", async () => {
    const s = createStore(memoryBackend(), { requireAnalysisConfirm: false })
    const base = setup(s)
    const r1 = await fetch(`${base}/api/settings`, {
      method: "PUT",
      headers: H,
      body: JSON.stringify({ requireAnalysisConfirm: true }),
    })
    expect(r1.status).toBe(200)

    const r2 = await fetch(`${base}/api/settings`)
    expect(((await r2.json()) as { requireAnalysisConfirm: boolean }).requireAnalysisConfirm).toBe(true)

    const t = await s.create({ title: "t" })
    await s.patch(t.id, { status: "pending" })
    await s.claim({ id: t.id, sessionID: "s1", agent: "build" })
    const r3 = await s.analyze({ id: t.id, sessionID: "s1", analysis: "a" })
    expect(r3.status).toBe("analysis_confirm")
  })

  test("health / logs / 未知 API 路径", async () => {
    const s = createStore(memoryBackend(), { requireAnalysisConfirm: false })
    const base = setup(s)
    const h = await (await fetch(`${base}/api/health`)).json()
    expect(h).toEqual({ ok: true, primary: true })
    const l = await (await fetch(`${base}/api/logs`)).json()
    expect(l).toEqual({ logs: ["line-a", "line-b"] })
    const r = await fetch(`${base}/api/nope`)
    expect(r.status).toBe(404)
    expect((await r.json()) as { error: unknown }).toHaveProperty("error")
  })

  test("StoreError 映射：not_found → 404", async () => {
    const s = createStore(memoryBackend(), { requireAnalysisConfirm: false })
    const base = setup(s)
    const r = await fetch(`${base}/api/tasks/task_nope`, { method: "PATCH", headers: H, body: JSON.stringify({ title: "x" }) })
    expect(r.status).toBe(404)
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("not_found")
  })
})

describe("工具操作代理路由", () => {
  async function setupStore() {
    const s = createStore(memoryBackend(), { requireAnalysisConfirm: false })
    const base = setup(s)
    return { s, base }
  }

  test("POST /api/claim 无 id 领最旧 pending；analyze/complete 闭环", async () => {
    const { s, base } = await setupStore()
    for (const title of ["甲", "乙"]) {
      const t = await s.create({ title })
      await s.patch(t.id, { status: "pending" })
    }
    const pend = (await (await fetch(`${base}/api/tasks`)).json()) as { id: string }[]

    const r1 = await fetch(`${base}/api/claim`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ sessionID: "sess-1" }),
    })
    expect(r1.status).toBe(200)
    const claimed = (await r1.json()) as { id: string; status: string }
    expect(claimed.status).toBe("analyzing")
    expect(pend.map((p) => p.id)).toContain(claimed.id)

    const r2 = await fetch(`${base}/api/tasks/${claimed.id}/analyze`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ sessionID: "sess-1", analysis: "方案" }),
    })
    expect(((await r2.json()) as { status: string }).status).toBe("executing")

    const r3 = await fetch(`${base}/api/tasks/${claimed.id}/complete`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ sessionID: "sess-1", result: "ok" }),
    })
    expect(((await r3.json()) as { status: string }).status).toBe("completion_confirm")
  })

  test("release 与 notes 路由；未领取者 → 400 not_claimer", async () => {
    const { s, base } = await setupStore()
    const t = await s.create({ title: "t" })
    await s.patch(t.id, { status: "pending" })

    const r0 = await fetch(`${base}/api/tasks/${t.id}/analyze`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ sessionID: "nobody", analysis: "x" }),
    })
    expect(r0.status).toBe(400)
    expect(((await r0.json()) as { error: { code: string } }).error.code).toBe("invalid_transition")

    await fetch(`${base}/api/claim`, { method: "POST", headers: H, body: JSON.stringify({ sessionID: "sess-9" }) })

    const r1 = await fetch(`${base}/api/tasks/${t.id}/analyze`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ sessionID: "nobody", analysis: "x" }),
    })
    expect(r1.status).toBe(400)
    expect(((await r1.json()) as { error: { code: string } }).error.code).toBe("not_claimer")

    await fetch(`${base}/api/claim`, { method: "POST", headers: H, body: JSON.stringify({ sessionID: "sess-9" }) })
    const rn = await fetch(`${base}/api/tasks/${t.id}/notes`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ sessionID: "sess-9", result: "进度 30%" }),
    })
    expect(((await rn.json()) as { result: string }).result).toBe("进度 30%")

    const rr = await fetch(`${base}/api/tasks/${t.id}/release`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ sessionID: "sess-9" }),
    })
    expect(((await rr.json()) as { status: string; claim: unknown }).status).toBe("pending")
  })
})

describe("静态页", () => {
  test("GET / 注入 token；不存在文件 404 JSON", async () => {
    mkdirSync(FIXDIR, { recursive: true })
    writeFileSync(`${FIXDIR}/index.html`, "<html>TOKEN=__TASKBOARD_TOKEN__</html>")
    try {
      const s = createStore(memoryBackend(), { requireAnalysisConfirm: false })
      const base = setup(s)
      const r = await fetch(`${base}/`)
      const body = await r.text()
      expect(body).toContain("TOKEN=tok123")
      expect(body).not.toContain("__TASKBOARD_TOKEN__")

      const r2 = await fetch(`${base}/no-such.js`)
      expect(r2.status).toBe(404)
      expect((await r2.json()) as { error: unknown }).toHaveProperty("error")
    } finally {
      rmSync(FIXDIR, { recursive: true, force: true })
    }
  })
})
