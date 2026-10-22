import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { createStore, memoryBackend, type Store } from "../src/store"
import { createServer, type ServerEvent, type ServerHandle } from "../src/server"
import { SseReader } from "./helpers/sse-reader"

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
    projectID: "proj-test",
  })
  started.push(handle)
  return `http://127.0.0.1:${handle.actualPort}`
}

const H = { "X-Taskboard-Token": "tok123", "Content-Type": "application/json" }

function assertSnapshot(e: ServerEvent, msg: string): { tasks: { id: string; title: string }[]; settings: unknown } {
  if (e.type !== "snapshot") throw new Error(`${msg}：期望 snapshot 事件，实际 ${e.type}`)
  return e
}

/** 服务端清理可能存在异步传播，短暂轮询直到重连返回 200 */
async function expectReconnectOk(base: string, timeoutMs = 2000): Promise<Response> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const res = await fetch(`${base}/api/events`)
    if (res.status === 200) return res
    await res.body?.cancel()
    if (Date.now() > deadline) throw new Error(`断开后重连期望 200，实际 ${res.status}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

async function openStream(base: string, signal?: AbortSignal): Promise<Response> {
  return fetch(`${base}/api/events`, { signal, headers: { Accept: "text/event-stream" } })
}

describe("SSE 事件流", () => {
  test("连接即推 hello + 全量快照；写操作后广播 snapshot", async () => {
    const s = createStore(memoryBackend(), { requireAnalysisConfirm: false })
    const base = setup(s)
    // 建任务门禁:先配齐阶段模型
    await s.setSettings({ modelAnalyze: "test/analyze", modelExecute: "test/execute" })
    const ctrl = new AbortController()
    const res = await openStream(base, ctrl.signal)
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toContain("text/event-stream")

    const reader = new SseReader<ServerEvent>(res)
    expect(await reader.nextEvent()).toEqual({ type: "hello" })
    const init = assertSnapshot(await reader.nextEvent(), "连接快照")
    expect(init.tasks).toEqual([])
    expect(init.settings).toEqual({
      requireAnalysisConfirm: false,
      autoDispatch: true,
      modelAnalyze: "test/analyze",
      modelExecute: "test/execute",
    })

    const created = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ title: "广播任务" }),
    })
    expect(created.status).toBe(201)
    const afterCreate = assertSnapshot(await reader.nextEvent(), "创建任务后")
    expect(afterCreate.tasks.map((t) => t.title)).toContain("广播任务")

    await fetch(`${base}/api/settings`, {
      method: "PUT",
      headers: H,
      body: JSON.stringify({ requireAnalysisConfirm: true }),
    })
    const afterPut = assertSnapshot(await reader.nextEvent(), "更新设置后")
    expect(afterPut.settings).toEqual({
      requireAnalysisConfirm: true,
      autoDispatch: true,
      modelAnalyze: "test/analyze",
      modelExecute: "test/execute",
    })

    ctrl.abort()
  })

  test("第 33 个连接返回 503 JSON；全部断开后可重新订阅", async () => {
    const s = createStore(memoryBackend(), { requireAnalysisConfirm: false })
    const base = setup(s)
    const ctrls: AbortController[] = []
    for (let i = 0; i < 32; i++) {
      const ctrl = new AbortController()
      ctrls.push(ctrl)
      const res = await openStream(base, ctrl.signal)
      expect(res.status).toBe(200)
    }
    const res33 = await fetch(`${base}/api/events`)
    expect(res33.status).toBe(503)
    expect((await res33.json()) as { error: unknown }).toHaveProperty("error")

    for (const ctrl of ctrls) ctrl.abort()
    const again = await expectReconnectOk(base)
    expect(again.headers.get("Content-Type")).toContain("text/event-stream")
    await again.body?.cancel()
  })

  test("AbortController 中止后订阅计数恰好回落一个名额", async () => {
    const s = createStore(memoryBackend(), { requireAnalysisConfirm: false })
    const base = setup(s)
    const ctrls: AbortController[] = []
    for (let i = 0; i < 32; i++) {
      const ctrl = new AbortController()
      ctrls.push(ctrl)
      expect((await openStream(base, ctrl.signal)).status).toBe(200)
    }
    expect((await fetch(`${base}/api/events`)).status).toBe(503)

    ctrls[0].abort()
    const reentry = await expectReconnectOk(base)
    expect(reentry.status).toBe(200)

    // 名额已被重连占用，下一个连接仍应 503
    expect((await fetch(`${base}/api/events`)).status).toBe(503)
    await reentry.body?.cancel()
    for (const ctrl of ctrls) ctrl.abort()
  })

  test("webDir 缺失：GET / 与 /no-such 均 404 JSON；未知 API 路径行为不变", async () => {
    const s = createStore(memoryBackend(), { requireAnalysisConfirm: false })
    const handle = createServer(s, {
      port: 0,
      token: "tok123",
      webDir: "test/.no-such-webdir",
      primary: true,
      projectID: "proj-test",
    })
    started.push(handle)
    const base = `http://127.0.0.1:${handle.actualPort}`

    const r1 = await fetch(`${base}/`)
    expect(r1.status).toBe(404)
    expect((await r1.json()) as { error: unknown }).toHaveProperty("error")

    const r2 = await fetch(`${base}/no-such`)
    expect(r2.status).toBe(404)
    expect((await r2.json()) as { error: unknown }).toHaveProperty("error")

    const r3 = await fetch(`${base}/api/nope`)
    expect(r3.status).toBe(404)
    expect((await r3.json()) as { error: unknown }).toHaveProperty("error")
  })

  test("静态响应带 Cache-Control: no-cache", async () => {
    mkdirSync(FIXDIR, { recursive: true })
    writeFileSync(`${FIXDIR}/index.html`, "<html>ok</html>")
    writeFileSync(`${FIXDIR}/board.css`, "body{}")
    try {
      const s = createStore(memoryBackend(), { requireAnalysisConfirm: false })
      const base = setup(s)
      const r1 = await fetch(`${base}/`)
      expect(r1.status).toBe(200)
      expect(r1.headers.get("Cache-Control")).toBe("no-cache")

      const r2 = await fetch(`${base}/board.css`)
      expect(r2.status).toBe(200)
      expect(r2.headers.get("Cache-Control")).toBe("no-cache")
    } finally {
      rmSync(FIXDIR, { recursive: true, force: true })
    }
  })
})
