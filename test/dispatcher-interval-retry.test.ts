// 缺陷 B 回归:interval 节流窗到期后必须自动重试派发,批量任务按 minInterval 连发填满槽位。
// 修复前:每轮只派 1 个,续派被 interval 守卫拒绝后无重试,只能等 30s 兜底 tick(测试里已关闭)。
import { describe, expect, test } from "bun:test"
import { initDispatcher, type DispatcherSession } from "../src/dispatcher/index"
import { createStore, memoryBackend, type Store } from "../src/store"
import type { Task } from "../src/types"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function toPending(s: Store, title: string): Promise<Task> {
  const t = await s.create({ title })
  return s.patch(t.id, { status: "pending" })
}

function fakeSession() {
  const created: { id: string }[] = []
  let seq = 0
  const sess = {
    created,
    create: async () => {
      const id = `ses_w${++seq}`
      created.push({ id })
      return { id }
    },
    get: async () => ({}),
    prompt: async () => ({}),
    remove: async () => ({}),
  } satisfies DispatcherSession
  return sess
}

describe("interval 节流窗到期自动重试(批量即时填槽)", () => {
  test("6 个任务在 minInterval 间隔下连发,~1s 内全部派出(而非 30s 一个)", async () => {
    const entries: Record<string, unknown> = {}
    const storage = {
      get: async (k: string) => entries[k],
      set: async (k: string, v: unknown) => {
        entries[k] = v
      },
    }
    const store = createStore(memoryBackend(), { requireAnalysisConfirm: false })
    await store.setSettings({ autoDispatch: true })
    for (let i = 1; i <= 6; i++) await toPending(store, `批量任务 ${i}`)

    const session = fakeSession()
    const d = initDispatcher(
      { session, storage, projectID: "p1", directory: "/proj" },
      {
        store,
        log: () => {},
        onWrite: () => {},
        evaluateMs: 10,
        claimWaitMs: 5_000,
        minIntervalMs: 120, // 压缩节流窗:6 个任务理论 120ms × 5 ≈ 600ms 内派完
        usagePollMs: 0,
        evaluateTickMs: 0, // 关兜底 tick:修复前此测试必挂(只有 1 个派出)
      },
    )
    await sleep(1_200)
    // 6 槽并发,全部派出 = 节流窗到期后自动续派生效
    expect(session.created.length).toBe(6)
    d.dispose()
  })

  test("重试不越界:槽位满(concurrency-full)后不再派发", async () => {
    const entries: Record<string, unknown> = {}
    const storage = {
      get: async (k: string) => entries[k],
      set: async (k: string, v: unknown) => {
        entries[k] = v
      },
    }
    const store = createStore(memoryBackend(), { requireAnalysisConfirm: false })
    await store.setSettings({ autoDispatch: true })
    for (let i = 1; i <= 8; i++) await toPending(store, `超槽任务 ${i}`)

    const session = fakeSession()
    const d = initDispatcher(
      { session, storage, projectID: "p1", directory: "/proj" },
      {
        store,
        log: () => {},
        onWrite: () => {},
        evaluateMs: 10,
        claimWaitMs: 60_000, // 派出的不领取不回收,占住槽位
        minIntervalMs: 120,
        usagePollMs: 0,
        evaluateTickMs: 0,
      },
    )
    await sleep(1_200)
    // maxConcurrent=6:恰好 6 个,重试循环不得越过并发上限
    expect(session.created.length).toBe(6)
    d.dispose()
  })
})
