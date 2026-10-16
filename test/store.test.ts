import { describe, expect, test } from "bun:test"
import { createStore, memoryBackend, storageBackend } from "../src/store"
import { StoreError, type Status, type Store, type Task } from "../src/types"

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
    expect(await s.getSettings()).toEqual({ requireAnalysisConfirm: true, autoDispatch: false })
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
    expect(await s.getSettings()).toEqual({ requireAnalysisConfirm: true, autoDispatch: false })
  })
})

describe("设置扩展与合并写入（autoDispatch）", () => {
  test("缺省设置包含 autoDispatch:false", async () => {
    const s = S(false)
    expect(await s.getSettings()).toEqual({ requireAnalysisConfirm: false, autoDispatch: false })
  })

  test("旧格式存储缺 autoDispatch → 补默认值", async () => {
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
    expect(await s.getSettings()).toEqual({ requireAnalysisConfirm: true, autoDispatch: false })
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
