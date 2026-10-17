import { describe, expect, test } from "bun:test"
import { BUILTIN_RULES, makeBuiltinRules, runAdvance } from "../../src/dispatcher/advance"
import { buildReanalyzePrompt } from "../../src/dispatcher/prompt"
import type { DispatcherSession } from "../../src/dispatcher/types"
import type { TaskTransition } from "../../src/dispatcher/types"
import type { Task } from "../../src/types"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const taskOf = (over: Partial<Task> = {}): Task => ({
  id: "t1",
  title: "问答任务",
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
  const prompts: { sessionID: string; text: string }[] = []
  const session: DispatcherSession = {
    create: async () => ({ id: "x" }),
    get: async () => ({}),
    prompt: async (input) => {
      prompts.push(input)
      return {}
    },
  }
  return { session, prompts }
}

function harness(session: DispatcherSession) {
  const lastActed = new Map<string, number>()
  const logs: string[] = []
  const ctx = {
    shouldAct: (t: TaskTransition) => t.seq > (lastActed.get(t.taskID) ?? 0),
    markActed: (t: TaskTransition) => lastActed.set(t.taskID, t.seq),
    log: (m: string) => logs.push(m),
  }
  return { lastActed, logs, ctx, rules: makeBuiltinRules({ session, log: (m) => logs.push(m) }) }
}

describe("advance 推进规则表(沿驱动唤醒)", () => {
  test("钉子(缺陷 3 回归):打回重做第二轮放行必唤醒新会话", async () => {
    const { session, prompts } = fakeSession()
    const { ctx, rules } = harness(session)
    // 第一轮:analysis_confirm→executing(seq 1)→ 唤醒 ses_w1
    await runAdvance(rules, along(1, "executing"), taskOf(), ctx)
    expect(prompts).toHaveLength(1)
    expect(prompts[0].sessionID).toBe("ses_w1")
    // 打回重做:重新派发到新会话 ses_w2,再次放行(seq 2)
    await runAdvance(
      rules,
      along(2, "executing"),
      taskOf({ claim: { sessionID: "ses_w2", agent: "build", claimedAt: 1 } }),
      ctx,
    )
    expect(prompts).toHaveLength(2) // 旧 nudgedTaskIDs 语义下第二轮不会发生
    expect(prompts[1].sessionID).toBe("ses_w2")
  })

  test("拖回必唤醒(缺陷 4 回归):analysis_confirm→analyzing 沿,提示词含最近用户评论", async () => {
    const { session, prompts } = fakeSession()
    const { ctx, rules } = harness(session)
    const task = taskOf({
      status: "analyzing",
      comments: [{ author: "user", text: "请改用方案 B,预算减半", createdAt: 5 }],
    })
    await runAdvance(rules, along(1, "analyzing"), task, ctx)
    expect(prompts).toHaveLength(1)
    expect(prompts[0].text).toContain("已退回分析中")
    expect(prompts[0].text).toContain("请改用方案 B,预算减半")
  })

  test("重析唤醒无评论时提示词不含空占位(有明确的无评论文案)", async () => {
    expect(buildReanalyzePrompt({ title: "T" }, null)).toContain("无评论")
  })

  test("幂等:同一 seq 的沿只 act 一次", async () => {
    const { session, prompts } = fakeSession()
    const { ctx, rules } = harness(session)
    await runAdvance(rules, along(1, "executing"), taskOf(), ctx)
    await runAdvance(rules, along(1, "executing"), taskOf(), ctx)
    expect(prompts).toHaveLength(1)
  })

  test("act 失败不推进幂等水位:下轮同沿重发成功", async () => {
    let fail = true
    const prompts: { sessionID: string; text: string }[] = []
    const session: DispatcherSession = {
      create: async () => ({ id: "x" }),
      get: async () => ({}),
      prompt: async (input) => {
        if (fail) throw new Error("api down")
        prompts.push(input)
        return {}
      },
    }
    const { ctx, rules, logs } = harness(session)
    await runAdvance(rules, along(1, "executing"), taskOf(), ctx)
    expect(prompts).toHaveLength(0)
    expect(logs.some((l) => l.includes("执行唤醒失败"))).toBe(true)
    await sleep(1)
    fail = false
    await runAdvance(rules, along(1, "executing"), taskOf(), ctx)
    expect(prompts).toHaveLength(1)
  })

  test("未知沿(如 completion_confirm→pending)无匹配规则 → 静默忽略", async () => {
    const { session, prompts } = fakeSession()
    const { ctx, rules } = harness(session)
    await runAdvance(rules, along(1, "pending", "completion_confirm"), taskOf({ status: "pending" }), ctx)
    expect(prompts).toHaveLength(0)
    expect(BUILTIN_RULES.length).toBe(2)
  })

  test("无会话的 claim(human)跳过唤醒,不抛错", async () => {
    const { session, prompts } = fakeSession()
    const { ctx, rules } = harness(session)
    await runAdvance(rules, along(1, "executing"), taskOf({ claim: undefined }), ctx)
    expect(prompts).toHaveLength(0)
  })
})
