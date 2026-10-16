import { describe, expect, test } from "bun:test"
import { shouldProxy, safeRegister } from "../src/index"

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
