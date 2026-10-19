// 启动自举守卫:存量待领取任务在 initDispatcher 后自动派发;空看板不评估(不污染 lastSkipReason)
import { describe, expect, test } from "bun:test"
import { initDispatcher, type DispatcherSession } from "../src/dispatcher/index"
import { createStore, memoryBackend, type Store } from "../src/store"
import type { Task } from "../src/types"

async function toPending(s: Store, title: string): Promise<Task> {
  const t = await s.create({ title })
  return s.patch(t.id, { status: "pending" })
}

function fakeSession() {
  const prompts: { sessionID: string; text: string }[] = []
  const created: { id: string; title?: string; directory?: string; model?: unknown }[] = []
  const removed: string[] = []
  let seq = 0
  const sess = {
    prompts,
    created,
    removed,
    create: async (input?: { title?: string; location?: { directory: string }; model?: unknown }) => {
      const id = `ses_w${++seq}`
      created.push({ id, title: input?.title, directory: input?.location?.directory, model: input?.model })
      return { id, title: input?.title }
    },
    get: async (input: { sessionID: string }) => {
      if (!created.some((c) => c.id === input.sessionID)) throw new Error("no such session")
      return { id: input.sessionID }
    },
    prompt: async (input: { sessionID: string; text: string }) => {
      prompts.push(input)
      return {}
    },
    remove: async (_input: { sessionID: string }) => {
      removed.push(_input.sessionID)
      return {}
    },
  } satisfies DispatcherSession
  return sess
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("派发器启动自举", () => {
  test("存量 pending 任务在启动时自动派发,worker 会话落在配置目录", async () => {
    const entries: Record<string, unknown> = {}
    const storage = {
      get: async (k: string) => entries[k],
      set: async (k: string, v: unknown) => {
        entries[k] = v
      },
    }
    const store = createStore(memoryBackend(), { requireAnalysisConfirm: false })
    await store.setSettings({ autoDispatch: true, modelAnalyze: "test/analyze", modelExecute: "test/execute" })
    await toPending(store, "存量任务")

    const session = fakeSession()
    const d = initDispatcher(
      { session, storage, projectID: "p1", directory: "/proj" },
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
    await sleep(60)
    // 启动自举:无需外部写事件,存量任务即被派发
    expect(session.prompts).toHaveLength(1)
    // worker 会话必须显式落在配置目录(回退 cwd 是历史 bug)
    expect(session.created[0]?.directory).toBe("/proj")
    d.dispose()
  })

  test("空看板启动不评估:不产生派发,不污染 lastSkipReason", async () => {
    const entries: Record<string, unknown> = {}
    const storage = {
      get: async (k: string) => entries[k],
      set: async (k: string, v: unknown) => {
        entries[k] = v
      },
    }
    const store = createStore(memoryBackend(), { requireAnalysisConfirm: false })
    await store.setSettings({ autoDispatch: true, modelAnalyze: "test/analyze", modelExecute: "test/execute" })
    // 不建任何任务

    const session = fakeSession()
    const lines: string[] = []
    const d = initDispatcher(
      { session, storage, projectID: "p1", directory: "/proj" },
      {
        store,
        log: (m) => lines.push(m),
        onWrite: () => {},
        evaluateMs: 10,
        claimWaitMs: 5_000,
        minIntervalMs: 0,
        usagePollMs: 0,
        evaluateTickMs: 0,
      },
    )
    await sleep(60)
    expect(session.prompts).toHaveLength(0)
    // 空看板启动不应留下 skip 痕迹(lastSkipReason 保持空)
    expect(lines.some((l) => l.includes("跳过"))).toBe(false)
    d.dispose()
  })
})
