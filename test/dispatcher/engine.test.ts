import { describe, expect, test } from "bun:test"
import { initDispatcher } from "../../src/dispatcher/engine"
import { buildDispatchPrompt } from "../../src/dispatcher/prompt"
import type { DispatcherSession } from "../../src/dispatcher/types"
import { createStore, memoryBackend, type Store } from "../../src/store"
import { DEFAULT_PROJECT_ID, type Task } from "../../src/types"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function toPending(s: Store, title: string): Promise<Task> {
  const t = await s.create({ title })
  return s.patch(t.id, { status: "pending" })
}

async function toAnalyzing(s: Store, title: string, sessionID = "ses_ext"): Promise<Task> {
  const t = await toPending(s, title)
  return s.claim({ id: t.id, sessionID, agent: "human" })
}

function fakeSession(overrides: Partial<DispatcherSession> = {}) {
  const prompts: { sessionID: string; text: string }[] = []
  const created: { id: string; title?: string; directory?: string; model?: { providerID: string; id: string } }[] = []
  const removed: string[] = []
  let seq = 0
  const sess = {
    prompts,
    created,
    removed,
    create: async (input?: { title?: string; location?: { directory: string }; model?: { providerID: string; id: string } }) => {
      if (overrides.create) return overrides.create(input)
      const id = `ses_w${++seq}`
      created.push({ id, title: input?.title, directory: input?.location?.directory, model: input?.model })
      return { id, title: input?.title }
    },
    get: async (input: { sessionID: string }) => {
      if (overrides.get) return overrides.get(input)
      if (!created.some((c) => c.id === input.sessionID)) return { id: input.sessionID }
      return { id: input.sessionID, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }
    },
    prompt: async (input: { sessionID: string; text: string }) => {
      if (overrides.prompt) return overrides.prompt(input)
      prompts.push(input)
      return {}
    },
    remove: async (input: { sessionID: string }) => {
      if (overrides.remove) return overrides.remove(input)
      removed.push(input.sessionID)
      return {}
    },
  } satisfies DispatcherSession
  return sess
}

function harness(
  opts: {
    claimWaitMs?: number
    evaluateMs?: number
    backoffBaseMs?: number
    minIntervalMs?: number
    usagePollMs?: number
    evaluateTickMs?: number
    promptFail?: boolean
    createFail?: boolean
    model?: { providerID: string; id: string }
  } = {},
  storageEntries?: Record<string, unknown>,
) {
  const entries: Record<string, unknown> = storageEntries ?? {}
  const storage = {
    get: async (k: string) => entries[k],
    set: async (k: string, v: unknown) => {
      entries[k] = v
    },
  }
  const store = createStore(memoryBackend(), { requireAnalysisConfirm: false })
  const lines: string[] = []
  const broadcasts: number[] = []
  let registered: ((tasks?: Task[]) => void) | null = null
  const session = fakeSession({
    ...(opts.promptFail ? { prompt: async () => { throw new Error("session api down") } } : {}),
    ...(opts.createFail ? { create: async () => { throw new Error("cannot create session") } } : {}),
  })
  const d = initDispatcher(
    {
      session,
      storage,
      projectID: "p1",
      directory: "/proj",
      ...(opts.model ? { model: opts.model } : {}),
    },
    {
      store,
      log: (m) => lines.push(m),
      onWrite: (fn) => (registered = fn),
      broadcast: async () => broadcasts.push(Date.now()),
      evaluateMs: opts.evaluateMs ?? 10,
      claimWaitMs: opts.claimWaitMs ?? 20,
      backoffBaseMs: opts.backoffBaseMs ?? 60_000,
      minIntervalMs: opts.minIntervalMs ?? 0,
      usagePollMs: opts.usagePollMs ?? 0,
      evaluateTickMs: opts.evaluateTickMs ?? 0,
    },
  )
  const fire = async (tasks?: Task[]) => registered?.(tasks ?? (await store.list()))
  return { d, store, storage, session, lines, broadcasts, fire, entries }
}

describe("engine 装配(沿驱动 initDispatcher)", () => {
  test("模型透传:initDispatcher 传入 model 时,session.create 收到 model 字段(TASKBOARD_MODEL 生效)", async () => {
    const h = harness({
      claimWaitMs: 5_000,
      model: { providerID: "opencode", id: "nemotron-3.5-super-vl-free" },
    })
    await toPending(h.store, "带模型任务")
    await h.store.setSettings({ autoDispatch: true })
    await h.fire()
    await new Promise((r) => setTimeout(r, 80))
    expect(h.session.created[0].model).toEqual({
      providerID: "opencode",
      id: "nemotron-3.5-super-vl-free",
    })
    h.d.dispose()
  })

  test("死代码回归钉子:两个 pending、单次写事件,排空循环自动派完两单(即时填槽)", async () => {
    const h = harness({ claimWaitMs: 5_000 })
    await toPending(h.store, "任务A")
    await toPending(h.store, "任务B")
    await h.store.setSettings({ autoDispatch: true })
    await h.fire()
    await sleep(80)
    // 旧实现:一轮评估只派 1,dispatch 末尾续跑被丢弃 → 1 单;新实现排空 → 2 单
    expect(h.session.prompts).toHaveLength(2)
    h.d.dispose()
  })

  test("confirm-off(默认配置)下 analyze 直落 executing 不误发执行唤醒(I-1 回归钉子)", async () => {
    const h = harness({ claimWaitMs: 5_000 })
    await h.store.setSettings({ autoDispatch: false, requireAnalysisConfirm: false })
    const t = await toPending(h.store, "直落任务")
    // 人工 claim:首观测(analyzing)
    await h.store.claim({ id: t.id, sessionID: "ses_w1", agent: "build" })
    await h.fire() // 载荷路径:首观测零沿
    await sleep(30)
    await h.store.analyze({ id: t.id, sessionID: "ses_w1", analysis: "a" }) // confirm-off:直落 executing
    await h.fire() // 载荷路径:沿 analyzing→executing —— 旧 "*" 规则会在此误发唤醒
    await sleep(30)
    expect(h.session.prompts).toHaveLength(0)
    h.d.dispose()
  })

  test("唤醒 act 失败后沿自动重发:恢复后同状态 fire 必补唤醒(I-3 回归钉子)", async () => {
    const h = harness({ claimWaitMs: 5_000 })
    await h.store.setSettings({ autoDispatch: true, requireAnalysisConfirm: true })
    const t = await toPending(h.store, "瞬断任务")
    await h.store.claim({ id: t.id, sessionID: "ses_w1", agent: "build" })
    await h.store.analyze({ id: t.id, sessionID: "ses_w1", analysis: "a" })
    await h.fire() // 首观测
    await sleep(30)
    // 瞬断:放行沿到达时 prompt 抛错
    const original = h.session.prompt
    h.session.prompt = async () => {
      throw new Error("transient api down")
    }
    await h.store.patch(t.id, { action: "confirm" })
    await h.fire()
    await sleep(30)
    expect(h.session.prompts.length).toBe(0)
    expect(h.lines.some((l) => l.includes("执行唤醒失败"))).toBe(true)
    // API 恢复:同状态(无新沿)fire → 重试队列重放 → 必须补唤醒,否则 worker 永久停在等唤醒
    h.session.prompt = original
    await h.fire()
    await sleep(30)
    expect(h.session.prompts.length).toBe(1)
    expect(h.session.prompts[0].text).toContain("已放行")
    h.d.dispose()
  })

  test("沿驱动唤醒接线:写事件载荷触发 analysis_confirm→executing 沿唤醒一次", async () => {
    const h = harness({ claimWaitMs: 5_000 })
    await h.store.setSettings({ autoDispatch: true, requireAnalysisConfirm: true })
    const t = await toPending(h.store, "nudge")
    await h.store.claim({ id: t.id, sessionID: "ses_w1", agent: "build" })
    await h.store.analyze({ id: t.id, sessionID: "ses_w1", analysis: "a" })
    expect((await h.store.get(t.id)).status).toBe("analysis_confirm")
    await h.fire() // 首轮:记录 lastSeen(analysis_confirm),不唤醒
    await sleep(30)
    const before = h.session.prompts.length
    await h.store.patch(t.id, { action: "confirm" }) // 用户放行
    await h.fire()
    await sleep(30)
    expect(h.session.prompts.length).toBe(before + 1)
    expect(h.session.prompts.at(-1)!.text).toContain("已放行")
    h.d.dispose()
  })

  test("任务级退避隔离:A 连续超时进 2 档冷却,B 首次超时仍是 1 档", async () => {
    const h = harness({ claimWaitMs: 20, backoffBaseMs: 200, evaluateTickMs: 25 })
    await h.store.setSettings({ autoDispatch: true })
    const a = await toPending(h.store, "任务A")
    await h.fire()
    await sleep(120) // A 超时(streak=1,冷却 200ms)
    await sleep(240) // 冷却过期,兜底 tick 再派 A → 又超时(streak=2,冷却 400ms)
    const aRemain = h.d.status().taskCooldowns[a.id] ?? 0
    expect(aRemain).toBeGreaterThan(0)
    const b = await toPending(h.store, "任务B")
    await h.fire()
    await sleep(120) // B 派出并超时
    const bRemain = h.d.status().taskCooldowns[b.id] ?? 0
    expect(bRemain).toBeGreaterThan(0)
    expect(bRemain).toBeLessThan(aRemain) // B 首次 1 档(200ms),不吃 A 的 2 档(400ms)
    h.d.dispose()
  }, 3000)

  test("建会话失败连败在派发成功后归零:孤立失败不再吃历史翻倍退避(M-5 回归钉子)", async () => {
    const h = harness({ claimWaitMs: 5_000, backoffBaseMs: 200 })
    await h.store.setSettings({ autoDispatch: true })
    // 第一段:create 恒败 → streak=1,create-fail 冷却 ≈ 200ms(1 档)
    h.session.create = async () => {
      throw new Error("配额耗尽")
    }
    const t1 = await toPending(h.store, "失败一")
    await h.fire()
    await sleep(40)
    const first = h.d.status().cooldownRemainMs
    expect(first).toBeGreaterThan(0)
    // 恢复:等冷却过期后派发成功 → createFailStreak 归零
    const realCreate = async (input?: { title?: string; location?: { directory: string } }) => {
      const id = `ses_ok${h.session.created.length + 1}`
      h.session.created.push({ id, title: input?.title, directory: input?.location?.directory })
      return { id, title: input?.title }
    }
    h.session.create = realCreate
    await sleep(400)
    const t2 = await toPending(h.store, "成功一")
    await h.fire()
    await sleep(60)
    expect(h.session.prompts.some((p) => p.text.includes(t2.id))).toBe(true) // 成功派出
    // 第二段:再败 → 归零后应为 1 档(≈200ms);若没归零会吃 2 档(≈400ms)
    h.session.create = async () => {
      throw new Error("又挂了")
    }
    await sleep(400)
    const t3 = await toPending(h.store, "失败二")
    await h.fire()
    await sleep(40)
    const second = h.d.status().cooldownRemainMs
    expect(second).toBeGreaterThan(100)
    expect(second).toBeLessThan(300)
    void t1
    void t3
    h.d.dispose()
  }, 4000)

  test("status() 只增:旧字段全在,新增 lastSkipReason 与 taskCooldowns", async () => {
    const h = harness()
    const st = h.d.status()
    for (const key of [
      "state", "failStreak", "todayCount", "cooldownRemainMs",
      "activeCount", "inFlight", "timeoutStreak", "queuedCooldownCount",
      "lastSkipReason", "taskCooldowns",
    ]) {
      expect(st).toHaveProperty(key)
    }
    h.d.dispose()
  })

  test("重启装载:同状态零沿零唤醒;状态变化正常提沿", async () => {
    const entries: Record<string, unknown> = {}
    const store = createStore(memoryBackend(), { requireAnalysisConfirm: false })
    const mkEngine = () => {
      const lines: string[] = []
      const session = fakeSession()
      const d = initDispatcher(
        { session, storage: { get: async (k) => entries[k], set: async (k, v) => { entries[k] = v } }, projectID: "p1", directory: "/proj" },
        {
          store,
          log: (m) => lines.push(m),
          onWrite: (fn) => (registered = fn),
          evaluateMs: 10,
          claimWaitMs: 5_000,
          minIntervalMs: 0,
          usagePollMs: 0,
          evaluateTickMs: 0,
        },
      )
      return { d, session, lines }
    }
    let registered: ((tasks?: Task[]) => void) | null = null
    const h1 = mkEngine()
    await store.setSettings({ autoDispatch: true, requireAnalysisConfirm: true })
    const t = await toPending(store, "重启任务")
    await store.claim({ id: t.id, sessionID: "ses_w1", agent: "build" })
    await store.analyze({ id: t.id, sessionID: "ses_w1", analysis: "a" })
    await registered?.(await store.list()) // engine1 记录 lastSeen=analysis_confirm
    await sleep(30)
    h1.d.dispose()

    const before = h1.session.prompts.length
    const h2 = mkEngine() // 同一 store + storage:沿状态已持久化
    await registered?.(await store.list()) // 状态无变化 → 零沿零唤醒
    await sleep(30)
    expect(h2.session.prompts.length).toBe(0)
    await store.patch(t.id, { action: "confirm" }) // 放行 → 沿出现
    await registered?.(await store.list())
    await sleep(30)
    expect(h2.session.prompts.length).toBe(1) // 装载成功才可能正确提沿
    h2.d.dispose()
    void before
  })

  test("重启后 seq 从持久化 seqCounter+1 续接,不把新沿误判已处理(审查重点 2)", async () => {
    const entries: Record<string, unknown> = {}
    const store = createStore(memoryBackend(), { requireAnalysisConfirm: false })
    await store.setSettings({ autoDispatch: true })
    // 先建任务拿真实 id,再预置 blob(store.create 不接受自定义 id)
    const t0 = await store.create({ title: "seq续接" })
    await store.patch(t0.id, { status: "pending" })
    entries["p1/dispatcher/along-state"] = JSON.stringify({
      lastSeen: { [t0.id]: "analysis_confirm" },
      lastActedSeq: { [t0.id]: 5 },
      rounds: {},
      taskBackoff: {},
      seqCounter: 5,
    })
    const session = fakeSession()
    const lines: string[] = []
    let registered: ((tasks?: Task[]) => void) | null = null
    const d = initDispatcher(
      { session, storage: { get: async (k) => entries[k], set: async (k, v) => { entries[k] = v } }, projectID: "p1", directory: "/proj" },
      {
        store,
        log: (m) => lines.push(m),
        onWrite: (fn) => (registered = fn),
        evaluateMs: 10,
        claimWaitMs: 5_000,
        minIntervalMs: 0,
        usagePollMs: 0,
        evaluateTickMs: 0,
      },
    )
    await store.claim({ id: t0.id, sessionID: "ses_w1", agent: "build" })
    await store.analyze({ id: t0.id, sessionID: "ses_w1", analysis: "a" })
    expect((await store.get(t0.id)).status).toBe("executing")
    await registered?.(await store.list())
    await sleep(30)
    // 若 seq 回退到 1(< lastActedSeq 5),该沿会被误判已处理而不唤醒
    expect(session.prompts.length).toBe(1)
    d.dispose()
  })

  test("任务删除:沿状态键清理,再建同名任务不串历史(审查重点 3)", async () => {
    const h = harness({ claimWaitMs: 5_000 })
    await h.store.setSettings({ autoDispatch: true })
    const t = await toPending(h.store, "将删除")
    await h.fire()
    await sleep(30)
    await h.store.remove(t.id)
    await h.fire()
    await sleep(30)
    const blob = JSON.parse(String(h.entries["p1/dispatcher/along-state"] ?? "{}"))
    expect(blob.lastSeen?.[t.id]).toBeUndefined()
    // 重建任务(新 id)不受历史污染:正常派出(第一单会话未超时仍计 1 条 prompt)
    const fresh = await toPending(h.store, "新任务")
    await h.fire()
    await sleep(50)
    expect(h.session.prompts.some((p) => p.text.includes(fresh.id))).toBe(true)
    h.d.dispose()
  })

  test("非在途任务删除同样清理沿状态键:blob 不随历史任务单调膨胀(I-2 回归钉子)", async () => {
    const h = harness({ claimWaitMs: 5_000 })
    await h.store.setSettings({ autoDispatch: true })
    // analyzing(非在途:不在 awaitingClaims)任务被删 —— 旧 sweep 只遍历在途表,清不到它
    const t = await toPending(h.store, "非在途删除")
    await h.store.claim({ id: t.id, sessionID: "ses_ext", agent: "human" })
    await h.fire()
    await sleep(30)
    expect(JSON.parse(String(h.entries["p1/dispatcher/along-state"])).lastSeen[t.id]).toBe("analyzing")
    await h.store.remove(t.id)
    await h.fire()
    await sleep(30)
    const blob = JSON.parse(String(h.entries["p1/dispatcher/along-state"]))
    expect(blob.lastSeen[t.id]).toBeUndefined()
    expect(blob.lastActedSeq[t.id]).toBeUndefined()
    h.d.dispose()
  })

  test("关开复位:paused/冷却/任务退避全清且落盘", async () => {
    const h = harness({ promptFail: true, claimWaitMs: 20, backoffBaseMs: 10 })
    await toPending(h.store, "t1")
    await h.store.setSettings({ autoDispatch: true })
    for (let i = 0; i < 3; i++) {
      await h.fire()
      await sleep(60)
    }
    expect(h.d.status().state).toBe("paused") // 3 连败熔断
    await h.store.setSettings({ autoDispatch: false })
    await h.fire()
    await sleep(30)
    await h.store.setSettings({ autoDispatch: true })
    await h.fire()
    await sleep(30)
    expect(h.d.status().state).not.toBe("paused")
    const blob = JSON.parse(String(h.entries["p1/dispatcher/along-state"] ?? "{}"))
    expect(blob.taskBackoff ?? {}).toEqual({})
    h.d.dispose()
  }, 3000)

  test("空看板：零任务 → empty 跳过,无派发,lastSkipReason=empty", async () => {
    const h = harness({ claimWaitMs: 5_000 })
    await h.store.setSettings({ autoDispatch: true })
    await h.fire()
    await sleep(40)
    expect(h.session.prompts).toHaveLength(0) // 没有任务,不派发
    expect(h.lines.some((l) => l.includes("派发跳过：empty"))).toBe(true)
    expect(h.d.status().lastSkipReason).toBe("empty")
    expect(h.d.status().state).toBe("idle") // 空闲,不是错误态
    h.d.dispose()
  })

  test("全部待领取任务在任务冷却中时不报 empty：pendingTotal>0 但 pending 为空，不崩溃且任务保持 pending", async () => {
    const h = harness({ claimWaitMs: 20, backoffBaseMs: 1000, minIntervalMs: 1 })
    await h.store.setSettings({ autoDispatch: true })
    const t1 = await toPending(h.store, "t1")
    h.fire()
    await sleep(50) // 派出，进入 awaiting（in-flight）
    expect(h.session.prompts).toHaveLength(1)

    await sleep(40) // claimWaitMs=20ms 超时，任务退回 pending 并进入任务冷却（1000ms）
    expect((await h.store.get(t1.id)).status).toBe("pending")
    expect(h.d.status().queuedCooldownCount).toBe(1) // 该任务在任务级冷却

    // 再次评估：pendingTotal=1 > 0，"empty" 守卫不应触发；
    // pending（剔除冷却后）为空，不应崩溃，也不应再次派发
    h.fire()
    await sleep(50)
    expect(h.lines.some((l) => l.includes("派发跳过：empty"))).toBe(false) // 不报 empty
    expect(h.session.prompts).toHaveLength(1) // 未再派发
    expect((await h.store.get(t1.id)).status).toBe("pending") // 任务仍在待领取
    h.d.dispose()
  }, 4000)

  test("全部待领取任务在任务冷却中时 lastSkipReason 应为 cooldown 而非空字符串", async () => {
    const h = harness({ claimWaitMs: 20, backoffBaseMs: 1000, minIntervalMs: 1 })
    await h.store.setSettings({ autoDispatch: true })
    const t1 = await toPending(h.store, "t1")
    h.fire()
    await sleep(50) // 派出，进入 awaiting（in-flight）
    expect(h.session.prompts).toHaveLength(1)

    await sleep(40) // claimWaitMs=20ms 超时，任务退回 pending 并进入任务冷却（1000ms）
    expect((await h.store.get(t1.id)).status).toBe("pending")
    expect(h.d.status().queuedCooldownCount).toBe(1)

    // 再次评估：pendingTotal=1 > 0，pending（剔除冷却后）为空
    h.fire()
    await sleep(50)
    expect(h.lines.some((l) => l.includes("派发跳过：empty"))).toBe(false) // 不报 empty
    expect(h.session.prompts).toHaveLength(1) // 未再派发
    expect((await h.store.get(t1.id)).status).toBe("pending") // 任务仍在待领取
    // lastSkipReason 应如实反映：待领取任务存在但全部在任务级冷却中，不可立即派发
    expect(h.d.status().lastSkipReason).toBe("cooldown")
    h.d.dispose()
  }, 4000)
})

describe("buildDispatchPrompt 项目行", () => {
  test("带 project 输出所属项目行;缺省省略该行", () => {
    const base = buildDispatchPrompt({ id: "task_1", title: "T" })
    expect(base).not.toContain("所属项目")
    const withP = buildDispatchPrompt({ id: "task_1", title: "T" }, { name: "网关", workspace: "/p1" })
    expect(withP).toContain("所属项目:网关（工作区:/p1）")
  })
})

describe("派发工作区解析", () => {
  test("任务归属项目 P → worker 会话建在 P.workspace,提示词带项目行", async () => {
    const h = harness({ claimWaitMs: 5_000 })
    const p = await h.store.createProject({ name: "网关", workspace: "/p1-workspace" })
    const t = await toPending(h.store, "项目任务")
    await h.store.patch(t.id, { projectId: p.id })
    await h.store.setSettings({ autoDispatch: true })
    await h.fire()
    await sleep(80)
    expect(h.session.created[0].directory).toBe("/p1-workspace")
    expect(h.session.prompts[0].text).toContain("所属项目:网关（工作区:/p1-workspace）")
    h.d.dispose()
  })

  test("任务归属默认项目 → 会话建在 ctx.directory,提示词省项目行", async () => {
    const h = harness({ claimWaitMs: 5_000 })
    await toPending(h.store, "默认项目任务")
    await h.store.setSettings({ autoDispatch: true })
    await h.fire()
    await sleep(80)
    expect(h.session.created[0].directory).toBe("/proj")
    expect(h.session.prompts[0].text).not.toContain("所属项目")
    h.d.dispose()
  })

  test("projectId 指向不存在项目 → 回退 ctx.directory 且日志含警示", async () => {
    const backend = memoryBackend()
    const store = createStore(backend, { requireAnalysisConfirm: false, directory: "/proj" })
    const entries: Record<string, unknown> = {}
    const created: { directory?: string }[] = []
    const lines: string[] = []
    let registered: ((tasks?: Task[]) => void) | null = null
    let seq = 0
    const session = {
      create: async (input?: { title?: string; location?: { directory: string } }) => {
        const id = `ses_w${++seq}`
        created.push({ directory: input?.location?.directory })
        return { id }
      },
      get: async () => ({}),
      prompt: async () => ({}),
      remove: async () => ({}),
    } satisfies DispatcherSession
    const d = initDispatcher(
      {
        session,
        storage: { get: async (k) => entries[k], set: async (k, v) => { entries[k] = v } },
        projectID: "p1",
        directory: "/proj",
      },
      {
        store,
        log: (m) => lines.push(m),
        onWrite: (fn) => (registered = fn),
        evaluateMs: 10,
        claimWaitMs: 5_000,
        minIntervalMs: 0,
        usagePollMs: 0,
        evaluateTickMs: 0,
      },
    )
    const t = await toPending(store, "幽灵项目任务")
    // 手工把归属指向已消失的项目(模拟存储键残留/外部改动——绕过 store 校验直接写 KV)
    const raw = (await backend.get(`task/${t.id}`)) as Task
    await backend.set(`task/${t.id}`, { ...raw, projectId: "project_ghost" })
    await store.setSettings({ autoDispatch: true })
    await registered?.()
    await sleep(80)
    expect(created[0].directory).toBe("/proj")
    expect(lines.some((m) => m.includes("project_ghost") && m.includes("回退"))).toBe(true)
    d.dispose()
  })
})
