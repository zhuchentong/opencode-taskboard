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

/**
 * 读干 SSE 流直到服务端关流；超时未关返回 false。
 * 不能用 SseReader.closedWithin：它只读一次，连接即发的注释帧（: ping）会占掉那一次读。
 */
async function drainUntilClosed(res: Response, timeoutMs = 2000): Promise<boolean> {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader()
  const read = (async () => {
    for (;;) {
      const r = await reader.read()
      if (r.done) return true
    }
  })()
  const timeout = new Promise<false>((r) => setTimeout(() => r(false), timeoutMs))
  return Promise.race([read, timeout])
}

/**
 * 观测 SSE 心跳 interval 的创建与清理：临时包裹全局定时器，只统计 25s 心跳
 * （server.ts 的 SSE_HEARTBEAT_MS）——别的 interval 与本用例无关，不受影响。
 * 心跳泄漏在业务上不可见（25s 才跳一次），只能从定时器生命周期上钉。
 */
async function countHeartbeats(
  fn: (beat: { created: number; cleared: number }) => Promise<void>,
): Promise<{ created: number; cleared: number }> {
  const origSet = globalThis.setInterval
  const origClear = globalThis.clearInterval
  const handles = new Set<unknown>()
  const beat = { created: 0, cleared: 0 }
  globalThis.setInterval = ((cb: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const h = (origSet as unknown as (...a: unknown[]) => unknown)(cb, ms, ...args)
    if (ms === 25_000) {
      beat.created++
      handles.add(h)
    }
    return h
  }) as unknown as typeof globalThis.setInterval
  globalThis.clearInterval = ((h: unknown) => {
    if (handles.has(h)) {
      beat.cleared++
      handles.delete(h)
    }
    ;(origClear as unknown as (x: unknown) => void)(h)
  }) as unknown as typeof globalThis.clearInterval
  try {
    await fn(beat)
  } finally {
    globalThis.setInterval = origSet
    globalThis.clearInterval = origClear
  }
  return beat
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

  // —— 订阅死亡/建立失败 → 关流（前端唯一终态信号是连接关闭）——

  test("hub 侧关流 → SSE 流真实终结、心跳清掉、detach 只被调用一次", async () => {
    const s = createStore(memoryBackend(), { requireAnalysisConfirm: false })
    let closeLive!: () => void
    let detachCalls = 0
    const base = setup(s, (_sid, _send, close) => {
      closeLive = close!
      return () => {
        detachCalls++
      }
    })
    const t = await claimedTask(s, "s1")

    const ctrl = new AbortController()
    const res = await fetch(`${base}/api/tasks/${t.id}/context/live`, { signal: ctrl.signal })
    expect(res.status).toBe(200)
    const closed = drainUntilClosed(res) // 先挂上读端，再触发关流
    closeLive() // hub 侧判定订阅死亡 → 关流
    expect(await closed).toBe(true) // 流真的终结了（前端据此退避重连）
    await expectEventually(() => detachCalls === 1, "期望关流后 detach 被调用")
    expect(detachCalls).toBe(1)
    ctrl.abort() // 客户端随后断开：清理幂等，不得重复反注册
    await new Promise((r) => setTimeout(r, 50))
    expect(detachCalls).toBe(1)
  })

  test("hub 侧关流 → 心跳 interval 被清掉（不留僵尸心跳）", async () => {
    const s = createStore(memoryBackend(), { requireAnalysisConfirm: false })
    let closeLive!: () => void
    const base = setup(s, (_sid, _send, close) => {
      closeLive = close!
      return () => {}
    })
    const t = await claimedTask(s, "s1")
    const beat = await countHeartbeats(async (beat) => {
      const ctrl = new AbortController()
      await fetch(`${base}/api/tasks/${t.id}/context/live`, { signal: ctrl.signal })
      expect(beat.created).toBe(1) // 心跳已建
      closeLive()
      await new Promise((r) => setTimeout(r, 50))
    })
    expect(beat.created).toBe(1)
    expect(beat.cleared).toBe(1) // 关流时清掉心跳
  })

  test("subscribeLive 同步抛错 → 流以 500 终结且心跳 interval 已清（无僵尸心跳）", async () => {
    const s = createStore(memoryBackend(), { requireAnalysisConfirm: false })
    const base = setup(s, () => {
      throw new Error("总线瞬断")
    })
    const t = await claimedTask(s, "s1")
    const beat = await countHeartbeats(async (beat) => {
      const res = await fetch(`${base}/api/tasks/${t.id}/context/live`)
      expect(res.status).toBe(500) // 挂载失败 → 500 终结
      await new Promise((r) => setTimeout(r, 50))
    })
    expect(beat.created).toBe(1)
    expect(beat.cleared).toBe(1) // 心跳不得留在进程里空转

    // 服务端未受影响，后续请求照常响应
    const after = await fetch(`${base}/api/health`)
    expect(after.status).toBe(200)
  })
})
