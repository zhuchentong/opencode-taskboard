// 阶段模型(分析/执行分模型)行为:advance 唤醒按规则选模型、pool 派发用分析模型、
// engine 从看板设置动态解析两阶段模型
import { describe, expect, test } from "bun:test"
import { makeBuiltinRules, runAdvance, BUILTIN_RULES } from "../src/dispatcher/advance"
import { createSessionPool } from "../src/dispatcher/session-pool"
import { initDispatcher, type DispatcherSession } from "../src/dispatcher/index"
import { createStore, memoryBackend, type Store } from "../src/store"
import type { Task } from "../src/types"
import type { TaskTransition } from "../src/dispatcher/types"

const taskOf = (over: Partial<Task> = {}): Task => ({
  id: "t1",
  title: "阶段模型任务",
  description: "",
  status: "executing",
  comments: [],
  claim: { sessionID: "ses_w1", agent: "build", claimedAt: 0 },
  ...over,
})

const along = (seq: number, to: Task["status"], from: Task["status"] = "analysis_confirm"): TaskTransition => ({
  taskID: "t1",
  from,
  to,
  seq,
})

function fakeSession() {
  const prompts: { sessionID: string; text: string; model?: unknown }[] = []
  const created: { model?: unknown }[] = []
  const session: DispatcherSession = {
    create: async (input?: { model?: unknown }) => {
      created.push({ model: input?.model })
      return { id: "ses_new" }
    },
    get: async () => ({}),
    prompt: async (input) => {
      prompts.push(input)
      return {}
    },
  }
  return { session, prompts, created }
}

describe("advance 唤醒按阶段选模型", () => {
  test("execute-nudge 的 prompt 携带执行模型(prompt 形态 key 为 modelID)", async () => {
    const { session, prompts } = fakeSession()
    const rules = makeBuiltinRules({
      session,
      log: () => {},
      models: { analyze: { providerID: "p-a", id: "m-a" }, execute: { providerID: "p-e", id: "m-e" } },
    })
    const ctx = { shouldAct: () => true, markActed: () => {}, log: () => {} }
    await runAdvance(rules, along(1, "executing"), taskOf(), ctx)
    expect(prompts).toHaveLength(1)
    expect(prompts[0].model).toEqual({ providerID: "p-e", modelID: "m-e" })
  })

  test("reanalyze-nudge 的 prompt 携带分析模型(继续分析属于分析阶段)", async () => {
    const { session, prompts } = fakeSession()
    const rules = makeBuiltinRules({
      session,
      log: () => {},
      models: { analyze: { providerID: "p-a", id: "m-a" }, execute: { providerID: "p-e", id: "m-e" } },
    })
    const ctx = { shouldAct: () => true, markActed: () => {}, log: () => {} }
    await runAdvance(rules, along(1, "analyzing"), taskOf(), ctx)
    expect(prompts).toHaveLength(1)
    expect(prompts[0].model).toEqual({ providerID: "p-a", modelID: "m-a" })
  })

  test("未配置阶段模型:prompt 不带 model 字段(跟随会话默认)", async () => {
    const { session, prompts } = fakeSession()
    const rules = makeBuiltinRules({ session, log: () => {}, models: {} })
    const ctx = { shouldAct: () => true, markActed: () => {}, log: () => {} }
    await runAdvance(rules, along(1, "executing"), taskOf(), ctx)
    expect(prompts).toHaveLength(1)
    expect(prompts[0].model).toBeUndefined()
  })
})

describe("session-pool 派发用分析模型", () => {
  const poolDeps = (session: DispatcherSession, patch: (id: string, p: { status: "pending" }) => Promise<void>) => ({
    session,
    directory: "/proj",
    claimWaitMs: 60_000,
    patchTask: patch,
    onSettled: () => {},
    onTimeout: () => {},
    onCreateFail: () => {},
    onTaskGone: () => {},
    log: () => {},
  })

  test("dispatch 的 create 与首 prompt 均携带分析模型(create key 为 id,prompt key 为 modelID)", async () => {
    const { session, prompts, created } = fakeSession()
    const pool = createSessionPool(poolDeps(session, async () => {}))
    const task = taskOf({ id: "t9", status: "pending" })
    const outcome = await pool.dispatch(
      task,
      "w1",
      "提示词",
      { providerID: "p-a", id: "m-a" },
    )
    expect(outcome).toBe("ok")
    expect(created[0]?.model).toEqual({ providerID: "p-a", id: "m-a" })
    expect(prompts[0]?.model).toEqual({ providerID: "p-a", modelID: "m-a" })
    pool.dispose()
  })

  test("未传模型:create 与 prompt 均不带 model(opencode 默认解析)", async () => {
    const { session, prompts, created } = fakeSession()
    const pool = createSessionPool(poolDeps(session, async () => {}))
    const task = taskOf({ id: "t9", status: "pending" })
    await pool.dispatch(task, "w1", "提示词")
    expect(created[0]?.model).toBeUndefined()
    expect(prompts[0]?.model).toBeUndefined()
    pool.dispose()
  })
})

describe("engine 从看板设置动态解析阶段模型", () => {
  async function toPending(s: Store, title: string): Promise<Task> {
    const t = await s.create({ title })
    return s.patch(t.id, { status: "pending" })
  }

  test("settings.modelAnalyze 覆盖默认:派发 create 收到网页配置的分析模型", async () => {
    const entries: Record<string, unknown> = {}
    const storage = {
      get: async (k: string) => entries[k],
      set: async (k: string, v: unknown) => {
        entries[k] = v
      },
    }
    const store = createStore(memoryBackend(), { requireAnalysisConfirm: false })
    await store.setSettings({ autoDispatch: true, modelAnalyze: "web-an/ma", modelExecute: "test/execute" })
    await toPending(store, "设置模型任务")

    const { session, created } = fakeSession()
    const d = initDispatcher(
      // 故意不传 ctx.model(运维兜底):验证网页设置独立生效
      { session, storage, projectID: "p1", directory: "/proj" } as never,
      {
        store,
        log: () => {},
        onWrite: () => {},
        evaluateMs: 10,
        claimWaitMs: 5_000,
        minIntervalMs: 0,
        usagePollMs: 0,
        evaluateTickMs: 0,
      },
    )
    await new Promise((r) => setTimeout(r, 80))
    expect(created.length).toBeGreaterThanOrEqual(1)
    expect(created[0]?.model).toEqual({ providerID: "web-an", id: "ma" })
    d.dispose()
  })

  test("settings 未配置且无兜底:跳过派发,不创建会话(绝不回退 opencode 默认解析)", async () => {
    const entries: Record<string, unknown> = {}
    const storage = {
      get: async (k: string) => entries[k],
      set: async (k: string, v: unknown) => {
        entries[k] = v
      },
    }
    const store = createStore(memoryBackend(), { requireAnalysisConfirm: false })
    await store.setSettings({ autoDispatch: true })
    await toPending(store, "无模型任务")

    const { session, created } = fakeSession()
    const d = initDispatcher(
      { session, storage, projectID: "p1", directory: "/proj" } as never,
      {
        store,
        log: () => {},
        onWrite: () => {},
        evaluateMs: 10,
        claimWaitMs: 5_000,
        minIntervalMs: 0,
        usagePollMs: 0,
        evaluateTickMs: 0,
      },
    )
    await new Promise((r) => setTimeout(r, 80))
    expect(created.length).toBe(0)
    d.dispose()
  })
})
