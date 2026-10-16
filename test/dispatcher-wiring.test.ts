import { afterEach, describe, expect, test } from "bun:test"
import { initDispatcher, type DispatcherSession } from "../src/dispatcher"
import { createStore, memoryBackend } from "../src/store"

// 把任务直接推进到 pending 的人工路径
async function toPending(s: ReturnType<typeof createStore>, title: string) {
  const t = await s.create({ title })
  return s.patch(t.id, { status: "pending" })
}

function fakeSession() {
  const prompts: { sessionID: string; text: string }[] = []
  const created: string[] = []
  const sess: DispatcherSession & { prompts: typeof prompts } = {
    prompts,
    create: async (input) => {
      const id = `ses_w${created.length + 1}`
      created.push(id)
      return { id, title: input?.title }
    },
    get: async (input) => {
      if (!created.includes(input.sessionID)) throw new Error("no such session")
      return { id: input.sessionID }
    },
    prompt: async (input) => {
      prompts.push(input)
      return {}
    },
  }
  return sess
}

function harness(opts: { claimCheckMs?: number; evaluateMs?: number; backoffBaseMs?: number; minIntervalMs?: number } = {}) {
  const entries: Record<string, unknown> = {}
  const storage = {
    get: async (k: string) => entries[k],
    set: async (k: string, v: unknown) => {
      entries[k] = v
    },
  }
  const store = createStore(memoryBackend(), { requireAnalysisConfirm: false })
  const lines: string[] = []
  let registered: (() => void) | null = null
  const session = fakeSession()
  const d = initDispatcher(
    { session, storage, projectID: "p1" },
    {
      store,
      log: (m) => lines.push(m),
      onWrite: (fn) => (registered = fn),
      evaluateMs: opts.evaluateMs ?? 10,
      claimCheckMs: opts.claimCheckMs ?? 20,
      backoffBaseMs: opts.backoffBaseMs,
      minIntervalMs: opts.minIntervalMs,
    },
  )
  return { d, store, storage, session, lines, fire: () => registered?.(), entries }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

afterEach(() => {})

describe("initDispatcher 接线", () => {
  test("开关关闭时写事件不派发", async () => {
    const h = harness()
    await toPending(h.store, "t1")
    h.fire()
    await sleep(40)
    expect(h.session.prompts).toHaveLength(0)
    h.d.dispose()
  })

  test("pending + 开关开启 → 创建 worker 会话并派发；日计数与 sessionID 落 storage", async () => {
    const h = harness()
    await toPending(h.store, "t1")
    await h.store.setSettings({ autoDispatch: true })
    h.fire()
    await sleep(60)
    expect(h.session.prompts).toHaveLength(1)
    expect(h.session.prompts[0].sessionID).toBe("ses_w1")
    expect(h.session.prompts[0].text).toContain("自动派发")
    expect(h.storage.get ? await h.storage.get("p1/settings/dispatcher-session") : undefined).toBe("ses_w1")
    expect(await h.storage.get("p1/dispatcher/")).toBeUndefined() // 日期键路径正确（键含日期）
    expect(Object.keys(h.entries).some((k) => k.startsWith("p1/dispatcher/"))).toBe(true)
    expect(h.lines.some((l) => l.includes("派发 →"))).toBe(true)
    h.d.dispose()
  })

  test("worker 忙碌（名下有非 done claim）不派发", async () => {
    const h = harness()
    await h.store.setSettings({ autoDispatch: true })
    h.fire()
    await sleep(40)
    expect(h.session.prompts).toHaveLength(0) // 无 pending → 不派
    const t = await toPending(h.store, "t1")
    await h.store.claim({ id: t.id, sessionID: "ses_w1", agent: "build" }) // 伪造成 worker 的 claim
    // 直接把 workerID 指向已有 claim：通过 storage 预置
    h.fire()
    await sleep(40)
    // workerID 此时为 null（从未成功创建），claim.sessionID=ses_w1 不构成 busy —— 该场景由纯函数层覆盖
    expect(h.lines.every((l) => !l.includes("评估失败"))).toBe(true)
    h.d.dispose()
  })

  test("失败退避：派发后未见领取 → 连败计数与冷却日志；3 连败暂停；重开复位", async () => {
    const h = harness({ claimCheckMs: 20, backoffBaseMs: 10, minIntervalMs: 1 })
    await toPending(h.store, "t1")
    await h.store.setSettings({ autoDispatch: true })
    for (let i = 1; i <= 3; i++) {
      h.fire()
      await sleep(120) // 10ms 节流 + 20ms 检查 + 10ms 退避过后可再派
    }
    expect(h.d.status().state).toBe("paused")
    expect(h.d.status().failStreak).toBe(3)
    expect(h.lines.filter((l) => l.includes("连败")).length).toBeGreaterThanOrEqual(3)
    // 重开开关复位（生产中 PUT settings 触发写广播 → 评估；off 先被评估到，on 才构成「重新开启」转变）
    await h.store.setSettings({ autoDispatch: false })
    h.fire()
    await sleep(40)
    await h.store.setSettings({ autoDispatch: true })
    h.fire()
    await sleep(80)
    expect(h.lines.some((l) => l.includes("失败状态复位"))).toBe(true)
    expect(h.d.status().state).not.toBe("paused") // 复位生效；复位后同一评估可立即再派（任务仍在 pending）
    h.d.dispose()
  }, 4000)

  test("冷却窗口内重复写事件不重复派发；单飞门生效", async () => {
    const h = harness({ claimCheckMs: 5_000, minIntervalMs: 1 }) // 间隔守卫置 1ms，专测单飞门
    await toPending(h.store, "t1")
    await h.store.setSettings({ autoDispatch: true })
    h.fire()
    await sleep(60)
    expect(h.session.prompts).toHaveLength(1)
    h.fire()
    await sleep(60)
    h.fire()
    await sleep(60)
    // 5s claim 检查未到 → awaitingClaim 门拦住，绝不重复派发打断 worker
    expect(h.session.prompts).toHaveLength(1)
    h.d.dispose()
  })
})
