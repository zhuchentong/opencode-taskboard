import { describe, expect, test } from "bun:test"
import { shouldProxy, safeRegister, arbitrate } from "../src/index"
import { createStore, memoryBackend } from "../src/store"

describe("shouldProxy（端口仲裁：仅同项目主实例才降级为次要实例）", () => {
  test("同项目主实例 → 代理", () => {
    expect(shouldProxy({ ok: true, projectID: "p1" }, "p1")).toBe(true)
  })
  test("不同项目 → 不代理（上移端口当主实例）", () => {
    expect(shouldProxy({ ok: true, projectID: "p2" }, "p1")).toBe(false)
  })
  test("health 无 projectID（旧版本/异构服务）→ 不代理", () => {
    expect(shouldProxy({ ok: true }, "p1")).toBe(false)
  })
  test("非 taskboard 服务 → 不代理", () => {
    expect(shouldProxy({ ok: false }, "p1")).toBe(false)
    expect(shouldProxy({ hello: "world" }, "p1")).toBe(false)
  })
})

describe("safeRegister（注册失败时停掉已绑定的服务）", () => {
  test("全部成功 → 不停服", async () => {
    let stopped = false
    await safeRegister({ stop: () => (stopped = true) }, [async () => 1, async () => 2])
    expect(stopped).toBe(false)
  })
  test("中途抛错 → 停服且异常继续上抛", async () => {
    let stopped = false
    const boom = new Error("register failed")
    try {
      await safeRegister({ stop: () => (stopped = true) }, [
        async () => 1,
        async () => {
          throw boom
        },
      ])
      expect.unreachable()
    } catch (e) {
      expect(e).toBe(boom)
    }
    expect(stopped).toBe(true)
  })
})

describe("arbitrate（忙端口探测：杜绝同项目双主）", () => {
  const ARB_OPTS = {
    token: "tok",
    webDir: "test",
    projectID: "proj-arb",
    log: () => {},
    logs: () => [] as string[],
    hooks: {},
  }
  const mkStore = () => createStore(memoryBackend(), { requireAnalysisConfirm: false })

  test("基准端口异构占用 → 首实例上移当主；第二实例探测到同项目主实例后降级代理", async () => {
    const foreign = Bun.serve({ port: 0, fetch: () => new Response("foreign") })
    try {
      const A = await arbitrate({ ...ARB_OPTS, port: foreign.port, localStore: mkStore() })
      expect(A.primary).toBe(true)
      expect(A.primaryPort).toBeGreaterThan(foreign.port)

      const B = await arbitrate({ ...ARB_OPTS, port: foreign.port, localStore: mkStore() })
      expect(B.primary).toBe(false)
      // B 的写必须落到 A 的存储（代理目标是被上移的 A，不是基准端口）
      const t = await B.store.create({ title: "经 B 写" })
      expect((await A.store.list()).map((x) => x.id)).toContain(t.id)
      const health = await (await fetch(`http://127.0.0.1:${B.handle.actualPort}/api/health`)).json()
      expect(health).toMatchObject({ ok: true, primary: false, projectID: "proj-arb" })
      A.handle.stop()
      B.handle.stop()
    } finally {
      foreign.stop(true)
    }
  })

  test("异构服务占用基准与首个溢出端口 → 主实例跳过继续上移", async () => {
    const foreign = Bun.serve({ port: 0, fetch: () => new Response("f") })
    let squatter: Bun.Server | undefined
    try {
      for (let attempt = 0; attempt < 10 && !squatter; attempt++) {
        const p = foreign.port + 1 + attempt
        try {
          squatter = Bun.serve({ port: p, fetch: () => new Response("s") })
        } catch {
          // 被占，换下一个
        }
      }
      const A = await arbitrate({ ...ARB_OPTS, port: foreign.port, projectID: "proj-arb2", localStore: mkStore() })
      expect(A.primary).toBe(true)
      expect(A.primaryPort).toBeGreaterThanOrEqual(squatter!.port + 1)
      A.handle.stop()
    } finally {
      foreign.stop(true)
      squatter?.stop(true)
    }
  })

  test("基准端口空闲 → 直接当主（回归）", async () => {
    const free = Bun.serve({ port: 0, fetch: () => new Response("x") })
    const port = free.port
    free.stop(true)
    const A = await arbitrate({ ...ARB_OPTS, port, projectID: "proj-arb3", localStore: mkStore() })
    expect(A.primary).toBe(true)
    expect(A.primaryPort).toBe(port)
    A.handle.stop()
  })
})
