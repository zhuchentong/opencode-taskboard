import { describe, expect, test } from "bun:test"
import { createStore, memoryBackend } from "../src/store"
import { createServer, type ServerHandle } from "../src/server"
import { clientStore } from "../src/client"

describe("clientStore（HTTP Store 实现）", () => {
  test("完整闭环经 HTTP 与本地 store 等价；错误映射为 StoreError", async () => {
    const backend = createStore(memoryBackend(), { requireAnalysisConfirm: false })
    const handle: ServerHandle = createServer(backend, {
      port: 0,
      token: "tok",
      webDir: "test",
      primary: true,
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

      await s.setSettings({ requireAnalysisConfirm: true })
      expect(await s.getSettings()).toEqual({ requireAnalysisConfirm: true, autoDispatch: false })

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
})
