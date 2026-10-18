import { describe, expect, test } from "bun:test"
import { createStore, memoryBackend, storageBackend } from "../src/store"
import { StoreError, type Status, type Store, type Task, type TaskUsage } from "../src/types"

const S = (requireAnalysisConfirm = false) => createStore(memoryBackend(), { requireAnalysisConfirm })

const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => "no-error",
    (e) => (e instanceof StoreError ? e.code : `unknown:${e}`),
  )

// 把任务从 planning 沿流水线驱动到指定状态（工具路径，sessionID 默认 s1）
async function toStatus(s: Store, t: Task, status: Status, sessionID = "s1"): Promise<Task> {
  let cur = t
  if (cur.status === "planning") cur = await s.patch(cur.id, { status: "pending" })
  if (status === "planning" || status === "pending") return cur
  if (status === "analyzing") return s.claim({ id: cur.id, sessionID, agent: "build" })
  if (status === "analysis_confirm" || status === "executing") {
    await s.claim({ id: cur.id, sessionID, agent: "build" })
    return s.analyze({ id: cur.id, sessionID, analysis: "方案" })
  }
  if (status === "completion_confirm") {
    await s.claim({ id: cur.id, sessionID, agent: "build" })
    await s.analyze({ id: cur.id, sessionID, analysis: "方案" })
    return s.complete({ id: cur.id, sessionID, result: "完成" })
  }
  return s.patch(cur.id, { status: "done" })
}

const newPending = async (s: Store, title = "任务") => toStatus(s, await s.create({ title }), "pending")

describe("create 与人工路径", () => {
  test("create 落 planning，字段齐全", async () => {
    const s = S()
    const t = await s.create({ title: "写个功能", description: "描述" })
    expect(t.status).toBe("planning")
    expect(t.id.startsWith("task_")).toBe(true)
    expect(t.comments).toEqual([])
    expect(t.claim).toBeUndefined()
    expect(t.createdAt).toBeGreaterThan(0)
  })

  test("create 空 title → invalid_input", async () => {
    expect(await codeOf(S().create({ title: "  " }))).toBe("invalid_input")
  })

  test("patch 人工兜底：任意流转允许（done→pending）", async () => {
    const s = S()
    const t = await toStatus(s, await s.create({ title: "t" }), "done")
    const r = await s.patch(t.id, { status: "pending" })
    expect(r.status).toBe("pending")
  })

  test("拖离 analyzing 清空 claim", async () => {
    const s = S()
    const t = await toStatus(s, await s.create({ title: "t" }), "analyzing")
    expect(t.claim?.agent).toBe("build")
    const r = await s.patch(t.id, { status: "pending" })
    expect(r.claim).toBeUndefined()
  })

  test("无 claim 拖入 analyzing → human 认领", async () => {
    const s = S()
    const t = await newPending(s)
    const r = await s.patch(t.id, { status: "analyzing" })
    expect(r.claim?.agent).toBe("human")
  })

  test("拖入 analysis_confirm 清空 claim", async () => {
    const s = S(true)
    const t = await toStatus(s, await s.create({ title: "t" }), "analysis_confirm")
    const r = await s.patch(t.id, { status: "analysis_confirm" })
    expect(r.claim).toBeUndefined()
  })
})

describe("工具路径流转", () => {
  test("claim：pending→analyzing 并写 claim", async () => {
    const s = S()
    const t = await newPending(s)
    const r = await s.claim({ id: t.id, sessionID: "s1", agent: "build" })
    expect(r.status).toBe("analyzing")
    expect(r.claim).toEqual({ sessionID: "s1", agent: "build", claimedAt: expect.any(Number) })
  })

  test("analyze 设置关：analyzing→executing，到达状态可见", async () => {
    const s = S(false)
    const t = await toStatus(s, await s.create({ title: "t" }), "analyzing")
    const r = await s.analyze({ id: t.id, sessionID: "s1", analysis: "结论" })
    expect(r.status).toBe("executing")
    expect(r.analysis).toBe("结论")
  })

  test("analyze 设置开：analyzing→analysis_confirm", async () => {
    const s = S(true)
    const t = await toStatus(s, await s.create({ title: "t" }), "analyzing")
    const r = await s.analyze({ id: t.id, sessionID: "s1", analysis: "结论" })
    expect(r.status).toBe("analysis_confirm")
  })

  test("setSettings 后 analyze 行为随之变化", async () => {
    const s = S(false)
    const t1 = await toStatus(s, await s.create({ title: "t1" }), "analyzing")
    expect((await s.analyze({ id: t1.id, sessionID: "s1", analysis: "a" })).status).toBe("executing")
    await s.setSettings({ requireAnalysisConfirm: true })
    expect(await s.getSettings()).toEqual({ requireAnalysisConfirm: true, autoDispatch: true })
    const t2 = await toStatus(s, await s.create({ title: "t2" }), "analyzing")
    expect((await s.analyze({ id: t2.id, sessionID: "s1", analysis: "b" })).status).toBe("analysis_confirm")
  })

  test("complete：executing→completion_confirm，记录 result", async () => {
    const s = S()
    const t = await toStatus(s, await s.create({ title: "t" }), "executing")
    const r = await s.complete({ id: t.id, sessionID: "s1", result: "搞定了" })
    expect(r.status).toBe("completion_confirm")
    expect(r.result).toBe("搞定了")
  })

  test("release：analyzing/executing→pending 且清 claim", async () => {
    const s = S()
    const a = await toStatus(s, await s.create({ title: "a" }), "analyzing")
    const b = await toStatus(s, await s.create({ title: "b" }), "executing")
    expect((await s.release({ id: a.id, sessionID: "s1" })).claim).toBeUndefined()
    expect((await s.release({ id: b.id, sessionID: "s1" })).status).toBe("pending")
  })

  test("confirm analysis_confirm→executing 且 claim 保留（审批不改变执行者）", async () => {
    const s = S(true)
    const t = await toStatus(s, await s.create({ title: "t" }), "analysis_confirm")
    const r = await s.patch(t.id, { action: "confirm" })
    expect(r.status).toBe("executing")
    expect(r.claim?.sessionID).toBe("s1")
  })

  test("confirm completion_confirm→done", async () => {
    const s = S()
    const t = await toStatus(s, await s.create({ title: "t" }), "completion_confirm")
    expect((await s.patch(t.id, { action: "confirm" })).status).toBe("done")
  })
})

describe("确认与打回（reject）", () => {
  test("reject 无评论 → comment_required 且状态不变", async () => {
    const s = S()
    const t = await toStatus(s, await s.create({ title: "t" }), "completion_confirm")
    expect(await codeOf(s.patch(t.id, { action: "reject" }))).toBe("comment_required")
    expect(await codeOf(s.patch(t.id, { action: "reject", comment: "   " }))).toBe("comment_required")
    expect((await s.get(t.id))?.status).toBe("completion_confirm")
  })

  test("reject 完成确认：→pending、清 claim、评论入列 author=user", async () => {
    const s = S()
    const t = await toStatus(s, await s.create({ title: "t" }), "completion_confirm")
    const r = await s.patch(t.id, { action: "reject", comment: "重新做" })
    expect(r.status).toBe("pending")
    expect(r.claim).toBeUndefined()
    expect(r.comments).toEqual([{ author: "user", text: "重新做", createdAt: expect.any(Number) }])
  })

  test("reject 分析确认：→pending", async () => {
    const s = S(true)
    const t = await toStatus(s, await s.create({ title: "t" }), "analysis_confirm")
    expect((await s.patch(t.id, { action: "reject", comment: "方案不行" })).status).toBe("pending")
  })

  test("confirm 在不可确认状态 → invalid_transition", async () => {
    const s = S()
    const t = await newPending(s)
    expect(await codeOf(s.patch(t.id, { action: "confirm" }))).toBe("invalid_transition")
  })

  test("comment 动作：不改状态追加用户评论；空评论拒绝；未知动作拒绝", async () => {
    const s = S()
    const t = await toStatus(s, await s.create({ title: "t" }), "analyzing")
    const r = await s.patch(t.id, { action: "comment", comment: "补充信息：优先级高" })
    expect(r.status).toBe("analyzing")
    expect(r.comments).toEqual([{ author: "user", text: "补充信息：优先级高", createdAt: expect.any(Number) }])
    expect(await codeOf(s.patch(t.id, { action: "comment" }))).toBe("comment_required")
    expect(await codeOf(s.patch(t.id, { action: "nonsense" as never, comment: "x" }))).toBe("invalid_input")
  })

  test("打回后可被再次认领，上一轮评论保留", async () => {
    const s = S()
    const t = await toStatus(s, await s.create({ title: "t" }), "completion_confirm")
    await s.patch(t.id, { action: "reject", comment: "返工" })
    const again = await s.claim({ id: t.id, sessionID: "s2", agent: "build" })
    expect(again.status).toBe("analyzing")
    expect(again.comments).toHaveLength(1)
    expect(again.claim?.sessionID).toBe("s2")
  })
})

describe("非法流转与归属校验", () => {
  test("claim 非 pending → invalid_transition", async () => {
    const s = S()
    const t = await toStatus(s, await s.create({ title: "t" }), "analyzing")
    expect(await codeOf(s.claim({ id: t.id, sessionID: "s2", agent: "build" }))).toBe("invalid_transition")
  })

  test("complete 非 executing → invalid_transition", async () => {
    const s = S()
    const t = await toStatus(s, await s.create({ title: "t" }), "analyzing")
    expect(await codeOf(s.complete({ id: t.id, sessionID: "s1" }))).toBe("invalid_transition")
  })

  test("analyze 非 analyzing → invalid_transition", async () => {
    const s = S()
    const t = await newPending(s)
    expect(await codeOf(s.analyze({ id: t.id, sessionID: "s1", analysis: "a" }))).toBe("invalid_transition")
  })

  test("release 非 analyzing/executing → invalid_transition", async () => {
    const s = S()
    const t = await newPending(s)
    expect(await codeOf(s.release({ id: t.id, sessionID: "s1" }))).toBe("invalid_transition")
  })

  test("human claim 下 analyze/complete/release → not_claimer", async () => {
    const s = S()
    const pending = await newPending(s)
    const t = await s.patch(pending.id, { status: "analyzing" })
    const human = { sessionID: "", agent: "human" }
    expect(t.claim).toEqual({ ...human, claimedAt: expect.any(Number) })
    expect(await codeOf(s.analyze({ id: t.id, sessionID: "any", agent: "human", analysis: "a" } as never))).toBe("not_claimer")
    await s.patch(t.id, { status: "executing" })
    expect(await codeOf(s.complete({ id: t.id, sessionID: "any", agent: "human" } as never))).toBe("not_claimer")
    expect(await codeOf(s.release({ id: t.id, sessionID: "any", agent: "human" } as never))).toBe("not_claimer")
  })

  test("非本人 sessionID 操作 → not_claimer", async () => {
    const s = S()
    const t = await toStatus(s, await s.create({ title: "t" }), "executing")
    expect(await codeOf(s.complete({ id: t.id, sessionID: "other" }))).toBe("not_claimer")
    expect(await codeOf(s.updateNotes({ id: t.id, sessionID: "other", result: "x" }))).toBe("not_claimer")
  })

  test("updateNotes 领取者可改备注", async () => {
    const s = S()
    const t = await toStatus(s, await s.create({ title: "t" }), "executing")
    const r = await s.updateNotes({ id: t.id, sessionID: "s1", result: "进度 50%" })
    expect(r.result).toBe("进度 50%")
  })

  test("不存在的任务 → not_found", async () => {
    const s = S()
    expect(await codeOf(s.get("task_nope"))).toBe("not_found")
    expect(await codeOf(s.patch("task_nope", { title: "x" }))).toBe("not_found")
    expect(await codeOf(s.remove("task_nope"))).toBe("not_found")
    expect(await codeOf(s.claim({ id: "task_nope", sessionID: "s1", agent: "build" }))).toBe("not_found")
  })
})

describe("并发与列表", () => {
  test("并发 claim 同一任务恰一人成功", async () => {
    const s = S()
    const t = await newPending(s)
    const results = await Promise.allSettled([
      s.claim({ id: t.id, sessionID: "a", agent: "build" }),
      s.claim({ id: t.id, sessionID: "b", agent: "build" }),
    ])
    const states = results.map((r) => r.status)
    expect(states.sort()).toEqual(["fulfilled", "rejected"])
    const loser = (results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason
    expect(loser).toBeInstanceOf(StoreError)
    expect((loser as StoreError).code).toBe("invalid_transition")
  })

  test("两次无 id claim 各领不同任务；无 pending → no_pending", async () => {
    const s = S()
    await newPending(s, "甲")
    await newPending(s, "乙")
    const c1 = await s.claim({ sessionID: "s1", agent: "build" })
    const c2 = await s.claim({ sessionID: "s2", agent: "build" })
    expect(c1.id).not.toBe(c2.id)
    expect(await codeOf(s.claim({ sessionID: "s3", agent: "build" }))).toBe("no_pending")
  })

  test("无 id claim 领最旧 pending（同 createdAt 按 id 兜底）", async () => {
    const s = S()
    const a = await newPending(s, "旧")
    const b = await newPending(s, "新")
    const got = await s.claim({ sessionID: "s1", agent: "build" })
    expect(got.id === a.id || got.id === b.id).toBe(true)
    expect(got.id).toBe([a, b].sort((x, y) => x.createdAt - y.createdAt || (x.id < y.id ? -1 : 1))[0].id)
  })

  test("list 按 updatedAt 倒序", async () => {
    const s = S()
    const t1 = await s.create({ title: "一" })
    const t2 = await s.create({ title: "二" })
    await s.patch(t1.id, { title: "一改" })
    const list = await s.list()
    expect(list.map((x) => x.id)).toEqual([t1.id, t2.id])
  })

  test("remove 后列表与 get 均不含", async () => {
    const s = S()
    const t = await s.create({ title: "t" })
    await s.remove(t.id)
    expect(await s.list()).toEqual([])
    expect(await codeOf(s.get(t.id))).toBe("not_found")
  })
})

describe("storageBackend 分页", () => {
  // 模拟 ctx.storage：scan 按 after（字典序）+ limit 截断，返回 { entries, next }
  function fakeCtxStorage(entries: Record<string, unknown>) {
    return {
      async get(key: string) {
        return entries[key]
      },
      async set(key: string, value: unknown) {
        entries[key] = value
      },
      async remove(key: string) {
        delete entries[key]
      },
      async scan(opts: { prefix: string; after?: string; limit?: number }) {
        const keys = Object.keys(entries)
          .filter((k) => k.startsWith(opts.prefix))
          .sort()
        let start = 0
        if (opts.after) {
          const i = keys.findIndex((k) => k > opts.after!)
          start = i < 0 ? keys.length : i
        }
        const limit = opts.limit ?? 100
        const page = keys.slice(start, start + limit)
        return {
          entries: page.map((k) => ({ key: k, value: entries[k] })),
          next: start + limit < keys.length ? page[page.length - 1] : undefined,
        }
      },
    }
  }

  test("跨页 scan 取全量，key 带 keyPrefix，remove 生效", async () => {
    const entries: Record<string, unknown> = {}
    const s = createStore(storageBackend(fakeCtxStorage(entries), "proj1/"), {
      requireAnalysisConfirm: false,
    })
    const t1 = await s.create({ title: "一" })
    const t2 = await s.create({ title: "二" })
    const t3 = await s.create({ title: "三" })
    // 3 个任务 + key 前缀
    const taskKeys = Object.keys(entries).filter((k) => k.includes("task/"))
    expect(taskKeys).toHaveLength(3)
    expect(taskKeys.every((k) => k.startsWith("proj1/"))).toBe(true)

    const list = await s.list()
    expect(list.map((x) => x.id).sort()).toEqual([t1.id, t2.id, t3.id].sort())

    await s.remove(t2.id)
    expect((await s.list()).map((x) => x.id).sort()).toEqual([t1.id, t3.id].sort())
  })

  test("settings 落在 keyPrefix 下且持久", async () => {
    const entries: Record<string, unknown> = {}
    const s = createStore(storageBackend(fakeCtxStorage(entries), "proj1/"), {
      requireAnalysisConfirm: false,
    })
    await s.setSettings({ requireAnalysisConfirm: true })
    expect(Object.keys(entries)).toContain("proj1/settings/board")
    expect(await s.getSettings()).toEqual({ requireAnalysisConfirm: true, autoDispatch: true })
  })
})

describe("设置扩展与合并写入（autoDispatch）", () => {
  test("缺省设置包含 autoDispatch:true(默认开启)", async () => {
    const s = S(false)
    expect(await s.getSettings()).toEqual({ requireAnalysisConfirm: false, autoDispatch: true })
  })

  test("旧格式存储缺 autoDispatch → 补默认值(默认开启)", async () => {
    const entries: Record<string, unknown> = {}
    const ctxStorage = {
      get: async (k: string) => entries[k],
      set: async (k: string, v: unknown) => {
        entries[k] = v
      },
    }
    const s = createStore(storageBackend(ctxStorage, "proj1/"), { requireAnalysisConfirm: false })
    await s.setSettings({ requireAnalysisConfirm: true, autoDispatch: true })
    // 模拟旧版本只存了一个字段
    entries["proj1/settings/board"] = { requireAnalysisConfirm: true }
    expect(await s.getSettings()).toEqual({ requireAnalysisConfirm: true, autoDispatch: true })
  })

  test("合并写入：只改一个字段不抹另一个", async () => {
    const s = S(false)
    await s.setSettings({ autoDispatch: true })
    expect(await s.getSettings()).toEqual({ requireAnalysisConfirm: false, autoDispatch: true })
    await s.setSettings({ requireAnalysisConfirm: true })
    expect(await s.getSettings()).toEqual({ requireAnalysisConfirm: true, autoDispatch: true })
  })

  test("非布尔值 → invalid_input", async () => {
    const s = S(false)
    await expect(s.setSettings({ autoDispatch: "yes" as never })).rejects.toMatchObject({ code: "invalid_input" })
    await expect(s.setSettings({ requireAnalysisConfirm: 1 as never })).rejects.toMatchObject({ code: "invalid_input" })
  })

  test("空 patch → invalid_input", async () => {
    const s = S(false)
    await expect(s.setSettings({})).rejects.toMatchObject({ code: "invalid_input" })
  })
})

describe("两段计时（spans）接入各写路径", () => {
  const done = (s: Task["spans"]): boolean =>
    !!s?.analyzing?.startedAt && !!s.analyzing.endedAt && !!s.executing?.startedAt && !!s.executing.endedAt

  test("闭环 claim→analyze→complete→confirm：两段均有起止且首尾不倒挂", async () => {
    const s = S(false)
    const t = await toStatus(s, await s.create({ title: "t" }), "completion_confirm")
    // 提交完成即封口执行段：等人工确认不再计时
    const mid = await s.get(t.id)
    expect(mid.spans?.analyzing?.endedAt).toBeGreaterThanOrEqual(mid.spans!.analyzing!.startedAt)
    expect(mid.spans?.executing?.startedAt).toBeGreaterThanOrEqual(mid.spans!.analyzing!.endedAt!)
    expect(mid.spans?.executing?.endedAt).toBeGreaterThanOrEqual(mid.spans!.executing!.startedAt)

    const fin = await s.patch(t.id, { action: "confirm" })
    expect(fin.status).toBe("done")
    expect(done(fin.spans)).toBe(true)
    // 等确认期间时长不再增长
    expect(fin.spans!.executing!.endedAt).toBe(mid.spans!.executing!.endedAt)
  })

  test("执行中：执行段进行中（无 endedAt），实时可算当前时长", async () => {
    const s = S(false)
    const t = await toStatus(s, await s.create({ title: "t" }), "executing")
    expect(t.spans?.executing?.startedAt).toBe(t.updatedAt)
    expect(t.spans?.executing?.endedAt).toBeUndefined()
    expect(t.spans?.analyzing?.endedAt).toBeGreaterThanOrEqual(t.spans!.analyzing!.startedAt)
  })

  test("需分析确认时：封口分析段并停表，确认后开执行段", async () => {
    const s = S(true)
    const t = await toStatus(s, await s.create({ title: "t" }), "analysis_confirm")
    expect(t.spans?.analyzing?.endedAt).toBeGreaterThanOrEqual(t.spans!.analyzing!.startedAt)
    expect(t.spans?.executing).toBeUndefined()

    const exec = await s.patch(t.id, { action: "confirm" })
    expect(exec.status).toBe("executing")
    expect(exec.spans?.executing).toEqual({ startedAt: exec.updatedAt })
  })

  test("只改标题不误封口进行中的段", async () => {
    const s = S(false)
    const t = await toStatus(s, await s.create({ title: "t" }), "executing")
    const r = await s.patch(t.id, { title: "改名" })
    expect(r.spans?.executing).toEqual(t.spans?.executing)
    expect(r.spans?.executing?.endedAt).toBeUndefined()
  })

  test("拖拽 analyzing→done：只封口分析段", async () => {
    const s = S(false)
    const t = await toStatus(s, await s.create({ title: "t" }), "analyzing")
    const r = await s.patch(t.id, { status: "done" })
    expect(r.spans?.analyzing?.endedAt).toBeGreaterThanOrEqual(r.spans!.analyzing!.startedAt)
    expect(r.spans?.executing).toBeUndefined()
  })

  test("打回与放弃回到待领取：spans 整体清空，重新领取开新一轮", async () => {
    const s = S(true)
    const t = await toStatus(s, await s.create({ title: "t" }), "analysis_confirm")
    const rejected = await s.patch(t.id, { action: "reject", comment: "重来" })
    expect(rejected.spans).toBeUndefined()

    const again = await s.claim({ id: t.id, sessionID: "s2", agent: "build" })
    expect(again.spans?.analyzing?.startedAt).toBeGreaterThanOrEqual(t.spans!.analyzing!.startedAt)
    expect(again.spans?.analyzing?.endedAt).toBeUndefined()

    const released = await s.release({ id: t.id, sessionID: "s2" })
    expect(released.spans).toBeUndefined()
  })

  test("人工拖入 analyzing 也开段，claim 会重开新一轮", async () => {
    const s = S(false)
    const t = await newPending(s)
    const dragged = await s.patch(t.id, { status: "analyzing" })
    expect(dragged.spans?.analyzing?.startedAt).toBe(dragged.updatedAt)

    const back = await s.patch(t.id, { status: "planning" })
    expect(back.spans?.analyzing?.endedAt).toBe(back.updatedAt)
    const redriven = await s.patch(t.id, { status: "analyzing" })
    expect(redriven.spans).toEqual({ analyzing: { startedAt: redriven.updatedAt } })
  })

  test("updateNotes 更新进度不干扰计时", async () => {
    const s = S(false)
    const t = await toStatus(s, await s.create({ title: "t" }), "executing")
    const r = await s.updateNotes({ id: t.id, sessionID: "s1", result: "50%" })
    expect(r.spans?.executing).toEqual(t.spans?.executing)
  })
})

describe("recordUsage", () => {
  const U = (over: Partial<TaskUsage> = {}): TaskUsage => ({
    input: 100,
    output: 200,
    reasoning: 300,
    cacheRead: 400,
    cacheWrite: 500,
    at: 1_700_000_000_000,
    ...over,
  })

  test("写入后可读回，五个计量字段与快照时间完整", async () => {
    const s = S()
    const t = await s.create({ title: "t" })
    const usage = U()
    const r = await s.recordUsage({ id: t.id, usage })
    expect(r.usage).toEqual(usage)
    expect((await s.get(t.id)).usage).toEqual(usage)
  })

  test("不刷新 updatedAt：消耗回写不惊动看板按更新时间的排序", async () => {
    const s = S()
    const t = await s.create({ title: "t" })
    const baseline = (await s.patch(t.id, { title: "改名" })).updatedAt
    // 让时钟真正走一格：否则「刷新 updatedAt」的写法会因同毫秒而假通过
    await Bun.sleep(5)
    const r = await s.recordUsage({ id: t.id, usage: U() })
    expect(r.updatedAt).toBe(baseline)
    expect((await s.get(t.id)).updatedAt).toBe(baseline)
  })

  test("不改动其他字段：状态/计时/claim 原样保留", async () => {
    const s = S()
    const t = await toStatus(s, await s.create({ title: "t" }), "executing")
    const r = await s.recordUsage({ id: t.id, usage: U() })
    expect(r.status).toBe(t.status)
    expect(r.claim).toEqual(t.claim)
    expect(r.spans).toEqual(t.spans)
  })

  test("任务不存在 → not_found", async () => {
    const s = S()
    expect(await codeOf(s.recordUsage({ id: "nope", usage: U() }))).toBe("not_found")
  })

  test("可覆盖写：连续两次以后者为准", async () => {
    const s = S()
    const t = await s.create({ title: "t" })
    await s.recordUsage({ id: t.id, usage: U({ input: 1 }) })
    const r = await s.recordUsage({ id: t.id, usage: U({ input: 9 }) })
    expect(r.usage?.input).toBe(9)
  })

  test("已有 usage 的任务再写 → 整体替换而非字段合并", async () => {
    const s = S()
    const t = await s.create({ title: "t" })
    await s.recordUsage({ id: t.id, usage: U({ input: 5, output: 6 }) })
    // 只带部分字段：若实现是「合并」，上一次的 reasoning/cacheRead 会残留
    const partial = { input: 1, output: 2, at: 42 } as TaskUsage
    const r = await s.recordUsage({ id: t.id, usage: partial })
    expect(r.usage).toEqual(partial)
    expect(Object.keys(r.usage!).sort()).toEqual(["at", "input", "output"])
  })
})

describe("pendingAt（排队计时起点）", () => {
  test("拖入 pending 时记录 pendingAt", async () => {
    const s = S()
    const t = await s.create({ title: "t" })
    expect(t.pendingAt).toBeUndefined()
    await Bun.sleep(5)
    const r = await s.patch(t.id, { status: "pending" })
    expect(r.pendingAt).toBeGreaterThan(t.createdAt)
  })

  test("已在 pending 改标题 → 不重置 pendingAt", async () => {
    const s = S()
    const t = await s.patch((await s.create({ title: "t" })).id, { status: "pending" })
    await Bun.sleep(5)
    const r = await s.patch(t.id, { title: "改名" })
    expect(r.pendingAt).toBe(t.pendingAt)
  })

  test("打回 pending → 重开一轮排队计时", async () => {
    const s = S(true) // 需分析确认，任务才真停在 analysis_confirm 可被打回
    const t2 = await toStatus(s, await s.create({ title: "t2" }), "analysis_confirm")
    const first = await s.patch(t2.id, { status: "pending" }) // 拖回 pending，开第一轮
    expect(first.pendingAt).toBeGreaterThan(0)
    await Bun.sleep(5)
    const t3 = await toStatus(s, await s.create({ title: "t3" }), "analysis_confirm")
    const back = await s.patch(t3.id, { action: "reject", comment: "重来" })
    expect(back.status).toBe("pending")
    expect(back.pendingAt).toBeGreaterThan(first.pendingAt)
  })

  test("claim 离开 pending → 保留 pendingAt 作为历史", async () => {
    const s = S()
    const t = await toStatus(s, await s.create({ title: "t" }), "pending")
    expect(t.pendingAt).toBeGreaterThan(0)
    const claimed = await s.claim({ id: t.id, sessionID: "s1", agent: "build" })
    expect(claimed.pendingAt).toBe(t.pendingAt)
  })
})

describe("设置:阶段模型字段", () => {
  test("仅 patch modelAnalyze 合法(字符串);未给出的字段保持不变", async () => {
    const s = createStore(memoryBackend(), { requireAnalysisConfirm: false })
    await s.setSettings({ modelAnalyze: "zhipuai-coding-plan/glm-5.3-flash" })
    const out = await s.getSettings()
    expect(out.modelAnalyze).toBe("zhipuai-coding-plan/glm-5.3-flash")
    expect(out.modelExecute).toBeUndefined()
    expect(out.autoDispatch).toBe(true)
  })

  test("modelExecute 可单独设置,空串合法(显式跟随默认)", async () => {
    const s = createStore(memoryBackend(), { requireAnalysisConfirm: false })
    await s.setSettings({ modelExecute: "" })
    expect((await s.getSettings()).modelExecute).toBe("")
  })

  test("模型字段非字符串 → invalid_input", async () => {
    const s = createStore(memoryBackend(), { requireAnalysisConfirm: false })
    let msg = ""
    try {
      await s.setSettings({ modelAnalyze: 123 as never })
    } catch (e) {
      msg = (e as Error).message
    }
    expect(msg).toContain("必须为字符串")
  })
})
