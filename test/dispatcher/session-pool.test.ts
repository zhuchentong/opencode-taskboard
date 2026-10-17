import { describe, expect, test } from "bun:test"
import { createSessionPool } from "../../src/dispatcher/session-pool"
import type { DispatcherSession } from "../../src/dispatcher/types"
import { createStore, memoryBackend, type Store } from "../../src/store"
import type { Task } from "../../src/types"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function toPending(s: Store, title: string): Promise<Task> {
  const t = await s.create({ title })
  return s.patch(t.id, { status: "pending" })
}

function fakeSession(overrides: Partial<DispatcherSession> = {}): DispatcherSession & {
  created: { id: string; title?: string; directory?: string }[]
  prompts: { sessionID: string; text: string }[]
  removed: string[]
} {
  const created: { id: string; title?: string; directory?: string }[] = []
  const prompts: { sessionID: string; text: string }[] = []
  const removed: string[] = []
  let seq = 0
  return {
    created,
    prompts,
    removed,
    create: async (input) => {
      if (overrides.create) return overrides.create(input)
      const id = `ses_w${++seq}`
      created.push({ id, title: input?.title, directory: input?.location?.directory })
      return { id, title: input?.title }
    },
    get: async (input) => ({ id: input.sessionID }),
    prompt: async (input) => {
      if (overrides.prompt) return overrides.prompt(input)
      prompts.push(input)
      return {}
    },
    remove: async (input) => {
      if (overrides.remove) return overrides.remove(input)
      removed.push(input.sessionID)
      return {}
    },
  }
}

function harness(overrides: Partial<DispatcherSession> = {}, claimWaitMs = 20) {
  const store = createStore(memoryBackend(), { requireAnalysisConfirm: false })
  const lines: string[] = []
  const settled: string[] = []
  const timeouts: string[] = []
  const createFails: number[] = []
  const gone: string[] = []
  const session = fakeSession(overrides)
  const pool = createSessionPool({
    session,
    directory: "/proj",
    claimWaitMs,
    patchTask: async (id, patch) => {
      // 契约(见账本 Task 4 裁决):仅当任务仍在 pending 时撤回;否则视为已被领取
      const cur = await store.get(id)
      if (cur.status !== "pending") {
        const e = new Error(`当前状态 ${cur.status} 不能执行撤回`) as Error & { code: string }
        e.code = "invalid_transition"
        throw e
      }
      return store.patch(id, patch)
    },
    onSettled: (taskID) => settled.push(taskID),
    onTimeout: (taskID) => timeouts.push(taskID),
    onCreateFail: () => createFails.push(Date.now()),
    onTaskGone: (taskID) => gone.push(taskID),
    log: (m) => lines.push(m),
  })
  return { pool, store, session, lines, settled, timeouts, createFails, gone }
}

describe("session-pool(在途表 + taskID 结算 + 统一清理)", () => {
  test("派发:建会话带项目目录与标题,记录在途(taskID 索引)", async () => {
    const h = harness()
    const task = await toPending(h.store, "写个功能")
    const result = await h.pool.dispatch(task, "w1", `派发提示词:${task.title}`)
    expect(result).toBe("ok")
    expect(h.session.created[0].directory).toBe("/proj")
    expect(h.session.created[0].title).toContain("写个功能")
    expect(h.pool.inFlightCount()).toBe(1)
    expect(h.pool.inFlightTaskIDs()).toEqual(new Set([task.id]))
    expect(h.lines.some((l) => l.includes("派发 →"))).toBe(true)
    h.pool.dispose()
  })

  test("超时回收:任务退回待领取、会话回收、onTimeout 通知 engine 记任务级退避", async () => {
    const h = harness({}, 20)
    const task = await toPending(h.store, "没人领")
    await h.pool.dispatch(task, "w1", `派发提示词:${task.title}`)
    await sleep(80)
    expect((await h.store.get(task.id)).status).toBe("pending")
    expect(h.session.removed).toEqual(["ses_w1"])
    expect(h.timeouts).toEqual([task.id])
    expect(h.pool.inFlightCount()).toBe(0)
    h.pool.dispose()
  }, 2000)

  test("超时但任务已被领取(invalid_transition):保留会话、按结算通知、不 onTimeout", async () => {
    const h = harness({}, 30)
    const task = await toPending(h.store, "被抢先")
    await h.pool.dispatch(task, "w1", `派发提示词:${task.title}`)
    await h.store.claim({ id: task.id, sessionID: "ses_w1", agent: "build" })
    await sleep(90)
    expect(h.session.removed).toEqual([]) // 会话仍在用
    expect(h.timeouts).toEqual([])
    expect(h.pool.inFlightCount()).toBe(0) // 条目已摘除
    h.pool.dispose()
  }, 2000)

  test("超时但任务已删除(not_found):回收会话、不计败、不 onTimeout、不 onSettled", async () => {
    const h = harness({}, 30)
    const task = await toPending(h.store, "将被删")
    await h.pool.dispatch(task, "w1", `派发提示词:${task.title}`)
    await h.store.remove(task.id)
    await sleep(90)
    expect(h.session.removed).toEqual(["ses_w1"])
    expect(h.timeouts).toEqual([])
    expect(h.settled).toEqual([])
    h.pool.dispose()
  }, 2000)

  test("拖拽盲区根治:human claim(空 sessionID)由 sweep 按 taskID 结算——在途释放、会话保留", async () => {
    const h = harness({}, 5_000)
    const task = await toPending(h.store, "人工拖入")
    await h.pool.dispatch(task, "w1", `派发提示词:${task.title}`)
    // 人工拖拽:claim={sessionID:"", agent:"human"}(旧实现按 sessionID 匹配永不命中)
    await h.store.claim({ id: task.id, sessionID: "", agent: "human" })
    h.pool.sweep(await h.store.list())
    expect(h.settled).toEqual([task.id]) // 按 taskID 结算命中
    expect(h.session.removed).toEqual([]) // 会话保留(不能误删在用会话)
    expect(h.pool.inFlightCount()).toBe(0)
    h.pool.dispose()
  })

  test("settleByTask:沿驱动零延迟结算入口,幂等(重复调用 no-op)", async () => {
    const h = harness({}, 5_000)
    const task = await toPending(h.store, "沿结算")
    await h.pool.dispatch(task, "w1", `派发提示词:${task.title}`)
    h.pool.settleByTask(task.id)
    expect(h.pool.inFlightCount()).toBe(0)
    expect(h.settled.length).toBe(1)
    h.pool.settleByTask(task.id)
    expect(h.settled.length).toBe(1)
    h.pool.dispose()
  })

  test("统一清理入口 releaseEntry 幂等:重复调用不重复回调", async () => {
    const h = harness({}, 5_000)
    const task = await toPending(h.store, "清理幂等")
    await h.pool.dispatch(task, "w1", `派发提示词:${task.title}`)
    h.pool.releaseEntry(task.id, "测试清理")
    h.pool.releaseEntry(task.id, "重复清理")
    expect(h.pool.inFlightCount()).toBe(0)
    h.pool.dispose()
  })

  test("建会话失败:不计名额、onCreateFail 通知(engine 记独立低上限退避)、任务留在池中", async () => {
    const h = harness({ create: async () => { throw new Error("配额耗尽") } }, 20)
    const task = await toPending(h.store, "建不出来")
    const result = await h.pool.dispatch(task, "w1", `派发提示词:${task.title}`)
    expect(result).toBe("create-fail")
    expect(h.createFails.length).toBe(1)
    expect(h.pool.inFlightCount()).toBe(0)
    expect((await h.store.get(task.id)).status).toBe("pending")
    h.pool.dispose()
  }, 2000)

  test("prompt 抛错:回收会话与在途名额,报告 prompt-fail(engine 计全局派发异常)", async () => {
    const h = harness({ prompt: async () => { throw new Error("session api down") } }, 20)
    const task = await toPending(h.store, "发不出去")
    const result = await h.pool.dispatch(task, "w1", `派发提示词:${task.title}`)
    expect(result).toBe("prompt-fail")
    expect(h.pool.inFlightCount()).toBe(0)
    expect(h.session.removed).toEqual(["ses_w1"])
    h.pool.dispose()
  }, 2000)

  test("任务消失由 sweep 发现:onTaskGone 通知 engine 清沿状态键(审查重点 3)", async () => {
    const h = harness({}, 5_000)
    const task = await toPending(h.store, "将消失")
    await h.pool.dispatch(task, "w1", `派发提示词:${task.title}`)
    await h.store.remove(task.id)
    h.pool.sweep(await h.store.list())
    expect(h.gone).toEqual([task.id])
    expect(h.pool.inFlightCount()).toBe(0)
    h.pool.dispose()
  })

  test("dispose:清理全部在途 timer,不触发超时回调", async () => {
    const h = harness({}, 20)
    const task = await toPending(h.store, "卸载即停")
    await h.pool.dispatch(task, "w1", `派发提示词:${task.title}`)
    h.pool.dispose()
    await sleep(60)
    expect(h.timeouts).toEqual([])
    expect(h.session.removed).toEqual([])
  })
})
