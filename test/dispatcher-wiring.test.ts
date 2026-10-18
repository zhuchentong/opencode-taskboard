import { describe, expect, test } from "bun:test"
import { DISPATCH_CAPS, initDispatcher, type DispatcherSession } from "../src/dispatcher/index"
import { createStore, memoryBackend, type Store } from "../src/store"
import type { Task } from "../src/types"
import type { Task } from "../src/types"

// 把任务推进到 pending 的人工路径
async function toPending(s: Store, title: string): Promise<Task> {
  const t = await s.create({ title })
  return s.patch(t.id, { status: "pending" })
}

// 推进到 analyzing（占一个并发槽）。默认用外部会话，避免与派发器自己的会话混淆。
async function toAnalyzing(s: Store, title: string, sessionID = "ses_ext"): Promise<Task> {
  const t = await toPending(s, title)
  return s.claim({ id: t.id, sessionID, agent: "human" })
}

type TokenRead = { input: number; output: number; reasoning: number; cache: { read: number; write: number } }

function fakeSession() {
  const prompts: { sessionID: string; text: string }[] = []
  const created: { id: string; title?: string; directory?: string; model?: { providerID: string; id: string } }[] = []
  const removed: string[] = []
  const tokens = new Map<string, TokenRead>()
  let seq = 0
  const sess = {
    prompts,
    created,
    removed,
    tokens,
    create: async (input?: { title?: string; location?: { directory: string }; model?: { providerID: string; id: string } }) => {
      const id = `ses_w${++seq}`
      created.push({ id, title: input?.title, directory: input?.location?.directory, model: input?.model })
      return { id, title: input?.title }
    },
    get: async (input: { sessionID: string }) => {
      if (!created.some((c) => c.id === input.sessionID)) throw new Error("no such session")
      return { id: input.sessionID, tokens: tokens.get(input.sessionID) }
    },
    prompt: async (input: { sessionID: string; text: string }) => {
      prompts.push(input)
      return {}
    },
    remove: async (input: { sessionID: string }) => {
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
  } = {},
) {
  const entries: Record<string, unknown> = {}
  const storage = {
    get: async (k: string) => entries[k],
    set: async (k: string, v: unknown) => {
      entries[k] = v
    },
  }
  const store = createStore(memoryBackend(), { requireAnalysisConfirm: false })
  const lines: string[] = []
  const broadcasts: number[] = []
  let registered: (() => void) | null = null
  const session = fakeSession()
  if (opts.promptFail) session.prompt = async () => { throw new Error("session api down") }
  if (opts.createFail) session.create = async () => { throw new Error("cannot create session") }
  const d = initDispatcher(
    { session, storage, projectID: "p1", directory: "/proj" },
    {
      store,
      log: (m) => lines.push(m),
      onWrite: (fn) => (registered = fn),
      broadcast: async () => {
        broadcasts.push(Date.now())
      },
      evaluateMs: opts.evaluateMs ?? 10,
      claimWaitMs: opts.claimWaitMs ?? 20,
      backoffBaseMs: opts.backoffBaseMs,
      minIntervalMs: opts.minIntervalMs,
      usagePollMs: opts.usagePollMs ?? 0, // 默认关掉：定时刷新会干扰断言，只在专门的用例里开
      evaluateTickMs: opts.evaluateTickMs ?? 0, // 默认关掉：兜底 tick 会干扰断言，只在专门的用例里开
    },
  )
  return {
    d,
    store,
    storage,
    session,
    lines,
    broadcasts,
    // 带载荷触发(计划任务 7:对齐 server 真实链路,沿处理走实时路径);缺省时拉全量
    fire: async (tasks?: Task[]) => registered?.(tasks ?? (await store.list())),
    entries,
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("派发延迟修订：按任务冷却与即时填槽", () => {
  // 公共参数：超时极短、退避极长（保证断言时冷却窗口未过）、排除节流与定时器干扰
  const FAST = {
    claimWaitMs: 10,
    backoffBaseMs: 60_000,
    minIntervalMs: 0,
    evaluateTickMs: 0,
  }
  /** 建派发器并开启自动派发（显式声明,不依赖默认值) */
  async function armed(opts = {}) {
    const h = harness({ ...FAST, ...opts })
    await h.store.setSettings({ autoDispatch: true })
    return h
  }

  test("① 超时冷却只锁该任务：A 冷却中，新建的 C 仍立即派发", async () => {
    const h = await armed()
    await toPending(h.store, "任务A")
    h.fire()
    await sleep(80)
    expect(h.session.prompts).toHaveLength(1) // A 已派出

    await sleep(80) // 等 claimWaitMs=10ms 超时：A 退回 + 进入任务冷却
    expect(h.session.removed).toHaveLength(1) // A 的会话已回收

    expect(h.d.status().queuedCooldownCount).toBe(1) // 只有 A 在冷却

    await toPending(h.store, "任务C")
    h.fire()
    await sleep(80)
    // A 在冷却，但 C 不受牵连：C 的派发 prompt 应已发出
    const c = await h.store.list().then((ts) => ts.find((t) => t.title === "任务C"))
    expect(h.session.prompts).toHaveLength(2)
    expect(h.session.prompts[1].text).toContain(c!.id)
  })

  test("② 对照：派发异常仍是全局冷却，新任务也被挡", async () => {
    const h = await armed({ promptFail: true })
    await toPending(h.store, "任务A")
    h.fire()
    await sleep(60)
    expect(h.session.prompts).toHaveLength(0)
    expect(h.d.status().state).toBe("cooldown")

    await toPending(h.store, "任务C")
    h.fire()
    await sleep(60)
    // 全局冷却未过：C 不被派发
    expect(h.session.prompts).toHaveLength(0)
  })

  test("③ 退回后零延迟填槽：B 在无写事件、无兜底 tick 时被立即派发", async () => {
    // 5 个外部会话先占 5 槽，留 1 个空位；A、B 竞争它
    const h = await armed({ claimWaitMs: 30 })
    for (let i = 0; i < 5; i++) await toAnalyzing(h.store, `占用${i}`, `ses_ext${i}`)
    await toPending(h.store, "任务A")
    await toPending(h.store, "任务B")
    h.fire()
    // 此后不再 fire，且 evaluateTickMs=0 关掉了兜底 tick：
    // B 的派发只能来自 A 超时退回时 releaseStalled 末尾的 scheduleEvaluate
    await sleep(400)
    const b = await h.store.list().then((ts) => ts.find((t) => t.title === "任务B"))
    // 断言行为而非时序位置：B 的派发 prompt 必须出现过（它绝不该靠 tick 或写事件上位）
    expect(
      h.session.prompts.some((p) => p.text.includes(b!.id)),
      `B 未被派出，实际派发序列：${h.session.prompts.map((p) => (p.text.match(/任务标题：(\S+)/) ?? [])[1]).join(" → ")}`,
    ).toBe(true)
  })

  test("④ 任务已删除（not_found）：回收会话、不计连败、不设冷却", async () => {
    const h = await armed({ claimWaitMs: 200 })
    const a = await toPending(h.store, "任务A")
    h.fire()
    await sleep(60)
    expect(h.session.prompts).toHaveLength(1)

    await h.store.remove(a.id) // 在超时前删任务，超时流程将撞 not_found
    await sleep(250)
    expect(h.session.removed).toHaveLength(1) // 会话仍要回收，不能残留烧 token
    const st = h.d.status()
    expect(st.timeoutStreak).toBe(0) // 删任务不是 worker 的错
    expect(st.queuedCooldownCount).toBe(0) // 也不设任务冷却
  })

  test("⑤ 自动派发关开复位：taskCooldown 一并清空", async () => {
    const h = await armed()
    const a = await toPending(h.store, "任务A")
    h.fire()
    await sleep(140) // A 超时退回并进入任务冷却
    expect(h.d.status().queuedCooldownCount).toBe(1)

    // 删掉任务：否则复位后 A 立刻被重新派出、又超时，冷却里会立刻多回一条，掩盖断言
    await h.store.remove(a.id)
    await h.store.setSettings({ autoDispatch: false })
    h.d.notifyWrite()
    await sleep(40)
    await h.store.setSettings({ autoDispatch: true })
    h.d.notifyWrite()
    await sleep(40)
    expect(h.d.status().queuedCooldownCount).toBe(0)
  })

  test("⑥ 排队日志计全量：冷却中的任务也计入排队数", async () => {
    const h = await armed()
    for (let i = 0; i < 5; i++) await toAnalyzing(h.store, `占用${i}`, `ses_ext${i}`)
    await toPending(h.store, "任务A")
    h.fire()
    await sleep(140) // A 派出（第 6 槽）→ 超时退回进冷却
    await toAnalyzing(h.store, "占用5", "ses_ext5") // 重新占满 6 槽
    await toPending(h.store, "任务B")
    h.fire()
    await sleep(60)
    // A 在冷却 + B 在等 → 排队数是 2，不是 1
    expect(h.lines.some((l) => l.includes("concurrency-full") && l.includes("2 个任务排队"))).toBe(true)
  })
})

describe("initDispatcher 接线", () => {
  test("开关关闭时写事件不派发", async () => {
    const h = harness()
    await h.store.setSettings({ autoDispatch: false }) // 显式关闭:默认已改为开启,此测试钉「关」的语义
    await toPending(h.store, "t1")
    h.fire()
    await sleep(40)
    expect(h.session.prompts).toHaveLength(0)
    h.d.dispose()
  })

  test("环境自举：存量 pending 任务在 dispatcher 就绪后即被派发，无需手动 fire", async () => {
    // 先建 pending 任务（模拟环境自举时存量任务已存在于 store），再创建派发器
    const entries: Record<string, unknown> = {}
    const storage = {
      get: async (k: string) => entries[k],
      set: async (k: string, v: unknown) => {
        entries[k] = v
      },
    }
    const store = createStore(memoryBackend(), { requireAnalysisConfirm: false })
    await store.setSettings({ autoDispatch: true })
    await toPending(store, "存量任务")

    const session = fakeSession()
    const lines: string[] = []
    let registered: ((tasks?: Task[]) => void) | null = null
    const d = initDispatcher(
      { session, storage, projectID: "p1", directory: "/proj" },
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
    // 不调用 registered() / fire()，仅等待自启动评估（evaluateMs=10 防抖）
    await sleep(200)
    expect(session.prompts).toHaveLength(1)
    expect(session.prompts[0].text).toContain("存量任务")
    d.dispose()
  })

  test("pending + 开关开启 → 每任务新建会话并派发，prompt 带上 taskID，工作目录为项目目录", async () => {
    const h = harness()
    const t = await toPending(h.store, "写个功能")
    await h.store.setSettings({ autoDispatch: true })
    h.fire()
    await sleep(60)
    expect(h.session.prompts).toHaveLength(1)
    expect(h.session.prompts[0].sessionID).toBe("ses_w1")
    expect(h.session.prompts[0].text).toContain("自动派发")
    // 预分配 taskID：并发下 worker 不再自己去抢任务
    expect(h.session.prompts[0].text).toContain(t.id)
    expect(h.session.prompts[0].text).toContain("写个功能")
    // 工作目录必须显式传，否则回退到服务进程 cwd（曾落到 .debug/playground）
    expect(h.session.created[0].directory).toBe("/proj")
    expect(h.session.created[0].title).toContain("写个功能")
    // 一任务一会话 → 不再有持久 worker 指针
    expect(await h.storage.get("p1/settings/dispatcher-session")).toBeUndefined()
    // 日计数落 storage
    expect(Object.keys(h.entries).some((k) => k.startsWith("p1/dispatcher/"))).toBe(true)
    expect(h.lines.some((l) => l.includes("派发 →"))).toBe(true)
    h.d.dispose()
  })

  test("并发槽满（maxConcurrent）不再派发", async () => {
    const h = harness()
    await h.store.setSettings({ autoDispatch: true })
    for (let i = 0; i < DISPATCH_CAPS.maxConcurrent; i++) await toAnalyzing(h.store, `占用${i}`)
    await toPending(h.store, "排队中")
    h.fire()
    await sleep(60)
    expect(h.session.prompts).toHaveLength(0)
    expect(h.lines.some((l) => l.includes("派发跳过：concurrency-full"))).toBe(true)
    // 可见性：满员时日志要带上排队数，否则用户无法区分「排队」与「故障」
    expect(h.lines.some((l) => l.includes("个任务排队"))).toBe(true)
    h.d.dispose()
  })

  test("多任务真并行：每个任务各自新建会话，互不复用", async () => {
    const h = harness({ minIntervalMs: 1, claimWaitMs: 5_000 })
    await h.store.setSettings({ autoDispatch: true })
    const ids: string[] = []
    for (let i = 0; i < 3; i++) ids.push((await toPending(h.store, `任务${i}`)).id)
    for (let i = 0; i < 3; i++) {
      h.fire()
      await sleep(50)
    }
    expect(h.session.prompts).toHaveLength(3)
    expect(h.session.created).toHaveLength(3)
    expect(new Set(h.session.prompts.map((p) => p.sessionID)).size).toBe(3) // 三个会话互不相同
    const seen = h.session.prompts.map((p) => ids.find((id) => p.text.includes(id)))
    expect(new Set(seen).size).toBe(3) // 每个会话认领的是各自的任务
    expect(h.d.status().inFlight).toBe(3) // 在途派发占槽
    h.d.dispose()
  })

  test("未领取超时 → 任务退回待领取并回收名额，但不暂停全局派发", async () => {
    const h = harness({ claimWaitMs: 20, backoffBaseMs: 10, minIntervalMs: 1, evaluateMs: 10 })
    const t = await toPending(h.store, "没人领")
    await h.store.setSettings({ autoDispatch: true })
    h.fire()
    await sleep(120) // 10ms 节流 + 20ms 超时 + 回收
    expect((await h.store.get(t.id)).status).toBe("pending") // 退回待领取，可重新派
    expect(h.d.status().timeoutStreak).toBe(1)
    // 未领取不置 paused：慢 worker 不该把整个派发器停掉
    expect(h.d.status().state).not.toBe("paused")
    expect(h.lines.some((l) => l.includes("派发超时未见领取"))).toBe(true)
    expect(h.session.removed).toEqual(["ses_w1"]) // 会话已回收
    h.d.dispose()
  }, 4000)

  test("冷却到期后无写事件，兜底 tick 自动恢复派发", async () => {
    // 真实事故：评估纯写事件驱动，超时冷却到期后无人再触发 → 任务挂在待领取
    const h = harness({ claimWaitMs: 20, backoffBaseMs: 30, minIntervalMs: 1, evaluateMs: 10, evaluateTickMs: 15 })
    const t = await toPending(h.store, "兜底恢复")
    await h.store.setSettings({ autoDispatch: true })
    h.fire()
    await sleep(500) // 首派 10ms + 超时 20ms + 冷却 30ms + tick 15ms → 第二轮派发
    const dispatches = h.lines.filter((l) => l.includes("派发 →")).length
    expect(dispatches).toBeGreaterThanOrEqual(2) // 兜底 tick 触发了第二轮派发
    expect((await h.store.get(t.id)).status).toBe("pending") // 第二个 worker 也未领取，任务仍在池中
    h.d.dispose()
  }, 4000)

  test("已领取的在途派发即时释放名额", async () => {
    const h = harness({ minIntervalMs: 1, claimWaitMs: 5_000 })
    await h.store.setSettings({ autoDispatch: true })
    const t = await toPending(h.store, "t1")
    h.fire()
    await sleep(50)
    expect(h.d.status().inFlight).toBe(1)
    await h.store.claim({ id: t.id, sessionID: "ses_w1", agent: "build" })
    h.fire()
    await sleep(50)
    expect(h.d.status().inFlight).toBe(0) // 名额回收，不会泄漏
    // 观测口径：派发→领取耗时入日志
    expect(h.lines.some((l) => l.includes("已领取 task=") && l.includes("派发→领取"))).toBe(true)
    h.d.dispose()
  })

  test("沿驱动执行唤醒：放行唤醒一次；同会话多次跳转后第二轮放行再唤醒（缺陷 3/4 回归钉子）", async () => {
    const h = harness({ claimWaitMs: 5_000 })
    await h.store.setSettings({ autoDispatch: true, requireAnalysisConfirm: true })
    const t = await toPending(h.store, "nudge-任务")
    await h.store.claim({ id: t.id, sessionID: "ses_w1", agent: "build" })
    await h.store.analyze({ id: t.id, sessionID: "ses_w1", analysis: "a" })
    expect((await h.store.get(t.id)).status).toBe("analysis_confirm")
    // 第一次评估：观察到 analysis_confirm → 记入 lastSeen（不唤醒）
    h.fire()
    await sleep(40)
    const promptsBefore = h.session.prompts.length
    // 用户在网页点「通过」→ executing（claim 保留）→ 沿出现 → 唤醒
    await h.store.patch(t.id, { action: "confirm" })
    h.fire()
    await sleep(40)
    expect(h.session.prompts.length).toBe(promptsBefore + 1)
    expect(h.session.prompts.at(-1)!.sessionID).toBe("ses_w1")
    expect(h.session.prompts.at(-1)!.text).toContain("已放行")
    // 重复写事件（同状态无新沿）不重复唤醒
    h.fire()
    await sleep(40)
    expect(h.session.prompts.length).toBe(promptsBefore + 1)
    // 多次跳转（同会话问答循环）：拖拽回 analyzing（claim 保留）→ 重新分析 → 再放行 → 同会话再唤醒
    await h.store.patch(t.id, { status: "analyzing" })
    h.fire()
    await sleep(40)
    await h.store.analyze({ id: t.id, sessionID: "ses_w1", analysis: "a2" }) // → analysis_confirm
    h.fire()
    await sleep(40)
    await h.store.patch(t.id, { action: "confirm" }) // 第二轮放行 → executing 沿（新 seq）→ 必须再唤醒
    h.fire()
    await sleep(40)
    const last = h.session.prompts.at(-1)!
    expect(last.sessionID).toBe("ses_w1")
    expect(last.text).toContain("已放行")
    expect(h.session.prompts.length).toBe(promptsBefore + 2)
    h.d.dispose()
  }, 4000)

  test("confirm-off（默认流程）：worker 自查自执行不经停确认 → 不打断", async () => {
    const h = harness({ claimWaitMs: 5_000 })
    await h.store.setSettings({ autoDispatch: true })
    const t = await toPending(h.store, "快速任务")
    await h.store.claim({ id: t.id, sessionID: "ses_w1", agent: "build" })
    await h.store.analyze({ id: t.id, sessionID: "ses_w1", analysis: "a" }) // → executing（无确认关卡）
    h.fire()
    await sleep(60)
    expect(h.session.prompts).toHaveLength(0)
    h.d.dispose()
  })

  test("派发异常进全局熔断：prompt 抛错计连败并冷却，3 连败暂停", async () => {
    const h = harness({ promptFail: true, backoffBaseMs: 10, minIntervalMs: 1, evaluateMs: 10 })
    await toPending(h.store, "t1")
    await h.store.setSettings({ autoDispatch: true })
    for (let i = 1; i <= 3; i++) {
      h.fire()
      await sleep(80)
    }
    expect(h.d.status().state).toBe("paused")
    expect(h.d.status().failStreak).toBe(3)
    // 精确匹配熔断日志：「回收会话 …（派发失败）」也含同四个字，不能计入
    expect(h.lines.filter((l) => l.includes("派发失败（第")).length).toBe(3)
    // 派发失败回收名额与建出的会话，不泄漏
    expect(h.d.status().inFlight).toBe(0)
    expect(h.session.removed.length).toBeGreaterThanOrEqual(1)
    h.d.dispose()
  })

  test("建会话失败不算派发失败：任务留在待领取，等下轮重试", async () => {
    const h = harness({ createFail: true, minIntervalMs: 1, evaluateMs: 10 })
    const t = await toPending(h.store, "t1")
    await h.store.setSettings({ autoDispatch: true })
    h.fire()
    await sleep(50)
    expect(h.session.prompts).toHaveLength(0)
    expect(h.d.status().failStreak).toBe(0) // 会话建不出来不代表会话 API 故障
    expect(h.d.status().inFlight).toBe(0)
    expect((await h.store.get(t.id)).status).toBe("pending")
    h.d.dispose()
  })

  test("冷却窗口内不重复派发同一任务（超时退避按任务绑定，不牵连其他任务）", async () => {
    const h = harness({ claimWaitMs: 20, backoffBaseMs: 1_000, minIntervalMs: 1 })
    await h.store.setSettings({ autoDispatch: true })
    const t1 = await toPending(h.store, "t1")
    h.fire()
    await sleep(50)
    expect(h.session.prompts).toHaveLength(1)
    // 未领取超时退回，进入该任务自己的 1s 退避窗口；期间重复写事件不应再派它
    await sleep(40)
    h.fire()
    await sleep(50)
    expect(h.session.prompts).toHaveLength(1)
    expect((await h.store.get(t1.id)).status).toBe("pending")
    h.d.dispose()
  })

  test("任务终结补记 token 消耗并广播快照", async () => {
    const h = harness({ claimWaitMs: 5_000 })
    await h.store.setSettings({ autoDispatch: true })
    const t = await toPending(h.store, "耗时任务")
    await h.store.claim({ id: t.id, sessionID: "ses_w1", agent: "build" })
    // 手工造的 claim 要有对应会话，否则 session.get 探活失败、读不到 token
    h.session.created.push({ id: "ses_w1" })
    h.session.tokens.set("ses_w1", { input: 100, output: 200, reasoning: 0, cache: { read: 300, write: 10 } })
    await h.store.analyze({ id: t.id, sessionID: "ses_w1", analysis: "a" })
    await h.store.complete({ id: t.id, sessionID: "ses_w1", result: "r" })
    expect((await h.store.get(t.id)).status).toBe("completion_confirm")
    h.fire()
    await sleep(50)
    const after = await h.store.get(t.id)
    expect(after.usage).toEqual({
      input: 100,
      output: 200,
      reasoning: 0,
      cacheRead: 300,
      cacheWrite: 10,
      at: expect.any(Number),
    })
    // store 层写入不经 HTTP 路由，必须显式广播才推得到看板
    expect(h.broadcasts.length).toBeGreaterThan(0)
    h.d.dispose()
  })

  test("消耗刷新定时器：活跃任务周期性回写 token", async () => {
    const h = harness({ claimWaitMs: 5_000, usagePollMs: 15 })
    await h.store.setSettings({ autoDispatch: true })
    const t = await toPending(h.store, "长任务")
    await h.store.claim({ id: t.id, sessionID: "ses_w1", agent: "build" })
    h.session.created.push({ id: "ses_w1" }) // 让 session.get 能查到
    h.session.tokens.set("ses_w1", { input: 5, output: 5, reasoning: 0, cache: { read: 0, write: 0 } })
    await sleep(80)
    expect((await h.store.get(t.id)).usage?.input).toBe(5)
    h.d.dispose()
  })
})
