import { describe, expect, test } from "bun:test"
import { createStore, memoryBackend } from "../src/store"
import { createServer, type ServerHandle } from "../src/server"
import { clientStore } from "../src/client"
import { DEFAULT_PROJECT_ID } from "../src/types"

describe("clientStore（HTTP Store 实现）", () => {
  test("完整闭环经 HTTP 与本地 store 等价；错误映射为 StoreError", async () => {
    const backend = createStore(memoryBackend(), { requireAnalysisConfirm: false })
    // 建任务门禁:先配齐阶段模型
    await backend.setSettings({ modelAnalyze: "test/analyze", modelExecute: "test/execute" })
    const handle: ServerHandle = createServer(backend, {
      port: 0,
      token: "tok",
      webDir: "test",
      primary: true,
      projectID: "proj-client",
    })
    try {
      const s = clientStore(`http://127.0.0.1:${handle.actualPort}`, "tok")

      const t = await s.create({ title: "远程任务" })
      expect(t.status).toBe("planning")
      await s.patch(t.id, { status: "pending" })
      const claimed = await s.claim({ sessionID: "s1", agent: "build" })
      expect(claimed.status).toBe("analyzing")
      const done = await s.analyze({ id: t.id, sessionID: "s1", analysis: "a" })
      expect(done.status).toBe("executing")
      await s.complete({ id: t.id, sessionID: "s1", result: "r" })
      const rejected = await s.patch(t.id, { action: "reject", comment: "返工" })
      expect(rejected.status).toBe("pending")

      expect((await s.get(t.id)).comments).toHaveLength(1)
      expect((await s.list()).map((x) => x.id)).toContain(t.id)

      const proj = await s.createProject({ name: "远程项目", workspace: process.cwd() })
      expect(proj.id.startsWith("project_")).toBe(true)
      const ps = await s.listProjects()
      expect(ps[0].id).toBe(DEFAULT_PROJECT_ID)
      expect(ps.map((x) => x.name)).toContain("远程项目")

      await s.setSettings({ requireAnalysisConfirm: true })
      expect(await s.getSettings()).toEqual({
        requireAnalysisConfirm: true,
        autoDispatch: true,
        modelAnalyze: "test/analyze",
        modelExecute: "test/execute",
      })

      await s.release({ id: t.id, sessionID: "s1" }).catch(() => undefined)
      try {
        await s.claim({ id: "task_nope", sessionID: "s1", agent: "build" })
        expect.unreachable()
      } catch (e) {
        expect((e as { code?: string }).code).toBe("not_found")
      }
    } finally {
      handle.stop()
    }
  })

  test("连接拒绝 → unreachable；响应悬挂 → 超时归一为 unreachable", async () => {
    // 连接拒绝：先起后停，拿到确定拒绝的端口
    const dead = Bun.serve({ port: 0, fetch: () => new Response("x") })
    const deadPort = dead.port
    dead.stop(true)
    const s1 = clientStore(`http://127.0.0.1:${deadPort}`, "t")
    try { await s1.list(); expect.unreachable() } catch (e) { expect((e as { code?: string }).code).toBe("unreachable") }

    // 响应悬挂：服务延迟 300ms，客户端超时 50ms
    const slow = Bun.serve({ port: 0, fetch: async () => { await Bun.sleep(300); return Response.json([]) } })
    try {
      const s2 = clientStore(`http://127.0.0.1:${slow.port}`, "t", { timeoutMs: 50 })
      try { await s2.list(); expect.unreachable() } catch (e) { expect((e as { code?: string }).code).toBe("unreachable") }
    } finally { slow.stop(true) }
  })

  test("服务端未知错误码还原为 conflict；forbidden 保留语义", async () => {
    const weird = Bun.serve({ port: 0, fetch: () => Response.json({ error: { code: "weird", message: "怪码" } }, { status: 400 }) })
    try {
      const s = clientStore(`http://127.0.0.1:${weird.port}`, "t")
      try { await s.list(); expect.unreachable() } catch (e) {
        expect((e as { code?: string }).code).toBe("conflict")
        expect((e as { message?: string }).message).toContain("怪码")
      }
    } finally { weird.stop(true) }

    const deny = Bun.serve({ port: 0, fetch: () => Response.json({ error: { code: "forbidden", message: "令牌错" } }, { status: 403 }) })
    try {
      const s = clientStore(`http://127.0.0.1:${deny.port}`, "t")
      try { await s.list(); expect.unreachable() } catch (e) { expect((e as { code?: string }).code).toBe("forbidden") }
    } finally { deny.stop(true) }
  })
})
