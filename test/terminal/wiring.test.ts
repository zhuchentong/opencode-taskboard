import { describe, expect, test } from "bun:test"
import { arbitrate } from "../../src/index"
import { createStore, memoryBackend } from "../../src/store"
import { createTerminalBridge, type TerminalBridge } from "../../src/terminal"
import { createFakePty, createFakeRunCmd } from "./helpers"

const ARB_OPTS = {
  token: "tok",
  webDir: "test",
  projectID: "proj-term",
  log: () => {},
  logs: () => [] as string[],
  hooks: {},
}

function mkBridge(): { bridge: TerminalBridge; pty: ReturnType<typeof createFakePty> } {
  const pty = createFakePty()
  const bridge = createTerminalBridge({
    runCmd: createFakeRunCmd(),
    spawnPty: async () => pty,
    checkSession: async () => ({ ok: true, directory: "/tmp/work" }),
    discoverDaemon: async () => ({ url: "http://127.0.0.1:1", password: "pw-12345678" }),
    existsSync: () => true,
    homeDir: () => "/home/u",
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  })
  return { bridge, pty }
}

describe("终端桥装配（仅主实例）", () => {
  test("主实例注入终端桥 → 终端路由存在；次要实例不注入 → 404「终端功能未启用」", async () => {
    const { bridge } = mkBridge()
    const storeA = createStore(memoryBackend(), { requireAnalysisConfirm: false })
    const t = await storeA.create({ title: "有会话的任务" })
    await storeA.patch(t.id, { status: "pending" })
    await storeA.claim({ id: t.id, sessionID: "ses_terminal", agent: "build" })

    // 基准端口：A 当主
    const probe = Bun.serve({ port: 0, fetch: () => new Response("x") })
    const basePort = probe.port
    probe.stop(true)

    const A = await arbitrate({ ...ARB_OPTS, port: basePort, localStore: storeA, terminal: bridge })
    expect(A.primary).toBe(true)

    // 同端口再起一个 → 降级次要实例
    const storeB = createStore(memoryBackend(), { requireAnalysisConfirm: false })
    const B = await arbitrate({ ...ARB_OPTS, port: basePort, localStore: storeB, terminal: bridge })
    expect(B.primary).toBe(false)

    // 主实例：路由存在（错 token → 401，而不是「未启用」404）
    const aRes = await fetch(`http://127.0.0.1:${A.handle.actualPort}/api/tasks/${t.id}/terminal?token=bad`)
    expect(aRes.status).toBe(401)

    // 次要实例：终端功能未启用 → 404
    const bRes = await fetch(`http://127.0.0.1:${B.handle.actualPort}/api/tasks/${t.id}/terminal?token=tok`)
    expect(bRes.status).toBe(404)
    const body = (await bRes.json()) as { error: { message: string } }
    expect(body.error.message).toContain("终端功能未启用")

    A.handle.stop()
    B.handle.stop()
  })

  test("主实例的终端路由：任务无会话 → 404「任务尚无会话」（路由确实在）", async () => {
    const { bridge } = mkBridge()
    const store = createStore(memoryBackend(), { requireAnalysisConfirm: false })
    const t = await store.create({ title: "没会话" })

    const probe = Bun.serve({ port: 0, fetch: () => new Response("x") })
    const basePort = probe.port
    probe.stop(true)

    const A = await arbitrate({ ...ARB_OPTS, port: basePort, localStore: store, terminal: bridge })
    const res = await fetch(`http://127.0.0.1:${A.handle.actualPort}/api/tasks/${t.id}/terminal?token=tok`)
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { message: string } }
    expect(body.error.message).toContain("任务尚无会话")
    A.handle.stop()
  })
})
