// 实时上下文 SSE 路由（/api/tasks/:id/context/live）的行为守护：
// 复用 test/server-sse.test.ts 的 setup 模式，SseReader 用共享 helper（test/helpers/sse-reader.ts），
// 经注入的 subscribeLive 假源驱动帧。
import { afterEach, describe, expect, test } from "bun:test"
import { createStore, memoryBackend } from "../src/store"
import { createServer, type ServerHandle } from "../src/server"
import type { LiveFrame } from "../src/live"
import type { Store } from "../src/types"
import { SseReader } from "./helpers/sse-reader"

const FIXDIR = "test/.webroot-fixture"

const started: ServerHandle[] = []
afterEach(() => {
  while (started.length) started.pop()?.stop()
})

function setup(store: Store, subscribeLive?: Parameters<typeof createServer>[1]["subscribeLive"]) {
  const handle = createServer(store, {
    port: 0,
    token: "tok123",
    webDir: FIXDIR,
    primary: true,
    projectID: "proj-test",
    subscribeLive,
  })
  started.push(handle)
  return `http://127.0.0.1:${handle.actualPort}`
}

/** 建任务 → pending → 指定会话领取（与 server.test.ts 的 toCompletionConfirm 前几步一致） */
async function claimedTask(s: Store, sessionID: string) {
  const t = await s.create({ title: "t" })
  await s.patch(t.id, { status: "pending" })
  await s.claim({ id: t.id, sessionID, agent: sessionID ? "build" : "human" })
  return t
}

/** detach 等服务端副作用是连接关闭后异步传播的：短暂轮询直到条件满足（同 server-sse 的 expectReconnectOk） */
async function expectEventually(check: () => boolean, msg: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`${msg}（超时）`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe("实时上下文 SSE 路由", () => {
  test("有会话任务：send 的帧经 SSE 到达客户端", async () => {
    const s = createStore(memoryBackend(), { requireAnalysisConfirm: false })
    let push!: (f: LiveFrame) => void
    const base = setup(s, (sid, send) => {
      expect(sid).toBe("s1")
      push = send
      return () => {}
    })
    const t = await claimedTask(s, "s1")

    const res = await fetch(`${base}/api/tasks/${t.id}/context/live`)
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toContain("text/event-stream")
    const reader = new SseReader<LiveFrame>(res)
    push({ type: "message-end", messageID: null })
    expect(await reader.nextEvent()).toEqual({ type: "message-end", messageID: null })
  })

  test("任务无会话（human claim sessionID 为空串）：立即 message-end 帧后流结束", async () => {
    const s = createStore(memoryBackend(), { requireAnalysisConfirm: false })
    let attachCalls = 0
    const base = setup(s, () => {
      attachCalls++
      return () => {}
    })
    const t = await claimedTask(s, "")

    const res = await fetch(`${base}/api/tasks/${t.id}/context/live`)
    expect(res.status).toBe(200)
    const reader = new SseReader<LiveFrame>(res)
    expect(await reader.nextEvent()).toEqual({ type: "message-end", messageID: null })
    expect(await reader.closedWithin()).toBe(true) // 前端据此不重试
    expect(attachCalls).toBe(0) // 无会话不挂观看者
  })

  test("客户端 abort → subscribeLive 返回的 detach 被调用", async () => {
    const s = createStore(memoryBackend(), { requireAnalysisConfirm: false })
    let detachCalls = 0
    const base = setup(s, () => () => {
      detachCalls++
    })
    const t = await claimedTask(s, "s1")

    const ctrl = new AbortController()
    await fetch(`${base}/api/tasks/${t.id}/context/live`, { signal: ctrl.signal })
    ctrl.abort()
    await expectEventually(() => detachCalls === 1, "期望 abort 后 detach 被调用")
    expect(detachCalls).toBe(1)
  })

  test("流已关闭后再调 send：不炸服务端且 detach 幂等（每观看者至多反注册一次）", async () => {
    const s = createStore(memoryBackend(), { requireAnalysisConfirm: false })
    let detachCalls = 0
    let push!: (f: LiveFrame) => void
    const base = setup(s, (_sid, send) => {
      push = send
      return () => {
        detachCalls++
      }
    })
    const t = await claimedTask(s, "s1")

    const ctrl = new AbortController()
    await fetch(`${base}/api/tasks/${t.id}/context/live`, { signal: ctrl.signal })
    ctrl.abort()
    await expectEventually(() => detachCalls === 1, "期望 abort 后 detach 恰好一次")

    // 流已死再连发两帧：send 不得同步抛错（异常冒出去会打进 hub 的 flush 定时器，无 catch 兜底）
    push({ type: "message-end", messageID: null })
    push({ type: "message-end", messageID: null })
    expect(detachCalls).toBe(1) // 幂等：每观看者至多反注册一次

    // 服务端未受影响，后续请求照常响应
    const after = await fetch(`${base}/api/health`)
    expect(after.status).toBe(200)
  })

  test("未知任务 id → 404 not_found（StoreError 映射，与 context 路由同路径）", async () => {
    const s = createStore(memoryBackend(), { requireAnalysisConfirm: false })
    const base = setup(s)
    const r = await fetch(`${base}/api/tasks/task_nope/context/live`)
    expect(r.status).toBe(404)
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("not_found")
  })

  test("观看者触顶：第 33 个 live 连接返回 503 too_many_subscribers", async () => {
    const s = createStore(memoryBackend(), { requireAnalysisConfirm: false })
    const base = setup(s, () => () => {})
    const t = await claimedTask(s, "s1")

    const ctrls: AbortController[] = []
    for (let i = 0; i < 32; i++) {
      const ctrl = new AbortController()
      ctrls.push(ctrl)
      expect((await fetch(`${base}/api/tasks/${t.id}/context/live`, { signal: ctrl.signal })).status).toBe(200)
    }
    const overflow = await fetch(`${base}/api/tasks/${t.id}/context/live`)
    expect(overflow.status).toBe(503)
    expect(((await overflow.json()) as { error: { code: string } }).error.code).toBe("too_many_subscribers")
    for (const ctrl of ctrls) ctrl.abort()
  })
})
