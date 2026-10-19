# 实时上下文流（看板 client 化）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 看板「上下文」标签实时跟随 worker 会话——文本打字机追加、工具状态实时翻转，断线快照收敛，三连败优雅降级。

**架构：** 插件进程内 `ctx.event.subscribe()` 订阅宿主 daemon 全局事件总线，按被观看会话过滤、150ms 合帧后经独立 SSE 端点 `/api/tasks/:id/context/live` 推给前端；前端先拉快照再应用增量，断线重拉快照收敛，连续 3 次重连失败降级为静态快照。全程只读，不碰 store 写路径。

**技术栈：** TypeScript + Bun（服务端）、Svelte 5（前端）、`@opencode/plugin` 2.0.30（`ctx.event` 域）。

**规格：** `docs/superpowers/specs/2026-10-19-live-context-stream-design.md`（实证基础 §2 与本计划互为依据，两份都读）

## 全局约束

- 注释、日志、UI 文案、测试描述、提交信息一律中文；提交用中文约定式提交带 emoji
- `bun test` 是唯一验收门；没有 lint、没有格式化器、`tsc --noEmit` 不可用（TS2688），别声称 typecheck 通过
- 改 `webapp/` 必须跑 `bun run build:web` 并提交 `src/web/` 产物（vite 文件名钉死 `assets/board.*`，别改）
- 读路径无鉴权沿用既有知情决策（127.0.0.1 绑定 + 写凭 token），新 SSE 路由不例外
- 本方案无 store 写路由，不涉及 `emitSnapshot`；绝不触碰 store 写路径
- SSE 全局 `idleTimeout: 255`、心跳 25s 注释帧（`src/server.ts` 既有常量，复用不改）
- 事件语义以规格 §2 实证为准：`session.idle` 不触发（用 `session.execution.*`）；delta 的 `ordinal` 是 part 索引非序号；tool 名从 `session.message.content.updated` 取（`session.tool.*` 无工具名）
- 合帧窗口 150ms；重连退避 1s/2s/4s 封顶 10s；连续 3 次失败降级

## 审查重点（Review Focus）

1. 同一会话多条 assistant 消息并行流式，delta 交替到达 → 帧必须按 messageID 分桶不串话（任务 1 测试钉住）
2. 观看者快速开关标签页，refcount 归零后重进 → 旧缓冲必须清空，不残留不泄漏（任务 2 测试钉住）
3. 快照与增量混用：message-end 后重拉快照 → 渲染必须按消息 id 整组替换收敛，不重复不丢失（任务 5 测试钉住）
4. 任务无会话（未领取/human claim `sessionID: null`）→ 服务端立即 message-end 关流，前端不得重试风暴（任务 3 与任务 6 测试钉住）
5. 慢消费者把 SSE 队列挤爆（`desiredSize < 0`）→ 必须 detach 该观看者，绝不累积队列（任务 3 测试钉住）

---

### 任务 1：delta 合帧器与 content 归一化（纯函数）

**文件：**
- 修改：`src/context.ts`（`normalizePart` 加 `export`，函数体零改动）
- 创建：`src/live.ts`
- 测试：`test/live.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
// test/live.test.ts
import { describe, expect, test } from "bun:test"
import { createDeltaBuffer, contentUpdatedFrame, type LiveFrame } from "../src/live"

describe("createDeltaBuffer", () => {
  test("text delta 按消息分桶，flush 产出 text-append 帧且清空缓冲", () => {
    const buf = createDeltaBuffer()
    buf.push("text", "msg_a", "你好")
    buf.push("text", "msg_b", "world")
    buf.push("text", "msg_a", "！")
    const frames = buf.flush()
    expect(frames).toEqual([
      { type: "text-append", kind: "text", messageID: "msg_a", text: "你好！" },
      { type: "text-append", kind: "text", messageID: "msg_b", text: "world" },
    ])
    expect(buf.flush()).toEqual([]) // 幂等：flush 后缓冲为空
  })

  test("text 与 reasoning 分桶互不串话", () => {
    const buf = createDeltaBuffer()
    buf.push("reasoning", "msg_a", "思考中")
    buf.push("text", "msg_a", "回答")
    const frames = buf.flush()
    expect(frames).toContainEqual({ type: "text-append", kind: "reasoning", messageID: "msg_a", text: "思考中" })
    expect(frames).toContainEqual({ type: "text-append", kind: "text", messageID: "msg_a", text: "回答" })
  })

  test("clear 清空全部桶", () => {
    const buf = createDeltaBuffer()
    buf.push("text", "msg_a", "x")
    buf.clear()
    expect(buf.flush()).toEqual([])
  })
})

describe("contentUpdatedFrame", () => {
  test("content.updated 归一化为 content 帧，tool part 保留名字与状态", () => {
    const frame = contentUpdatedFrame({
      messageID: "msg_1",
      content: [
        { type: "text", text: "hi" },
        { type: "tool", id: "c1", name: "bash", state: { status: "running", input: { command: "ls" } } },
        { type: "step-start" }, // normalizePart 会过滤
      ],
    })
    expect(frame).toEqual({
      type: "content",
      messageID: "msg_1",
      parts: [
        { type: "text", text: "hi" },
        { type: "tool", tool: "bash", state: "running", input: '{"command":"ls"}' },
      ],
    })
  })

  test("content 缺失或非数组返回 null", () => {
    expect(contentUpdatedFrame({ messageID: "m" })).toBeNull()
    expect(contentUpdatedFrame({ messageID: "m", content: "bad" })).toBeNull()
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`bun test test/live.test.ts`
预期：FAIL，报错模块 `../src/live` 不存在

- [ ] **步骤 3：实现 `src/live.ts` 并导出 `normalizePart`**

`src/context.ts`：`function normalizePart` 改为 `export function normalizePart`，函数体零改动。

`src/live.ts` 签名（函数体由实现者编写，语义：delta 按 `(kind, messageID)` 用 `Map` 分桶拼串，Map 保序即 flush 顺序；`contentUpdatedFrame` 逐项调 `normalizePart` 过滤 null）：

```ts
import type { ContextPart } from "./context"

export type LiveFrame =
  | { type: "text-append"; kind: "text" | "reasoning"; messageID: string; text: string }
  | { type: "content"; messageID: string; parts: ContextPart[] }
  | { type: "message-end"; messageID: string | null }

/** 总线事件的最小形态（V2Event 结构兼容子集，测试可造） */
export interface LiveEvent {
  type: string
  data: Record<string, unknown>
}

export function createDeltaBuffer(): {
  push(kind: "text" | "reasoning", messageID: string, text: string): void
  flush(): LiveFrame[]
  clear(): void
}

/** session.message.content.updated 的 data → content 帧；content 缺失/非数组返回 null */
export function contentUpdatedFrame(data: Record<string, unknown>): LiveFrame | null
```

- [ ] **步骤 4：运行测试验证通过**

运行：`bun test test/live.test.ts`
预期：PASS 全部用例；`bun test test/context.test.ts` 回归通过

- [ ] **步骤 5：Commit**

```bash
git add src/context.ts src/live.ts test/live.test.ts
git commit -m "feat: 📡 实时上下文流数据层——delta 合帧器与 content 归一化"
```

### 任务 2：createLiveHub（观看者注册表 + 懒订阅 + 事件循环）

**文件：**
- 修改：`src/live.ts`（追加 hub 部分）
- 测试：`test/live.test.ts`（追加 describe）

- [ ] **步骤 1：编写失败的测试**

```ts
// 追加到 test/live.test.ts
import { createLiveHub, type LiveHubDeps, type LiveEvent, type LiveFrame } from "../src/live"

/** 可控假事件源：手动 emit / fail；hub 的 subscribe() 每次调用登记一个新流 */
function fakeSource() {
  const streams: {
    push: (e: LiveEvent) => void
    fail: (e: unknown) => void
    ended: boolean
  }[] = []
  const logs: string[] = []
  const timers: { fn: () => void; ms: number }[] = []
  const deps: LiveHubDeps = {
    subscribe: () =>
      ({
        [Symbol.asyncIterator]() {
          const pending: ((r: IteratorResult<LiveEvent>) => void)[] = []
          const s = {
            ended: false,
            push: (e: LiveEvent) => {
              for (const r of pending.splice(0)) r({ value: e, done: false })
            },
            fail: (err: unknown) => {
              s.ended = true
              for (const r of pending.splice(0)) r({ value: undefined, done: true })
              void err // 迭代器以结束代替抛错：hub 视为「订阅死亡」路径
            },
          }
          streams.push(s)
          return {
            next: () =>
              new Promise<IteratorResult<LiveEvent>>((resolve) => {
                pending.push(resolve)
              }),
          }
        },
      }) as unknown as AsyncIterable<LiveEvent>,
    log: (m: string) => logs.push(m),
    setInterval: ((fn: () => void, ms: number) => {
      timers.push({ fn, ms })
      return timers.length
    }) as unknown as LiveHubDeps["setInterval"],
    clearInterval: (() => {}) as unknown as LiveHubDeps["clearInterval"],
  }
  return {
    deps,
    logs,
    timers,
    last: () => streams[streams.length - 1]!,
    count: () => streams.length,
  }
}

const DELTA = (sessionID: string, messageID: string, text: string): LiveEvent => ({
  type: "session.text.delta",
  data: { sessionID, assistantMessageID: messageID, ordinal: 0, delta: text },
})

function flushTimers(timers: { fn: () => void; ms: number }[], ms: number): void {
  for (const t of timers) if (t.ms === ms) t.fn()
}
```

用例（断言为准）：

```ts
test("attach 后同会话 text.delta 合成 text-append 帧到达；两个观看者同会话都收到", () => {
  const src = fakeSource()
  const hub = createLiveHub(src.deps)
  const got1: LiveFrame[] = []
  const got2: LiveFrame[] = []
  hub.attach("s1", (f) => got1.push(f))
  hub.attach("s1", (f) => got2.push(f))
  src.last().push(DELTA("s1", "m1", "hi"))
  flushTimers(src.timers, 150)
  expect(got1).toEqual([{ type: "text-append", kind: "text", messageID: "m1", text: "hi" }])
  expect(got2).toEqual(got1)
  hub.dispose()
})

test("非观看会话的事件被丢弃", () => {
  const src = fakeSource()
  const hub = createLiveHub(src.deps)
  const got: LiveFrame[] = []
  hub.attach("s1", (f) => got.push(f))
  src.last().push(DELTA("other", "m1", "x"))
  flushTimers(src.timers, 150)
  expect(got).toEqual([])
  hub.dispose()
})

test("message.content.updated → content 帧即时到达（不等 flush）", () => {
  const src = fakeSource()
  const hub = createLiveHub(src.deps)
  const got: LiveFrame[] = []
  hub.attach("s1", (f) => got.push(f))
  src.last().push({
    type: "session.message.content.updated",
    data: { sessionID: "s1", messageID: "m1", content: [{ type: "text", text: "x" }] },
  })
  expect(got).toEqual([{ type: "content", messageID: "m1", parts: [{ type: "text", text: "x" }] }])
  hub.dispose()
})

test("execution.succeeded/failed → message-end(null) 广播给该会话观看者", () => {
  const src = fakeSource()
  const hub = createLiveHub(src.deps)
  const got: LiveFrame[] = []
  hub.attach("s1", (f) => got.push(f))
  src.last().push({ type: "session.execution.succeeded", data: { sessionID: "s1" } })
  expect(got).toEqual([{ type: "message-end", messageID: null }])
  hub.dispose()
})

test("detach 全部观看者后 emit 不产生帧；重新 attach 不残留旧缓冲且复用订阅", () => {
  const src = fakeSource()
  const hub = createLiveHub(src.deps)
  const got: LiveFrame[] = []
  const detach = hub.attach("s1", (f) => got.push(f))
  src.last().push(DELTA("s1", "m1", "old"))
  detach()
  src.last().push(DELTA("s1", "m1", "new"))
  flushTimers(src.timers, 150)
  expect(got).toEqual([])
  hub.attach("s1", (f) => got.push(f))
  src.last().push(DELTA("s1", "m1", "fresh"))
  flushTimers(src.timers, 150)
  expect(got).toEqual([{ type: "text-append", kind: "text", messageID: "m1", text: "fresh" }])
  expect(src.count()).toBe(1) // 订阅未重建（规格 §4.1：观看者归零不关订阅）
  hub.dispose()
})

test("订阅流结束 → log 记录；重新 attach 走重订阅且帧可达", () => {
  const src = fakeSource()
  const hub = createLiveHub(src.deps)
  const got: LiveFrame[] = []
  hub.attach("s1", (f) => got.push(f))
  expect(src.logs.length).toBe(0)
  src.last().fail(new Error("断连"))
  expect(src.logs.length).toBeGreaterThan(0)
  hub.attach("s2", () => {}) // 触发重订阅
  src.last().push(DELTA("s2", "m2", "ok"))
  flushTimers(src.timers, 150)
  expect(src.count()).toBe(2)
  hub.dispose()
})

test("dispose 后 emit 不产生帧、定时器已清理", () => {
  const src = fakeSource()
  const hub = createLiveHub(src.deps)
  const got: LiveFrame[] = []
  hub.attach("s1", (f) => got.push(f))
  hub.dispose()
  src.last().push(DELTA("s1", "m1", "x"))
  flushTimers(src.timers, 150)
  expect(got).toEqual([])
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`bun test test/live.test.ts`
预期：FAIL，`createLiveHub` 未导出

- [ ] **步骤 3：在 `src/live.ts` 实现 hub**

```ts
export interface LiveHubDeps {
  subscribe(): AsyncIterable<LiveEvent>
  log(m: string): void
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

export function createLiveHub(deps: LiveHubDeps, opts?: { flushMs?: number }): {
  /** 注册观看者，返回 detach（幂等）；sessionID 是注册表键（一任务一会话，观看会话唯一） */
  attach(sessionID: string, send: (frame: LiveFrame) => void): () => void
  dispose(): void
}
```

实现要点（规格 §4.1）：注册表 `Map<sessionID, Set<send>>` + 每 sessionID 一个 `DeltaBuffer`；从空到非空或原订阅已死亡时重建 `deps.subscribe()` 的迭代循环；flush 定时器 `opts.flushMs ?? 150`，dispose 时 `clearInterval`；事件循环里先过滤 `data.sessionID` 在注册表中，再按事件类型分派（delta → buffer.push；content.updated → `contentUpdatedFrame` 即时 send；execution.succeeded/failed → `message-end(null)`）；迭代循环 throw → `deps.log` + 标记订阅死亡。

- [ ] **步骤 4：运行测试验证通过**

运行：`bun test test/live.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/live.ts test/live.test.ts
git commit -m "feat: 📡 实时上下文流枢纽——观看者注册表与懒订阅事件循环"
```

### 任务 3：SSE 路由 `/api/tasks/:id/context/live`

**文件：**
- 修改：`src/server.ts`
- 创建：`test/server-live.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
// test/server-live.test.ts —— 复用 test/server-sse.test.ts 的 setup/SseReader 模式
import { createServer } from "../src/server"
import type { LiveFrame } from "../src/live"

function setup(store: Store, subscribeLive?: Parameters<typeof createServer>[1]["subscribeLive"]) {
  // 与 server-sse.test.ts 相同：port 0、token "tok123"、FIXDIR，额外注入 subscribeLive
}

test("有会话任务：send 的帧经 SSE 到达客户端", async () => {
  let push!: (f: LiveFrame) => void
  const base = setup(store, (sid, send) => {
    expect(sid).toBe("s1")
    push = send
    return () => {}
  })
  // 建任务并 claim({ sessionID: "s1" })（照抄 server.test.ts 的 toCompletionConfirm 前两步）
  const res = await fetch(`${base}/api/tasks/${taskId}/context/live`)
  const reader = new SseReader(res) // 从 server-sse.test.ts 复制该类，泛型改 LiveFrame
  push({ type: "message-end", messageID: null })
  expect(await reader.nextEvent()).toEqual({ type: "message-end", messageID: null })
})

test("任务无会话（human claim sessionID 为空串）：立即 message-end 帧后流结束", async () => {
  // claim({ sessionID: "" })；fetch live；nextEvent === {type:"message-end",messageID:null}；流 close
})

test("客户端 abort → subscribeLive 返回的 detach 被调用", async () => {
  // subscribeLive 返回 detach 计数器；AbortController abort fetch；断言 detach 调用数为 1
})

test("流已关闭后再调 send：不炸服务端且 detach 幂等（每观看者至多反注册一次）", async () => {
  // subscribeLive 返回 detach 计数器；先 abort 使流关闭，再经捕获到的 send 连发两帧
  // 断言：服务端不抛（后续请求仍正常响应）、detach 调用数恰为 1
  //（desiredSize<0 主动 detach 的实现见步骤 3；可构造的失败路径即「enqueue 抛错」）
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`bun test test/server-live.test.ts`
预期：FAIL，路由 404

- [ ] **步骤 3：在 `src/server.ts` 实现路由与注入点**

`createServer` opts 追加（放 `readContext` 之后，注释风格与相邻项一致）：

```ts
/** 实时上下文流：注册观看者，返回 detach（index 注入 liveHub.attach，测试可 mock）；缺省路由走无会话分支 */
subscribeLive?: (sessionID: string, send: (frame: LiveFrame) => void) => () => void
```

`api()` 里 `/api/tasks/:id/context` 路由（约 349 行）之后新增 `ctxLiveMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/context\/live$/)`：GET 时 `store.get` 拿 `task.claim?.sessionID || null`；无 sessionID 或无 `opts.subscribeLive` → 返回只含一帧 `{type:"message-end",messageID:null}` 即 close 的 `text/event-stream`（照抄 `handleEvents` 的响应头）；否则按 `handleEvents` 模式建 ReadableStream（25s 心跳注释帧、`req.signal` abort 反注册），`send = (frame) => { if (controller.desiredSize !== null && controller.desiredSize < 0) { detach(); return } controller.enqueue(encoder.encode(\`data: ${JSON.stringify(frame)}\\n\\n\`)) }`，enqueue 抛错同样 detach。`import type { LiveFrame } from "./live"`。

- [ ] **步骤 4：运行测试验证通过**

运行：`bun test test/server-live.test.ts test/server-sse.test.ts`
预期：PASS（新路由通过，既有 SSE 回归通过）

- [ ] **步骤 5：Commit**

```bash
git add src/server.ts test/server-live.test.ts
git commit -m "feat: 📡 实时上下文 SSE 端点——观看者挂载与背压 detach"
```

### 任务 4：index.ts 装配（ctx.event → hub → server）

**文件：**
- 修改：`src/index.ts`（`arbitrate` opts 与 `Plugin.define` setup）
- 测试：既有全量（装配无回归即通过；端到端由任务 7 手工验收覆盖）

- [ ] **步骤 1：在 `arbitrate` 增加透传**

`arbitrate` opts 增加 `subscribeLive?: (sessionID: string, send: (frame: LiveFrame) => void) => () => void`，`tryBind` 的 `createServer` 调用里透传 `subscribeLive: opts.subscribeLive`（主/次实例同样生效——总线 daemon 全局，规格 §4.4）。

- [ ] **步骤 2：在 setup 中构建 hub 并注入**

```ts
import { createLiveHub } from "./live"
// setup 内，arbitrate 调用之前：
const liveHub = createLiveHub({
  subscribe: () => ctx.event.subscribe() as never,
  log,
  setInterval: setInterval.bind(globalThis),
  clearInterval: clearInterval.bind(globalThis),
})
// arbitrate opts 增加：subscribeLive: (sessionID, send) => liveHub.attach(sessionID, send),
// cleanup 返回函数中追加：liveHub.dispose()
```

- [ ] **步骤 3：运行全量测试验证无回归**

运行：`bun test`
预期：PASS（全部既有用例不受影响）

- [ ] **步骤 4：Commit**

```bash
git add src/index.ts
git commit -m "feat: 🔌 装配实时上下文流——插件 ctx.event 接入看板服务"
```

### 任务 5：前端 applyFrame 帧应用（纯函数）

**文件：**
- 修改：`webapp/src/lib/context.ts`（`ContextMessage` 追加 `streaming?: boolean`）
- 创建：`webapp/src/lib/live-context.ts`
- 测试：`webapp/test/live-context.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
// webapp/test/live-context.test.ts
import { describe, expect, test } from "bun:test"
import { applyFrame, type LiveFrame } from "../src/lib/live-context"
import type { ContextMessage } from "../src/lib/context"

const M = (id: string, parts: ContextMessage["parts"]): ContextMessage => ({ id, role: "assistant", time: 1, parts })

test("text-append 追加到最后一个 text part；无则创建占位并标记 streaming", () => {
  const msgs = applyFrame([M("m1", [{ type: "text", text: "a" }])], { type: "text-append", kind: "text", messageID: "m1", text: "b" })
  expect(msgs[0]!.parts).toEqual([{ type: "text", text: "ab" }])
  expect(msgs[0]!.streaming).toBe(true)
  const created = applyFrame([], { type: "text-append", kind: "reasoning", messageID: "m2", text: "思" })
  expect(created[0]!.id).toBe("m2")
  expect(created[0]!.role).toBe("assistant")
  expect(created[0]!.streaming).toBe(true)
  expect(created[0]!.parts).toEqual([{ type: "reasoning", text: "思" }])
})

test("content 帧整体替换该消息 parts（权威快照），streaming 标记保留", () => {
  const msgs = applyFrame(
    [M("m1", [{ type: "text", text: "旧" }])],
    { type: "content", messageID: "m1", parts: [{ type: "tool", tool: "bash", state: "completed", output: "ok" }] },
  )
  expect(msgs[0]!.parts).toEqual([{ type: "tool", tool: "bash", state: "completed", output: "ok" }])
})

test("message-end(null) 全部定格；message-end(id) 仅该消息", () => {
  const two = [M("m1", []), M("m2", [])]
  expect(applyFrame(two, { type: "message-end", messageID: null }).every((m) => m.streaming === false)).toBe(true)
  const one = applyFrame([{ ...M("m1", []), streaming: true }, M("m2", [])], { type: "message-end", messageID: "m1" })
  expect(one[0]!.streaming).toBe(false)
  expect(one[1]!.streaming).toBeUndefined()
})

test("未知消息的 content 帧创建消息并插到头部（最新在前，与快照倒序一致）", () => {
  const msgs = applyFrame([M("old", [])], { type: "content", messageID: "new", parts: [{ type: "text", text: "x" }] })
  expect(msgs.map((m) => m.id)).toEqual(["new", "old"])
})

test("applyFrame 返回新数组不改入参（Svelte $state 兼容）", () => {
  const input = [M("m1", [])]
  applyFrame(input, { type: "message-end", messageID: null })
  expect(input[0]!.streaming).toBeUndefined()
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd webapp && bun test test/live-context.test.ts`
预期：FAIL，模块不存在

- [ ] **步骤 3：实现 `webapp/src/lib/live-context.ts` 的类型与 applyFrame**

```ts
import type { ContextMessage } from "./context"

export type LiveFrame =
  | { type: "text-append"; kind: "text" | "reasoning"; messageID: string; text: string }
  | { type: "content"; messageID: string; parts: ContextMessage["parts"] }
  | { type: "message-end"; messageID: string | null }

/** 不可变应用一帧：返回新数组；新消息 unshift 头部（快照时间倒序），既有消息按 id 原位替换 */
export function applyFrame(messages: ContextMessage[], frame: LiveFrame): ContextMessage[]
```

`webapp/src/lib/context.ts` 的 `ContextMessage` 追加字段：`/** 实时流式中：text/reasoning part 以纯文本渲染，message-end 后切 markdown */ streaming?: boolean`

- [ ] **步骤 4：运行测试验证通过**

运行：`cd webapp && bun test test/live-context.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add webapp/src/lib/live-context.ts webapp/src/lib/context.ts webapp/test/live-context.test.ts
git commit -m "feat: 🖥️ 前端实时帧应用——text-append/content/message-end 纯函数"
```

### 任务 6：connectLiveContext 订阅状态机（仿 events.ts）

**文件：**
- 修改：`webapp/src/lib/live-context.ts`（追加 connect 部分）
- 测试：`webapp/test/live-context.test.ts`（追加 describe）

- [ ] **步骤 1：编写失败的测试**

照抄 `webapp/test/events.test.ts` 的 `FakeES` 与 `fakeTimers` 假件模式，用例：

```ts
test("onopen → onStatus('live')；onmessage 解析帧并经 applyFrame 回调 onMessages", () => {})
test("error → onStatus('reconnecting')，按 1s/2s/4s 退避重建 EventSource（封顶 10s）", () => {})
test("连续 3 次 error → onStatus('off')，EventSource 关闭，不再重连", () => {})
test("返回的 cleanup 关闭 EventSource 并清空全部定时器", () => {})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd webapp && bun test test/live-context.test.ts`
预期：FAIL，`connectLiveContext` 未导出

- [ ] **步骤 3：实现 connectLiveContext**

```ts
export interface LiveConnectDeps {
  EventSource: new (url: string) => {
    onopen: (() => void) | null
    onerror: (() => void) | null
    onmessage: ((e: { data: string }) => void) | null
    close(): void
  }
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export function connectLiveContext(
  taskID: string,
  handlers: {
    onMessages(messages: ContextMessage[]): void
    onStatus(s: "live" | "reconnecting" | "off"): void
  },
  deps?: Partial<LiveConnectDeps>,
): () => void
```

实现要点：URL 为 `/api/tasks/${encodeURIComponent(taskID)}/context/live`；onmessage 里 `JSON.parse` 后调 `applyFrame(当前数组, frame)`（当前数组由 handlers 回调方持有、经 `onMessages` 回传的最新值——connect 内部自己保存 last 数组，初始为 `[]`）；`EventSource` 自带重连故 error 后手动 `close()` + `setTimeout` 退避重建，退避序列 `1000/2000/4000` 封顶 `10000`，连续失败达 3 次进 `off` 终态停止；宿主方法 `.bind(globalThis)`（events.ts 同款注释）。

- [ ] **步骤 4：运行测试验证通过**

运行：`cd webapp && bun test test/live-context.test.ts test/events.test.ts`
预期：PASS（新状态机通过，events 回归通过）

- [ ] **步骤 5：Commit**

```bash
git add webapp/src/lib/live-context.ts webapp/test/live-context.test.ts
git commit -m "feat: 🖥️ 实时上下文订阅状态机——退避重连与三连败降级"
```

### 任务 7：ContextView 接线、streaming 渲染与产物

**文件：**
- 修改：`webapp/src/components/ContextView.svelte`
- 产物：`src/web/`（`bun run build:web` 重建，必须随本任务提交）

- [ ] **步骤 1：ContextView 接线**

`<script>` 中引入 `connectLiveContext`，现有 `$effect`（约 52 行）改为：

```ts
$effect(() => {
  void task.id
  void load()
  const stop = connectLiveContext(task.id, {
    onMessages: (live) => {
      // 以 live 为准整组替换（快照与增量按消息 id 收敛，审查重点 3）
      messages = live.length ? mergeLive(messages, live) : messages
    },
    onStatus: (s) => {
      liveStatus = s
      if (s === "off" && !messages.length) void load() // 降级时兜底一次快照
    },
  })
  return stop
})
```

`mergeLive` 放 `webapp/src/lib/live-context.ts` 并加纯函数测试（本任务步骤 1 一并写：`test("mergeLive 以 live 消息按 id 替换/前置，保留仅存在于快照的更早消息")`——live 含快照首页时整组一致，live 只含新消息时旧消息保持在后）。`let liveStatus = $state<"live" | "reconnecting" | "off">("off")`；`liveStatus !== "off"` 时在消息列表顶部渲染一行状态条（`实时` / `重连中…`，`text-xs text-muted-foreground`，样式沿现有空态文案）。

- [ ] **步骤 2：streaming 渲染分支**

text part 的渲染块（约 92 行 `{#if p.type === "text"}`）内：`m.streaming` 为真时用 `<pre class="whitespace-pre-wrap break-all text-sm">`（尾部加闪烁光标 `▍`）替代 `<Markdown>`；reasoning part 同理用纯文本。message-end 后自动回落既有 Markdown 渲染。

- [ ] **步骤 3：运行 webapp 测试与构建产物**

运行：`cd webapp && bun test` 然后 `cd .. && bun run build:web`
预期：测试全 PASS；`src/web/assets/board.js` 等产物更新（git status 可见）

- [ ] **步骤 4：运行全量服务端测试**

运行：`bun test`
预期：PASS

- [ ] **步骤 5：手工验收（dev 模式）**

运行：`bun run dev`（终端 1）与 `bun run dev:web`（终端 2），浏览器开看板：
1. 建任务、开自动派发（或 `/taskboard-claim` 手动领取），打开该任务「上下文」标签
2. 断言：worker 回合中文本打字机追加、工具折叠条状态从 ⏳ 翻转 ✓/✗、顶部「实时」标识
3. 断言：刷新页面后消息完整、无重复（快照收敛）
4. 断言：未领取任务的上下文标签无重试风暴（Network 面板 live 请求只有一次）

- [ ] **步骤 6：Commit（含产物）**

```bash
git add webapp/src/components/ContextView.svelte webapp/src/lib/live-context.ts webapp/test/live-context.test.ts src/web
git commit -m "feat: 🖥️ 上下文标签实时接线——打字机渲染、状态条与产物入库"
```

## 收尾验证（全计划完成后）

- `bun test` 全量 PASS（唯一验收门）
- `git log --oneline` 七个提交、`src/web/` 产物与 `webapp/` 改动同在最后一个提交
- 删除一次性探针目录 `.debug/spike-live/`、`.debug/spike-live2/`（gitignore 内，删不删都不影响仓库）
