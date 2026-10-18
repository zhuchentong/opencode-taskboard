import { describe, expect, test } from "bun:test"
import {
  applySnapshot,
  beginOptimistic,
  emptyState,
  settle,
  visibleTasks,
} from "../src/lib/optimistic"
import type { Task } from "../src/lib/types"

// 工厂：全字段必填，analysis/result/claim 可选注入
function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    title: "任务一",
    description: "任务描述",
    status: "planning",
    comments: [],
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  }
}

const settings = { requireAnalysisConfirm: true }

describe("乐观更新协议状态机", () => {
  test("emptyState：空服务器快照 + 保存 settings + 无在途遮罩", () => {
    const state = emptyState(settings)
    expect(state.server).toEqual([])
    expect(state.settings).toEqual(settings)
    expect(state.pending.size).toBe(0)
    expect(visibleTasks(state)).toEqual([])
  })

  // 规则 ①：applySnapshot 先落 server 与 settings，visibleTasks 对有 pending 的任务用遮罩覆盖合成视图
  test("在途写期间服务器回流不覆盖遮罩字段（不闪烁）", () => {
    let state = emptyState(settings)
    state = applySnapshot(state, [makeTask()], settings)
    state = beginOptimistic(state, "t1", { status: "executing" })

    // 在途写尚未落库，服务器回流仍是旧值
    state = applySnapshot(state, [makeTask()], settings)

    expect(state.server[0]!.status).toBe("planning") // 事实源保持服务器值
    const view = visibleTasks(state)
    expect(view[0]!.status).toBe("executing") // 合成视图用遮罩
  })

  test("无 pending 的任务直接使用服务器值；applySnapshot 同步更新 settings", () => {
    let state = emptyState(settings)
    const serverTasks = [makeTask({ id: "t1" }), makeTask({ id: "t2", status: "analyzing" })]
    state = applySnapshot(state, serverTasks, settings)
    state = beginOptimistic(state, "t1", { status: "executing" })

    const otherSettings = { requireAnalysisConfirm: false }
    state = applySnapshot(state, serverTasks, otherSettings)
    expect(state.settings).toEqual(otherSettings)

    const view = visibleTasks(state)
    expect(view.find((t) => t.id === "t1")!.status).toBe("executing") // 有遮罩
    expect(view.find((t) => t.id === "t2")!.status).toBe("analyzing") // 无遮罩，直接服务器值
  })

  // 规则 ②：写成功流——快照到达（与遮罩一致）→ settle(true) 摘遮罩，视图=服务器值
  test("写成功：settle(true) 摘除遮罩，视图回到服务器值", () => {
    let state = emptyState(settings)
    state = applySnapshot(state, [makeTask()], settings)
    state = beginOptimistic(state, "t1", { status: "executing" })

    // 服务器确认写入，回流新快照（与遮罩一致，且带服务器侧 updatedAt）
    state = applySnapshot(state, [makeTask({ status: "executing", updatedAt: 2000 })], settings)
    state = settle(state, "t1", true)

    expect(state.pending.size).toBe(0)
    const view = visibleTasks(state)
    expect(view[0]!.status).toBe("executing")
    expect(view[0]!.updatedAt).toBe(2000) // 来自服务器，不再依赖遮罩
  })

  // 规则 ③：写失败流——settle(false) 回滚到 server 最近快照，不是本地旧值
  test("写失败：drop 撞 invalid_transition，回滚到服务器态（含 Agent 新 claim）", () => {
    let state = emptyState(settings)
    const localClaim = { sessionID: "s-local", agent: "本地旧值", claimedAt: 100 }
    state = applySnapshot(state, [makeTask({ claim: localClaim })], settings)

    // 本地拖拽：乐观把任务移到 executing
    state = beginOptimistic(state, "t1", { status: "executing" })

    // 在途期间 Agent 认领了任务，服务器快照 claim 已变；随后 drop 返回 invalid_transition
    const agentClaim = { sessionID: "s-agent", agent: "Agent", claimedAt: 200 }
    state = applySnapshot(state, [makeTask({ claim: agentClaim })], settings)
    expect(visibleTasks(state)[0]!.status).toBe("executing") // 失败前视图仍是乐观值

    state = settle(state, "t1", false)

    const view = visibleTasks(state)
    expect(view[0]!.status).toBe("planning") // 回到服务器态，非本地旧值
    expect(view[0]!.claim).toEqual(agentClaim) // claim 是服务器新值，非本地旧 claim
    expect(state.pending.size).toBe(0)
  })

  // 规则 ④：多任务并发互不影响
  test("A 在途时，B 的快照更新与 settle 正常且不影响 A", () => {
    let state = emptyState(settings)
    state = applySnapshot(
      state,
      [makeTask({ id: "a" }), makeTask({ id: "b", status: "analyzing" })],
      settings,
    )
    state = beginOptimistic(state, "a", { status: "executing" })

    // Agent 改了 B，快照回流
    state = applySnapshot(
      state,
      [makeTask({ id: "a" }), makeTask({ id: "b", status: "completion_confirm" })],
      settings,
    )
    let view = visibleTasks(state)
    expect(view.find((t) => t.id === "a")!.status).toBe("executing") // A 遮罩仍在
    expect(view.find((t) => t.id === "b")!.status).toBe("completion_confirm") // B 用新快照

    // B 的写成功 settle，不影响 A 的在途遮罩
    state = settle(state, "b", true)
    view = visibleTasks(state)
    expect(view.find((t) => t.id === "a")!.status).toBe("executing")
    expect(state.pending.has("a")).toBe(true)
    expect(state.pending.has("b")).toBe(false)
  })

  // 规则 ⑤：字段级合并 + 边界
  test("同任务连续两次 beginOptimistic：字段级合并，后者覆盖前者", () => {
    let state = emptyState(settings)
    state = applySnapshot(state, [makeTask()], settings)
    state = beginOptimistic(state, "t1", { status: "executing" })
    state = beginOptimistic(state, "t1", { title: "新标题" })

    const view = visibleTasks(state)
    expect(view[0]!.status).toBe("executing") // 第一次的字段保留
    expect(view[0]!.title).toBe("新标题") // 后者字段覆盖
  })

  test("settle 未知 taskId 容错返回原态", () => {
    let state = emptyState(settings)
    state = applySnapshot(state, [makeTask()], settings)
    const settled = settle(state, "ghost", true)
    expect(settled).toBe(state)
  })

  test("visibleTasks 对 server 里不存在的 taskId 忽略遮罩", () => {
    let state = emptyState(settings)
    state = applySnapshot(state, [], settings)
    state = beginOptimistic(state, "ghost", { status: "executing" })
    expect(visibleTasks(state)).toEqual([])
  })

  test("不可变更新：每函数返回新对象，入参不被修改", () => {
    const s0 = emptyState(settings)
    const tasks = [makeTask()]

    const s1 = applySnapshot(s0, tasks, settings)
    const s2 = beginOptimistic(s1, "t1", { status: "executing" })
    const s3 = applySnapshot(s2, tasks, settings) // 在途时快照回流，遮罩应保留
    const s4 = settle(s3, "t1", true)

    expect(s0.server).toEqual([]) // s0 未被污染
    expect(s0.pending.size).toBe(0)
    expect(s1.pending.size).toBe(0) // s1 未被 beginOptimistic 改掉
    expect(s2.pending.size).toBe(1)
    expect(s3.pending.size).toBe(1) // s2 未被 applySnapshot 清掉遮罩
    expect(s4.pending.size).toBe(0)
    expect(s1).not.toBe(s0)
    expect(s2).not.toBe(s1)
    expect(s3).not.toBe(s2)
    expect(s4).not.toBe(s3)
  })

  describe("projects 维度", () => {
    const proj = { id: "project_a", name: "A", workspace: "/a", createdAt: 1, updatedAt: 1 }

    test("emptyState 携带空项目清单;applySnapshot 第四参落 state.projects", () => {
      let state = emptyState(settings)
      expect(state.projects).toEqual([])
      state = applySnapshot(state, [makeTask()], settings, [proj])
      expect(state.projects).toEqual([proj])
      // 再次快照更新 projects(替换,非合并)
      state = applySnapshot(state, [makeTask()], settings, [])
      expect(state.projects).toEqual([])
    })

    test("applySnapshot 缺第四参时保留现有 projects(向后兼容旧调用方)", () => {
      let state = emptyState(settings, [proj])
      state = applySnapshot(state, [makeTask()], settings)
      expect(state.projects).toEqual([proj])
    })
  })
})
