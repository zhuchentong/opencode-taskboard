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

## 执行期修订（2026-10-20，任务 1-5 审查裁决）

本节记录执行期对计划正文的裁决（任务 6/7 的简报从本文件生成，务必连同这些修订一起读）：

1. **服务端帧序（任务 2/5 跨任务）**：hub 在 `session.execution.succeeded/failed` 时**先冲刷该会话 delta 缓冲、再广播 `message-end(null)`**——结束信号必须排在文本之后，否则前端把消息定格后又被迟到的 `text-append` 置回流式态且永不定格。
2. **回合结束态不变量（任务 5）**：hub 按会话记结束态；`session.execution.started` 复位；结束态为真时到达的帧**照常广播并紧跟一条 `message-end`**（内容不丢、帧序以 message-end 收尾）。
3. **前端 streaming 统一模型（任务 5）**：任何实时帧（`text-append`/`content`）触及某消息即置 `streaming:true`；只有 `message-end` 定格。（原「content 对既有消息保留原样」作废。）
4. **前端 `applyFrame` 签名（任务 5）**：增可选第三参 `now: number = Date.now()`，并加 `default` 分支返回原数组。
5. **规格 §6 的订阅死亡处置（任务 5 复审发现）**：订阅流结束/异常时，服务端须给**所有活跃观看者**补发 `message-end`（否则看板静默冻在「实时」状态），并清理结束态。

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

test("content 帧整体替换该消息 parts（权威快照），并置 streaming", () => {
  const msgs = applyFrame(
    [M("m1", [{ type: "text", text: "旧" }])],
    { type: "content", messageID: "m1", parts: [{ type: "tool", tool: "bash", state: "completed", output: "ok" }] },
  )
  expect(msgs[0]!.parts).toEqual([{ type: "tool", tool: "bash", state: "completed", output: "ok" }])
  expect(msgs[0]!.streaming).toBe(true)
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

/** 不可变应用一帧：返回新数组；新消息 unshift 头部（快照时间倒序），既有消息按 id 原位替换
 *  统一模型：任何实时帧触及某消息即置 streaming=true；只有 message-end 才定格
 *  未知帧类型返回原数组（default 兜底）；now 可注入以消除读时钟的隐性副作用 */
export function applyFrame(
  messages: ContextMessage[],
  frame: LiveFrame,
  now: number = Date.now(),
): ContextMessage[]
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

---

# 执行进度与交接（2026-10-20 暂停）

分支 `feat/live-context-stream`（从 `master@50144ac` 拉出）。规格：
`docs/superpowers/specs/2026-10-19-live-context-stream-design.md`。

## 一、状态总览：7 个任务完成 5 个

| 任务 | 状态 | 提交 |
|------|------|------|
| 0 基线 | ✅ | `50144ac`（上一轮会话遗留的「上下文标签」在途工作，作为基线提交以隔离本计划 diff） |
| 1 数据层（合帧器 + content 归一化） | ✅ 审查干净（1 轮修复） | `f62bf55` `c0035df` |
| 2 枢纽 createLiveHub | ✅ 审查干净（1 轮修复） | `9fd75f9` `5557144` |
| 3 SSE 路由 `/api/tasks/:id/context/live` | ✅ 审查干净（1 轮修复） | `b9eadb9` `1a218b9` |
| 4 index.ts 装配 | ✅ 审查干净（1 轮修复） | `dcc7c1e` `551176e` |
| 5 前端 applyFrame | ⚠️ **第 2 轮修复已实施，复审待做** | `aeb7347` `00957c3` `a63da03` `104c727` `9a66d23` |
| 6 connectLiveContext 订阅状态机 | ⬜ 未开始 | — |
| 7 ContextView 接线 + 产物 + 验收 | ⬜ 未开始 | — |
| 终审（宽范围审查）+ finishing-a-development-branch | ⬜ 未开始 | — |

附带：`d2433eb` 规格帧词汇修订（见上文「执行期修订」）。

**测试状态**：根 `bun test` → 510 pass / 0 fail；前端 `cd webapp && bun test` → 139 pass / 0 fail。

## 二、恢复执行的入口

1. **账本**（本机，gitignore，勿删）：`.superpowers/sdd/2026-10-19-live-context-stream/progress.md`
   —— 含逐任务裁决与遗留 Minor 清单。上下文压缩后以它与 `git log` 为准，不要凭记忆。
2. **任务 6 简报**：
   `bash <superpowers>/skills/subagent-driven-development/scripts/task-brief docs/superpowers/plans/2026-10-19-live-context-stream.md 6`
3. **模型**：后续任务统一 `minimax-cn-coding-plan/MiniMax-M3.1-Flash`（用户 2026-10-20 指令，覆盖原分层安排）。
4. **待办顺序**：① 任务 5 第 2 轮修复的定向复审（FIX_BASE=`104c727`，HEAD=`9a66d23`）→ ② 任务 6 → ③ 任务 7（含 dev 假事件源）→ ④ 宽范围终审 → ⑤ finishing-a-development-branch。
5. **注意**：任务 6/7 的简报从本文件生成，**必须连同上文「执行期修订」5 条一起读**（否则会回退已修掉的 streaming 语义与帧序）。

## 三、任务 5 第 2 轮修复（待复审）内容

`9a66d23`：补规格 §6 缺口——订阅流结束/异常时给**所有活跃观看者**补发 `message-end` 并清结束态；
重订阅成功时也清结束态。含 4 条新用例（根全量 510 pass）。

## 四、我作出的裁决摘要（若判断有误，返工点在此）

1. **规格帧词汇**：`part-update {messageID, part}` 作废，改为 `content {messageID, parts[]}`（权威整体替换）——理由：工具名与工具输出只存在于 `session.message.content.updated`，`session.tool.*` 不带工具名。代价：规格与早期计划文本需同步修订（已做 `d2433eb`）。
2. **服务端帧序**：回合收尾先冲刷 delta 缓冲再广播 `message-end`——结束信号必须排在文本之后，否则消息永不定格。代价：跨任务改了 `src/live.ts`。
3. **前端 streaming 统一模型**：任何实时帧触及某消息即置 `streaming:true`，只有 `message-end` 定格（原「content 对既有消息保留原样」作废）。代价：计划用例标题与断言更正。
4. **回合结束态不变量**：迟到帧照常广播并紧跟一条 `message-end`（不丢内容、帧序以 message-end 收尾）。代价：hub 多两个状态结构。
5. **规格 §6 订阅死亡处置**：给活跃观看者补发 `message-end`（否则看板静默冻在「实时」）。代价：hub 多一个跨会话广播。
6. **计划缺陷·任务 2**：简报用例原为同步断言，消费 AsyncIterable 至少延迟一个微任务 → 任何实现都过不了；接受 `async` + `await tick()` 的最小机械修正（断言与事件序列逐字保留）。
7. **计划缺陷·任务 3**：简报让复制 55 行 `SseReader` → 跨文件逐字重复；改为提取 `test/helpers/sse-reader.ts`（泛型 `SseReader<T>`），既有 server-sse 用例只改 import。
8. **file 类工具输出**：live 侧只能给 `[文件: 名]` 引用行（事件只带 uri/mime/name）——数据源限制，接受，已写入规格 §5。
9. **工具错误详情**：live 与快照两侧都不展示（`normalizePart` 不读 `state.error`）——范围外，既有行为。
10. **dev 模式无 live 接线**：放到任务 7 补 dev 假事件源（否则任务 7 的手工验收会看到「live 流秒断」并误判装配失败）。
11. **接受现状的遗留项**：合帧定时器随插件常驻（150ms 空转）；插件卸载时总线订阅不立即释放（挂到下一事件才释放，世代守卫已防迟到事件）；setup 失败时派发器定时器不被 dispose（既有行为）；任务 5 两条观感级 Minor（复位与迟到 delta 的时序竞态、复位后迟到 content 帧无补定格）。
12. **帧协议不带 role**（实时新建消息一律 assistant）——交最终审查甄别，暂不改。

## 五、遗留 Minor 清单（交宽范围终审甄别哪些必须合并前修掉）

- file 类工具 live 输出为引用行，与快照正文不同；多 text 条目以 `\n` 连接，与快照非逐字相同；error 态工具 live 合成 output 而快照无此字段；空 text 块产出 `output:""`；半截 JSON 的 streaming 入参保持字符串
- `removeLiveWatcher` 与 `removeSubscriber` 8 行同构（有意不动既有路径）
- 任务 5 两条观感级时序 Minor（见上 11）
- 帧协议不带 role
- `applyFrame` 未知帧类型走 `default` 兜底（不崩但不产出）

