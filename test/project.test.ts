import { describe, expect, test } from "bun:test"
import { createStore, memoryBackend } from "../src/store"
import { DEFAULT_PROJECT_ID, StoreError } from "../src/types"

const S = (opts?: { directory?: string }) =>
  createStore(memoryBackend(), { requireAnalysisConfirm: false, ...opts })

const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => "no-error",
    (e) => (e instanceof StoreError ? e.code : `unknown:${e}`),
  )

describe("项目 CRUD 与合成默认项目", () => {
  test("listProjects 首项为合成默认项目,不传 directory 时 workspace 显示占位", async () => {
    const ps = await S().listProjects()
    expect(ps[0]).toMatchObject({
      id: DEFAULT_PROJECT_ID,
      name: "默认项目",
      builtin: true,
      workspace: "(未配置)",
      createdAt: 0,
      updatedAt: 0,
    })
  })

  test("传 directory 时合成默认项目 workspace 取该值", async () => {
    const ps = await S({ directory: "/proj" }).listProjects()
    expect(ps[0].workspace).toBe("/proj")
    expect(ps[0].builtin).toBe(true)
  })

  test("getProject(DEFAULT_PROJECT_ID) 返回合成值(存储为空也可取)", async () => {
    const p = await S({ directory: "/proj" }).getProject(DEFAULT_PROJECT_ID)
    expect(p.id).toBe(DEFAULT_PROJECT_ID)
    expect(p.workspace).toBe("/proj")
  })

  test("createProject 返回完整实体且 listProjects 可见(id 前缀 project_)", async () => {
    const s = S()
    const p = await s.createProject({ name: "网关", workspace: "/repos/gateway", description: "API 网关" })
    expect(p.id.startsWith("project_")).toBe(true)
    expect(p.name).toBe("网关")
    expect(p.workspace).toBe("/repos/gateway")
    expect(p.description).toBe("API 网关")
    expect(p.builtin).toBeUndefined()
    expect(p.createdAt).toBeGreaterThan(0)
    const ps = await s.listProjects()
    expect(ps).toHaveLength(2)
    expect(ps[0].id).toBe(DEFAULT_PROJECT_ID) // 合成默认恒打头
    expect(ps[1].id).toBe(p.id)
  })

  test("重名创建 conflict", async () => {
    const s = S()
    await s.createProject({ name: "A", workspace: "/a" })
    expect(await codeOf(s.createProject({ name: "A", workspace: "/b" }))).toBe("conflict")
  })

  test("name 空白 invalid_input", async () => {
    expect(await codeOf(S().createProject({ name: "   ", workspace: "/a" }))).toBe("invalid_input")
  })

  test("updateProject 改名/改描述;重名(他人)conflict;改回自己原名放行", async () => {
    const s = S()
    const a = await s.createProject({ name: "A", workspace: "/a" })
    await s.createProject({ name: "B", workspace: "/b" })
    const renamed = await s.updateProject(a.id, { name: "A2", description: "新描述" })
    expect(renamed.name).toBe("A2")
    expect(renamed.description).toBe("新描述")
    expect(await codeOf(s.updateProject(a.id, { name: "B" }))).toBe("conflict")
    await s.updateProject(a.id, { name: "A2" }) // 改回自己当前名,放行
    expect((await s.getProject(a.id)).name).toBe("A2")
  })

  test("updateProject 作用于默认项目 → invalid_input;项目不存在 → not_found", async () => {
    const s = S()
    expect(await codeOf(s.updateProject(DEFAULT_PROJECT_ID, { name: "X" }))).toBe("invalid_input")
    expect(await codeOf(s.updateProject("project_missing", { name: "X" }))).toBe("not_found")
  })

  test("deleteProject 作用于默认项目 → invalid_input;项目不存在 → not_found;存在项目可直删", async () => {
    const s = S()
    expect(await codeOf(s.deleteProject(DEFAULT_PROJECT_ID))).toBe("invalid_input")
    expect(await codeOf(s.deleteProject("project_missing"))).toBe("not_found")
    const p = await s.createProject({ name: "临时", workspace: "/t" })
    await s.deleteProject(p.id)
    expect(await codeOf(s.getProject(p.id))).toBe("not_found")
    expect((await s.listProjects()).map((x) => x.name)).toEqual(["默认项目"])
  })
})
