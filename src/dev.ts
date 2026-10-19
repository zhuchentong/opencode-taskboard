// Mock 模式：内存 store + 真实 server，浏览器直接调试前端，无需 OpenCode。
// 用法：bun run src/dev.ts → http://127.0.0.1:4370/（token 固定为 dev）
import { createStore, memoryBackend } from "./store"
import { createServer } from "./server"
import type { ContextPage, ContextReadInput } from "./context"

const store = createStore(memoryBackend(), { requireAnalysisConfirm: false, directory: process.cwd() })

// 预置三条不同阶段的样例任务
await store.create({ title: "示例：梳理登录模块的问题", description: "处于待规划，补充清楚目标后再拖到待领取" })
const pending = await store.create({ title: "示例：修复看板拖拽偶发失效", description: "已规划完毕，等待 Agent 认领" })
await store.patch(pending.id, { status: "pending" })
await store.claim({ id: pending.id, sessionID: "ses_dev_mock", agent: "build" })
const done = await store.create({ title: "示例：升级依赖版本", description: "已完成" })
await store.patch(done.id, { status: "pending" })
await store.patch(done.id, { status: "done" })

/** dev 假上下文：一段典型 worker 会话（派发提示词 → 工具调用 → 分析 → 结论） */
function fakeContext(input: ContextReadInput): ContextPage {
  const page = [
    {
      id: "msg_dev_1",
      role: "user",
      time: Date.now() - 600_000,
      parts: [
        { type: "text" as const, text: `请完成任务「${pending.title}」：${pending.description}。先分析再执行。` },
      ],
    },
    {
      id: "msg_dev_2",
      role: "assistant",
      time: Date.now() - 480_000,
      parts: [
        {
          type: "tool" as const,
          tool: "taskboard_claim",
          state: "completed",
          input: JSON.stringify({ id: pending.id }),
          output: "任务已领取",
        },
        { type: "reasoning" as const, text: "先看拖拽实现，定位偶发失效的根因……" },
        { type: "tool" as const, tool: "read", state: "completed", input: JSON.stringify({ path: "webapp/src/lib/lane.ts" }), output: "export function resolveLane(…)…" },
        { type: "tool" as const, tool: "bash", state: "completed", input: JSON.stringify({ cmd: "bun test webapp/test/lane.test.ts" }), output: "42 pass\nRan 42 tests" },
      ],
    },
    {
      id: "msg_dev_3",
      role: "assistant",
      time: Date.now() - 300_000,
      parts: [
        {
          type: "text" as const,
          text: "## 分析\n\n拖拽偶发失效的根因是 `resolveLane` 在列宽变化后未重算命中区……\n\n## 修复方案\n\n在 pointermove 里改为实时重算。",
        },
      ],
    },
  ]
  return { sessionID: input.sessionID, total: page.length, page, nextCursor: null, hasMore: false }
}

const handle = createServer(store, {
  port: Number(process.env.TASKBOARD_PORT) || 4370,
  token: "dev",
  webDir: new URL("./web/", import.meta.url).pathname,
  primary: true,
  logs: () => ["dev 模式运行中"],
  readContext: fakeContext,
})

console.log(`[taskboard] dev 看板已启动：http://127.0.0.1:${handle.actualPort}/ （token=dev，Ctrl+C 退出）`)
