import { describe, expect, test } from "bun:test"
import { createMetrics, readTokens } from "../../src/dispatcher/metrics"
import type { DispatcherSession } from "../../src/dispatcher/types"
import type { TaskTransition } from "../../src/dispatcher/types"
import { createStore, memoryBackend, type Store } from "../../src/store"
import type { Task } from "../../src/types"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const along = (to: Task["status"], from: Task["status"] = "analyzing"): TaskTransition => ({
  taskID: "t1",
  from,
  to,
  seq: 1,
})

const taskOf = (over: Partial<Task> = {}): Task => ({
  id: "t1",
  title: "t",
  description: "",
  status: "analyzing",
  comments: [],
  claim: { sessionID: "ses_w1", agent: "build", claimedAt: 0 },
  createdAt: 1,
  updatedAt: 1,
  ...over,
})

function fakeSession(tokens: unknown = { input: 10, output: 20, reasoning: 1, cache: { read: 30, write: 2 } }) {
  const gets: string[] = []
  const session: DispatcherSession = {
    create: async () => ({ id: "x" }),
    get: async (input) => {
      gets.push(input.sessionID)
      return { id: input.sessionID, tokens }
    },
    prompt: async () => ({}),
  }
  return { session, gets }
}

function harness(tokens?: unknown, usagePollMs = 0) {
  const store = createStore(memoryBackend(), { requireAnalysisConfirm: false })
  const broadcasts: number[] = []
  const lines: string[] = []
  const { session } = fakeSession(tokens)
  const metrics = createMetrics({
    store,
    session,
    broadcast: async () => {
      broadcasts.push(Date.now())
    },
    usagePollMs,
    log: (m) => lines.push(m),
  })
  return { store, metrics, broadcasts, lines }
}

async function seedTask(store: Store, over: Partial<Task> = {}): Promise<Task> {
  const t = await store.create({ title: "t" })
  await store.patch(t.id, { status: "pending" })
  const claimed = await store.claim({ id: t.id, sessionID: "ses_w1", agent: "build" })
  return over.status ? store.patch(claimed.id, { status: over.status }) : claimed
}

describe("metrics(沿驱动消耗刷新)", () => {
  test("沿边界调现有 recordUsage 刷新 task.usage 并 broadcast", async () => {
    const h = harness()
    const task = await seedTask(h.store)
    await h.metrics.applyTransition(along("analysis_confirm"), task)
    const after = await h.store.get(task.id)
    expect(after.usage).toEqual({
      input: 10,
      output: 20,
      reasoning: 1,
      cacheRead: 30,
      cacheWrite: 2,
      at: expect.any(Number),
    })
    expect(h.broadcasts.length).toBeGreaterThan(0)
  })

  test("无会话的 claim(human)跳过 token 刷新,不抛错", async () => {
    const h = harness()
    const task = await seedTask(h.store)
    await h.store.patch(task.id, { status: "pending" }) // 拖拽分支:claim 清空
    const released = await h.store.get(task.id)
    await h.metrics.applyTransition(along("pending", "analyzing"), released)
    expect(released.usage).toBeUndefined()
  })

  test("会话读数缺 tokens → 宁可没有统计,不写入假数据", async () => {
    const h = harness(null) // info.tokens 缺失
    const task = await seedTask(h.store)
    await h.metrics.applyTransition(along("executing"), task)
    const after = await h.store.get(task.id)
    expect(after.usage).toBeUndefined()
  })

  test("终结沿 flush:completion_confirm/done 任务补一次完整读数", async () => {
    const h = harness()
    const task = await seedTask(h.store)
    await h.store.patch(task.id, { status: "analyzing" })
    const analyzing = await h.store.patch(task.id, { status: "executing" })
    const done = await h.store.complete({
      id: task.id,
      sessionID: "ses_w1",
      result: "r",
    })
    expect(done.status).toBe("completion_confirm")
    await h.metrics.flushTerminal([analyzing, done])
    const after = await h.store.get(task.id)
    expect(after.usage?.input).toBe(10)
  })

  test("readTokens:结构认得就取 token,不认得返回 null", () => {
    expect(readTokens({ tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } } })).toEqual({
      input: 1,
      output: 2,
      reasoning: 3,
      cache: { read: 4, write: 5 },
    })
    expect(readTokens(null)).toBeNull()
    expect(readTokens({ nope: 1 })).toBeNull()
  })

  test("pollUsage 定时:活跃任务周期性回写 token(usagePollMs>0)", async () => {
    const h = harness(undefined, 15)
    h.metrics.startPoll() // engine 装配时调用;测试显式启动
    await seedTask(h.store) // analyzing(占活跃段)
    await sleep(60)
    const after = await h.store.list()
    expect(after[0].usage?.input).toBe(10)
    h.metrics.dispose()
  })
})
