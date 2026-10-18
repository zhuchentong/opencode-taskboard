import { describe, expect, test } from "bun:test"
import { badgeHue, normalizeProjectId, projectFilterOptions, projectMap } from "../src/lib/project-options"
import { DEFAULT_PROJECT_ID, type Project, type Task } from "../src/lib/types"

const P = (id: string, name: string): Project => ({ id, name, workspace: "/w", createdAt: 1, updatedAt: 1 })
const T = (id: string, projectId?: string, status: Task["status"] = "pending"): Task => ({
  id,
  title: id,
  description: "",
  status,
  comments: [],
  projectId,
  createdAt: 1,
  updatedAt: 1,
})

describe("projectFilterOptions", () => {
  test("首项「全部」count=未完结总数;其余按传入顺序 count=各自未完结数", () => {
    const projects = [P(DEFAULT_PROJECT_ID, "默认项目"), P("project_a", "A")]
    const tasks = [
      T("1"),
      T("2", DEFAULT_PROJECT_ID),
      T("3", "project_a"),
      T("4", "project_a", "done"), // done 不计
    ]
    const opts = projectFilterOptions(projects, tasks)
    expect(opts[0]).toEqual({ id: "", label: "全部", count: 3 })
    expect(opts[1]).toEqual({ id: DEFAULT_PROJECT_ID, label: "默认项目", count: 2 })
    expect(opts[2]).toEqual({ id: "project_a", label: "A", count: 1 })
  })

  test("空任务表 → 各项目 count=0;projects 缺省只有默认项目", () => {
    const opts = projectFilterOptions([P(DEFAULT_PROJECT_ID, "默认项目")], [])
    expect(opts).toEqual([
      { id: "", label: "全部", count: 0 },
      { id: DEFAULT_PROJECT_ID, label: "默认项目", count: 0 },
    ])
  })
})

describe("badgeHue", () => {
  test("确定性(同输入同输出)且落在 0-359", () => {
    expect(badgeHue("网关")).toBe(badgeHue("网关"))
    for (const n of ["网关", "a", "很长很长的项目名称也一样"]) {
      const h = badgeHue(n)
      expect(h).toBeGreaterThanOrEqual(0)
      expect(h).toBeLessThanOrEqual(359)
    }
  })
})

describe("normalizeProjectId", () => {
  test("缺省回 DEFAULT_PROJECT_ID;有值原样", () => {
    expect(normalizeProjectId({})).toBe(DEFAULT_PROJECT_ID)
    expect(normalizeProjectId({ projectId: "project_x" })).toBe("project_x")
  })
})

describe("projectMap", () => {
  test("以 id 为键", () => {
    const m = projectMap([P("project_a", "A")])
    expect(m.get("project_a")?.name).toBe("A")
    expect(m.get("project_missing")).toBeUndefined()
  })
})
